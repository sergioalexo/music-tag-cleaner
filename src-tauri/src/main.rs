#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod models;

use std::path::Path;
use std::sync::Mutex;

use tauri::{Emitter, Manager};

/// Audio files / folders named on the command line — from a Windows
/// "Open with MusicTagCleaner", a macOS "Open With", or a shell invocation.
/// The first instance stashes these here until the UI asks for them with
/// `take_opened_files`; later invocations arrive via the single-instance hook.
#[derive(Default)]
struct PendingOpen(Mutex<Vec<String>>);

/// Keeps only the arguments that look like an audio file or a folder, so a
/// stray flag or the exe path itself is never treated as something to import.
fn openable_paths<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .filter(|a| {
            let p = Path::new(a);
            p.is_dir()
                || p.extension()
                    .and_then(|e| e.to_str())
                    .map(|e| {
                        commands::files::AUDIO_EXTENSIONS
                            .contains(&e.to_ascii_lowercase().as_str())
                    })
                    .unwrap_or(false)
        })
        .collect()
}

/// The UI calls this once on startup to pick up any files the app was opened
/// with; it drains the list so a later reload doesn't re-import them.
#[tauri::command]
fn take_opened_files(state: tauri::State<PendingOpen>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

fn main() {
    let initial = openable_paths(std::env::args().skip(1));

    tauri::Builder::default()
        // Must be registered first: a second launch (e.g. "Open with" on more
        // files while the app is already open) forwards its arguments here and
        // exits. Paths go onto the shared queue and the UI is nudged to drain
        // it with `take_opened_files` — selecting N files spawns N processes in
        // a burst, some before the webview has a listener, so the queue (not
        // the event payload) is the source of truth.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let paths = openable_paths(argv.into_iter().skip(1));
            if !paths.is_empty() {
                if let Some(state) = app.try_state::<PendingOpen>() {
                    state.0.lock().unwrap().extend(paths);
                }
                let _ = app.emit("open-files", ());
            }
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(PendingOpen(Mutex::new(initial)))
        .invoke_handler(tauri::generate_handler![
            take_opened_files,
            commands::files::scan_folder,
            commands::files::list_files,
            commands::files::import_paths,
            commands::files::read_tags,
            commands::files::read_tags_batch,
            commands::files::write_tags,
            commands::files::write_raw_field,
            commands::files::read_cover_art,
            commands::files::read_cover_thumbnail,
            commands::files::image_info,
            commands::files::set_cover_art,
            commands::files::remove_cover_art,
            commands::files::restore_cover_art,
            commands::files::standardize_artwork,
            commands::files::rename_file,
            commands::files::delete_file,
            commands::files::write_text_file,
            commands::files::read_text_file,
            commands::files::backup_file,
            commands::backup::restore_from_backup,
            commands::ai::check_ollama,
            commands::ai::ai_clean_batch,
            commands::ai::ai_map_genre_batch,
            commands::ai::ai_preview_prompt,
            commands::ai::ai_clean_prompt,
            commands::ai::ai_genre_prompt,
            commands::ai::ai_parse_clean_response,
            commands::ai::ai_parse_genre_response,
            commands::components::ollama_info,
            commands::components::install_ollama,
            commands::components::start_ollama,
            commands::components::pull_model,
            commands::components::delete_model,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MusicTagCleaner");
}
