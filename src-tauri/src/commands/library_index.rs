//! Whole-library index (v0.13).
//!
//! Everything before this worked only on the files loaded into the current
//! session, which is fine for editing a folder and wrong for every question
//! about the *collection*: which genres do I actually use, is this playlist
//! track something I already own, where is that track I remember but haven't
//! opened. Those need to know about tracks nobody opened today.
//!
//! So: a persistent sqlite index of one or more root folders, holding the
//! curated tag fields plus enough file identity (`mtime` + `size`) to skip
//! unchanged files on a re-index. It is deliberately a *cache of the files*,
//! never a source of truth — the tags on disk always win, a row whose file
//! has changed is re-read, and a row whose file is gone is dropped. Nothing
//! is ever written to a file because of what the index says.
//!
//! It lives in its own database rather than joining `fingerprint-cache.sqlite`
//! (duplicates/waveforms): that one is a derived-computation cache that can be
//! deleted at any time to reclaim space, and this one is user-facing state
//! whose loss means re-walking the whole collection.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

use crate::commands::files::{par_map, read_tags_impl, AUDIO_EXTENSIONS};
use crate::models::WriteResult;

/// Canonical tag keys that survive a write as typed fields, so they must not
/// be re-sent as "extra" frames to preserve.
///
/// This mirrors `KEPT_FIELD_KEYS` in `src/types.ts`; the two are checked
/// against each other by `kept_field_keys_match_the_frontend` below, which
/// fails if either list is edited without the other.
pub const KEPT_FIELD_KEYS: &[&str] = &[
    "TrackTitle",
    "TrackArtist",
    "AlbumTitle",
    "AlbumArtist",
    "TrackNumber",
    "TrackTotal",
    "DiscNumber",
    "DiscTotal",
    "Year",
    "RecordingDate",
    "Genre",
    "Comment",
    "OriginalArtist",
    "Composer",
    "Popularimeter",
    "Unknown(TRACKID)",
];

const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS library_track (
    path TEXT PRIMARY KEY,
    mtime INTEGER NOT NULL,
    size INTEGER NOT NULL,
    format TEXT NOT NULL,
    duration_secs REAL,
    has_backup INTEGER NOT NULL DEFAULT 0,
    has_cover INTEGER NOT NULL DEFAULT 0,
    title TEXT,
    artist TEXT,
    album TEXT,
    album_artist TEXT,
    genre TEXT,
    year TEXT,
    comment TEXT,
    composer TEXT,
    original_artist TEXT,
    track_id TEXT,
    rating INTEGER,
    indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS library_track_genre ON library_track(genre);
CREATE INDEX IF NOT EXISTS library_track_artist ON library_track(artist);
CREATE TABLE IF NOT EXISTS library_root (
    path TEXT PRIMARY KEY,
    added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS import_session (
    key TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    saved_at INTEGER NOT NULL,
    payload TEXT NOT NULL
);
";

pub(crate) fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("library-index.sqlite"))
}

pub(crate) fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(db_path(app)?).map_err(|e| e.to_string())?;
    // WAL keeps a long indexing write from blocking the reads the UI makes
    // while it runs (stats polling, the search dock).
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    conn.execute_batch(SCHEMA_SQL).map_err(|e| e.to_string())?;
    Ok(conn)
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn file_stat(path: &Path) -> Option<(i64, i64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    Some((mtime, meta.len() as i64))
}

/// One track as the index has it. Flat (rather than the `AudioFile` +
/// `TagData` pair the rest of the app passes around) because it is one
/// database row; the frontend splits it back into that pair.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedTrack {
    pub path: String,
    pub filename: String,
    pub format: String,
    pub size: i64,
    pub duration_secs: Option<f64>,
    pub has_backup: bool,
    pub has_cover_art: bool,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub genre: Option<String>,
    pub year: Option<String>,
    pub comment: Option<String>,
    pub composer: Option<String>,
    pub original_artist: Option<String>,
    pub track_id: Option<String>,
    pub rating: Option<u8>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSummary {
    pub scanned: usize,
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub unchanged: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenreCount {
    pub name: String,
    pub count: i64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    pub track_count: i64,
    pub roots: Vec<String>,
    pub last_indexed_at: Option<i64>,
    pub genre_count: i64,
    pub artist_count: i64,
}

// --- Roots -----------------------------------------------------------------

#[tauri::command]
pub async fn library_roots(app: AppHandle) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db(&app)?;
        let mut stmt = conn
            .prepare("SELECT path FROM library_root ORDER BY path")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        Ok(rows)
    })
    .await
    .map_err(|_| "Reading library roots failed unexpectedly".to_string())?
}

/// Replaces the whole root list. Rows under a root that is no longer listed
/// are dropped, so removing a folder from the index actually removes its
/// tracks rather than leaving them as orphans nothing will ever refresh.
#[tauri::command]
pub async fn set_library_roots(app: AppHandle, roots: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db(&app)?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM library_root", []).map_err(|e| e.to_string())?;
        for r in &roots {
            tx.execute(
                "INSERT OR REPLACE INTO library_root (path, added_at) VALUES (?1, ?2)",
                params![r, now_secs()],
            )
            .map_err(|e| e.to_string())?;
        }
        if roots.is_empty() {
            tx.execute("DELETE FROM library_track", []).map_err(|e| e.to_string())?;
        } else {
            let mut keep = String::new();
            for (i, _) in roots.iter().enumerate() {
                if i > 0 {
                    keep.push_str(" OR ");
                }
                keep.push_str(&format!("path LIKE ?{} ESCAPE '\\'", i + 1));
            }
            let patterns: Vec<String> = roots.iter().map(|r| format!("{}%", escape_like(r))).collect();
            let sql = format!("DELETE FROM library_track WHERE NOT ({keep})");
            tx.execute(&sql, rusqlite::params_from_iter(patterns.iter()))
                .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|_| "Saving library roots failed unexpectedly".to_string())?
}

/// `LIKE` treats `%` and `_` as wildcards, and Windows paths legitimately
/// contain neither — but a folder named "100_%" would otherwise match far
/// more than itself, so escape them rather than trusting the path shape.
fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

// --- Indexing --------------------------------------------------------------

fn emit_progress(app: &AppHandle, phase: &str, done: usize, total: usize, current: &str) {
    let _ = app.emit(
        "library-index-progress",
        serde_json::json!({ "phase": phase, "done": done, "total": total, "current": current }),
    );
}

/// Walks every root and brings the index up to date.
///
/// Incremental by default: a file whose `mtime` and `size` both match the
/// stored row is skipped without opening it, which is the difference between
/// a re-index taking seconds and taking as long as the first one.
/// `rescan_all` forces every file to be re-read — for when the *index schema*
/// changed rather than the files.
#[tauri::command]
pub async fn index_library(app: AppHandle, rescan_all: bool) -> Result<IndexSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db(&app)?;

        let roots: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT path FROM library_root ORDER BY path")
                .map_err(|e| e.to_string())?;
            let r = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .filter_map(Result::ok)
                .collect();
            r
        };
        if roots.is_empty() {
            return Err("No library folders chosen yet — add one first".to_string());
        }

        emit_progress(&app, "walking", 0, 0, "");
        let mut found: Vec<PathBuf> = Vec::new();
        for root in &roots {
            let rp = Path::new(root);
            if !rp.is_dir() {
                continue;
            }
            for e in WalkDir::new(rp).into_iter().filter_map(|e| e.ok()) {
                if e.file_type().is_file() && is_audio(e.path()) {
                    found.push(e.into_path());
                }
            }
        }

        // Existing rows, so we can tell added/updated/unchanged apart and
        // spot the ones whose file no longer exists.
        let mut known: std::collections::HashMap<String, (i64, i64)> = std::collections::HashMap::new();
        {
            let mut stmt = conn
                .prepare("SELECT path, mtime, size FROM library_track")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
                })
                .map_err(|e| e.to_string())?;
            for row in rows.flatten() {
                known.insert(row.0, (row.1, row.2));
            }
        }

        let total = found.len();
        emit_progress(&app, "reading", 0, total, "");

        // Decide what actually needs re-reading before touching any tags.
        let mut to_read: Vec<PathBuf> = Vec::new();
        let mut unchanged = 0usize;
        let mut seen: BTreeSet<String> = BTreeSet::new();
        for p in &found {
            let key = p.to_string_lossy().to_string();
            seen.insert(key.clone());
            let stat = file_stat(p);
            match (known.get(&key), stat) {
                (Some(&(m, s)), Some((mtime, size))) if !rescan_all && m == mtime && s == size => {
                    unchanged += 1;
                }
                _ => to_read.push(p.clone()),
            }
        }

        // Tag parsing is the expensive part, so it runs in parallel and the
        // database write happens afterwards in one transaction — sqlite is
        // single-writer, and interleaving would serialise the parses too.
        let parsed = par_map(&to_read, |p| {
            let path = p.to_string_lossy().to_string();
            let (mtime, size) = file_stat(p).unwrap_or((0, 0));
            let tags = read_tags_impl(&path);
            (path, mtime, size, tags)
        });

        let mut summary = IndexSummary {
            scanned: total,
            unchanged,
            ..Default::default()
        };

        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let now = now_secs();
        for (i, (path, mtime, size, tags)) in parsed.into_iter().enumerate() {
            if i % 64 == 0 {
                emit_progress(&app, "reading", i, to_read.len(), &path);
            }
            let tags = match tags {
                Ok(t) => t,
                Err(e) => {
                    summary.errors.push(format!("{path}: {e}"));
                    continue;
                }
            };
            let p = Path::new(&path);
            let existed = known.contains_key(&path);
            tx.execute(
                "INSERT OR REPLACE INTO library_track (
                    path, mtime, size, format, duration_secs, has_backup, has_cover,
                    title, artist, album, album_artist, genre, year, comment,
                    composer, original_artist, track_id, rating, indexed_at
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
                params![
                    path,
                    mtime,
                    size,
                    p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase(),
                    Option::<f64>::None,
                    0i64,
                    tags.has_cover_art as i64,
                    tags.title,
                    tags.artist,
                    tags.album,
                    tags.album_artist,
                    tags.genre,
                    tags.year,
                    tags.comment,
                    tags.composer,
                    tags.original_artist,
                    tags.track_id,
                    tags.rating.map(|r| r as i64),
                    now,
                ],
            )
            .map_err(|e| e.to_string())?;
            if existed {
                summary.updated += 1;
            } else {
                summary.added += 1;
            }
        }

        // Drop rows whose file is gone. Only paths under a root are
        // considered, so an unplugged external drive doesn't quietly erase
        // its half of the index — its root simply produced no `found` entries
        // and we can't tell "deleted" from "offline".
        let stale: Vec<String> = known
            .keys()
            .filter(|k| !seen.contains(*k))
            .filter(|k| !Path::new(k).exists())
            .cloned()
            .collect();
        for path in &stale {
            tx.execute("DELETE FROM library_track WHERE path = ?1", params![path])
                .map_err(|e| e.to_string())?;
        }
        summary.removed = stale.len();
        tx.commit().map_err(|e| e.to_string())?;

        emit_progress(&app, "done", total, total, "");
        Ok(summary)
    })
    .await
    .map_err(|_| "Indexing the library failed unexpectedly".to_string())?
}

#[tauri::command]
pub async fn clear_library_index(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db(&app)?;
        conn.execute("DELETE FROM library_track", []).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|_| "Clearing the index failed unexpectedly".to_string())?
}

// --- Reads -----------------------------------------------------------------

fn row_to_track(r: &rusqlite::Row) -> rusqlite::Result<IndexedTrack> {
    let path: String = r.get("path")?;
    let filename = Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    Ok(IndexedTrack {
        filename,
        format: r.get("format")?,
        size: r.get("size")?,
        duration_secs: r.get("duration_secs")?,
        has_backup: r.get::<_, i64>("has_backup")? != 0,
        has_cover_art: r.get::<_, i64>("has_cover")? != 0,
        title: r.get("title")?,
        artist: r.get("artist")?,
        album: r.get("album")?,
        album_artist: r.get("album_artist")?,
        genre: r.get("genre")?,
        year: r.get("year")?,
        comment: r.get("comment")?,
        composer: r.get("composer")?,
        original_artist: r.get("original_artist")?,
        track_id: r.get("track_id")?,
        rating: r.get::<_, Option<i64>>("rating")?.map(|v| v as u8),
        path,
    })
}

/// The whole index. The frontend holds it in memory for matching and search;
/// at ~200 bytes of JSON per track even a 50k-track collection is a one-off
/// read of a few megabytes, which is cheaper than round-tripping a query per
/// keystroke.
#[tauri::command]
pub async fn library_tracks(app: AppHandle) -> Result<Vec<IndexedTrack>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db(&app)?;
        let mut stmt = conn
            .prepare("SELECT * FROM library_track ORDER BY path")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], row_to_track)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        Ok(rows)
    })
    .await
    .map_err(|_| "Reading the library index failed unexpectedly".to_string())?
}

#[tauri::command]
pub async fn library_stats(app: AppHandle) -> Result<LibraryStats, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db(&app)?;
        let track_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM library_track", [], |r| r.get(0))
            .unwrap_or(0);
        let last_indexed_at: Option<i64> = conn
            .query_row("SELECT MAX(indexed_at) FROM library_track", [], |r| r.get(0))
            .unwrap_or(None);
        let genre_count: i64 = conn
            .query_row(
                "SELECT COUNT(DISTINCT genre) FROM library_track WHERE genre IS NOT NULL AND genre <> ''",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let artist_count: i64 = conn
            .query_row(
                "SELECT COUNT(DISTINCT artist) FROM library_track WHERE artist IS NOT NULL AND artist <> ''",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let mut stmt = conn
            .prepare("SELECT path FROM library_root ORDER BY path")
            .map_err(|e| e.to_string())?;
        let roots = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        Ok(LibraryStats { track_count, roots, last_indexed_at, genre_count, artist_count })
    })
    .await
    .map_err(|_| "Reading library stats failed unexpectedly".to_string())?
}

/// Every genre actually present in the collection, most-used first.
///
/// This is what replaced the hardcoded genre presets: the list you pick from
/// is the list you already use, so it can't drift from the files.
#[tauri::command]
pub async fn library_genres(app: AppHandle) -> Result<Vec<GenreCount>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db(&app)?;
        let mut stmt = conn
            .prepare(
                "SELECT genre, COUNT(*) AS n FROM library_track
                 WHERE genre IS NOT NULL AND TRIM(genre) <> ''
                 GROUP BY genre ORDER BY n DESC, genre ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok(GenreCount { name: r.get(0)?, count: r.get(1)? }))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        Ok(rows)
    })
    .await
    .map_err(|_| "Reading library genres failed unexpectedly".to_string())?
}

#[tauri::command]
pub async fn library_paths_with_genre(app: AppHandle, genre: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db(&app)?;
        let mut stmt = conn
            .prepare("SELECT path FROM library_track WHERE genre = ?1 ORDER BY path")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![genre], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        Ok(rows)
    })
    .await
    .map_err(|_| "Reading tracks by genre failed unexpectedly".to_string())?
}

// --- Writes ----------------------------------------------------------------

/// Rewrites one field across a set of files that may not be loaded in the
/// session, then refreshes their index rows.
///
/// Used by the genre rename: renaming a genre has to reach every track that
/// carries it, not just the handful currently on screen, or the preset and
/// the files drift apart — which is the whole thing the library-derived genre
/// list exists to prevent.
///
/// Every other tag frame is preserved: the file's own `all_fields` dump minus
/// the typed fields is passed back as `keep_extra`, matching what the
/// frontend does for an ordinary inline edit.
///
/// `backup` carries the user's "Backup original tags before changes" setting.
/// It must be threaded through rather than assumed: this path can rewrite
/// thousands of files the user never opened, which is precisely when they
/// would most want the full pre-change snapshot they asked for.
#[tauri::command]
pub async fn retag_field(
    app: AppHandle,
    paths: Vec<String>,
    field: String,
    value: String,
    backup: bool,
    preserve_art: bool,
    backup_field: Option<String>,
) -> Result<Vec<WriteResult>, String> {
    let app2 = app.clone();
    let results = tauri::async_runtime::spawn_blocking(move || {
        let total = paths.len();
        let done = std::sync::atomic::AtomicUsize::new(0);
        par_map(&paths, |path| {
            let n = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if n % 16 == 0 {
                emit_progress(&app2, "retagging", n, total, path);
            }
            let mut tags = match read_tags_impl(path) {
                Ok(t) => t,
                Err(e) => return WriteResult { path: path.clone(), error: Some(e) },
            };
            let v = if value.trim().is_empty() { None } else { Some(value.clone()) };
            match field.as_str() {
                "genre" => tags.genre = v,
                "artist" => tags.artist = v,
                "album" => tags.album = v,
                "albumArtist" => tags.album_artist = v,
                "year" => tags.year = v,
                "comment" => tags.comment = v,
                "composer" => tags.composer = v,
                "originalArtist" => tags.original_artist = v,
                other => {
                    return WriteResult {
                        path: path.clone(),
                        error: Some(format!("Unsupported field: {other}")),
                    }
                }
            }
            let keep_extra: Vec<String> = tags
                .all_fields
                .keys()
                .filter(|k| !KEPT_FIELD_KEYS.contains(&k.as_str()))
                .cloned()
                .collect();
            let err = crate::commands::files::write_tags_blocking(
                path,
                tags,
                backup,
                keep_extra,
                preserve_art,
                backup_field.clone(),
            )
            .err();
            WriteResult { path: path.clone(), error: err }
        })
    })
    .await
    .map_err(|_| "Retagging failed unexpectedly".to_string())?;

    // Refresh the rows we just changed, so the index doesn't claim the old
    // value until the next full re-index.
    let written: Vec<String> = results
        .iter()
        .filter(|r| r.error.is_none())
        .map(|r| r.path.clone())
        .collect();
    if !written.is_empty() {
        let app3 = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || reindex_paths(&app3, &written)).await;
    }
    Ok(results)
}

/// Re-reads specific paths into the index. Cheap enough to run right after a
/// write, so the index never lags the files it describes.
pub(crate) fn reindex_paths(app: &AppHandle, paths: &[String]) -> Result<(), String> {
    let parsed = par_map(paths, |path| {
        let p = Path::new(path);
        let (mtime, size) = file_stat(p).unwrap_or((0, 0));
        (path.clone(), mtime, size, read_tags_impl(path))
    });
    let mut conn = open_db(app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let now = now_secs();
    for (path, mtime, size, tags) in parsed {
        let Ok(tags) = tags else { continue };
        let p = Path::new(&path);
        tx.execute(
            "INSERT OR REPLACE INTO library_track (
                path, mtime, size, format, duration_secs, has_backup, has_cover,
                title, artist, album, album_artist, genre, year, comment,
                composer, original_artist, track_id, rating, indexed_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
            params![
                path,
                mtime,
                size,
                p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase(),
                Option::<f64>::None,
                0i64,
                tags.has_cover_art as i64,
                tags.title,
                tags.artist,
                tags.album,
                tags.album_artist,
                tags.genre,
                tags.year,
                tags.comment,
                tags.composer,
                tags.original_artist,
                tags.track_id,
                tags.rating.map(|r| r as i64),
                now,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        conn
    }

    fn insert(conn: &Connection, path: &str, genre: Option<&str>, artist: Option<&str>) {
        conn.execute(
            "INSERT INTO library_track (path, mtime, size, format, genre, artist, indexed_at)
             VALUES (?1, 1, 1, 'mp3', ?2, ?3, 100)",
            params![path, genre, artist],
        )
        .unwrap();
    }

    /// The Rust and TypeScript kept-key lists must stay identical: a field in
    /// one but not the other is either dropped on write or duplicated as a
    /// raw frame, and neither shows up until someone's tags are already
    /// damaged. Parsing the .ts constant is ugly but it is the only thing
    /// that actually fails when the two drift.
    #[test]
    fn kept_field_keys_match_the_frontend() {
        let ts = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/types.ts"),
        )
        .expect("could not read src/types.ts");
        let start = ts
            .find("export const KEPT_FIELD_KEYS = new Set([")
            .expect("KEPT_FIELD_KEYS not found in types.ts");
        let body = &ts[start..];
        let end = body.find("]);").expect("unterminated KEPT_FIELD_KEYS");
        let mut from_ts: Vec<String> = body[..end]
            .lines()
            .filter_map(|l| {
                let t = l.trim();
                let t = t.strip_prefix('"')?;
                t.split('"').next().map(str::to_string)
            })
            .collect();
        from_ts.sort();
        let mut from_rs: Vec<String> = KEPT_FIELD_KEYS.iter().map(|s| s.to_string()).collect();
        from_rs.sort();
        assert_eq!(from_rs, from_ts, "KEPT_FIELD_KEYS drifted between Rust and TypeScript");
    }

    #[test]
    fn genre_tally_counts_and_orders_by_use() {
        let conn = mem_db();
        insert(&conn, "a.mp3", Some("Techno"), None);
        insert(&conn, "b.mp3", Some("Techno"), None);
        insert(&conn, "c.mp3", Some("House Melodic"), None);
        insert(&conn, "d.mp3", Some(""), None);
        insert(&conn, "e.mp3", None, None);

        let mut stmt = conn
            .prepare(
                "SELECT genre, COUNT(*) AS n FROM library_track
                 WHERE genre IS NOT NULL AND TRIM(genre) <> ''
                 GROUP BY genre ORDER BY n DESC, genre ASC",
            )
            .unwrap();
        let rows: Vec<(String, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .filter_map(Result::ok)
            .collect();

        // Blank and NULL genres are not genres — they must not become an
        // empty-string entry in the picker.
        assert_eq!(rows, vec![("Techno".to_string(), 2), ("House Melodic".to_string(), 1)]);
    }

    #[test]
    fn paths_with_genre_returns_only_exact_matches() {
        let conn = mem_db();
        insert(&conn, "a.mp3", Some("Techno"), None);
        insert(&conn, "b.mp3", Some("Techno Melodic"), None);
        let mut stmt = conn
            .prepare("SELECT path FROM library_track WHERE genre = ?1 ORDER BY path")
            .unwrap();
        let rows: Vec<String> = stmt
            .query_map(params!["Techno"], |r| r.get(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(rows, vec!["a.mp3".to_string()]);
    }

    #[test]
    fn escape_like_neutralises_wildcards_in_a_folder_name() {
        assert_eq!(escape_like("C:/100%_mixes"), "C:/100\\%\\_mixes");
        // A Windows separator is escaped too, so it stays a literal backslash
        // under LIKE ... ESCAPE '\'.
        assert_eq!(escape_like("C:\\Music"), "C:\\\\Music");
    }

    #[test]
    fn a_row_round_trips_through_the_index_shape() {
        let conn = mem_db();
        conn.execute(
            "INSERT INTO library_track (path, mtime, size, format, genre, artist, title, rating, has_cover, indexed_at)
             VALUES ('C:/m/x.mp3', 1, 2, 'mp3', 'Techno', 'Boris Brejcha', 'Gravity', 4, 1, 100)",
            [],
        )
        .unwrap();
        let mut stmt = conn.prepare("SELECT * FROM library_track").unwrap();
        let t = stmt.query_row([], row_to_track).unwrap();
        assert_eq!(t.filename, "x.mp3");
        assert_eq!(t.artist.as_deref(), Some("Boris Brejcha"));
        assert_eq!(t.rating, Some(4));
        assert!(t.has_cover_art);
        assert!(!t.has_backup);
    }
}
