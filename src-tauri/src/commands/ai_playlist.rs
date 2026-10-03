//! AI playlists built from the Library (v0.15 workstream D).
//!
//! Same shape as AI Clean (`ai.rs`): one prompt builder and one tolerant
//! parser shared by every backend (Ollama, Claude CLI, manual copy/paste),
//! so a request answers identically whichever backend ran it. The one rule
//! that matters more here than in AI Clean: the AI is given a numbered pool
//! and must only ever return ids from that pool. `parse_playlist_response`
//! enforces it — anything else is an invention, not a track, and is dropped
//! rather than trusted (same "no guessing" rule the v0.14 plan set for AI
//! Clean's filename fallback).

use serde_json::Value;

use crate::models::{PlaylistAiResult, PlaylistSet, PlaylistSetSpec, PlaylistTrackInput};

/// Builds the exact prompt sent to the model. `pool` is already filtered
/// (D2) — the AI never sees genre/year/bpm filters, only the tracks that
/// survived them, which keeps the prompt small and means it cannot choose a
/// track the filters excluded.
pub(crate) fn build_playlist_prompt(
    pool: &[PlaylistTrackInput],
    instructions: &str,
    sets: &[PlaylistSetSpec],
) -> Result<String, String> {
    let track_list = serde_json::to_string_pretty(pool).map_err(|e| e.to_string())?;
    let sets_desc = sets
        .iter()
        .map(|s| match s.target_count {
            Some(n) => format!("  - \"{}\": about {} tracks", s.name, n),
            None => format!("  - \"{}\": however many tracks fit well", s.name),
        })
        .collect::<Vec<_>>()
        .join("\n");

    Ok(format!(
        r#"You are a DJ's playlist-building assistant. You will receive a numbered pool of tracks from the user's own music library, free-text instructions, and a list of sets (sub-playlists) to split the pool into.

RULES:
1. Use ONLY the "id" values from the pool below. Never invent an id, and never return a track that is not in the pool.
2. Every id you return must appear in exactly the sets that make sense — a track may appear in at most one set, and does not need to appear in any set if it doesn't fit.
3. Respect the instructions for mood, energy, flow and ordering (the order of ids within a set is the play order).
4. Respect each set's target size when one is given, as closely as the pool allows.
5. Separately, suggest up to 15 songs that are NOT in the pool but would fit the instructions well — real, specific songs ("Artist – Title"), from your own knowledge, not from the pool. These are suggestions to go find and add, never pool ids.

INSTRUCTIONS FROM THE USER:
{instructions}

SETS TO BUILD:
{sets_desc}

TRACK POOL:
{track_list}

OUTPUT FORMAT: Return ONLY valid JSON, no explanation, no markdown, no preamble:
{{
  "sets": [
    {{ "name": "Warm-up", "trackIds": [3, 17, 2] }}
  ],
  "suggestions": ["Artist – Title", "Artist – Title"]
}}"#
    ))
}

/// Manual mode: the same prompt `ai_playlist_batch`/`claude_playlist_batch`
/// would send, for pasting into any AI.
#[tauri::command]
pub fn ai_playlist_prompt(
    pool: Vec<PlaylistTrackInput>,
    instructions: String,
    sets: Vec<PlaylistSetSpec>,
) -> Result<String, String> {
    build_playlist_prompt(&pool, &instructions, &sets)
}

/// Manual mode: parses a pasted-back answer with the same parser the
/// automated backends use.
#[tauri::command]
pub fn ai_parse_playlist_response(text: String, pool_ids: Vec<u32>) -> PlaylistAiResult {
    parse_playlist_response(&text, &pool_ids)
}

#[tauri::command]
pub async fn ai_playlist_batch(
    app: tauri::AppHandle,
    url: String,
    model: String,
    pool: Vec<PlaylistTrackInput>,
    instructions: String,
    sets: Vec<PlaylistSetSpec>,
) -> Result<PlaylistAiResult, String> {
    use std::time::Duration;

    let pool_ids: Vec<u32> = pool.iter().map(|t| t.id).collect();
    let prompt = build_playlist_prompt(&pool, &instructions, &sets)?;
    let body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": false,
        "format": "json"
    });

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post(format!("{}/api/generate", url.trim_end_matches('/')))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Could not reach Ollama: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Ollama returned HTTP {}", resp.status()));
    }

    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid response from Ollama: {e}"))?;
    crate::commands::ai_playlist::emit_usage_ollama(&app, &model, &v, pool.len());
    let text = v["response"]
        .as_str()
        .ok_or_else(|| "Ollama response is missing the 'response' field".to_string())?;
    Ok(parse_playlist_response(text, &pool_ids))
}

pub(crate) fn emit_usage_ollama(app: &tauri::AppHandle, model: &str, v: &Value, tracks: usize) {
    use tauri::Emitter;
    let _ = app.emit(
        "ai-usage",
        crate::models::AiUsage {
            model: model.to_string(),
            prompt_eval_count: v["prompt_eval_count"].as_u64().unwrap_or(0),
            eval_count: v["eval_count"].as_u64().unwrap_or(0),
            tracks,
        },
    );
}

/// Tolerant parse, same strategy as `ai::parse_cleaned`: try the whole text
/// as JSON, then fall back to the outermost `{...}` slice if the model wraps
/// it in prose or markdown. Any `trackIds` not present in `pool_ids` are
/// dropped — never trusted as a real track — and empty/unknown sets just
/// come back with fewer ids rather than erroring the whole run.
pub(crate) fn parse_playlist_response(text: &str, pool_ids: &[u32]) -> PlaylistAiResult {
    let text = strip_reasoning(text);
    let parsed = serde_json::from_str::<Value>(text.trim())
        .ok()
        .or_else(|| extract_json_object(text).and_then(|s| serde_json::from_str::<Value>(s).ok()));

    let Some(v) = parsed else {
        return PlaylistAiResult::default();
    };

    let valid: std::collections::HashSet<u32> = pool_ids.iter().copied().collect();
    let sets = v["sets"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|s| {
                    let name = s["name"].as_str()?.trim().to_string();
                    if name.is_empty() {
                        return None;
                    }
                    let track_ids: Vec<u32> = s["trackIds"]
                        .as_array()
                        .map(|ids| {
                            ids.iter()
                                .filter_map(|id| id.as_u64().map(|n| n as u32))
                                .filter(|id| valid.contains(id))
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(PlaylistSet { name, track_ids })
                })
                .collect()
        })
        .unwrap_or_default();

    let suggestions = v["suggestions"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|s| s.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    PlaylistAiResult { sets, suggestions }
}

fn strip_reasoning(text: &str) -> &str {
    match text.rfind("</think>") {
        Some(pos) => &text[pos + "</think>".len()..],
        None => text,
    }
}

fn extract_json_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    (end > start).then(|| &text[start..=end])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool() -> Vec<PlaylistTrackInput> {
        vec![
            PlaylistTrackInput { id: 1, artist: "A".into(), title: "One".into(), genre: "House".into(), year: "2020".into(), bpm: "124".into() },
            PlaylistTrackInput { id: 2, artist: "B".into(), title: "Two".into(), genre: "House".into(), year: "2021".into(), bpm: "126".into() },
        ]
    }

    #[test]
    fn parses_clean_json() {
        let text = r#"{"sets":[{"name":"Warm-up","trackIds":[1,2]}],"suggestions":["X - Y"]}"#;
        let r = parse_playlist_response(text, &[1, 2]);
        assert_eq!(r.sets.len(), 1);
        assert_eq!(r.sets[0].track_ids, vec![1, 2]);
        assert_eq!(r.suggestions, vec!["X - Y".to_string()]);
    }

    #[test]
    fn drops_unknown_ids_never_invents_tracks() {
        let text = r#"{"sets":[{"name":"Warm-up","trackIds":[1,999,2,4242]}]}"#;
        let r = parse_playlist_response(text, &[1, 2]);
        assert_eq!(r.sets[0].track_ids, vec![1, 2]);
    }

    #[test]
    fn extracts_object_from_prose_wrapper() {
        let text = "Sure! Here you go:\n```json\n{\"sets\":[{\"name\":\"Peak\",\"trackIds\":[1]}]}\n```\nEnjoy.";
        let r = parse_playlist_response(text, &[1, 2]);
        assert_eq!(r.sets[0].name, "Peak");
        assert_eq!(r.sets[0].track_ids, vec![1]);
    }

    #[test]
    fn malformed_response_yields_empty_result_not_error() {
        let r = parse_playlist_response("not json at all", &[1, 2]);
        assert!(r.sets.is_empty());
        assert!(r.suggestions.is_empty());
    }

    #[test]
    fn prompt_includes_pool_and_set_targets() {
        let specs = vec![
            PlaylistSetSpec { name: "Warm-up".into(), target_count: Some(10) },
            PlaylistSetSpec { name: "Peak".into(), target_count: None },
        ];
        let prompt = build_playlist_prompt(&pool(), "wedding, no explicit", &specs).unwrap();
        assert!(prompt.contains("Warm-up"));
        assert!(prompt.contains("about 10 tracks"));
        assert!(prompt.contains("Peak"));
        assert!(prompt.contains("wedding, no explicit"));
        assert!(prompt.contains("\"id\": 1"));
    }
}
