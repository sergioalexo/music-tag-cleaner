//! Audio-content duplicate detection (v0.8 F1).
//!
//! Three stages, cheapest first:
//! 1. **Exact** — a blake3 hash of the file bytes catches literal copies.
//! 2. **Fingerprint** — a Chromaprint-compatible fingerprint (`rusty-chromaprint`,
//!    pure Rust, no external binary) computed from PCM decoded by `symphonia`.
//!    Both are cached in a small local sqlite database keyed by path + mtime +
//!    size, so re-scanning an unchanged library is nearly free.
//! 3. **Match** — `rusty-chromaprint::match_fingerprints` gives alignment-
//!    tolerant segments, which we use to tell a real duplicate from a radio
//!    edit vs. extended mix of the same track (see `classify_pair`).

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rusqlite::{params, Connection, OptionalExtension};
use rusty_chromaprint::{match_fingerprints, Configuration, Fingerprinter};
use serde::{Deserialize, Serialize};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use tauri::{AppHandle, Emitter, Manager};

/// A duplicate/alternate-version group returned to the frontend. Facts for
/// judging which to keep (bitrate, tags, etc.) are looked up on the frontend
/// via the existing `list_files`/`read_tags_batch` commands — this only
/// carries what the matching itself produced.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    pub id: String,
    /// "duplicate" (same recording, safe to consider deleting) or
    /// "alternate" (e.g. radio edit vs. extended mix — never auto-suggested
    /// for deletion).
    pub kind: String,
    pub paths: Vec<String>,
    /// 0 (exact byte-identical) explanation, or the best pairwise chromaprint
    /// score in the group (lower = more similar; see `classify_pair`).
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedFingerprint {
    blake3: String,
    fingerprint: Vec<u32>,
    duration_secs: f64,
    sample_rate: u32,
}

fn emit_progress(app: &AppHandle, done: usize, total: usize, phase: &str) {
    let _ = app.emit(
        "duplicate-scan-progress",
        serde_json::json!({ "done": done, "total": total, "phase": phase }),
    );
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("fingerprint-cache.sqlite"))
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(db_path(app)?).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS file_cache (
            path TEXT PRIMARY KEY,
            mtime INTEGER NOT NULL,
            size INTEGER NOT NULL,
            blake3_hash TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            duration_secs REAL NOT NULL,
            sample_rate INTEGER NOT NULL
        );",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn file_stat(path: &Path) -> Result<(i64, i64), String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    Ok((mtime, meta.len() as i64))
}

fn compute_blake3(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    Ok(blake3::hash(&bytes).to_hex().to_string())
}

/// Decodes up to ~2 minutes of audio (plenty for a fingerprint match, and
/// far cheaper than decoding a whole DJ mix) to interleaved i16 PCM.
fn decode_to_pcm(path: &str) -> Result<(Vec<i16>, u32, u32, f64), String> {
    const MAX_SAMPLES: usize = 44_100 * 2 * 120; // ~120s stereo @44.1kHz worst case

    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let mut format = symphonia::default::get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .map_err(|e| format!("unsupported audio format: {e}"))?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| "no audio track found".to_string())?;
    let track_id = track.id;
    let codec_params = track
        .codec_params
        .as_ref()
        .ok_or_else(|| "missing codec parameters".to_string())?
        .audio()
        .ok_or_else(|| "not an audio codec".to_string())?
        .clone();
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&codec_params, &AudioDecoderOptions::default())
        .map_err(|e| format!("unsupported codec: {e}"))?;

    let mut pcm: Vec<i16> = Vec::new();
    let mut sample_rate = 0u32;
    let mut channels = 0u32;
    let mut total_frames: u64 = 0;

    loop {
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(SymError::ResetRequired) => break,
            Err(_) => break,
        };
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(audio_buf) => {
                if sample_rate == 0 {
                    sample_rate = audio_buf.spec().rate();
                    channels = audio_buf.spec().channels().count() as u32;
                }
                total_frames += audio_buf.frames() as u64;
                let mut chunk: Vec<i16> = vec![0i16; audio_buf.samples_interleaved()];
                audio_buf.copy_to_slice_interleaved(&mut chunk);
                pcm.extend_from_slice(&chunk);
                if pcm.len() >= MAX_SAMPLES {
                    break;
                }
            }
            Err(SymError::DecodeError(_)) => continue,
            Err(_) => break,
        }
    }

    if sample_rate == 0 {
        return Err("could not decode any audio frames".to_string());
    }
    // Duration is measured from the actual audio decoded here (capped at
    // ~2 minutes), not the file's real length — fine for fingerprint
    // matching, but callers needing the true track length should use the
    // existing `file_info`/`list_files` duration instead.
    let duration_secs = total_frames as f64 / sample_rate as f64;
    Ok((pcm, sample_rate, channels.max(1), duration_secs))
}

fn compute_fingerprint(pcm: &[i16], sample_rate: u32, channels: u32) -> Result<Vec<u32>, String> {
    let config = Configuration::preset_test2();
    let mut printer = Fingerprinter::new(&config);
    printer
        .start(sample_rate, channels)
        .map_err(|e| format!("fingerprinter reset failed: {e:?}"))?;
    printer.consume(pcm);
    printer.finish();
    Ok(printer.fingerprint().to_vec())
}

fn get_or_compute(conn: &Connection, path: &str) -> Result<CachedFingerprint, String> {
    let (mtime, size) = file_stat(Path::new(path))?;

    let cached: Option<CachedFingerprint> = conn
        .query_row(
            "SELECT blake3_hash, fingerprint, duration_secs, sample_rate FROM file_cache
             WHERE path = ?1 AND mtime = ?2 AND size = ?3",
            params![path, mtime, size],
            |row| {
                let fp_str: String = row.get(1)?;
                Ok(CachedFingerprint {
                    blake3: row.get(0)?,
                    fingerprint: fp_str.split(',').filter_map(|s| s.parse().ok()).collect(),
                    duration_secs: row.get(2)?,
                    sample_rate: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(hit) = cached {
        return Ok(hit);
    }

    let blake3 = compute_blake3(Path::new(path))?;
    let (pcm, sample_rate, channels, duration_secs) = decode_to_pcm(path)?;
    let fingerprint = compute_fingerprint(&pcm, sample_rate, channels)?;
    let fp_str = fingerprint.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(",");

    conn.execute(
        "INSERT OR REPLACE INTO file_cache
            (path, mtime, size, blake3_hash, fingerprint, duration_secs, sample_rate)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![path, mtime, size, blake3, fp_str, duration_secs, sample_rate],
    )
    .map_err(|e| e.to_string())?;

    Ok(CachedFingerprint { blake3, fingerprint, duration_secs, sample_rate })
}

/// A same-recording duplicate needs high similarity *and* matching duration.
/// A lower score (rusty-chromaprint: 0-32, lower = more similar) with
/// coverage this close on *both* sides is a very strong signal — these
/// thresholds are a starting point, not a scientifically calibrated cutoff,
/// and may need tuning against real libraries.
const DUPLICATE_SCORE_MAX: f64 = 10.0;
const DUPLICATE_MIN_COVERAGE: f64 = 0.85;
/// A weaker/partial match still worth surfacing as a probable alternate
/// version (radio edit vs. extended mix, etc.) rather than discarding.
const ALTERNATE_SCORE_MAX: f64 = 14.0;
const ALTERNATE_MIN_COVERAGE: f64 = 0.35;

enum PairMatch {
    Duplicate { score: f64 },
    Alternate { score: f64 },
    NoMatch,
}

/// Compares two fingerprints and classifies the relationship. Reports
/// **coverage** (how much of each track's fingerprinted audio the best
/// matching segment spans) and **score** (chromaprint's own similarity
/// measure) separately, which is what lets a radio edit correctly match
/// *inside* an extended mix without the two being flagged as identical:
/// coverage on the shorter file is high, but coverage on the longer one is
/// only partial — an "alternate version", not a duplicate.
fn classify_pair(a: &CachedFingerprint, b: &CachedFingerprint, config: &Configuration) -> PairMatch {
    let Ok(segments) = match_fingerprints(&a.fingerprint, &b.fingerprint, config) else {
        return PairMatch::NoMatch;
    };
    let Some(best) = segments.iter().max_by(|x, y| x.items_count.cmp(&y.items_count)) else {
        return PairMatch::NoMatch;
    };
    let match_secs = best.duration(config) as f64;
    let coverage_a = if a.duration_secs > 0.0 { (match_secs / a.duration_secs).min(1.0) } else { 0.0 };
    let coverage_b = if b.duration_secs > 0.0 { (match_secs / b.duration_secs).min(1.0) } else { 0.0 };
    let min_coverage = coverage_a.min(coverage_b);
    let duration_diff = (a.duration_secs - b.duration_secs).abs();

    if best.score <= DUPLICATE_SCORE_MAX
        && min_coverage >= DUPLICATE_MIN_COVERAGE
        && duration_diff <= a.duration_secs.max(b.duration_secs) * 0.05 + 1.0
    {
        PairMatch::Duplicate { score: best.score }
    } else if best.score <= ALTERNATE_SCORE_MAX && min_coverage >= ALTERNATE_MIN_COVERAGE {
        PairMatch::Alternate { score: best.score }
    } else {
        PairMatch::NoMatch
    }
}

/// Union-find so transitively-related files (A matches B, B matches C) land
/// in one group instead of three overlapping pairs.
struct UnionFind {
    parent: Vec<usize>,
}
impl UnionFind {
    fn new(n: usize) -> Self {
        Self { parent: (0..n).collect() }
    }
    fn find(&mut self, x: usize) -> usize {
        if self.parent[x] != x {
            self.parent[x] = self.find(self.parent[x]);
        }
        self.parent[x]
    }
    fn union(&mut self, a: usize, b: usize) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            self.parent[ra] = rb;
        }
    }
}

fn scan_duplicates_blocking(app: &AppHandle, paths: Vec<String>) -> Result<Vec<DuplicateGroup>, String> {
    let conn = open_db(app)?;
    let total = paths.len();
    let mut fingerprints: Vec<(String, CachedFingerprint)> = Vec::with_capacity(total);
    for (i, path) in paths.iter().enumerate() {
        match get_or_compute(&conn, path) {
            Ok(fp) => fingerprints.push((path.clone(), fp)),
            Err(e) => eprintln!("duplicate scan: skipping {path}: {e}"),
        }
        emit_progress(app, i + 1, total, "fingerprinting");
    }

    // Stage 1: exact byte-identical files (blake3), grouped immediately —
    // no need to fingerprint-compare files we already know are identical.
    let mut exact_groups: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();
    for (i, (_, fp)) in fingerprints.iter().enumerate() {
        exact_groups.entry(fp.blake3.clone()).or_default().push(i);
    }
    let mut in_exact_group = vec![false; fingerprints.len()];
    let mut groups: Vec<DuplicateGroup> = Vec::new();
    for (hash, idxs) in &exact_groups {
        if idxs.len() > 1 {
            for &i in idxs {
                in_exact_group[i] = true;
            }
            groups.push(DuplicateGroup {
                id: format!("exact-{hash}"),
                kind: "duplicate".to_string(),
                paths: idxs.iter().map(|&i| fingerprints[i].0.clone()).collect(),
                score: 0.0,
            });
        }
    }

    // Stage 2/3: fingerprint comparison for everything not already an exact
    // duplicate. Bucketed by duration (a radio edit is never wildly shorter
    // than ~35% of its extended mix in practice) to keep this well short of
    // full O(n²) on a large library.
    let candidates: Vec<usize> = (0..fingerprints.len()).filter(|&i| !in_exact_group[i]).collect();
    let config = Configuration::preset_test2();
    let mut uf = UnionFind::new(candidates.len());
    let mut pair_kind: std::collections::HashMap<(usize, usize), (bool, f64)> = std::collections::HashMap::new();

    for (ci, &i) in candidates.iter().enumerate() {
        for (cj, &j) in candidates.iter().enumerate().skip(ci + 1) {
            let (_, fa) = &fingerprints[i];
            let (_, fb) = &fingerprints[j];
            let longer = fa.duration_secs.max(fb.duration_secs);
            let shorter = fa.duration_secs.min(fb.duration_secs);
            if longer <= 0.0 || shorter / longer < 0.30 {
                continue; // durations too far apart to plausibly be related
            }
            match classify_pair(fa, fb, &config) {
                PairMatch::Duplicate { score } => {
                    uf.union(ci, cj);
                    pair_kind.insert((ci, cj), (true, score));
                }
                PairMatch::Alternate { score } => {
                    uf.union(ci, cj);
                    pair_kind.entry((ci, cj)).or_insert((false, score));
                }
                PairMatch::NoMatch => {}
            }
        }
        emit_progress(app, i + 1, fingerprints.len(), "comparing");
    }

    let mut clusters: std::collections::HashMap<usize, Vec<usize>> = std::collections::HashMap::new();
    for ci in 0..candidates.len() {
        let root = uf.find(ci);
        clusters.entry(root).or_default().push(ci);
    }
    for (root, members) in clusters {
        if members.len() < 2 {
            continue;
        }
        // A cluster is a "duplicate" group only if every pair inside it that
        // was actually compared came back "duplicate" — one alternate-version
        // pair downgrades the whole cluster, so an extended mix + radio edit
        // + a real duplicate of the radio edit doesn't get mislabeled as all
        // being identical.
        let mut is_pure_duplicate = true;
        let mut best_score = f64::MAX;
        for a in 0..members.len() {
            for b in (a + 1)..members.len() {
                let key = if members[a] < members[b] {
                    (members[a], members[b])
                } else {
                    (members[b], members[a])
                };
                if let Some(&(dup, score)) = pair_kind.get(&key) {
                    if !dup {
                        is_pure_duplicate = false;
                    }
                    best_score = best_score.min(score);
                }
            }
        }
        groups.push(DuplicateGroup {
            id: format!("cluster-{root}"),
            kind: if is_pure_duplicate { "duplicate" } else { "alternate" }.to_string(),
            paths: members.iter().map(|&ci| fingerprints[candidates[ci]].0.clone()).collect(),
            score: if best_score == f64::MAX { 0.0 } else { best_score },
        });
    }

    Ok(groups)
}

#[tauri::command]
pub async fn scan_duplicates(app: AppHandle, paths: Vec<String>) -> Result<Vec<DuplicateGroup>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_duplicates_blocking(&app, paths))
        .await
        .map_err(|_| "duplicate scan task panicked".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine_pcm(freq: f64, sample_rate: u32, seconds: f64) -> Vec<i16> {
        let n = (sample_rate as f64 * seconds) as usize;
        (0..n)
            .map(|i| {
                let t = i as f64 / sample_rate as f64;
                ((t * freq * std::f64::consts::TAU).sin() * i16::MAX as f64 * 0.8) as i16
            })
            .collect()
    }

    /// Minimal 16-bit mono PCM WAV writer — just enough to exercise the real
    /// `decode_to_pcm` (symphonia probe + decode) path against an actual file
    /// on disk, since every other test here calls `compute_fingerprint`
    /// directly on in-memory PCM and never touches decoding at all.
    fn write_wav(path: &Path, pcm: &[i16], sample_rate: u32) {
        let mut data = Vec::with_capacity(pcm.len() * 2);
        for s in pcm {
            data.extend_from_slice(&s.to_le_bytes());
        }
        let byte_rate = sample_rate * 2;
        let mut buf = Vec::new();
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        buf.extend_from_slice(b"WAVEfmt ");
        buf.extend_from_slice(&16u32.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes()); // PCM
        buf.extend_from_slice(&1u16.to_le_bytes()); // mono
        buf.extend_from_slice(&sample_rate.to_le_bytes());
        buf.extend_from_slice(&byte_rate.to_le_bytes());
        buf.extend_from_slice(&2u16.to_le_bytes()); // block align
        buf.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&(data.len() as u32).to_le_bytes());
        buf.extend_from_slice(&data);
        std::fs::write(path, buf).unwrap();
    }

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mtc-dup-test-{name}-{:?}",
            std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn decode_to_pcm_reads_a_real_wav_file_from_disk() {
        let dir = scratch_dir("decode");
        let path = dir.join("tone.wav");
        let sr = 44_100;
        write_wav(&path, &sine_pcm(440.0, sr, 3.0), sr);

        let (pcm, rate, channels, duration) = decode_to_pcm(path.to_str().unwrap()).unwrap();
        assert_eq!(rate, sr);
        assert_eq!(channels, 1);
        assert!(!pcm.is_empty(), "decoded PCM should not be empty");
        assert!(
            (2.5..3.5).contains(&duration),
            "expected roughly a 3s file, got {duration}s"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn get_or_compute_caches_and_reuses_the_fingerprint() {
        let dir = scratch_dir("cache");
        let path = dir.join("tone.wav");
        let sr = 44_100;
        write_wav(&path, &sine_pcm(440.0, sr, 3.0), sr);
        let path_str = path.to_str().unwrap();

        let db_path = dir.join("cache.sqlite");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS file_cache (
                path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, size INTEGER NOT NULL,
                blake3_hash TEXT NOT NULL, fingerprint TEXT NOT NULL,
                duration_secs REAL NOT NULL, sample_rate INTEGER NOT NULL
            );",
        )
        .unwrap();

        let first = get_or_compute(&conn, path_str).unwrap();
        assert!(!first.fingerprint.is_empty());

        // Second call must hit the cache and return the identical fingerprint
        // without needing to touch symphonia again (mtime/size unchanged).
        let second = get_or_compute(&conn, path_str).unwrap();
        assert_eq!(first.fingerprint, second.fingerprint);
        assert_eq!(first.blake3, second.blake3);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A short melody (concatenated fixed-length notes) — Chromaprint works
    /// on tonal/chroma content, so a meaningful "these are different songs"
    /// fixture needs distinct pitch sequences over time. Plain white noise
    /// is a poor fixture here: it carries no chroma content, so two
    /// unrelated noise clips can score deceptively "similar" to a chroma-based
    /// algorithm in a way two different real songs would not.
    fn melody_pcm(note_freqs: &[f64], sample_rate: u32, seconds_per_note: f64) -> Vec<i16> {
        let mut out = Vec::new();
        for &freq in note_freqs {
            out.extend(sine_pcm(freq, sample_rate, seconds_per_note));
        }
        out
    }

    #[test]
    fn radio_edit_inside_extended_mix_classifies_as_alternate_not_duplicate() {
        let sr = 11025;
        // "Radio edit": one shared melody phrase.
        let shared_phrase = [261.63, 329.63, 392.00, 523.25, 440.0, 349.23];
        let radio_pcm = melody_pcm(&shared_phrase, sr, 4.0);
        // "Extended mix": an intro and outro (never in the radio edit) around the same shared phrase.
        let mut extended_notes = vec![220.0, 246.94, 261.63];
        extended_notes.extend_from_slice(&shared_phrase);
        extended_notes.extend_from_slice(&[196.00, 174.61, 164.81]);
        let extended_pcm = melody_pcm(&extended_notes, sr, 4.0);

        let fp_radio = compute_fingerprint(&radio_pcm, sr, 1).unwrap();
        let fp_extended = compute_fingerprint(&extended_pcm, sr, 1).unwrap();
        let radio = CachedFingerprint {
            blake3: "radio".into(),
            fingerprint: fp_radio,
            duration_secs: radio_pcm.len() as f64 / sr as f64,
            sample_rate: sr,
        };
        let extended = CachedFingerprint {
            blake3: "extended".into(),
            fingerprint: fp_extended,
            duration_secs: extended_pcm.len() as f64 / sr as f64,
            sample_rate: sr,
        };
        let config = Configuration::preset_test2();
        match classify_pair(&radio, &extended, &config) {
            PairMatch::Alternate { .. } => {}
            PairMatch::Duplicate { score } => {
                panic!("radio edit vs. extended mix should classify as Alternate, not Duplicate (score {score})")
            }
            PairMatch::NoMatch => panic!(
                "radio edit vs. extended mix should classify as Alternate, got NoMatch — the shared phrase wasn't matched"
            ),
        }
    }

    #[test]
    fn identical_audio_scores_as_a_strong_match() {
        let sr = 11025;
        let pcm_a = sine_pcm(440.0, sr, 20.0);
        let pcm_b = pcm_a.clone();
        let fp_a = compute_fingerprint(&pcm_a, sr, 1).unwrap();
        let fp_b = compute_fingerprint(&pcm_b, sr, 1).unwrap();
        let config = Configuration::preset_test2();
        let segments = match_fingerprints(&fp_a, &fp_b, &config).unwrap();
        let best = segments.iter().max_by(|a, b| a.items_count.cmp(&b.items_count));
        assert!(best.is_some(), "identical audio should produce at least one matching segment");
        assert!(
            best.unwrap().score <= DUPLICATE_SCORE_MAX,
            "identical audio should score within the duplicate threshold, got {}",
            best.unwrap().score
        );
    }

    #[test]
    fn different_melodies_do_not_match_as_duplicates() {
        let sr = 11025;
        // Two clearly different, unrelated note sequences.
        let pcm_a = melody_pcm(&[261.63, 329.63, 392.00, 523.25], sr, 5.0); // C E G C (C major arpeggio)
        let pcm_b = melody_pcm(&[233.08, 277.18, 311.13, 466.16], sr, 5.0); // A#/Bb-ish minor-flavored run
        let fp_a = compute_fingerprint(&pcm_a, sr, 1).unwrap();
        let fp_b = compute_fingerprint(&pcm_b, sr, 1).unwrap();
        let config = Configuration::preset_test2();
        let segments = match_fingerprints(&fp_a, &fp_b, &config).unwrap();
        let best_score = segments
            .iter()
            .max_by(|a, b| a.items_count.cmp(&b.items_count))
            .map(|s| s.score)
            .unwrap_or(f64::MAX);
        assert!(
            best_score > DUPLICATE_SCORE_MAX,
            "different melodies should not score as a duplicate, got {best_score}"
        );
    }
}
