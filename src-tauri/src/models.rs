use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFile {
    pub path: String,
    pub filename: String,
    pub format: String,
    pub size: u64,
    pub has_backup: bool,
    /// Playback length in seconds, when readable from the file's audio properties.
    pub duration_secs: Option<f64>,
    /// Audio bitrate in kbps, when readable — used by duplicate review to
    /// judge which of two matching files is the better-quality copy.
    pub bitrate_kbps: Option<u32>,
    pub sample_rate_hz: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagData {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub track_number: Option<String>,
    pub disc_number: Option<String>,
    pub year: Option<String>,
    pub genre: Option<String>,
    pub comment: Option<String>,
    pub composer: Option<String>,
    pub original_artist: Option<String>,
    /// App-assigned unique id (from "Generate IDs"), stored in a private
    /// `TXXX:TRACKID` frame so it never collides with Track Number.
    pub track_id: Option<String>,
    /// Rating in stars, 0-5 (mapped from the POPM/rating byte).
    pub rating: Option<u8>,
    pub has_cover_art: bool,
    /// Full dump of every text field in the tag, keyed by a canonical
    /// (format-independent) name like `TrackTitle` or `Unknown(FOO)`.
    pub all_fields: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagReadResult {
    pub path: String,
    pub tags: Option<TagData>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub mime: String,
    pub size_bytes: u64,
    pub width: u32,
    pub height: u32,
}

/// Result of recompressing one file's cover art. `None` from the command means
/// nothing was done (no art, or it already meets the target).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtworkChange {
    /// `data:<mime>;base64,…` of the picture before and after — carried into
    /// the undo/redo history exactly like a manual artwork swap.
    pub before_data_url: String,
    pub after_data_url: String,
    pub before_bytes: u64,
    pub after_bytes: u64,
    pub before_width: u32,
    pub before_height: u32,
    pub after_width: u32,
    pub after_height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsage {
    pub model: String,
    pub prompt_eval_count: u64,
    pub eval_count: u64,
    pub tracks: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OllamaStatus {
    pub running: bool,
    pub models: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TrackInput {
    pub index: u32,
    pub filename: String,
    pub artist: String,
    pub title: String,
    pub year: String,
    pub genre: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CleanedTrack {
    pub index: u32,
    pub artist: Option<String>,
    pub title: Option<String>,
    pub year: Option<String>,
    pub genre: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GenreInput {
    pub index: u32,
    pub artist: String,
    pub title: String,
    pub genre: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GenreResult {
    pub index: u32,
    pub genre: Option<String>,
}

/// One file's table thumbnail, as returned by `read_cover_thumbnails`.
/// `data_url` is `None` both for "no embedded art" and for an unreadable
/// file — the table draws the same placeholder either way, and a per-file
/// error here would only produce a toast storm on a large library.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverThumbnail {
    pub path: String,
    pub data_url: Option<String>,
}

/// One file's artwork metadata, as returned by `image_info_batch`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfoResult {
    pub path: String,
    pub info: Option<ImageInfo>,
}

/// One file's worth of work for `write_tags_batch`. The flags that are the
/// same for every file in a run (backup, art preservation, backup field) are
/// passed once on the command itself rather than repeated per item.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteTagsItem {
    pub path: String,
    pub tags: TagData,
    /// Canonical key names of non-common fields to carry over untouched.
    pub keep_extra: Vec<String>,
}

/// One file's worth of work for `write_raw_fields_batch`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteRawFieldItem {
    pub path: String,
    pub field_key: String,
    pub value: String,
}

/// Outcome of one file in a batch write. `error` is `None` on success.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub path: String,
    pub error: Option<String>,
}

/// Progress payload for the `write-progress` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteProgress {
    pub done: usize,
    pub total: usize,
}
