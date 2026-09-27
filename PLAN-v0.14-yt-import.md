# Plan — v0.14.0: YouTube-import metadata, library labels, list import, horizontal wheel

Hand-off plan for an implementing agent. Read `CLAUDE.md` first (stack, commands,
hard-won rules). Do **not** read ROADMAP.md whole — grep its headings.

Work on a new branch `v0.14-yt-import` off `master`. One commit per workstream
(A, B, D, C, in that order). Don't push, tag or release without the owner saying so.

The owner's rule for this whole batch: **no guessing.** Every artist/title/album the
UI shows must come from real data (YouTube Music metadata or the file's tags). If
the data isn't there, say so plainly — never derive an artist from splitting a title
or from a channel name.

---

## Verified facts (checked 2026-09-27, don't re-derive)

- The owner's saved session "(Dance) Wedding Music" (`import_session` table in
  `%APPDATA%\com.sopas.musictagcleaner\library-index.sqlite`) has **every entry with
  `uploader: null` and `artist: null`**. `yt-dlp -J --flat-playlist` on a
  `music.youtube.com` playlist does not return artist/channel. That is the whole
  reason for "No channel name from YouTube" on almost every row.
- Row "Pain)" is entry title `Low (feat. T-Pain)`. `splitArtistTitle()`
  (`src/lib/ytMatch.ts:75`) splits on the first `-`/`–`/`—`/`:` **with no spaces
  required** (`/^(.{1,80}?)\s*[-–—:]\s*(.{1,120})$/`), so it produced
  artist `Low (feat. T`, title `Pain)`.
- A **full** (non-flat) extraction of one video returns exactly what YouTube Music
  shows. Tested with the bundled-by-mediafetch yt-dlp 2026.07.04:
  `yt-dlp -j --skip-download https://music.youtube.com/watch?v=uUL8a7eJCk8` →
  `title/track: "Low (feat. T-Pain)"`, `artists: ["Flo Rida","T-Pain"]`,
  `artist: "Flo Rida, T-Pain"`, `album: "Mail on Sunday"`, `release_year: 2007`,
  `channel/uploader: "Flo Rida"`. Took **~3.7 s** for one video.
- YouTube Music's own UI shows: title `Low (feat. T-Pain)`, second line
  `Flo Rida • Mail on Sunday • 2008`. So **artist = `artists[0]`**, title is the
  YouTube title untouched.
- `find_ytdlp()` (`ytmusic.rs:91`) prefers `<app_data>/bin/yt-dlp.exe` (not present
  on the owner's machine), then PATH. On PATH the owner has pip's yt-dlp
  2026.06.09, which works. An old 2024.10.07 copy exists under
  `%APPDATA%\DeeKeep\` and fails with "Precondition check failed". It's not on
  PATH, so it isn't picked up, but see A6.
- The library index **does** contain the matched tracks with correct tags, e.g.
  `C:\Users\sopas\Music\Collection\Flo Rida - Low - 001908.mp3` → title `Low`,
  artist `Flo Rida`. Index root is `C:\Users\sopas\Music\Collection` (4149 tracks).
  Yet the import page rendered the **full path** as the title and `—` as the artist.
  In `trackLabel` (`YtMusicImportPage.tsx:176`) that only happens when the path is
  in neither `tags` nor `fileByPath`. Also, one matched path
  (`C:\Users\sopas\Music\Macklemore N Ryan Lewis - White Walls - 002468...`) is
  **outside** the index root: it came from files opened in an earlier session and
  now lives only in the saved session's `overrides`. The root cause of the Flo Rida
  case is **not yet confirmed**. See B1.
- Clicking a matched library track calls `onInspect` (`App.tsx:2010`), which only
  works for files in `filesApi.files`. `inspect()` (`App.tsx:1863`) also needs
  `libraryTags[path]`. Indexed-only tracks hit the toast "That track is in the
  index but not loaded — open its folder to inspect it".
- Horizontal wheel handler: `TrackTable.tsx:1084–1127`. There have been three prior
  "fixes" (ROADMAP item 42, v0.11.4, commit `dba4b93`), and the bug was never
  reproduced by the agent. ROADMAP item 42 documents that a tilt over an
  **unfocused** webview arrives as a `wheel` event with all deltas = 0.

---

## A. Real YouTube Music metadata (no guessing)

### A1. Rust: `enrich_ytmusic_entries` command (`src-tauri/src/commands/ytmusic.rs`)
- New `#[tauri::command] async fn enrich_ytmusic_entries(app, video_ids: Vec<String>) -> Result<(), String>`.
  Register it in `src-tauri/src/main.rs` next to `fetch_ytmusic_playlist`.
- For each id, run `yt-dlp -j --skip-download --no-warnings --no-playlist
  https://music.youtube.com/watch?v=<id>` (use `hide_console`). Run **4 in
  parallel** (a small worker pool over `spawn_blocking`, or `std::thread` +
  channel). Don't pass the whole list to one process: yt-dlp extracts
  sequentially.
- Parse into a new struct:
  ```rust
  pub struct EntryMeta {
      pub video_id: String,
      pub title: Option<String>,        // "track" if present, else "title"
      pub artists: Vec<String>,         // "artists" array; else split "artist" on ", " ONLY as a fallback when the array is absent
      pub album: Option<String>,
      pub year: Option<i32>,            // "release_year", else first 4 chars of "release_date"/"upload_date"
      pub channel: Option<String>,      // "channel" / "uploader", " - Topic" stripped
      pub duration_secs: Option<f64>,
      pub error: Option<String>,        // last stderr line on failure
  }
  ```
- Emit each result as it finishes: `app.emit("ytmusic-entry-meta", &meta)`.
  Also emit progress `{done, total}` on `"ytmusic-enrich-progress"`. The command
  returns when everything is done.
- **Cache** results in a new table in the same sqlite that holds `import_session`
  (`yt_entry_meta(video_id TEXT PRIMARY KEY, json TEXT, fetched_at INTEGER)`).
  Add the migration where that DB's schema lives (`library_index.rs`). Before
  spawning yt-dlp, emit cached rows immediately and only fetch the misses.
  Don't cache failures.
- Add `pub fn cached_ytmusic_meta(video_ids) -> Vec<EntryMeta>` as a command too,
  so a restored session can paint instantly with no network.
- Support cancel: a `cancel_ytmusic_enrich` command that sets an `AtomicBool`
  checked between videos (the user may fetch another playlist mid-run).
- Tests (pure parsing, no network): add a `parse_video_json(raw) -> EntryMeta`
  function and fixture-test it with the JSON shape above: `artists` array present;
  only `artist` string present; only `uploader: "X - Topic"`; nothing at all.

### A2. TS types (`src/types.ts`)
- Extend `PlaylistEntry` with optional `artists?: string[]`, `album?: string | null`,
  `year?: number | null`, `metaStatus?: "pending" | "done" | "failed"`.
  Add an `EntryMeta` type mirroring Rust (camelCase).

### A3. Matcher (`src/lib/ytMatch.ts`)
- **Delete the title split from display and artist resolution.** In `buildWanted()`:
  - `title` = `entry.title` (after `stripTitleNoise` only for *matching*, not
    display).
  - `artist` = `entry.artists?.[0]` → else `entry.artist` (existing field) → else
    `null`. **Remove the `split.artist` and `channelGuess` branches.**
  - Make `ArtistSource` just `"metadata" | null`, or remove it. Update the UI that
    reads it.
- Matching may still *use* the parsed title internally as an extra comparison
  string (e.g. keep `rawP`), but it must never be shown or treated as the artist.
  Keep `splitArtistTitle` only if the matcher's scoring needs it, and make its
  regex require whitespace around the separator (`\s+[-–—]\s+`; drop `:`), so
  `T-Pain`, `Jay-Z`, `A-ha`, `Ne-Yo` survive.
- When `artists` has several names, the combined matching string should use
  `artists[0]` only. Featured artists are already in the title.
- Tests in `src/lib/ytMatch.test.ts`:
  - `Low (feat. T-Pain)` + `artists ["Flo Rida","T-Pain"]` → artist `Flo Rida`,
    title `Low (feat. T-Pain)`, and it matches a library file tagged
    `Flo Rida / Low`.
  - The same entry with **no** metadata → artist `null`, title unchanged (not
    `Pain)`).
  - `Jay-Z`, `A-ha - Take On Me` (if the split is kept for scoring: splits into
    `A-ha` / `Take On Me`, never into `A` / `ha - Take On Me`).
  - Update any existing tests that asserted channel-guess behaviour.

### A4. Import page (`src/pages/YtMusicImportPage.tsx`)
- After `fetchPlaylist` succeeds (and after a session restore), call
  `cached_ytmusic_meta` for all ids, then `enrich_ytmusic_entries` for entries
  with no metadata yet. Listen on `ytmusic-entry-meta` and merge each result into
  `playlist.entries` by `videoId`. Batch the `setPlaylist` updates (e.g. flush
  every 250 ms) so re-matching doesn't run 100 times.
- **Replace** the existing "reconcile channel names" effect (the one around lines
  228–260 that re-runs the flat fetch). It can never succeed for music.youtube.com.
- Row display (left column, around line 960–975):
  - Line 1: `entry.title` exactly as YouTube has it.
  - Line 2: `Artist • Album • Year`, skipping missing parts. While
    `metaStatus === "pending"`, show a small muted "Loading from YouTube Music…".
    If `failed`, or done with no artist: muted **"Artist unknown on YouTube"**
    (no channel name, no guess).
  - Remove the "No channel name from YouTube" string and any "(channel)" flag UI.
- Show a thin progress line above the list while enrichment runs
  ("Reading track details from YouTube Music — 23 / 96").
- Persist the enriched fields in the saved session payload (they're on the
  entries, so this should already happen; verify).
- `ytMatchLog.ts`: include `artists`, `album` and `year` per entry in the exported
  log.

### A5. "Still to get" / Copy All Links
- Copied text should use the real artist when known: `Flo Rida - Low (feat. T-Pain) <url>`,
  else `Low (feat. T-Pain) <url>`.

### A6. yt-dlp version guard
- In `ytdlp_info`, parse the version (`YYYY.MM.DD`). If older than ~6 months,
  show a warning on the import page and on the Components page: "Your yt-dlp is
  from 2024-10 — YouTube often breaks old versions. Update". The button reuses
  `install_ytdlp`, which installs into `<app_data>/bin` and then wins in
  `find_ytdlp`. Don't auto-install without a click.

**A acceptance:** fetching the owner's wedding playlist shows `Low (feat. T-Pain)`
with `Flo Rida • Mail on Sunday • 2007` under it, and no row says "No channel name".
Re-opening the page later paints the metadata instantly from cache. `npm test` and
`cargo test` pass.

---

## B. Matched library tracks show Artist – Title, and open without the "not loaded" toast

### B1. Find the real cause first (don't skip)
Run `npm run tauri dev`, open the YouTube-import page (the wedding session restores
automatically), and in the devtools console or a temporary `console.log` check,
for the path `C:\Users\sopas\Music\Collection\Flo Rida - Low - 001908.mp3`:
- Is it in `files` (the `wholeCollection.files` prop)? Is it in `tags`?
- If not: is `libraryIndex` loaded yet (`useLibraryIndex` → `library_tracks`)? Is
  the path string byte-identical (case, slashes, trailing spaces, Unicode
  apostrophes) to the index row?

Write down the finding in the ROADMAP entry. Candidates: the index failed to load
(`refreshTracks` catches and sets `[]` silently); the override path differs in case
or slashes; the page memoized before the index arrived.

### B2. Fix whatever B1 finds, plus make it robust regardless
- Normalize path comparisons on Windows: build `fileByPath` and the tags lookup
  keyed by a `normPath(p)` (lower-case + backslashes) and look up with the same
  function. Keep original paths for display and invokes.
- If `refreshTracks` fails, `notify` the error (silent log entry) instead of
  swallowing it.
- **On-demand tags for paths not in the collection** (like the White Walls file
  outside the index root): collect the missing paths from the currently shown
  matches, call the existing `read_tags_batch` command (`files.rs:425`), and keep
  a local `extraTags` map in the page. If the file no longer exists, show the row
  as **"File missing"** with the path in the tooltip, and treat it as unmatched
  for export.
- `trackLabel` fallback order: tags title/artist → the `extraTags` result →
  **basename without extension** (never the full path). The full path goes only in
  the `title=` tooltip.

### B3. Inspect indexed tracks directly
- Change `onInspect` in `App.tsx:2010` to handle paths not in `filesApi.files`:
  build the `AudioFile` from `wholeCollection.files` (or `indexedToFile`), load the
  full tags with `read_tags_batch([path])` (the index lacks `allFields`), then
  `setInspected({file, tags})`. Delete the "in the index but not loaded — open its
  folder" toast.
- Check that the inspector's edit/save path works for a file that isn't in the
  session table. After a save, the index row for that file should refresh (call the
  index's incremental update for that path, or `libraryIndex.refresh()`). If saving
  from there is too tangled, open the inspector read-only for indexed-only files
  and say so. Don't bring back the "open its folder" toast.

**B acceptance:** every matched row's right side reads `Low` / `Flo Rida` (tag
title / artist), never a path. Clicking it opens the inspector.

---

## D. Horizontal wheel in the library table — diagnose, then fix

The previous three attempts guessed. This time, collect evidence first.

### D1. Ask the owner (before coding D)
- What exactly happens: nothing at all / moves then snaps back / only works after
  clicking the table / too slow?
- Mouse model, and whether Logitech Options+ (or similar) with smooth scrolling is on.

### D2. Diagnostic switch
- Settings → (Advanced or Logs section) toggle **"Log wheel events"**. Keep it in
  memory only, or add it as a setting (if so, bump `CURRENT_SETTINGS_VERSION`
  and add a migration in `src/hooks/useSettings.ts`).
- When on, the `TrackTable` wheel handler logs every event via
  `notify(..., "info", { silent: true, details })` with: `deltaX`, `deltaY`,
  `deltaMode`, `shiftKey`, `wheelDeltaX` (legacy), `target` tag/class,
  `document.hasFocus()`, `el.scrollLeft` before and after, `scrollWidth`,
  `clientWidth`, and whether it returned early (and at which guard). Throttle to
  at most ~20 entries per second.
- The owner tilts the wheel over the table a few times (focused and unfocused)
  and copies the Logs page.

### D3. Fix per evidence
- **All deltas 0 / `hasFocus()` false:** handle `WM_MOUSEHWHEEL` on the Rust side.
  Subclass the main window (Windows only, `windows`/`windows-sys` crate,
  `SetWindowSubclass`), read the signed delta from `HIWORD(wParam)`, and
  `emit("native-hwheel", delta)`. The TS side applies it to the table under the
  cursor (hit-test with `document.elementFromPoint` and the last known pointer
  position). Or, simpler if it works: on `pointerenter` of the table call
  `window.focus()` / `getCurrentWindow().setFocus()`. Try the simple one first
  and check it with the logs.
- **Moves then snaps back:** make sure `preventDefault` runs for every event of
  the burst (it already does). Also set `overscroll-behavior-x: contain` and
  `scroll-behavior: auto` on the scroller. If Chromium's smooth scroll still
  fights it, accumulate deltas and apply them in one `requestAnimationFrame`.
- **Pointer over the sticky header / below the last row / virtualization spacer:**
  the `el.contains(target)` guard fails if any of these render outside
  `scrollRef`. Widen the hit area to the table's whole wrapper.
- **Too slow:** `deltaMode` 1 → use ~40 px per line, not 16.

### D4. Share it
- Move the handler into `src/hooks/useHorizontalWheel.ts(ref)` and use it in
  `TrackTable`, `PreviewTable` (`src/components/PreviewTable.tsx:79`) and the YT
  import list's scroller.
- Remove the diagnostic switch, or leave it off by default and document it in the
  ROADMAP entry.

**D acceptance:** the owner confirms the tilt wheel scrolls the library table
sideways without clicking first. The agent can't verify this alone. Say so in the
report instead of claiming it's fixed.

---

## C. Import from a list of links and/or a written song list

### C1. Input
- Replace the single URL `<input>` on the import page with a multi-line
  `<textarea>` (still accepts one playlist URL, so nothing changes for the old flow).
  Placeholder:
  ```
  Paste a YouTube / YouTube Music playlist, video links (one per line),
  or just song names:
  Flo Rida - Low
  Bad Romance by Lady Gaga
  ```
- "Load .txt / .csv" button (Tauri dialog; read the file's text, same parser).

### C2. Parsing (`src/lib/ytListInput.ts`, pure + Vitest tested)
`parseImportInput(text) -> Array<{kind:"playlist",url} | {kind:"video",url,videoId} | {kind:"text",line,raw}>`
- Trim; skip blank lines and `#` comments.
- URLs: `list=` param → playlist (if it also has `v=`, treat it as a playlist);
  `watch?v=`, `youtu.be/<id>`, `music.youtube.com/watch?v=`, `shorts/<id>` → video.
- Strip list numbering (`1.`, `01)`, `3 -`, `- `, `• `) and trailing durations
  (`3:45`).
- CSV: if the first line has a comma or tab and a header like
  `artist,title` / `title,artist`, map the columns. Otherwise treat each line as
  text.
- Written lines stay as the user wrote them. **No artist/title splitting for
  display.** For matching, the whole line is compared against library tags and
  filenames (the matcher already scores a combined string; add an entry type
  whose `combinedP`/`rawP` is the line).

### C3. Fetching
- Playlists: existing `fetch_ytmusic_playlist`, entries concatenated in input
  order, de-duplicated by `videoId`.
- Videos: new `fetch_ytmusic_videos(ids)` can simply reuse A1's per-video
  extraction (same parser, same cache, same events), producing `PlaylistEntry`s
  with full metadata.
- Text lines: become entries with `videoId = "text:<hash of line>"`, `url = ""`,
  `title = line`, `source: "text"`. Add `source?: "youtube" | "text"` to
  `PlaylistEntry`. They go through the matcher and review UI as usual (confirm /
  deny / search dock / "Still to get").

### C4. "Find on YouTube" for text lines
- Rust command `search_ytmusic(query) -> Vec<EntryMeta>` using yt-dlp's search:
  `yt-dlp -j --skip-download --no-warnings "https://music.youtube.com/search?q=<urlencoded>#songs" --playlist-items 1:3`
  (verify this URL form works; fallback `ytsearch3:<query>` against regular
  YouTube). Use the same parser and the same cache (keyed by video id).
- **Default: on click only** (per-row button + a "Find all on YouTube" button for
  the whole list). The owner hasn't picked auto vs manual. Ask them. If they want
  auto, run it in the background for text rows only, 4 at a time.
- Results show as candidates in the row. Picking one fills in the YouTube link,
  title, artist and album, so "Still to get / Copy All Links" works for those rows
  too. Nothing is picked automatically.

### C5. Sessions
- Session key for non-playlist input: `list:` + short hash of the normalized input
  text. Title = first playlist title if there is one, else "Pasted list (N tracks)".
- Store the original input text in the payload (`payload.sourceText`), so
  **Re-match** and re-fetch work, and the textarea is refilled on restore.
- Existing sessions (single playlist URL) must restore unchanged.

**C acceptance:** pasting two video links, one playlist URL and three typed song
names produces one combined list. The typed rows match library files when they
exist. "Find on YouTube" gives a typed row a real link and artist. Everything
survives leaving and returning to the page.

---

## Cross-cutting rules
- No drag gestures in the import page (see CLAUDE.md).
- Every yt-dlp call goes through `find_ytdlp` + `hide_console`, with
  `--no-warnings`, and never downloads media.
- Large playlists (300+) must stay responsive: batch state updates, don't
  re-match per event, and keep the row list virtualized if it isn't already
  (reuse `useVirtualRows`).
- `notify` errors with `details` so they're copyable from the Logs page.

## Verification checklist (report each honestly)
- `npm test`, `cargo test` (in `src-tauri/`), `npm run build`: all green.
- `npm run tauri dev` click-through on the owner's wedding session: A and B
  acceptance criteria. If the agent can't drive the app UI, say so explicitly and
  list what the owner should click.
- D needs the owner's hardware. Report it as "diagnostic shipped / fix pending
  confirmation" until they confirm.

## Wrap-up
- Bump version to **0.14.0** in `package.json`, `src-tauri/tauri.conf.json`,
  `src-tauri/Cargo.toml`.
- Append ROADMAP.md section(s) in the house style (what / why / how verified).
  Include the B1 root-cause finding and the D2 log findings. The release notes
  should also cover the unreleased backlog commits already on master since v0.13.2
  (Track ID migration, casing exceptions, algo_version stamp, hover-dwell
  debounce, standardize tests). The owner asked for those to go into the next
  feature release.
- Don't tag or push. Leave that to the owner.
