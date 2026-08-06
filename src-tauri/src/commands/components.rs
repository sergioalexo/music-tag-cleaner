use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaInfo {
    pub running: bool,
    pub server_version: Option<String>,
    pub installed: bool,
    pub install_path: Option<String>,
}

#[cfg(target_os = "windows")]
const OLLAMA_EXE: &str = "ollama.exe";
#[cfg(not(target_os = "windows"))]
const OLLAMA_EXE: &str = "ollama";

fn find_ollama_exe() -> Option<PathBuf> {
    // Default per-user install location on Windows.
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let p = PathBuf::from(&local)
            .join("Programs")
            .join("Ollama")
            .join(OLLAMA_EXE);
        if p.exists() {
            return Some(p);
        }
    }
    // Anywhere on PATH.
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let p = dir.join(OLLAMA_EXE);
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

fn emit_progress(app: &AppHandle, component: &str, phase: &str, downloaded: u64, total: u64) {
    let _ = app.emit(
        "component-progress",
        json!({
            "component": component,
            "phase": phase,
            "downloaded": downloaded,
            "total": total,
        }),
    );
}

#[tauri::command]
pub async fn ollama_info(url: String) -> OllamaInfo {
    let mut running = false;
    let mut server_version = None;
    if let Ok(client) = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(5))
        .build()
    {
        if let Ok(resp) = client
            .get(format!("{}/api/version", url.trim_end_matches('/')))
            .send()
            .await
        {
            if resp.status().is_success() {
                running = true;
                if let Ok(v) = resp.json::<Value>().await {
                    server_version = v["version"].as_str().map(String::from);
                }
            }
        }
    }
    let exe = find_ollama_exe();
    OllamaInfo {
        running,
        server_version,
        // A reachable server counts as installed even if the binary is
        // somewhere we don't know about (custom install, remote URL).
        installed: exe.is_some() || running,
        install_path: exe.map(|p| p.to_string_lossy().to_string()),
    }
}

/// Downloads the official Windows installer (with progress events) and
/// launches it. The user completes the wizard; the UI polls afterwards.
#[tauri::command]
pub async fn install_ollama(app: AppHandle) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err(
            "Automatic install is only supported on Windows — download from https://ollama.com/download".into(),
        );
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client
        .get("https://ollama.com/download/OllamaSetup.exe")
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let dest = std::env::temp_dir().join("OllamaSetup.exe");
    let mut file = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    let mut last_emitted: u64 = 0;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("Download failed: {e}"))? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        if downloaded - last_emitted >= 512 * 1024 {
            last_emitted = downloaded;
            emit_progress(&app, "ollama", "downloading", downloaded, total);
        }
    }
    drop(file);
    emit_progress(&app, "ollama", "launching", downloaded, total.max(downloaded));
    std::process::Command::new(&dest)
        .spawn()
        .map_err(|e| format!("Could not launch the installer: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn start_ollama() -> Result<(), String> {
    let exe = find_ollama_exe().ok_or_else(|| "Ollama is not installed".to_string())?;
    // Prefer the desktop app (tray icon + server + autostart); fall back
    // to a headless `ollama serve`.
    let desktop = exe.parent().map(|d| d.join("ollama app.exe"));
    match desktop.filter(|p| p.exists()) {
        Some(app_exe) => spawn_detached(&app_exe, &[]),
        None => spawn_detached(&exe, &["serve"]),
    }
}

#[cfg(target_os = "windows")]
fn spawn_detached(exe: &Path, args: &[&str]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new(exe)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn spawn_detached(exe: &Path, args: &[&str]) -> Result<(), String> {
    std::process::Command::new(exe)
        .args(args)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Pulls a model through Ollama's streaming API, forwarding layer download
/// progress as `component-progress` events.
#[tauri::command]
pub async fn pull_model(app: AppHandle, url: String, model: String) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        // No overall timeout: large models take a long time to pull.
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client
        .post(format!("{}/api/pull", url.trim_end_matches('/')))
        .json(&json!({ "model": model, "stream": true }))
        .send()
        .await
        .map_err(|e| format!("Could not reach Ollama: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Ollama returned HTTP {}", resp.status()));
    }

    let mut buf = String::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buf.find('\n') {
            let line: String = buf.drain(..=pos).collect();
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if let Some(err) = v["error"].as_str() {
                return Err(err.to_string());
            }
            emit_progress(
                &app,
                "model",
                v["status"].as_str().unwrap_or("pulling"),
                v["completed"].as_u64().unwrap_or(0),
                v["total"].as_u64().unwrap_or(0),
            );
        }
    }
    Ok(())
}

/// Removes a locally installed model through Ollama's delete API.
#[tauri::command]
pub async fn delete_model(url: String, model: String) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .delete(format!("{}/api/delete", url.trim_end_matches('/')))
        .json(&json!({ "model": model }))
        .send()
        .await
        .map_err(|e| format!("Could not reach Ollama: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Ollama returned HTTP {}", resp.status()));
    }
    Ok(())
}
