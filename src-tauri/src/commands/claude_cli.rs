//! The Claude Code CLI as an AI backend (v0.13).
//!
//! AI Clean already had two backends: Ollama (local, free, weaker) and
//! manual (paste the prompt into whatever you like, then paste the answer
//! back). This adds a third that is neither: drive the `claude` CLI that is
//! already installed and already signed in, so cleaning a few hundred tracks
//! needs no copy/paste *and* no separate API key or bill — it runs on the
//! Claude subscription the machine already has.
//!
//! The whole integration is `claude --print`, its documented non-interactive
//! mode. The same prompt builders and the same tolerant response parsers the
//! other two backends use are reused verbatim (`ai::build_clean_prompt`,
//! `ai::parse_cleaned`, …) — a second copy of the rules would drift, and
//! "the AI answered differently depending on which backend you picked" is a
//! very unpleasant bug to chase.
//!
//! Two things about detection are worth knowing before changing this:
//!
//! 1. **Being installed is not the same as being usable.** The copy bundled
//!    inside the Claude desktop app authenticates through the app's own
//!    session, so invoking it standalone returns `{"is_error": true,
//!    "result": "Not logged in · Please run /login"}` — a perfectly healthy
//!    binary that cannot answer. The probe therefore checks *login*, not
//!    just presence, and the UI says which of the two is wrong.
//! 2. **The envelope reports failure in the body, not the exit code.** A
//!    refusal, a rate limit and a login problem all come back as valid JSON
//!    with `is_error: true`, so the error text has to be read out of
//!    `result`.

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::commands::ai;
use crate::commands::ffmpeg::hide_console;
use crate::models::{CleanedTrack, GenreInput, GenreResult, TrackInput};

#[cfg(target_os = "windows")]
const CLAUDE_EXE: &str = "claude.exe";
#[cfg(not(target_os = "windows"))]
const CLAUDE_EXE: &str = "claude";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCliInfo {
    /// A `claude` binary was found.
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    /// It answered a trivial prompt — i.e. it is signed in and usable.
    /// `found && !logged_in` is the desktop-app-bundled case.
    pub logged_in: bool,
    /// Why it isn't usable, when it isn't.
    pub error: Option<String>,
}

fn on_path() -> Option<PathBuf> {
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let p = dir.join(CLAUDE_EXE);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    // A GUI app launched from Finder/Dock/the Windows shell doesn't inherit a
    // shell PATH, so the two places `claude` actually gets installed to are
    // checked directly rather than relying on PATH alone.
    //
    // 1. npm's global bin (`npm i -g @anthropic-ai/claude-code`).
    // 2. The native installer (`irm https://claude.ai/install.ps1 | iex` on
    //    Windows, the equivalent curl script on macOS/Linux), which drops
    //    `claude` in `~/.local/bin` and tells the user to add that to PATH
    //    themselves — a step it's easy to skip, so this app shouldn't
    //    require it.
    #[cfg(target_os = "macos")]
    for dir in ["/opt/homebrew/bin", "/usr/local/bin"] {
        let p = PathBuf::from(dir).join(CLAUDE_EXE);
        if p.is_file() {
            return Some(p);
        }
    }
    #[cfg(target_os = "windows")]
    if let Ok(appdata) = std::env::var("APPDATA") {
        for name in ["claude.cmd", "claude.exe"] {
            let p = PathBuf::from(&appdata).join("npm").join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    #[cfg(target_os = "windows")]
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let p = PathBuf::from(&profile).join(".local").join("bin").join(CLAUDE_EXE);
        if p.is_file() {
            return Some(p);
        }
    }
    #[cfg(unix)]
    if let Ok(home) = std::env::var("HOME") {
        let p = PathBuf::from(&home).join(".local").join("bin").join(CLAUDE_EXE);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// The copy the Claude desktop app ships, under a version-named folder.
///
/// Used only as a fallback: it is frequently *not* signed in for standalone
/// use (its credentials belong to the app session), so a real CLI install on
/// `PATH` is always preferred. Picking the highest version string keeps this
/// working after the app updates itself.
#[cfg(target_os = "windows")]
fn bundled_with_desktop_app() -> Option<PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    let root = PathBuf::from(appdata).join("Claude").join("claude-code");
    let mut versions: Vec<PathBuf> = std::fs::read_dir(&root)
        .ok()?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.join(CLAUDE_EXE).is_file())
        .collect();
    versions.sort();
    versions.pop().map(|p| p.join(CLAUDE_EXE))
}

#[cfg(target_os = "macos")]
fn bundled_with_desktop_app() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let root = PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("Claude")
        .join("claude-code");
    let mut versions: Vec<PathBuf> = std::fs::read_dir(&root)
        .ok()?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.join(CLAUDE_EXE).is_file())
        .collect();
    versions.sort();
    versions.pop().map(|p| p.join(CLAUDE_EXE))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn bundled_with_desktop_app() -> Option<PathBuf> {
    None
}

pub fn find_claude() -> Option<PathBuf> {
    on_path().or_else(bundled_with_desktop_app)
}

fn version_of(exe: &PathBuf) -> Option<String> {
    let mut cmd = Command::new(exe);
    cmd.arg("--version");
    hide_console(&mut cmd);
    let out = cmd.output().ok()?;
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!v.is_empty()).then_some(v)
}

/// Runs one non-interactive prompt and returns the assistant's text.
///
/// `--print` with `--output-format json` gives a single JSON envelope whose
/// `result` field holds the answer — or, when `is_error` is set, the reason
/// there isn't one. The CLI exits non-zero in that case too, but the body is
/// still valid JSON and carries the only useful message, so the body is
/// parsed first and the exit code is only a fallback.
fn run_prompt(exe: &PathBuf, prompt: &str, model: Option<&str>) -> Result<(String, Value), String> {
    let mut cmd = Command::new(exe);
    cmd.arg("--print")
        .arg(prompt)
        .arg("--output-format")
        .arg("json")
        // Tag work is pure text transformation: no file access, no shell, no
        // network. Denying the tools outright means a prompt built from
        // someone's tag data can never talk the CLI into touching the disk.
        .arg("--allowedTools")
        .arg("")
        .arg("--append-system-prompt")
        .arg("Return only the requested JSON. Do not use any tools.");
    if let Some(m) = model.filter(|m| !m.trim().is_empty()) {
        cmd.arg("--model").arg(m);
    }
    hide_console(&mut cmd);

    let out = cmd
        .output()
        .map_err(|e| format!("Could not run the Claude CLI: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();

    let envelope: Value = serde_json::from_str(stdout.trim()).map_err(|_| {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let detail = stderr
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("no output")
            .trim()
            .to_string();
        format!("The Claude CLI returned something unexpected: {detail}")
    })?;

    let text = envelope["result"].as_str().unwrap_or("").to_string();
    if envelope["is_error"].as_bool().unwrap_or(false) {
        let msg = if text.is_empty() { "unknown error".to_string() } else { text };
        return Err(if msg.contains("Not logged in") {
            "The Claude CLI is installed but not signed in. Run `claude` once in a terminal and \
             log in, then try again."
                .to_string()
        } else {
            format!("Claude CLI: {msg}")
        });
    }
    if text.trim().is_empty() {
        return Err("The Claude CLI returned an empty response".to_string());
    }
    Ok((text, envelope))
}

/// Reports usage the same way the Ollama path does, so the usage dashboard
/// counts every backend rather than silently under-reporting this one.
fn emit_usage(app: &AppHandle, envelope: &Value, tracks: usize) {
    let usage = &envelope["usage"];
    let _ = app.emit(
        "ai-usage",
        serde_json::json!({
            "model": envelope["modelUsage"]
                .as_object()
                .and_then(|m| m.keys().next().cloned())
                .unwrap_or_else(|| "claude-cli".to_string()),
            "promptTokens": usage["input_tokens"].as_u64().unwrap_or(0),
            "completionTokens": usage["output_tokens"].as_u64().unwrap_or(0),
            "songs": tracks,
        }),
    );
}

#[tauri::command]
pub async fn claude_cli_info() -> ClaudeCliInfo {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(exe) = find_claude() else {
            return ClaudeCliInfo {
                found: false,
                path: None,
                version: None,
                logged_in: false,
                error: Some(
                    "No Claude CLI found. Install it with `npm i -g @anthropic-ai/claude-code`."
                        .to_string(),
                ),
            };
        };
        let version = version_of(&exe);
        // The cheapest possible real call: it costs a handful of tokens and
        // is the only way to tell "installed" from "actually usable".
        let (logged_in, error) = match run_prompt(&exe, "Reply with exactly: OK", None) {
            Ok(_) => (true, None),
            Err(e) => (false, Some(e)),
        };
        ClaudeCliInfo {
            found: true,
            path: Some(exe.to_string_lossy().to_string()),
            version,
            logged_in,
            error,
        }
    })
    .await
    .unwrap_or(ClaudeCliInfo {
        found: false,
        path: None,
        version: None,
        logged_in: false,
        error: Some("The Claude CLI probe failed unexpectedly".to_string()),
    })
}

#[tauri::command]
pub async fn claude_clean_batch(
    app: AppHandle,
    tracks: Vec<TrackInput>,
    transliterate_scripts: Vec<String>,
    model: Option<String>,
) -> Result<Vec<CleanedTrack>, String> {
    let count = tracks.len();
    let prompt = ai::build_clean_prompt(&tracks, &transliterate_scripts)?;
    let (text, envelope) = tauri::async_runtime::spawn_blocking(move || {
        let exe = find_claude().ok_or_else(|| {
            "No Claude CLI found — install it, or switch the AI backend in Settings.".to_string()
        })?;
        run_prompt(&exe, &prompt, model.as_deref())
    })
    .await
    .map_err(|_| "The Claude CLI task panicked".to_string())??;

    emit_usage(&app, &envelope, count);
    ai::parse_cleaned(&text)
}

#[tauri::command]
pub async fn claude_genre_batch(
    app: AppHandle,
    tracks: Vec<GenreInput>,
    genres: Vec<String>,
    model: Option<String>,
) -> Result<Vec<GenreResult>, String> {
    let count = tracks.len();
    let prompt = ai::build_genre_prompt(&tracks, &genres)?;
    let allowed = genres.clone();
    let (text, envelope) = tauri::async_runtime::spawn_blocking(move || {
        let exe = find_claude().ok_or_else(|| {
            "No Claude CLI found — install it, or switch the AI backend in Settings.".to_string()
        })?;
        run_prompt(&exe, &prompt, model.as_deref())
    })
    .await
    .map_err(|_| "The Claude CLI task panicked".to_string())??;

    emit_usage(&app, &envelope, count);
    ai::parse_genres(&text, &allowed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The exact envelope the real CLI returns when it is installed but its
    /// credentials belong to the desktop app rather than a standalone login.
    /// Captured from a real run, because guessing this shape is how you ship
    /// a backend that reports "unexpected output" for the one failure every
    /// new user hits first.
    fn not_logged_in_envelope() -> Value {
        json!({
            "type": "result",
            "subtype": "success",
            "is_error": true,
            "result": "Not logged in · Please run /login",
            "usage": { "input_tokens": 0, "output_tokens": 0 },
            "total_cost_usd": 0
        })
    }

    /// Mirrors `run_prompt`'s envelope handling so it can be tested without
    /// spawning the real binary.
    fn interpret(envelope: &Value) -> Result<String, String> {
        let text = envelope["result"].as_str().unwrap_or("").to_string();
        if envelope["is_error"].as_bool().unwrap_or(false) {
            let msg = if text.is_empty() { "unknown error".to_string() } else { text };
            return Err(if msg.contains("Not logged in") {
                "The Claude CLI is installed but not signed in. Run `claude` once in a terminal and \
                 log in, then try again."
                    .to_string()
            } else {
                format!("Claude CLI: {msg}")
            });
        }
        if text.trim().is_empty() {
            return Err("The Claude CLI returned an empty response".to_string());
        }
        Ok(text)
    }

    #[test]
    fn a_not_logged_in_envelope_becomes_actionable_advice() {
        let err = interpret(&not_logged_in_envelope()).unwrap_err();
        assert!(err.contains("not signed in"), "got: {err}");
        assert!(err.contains("claude"), "should say how to fix it: {err}");
    }

    #[test]
    fn an_error_envelope_surfaces_the_reason_rather_than_an_exit_code() {
        let v = json!({ "is_error": true, "result": "Rate limit exceeded" });
        assert_eq!(interpret(&v).unwrap_err(), "Claude CLI: Rate limit exceeded");
    }

    #[test]
    fn a_successful_envelope_yields_its_result_text() {
        let v = json!({ "is_error": false, "result": "[{\"index\":1,\"genre\":\"Techno\"}]" });
        assert_eq!(interpret(&v).unwrap(), "[{\"index\":1,\"genre\":\"Techno\"}]");
    }

    /// `is_error` absent must not be read as an error — the field is only
    /// present on some envelopes.
    #[test]
    fn a_missing_is_error_field_is_not_a_failure() {
        let v = json!({ "result": "OK" });
        assert_eq!(interpret(&v).unwrap(), "OK");
    }

    #[test]
    fn an_empty_result_is_an_error_not_an_empty_parse() {
        let v = json!({ "is_error": false, "result": "   " });
        assert!(interpret(&v).is_err());
    }

    /// The CLI's own response is fed to the same parser the Ollama and manual
    /// backends use, so all three must accept the same shapes — including a
    /// fenced block, which is what a chat-tuned model tends to return.
    #[test]
    fn the_shared_parser_accepts_what_the_cli_typically_returns() {
        let fenced = "```json\n[{\"index\":1,\"artist\":\"Boris Brejcha\",\"title\":\"Gravity\"}]\n```";
        let parsed = ai::parse_cleaned(fenced).expect("fenced JSON should parse");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].artist.as_deref(), Some("Boris Brejcha"));
    }
}
