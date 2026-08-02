use std::path::Path;
use std::time::Duration;

use lofty::config::WriteOptions;
// Imported unnamed so `save_to_path` is in scope without clashing with our
// own `AudioFile` model struct.
use lofty::file::AudioFile as _;
use lofty::prelude::*;
use lofty::tag::{ItemKey, ItemValue, Tag, TagItem, TagType};
use walkdir::WalkDir;

use crate::commands::backup::{find_backup_in_file, make_backup_string, BACKUP_KEY};
use crate::models::{AudioFile, TagData, TagReadResult};

pub const AUDIO_EXTENSIONS: &[&str] = &["mp3", "flac", "ogg", "aac", "m4a", "wav", "aiff", "aif"];

const FILE_OP_TIMEOUT: Duration = Duration::from_secs(20);

/// Runs blocking file I/O off the async runtime with a timeout, so a single
/// locked file (open in another app) or a cloud-storage placeholder that
/// hasn't downloaded yet fails fast with a clear message instead of hanging
/// the command forever — which otherwise leaves every toolbar button
/// disabled with no explanation, since they all share one busy flag.
pub(crate) async fn run_blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    match tokio::time::timeout(FILE_OP_TIMEOUT, tauri::async_runtime::spawn_blocking(f)).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("The file operation task panicked unexpectedly".to_string()),
        Err(_) => Err(format!(
            "Timed out after {}s — the file may be locked by another program (a DJ app, antivirus) or not fully downloaded from cloud storage",
            FILE_OP_TIMEOUT.as_secs()
        )),
    }
}

/// Canonical, format-independent name for a tag key. Used for the
/// `allFields` dump and to match the frontend's kept-field list.
pub fn key_name(key: &ItemKey) -> String {
    match key {
        ItemKey::Unknown(s) => format!("Unknown({s})"),
        other => format!("{other:?}"),
    }
}

fn text_of(value: &ItemValue) -> Option<String> {
    match value {
        ItemValue::Text(s) | ItemValue::Locator(s) => Some(s.clone()),
        ItemValue::Binary(_) => None,
    }
}

fn get_text(tag: &Tag, key: &ItemKey) -> Option<String> {
    tag.get(key)
        .and_then(|item| text_of(item.value()))
        .filter(|s| !s.is_empty())
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn file_info(path: &Path) -> AudioFile {
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let has_backup = lofty::read_from_path(path)
        .ok()
        .map(|t| find_backup_in_file(&t).is_some())
        .unwrap_or(false);
    AudioFile {
        path: path.to_string_lossy().to_string(),
        filename: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        format: path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default(),
        size,
        has_backup,
    }
}

#[tauri::command]
pub async fn scan_folder(path: String, recursive: bool) -> Result<Vec<AudioFile>, String> {
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err(format!("Not a folder: {path}"));
    }
    let max_depth = if recursive { usize::MAX } else { 1 };
    let mut files: Vec<AudioFile> = WalkDir::new(root)
        .max_depth(max_depth)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && is_audio(e.path()))
        .map(|e| file_info(e.path()))
        .collect();
    files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(files)
}

#[tauri::command]
pub async fn list_files(paths: Vec<String>) -> Vec<AudioFile> {
    paths.iter().map(|p| file_info(Path::new(p))).collect()
}

/// Imports a mix of files and folders (as produced by a drag-and-drop),
/// recursing into any folders. Non-audio paths are ignored.
#[tauri::command]
pub async fn import_paths(paths: Vec<String>, recursive: bool) -> Vec<AudioFile> {
    let max_depth = if recursive { usize::MAX } else { 1 };
    let mut out: Vec<AudioFile> = Vec::new();
    for p in paths {
        let path = Path::new(&p);
        if path.is_dir() {
            out.extend(
                WalkDir::new(path)
                    .max_depth(max_depth)
                    .into_iter()
                    .filter_map(|e| e.ok())
                    .filter(|e| e.file_type().is_file() && is_audio(e.path()))
                    .map(|e| file_info(e.path())),
            );
        } else if path.is_file() && is_audio(path) {
            out.push(file_info(path));
        }
    }
    out
}

pub fn read_tags_impl(path: &str) -> Result<TagData, String> {
    let tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    let mut data = TagData::default();
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return Ok(data);
    };

    data.title = tag.title().map(|c| c.to_string());
    data.artist = tag.artist().map(|c| c.to_string());
    data.album = tag.album().map(|c| c.to_string());
    data.album_artist = get_text(tag, &ItemKey::AlbumArtist);
    data.track_number = join_total(
        get_text(tag, &ItemKey::TrackNumber),
        get_text(tag, &ItemKey::TrackTotal),
    );
    data.disc_number = join_total(
        get_text(tag, &ItemKey::DiscNumber),
        get_text(tag, &ItemKey::DiscTotal),
    );
    data.year = get_text(tag, &ItemKey::RecordingDate)
        .or_else(|| get_text(tag, &ItemKey::Year))
        .or_else(|| tag.year().map(|y| y.to_string()));
    data.genre = tag.genre().map(|c| c.to_string());
    data.comment = tag.comment().map(|c| c.to_string());
    data.composer = get_text(tag, &ItemKey::Composer);
    data.original_artist = get_text(tag, &ItemKey::OriginalArtist);
    data.rating = read_rating(tag);
    data.has_cover_art = !tag.pictures().is_empty();

    let backup_name = format!("Unknown({BACKUP_KEY})");
    for item in tag.items() {
        let name = key_name(item.key());
        // The backup blob is surfaced via AudioFile.hasBackup, not the field dump.
        if name == backup_name {
            continue;
        }
        if let Some(text) = text_of(item.value()) {
            data.all_fields
                .entry(name)
                .and_modify(|v| {
                    v.push_str(" | ");
                    v.push_str(&text);
                })
                .or_insert(text);
        }
    }
    Ok(data)
}

fn join_total(num: Option<String>, total: Option<String>) -> Option<String> {
    match (num, total) {
        (Some(n), Some(t)) if !n.contains('/') => Some(format!("{n}/{t}")),
        (n, _) => n,
    }
}

/// A POPM rating byte (0-255) to 0-5 stars, using the Rekordbox 51/star scale.
fn stars_from_popm_byte(n: u32) -> u8 {
    let stars = if n == 0 {
        0
    } else if n <= 5 {
        n
    } else {
        ((n as f32) / 51.0).round() as u32
    };
    stars.min(5) as u8
}

/// Parses a POPM frame body ("email\0<rating><counter>") to stars.
fn popm_to_stars(bytes: &[u8]) -> u8 {
    match bytes.iter().position(|&b| b == 0) {
        Some(pos) => bytes
            .get(pos + 1)
            .map(|&r| stars_from_popm_byte(r as u32))
            .unwrap_or(0),
        None => 0,
    }
}

/// Reads a rating (0-5 stars) from a POPM binary frame (ID3) or a numeric
/// RATING text comment (Vorbis/MP4, 0-100 scale). Returns None if unrated.
fn read_rating(tag: &Tag) -> Option<u8> {
    if let Some(item) = tag.get(&ItemKey::Popularimeter) {
        let stars = match item.value() {
            ItemValue::Binary(bytes) => popm_to_stars(bytes),
            ItemValue::Text(s) => s
                .trim()
                .parse::<u32>()
                .ok()
                .map(stars_from_popm_byte)
                .unwrap_or(0),
            _ => 0,
        };
        return (stars > 0).then_some(stars);
    }
    let rating_key = ItemKey::from_key(tag.tag_type(), "RATING");
    if let Some(s) = get_text(tag, &rating_key) {
        if let Ok(n) = s.trim().parse::<u32>() {
            let stars = if n <= 5 {
                n
            } else {
                ((n as f32) / 20.0).round() as u32
            };
            return (stars > 0).then_some(stars.min(5) as u8);
        }
    }
    None
}

/// Writes a 0-5 star rating: a POPM binary frame for ID3v2, or a numeric
/// RATING comment (0-100) for other formats. Clears the rating when 0.
fn write_rating(tag: &mut Tag, tag_type: TagType, stars: u8) {
    tag.remove_key(&ItemKey::Popularimeter);
    let rating_key = ItemKey::from_key(tag_type, "RATING");
    tag.remove_key(&rating_key);
    if stars == 0 {
        return;
    }
    if tag_type == TagType::Id3v2 {
        let byte = (stars.min(5) as u16 * 51) as u8;
        // POPM body: empty email + null terminator + rating byte + 4-byte counter.
        let bytes = vec![0u8, byte, 0, 0, 0, 0];
        tag.insert(TagItem::new(ItemKey::Popularimeter, ItemValue::Binary(bytes)));
    } else {
        let val = (stars.min(5) as u16 * 20).to_string();
        tag.insert(TagItem::new(rating_key, ItemValue::Text(val)));
    }
}

/// Resolves the human-readable "searchable backup" target field.
fn backup_item_key(field: &str) -> ItemKey {
    match field {
        "OriginalArtist" => ItemKey::OriginalArtist,
        "Comment" => ItemKey::Comment,
        _ => ItemKey::Composer,
    }
}

/// Builds the searchable backup string "filename | | artist | | title | | year".
/// All four slots are always present (empty when unknown) so the layout is
/// stable and the filename slot is filled even for untagged files.
fn build_searchable_backup(
    path: &str,
    artist: Option<String>,
    title: Option<String>,
    year: Option<String>,
) -> String {
    let stem = Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().trim().to_string())
        .unwrap_or_default();
    let a = artist.map(|s| s.trim().to_string()).unwrap_or_default();
    let t = title.map(|s| s.trim().to_string()).unwrap_or_default();
    let y = year
        .map(|s| s.trim().chars().take(4).collect::<String>())
        .unwrap_or_default();
    [stem, a, t, y].join(" | | ")
}

#[tauri::command]
pub async fn read_tags(path: String) -> Result<TagData, String> {
    read_tags_impl(&path)
}

#[tauri::command]
pub async fn read_tags_batch(paths: Vec<String>) -> Vec<TagReadResult> {
    paths
        .into_iter()
        .map(|p| match read_tags_impl(&p) {
            Ok(tags) => TagReadResult {
                path: p,
                tags: Some(tags),
                error: None,
            },
            Err(e) => TagReadResult {
                path: p,
                tags: None,
                error: Some(e),
            },
        })
        .collect()
}

/// Writes the common fields in `tags`, dropping everything else.
/// `keep_extra` lists canonical key names (see `key_name`) of non-common
/// fields to carry over from the existing tag — used both to honor
/// unchecked removals in the strip preview and to preserve everything
/// when stripping is disabled. The backup (if requested) is captured from
/// the file's current state before anything is overwritten; an existing
/// backup is never replaced.
///
/// `backup_field` (when Some) writes "file name - artist - title - year"
/// (from the pre-change values) into a chosen field — Composer by default,
/// or OriginalArtist / Comment — so the original identity stays searchable
/// in DJ software. A non-empty target is never overwritten, so the oldest
/// snapshot (or any real data already there) wins.
#[tauri::command]
pub async fn write_tags(
    path: String,
    tags: TagData,
    backup: bool,
    keep_extra: Vec<String>,
    preserve_art: bool,
    backup_field: Option<String>,
) -> Result<(), String> {
    let tagged = lofty::read_from_path(&path).map_err(|e| e.to_string())?;
    // Prefer the format's canonical tag so fields aren't lost to a limited
    // secondary tag (e.g. ID3v1) that happened to be present.
    let tag_type = tagged
        .primary_tag()
        .map(|t| t.tag_type())
        .unwrap_or_else(|| tagged.file_type().primary_tag_type());
    let old_tag = tagged.primary_tag().or_else(|| tagged.first_tag()).cloned();

    let mut new_tag = Tag::new(tag_type);
    set_text(&mut new_tag, ItemKey::TrackTitle, &tags.title);
    set_text(&mut new_tag, ItemKey::TrackArtist, &tags.artist);
    set_text(&mut new_tag, ItemKey::AlbumTitle, &tags.album);
    set_text(&mut new_tag, ItemKey::AlbumArtist, &tags.album_artist);
    set_text(&mut new_tag, ItemKey::RecordingDate, &tags.year);
    set_text(&mut new_tag, ItemKey::Genre, &tags.genre);
    set_text(&mut new_tag, ItemKey::Comment, &tags.comment);
    set_numbered(
        &mut new_tag,
        ItemKey::TrackNumber,
        ItemKey::TrackTotal,
        &tags.track_number,
    );
    set_numbered(
        &mut new_tag,
        ItemKey::DiscNumber,
        ItemKey::DiscTotal,
        &tags.disc_number,
    );
    set_text(&mut new_tag, ItemKey::Composer, &tags.composer);
    set_text(&mut new_tag, ItemKey::OriginalArtist, &tags.original_artist);
    if let Some(stars) = tags.rating {
        write_rating(&mut new_tag, tag_type, stars);
    }

    // Searchable backup: written into the chosen field only when it (and any
    // existing data there) is empty, so the original snapshot is never lost.
    if let Some(field) = backup_field.as_deref() {
        let key = backup_item_key(field);
        let old_val = old_tag.as_ref().and_then(|t| get_text(t, &key));
        if let Some(v) = old_val {
            new_tag.insert_text(key, v); // preserve whatever is already there
        } else if new_tag.get(&key).is_none() {
            let (artist, title, year) = match old_tag.as_ref() {
                Some(old) => (
                    old.artist().map(|c| c.to_string()),
                    old.title().map(|c| c.to_string()),
                    get_text(old, &ItemKey::RecordingDate)
                        .or_else(|| get_text(old, &ItemKey::Year))
                        .or_else(|| old.year().map(|y| y.to_string())),
                ),
                None => (None, None, None),
            };
            // Always write — the filename slot alone is a valid backup.
            new_tag.insert_text(key, build_searchable_backup(&path, artist, title, year));
        }
    }

    if let Some(ref old) = old_tag {
        if !keep_extra.is_empty() {
            for item in old.items() {
                if keep_extra.iter().any(|k| *k == key_name(item.key())) {
                    new_tag.push(item.clone());
                }
            }
        }
        if preserve_art {
            for pic in old.pictures() {
                new_tag.push_picture(pic.clone());
            }
        }
    }

    if backup {
        let backup_str = find_backup_in_file(&tagged)
            .unwrap_or_else(|| make_backup_string(old_tag.as_ref(), tag_type));
        new_tag.insert(TagItem::new(
            ItemKey::Unknown(BACKUP_KEY.to_string()),
            ItemValue::Text(backup_str),
        ));
    }

    // Drop secondary tag formats (ID3v1, APE, ...) so stripped fields
    // cannot linger in them.
    let other_types: Vec<TagType> = tagged
        .tags()
        .iter()
        .map(|t| t.tag_type())
        .filter(|t| *t != tag_type)
        .collect();
    drop(tagged);
    for tt in other_types {
        Tag::new(tt)
            .remove_from_path(&path)
            .map_err(|e| e.to_string())?;
    }
    new_tag
        .save_to_path(&path, WriteOptions::default())
        .map_err(|e| e.to_string())
}

/// Explicit backup of a single file. Always (re)writes the searchable
/// backup field in the canonical "filename | | artist | | title | | year"
/// format from the file's current values, and writes the full JSON snapshot
/// if one isn't already present (the JSON snapshot is never overwritten, so
/// the earliest full state is always recoverable). All other tags are kept.
#[tauri::command]
pub async fn backup_file(path: String, backup_field: String) -> Result<(), String> {
    run_blocking(move || backup_file_blocking(&path, &backup_field)).await
}

fn backup_file_blocking(path: &str, backup_field: &str) -> Result<(), String> {
    let mut tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    // Write into the format's canonical tag (e.g. ID3v2 for MP3), never a
    // limited secondary tag like ID3v1 that can't hold Composer.
    let tag_type = tagged
        .primary_tag()
        .map(|t| t.tag_type())
        .unwrap_or_else(|| tagged.file_type().primary_tag_type());

    // Read current values and decide on the JSON snapshot (immutable borrow).
    let (artist, title, year, json_backup) = {
        let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
        let (a, t, y) = match tag {
            Some(t) => (
                t.artist().map(|c| c.to_string()),
                t.title().map(|c| c.to_string()),
                get_text(t, &ItemKey::RecordingDate)
                    .or_else(|| get_text(t, &ItemKey::Year))
                    .or_else(|| t.year().map(|y| y.to_string())),
            ),
            None => (None, None, None),
        };
        let json = if find_backup_in_file(&tagged).is_some() {
            None
        } else {
            Some(make_backup_string(tag, tag_type))
        };
        (a, t, y, json)
    };
    let searchable = build_searchable_backup(path, artist, title, year);

    // Fetch the tag by type (creating it if missing) so this never depends on
    // whether that type happens to be the file's "primary" tag.
    if tagged.tag(tag_type).is_none() {
        tagged.insert_tag(Tag::new(tag_type));
    }
    let key = backup_item_key(backup_field);
    let tag = tagged
        .tag_mut(tag_type)
        .expect("tag of tag_type was just ensured");
    tag.insert_text(key, searchable);
    if let Some(json) = json_backup {
        tag.insert(TagItem::new(
            ItemKey::Unknown(BACKUP_KEY.to_string()),
            ItemValue::Text(json),
        ));
    }
    tagged
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| e.to_string())
}

/// Returns the first embedded picture as a `data:` URL, or None if the file
/// has no cover art. Used for lazy thumbnail loading in the track table.
#[tauri::command]
pub async fn read_cover_art(path: String) -> Result<Option<String>, String> {
    use base64::Engine;
    let tagged = lofty::read_from_path(&path).map_err(|e| e.to_string())?;
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return Ok(None);
    };
    let Some(pic) = tag.pictures().first() else {
        return Ok(None);
    };
    let mime = pic
        .mime_type()
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| "image/jpeg".to_string());
    let b64 = base64::engine::general_purpose::STANDARD.encode(pic.data());
    Ok(Some(format!("data:{mime};base64,{b64}")))
}

/// Renames the file to `new_stem` (extension preserved), resolving collisions
/// by appending " (2)", " (3)", … Returns the new absolute path.
#[tauri::command]
pub async fn rename_file(path: String, new_stem: String) -> Result<String, String> {
    let src = Path::new(&path);
    if !src.is_file() {
        return Err(format!("File not found: {path}"));
    }
    let stem = new_stem.trim();
    if stem.is_empty() {
        return Err("New name is empty".into());
    }
    let parent = src.parent().unwrap_or_else(|| Path::new("."));
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("");

    let build = |candidate: &str| -> std::path::PathBuf {
        if ext.is_empty() {
            parent.join(candidate)
        } else {
            parent.join(format!("{candidate}.{ext}"))
        }
    };

    let mut target = build(stem);
    // Same path (case-insensitive no-op rename) — nothing to do.
    if target == src {
        return Ok(path);
    }
    let mut n = 2;
    while target.exists() {
        target = build(&format!("{stem} ({n})"));
        n += 1;
    }
    std::fs::rename(src, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

fn set_text(tag: &mut Tag, key: ItemKey, value: &Option<String>) {
    if let Some(v) = value {
        let v = v.trim();
        if !v.is_empty() {
            tag.insert_text(key, v.to_string());
        }
    }
}

fn set_numbered(tag: &mut Tag, num_key: ItemKey, total_key: ItemKey, value: &Option<String>) {
    let Some(v) = value else { return };
    let v = v.trim();
    if v.is_empty() {
        return;
    }
    if let Some((n, t)) = v.split_once('/') {
        if !n.trim().is_empty() {
            tag.insert_text(num_key, n.trim().to_string());
        }
        if !t.trim().is_empty() {
            tag.insert_text(total_key, t.trim().to_string());
        }
    } else {
        tag.insert_text(num_key, v.to_string());
    }
}
