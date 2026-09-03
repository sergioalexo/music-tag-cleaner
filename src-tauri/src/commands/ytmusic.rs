//! YouTube Music playlist import (v0.9 F4): fetches a playlist's track list
//! via `yt-dlp` (metadata only — nothing is ever downloaded) so the frontend
//! can match it against the loaded collection and export a Rekordbox
//! playlist. yt-dlp is treated as an optional external tool, the same way
//! `components.rs` treats Ollama: detected on PATH or in a per-app bundled
//! location, with a one-click download if it's missing.
//!
//! Empirically validated against real playlists (see `fetch_ytmusic_playlist`
//! doc comment) before writing the matching logic that depends on it:
//! `yt-dlp -J --flat-playlist` returns each entry's `id`, `title` and
//! `duration` in a single fast request (no per-video fetch, so a 100-track
//! playlist costs one HTTP round trip, not a hundred) — but *not* separate
//! artist/track/album fields, even for videos uploaded to an artist's
//! official channel. Those fields exist in yt-dlp's schema and are read here
//! when present (a future yt-dlp version, or a differently-shaped playlist,
//! may populate them), but the matching step this feeds can't assume they
//! will be — it has to work from `title` and `duration` alone.

use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "windows")]
const YTDLP_EXE: &str = "yt-dlp.exe";
#[cfg(not(target_os = "windows"))]
const YTDLP_EXE: &str = "yt-dlp";

#[cfg(target_os = "windows")]
const YTDLP_ASSET_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
#[cfg(target_os = "macos")]
const YTDLP_ASSET_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
#[cfg(all(unix, not(target_os = "macos")))]
const YTDLP_ASSET_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YtDlpInfo {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistEntry {
    pub index: usize,
    pub video_id: String,
    pub url: String,
    pub title: String,
    pub duration_secs: Option<f64>,
    /// The uploading channel, when yt-dlp includes one for this entry.
    /// Often the artist's name, sometimes suffixed " - Topic" for
    /// auto-generated YouTube Music uploads — stripping that suffix is left
    /// to the matching step, not this fetch.
    pub uploader: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistFetchResult {
    pub title: String,
    pub entries: Vec<PlaylistEntry>,
}

#[cfg(target_os = "windows")]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(target_os = "windows"))]
fn hide_console(_cmd: &mut Command) {}

fn bundled_ytdlp_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    Some(dir.join("bin").join(YTDLP_EXE))
}

/// Bundled copy first (something we downloaded ourselves and know the
/// version of), then anywhere on `PATH` (a system-wide install, e.g. via pip
/// or a package manager, which the user may already have for other tools).
fn find_ytdlp(app: &AppHandle) -> Option<PathBuf> {
    if let Some(p) = bundled_ytdlp_path(app) {
        if p.exists() {
            return Some(p);
        }
    }
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let p = dir.join(YTDLP_EXE);
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

fn ytdlp_version(exe: &PathBuf) -> Option<String> {
    let mut cmd = Command::new(exe);
    cmd.arg("--version");
    hide_console(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

#[tauri::command]
pub async fn ytdlp_info(app: AppHandle) -> YtDlpInfo {
    tauri::async_runtime::spawn_blocking(move || match find_ytdlp(&app) {
        Some(exe) => YtDlpInfo {
            installed: true,
            version: ytdlp_version(&exe),
            path: Some(exe.to_string_lossy().to_string()),
        },
        None => YtDlpInfo { installed: false, version: None, path: None },
    })
    .await
    .unwrap_or(YtDlpInfo { installed: false, version: None, path: None })
}

fn emit_install_progress(app: &AppHandle, phase: &str, downloaded: u64, total: u64) {
    let _ = app.emit(
        "ytdlp-install-progress",
        serde_json::json!({ "phase": phase, "downloaded": downloaded, "total": total }),
    );
}

/// Downloads yt-dlp's standalone binary release straight from GitHub into
/// the app's own data directory — no installer, no PATH changes, and no
/// interference with a system-wide yt-dlp the user might already have (that
/// one is still preferred by `find_ytdlp` only if it's actually on `PATH`;
/// this bundled copy is the fallback either way covers).
#[tauri::command]
pub async fn install_ytdlp(app: AppHandle) -> Result<(), String> {
    let dest = bundled_ytdlp_path(&app).ok_or_else(|| "Could not resolve the app data directory".to_string())?;
    let dir = dest
        .parent()
        .ok_or_else(|| "Could not resolve the app data directory".to_string())?
        .to_path_buf();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client
        .get(YTDLP_ASSET_URL)
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    let mut last_emitted: u64 = 0;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("Download failed: {e}"))? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        if downloaded - last_emitted >= 256 * 1024 {
            last_emitted = downloaded;
            emit_install_progress(&app, "downloading", downloaded, total);
        }
    }
    drop(file);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dest).map_err(|e| e.to_string())?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&dest, perms).map_err(|e| e.to_string())?;
    }

    emit_install_progress(&app, "done", downloaded, total.max(downloaded));
    Ok(())
}

/// Parses `yt-dlp -J --flat-playlist`'s output. Shared with tests so the
/// parsing logic can be checked against fixture JSON without running the
/// real binary.
///
/// Handles the shapes actually seen from real playlists: a `null` entry for
/// a removed/private video (skipped, not an error), an entry missing `id`
/// (skipped — nothing to match or link to), and a single-video URL where
/// yt-dlp returns one object with no `entries` wrapper at all (treated as a
/// one-track "playlist").
fn parse_playlist_json(raw: &str) -> Result<PlaylistFetchResult, String> {
    let v: Value = serde_json::from_str(raw).map_err(|e| format!("Could not parse yt-dlp output: {e}"))?;
    let title = v["title"].as_str().unwrap_or("YouTube Music Playlist").to_string();
    let raw_entries: Vec<Value> = match v.get("entries").and_then(Value::as_array) {
        Some(arr) => arr.clone(),
        None => vec![v.clone()],
    };

    let mut entries = Vec::with_capacity(raw_entries.len());
    for e in raw_entries.iter() {
        if e.is_null() {
            continue;
        }
        let Some(video_id) = e["id"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        let title = e["title"].as_str().unwrap_or("Unknown title").to_string();
        let uploader = e["uploader"]
            .as_str()
            .or_else(|| e["channel"].as_str())
            .map(String::from);
        entries.push(PlaylistEntry {
            index: entries.len(),
            url: format!("https://music.youtube.com/watch?v={video_id}"),
            video_id: video_id.to_string(),
            title,
            duration_secs: e["duration"].as_f64(),
            uploader,
        });
    }
    Ok(PlaylistFetchResult { title, entries })
}

/// Fetches a playlist's track list — title, duration, video id — via one
/// `yt-dlp -J --flat-playlist` call (no per-video requests, no downloading).
/// Works for both `music.youtube.com/playlist?list=…` and plain
/// `youtube.com/playlist?list=…` URLs: both route through yt-dlp's same
/// `youtube:tab` extractor, confirmed by fetching the same playlist ID
/// through each domain during development and diffing the results.
#[tauri::command]
pub async fn fetch_ytmusic_playlist(app: AppHandle, url: String) -> Result<PlaylistFetchResult, String> {
    let exe = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || find_ytdlp(&app)
    })
    .await
    .map_err(|_| "yt-dlp lookup task panicked".to_string())?
    .ok_or_else(|| "yt-dlp is not installed — install it from Settings first".to_string())?;

    let output = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&exe);
        cmd.args(["-J", "--flat-playlist", "--no-warnings", "--ignore-errors", &url]);
        hide_console(&mut cmd);
        cmd.output()
    })
    .await
    .map_err(|_| "yt-dlp task panicked".to_string())?
    .map_err(|e| format!("Could not run yt-dlp: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = stderr
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("yt-dlp failed")
            .trim()
            .to_string();
        return Err(format!("yt-dlp error: {msg}"));
    }

    let raw = String::from_utf8_lossy(&output.stdout).to_string();
    let result = parse_playlist_json(&raw)?;
    if result.entries.is_empty() {
        return Err("No tracks found in that playlist — is it public?".to_string());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_flat_playlist_with_entries_wrapper() {
        let raw = r#"{
            "title": "Uploads from Rick Astley",
            "entries": [
                {"id": "ihRdK3x3cUY", "title": "A message from Rick", "duration": 24, "_type": "url"},
                {"id": "JjI4o2w6D5A", "title": "Cologne thanks", "duration": 21, "_type": "url"}
            ]
        }"#;
        let result = parse_playlist_json(raw).unwrap();
        assert_eq!(result.title, "Uploads from Rick Astley");
        assert_eq!(result.entries.len(), 2);
        assert_eq!(result.entries[0].video_id, "ihRdK3x3cUY");
        assert_eq!(result.entries[0].duration_secs, Some(24.0));
        assert_eq!(result.entries[0].index, 0);
        assert_eq!(result.entries[1].index, 1);
        assert_eq!(
            result.entries[0].url,
            "https://music.youtube.com/watch?v=ihRdK3x3cUY"
        );
    }

    #[test]
    fn skips_null_entries_for_removed_or_private_videos() {
        let raw = r#"{
            "title": "Mixed availability",
            "entries": [
                {"id": "abc123", "title": "Still up", "duration": 200},
                null,
                {"id": "def456", "title": "Also up", "duration": 180}
            ]
        }"#;
        let result = parse_playlist_json(raw).unwrap();
        assert_eq!(result.entries.len(), 2);
        assert_eq!(result.entries[0].video_id, "abc123");
        assert_eq!(result.entries[1].video_id, "def456");
        // Re-indexed after skipping, not the original array position.
        assert_eq!(result.entries[1].index, 1);
    }

    #[test]
    fn skips_entries_missing_an_id() {
        let raw = r#"{"title": "x", "entries": [{"title": "no id here"}, {"id": "ok1", "title": "fine"}]}"#;
        let result = parse_playlist_json(raw).unwrap();
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].video_id, "ok1");
    }

    #[test]
    fn falls_back_to_channel_when_uploader_is_absent() {
        let raw = r#"{"title": "x", "entries": [{"id": "v1", "title": "t", "channel": "Some Artist - Topic"}]}"#;
        let result = parse_playlist_json(raw).unwrap();
        assert_eq!(result.entries[0].uploader.as_deref(), Some("Some Artist - Topic"));
    }

    #[test]
    fn a_single_video_url_with_no_entries_wrapper_becomes_a_one_track_playlist() {
        let raw = r#"{"id": "solo1", "title": "Just one video", "duration": 213}"#;
        let result = parse_playlist_json(raw).unwrap();
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].video_id, "solo1");
    }

    #[test]
    fn an_entirely_empty_playlist_parses_to_zero_entries_rather_than_erroring() {
        let raw = r#"{"title": "Empty", "entries": []}"#;
        let result = parse_playlist_json(raw).unwrap();
        assert_eq!(result.entries.len(), 0);
    }

    /// Runs the real `yt-dlp -J --flat-playlist` call this module relies on
    /// against a real, stable public playlist (a channel's own uploads
    /// list, which every channel has and which doesn't disappear the way a
    /// curated/auto-generated mix can) and feeds the output through
    /// `parse_playlist_json` — the same fixture-shaped assumptions the unit
    /// tests above check, but against what YouTube actually returns today.
    /// `MTC_TEST_PLAYLIST_URL` overrides the URL. Requires yt-dlp on `PATH`
    /// and network access, hence `#[ignore]`.
    #[test]
    #[ignore]
    fn real_playlist_fetch_smoke_test() {
        let url = std::env::var("MTC_TEST_PLAYLIST_URL")
            .unwrap_or_else(|_| "https://music.youtube.com/playlist?list=UUuAXFkgsw1L7xaCfnd5JJOw".to_string());
        let exe = std::env::var("PATH")
            .ok()
            .and_then(|path_var| std::env::split_paths(&path_var).map(|d| d.join(YTDLP_EXE)).find(|p| p.exists()))
            .expect("yt-dlp not found on PATH — install it to run this test");

        let mut cmd = Command::new(&exe);
        cmd.args(["-J", "--flat-playlist", "--no-warnings", "--ignore-errors", "--playlist-end", "5", &url]);
        hide_console(&mut cmd);
        let output = cmd.output().expect("failed to run yt-dlp");
        assert!(output.status.success(), "yt-dlp failed: {}", String::from_utf8_lossy(&output.stderr));

        let raw = String::from_utf8_lossy(&output.stdout);
        let result = parse_playlist_json(&raw).expect("parse_playlist_json failed on real yt-dlp output");
        println!("Playlist: {} — {} entries", result.title, result.entries.len());
        for e in &result.entries {
            println!("  [{}] {} — uploader={:?} duration={:?}s", e.video_id, e.title, e.uploader, e.duration_secs);
        }
        assert!(!result.entries.is_empty(), "expected at least one entry from a real playlist");
        assert!(result.entries.iter().all(|e| !e.video_id.is_empty()));
    }
}
