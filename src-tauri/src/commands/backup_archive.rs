//! Simple backup archive (v0.9 F6): a store-only (uncompressed) ZIP of the
//! selected files, deliberately minimal — no scheduling, no incremental
//! logic, no cloud. The user names/locates it via the save dialog on the
//! frontend and moves it somewhere safe themselves.

use std::fs::File;
use std::io::{Read, Write};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use zip::write::{SimpleFileOptions, ZipWriter};
use zip::CompressionMethod;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestEntry {
    /// The original absolute path, so the archive can be verified or
    /// restored to the same layout later.
    path: String,
    /// Path as stored inside the zip (see `zip_entry_name`).
    archive_path: String,
    size: u64,
    blake3: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    created_at: String,
    track_count: usize,
    total_bytes: u64,
    files: Vec<ManifestEntry>,
}

/// Turns an absolute path into a zip-safe relative entry name that preserves
/// the original folder structure (so two files with the same filename from
/// different folders never collide) without leading drive letters or `:`,
/// which most zip tools reject or mishandle. `C:\Users\x\Music\a.mp3`
/// becomes `C/Users/x/Music/a.mp3`.
fn zip_entry_name(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let normalized = normalized.strip_prefix('/').unwrap_or(&normalized);
    match normalized.split_once(":/") {
        Some((drive, rest)) => format!("{drive}/{rest}"),
        None => normalized.to_string(),
    }
}

/// A plain ISO-ish local timestamp with no date/time crate dependency —
/// good enough for a manifest field nobody parses programmatically.
fn humantime_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("unix:{secs}")
}

/// The actual archive-building logic, independent of Tauri — takes a plain
/// progress callback instead of an `AppHandle` so it's directly testable.
fn create_backup_archive_core(
    paths: &[String],
    dest_path: &str,
    mut on_progress: impl FnMut(usize, usize),
) -> Result<(), String> {
    let file = File::create(dest_path).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

    let total = paths.len();
    let mut entries = Vec::with_capacity(total);
    let mut total_bytes: u64 = 0;

    for (i, path) in paths.iter().enumerate() {
        let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
        let hash = blake3::hash(&bytes).to_hex().to_string();
        let archive_path = zip_entry_name(path);

        zip.start_file(&archive_path, options).map_err(|e| e.to_string())?;
        zip.write_all(&bytes).map_err(|e| e.to_string())?;

        total_bytes += bytes.len() as u64;
        entries.push(ManifestEntry {
            path: path.clone(),
            archive_path,
            size: bytes.len() as u64,
            blake3: hash,
        });
        on_progress(i + 1, total);
    }

    let manifest = Manifest {
        created_at: humantime_now(),
        track_count: entries.len(),
        total_bytes,
        files: entries,
    };
    let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    zip.start_file("manifest.json", options).map_err(|e| e.to_string())?;
    zip.write_all(manifest_json.as_bytes()).map_err(|e| e.to_string())?;

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

fn emit_progress(app: &AppHandle, done: usize, total: usize) {
    let _ = app.emit("backup-archive-progress", serde_json::json!({ "done": done, "total": total }));
}

#[tauri::command]
pub async fn create_backup_archive(app: AppHandle, paths: Vec<String>, dest_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_backup_archive_core(&paths, &dest_path, |done, total| emit_progress(&app, done, total))
    })
    .await
    .map_err(|_| "backup archive task panicked".to_string())?
}

/// Reads back a backup archive's manifest.json without extracting anything
/// else — used to let a user verify what an old backup contains.
#[tauri::command]
pub async fn read_backup_manifest(zip_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = File::open(&zip_path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        let mut manifest_entry = archive.by_name("manifest.json").map_err(|e| e.to_string())?;
        let mut contents = String::new();
        manifest_entry.read_to_string(&mut contents).map_err(|e| e.to_string())?;
        Ok(contents)
    })
    .await
    .map_err(|_| "reading the backup manifest panicked".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mtc-backup-test-{name}-{:?}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn zip_entry_name_strips_drive_letter_and_uses_forward_slashes() {
        assert_eq!(
            zip_entry_name(r"C:\Users\sopas\Music\Collection\song.mp3"),
            "C/Users/sopas/Music/Collection/song.mp3"
        );
    }

    #[test]
    fn zip_entry_name_handles_already_forward_slash_paths() {
        assert_eq!(zip_entry_name("/home/user/song.mp3"), "home/user/song.mp3");
    }

    #[test]
    fn round_trip_produces_a_readable_archive_and_manifest() {
        let dir = scratch_dir("roundtrip");
        let src_a = dir.join("a.mp3");
        let src_b = dir.join("b.mp3");
        std::fs::write(&src_a, b"hello world").unwrap();
        std::fs::write(&src_b, b"a different file, longer content").unwrap();

        let zip_path = dir.join("backup.zip");
        let mut progress_calls = Vec::new();
        create_backup_archive_core(
            &[src_a.to_str().unwrap().to_string(), src_b.to_str().unwrap().to_string()],
            zip_path.to_str().unwrap(),
            |done, total| progress_calls.push((done, total)),
        )
        .unwrap();

        assert_eq!(progress_calls, vec![(1, 2), (2, 2)]);
        assert!(zip_path.exists());

        // Read the archive back and verify: both files present, stored
        // (not compressed), byte-identical, plus a valid manifest.
        let file = File::open(&zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        assert_eq!(archive.len(), 3); // a.mp3, b.mp3, manifest.json

        let mut a_entry = archive
            .by_name(&zip_entry_name(src_a.to_str().unwrap()))
            .expect("a.mp3 should be in the archive");
        assert_eq!(a_entry.compression(), CompressionMethod::Stored);
        let mut a_contents = Vec::new();
        a_entry.read_to_end(&mut a_contents).unwrap();
        assert_eq!(a_contents, b"hello world");
        drop(a_entry);

        let mut manifest_entry = archive.by_name("manifest.json").unwrap();
        let mut manifest_str = String::new();
        manifest_entry.read_to_string(&mut manifest_str).unwrap();
        let manifest: serde_json::Value = serde_json::from_str(&manifest_str).unwrap();
        assert_eq!(manifest["trackCount"], 2);
        assert_eq!(manifest["files"].as_array().unwrap().len(), 2);

        std::fs::remove_dir_all(&dir).ok();
    }
}
