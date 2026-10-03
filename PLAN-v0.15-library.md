# Plan — v0.15.0: a permanent Library, AI playlists from it, right-click open, Settings black screen

Hand-off plan for an implementing agent. Read `CLAUDE.md` first. Do **not** read
ROADMAP.md whole — grep its headings. Branch `v0.15-library` off `master`, one
commit per workstream, in the order below. Don't push/tag/release without the owner.

## The owner's mental model (the rule for this whole batch)

There are **two different things** and the app must never confuse them:

| | **Library** | **Working batch** |
|---|---|---|
| What | The finished collection — always one fixed folder (today `C:\Users\sopas\Music\Collection`, ~4,500 files) | The songs opened right now to clean/tag |
| Lifetime | Permanent. Remembered across launches, never forgotten | This session only |
| Feeds | Genre list, search, playlist matching, AI playlists | The track table |

Opening a new batch must **never** change, shrink or replace the Library or its genres.

---

## Verified facts (checked 2026-10-02, don't re-derive)

- `%APPDATA%\com.sopas.musictagcleaner\library-index.sqlite` right now has
  **`library_root` = empty, `library_track` = 0 rows, `index_meta` = empty**
  (file last written 2026-09-30 12:48). On 2026-09-27 it held 4,149 tracks under
  `C:\Users\sopas\Music\Collection`. Since genres come only from the index
  (`lib/genres.ts` → `libraryGenreNames(libraryIndex.genres, libraryTags)`), an
  empty index means **only the genres of the batch you just opened appear**. That's the
  "my genres are gone" bug.
- How the index can be wiped:
  - `set_library_roots` (`library_index.rs:264`) **deletes every track row** when
    called with `[]`, and deletes rows outside the new roots otherwise.
  - Settings → remove-root (`SettingsPage.tsx:244`) and Clear index
    (`SettingsPage.tsx:270`, `clear_library_index`) both destroy rows, and neither asks for confirmation.
  - `addLibraryRoot` (`App.tsx:176`, called on every folder open at `App.tsx:160`)
    **adds every opened batch folder as a library root**, which mixes working batches into
    the Library. The startup effect (`App.tsx:203–216`) seeds roots from
    `settings.lastFolder`, which is a *batch* folder, not the Library. `lastFolder` is now `""`.
  - The exact click that emptied it on 09-30 is **not confirmed**. Don't guess. Make
    the whole class impossible (workstream A).
- The "Genre" toolbar button is `LibraryPage.tsx:516–525` → `runGenre`
  (`App.tsx:715`). It asks the AI to map each track's genre to an existing one.
  The owner doesn't use it and wants it gone.
- Right-click on the track table already has Open / Open with… / Reveal / Inspect
  (`TrackTable.tsx:2250+`). It has **no** right-click on library tracks shown
  elsewhere (search dock `LibrarySearchPanel.tsx`, YT-import matched rows,
  sidebar), and there's no way to pull an indexed track into the working batch.
- The YT-import page already turns a playlist link or a typed list of songs into a playlist,
  matches it against the index, and exports `.m3u8` / Rekordbox XML
  (`YtMusicImportPage.tsx:999`). AI backends: Ollama / API / Claude CLI / Manual
  (`ai.rs`, `claude_cli.rs`, `useAI.ts`).
- There is **no React error boundary** (`src/main.tsx` renders `<App/>` bare), so
  any exception thrown while rendering unmounts the whole tree and leaves a black window. That
  matches "Settings → black screen". Settings has 1,636 lines and also renders the index
  card, which reads `stats`/`genres` that are now empty or null.

---

## Workstream E (do first): Settings black screen

1. Reproduce with `npm run tauri dev` → open Settings and read the devtools console
   (right-click → Inspect). Record the exact exception and component here before
   fixing.
2. Fix the root cause. Likely suspects: the index card with `stats === null` and
   0 roots, or the Genres card with an empty list. Verify; don't assume.
3. Add a top-level `ErrorBoundary` in `main.tsx`, plus one per page in `App.tsx`,
   that shows the error, a "Copy details" button and "Back to tracks", and logs
   through `notify(..., "error")`. A crash on one page should never black out the app again.
4. Verify: Settings opens with an empty index, with a full index, and after a re-index.

## Workstream A: the Library is one permanent folder

**A1. A single Library folder setting.**
- New setting `libraryFolder: string` (bump `CURRENT_SETTINGS_VERSION`, add a
  migration: seed it from the first existing `library_root` row, otherwise empty).
- Settings → Library card: shows the folder, "Change…", track and genre counts, and the last
  indexed time. Changing it asks for confirmation ("Library will be re-scanned
  from <new folder>").
- First launch with no library folder: a one-time prompt, "Where is your music
  library?", which suggests `Music\Collection` if it exists.

**A2. Stop working batches from touching the Library.**
- Delete `addLibraryRoot` and its call on folder open (`App.tsx:160–193`).
- Delete the `settings.lastFolder` seeding in the startup effect (`App.tsx:209–216`).
- Roots = exactly `[settings.libraryFolder]`. Nothing else ever writes roots.

**A3. Never lose the index by accident.**
- `set_library_roots` must not delete rows when given `[]`. Reject it with an error.
- Remove the per-root "remove" button. "Clear index" goes behind a typed or two-step
  confirmation and stays under an "Advanced" fold.
- If the folder is temporarily missing (unplugged drive), **keep** the rows and
  show "Library folder not found — showing last known library". Don't prune.

**A4. Always fresh, always loaded.**
- On every launch: load the index from sqlite immediately (instant genres and search),
  then run an incremental index in the background (already cheap: mtime+size).
- Re-index the Library after any write that touches files inside the Library folder,
  so genres you edit there show up right away.
- Optional: a filesystem watcher on the Library folder (`notify` crate) for
  files added or removed outside the app. Debounce it, and leave it for last if time is short.

**A5. Genres = Library genres ∪ working batch genres.**
- `libraryGenreNames` already merges both. After A1–A4 it just works. Add a
  test: opening a batch from outside the Library still offers every Library genre.
- In the genre picker, mark genres that only exist in the current batch
  (e.g. a small "new" tag) so typos are visible.

**A6. Make the split visible in the UI.**
- Sidebar header and toolbar wording: "Library (4,512)" vs "Working batch (37)".
- Status line when a batch is open: "Batch is not in your Library. Library
  genres are still available."

**Verify:** index the Collection, open a batch from `Downloads`, check that all Library
genres are in the picker, restart the app, check they're still there, and open another
batch. Check the root list is still exactly the Collection.

## Workstream B: remove the "Genre" button

- Remove the toolbar button (`LibraryPage.tsx:516–525`), the `onGenre` prop, the
  `runGenre` wiring in `App.tsx`, and the genre mode of `ManualAIDialog`, **if** nothing else
  uses them. Check `useAI.runGenre`, `ai_genre_prompt`, `ai_map_genre_batch` and
  `claude_genre_batch` for other callers before deleting the Rust side. If they're unused,
  delete them together with their tests.
- Keep the Settings → Genres card (Detect/merge duplicates, rename). That's a
  different feature.

## Workstream C: right-click → open songs

- One shared `TrackContextMenu` component (pull it out of `TrackTable.tsx:2250+`)
  used everywhere a track appears: the track table, the Library search dock, the
  sidebar track list, YT-import matched rows, and the AI-playlist results (D).
- Items: **Open** (default player), **Add to working batch** (loads the file into
  the table via `filesApi`, which also fixes the "in the index but not loaded" toast
  from the v0.14 plan), Reveal in Explorer, Copy path, Inspect tags.
- Multi-select support: "Open N songs" and "Add N to working batch".
- Use buttons and menus only, never drag (see the CLAUDE.md hard-won rule).

## Workstream D: AI playlists built from your Library

A new tab/mode on the YT-import page (the owner's decision), reusing its matcher,
results table and export:

**D1. Source = the Library only.** Not the working batch.

**D2. Filters before the prompt** (to narrow the pool and keep the prompt small):
- Genre (multi-select, from Library genres), year range, BPM range and key
  (from Rekordbox, D0), artist include or
  exclude, rating, duration, and "exclude tracks already in playlist X".
- A live count: "312 tracks match the filters".

**D3. Free-text instructions**, e.g. "wedding dance floor, no explicit lyrics".

**D4. Split into sets.** Presets plus a custom option:
- "Warm-up / Peak" or "Warm-up / Build / Peak", with track counts or duration per set.
- Free-form: "split into 3 playlists: start, warm-up, peak".

**D5. How it runs.**
- Build the prompt from the filtered pool, one compact line per track (`id | artist |
  title | genre | year | bpm`), plus the instructions and set definitions. Ask for strict JSON:
  `{ sets: [{ name, trackIds[] }] }`.
- Works with every backend, including **Manual** (copy/paste), like AI Clean does.
- Parse the reply with **only ids from the pool**. Drop and report unknown ids, because the AI must never
  invent tracks (the owner's v0.14 "no guessing" rule).
- If the pool is too large for one prompt, warn the user and suggest tighter filters.
  Don't silently truncate.

**D6. "Suggested to add."**
- Ask the AI for a separate list of songs that would fit but aren't in
  the Library. Show it as a list of "Artist – Title" the user can send straight into the
  existing typed-song YT import flow, to search and download. Label these clearly as AI suggestions,
  not Library tracks.

**D7. Output.**
- One tab per set, editable (reorder with up/down buttons, remove, add from
  the search dock), and right-click from C.
- Export each set as `.m3u8` / Rekordbox XML with the existing exporters, named
  `<Playlist> - 1 Warm-up` and so on.
- Save the session like YT imports so it can be reopened.

**Verify:** run it against the real Collection with Claude CLI and Manual. Every returned
track must exist in the Library, the sets must respect the counts, and the exports must open in
Rekordbox.

---

## Workstream F: model and effort per AI task (Claude CLI backend)

**Verified facts (2026-10-02):**
- The app passes **no model and no effort** when `settings.claudeModel` is empty,
  which is the owner's current setting (`claude_cli.rs:205`, `useAI.ts:221/263`).
  The CLI then uses the owner's own Claude Code settings: `~/.claude/settings.json` has
  `"model": "sonnet"` and `modelSettings.effortLevel: "low"`. So AI Clean runs on Sonnet at low effort today,
  but only by accident. Changing the Claude Code default silently changes the app too.
- The CLI supports `--model <alias|full id>`, `--effort <level>` and
  `--fallback-model <model>` (checked with `claude --help`).
- `emit_usage` (`claude_cli.rs:251`) labels the call with the **first** key of
  `modelUsage`. The CLI can list a small helper model (Haiku) next to the main
  one, so the usage dashboard may show the wrong model.

**F1. Per-task settings.** Replace the single `claudeModel` with a model + effort pair for each task
(bump `CURRENT_SETTINGS_VERSION` and migrate: a non-empty old `claudeModel` becomes the Clean model):

| Task | Default model | Default effort | Why |
|---|---|---|---|
| AI Clean (artist/title/year/genre) | `sonnet` | `low` | Needs factual recall (original release year, main artist), and wrong answers get written into files. Low effort keeps it fast |
| AI playlists (D) | `sonnet` | `medium` | Needs judgment on energy/flow across hundreds of tracks |

- Model dropdown: Haiku / Sonnet / Opus / "Claude Code default" (sends no flag,
  which is today's behaviour) / Custom (free text, for a full model id).
- Effort dropdown: low / medium / high / "default". **Disable it when Haiku is selected**,
  because Haiku 4.5 has no effort setting.
- Hint under the playlist row: "Opus gives better sets but uses your plan's usage
  faster."

**F2. Pass them through.** `run_prompt` takes `effort: Option<&str>` and adds
`--effort <level>` when it's set, the same way `--model` works. `claude_clean_batch` and
the new playlist command each pass their own task's pair. Add a Rust test
for the argument building (empty → no flag).

**F3. Correct usage labels.** In `emit_usage`, pick the `modelUsage` entry with
the most output tokens, not the first key. Optionally keep the per-model
breakdown in the Logs page.

**F4. Fewer tokens without lowering quality** (cheaper than switching to a smaller model):
- AI playlists send one compact line per track (`id | artist | title | genre | year |
  bpm | key`), never full tag dumps, and only the filtered pool (D2).
- AI Clean keeps batching (`batchSize` 50). Check the prompt doesn't repeat
  per-track boilerplate.
- Show tokens per run in the result toast so the owner can compare settings.

**Verify:** run AI Clean on the same 50 tracks with Haiku, Sonnet/low and Sonnet/medium.
Compare the changed rows and tokens, and record the result in the ROADMAP entry. Confirm that
`--effort` actually reaches the CLI (log the full command line in the debug log).

## Order and size

| # | Workstream | Size |
|---|---|---|
| 1 | E: Settings black screen + error boundary | S |
| 2 | A: Permanent Library (fixes the lost genres) | M |
| 3 | B: Remove Genre button | S |
| 4 | C: Right-click open everywhere | S–M |
| 5 | F: Model + effort per AI task | S |
| 6 | D0: Rekordbox BPM/key into the Library | M |
| 7 | D: AI playlists from the Library (tab on the YT import page) | L |

After each one: `npm test`, `cargo test`, `npm run build`, add a ROADMAP entry, and bump to v0.15.0 at the end.

## Owner's answers (2026-10-02): decisions, don't re-ask

1. **The Library folder is `C:\Users\sopas\Music\Collection`**, and it's the only one for now.
   The A1 migration and the first-run prompt default to it. Keep it a single-folder setting
   with no multi-root UI.
2. **Remove the toolbar "Genre" button.** Confirmed: do workstream B as written.
3. **Right-click: ship both** "Open" (default player) and "Add to working batch".
   The owner will try them and decide what stays.
4. **The AI playlist builder is a new tab/mode on the YouTube Music import page**,
   next to the link / typed-songs input. It is not a separate page.
5. **BPM and key come from Rekordbox's data**, not the file tags. See D0.

## Workstream D0 (before D): Rekordbox BPM/key into the Library

- Verified: the app already parses a **`rekordbox.xml` collection export**
  (`rekordbox_import.rs`, which reads `AverageBpm` around line 141 for cue import).
  It doesn't read `Tonality` (the key) yet. Rekordbox's live `master.db` is
  SQLCipher-encrypted, so stay away from it and use the XML export instead.
- Settings → Library card: "Rekordbox XML: <path> [Choose…] [Re-import]",
  remembered in settings with a migration. Hint text: "In Rekordbox: File → Export
  Collection in xml format".
- For each `TRACK`, read `Location` (a file:// URL, decoded to a Windows path),
  `AverageBpm` and `Tonality`. Store them in a new `rekordbox_track` table in
  `library-index.sqlite` (path, bpm, key, imported_at). Join to `library_track`
  on the normalized path, case-insensitive. Report "N of M Library tracks have
  Rekordbox BPM/key" so mismatches are visible instead of silently missing.
- Add BPM and Key as optional columns in the track table and the search dock.
- The D2 BPM-range and key filters use this data. Tracks without Rekordbox data show as
  "no BPM", and a toggle includes or excludes them.
- Re-import on demand. Also re-import automatically at launch if the XML file's mtime changed.
