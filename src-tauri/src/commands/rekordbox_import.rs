//! Rekordbox cue import (v0.9 F5): reads memory cues, hot cues, loops and
//! the beat grid from a `rekordbox.xml` collection export. Read-only — this
//! never writes anything back to Rekordbox.
//!
//! Cues are stored keyed by **audio fingerprint, not file path** (reusing
//! the exact same Chromaprint pipeline and sqlite database `duplicates.rs`
//! already built for duplicate detection), so a cue survives a rename or a
//! move — the whole reason the roadmap called for this instead of the
//! simpler path-keyed approach.

use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::duplicates::{get_or_compute, open_db};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoPoint {
    pub position_secs: f64,
    pub bpm: f64,
    pub meter: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CuePoint {
    pub position_secs: f64,
    /// `None` for a memory cue; `Some(pad)` (0-7) for a hot cue.
    pub pad: Option<i32>,
    pub name: String,
    pub color: Option<(u8, u8, u8)>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopPoint {
    pub start_secs: f64,
    pub end_secs: f64,
    pub pad: Option<i32>,
    pub name: String,
    pub color: Option<(u8, u8, u8)>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CueData {
    pub average_bpm: Option<f64>,
    pub tempo: Vec<TempoPoint>,
    pub memory_cues: Vec<CuePoint>,
    pub hot_cues: Vec<CuePoint>,
    pub loops: Vec<LoopPoint>,
}

#[derive(Debug, Clone, Default)]
struct ParsedTrack {
    location: String,
    average_bpm: Option<f64>,
    cues: CueData,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub total_entries: usize,
    pub matched: usize,
    pub not_found_on_disk: usize,
    pub errors: Vec<String>,
}

/// Decodes `%XX` percent-escapes (the only encoding rekordbox.xml's
/// `file://` URIs use) without pulling in a full URL-parsing crate for it.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `file://localhost/C:/Users/x/Music/song.flac` -> `C:\Users\x\Music\song.flac`.
fn location_to_path(location: &str) -> String {
    let stripped = location
        .strip_prefix("file://localhost/")
        .or_else(|| location.strip_prefix("file:///"))
        .or_else(|| location.strip_prefix("file://"))
        .unwrap_or(location);
    percent_decode(stripped).replace('/', "\\")
}

// `unescape_value()`'s replacement (`normalized_value`) takes an XML version
// parameter this codebase has no reason to track for a private XML-reading
// helper; the deprecated method is unremoved and behaves identically here.
#[allow(deprecated)]
fn attr_str(e: &quick_xml::events::BytesStart, name: &str) -> Option<String> {
    e.attributes()
        .flatten()
        .find(|a| a.key.as_ref() == name)
        .and_then(|a| a.unescape_value().ok().map(|v| v.into_owned()))
}

fn attr_f64(e: &quick_xml::events::BytesStart, name: &str) -> Option<f64> {
    attr_str(e, name).and_then(|v| v.parse().ok())
}

fn attr_i32(e: &quick_xml::events::BytesStart, name: &str) -> Option<i32> {
    attr_str(e, name).and_then(|v| v.parse().ok())
}

/// Parses a rekordbox.xml collection export into one entry per `<TRACK>`.
/// Ignores `<PLAYLISTS>` entirely — out of scope for cue import.
fn parse_rekordbox_xml(xml_path: &str) -> Result<Vec<ParsedTrack>, String> {
    let mut reader = Reader::from_file(xml_path).map_err(|e| e.to_string())?;
    reader.config_mut().trim_text(true);

    let mut tracks = Vec::new();
    let mut current: Option<ParsedTrack> = None;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Eof) => break,
            Ok(Event::Start(e)) if e.name().as_ref() == "TRACK" => {
                let location = attr_str(&e, "Location").map(|l| location_to_path(&l)).unwrap_or_default();
                current = Some(ParsedTrack {
                    location,
                    average_bpm: attr_f64(&e, "AverageBpm"),
                    cues: CueData::default(),
                });
            }
            Ok(Event::End(e)) if e.name().as_ref() == "TRACK" => {
                if let Some(track) = current.take() {
                    tracks.push(track);
                }
            }
            Ok(Event::Empty(e)) if e.name().as_ref() == "TEMPO" => {
                if let Some(track) = current.as_mut() {
                    track.cues.tempo.push(TempoPoint {
                        position_secs: attr_f64(&e, "Inizio").unwrap_or(0.0),
                        bpm: attr_f64(&e, "Bpm").unwrap_or(0.0),
                        meter: attr_str(&e, "Metro").unwrap_or_default(),
                    });
                }
            }
            Ok(Event::Empty(e)) if e.name().as_ref() == "POSITION_MARK" => {
                if let Some(track) = current.as_mut() {
                    let start = attr_f64(&e, "Start").unwrap_or(0.0);
                    let end = attr_f64(&e, "End");
                    let num = attr_i32(&e, "Num");
                    let name = attr_str(&e, "Name").unwrap_or_default();
                    let color = match (attr_i32(&e, "Red"), attr_i32(&e, "Green"), attr_i32(&e, "Blue")) {
                        (Some(r), Some(g), Some(b)) => Some((r as u8, g as u8, b as u8)),
                        _ => None,
                    };
                    // Type="4" is a saved loop (has both Start and End); everything
                    // else observed in real exports (Type="0", the common case, and
                    // the rare Type="1") is a plain position — memory cue when
                    // Num is -1/absent, hot cue pad otherwise.
                    if let Some(end) = end {
                        track.cues.loops.push(LoopPoint {
                            start_secs: start,
                            end_secs: end,
                            pad: num.filter(|&n| n >= 0),
                            name,
                            color,
                        });
                    } else {
                        let cue = CuePoint { position_secs: start, pad: num.filter(|&n| n >= 0), name, color };
                        if cue.pad.is_some() {
                            track.cues.hot_cues.push(cue);
                        } else {
                            track.cues.memory_cues.push(cue);
                        }
                    }
                }
            }
            Ok(_) => {}
            Err(e) => return Err(format!("XML parse error: {e}")),
        }
        buf.clear();
    }

    Ok(tracks)
}

const CUES_SCHEMA_SQL: &str = "CREATE TABLE IF NOT EXISTS cues (
    fingerprint_key TEXT PRIMARY KEY,
    source_path TEXT NOT NULL,
    data TEXT NOT NULL,
    imported_at INTEGER NOT NULL
);";

/// The stable, path-independent lookup key: a hash of the audio fingerprint
/// itself (not the byte-exact blake3 used for exact-duplicate detection,
/// which would change on every tag edit since tags are embedded in the same
/// file — the fingerprint is decoded-audio-only and untouched by that).
fn fingerprint_key(fingerprint: &[u32]) -> String {
    let joined = fingerprint.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(",");
    blake3::hash(joined.as_bytes()).to_hex().to_string()
}

fn emit_progress(app: &AppHandle, done: usize, total: usize) {
    let _ = app.emit("rekordbox-import-progress", serde_json::json!({ "done": done, "total": total }));
}

fn import_rekordbox_cues_blocking(app: &AppHandle, xml_path: &str) -> Result<ImportResult, String> {
    let tracks = parse_rekordbox_xml(xml_path)?;
    let conn = open_db(app)?;
    conn.execute_batch(CUES_SCHEMA_SQL).map_err(|e| e.to_string())?;

    let total = tracks.len();
    let mut matched = 0;
    let mut not_found = 0;
    let mut errors = Vec::new();

    for (i, track) in tracks.iter().enumerate() {
        if !Path::new(&track.location).is_file() {
            not_found += 1;
            emit_progress(app, i + 1, total);
            continue;
        }
        match get_or_compute(&conn, &track.location) {
            Ok(fp) => {
                let key = fingerprint_key(&fp.fingerprint);
                let mut data = track.cues.clone();
                data.average_bpm = track.average_bpm;
                let data_json = serde_json::to_string(&data).map_err(|e| e.to_string())?;
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                conn.execute(
                    "INSERT INTO cues (fingerprint_key, source_path, data, imported_at)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(fingerprint_key) DO UPDATE SET
                        source_path = excluded.source_path, data = excluded.data, imported_at = excluded.imported_at",
                    params![key, track.location, data_json, now],
                )
                .map_err(|e| e.to_string())?;
                matched += 1;
            }
            Err(e) => errors.push(format!("{}: {e}", track.location)),
        }
        emit_progress(app, i + 1, total);
    }

    Ok(ImportResult { total_entries: total, matched, not_found_on_disk: not_found, errors })
}

#[tauri::command]
pub async fn import_rekordbox_cues(app: AppHandle, xml_path: String) -> Result<ImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || import_rekordbox_cues_blocking(&app, &xml_path))
        .await
        .map_err(|_| "rekordbox import task panicked".to_string())?
}

fn get_cues_for_path_blocking(app: &AppHandle, path: &str) -> Result<Option<CueData>, String> {
    let conn = open_db(app)?;
    conn.execute_batch(CUES_SCHEMA_SQL).map_err(|e| e.to_string())?;
    let fp = get_or_compute(&conn, path)?;
    let key = fingerprint_key(&fp.fingerprint);
    let data_json: Option<String> = conn
        .query_row("SELECT data FROM cues WHERE fingerprint_key = ?1", params![key], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    match data_json {
        Some(json) => serde_json::from_str(&json).map(Some).map_err(|e| e.to_string()),
        None => Ok(None),
    }
}

/// Looks up previously-imported cues for `path` by computing (or reusing
/// the cached) fingerprint and matching on that, not the path itself — so
/// this still finds cues imported under a different filename/location for
/// the same audio.
#[tauri::command]
pub async fn get_cues_for_path(app: AppHandle, path: String) -> Result<Option<CueData>, String> {
    tauri::async_runtime::spawn_blocking(move || get_cues_for_path_blocking(&app, &path))
        .await
        .map_err(|_| "cue lookup task panicked".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Manual, opt-in smoke test against a real rekordbox.xml — parsing
    /// only, no fingerprinting/sqlite (which need an AppHandle). Confirms
    /// the parser survives a real, full-size export (not just the excerpt
    /// the other test is built from) and reports how many tracks actually
    /// resolve to a file on disk. Run explicitly with:
    ///   MTC_TEST_REKORDBOX_XML="C:\path\to\rekordbox.xml" cargo test --release parse_real_rekordbox_xml -- --ignored --nocapture
    #[test]
    #[ignore]
    fn parse_real_rekordbox_xml() {
        let xml_path = std::env::var("MTC_TEST_REKORDBOX_XML")
            .expect("set MTC_TEST_REKORDBOX_XML to a real rekordbox.xml export");
        let tracks = parse_rekordbox_xml(&xml_path).expect("parsing should succeed");
        println!("Parsed {} track entries", tracks.len());

        let mut found_on_disk = 0;
        let mut with_memory_cues = 0;
        let mut with_hot_cues = 0;
        let mut with_loops = 0;
        let mut with_tempo = 0;
        for t in &tracks {
            if Path::new(&t.location).is_file() {
                found_on_disk += 1;
            } else {
                println!("  not found on disk: {}", t.location);
            }
            if !t.cues.memory_cues.is_empty() {
                with_memory_cues += 1;
            }
            if !t.cues.hot_cues.is_empty() {
                with_hot_cues += 1;
            }
            if !t.cues.loops.is_empty() {
                with_loops += 1;
            }
            if !t.cues.tempo.is_empty() {
                with_tempo += 1;
            }
        }
        println!(
            "found_on_disk={found_on_disk}/{} with_memory_cues={with_memory_cues} \
             with_hot_cues={with_hot_cues} with_loops={with_loops} with_tempo={with_tempo}",
            tracks.len()
        );
        assert!(!tracks.is_empty(), "a real export should have at least one track");
    }

    #[test]
    fn location_to_path_decodes_percent_escapes_and_strips_file_uri() {
        assert_eq!(
            location_to_path("file://localhost/C:/Users/x/Music/A-Trak,%20Ferreck%20Dawn.flac"),
            r"C:\Users\x\Music\A-Trak, Ferreck Dawn.flac"
        );
    }

    #[test]
    fn location_to_path_decodes_multibyte_utf8_percent_escapes() {
        // "é" as it appears in a real rekordbox.xml export (Dajaé).
        assert_eq!(location_to_path("file://localhost/Daja%c3%a9.flac"), "Dajaé.flac");
    }

    #[test]
    fn parses_a_real_rekordbox_xml_track_with_cues_hot_cues_and_a_loop() {
        // A trimmed excerpt matching the real schema this was built against
        // (a genuine rekordbox 7.2.18 collection export), not a guess.
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.2.18" Company="AlphaTheta"/>
  <COLLECTION Entries="1">
    <TRACK TrackID="1" Name="Coming Home" Artist="A-Trak" AverageBpm="123.00"
           Location="file://localhost/C:/Users/sopas/Music/Collection/song.flac">
      <TEMPO Inizio="0.054" Bpm="123.00" Metro="4/4" Battito="1"/>
      <POSITION_MARK Name="AutoGrid" Type="0" Start="0.048" Num="-1"/>
      <POSITION_MARK Name="n.n." Type="0" Start="62.487" Num="0" Red="48" Green="90" Blue="255"/>
      <POSITION_MARK Name="n.n." Type="4" Start="281.024" End="296.634" Num="3" Red="224" Green="100" Blue="27"/>
    </TRACK>
  </COLLECTION>
</DJ_PLAYLISTS>"#;
        let dir = std::env::temp_dir().join(format!(
            "mtc-rb-test-{:?}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let xml_path = dir.join("rekordbox.xml");
        std::fs::write(&xml_path, xml).unwrap();

        let tracks = parse_rekordbox_xml(xml_path.to_str().unwrap()).unwrap();
        assert_eq!(tracks.len(), 1);
        let t = &tracks[0];
        assert_eq!(t.location, r"C:\Users\sopas\Music\Collection\song.flac");
        assert_eq!(t.average_bpm, Some(123.0));
        assert_eq!(t.cues.tempo.len(), 1);
        assert_eq!(t.cues.tempo[0].bpm, 123.0);
        assert_eq!(t.cues.memory_cues.len(), 1, "the Num=-1 AutoGrid marker is a memory cue");
        assert_eq!(t.cues.hot_cues.len(), 1, "the Num=0 marker is hot cue pad 0");
        assert_eq!(t.cues.hot_cues[0].pad, Some(0));
        assert_eq!(t.cues.hot_cues[0].color, Some((48, 90, 255)));
        assert_eq!(t.cues.loops.len(), 1, "Type=4 with a Start/End pair is a saved loop");
        assert_eq!(t.cues.loops[0].start_secs, 281.024);
        assert_eq!(t.cues.loops[0].end_secs, 296.634);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cues_survive_a_sql_round_trip_and_a_path_change_under_the_same_fingerprint() {
        let dir = std::env::temp_dir().join(format!(
            "mtc-rb-sql-test-{:?}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = rusqlite::Connection::open(dir.join("cache.sqlite")).unwrap();
        conn.execute_batch(CUES_SCHEMA_SQL).unwrap();

        // A fake fingerprint stands in for a real decoded one — this test is
        // only exercising the SQL/JSON layer, not audio decoding (that's
        // covered by duplicates.rs's own tests, which this module reuses).
        let fingerprint = vec![1u32, 2, 3, 4, 5];
        let key = fingerprint_key(&fingerprint);

        let data = CueData {
            average_bpm: Some(128.0),
            tempo: vec![TempoPoint { position_secs: 0.05, bpm: 128.0, meter: "4/4".into() }],
            memory_cues: vec![CuePoint { position_secs: 10.0, pad: None, name: "".into(), color: None }],
            hot_cues: vec![CuePoint {
                position_secs: 20.0,
                pad: Some(0),
                name: "n.n.".into(),
                color: Some((48, 90, 255)),
            }],
            loops: vec![],
        };
        let data_json = serde_json::to_string(&data).unwrap();
        conn.execute(
            "INSERT INTO cues (fingerprint_key, source_path, data, imported_at) VALUES (?1, ?2, ?3, ?4)",
            params![key, "C:\\old\\path.mp3", data_json, 0i64],
        )
        .unwrap();

        // Look up by fingerprint, as if the file had since been renamed —
        // the whole point of keying on audio content instead of path.
        let found_json: String = conn
            .query_row("SELECT data FROM cues WHERE fingerprint_key = ?1", params![key], |row| row.get(0))
            .unwrap();
        let found: CueData = serde_json::from_str(&found_json).unwrap();
        assert_eq!(found.average_bpm, Some(128.0));
        assert_eq!(found.hot_cues.len(), 1);
        assert_eq!(found.hot_cues[0].pad, Some(0));
        assert_eq!(found.hot_cues[0].color, Some((48, 90, 255)));
        assert_eq!(found.memory_cues.len(), 1);

        // A different fingerprint must not match.
        let other_key = fingerprint_key(&[9u32, 9, 9]);
        let miss: Option<String> = conn
            .query_row("SELECT data FROM cues WHERE fingerprint_key = ?1", params![other_key], |row| row.get(0))
            .optional()
            .unwrap();
        assert!(miss.is_none());

        std::fs::remove_dir_all(&dir).ok();
    }
}
