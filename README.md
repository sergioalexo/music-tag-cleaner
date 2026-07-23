# 🎵 MusicTagCleaner

Cross-platform desktop app (Tauri 2 + React/TypeScript + Rust) that strips audio
file metadata down to the common essentials, backs up the original tags inside
the file itself, and uses a local AI (Ollama) to clean up messy artist names,
titles, years, and genres.

## Features

- **Select Folder / Add Files** — native pickers; supports `.mp3`, `.flac`,
  `.ogg`, `.aac`, `.m4a`, `.wav`, `.aiff`
- **Clean Tags** — strips every tag field except Title, Artist, Album,
  Album Artist, Track/Disc Number, Year, Genre, Comment, and embedded cover
  art. Everything else (TXXX, PRIV, MusicBrainz IDs, replaygain, encoder info,
  …) is deleted. Before/after preview with per-field checkboxes; nothing is
  written until you confirm.
- **AI Clean** — sends the tags to a local Ollama model that removes featured
  artists / legal names from the artist field, strips `(Radio Edit)`-style
  title suffixes, corrects the year to the original release, and normalizes
  the genre. Same confirm-before-write preview.
- **Backup / Restore** — before the first write, all original text tags are
  serialized to JSON and stored inside the file as `TAGBACKUP_v1::{json}`
  (a `TXXX:TAGBACKUP` frame in ID3v2, `TAGBACKUP=` in Vorbis comments, a
  freeform atom in MP4). An existing backup is never overwritten, so the
  oldest state is always recoverable via **Restore Backup**.
- Settings (AI backend, Ollama URL/model, batch size, processing toggles,
  last-used folder) persist via `tauri-plugin-store`.
- Keyboard shortcuts: `Ctrl+O` open folder, `Ctrl+A` select all files,
  `Escape` close modal / cancel preview.

## Prerequisites

- **Node.js** ≥ 20 and **Rust** (stable) — <https://tauri.app/start/prerequisites/>
- On Windows: WebView2 runtime (preinstalled on Win 10/11) and the
  Visual Studio C++ Build Tools
- **Ollama** for the AI Clean feature — <https://ollama.com>, then e.g.
  `ollama pull llama3.1` or `ollama pull deepseek-r1:14b`

## Development

```sh
npm install
npm run tauri dev
```

## Release build

```sh
npm run tauri build
```

The bundled icons are auto-generated placeholders. To use a real icon, drop a
1024×1024 PNG somewhere and run `npm run tauri icon path/to/icon.png`.

## Architecture notes

- **Rust backend** ([src-tauri/src](src-tauri/src)) uses the
  [`lofty`](https://crates.io/crates/lofty) crate so MP3/ID3v2, FLAC/Vorbis,
  MP4/iTunes atoms, OGG, WAV, and AIFF are handled uniformly.
  - [files.rs](src-tauri/src/commands/files.rs) — scanning, tag read/write.
    `write_tags` performs read → backup → write in one operation and also
    removes secondary tag formats (ID3v1, APE) so stripped fields cannot
    linger there.
  - [backup.rs](src-tauri/src/commands/backup.rs) — backup serialization
    uses each format's *native* key names (`TIT2`, `ARTIST`, …) so
    `ItemKey::from_key` restores fields exactly.
  - [ai.rs](src-tauri/src/commands/ai.rs) — Ollama `/api/generate` calls with
    `format: "json"`, defensive response parsing (handles `<think>` blocks
    from reasoning models, markdown fences, and object-wrapped arrays).
- **AI responses are never auto-applied** — every change goes through the
  preview table, and malformed/missing fields fall back to the original value.
- The Claude API backend is reserved UI (disabled, "Coming Soon").

### Known limitations

- Binary tag frames other than cover art (e.g. SYLT lyrics blobs) are not
  included in the JSON backup — they are stripped and not restorable.
- Cover art is preserved through strip/clean/restore only while
  "Preserve embedded cover art" is enabled in Settings.

## Manual test checklist

- [ ] MP3 with ID3v2 (incl. TXXX/PRIV frames): strip, verify backup, restore
- [ ] FLAC with Vorbis comments (incl. MusicBrainz keys): strip + restore
- [ ] M4A with iTunes atoms: strip + restore
- [ ] AI Clean with Ollama running (messy artist/title/year fixtures)
- [ ] AI Clean with Ollama stopped → friendly error message
- [ ] Preview: uncheck one removal row → field survives the strip
