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
use crate::models::{AudioFile, ImageInfo, TagData, TagReadResult};

pub const AUDIO_EXTENSIONS: &[&str] = &["mp3", "flac", "ogg", "aac", "m4a", "wav", "aiff", "aif"];

const FILE_OP_TIMEOUT: Duration = Duration::from_secs(20);

/// `key_name()` of the private frame that holds the app-assigned track id.
const TRACK_ID_FIELD: &str = "Unknown(TRACKID)";

fn track_id_key() -> ItemKey {
    ItemKey::Unknown("TRACKID".to_string())
}

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

/// Maps `f` over `items` across a few threads. Each tag parse is an
/// independent file read + decode, so a folder scan or a batch tag read of a
/// few hundred files is otherwise a multi-second sequential stall. Small
/// inputs stay single-threaded to avoid the spawn overhead.
fn par_map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    const MAX_THREADS: usize = 8;
    if items.len() <= 16 {
        return items.iter().map(&f).collect();
    }
    let chunk = items.len().div_ceil(MAX_THREADS.min(items.len()));
    std::thread::scope(|s| {
        items
            .chunks(chunk)
            .map(|c| s.spawn(|| c.iter().map(&f).collect::<Vec<_>>()))
            .collect::<Vec<_>>()
            .into_iter()
            .flat_map(|h| h.join().unwrap_or_default())
            .collect()
    })
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
    let tagged = lofty::read_from_path(path).ok();
    let has_backup = tagged
        .as_ref()
        .map(|t| find_backup_in_file(t).is_some())
        .unwrap_or(false);
    let duration_secs = tagged
        .as_ref()
        .map(|t| t.properties().duration().as_secs_f64());
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
        duration_secs,
    }
}

// scan_folder / list_files / import_paths each parse every file they touch, so
// they run on the blocking pool. Their duration scales with the folder size, so
// they intentionally skip run_blocking's fixed per-operation timeout.
#[tauri::command]
pub async fn scan_folder(path: String, recursive: bool) -> Result<Vec<AudioFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&path);
        if !root.is_dir() {
            return Err(format!("Not a folder: {path}"));
        }
        let max_depth = if recursive { usize::MAX } else { 1 };
        let paths: Vec<std::path::PathBuf> = WalkDir::new(root)
            .max_depth(max_depth)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file() && is_audio(e.path()))
            .map(|e| e.into_path())
            .collect();
        let mut files = par_map(&paths, |p| file_info(p));
        files.sort_by_cached_key(|f| f.path.to_lowercase());
        Ok(files)
    })
    .await
    .map_err(|_| "Scanning the folder failed unexpectedly".to_string())?
}

#[tauri::command]
pub async fn list_files(paths: Vec<String>) -> Vec<AudioFile> {
    tauri::async_runtime::spawn_blocking(move || par_map(&paths, |p| file_info(Path::new(p))))
        .await
        .unwrap_or_default()
}

/// Imports a mix of files and folders (as produced by a drag-and-drop),
/// recursing into any folders. Non-audio paths are ignored.
#[tauri::command]
pub async fn import_paths(paths: Vec<String>, recursive: bool) -> Vec<AudioFile> {
    tauri::async_runtime::spawn_blocking(move || {
        let max_depth = if recursive { usize::MAX } else { 1 };
        let mut targets: Vec<std::path::PathBuf> = Vec::new();
        for p in paths {
            let path = Path::new(&p);
            if path.is_dir() {
                targets.extend(
                    WalkDir::new(path)
                        .max_depth(max_depth)
                        .into_iter()
                        .filter_map(|e| e.ok())
                        .filter(|e| e.file_type().is_file() && is_audio(e.path()))
                        .map(|e| e.into_path()),
                );
            } else if path.is_file() && is_audio(path) {
                targets.push(path.to_path_buf());
            }
        }
        par_map(&targets, |p| file_info(p))
    })
    .await
    .unwrap_or_default()
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
    data.track_id = get_text(tag, &track_id_key());
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
    // Fallback in case this format surfaces the private frame under a name the
    // typed accessor above missed.
    if data.track_id.is_none() {
        data.track_id = data.all_fields.get(TRACK_ID_FIELD).cloned();
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
        "Album" => ItemKey::AlbumTitle,
        "AlbumArtist" => ItemKey::AlbumArtist,
        "Genre" => ItemKey::Genre,
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
    run_blocking(move || read_tags_impl(&path)).await
}

/// Reads many files' tags off the async runtime. Deliberately *not* wrapped in
/// `run_blocking`: its timeout is per-operation, and a legitimately large batch
/// can outlast it. Each file still reports its own error, so one unreadable
/// file never fails the batch.
#[tauri::command]
pub async fn read_tags_batch(paths: Vec<String>) -> Vec<TagReadResult> {
    let fallback: Vec<String> = paths.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        par_map(&paths, |p| match read_tags_impl(p) {
            Ok(tags) => TagReadResult {
                path: p.clone(),
                tags: Some(tags),
                error: None,
            },
            Err(e) => TagReadResult {
                path: p.clone(),
                tags: None,
                error: Some(e),
            },
        })
    })
    .await;

    joined.unwrap_or_else(|_| {
        fallback
            .into_iter()
            .map(|p| TagReadResult {
                path: p,
                tags: None,
                error: Some("Reading tags failed unexpectedly".to_string()),
            })
            .collect()
    })
}

/// Writes the common fields in `tags`, dropping everything else.
/// `keep_extra` lists canonical key names (see `key_name`) of non-common
/// fields to carry over from the existing tag — used both to honor
/// unchecked removals in the strip preview and to preserve everything
/// when stripping is disabled. The backup (if requested) is captured from
/// the file's current state before anything is overwritten; an existing
/// backup is never replaced.
///
/// `backup_field` (when Some) writes "file name | | artist | | title | | year"
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
    run_blocking(move || {
        write_tags_blocking(&path, tags, backup, keep_extra, preserve_art, backup_field)
    })
    .await
}

fn write_tags_blocking(
    path: &str,
    tags: TagData,
    backup: bool,
    keep_extra: Vec<String>,
    preserve_art: bool,
    backup_field: Option<String>,
) -> Result<(), String> {
    let tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
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
    set_text(&mut new_tag, track_id_key(), &tags.track_id);
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
            new_tag.insert_text(key, build_searchable_backup(path, artist, title, year));
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
        // `insert` (checked) silently drops ItemKey::Unknown keys the format
        // doesn't already map — see the comment on `set_text` — which meant
        // this JSON snapshot never actually made it into ID3v2 files, and
        // "Restore Backup" had nothing to restore from.
        new_tag.insert_unchecked(TagItem::new(
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
            .remove_from_path(path)
            .map_err(|e| e.to_string())?;
    }
    new_tag
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| e.to_string())
}

/// Writes (or, when `value` is empty, completely removes) a raw tag field
/// identified by its `key_name()` display string — the same name shown in
/// the "All Tags" view. Matches against the tag's existing items rather than
/// reconstructing an `ItemKey` from the string, so it works for every key
/// `allFields` can surface, known or unknown to lofty.
#[tauri::command]
pub async fn write_raw_field(path: String, field_key: String, value: String) -> Result<(), String> {
    run_blocking(move || write_raw_field_blocking(&path, &field_key, &value)).await
}

fn write_raw_field_blocking(path: &str, field_key: &str, value: &str) -> Result<(), String> {
    let mut tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    let tag_type = tagged
        .primary_tag()
        .map(|t| t.tag_type())
        .unwrap_or_else(|| tagged.file_type().primary_tag_type());
    let Some(tag) = tagged.tag_mut(tag_type) else {
        return Ok(());
    };
    let Some(existing_key) = tag
        .items()
        .find(|item| key_name(item.key()) == field_key)
        .map(|item| item.key().clone())
    else {
        return Ok(()); // Field no longer present — nothing to write or clear.
    };
    let value = value.trim();
    if value.is_empty() {
        tag.remove_key(&existing_key);
    } else {
        // `existing_key` is very often ItemKey::Unknown for a raw/"All Tags"
        // field — same silent-drop issue as set_text above, so this must go
        // through insert_unchecked too.
        tag.insert_unchecked(TagItem::new(existing_key, ItemValue::Text(value.to_string())));
    }
    tagged
        .save_to_path(path, WriteOptions::default())
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
        // See the matching fix in write_tags_blocking: this must be
        // insert_unchecked, or the snapshot silently never gets written.
        tag.insert_unchecked(TagItem::new(
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
    run_blocking(move || read_cover_art_blocking(&path)).await
}

fn read_cover_art_blocking(path: &str) -> Result<Option<String>, String> {
    use base64::Engine;
    let tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
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

/// Returns a small JPEG data URL of the first embedded picture — for the track
/// table's tiny thumbnails, where handing back the full-resolution art (via
/// `read_cover_art`) for hundreds of rows at once would use hundreds of MB of
/// base64 and freeze the UI. `size` is the longest side in px (clamped 16–512).
#[tauri::command]
pub async fn read_cover_thumbnail(path: String, size: u32) -> Result<Option<String>, String> {
    run_blocking(move || {
        use base64::Engine;
        use image::GenericImageView;

        let size = size.clamp(16, 512);
        let tagged = lofty::read_from_path(&path).map_err(|e| e.to_string())?;
        let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
            return Ok(None);
        };
        let Some(pic) = tag.pictures().first() else {
            return Ok(None);
        };
        let img = image::load_from_memory(pic.data()).map_err(|e| e.to_string())?;
        let thumb = if img.dimensions().0.max(img.dimensions().1) > size {
            img.resize(size, size, image::imageops::FilterType::Triangle)
        } else {
            img
        };
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 78)
            .encode_image(&thumb.to_rgb8())
            .map_err(|e| e.to_string())?;
        Ok(Some(format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&out)
        )))
    })
    .await
}

/// Returns byte size, pixel dimensions, and mime type of the first embedded
/// picture, or None if the file has no cover art. Dimensions are decoded from
/// the picture bytes with the `image` crate (lofty exposes the mime/bytes only).
#[tauri::command]
pub async fn image_info(path: String) -> Result<Option<ImageInfo>, String> {
    run_blocking(move || image_info_blocking(&path)).await
}

fn image_info_blocking(path: &str) -> Result<Option<ImageInfo>, String> {
    let tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
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
    let size_bytes = pic.data().len() as u64;
    let (width, height) = image::load_from_memory(pic.data())
        .map(|img| {
            use image::GenericImageView;
            img.dimensions()
        })
        .unwrap_or((0, 0));
    Ok(Some(ImageInfo { mime, size_bytes, width, height }))
}

fn mime_from_extension(image_path: &str) -> lofty::picture::MimeType {
    match Path::new(image_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "png" => lofty::picture::MimeType::Png,
        "gif" => lofty::picture::MimeType::Gif,
        "bmp" => lofty::picture::MimeType::Bmp,
        _ => lofty::picture::MimeType::Jpeg,
    }
}

fn mime_from_data_url_type(mime_str: &str) -> lofty::picture::MimeType {
    match mime_str {
        "image/png" => lofty::picture::MimeType::Png,
        "image/gif" => lofty::picture::MimeType::Gif,
        "image/bmp" => lofty::picture::MimeType::Bmp,
        _ => lofty::picture::MimeType::Jpeg,
    }
}

/// Embeds `bytes` as the file's sole cover art, replacing any existing picture.
fn embed_picture_bytes(path: &str, mime: lofty::picture::MimeType, bytes: Vec<u8>) -> Result<(), String> {
    let picture = lofty::picture::Picture::new_unchecked(
        lofty::picture::PictureType::CoverFront,
        Some(mime),
        None,
        bytes,
    );

    let mut tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    let tag_type = tagged
        .primary_tag()
        .map(|t| t.tag_type())
        .unwrap_or_else(|| tagged.file_type().primary_tag_type());
    if tagged.primary_tag().is_none() {
        tagged.insert_tag(Tag::new(tag_type));
    }
    let tag = tagged.tag_mut(tag_type).ok_or("Could not access tag")?;
    tag.set_picture(0, picture);
    tagged
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| e.to_string())
}

/// Removes all embedded pictures from the file.
fn remove_all_pictures(path: &str) -> Result<(), String> {
    let mut tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    let tag_type = tagged
        .primary_tag()
        .map(|t| t.tag_type())
        .unwrap_or_else(|| tagged.file_type().primary_tag_type());
    let Some(tag) = tagged.tag_mut(tag_type) else {
        return Ok(());
    };
    while !tag.pictures().is_empty() {
        tag.remove_picture(0);
    }
    tagged
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| e.to_string())
}

/// Embeds `image_path` as the file's cover art, replacing any existing picture.
#[tauri::command]
pub async fn set_cover_art(path: String, image_path: String) -> Result<(), String> {
    run_blocking(move || {
        let bytes = std::fs::read(&image_path).map_err(|e| e.to_string())?;
        let mime = mime_from_extension(&image_path);
        embed_picture_bytes(&path, mime, bytes)
    })
    .await
}

/// Removes all embedded cover art from the file.
#[tauri::command]
pub async fn remove_cover_art(path: String) -> Result<(), String> {
    run_blocking(move || remove_all_pictures(&path)).await
}

/// Re-embeds (or removes, if `data_url` is `None`/empty) cover art from a
/// `data:<mime>;base64,<data>` string — used to undo/redo artwork changes
/// without needing to keep the original source file around.
#[tauri::command]
pub async fn restore_cover_art(path: String, data_url: Option<String>) -> Result<(), String> {
    run_blocking(move || {
        use base64::Engine;
        let Some(url) = data_url.filter(|u| !u.is_empty()) else {
            return remove_all_pictures(&path);
        };
        let (meta, b64) = url.split_once(',').ok_or("Malformed image data")?;
        let mime_str = meta
            .strip_prefix("data:")
            .and_then(|m| m.strip_suffix(";base64"))
            .unwrap_or("image/jpeg");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| e.to_string())?;
        embed_picture_bytes(&path, mime_from_data_url_type(mime_str), bytes)
    })
    .await
}

/// Recompresses one file's cover art to a standard form: JPEG at `quality`,
/// scaled so the longest side is at most `max_dim` (never upscaled). Returns
/// `None` when the file has no art, or the art is already JPEG, within size,
/// and re-encoding it would not shrink it. The before/after data URLs let the
/// caller record the change in the undo/redo history like a manual swap.
#[tauri::command]
pub async fn standardize_artwork(
    path: String,
    max_dim: u32,
    quality: u8,
) -> Result<Option<crate::models::ArtworkChange>, String> {
    run_blocking(move || standardize_artwork_blocking(&path, max_dim, quality)).await
}

/// A standardized cover: the new JPEG bytes plus the source and result pixel
/// sizes (for the history entry's before/after summary).
struct RecompressedCover {
    jpeg: Vec<u8>,
    from: (u32, u32),
    to: (u32, u32),
}

/// The pixel transform behind `standardize_artwork`, split out so it can be
/// tested without an audio container. Given the original picture bytes,
/// returns the standardized JPEG plus its dimensions — or `None` when the
/// original is already a JPEG within `max_dim` that a re-encode would not
/// shrink.
fn recompress_cover(
    orig: &[u8],
    is_jpeg: bool,
    max_dim: u32,
    quality: u8,
) -> Result<Option<RecompressedCover>, String> {
    use image::GenericImageView;

    let max_dim = max_dim.clamp(64, 4000);
    let quality = quality.clamp(40, 100);

    let img = image::load_from_memory(orig).map_err(|e| format!("Unreadable cover art: {e}"))?;
    let (w, h) = img.dimensions();

    let needs_resize = w.max(h) > max_dim;
    let scaled = if needs_resize {
        img.resize(max_dim, max_dim, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    let (nw, nh) = scaled.dimensions();

    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality)
        .encode_image(&scaled.to_rgb8())
        .map_err(|e| format!("JPEG encode failed: {e}"))?;

    // Leave a JPEG that is already within bounds alone unless the re-encode
    // saves real space (>10%) — a marginal shave isn't worth a generation of
    // quality loss.
    if !needs_resize && is_jpeg && (out.len() as f64) > (orig.len() as f64) * 0.9 {
        return Ok(None);
    }
    Ok(Some(RecompressedCover {
        jpeg: out,
        from: (w, h),
        to: (nw, nh),
    }))
}

fn standardize_artwork_blocking(
    path: &str,
    max_dim: u32,
    quality: u8,
) -> Result<Option<crate::models::ArtworkChange>, String> {
    use base64::Engine;

    let tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return Ok(None);
    };
    let Some(pic) = tag.pictures().first() else {
        return Ok(None);
    };
    let orig = pic.data().to_vec();
    let is_jpeg = matches!(pic.mime_type(), Some(lofty::picture::MimeType::Jpeg));
    let before_mime = pic
        .mime_type()
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| "image/jpeg".to_string());
    drop(tagged);

    let Some(new) = recompress_cover(&orig, is_jpeg, max_dim, quality)? else {
        return Ok(None);
    };

    embed_picture_bytes(path, lofty::picture::MimeType::Jpeg, new.jpeg.clone())?;

    let b64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(Some(crate::models::ArtworkChange {
        before_data_url: format!("data:{before_mime};base64,{}", b64(&orig)),
        after_data_url: format!("data:image/jpeg;base64,{}", b64(&new.jpeg)),
        before_bytes: orig.len() as u64,
        after_bytes: new.jpeg.len() as u64,
        before_width: new.from.0,
        before_height: new.from.1,
        after_width: new.to.0,
        after_height: new.to.1,
    }))
}

/// Renames the file to `new_stem` (extension preserved), resolving collisions
/// by appending " (2)", " (3)", … Returns the new absolute path.
#[tauri::command]
pub async fn rename_file(path: String, new_stem: String) -> Result<String, String> {
    run_blocking(move || rename_file_blocking(&path, &new_stem)).await
}

fn rename_file_blocking(path: &str, new_stem: &str) -> Result<String, String> {
    let src = Path::new(path);
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
    // Byte-identical path — nothing to do.
    if target == src {
        return Ok(path.to_string());
    }

    // Does `p` resolve to the very file we're renaming? On a case-insensitive
    // volume (Windows, default macOS) "Bonobo - Kerala.mp3" and an on-disk
    // "bonobo - kerala.mp3" are the same file, so `target.exists()` is true
    // even though the paths differ. Without this check the loop below would
    // treat the file as colliding with itself and append " (2)".
    let src_canon = std::fs::canonicalize(src).ok();
    let is_self = |p: &std::path::Path| {
        matches!(
            (std::fs::canonicalize(p).ok(), src_canon.as_ref()),
            (Some(a), Some(b)) if a == *b
        )
    };

    let mut n = 2;
    while target.exists() && !is_self(&target) {
        target = build(&format!("{stem} ({n})"));
        n += 1;
    }
    // A case-only / normalization-only change lands here with `target` still
    // pointing at `src`; fs::rename applies it (a case-only rename is fine on
    // Windows and macOS).
    std::fs::rename(src, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

/// Sends the file to the OS Recycle Bin / Trash rather than deleting it
/// permanently, so a mistaken delete from the app can still be recovered.
#[tauri::command]
pub async fn delete_file(path: String) -> Result<(), String> {
    run_blocking(move || {
        let src = Path::new(&path);
        if !src.is_file() {
            return Err(format!("File not found: {path}"));
        }
        trash::delete(src).map_err(|e| e.to_string())
    })
    .await
}

/// Generic text file write, used for exporting settings to a user-chosen path.
#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

/// Generic text file read, used for importing a previously exported settings file.
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

fn set_text(tag: &mut Tag, key: ItemKey, value: &Option<String>) {
    if let Some(v) = value {
        let v = v.trim();
        if !v.is_empty() {
            // `Tag::insert_text` goes through `Tag::insert`, which calls
            // `ItemKey::re_map` with `allow_unknown: false` — so it silently
            // drops any `ItemKey::Unknown` (e.g. our private TRACKID field)
            // that isn't in the format's own key map, *before* the item is
            // even added to the tag. `insert_unchecked` is lofty's documented
            // way to write such keys; the format-specific writer still
            // rejects a genuinely out-of-spec key at save time, so this
            // doesn't bypass validation, just the redundant pre-check that
            // has no entry for private keys anyway.
            tag.insert_unchecked(TagItem::new(key, ItemValue::Text(v.to_string())));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mtc-test-{}-{:?}",
            name,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rename_case_only_change_does_not_append_suffix() {
        let dir = scratch("case");
        let src = dir.join("bonobo - kerala.mp3");
        std::fs::write(&src, b"x").unwrap();

        let out = rename_file_blocking(src.to_str().unwrap(), "Bonobo - Kerala").unwrap();

        assert!(
            !out.contains("(2)"),
            "case-only rename should not collide with itself: {out}"
        );
        assert!(out.ends_with("Bonobo - Kerala.mp3"));
        // Exactly one file in the dir (the renamed one), not a stale duplicate.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rename_real_collision_still_appends_suffix() {
        let dir = scratch("collision");
        let a = dir.join("song a.mp3");
        let b = dir.join("song b.mp3");
        std::fs::write(&a, b"a").unwrap();
        std::fs::write(&b, b"b").unwrap();

        let out = rename_file_blocking(b.to_str().unwrap(), "song a").unwrap();

        assert!(out.ends_with("song a (2).mp3"), "got {out}");
        std::fs::remove_dir_all(&dir).ok();
    }

    fn png_bytes(w: u32, h: u32) -> Vec<u8> {
        let mut img = image::RgbImage::new(w, h);
        for (x, y, px) in img.enumerate_pixels_mut() {
            *px = image::Rgb([(x % 256) as u8, (y % 256) as u8, 128]);
        }
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut out, image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    #[test]
    fn recompress_downscales_oversized_art() {
        let out = recompress_cover(&png_bytes(2000, 1500), false, 1000, 85).unwrap().unwrap();
        assert_eq!(out.from, (2000, 1500));
        assert_eq!(out.to, (1000, 750)); // longest side clamped, aspect kept
        assert_eq!(&out.jpeg[..3], b"\xFF\xD8\xFF"); // JPEG magic
    }

    #[test]
    fn recompress_converts_non_jpeg_even_when_small() {
        let res = recompress_cover(&png_bytes(400, 400), false, 1000, 85).unwrap();
        assert!(res.is_some(), "a PNG should still be converted to JPEG");
        assert_eq!(res.unwrap().to, (400, 400)); // not upscaled
    }

    #[test]
    fn recompress_skips_a_conformant_jpeg() {
        // Encode a small JPEG, then feed it back in as an existing JPEG.
        let jpeg = recompress_cover(&png_bytes(500, 500), false, 1000, 85).unwrap().unwrap().jpeg;
        let again = recompress_cover(&jpeg, true, 1000, 85).unwrap();
        assert!(again.is_none(), "a JPEG within bounds should not be rewritten");
    }

    /// A minimal valid MPEG-1 Layer III frame (128kbps / 44100Hz / stereo,
    /// no CRC), repeated so lofty's format prober has enough consecutive
    /// frames to identify the file as MP3.
    fn minimal_mp3_bytes() -> Vec<u8> {
        let mut bytes = Vec::new();
        for _ in 0..20 {
            bytes.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
            bytes.extend(std::iter::repeat(0u8).take(413));
        }
        bytes
    }

    // Regression test for "Generate IDs" writing a Track ID that never shows
    // up on read-back: ItemKey::Unknown("TRACKID") is 7 bytes, not a valid
    // 4-byte ID3v2 frame id, so it must round-trip as a TXXX frame with
    // description "TRACKID" rather than being silently dropped.
    #[test]
    fn track_id_round_trips_through_id3v2() {
        let dir = scratch("trackid");
        let path = dir.join("track.mp3");
        std::fs::write(&path, minimal_mp3_bytes()).unwrap();
        let path_str = path.to_str().unwrap().to_string();

        let mut tags = TagData::default();
        tags.track_id = Some("000123".to_string());
        write_tags_blocking(&path_str, tags, false, vec![], false, None)
            .expect("write_tags_blocking should succeed");

        let read_back = read_tags_impl(&path_str).expect("read_tags_impl should succeed");
        assert_eq!(
            read_back.track_id.as_deref(),
            Some("000123"),
            "Track ID did not round-trip through ID3v2"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // Same class of bug as the Track ID one above, hitting the searchable
    // backup: the JSON snapshot is stored under `ItemKey::Unknown(BACKUP_KEY)`
    // ("TAGBACKUP"), an unmapped private key, so it must go through
    // `insert_unchecked` too or it's silently dropped and "Restore Backup"
    // has nothing to restore from.
    #[test]
    fn backup_blob_round_trips_through_id3v2() {
        let dir = scratch("backupblob");
        let path = dir.join("track.mp3");
        std::fs::write(&path, minimal_mp3_bytes()).unwrap();
        let path_str = path.to_str().unwrap().to_string();

        let mut tags = TagData::default();
        tags.title = Some("Kerala".to_string());
        write_tags_blocking(&path_str, tags, true, vec![], false, None)
            .expect("write_tags_blocking should succeed");

        let tagged = lofty::read_from_path(&path_str).unwrap();
        assert!(
            find_backup_in_file(&tagged).is_some(),
            "searchable backup blob did not round-trip through ID3v2"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // Same class of bug again: editing a raw "All Tags" field whose key
    // lofty doesn't have a built-in mapping for (e.g. a custom TXXX
    // description) went through checked `insert_text` and was silently
    // dropped instead of actually changing the value on disk.
    #[test]
    fn raw_field_edit_round_trips_through_id3v2() {
        let dir = scratch("rawfield");
        let path = dir.join("track.mp3");
        std::fs::write(&path, minimal_mp3_bytes()).unwrap();
        let path_str = path.to_str().unwrap().to_string();

        // Seed an unmapped custom field directly, the way a file ripped by
        // some other tool might already have one.
        {
            let mut tag = Tag::new(TagType::Id3v2);
            tag.insert_unchecked(TagItem::new(
                ItemKey::Unknown("CUSTOMFIELD".to_string()),
                ItemValue::Text("old value".to_string()),
            ));
            tag.save_to_path(&path_str, WriteOptions::default()).unwrap();
        }

        write_raw_field_blocking(&path_str, "Unknown(CUSTOMFIELD)", "new value")
            .expect("write_raw_field_blocking should succeed");

        let read_back = read_tags_impl(&path_str).expect("read_tags_impl should succeed");
        assert_eq!(
            read_back.all_fields.get("Unknown(CUSTOMFIELD)").map(String::as_str),
            Some("new value"),
            "raw field edit did not round-trip through ID3v2"
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
