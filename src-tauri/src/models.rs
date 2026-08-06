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
