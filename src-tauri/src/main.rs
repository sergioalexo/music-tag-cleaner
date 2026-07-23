#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod models;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            commands::files::scan_folder,
            commands::files::list_files,
            commands::files::import_paths,
            commands::files::read_tags,
            commands::files::read_tags_batch,
            commands::files::write_tags,
            commands::files::read_cover_art,
            commands::files::rename_file,
            commands::files::backup_file,
            commands::backup::restore_from_backup,
            commands::ai::check_ollama,
            commands::ai::ai_clean_batch,
            commands::ai::ai_map_genre_batch,
            commands::components::ollama_info,
            commands::components::install_ollama,
            commands::components::start_ollama,
            commands::components::pull_model,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MusicTagCleaner");
}
