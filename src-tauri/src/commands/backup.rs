use lofty::config::WriteOptions;
use lofty::file::TaggedFile;
use lofty::prelude::*;
use lofty::tag::{ItemKey, ItemValue, Tag, TagItem, TagType};
use serde::{Deserialize, Serialize};

pub const BACKUP_PREFIX: &str = "TAGBACKUP_v1::";
/// Stored as TXXX:TAGBACKUP in ID3v2, TAGBACKUP= in Vorbis comments,
/// and a freeform atom in MP4.
pub const BACKUP_KEY: &str = "TAGBACKUP";

#[derive(Serialize, Deserialize)]
struct BackupData {
    tag_type: String,
    items: Vec<BackupItem>,
}

#[derive(Serialize, Deserialize)]
struct BackupItem {
    key: String,
    value: String,
}

pub fn find_backup_in_file(tagged: &TaggedFile) -> Option<String> {
    for tag in tagged.tags() {
        for item in tag.items() {
            if let ItemValue::Text(s) = item.value() {
                if s.starts_with(BACKUP_PREFIX) {
                    return Some(s.clone());
                }
            }
        }
    }
    None
}

/// Serializes every text field of `tag` using the tag-format's native key
/// names (TIT2, ARTIST, ...) so `ItemKey::from_key` can round-trip them
/// exactly on restore. Binary frames other than cover art are not included.
pub fn make_backup_string(tag: Option<&Tag>, tag_type: TagType) -> String {
    let mut items = Vec::new();
    if let Some(tag) = tag {
        for item in tag.items() {
            let text = match item.value() {
                ItemValue::Text(s) | ItemValue::Locator(s) => s.clone(),
                ItemValue::Binary(_) => continue,
            };
            if text.starts_with(BACKUP_PREFIX) {
                continue;
            }
            let key = item
                .key()
                .map_key(tag_type, true)
                .map(str::to_string)
                .unwrap_or_else(|| crate::commands::files::key_name(item.key()));
            items.push(BackupItem { key, value: text });
        }
    }
    let data = BackupData {
        tag_type: format!("{tag_type:?}"),
        items,
    };
    format!(
        "{BACKUP_PREFIX}{}",
        serde_json::to_string(&data).unwrap_or_else(|_| "{}".into())
    )
}

#[tauri::command]
pub async fn restore_from_backup(path: String) -> Result<(), String> {
    let tagged = lofty::read_from_path(&path).map_err(|e| e.to_string())?;
    let backup =
        find_backup_in_file(&tagged).ok_or_else(|| "No backup found in this file".to_string())?;
    let json = &backup[BACKUP_PREFIX.len()..];
    let data: BackupData =
        serde_json::from_str(json).map_err(|e| format!("Backup is corrupted: {e}"))?;

    let tag_type = tagged
        .primary_tag()
        .map(|t| t.tag_type())
        .or_else(|| tagged.first_tag().map(|t| t.tag_type()))
        .unwrap_or_else(|| tagged.file_type().primary_tag_type());

    let mut restored = Tag::new(tag_type);
    for item in data.items {
        let key = ItemKey::from_key(tag_type, &item.key);
        restored.push(TagItem::new(key, ItemValue::Text(item.value)));
    }
    // Cover art is preserved through strip/clean, so carry the current
    // pictures over rather than losing them on restore.
    if let Some(current) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        for pic in current.pictures() {
            restored.push_picture(pic.clone());
        }
    }
    drop(tagged);
    restored
        .save_to_path(&path, WriteOptions::default())
        .map_err(|e| e.to_string())
}
