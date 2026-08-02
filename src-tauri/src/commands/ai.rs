use std::time::Duration;

use serde_json::{json, Value};

use crate::models::{CleanedTrack, GenreInput, GenreResult, OllamaStatus, TrackInput};

/// Non-Latin writing systems the user can opt into transliterating. Names
/// must match what the frontend's TRANSLITERATE_SCRIPTS list sends.
const SCRIPTS: &[&str] = &["Cyrillic", "Hebrew", "Arabic", "Greek", "Chinese/Japanese/Korean"];

fn script_rules(transliterate: &[String]) -> String {
    SCRIPTS
        .iter()
        .map(|name| {
            let wants_transliteration = transliterate.iter().any(|s| s.eq_ignore_ascii_case(name));
            let instruction = if wants_transliteration {
                "transliterate it phonetically into Latin letters (romanize how it sounds — do not translate the meaning)"
            } else {
                "keep it exactly as written — do not transliterate or translate it"
            };
            format!("   - {name}: {instruction}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Builds the exact prompt sent to the model. `transliterate` lists the
/// scripts (from `SCRIPTS`) the user wants romanized instead of preserved —
/// also used verbatim by `ai_preview_prompt` so the Settings UI can show the
/// user precisely what will be sent, never a hand-written summary that could
/// drift out of sync.
fn build_system_prompt(transliterate: &[String]) -> String {
    let rules = script_rules(transliterate);
    format!(
        r#"You are a music metadata cleanup expert. You will receive a list of audio tracks with messy metadata and must return cleaned versions.
RULES:
1. ARTIST: Keep only the main/lead artist. Remove all of the following from the artist field:
   - Legal full names (e.g. "Benito Antonio Martinez Ocasio" → remove, keep "Bad Bunny")
   - Co-writers, producers, publishers
   - Featured artists (ft., feat., &, x, N, -)
   - Duplicate names or alternative spellings of the same artist
   - Record label names
   - YouTube channel names (if the artist field looks like a channel, decode the real artist from the title)
2. TITLE: Keep only the clean song name. Strip ALL of the following suffixes/additions:
   - (Radio Edit), (Club Mix), (Extended Mix), (Original Mix), (Album Version)
   - (feat. X), (ft. X), (with X), (Feat X), -Feat-
   - (Remastered YYYY), (Remastered), [Remastered]
   - (Live), (Live at X), (Acoustic), (Acoustic Version)
   - (Official Video), (Official Audio), (Music Video), (Lyric Video)
   - (Explicit), [Explicit], (Clean), (Dirty)
   - (Remix), (X Remix), -X Remix-, [X Remix]
   - (Slowed), (Sped Up), (Pitched), (Nightcore)
   - Any version tags in any language
   - YouTube video titles embedded in the tag — extract just the song name
3. YEAR: Return the ORIGINAL release year of the song (when it was first ever released commercially or publicly), NOT the year of a remaster, re-release, streaming upload, or compilation. Use your music knowledge. If you are not certain, leave the existing year unchanged.
4. GENRE: Normalize to a standard single genre. Use common terms like: Pop, Rock, Hip-Hop, R&B, Reggaeton, House, Techno, Trance, Electronic, Dance, Folk, Country, Jazz, Classical, Metal, Punk, Soul, Funk, Latin, Reggae, Indie, Alternative. Do not use subgenres unless they are very widely recognized.
5. Do NOT change Album, Track Number, Disc Number, or Album Artist unless they are clearly wrong.
6. SCRIPTS: Apply this per writing system, to both Artist and Title:
{rules}
   Any other non-Latin script not listed above: keep it exactly as written.
7. For mashups (two songs blended together), keep the mashup creator as the artist and format the title as: "Song1 N Song2"
8. FILENAME FALLBACK: Every track includes a "filename" field. When the artist or title is empty, missing, or clearly junk, derive them from the filename — filenames are usually "Artist - Title" or "Artist - Title (Mix)". Apply all the cleaning rules above to values you take from the filename. If, after using both the metadata AND the filename, you still cannot determine the artist or the title, return an empty string "" for that field (do not guess a random value).
OUTPUT FORMAT: Return ONLY a valid JSON array, no explanation, no markdown, no preamble:
[
  {{
    "index": 1,
    "artist": "cleaned artist",
    "title": "cleaned title",
    "year": "YYYY",
    "genre": "Genre"
  }},
  ...
]"#
    )
}

/// Returns the exact prompt `ai_clean_batch` would send for the given
/// transliteration choices, without needing a track list — used by the
/// Settings UI's "What does AI Clean do?" viewer.
#[tauri::command]
pub fn ai_preview_prompt(transliterate_scripts: Vec<String>) -> String {
    build_system_prompt(&transliterate_scripts)
}

#[tauri::command]
pub async fn check_ollama(url: String) -> OllamaStatus {
    let client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return OllamaStatus {
                running: false,
                models: vec![],
                error: Some(e.to_string()),
            }
        }
    };
    let endpoint = format!("{}/api/tags", url.trim_end_matches('/'));
    match client.get(&endpoint).send().await {
        Ok(resp) if resp.status().is_success() => match resp.json::<Value>().await {
            Ok(v) => {
                let models = v["models"]
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|m| m["name"].as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                OllamaStatus {
                    running: true,
                    models,
                    error: None,
                }
            }
            Err(e) => OllamaStatus {
                running: false,
                models: vec![],
                error: Some(format!("Unexpected response from Ollama: {e}")),
            },
        },
        Ok(resp) => OllamaStatus {
            running: false,
            models: vec![],
            error: Some(format!("Ollama returned HTTP {}", resp.status())),
        },
        Err(e) => OllamaStatus {
            running: false,
            models: vec![],
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub async fn ai_clean_batch(
    url: String,
    model: String,
    tracks: Vec<TrackInput>,
    transliterate_scripts: Vec<String>,
) -> Result<Vec<CleanedTrack>, String> {
    let track_list = serde_json::to_string_pretty(&tracks).map_err(|e| e.to_string())?;
    let system_prompt = build_system_prompt(&transliterate_scripts);
    let prompt = format!("{system_prompt}\n\nTrack list to clean:\n{track_list}");
    let body = json!({
        "model": model,
        "prompt": prompt,
        "stream": false,
        "format": "json"
    });

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        // Local models can take a long time on big batches.
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
    let text = v["response"]
        .as_str()
        .ok_or_else(|| "Ollama response is missing the 'response' field".to_string())?;
    parse_cleaned(text)
}

/// Maps each track's genre to the single best fit from `genres` (the user's
/// preset). The model must choose from the list — never invent a genre.
#[tauri::command]
pub async fn ai_map_genre_batch(
    url: String,
    model: String,
    tracks: Vec<GenreInput>,
    genres: Vec<String>,
) -> Result<Vec<GenreResult>, String> {
    let track_list = serde_json::to_string_pretty(&tracks).map_err(|e| e.to_string())?;
    let allowed = genres.join(", ");
    let prompt = format!(
        "You are a music genre classifier. For each track, choose the SINGLE best-fitting \
genre from THIS EXACT LIST and no others:\n[{allowed}]\n\n\
Rules:\n\
- You MUST return one of the listed genres verbatim (exact spelling) for every track.\n\
- Use the artist, title, and any existing genre to decide.\n\
- If unsure, pick the closest match from the list.\n\
OUTPUT: Return ONLY a JSON array like \
[{{\"index\":1,\"genre\":\"Genre From List\"}}], no prose.\n\n\
Tracks:\n{track_list}"
    );
    let body = json!({
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
    let text = v["response"]
        .as_str()
        .ok_or_else(|| "Ollama response is missing the 'response' field".to_string())?;
    parse_genres(text, &genres)
}

fn parse_genres(text: &str, allowed: &[String]) -> Result<Vec<GenreResult>, String> {
    let text = strip_reasoning(text);
    let value: Value = serde_json::from_str(text.trim())
        .or_else(|_| {
            extract_json_array(text)
                .ok_or(())
                .and_then(|s| serde_json::from_str(s).map_err(|_| ()))
        })
        .map_err(|_| {
            let preview: String = text.chars().take(200).collect();
            format!("Could not parse the AI genre response: {preview}")
        })?;
    let arr = match &value {
        Value::Array(a) => a.clone(),
        Value::Object(o) => o
            .values()
            .find_map(|x| x.as_array().cloned())
            .unwrap_or_default(),
        _ => vec![],
    };
    let results = arr
        .iter()
        .filter_map(|v| {
            let index = v.get("index").and_then(|i| {
                i.as_u64().or_else(|| i.as_str().and_then(|s| s.parse().ok()))
            })? as u32;
            let raw = v.get("genre").and_then(|g| g.as_str()).unwrap_or("").trim();
            // Snap to an allowed genre (case-insensitive), else drop.
            let genre = allowed
                .iter()
                .find(|g| g.eq_ignore_ascii_case(raw))
                .cloned();
            Some(GenreResult { index, genre })
        })
        .collect();
    Ok(results)
}

fn parse_cleaned(text: &str) -> Result<Vec<CleanedTrack>, String> {
    let text = strip_reasoning(text);
    if let Ok(v) = serde_json::from_str::<Value>(text.trim()) {
        if let Some(tracks) = tracks_from_value(&v) {
            return Ok(tracks);
        }
    }
    // Some models wrap the JSON in prose or markdown fences despite
    // instructions — fall back to the outermost [...] slice.
    if let Some(slice) = extract_json_array(text) {
        if let Ok(v) = serde_json::from_str::<Value>(slice) {
            if let Some(tracks) = tracks_from_value(&v) {
                return Ok(tracks);
            }
        }
    }
    let preview: String = text.chars().take(300).collect();
    Err(format!("Could not parse the AI response as JSON: {preview}"))
}

/// Reasoning models (deepseek-r1 etc.) may emit a <think> block first.
fn strip_reasoning(text: &str) -> &str {
    match text.rfind("</think>") {
        Some(pos) => &text[pos + "</think>".len()..],
        None => text,
    }
}

fn extract_json_array(text: &str) -> Option<&str> {
    let start = text.find('[')?;
    let end = text.rfind(']')?;
    (end > start).then(|| &text[start..=end])
}

fn tracks_from_value(v: &Value) -> Option<Vec<CleanedTrack>> {
    let arr = match v {
        Value::Array(a) => a,
        // format:"json" sometimes yields {"tracks": [...]} — take the
        // first array-valued member.
        Value::Object(o) => o.values().find_map(|x| x.as_array())?,
        _ => return None,
    };
    let tracks: Vec<CleanedTrack> = arr.iter().filter_map(track_from_value).collect();
    if tracks.is_empty() {
        None
    } else {
        Some(tracks)
    }
}

fn track_from_value(v: &Value) -> Option<CleanedTrack> {
    let index = v
        .get("index")
        .and_then(|i| i.as_u64().or_else(|| i.as_str().and_then(|s| s.parse().ok())))?;
    let text = |key: &str| -> Option<String> {
        let field = v.get(key)?;
        let s = field
            .as_str()
            .map(str::to_string)
            .or_else(|| field.as_u64().map(|n| n.to_string()))?;
        let s = s.trim().to_string();
        (!s.is_empty()).then_some(s)
    };
    Some(CleanedTrack {
        index: index as u32,
        artist: text("artist"),
        title: text("title"),
        year: text("year"),
        genre: text("genre"),
    })
}
