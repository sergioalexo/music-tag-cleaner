# MusicTagCleaner — fix roadmap

Running list of known issues and their status. Add new items under **Backlog**.

## Done

### 1. Standardize capitalization mangled titles
`Capitalization → Aa` used English/Chicago "title case" rules: small words
(`in`, `of`, `the`, `and`, …) were forced lowercase mid‑title, so
`Rivers Flow In You` became `Rivers Flow in You`. The same function also
flattened acronyms (`DJ Snake` → `Dj Snake`), broke hyphenated words
(`Rock-N-Roll` → `Rock-n-roll`), and lower‑cased roman numerals
(`Part III` → `Part Iii`).

**Fix** (`src/lib/standardize.ts`): the `Aa` mode now simply **capitalizes the
first letter of every word** — no small‑word rule. Also:

- letter runs split on spaces, `-` and `/` (`ac/dc` → `Ac/Dc`, `rock-n-roll` → `Rock-N-Roll`)
- an already-uppercase roman numeral I–XX is preserved (`Part III` stays `Part III`,
  not `Part Iii`)
- mixed‑case initialisms are kept (`DJ Snake` stays `DJ Snake`)
- an all‑caps run reading as an initialism is kept (`MGMT Kids` → `MGMT Kids`),
  but a shouted ordinary word is normalized (`LOVE` → `Love`)
- a fully‑shouting value is fully recased (`RIVERS FLOW IN YOU` → `Rivers Flow In You`)

The Settings tooltip for `Aa` is now "Capitalize Each Word".

**Known limitations** (candidates for a future "casing exceptions" setting):
- lowercase initialisms can't be detected — `dj snake` → `Dj Snake`
- Irish/Scots names — `O'Brien` → `O'brien`, `McFly` → `Mcfly`
- a value that is *only* `AC/DC` or `MGMT` is treated as shouting → `Ac/Dc`, `Mgmt`
- `feat.` / `ft.` are capitalized like any other word

### 2. Editing a field cleared the row selection
Double‑clicking a cell to edit fired the row's `click` handler first, which
collapsed a multi‑row selection to just that row — so the edit only applied to
one track even though `targetPaths()` is built to fan an edit out across the
selection.

**Fix** (`src/components/TrackTable.tsx`, `handleRowClick`): a plain click on a
row that is already part of a multi‑row selection now leaves the selection
intact (only the anchor moves). To drop one row from the selection, Ctrl+click
it. Clicking a row outside the selection still collapses to that row.

### 3. "All Tags" view duplicated Title / Artist / Year etc.
The `All Tags` toggle added one column per raw tag frame in the file, but did
not skip the raw frames that the curated columns already show — so `TrackTitle`
appeared next to `Title`, `TrackArtist` next to `Artist`, `Year`/`RecordingDate`
next to `Year`, and so on, all with identical values.

**Fix** (`src/components/TrackTable.tsx`, `extraColumns`): raw keys in
`KEPT_FIELD_KEYS` are now skipped, matching what the strip preview already does.
`All Tags` now shows only the *extra* frames (Publisher, ISRC, encoder info,
MusicBrainz IDs, `TXXX:*`, …).

### 4. Clear Fields — pick fields per run, remember the choice, allow raw fields
The Clear Fields target list used to be editable only in Settings
(`settings.clearFields`, curated fields only).

**Fix:**
- The toolbar **Clear Fields** button is now a split button
  ([ClearFieldsMenu.tsx](src/components/ClearFieldsMenu.tsx)): the left half
  runs immediately with the remembered set; the caret opens a checklist.
- The checklist offers the curated `CLEARABLE_FIELDS` **and** the raw frame
  keys present on the current selection (`allFields` minus `KEPT_FIELD_KEYS`,
  the backup blob is already excluded from `allFields` by the reader).
- Running it persists the chosen set to `settings.clearFields` — that becomes
  the default for next time. Raw entries are stored with a `raw:` prefix.
- `buildClearPreview` resolves a `raw:` entry against `allFields[key]`;
  `applyUpdates` clears a raw frame by dropping it from the `keepExtra`
  carry-over list (`PendingChange.raw` marks those rows).

Touched: `types.ts`, `hooks/useTags.ts`, `App.tsx` (`runClearFields`),
`pages/LibraryPage.tsx`, new `components/ClearFieldsMenu.tsx`.

### 5. Raw ("All Tags") columns: header text spilled over, couldn't resize
Dynamic columns had a fixed 140px width that `widthOf()` refused to override,
so their resize handle wasn't even rendered; and the header `<th>` used
`whitespace-nowrap` with no clipping, so long raw key names
(`MusicBrainzReleaseGroupId`, …) painted over the next column.

**Fix** (`src/components/TrackTable.tsx`):
- `widthOf()` now reads `columnWidths[c.id]` for every column, dynamic
  included (dynamic ids are `extra:<key>`, so a resized width persists).
- The resize handle renders on dynamic headers too.
- Header label sits in a `min-w-0 flex-1 truncate` span inside an
  `overflow-hidden` flex row, so it ellipsises within the column instead of
  overflowing; the toggle, `(Backup)` badge and sort caret are `shrink-0`.

### 6. Row checkboxes painted over the sticky header when scrolling
The `<thead>` and the sticky first-column `<td>` cells both had `z-10`, so on
scroll the later-in-DOM body checkboxes drew on top of the header's
"check all" box.

**Fix** (`src/components/TrackTable.tsx`): `<thead>` is now `z-20` and its
sticky corner `<th>` `z-30`; body sticky cells stay `z-10`.

### 7. "Rename to Standard" appended " (2)" to files with no duplicate
`rename_file_blocking` guarded only against a byte-identical target path, then
looped `while target.exists()` appending " (2)", " (3)", …. On Windows/macOS
(case-insensitive volumes) a tag casing that differed from the on-disk name —
`bonobo - kerala.mp3` on disk, `Bonobo - Kerala` from the tags — made
`target.exists()` true against the file *itself*, so it renamed to
`Bonobo - Kerala (2).mp3`.

**Fix** (`src-tauri/src/commands/files.rs`): the collision loop now skips a
candidate that `canonicalize()`s to the source file, so a case-only /
normalization-only rename applies cleanly with no suffix.

### 8. Ctrl+A ticked every checkbox instead of just selecting
`Ctrl+A` called `filesApi.setAll(true)`, ticking every row. It now highlights
every visible row (the `rowSel` selection) without ticking; `Space` then ticks
the highlighted rows. Handled in `TrackTable`'s key handler; removed from
`App.tsx`. Shortcut relabelled "Highlight all tracks".

### 9. Track ID moved out of Track Number
"Generate IDs" wrote a 6-digit sequential id into **Track Number** (`TRCK`),
which Rekordbox/Serato use for album & playlist track position — so the id
clobbered real metadata.

**Fix:** the id now lives in its own field, `TagData.trackId`, stored in a
private `TXXX:TRACKID` frame (`ItemKey::Unknown("TRACKID")` — TXXX on
ID3, `TRACKID` in Vorbis, freeform atom on MP4), and shows as its own
**Track ID** column. Track Number is left untouched. `isUid` /
`buildRenameStem` (rename-to-standard) and Clear Fields now target `trackId`.
Settings migration v4 inserts the new column after Track Number.

**Existing libraries:** ids already written into Track Number by older builds
stay there — clear that column with **Clear Fields → Track #**, or re-run
**Generate IDs** (which now fills Track ID) and clear Track Number after.

Touched: `models.rs`, `commands/files.rs` (read/write + `TRACK_ID_FIELD`),
`types.ts` (`TagData`, `FIELD_LABELS`, `CLEARABLE_FIELDS`, `KEPT_FIELD_KEYS`),
`hooks/useTags.ts`, `hooks/useSettings.ts` (defaults + v4 migration),
`components/TrackTable.tsx` (`ALL_COLUMNS`), `pages/SettingsPage.tsx` (hint).
Rust tests added for the rename `(2)` fix (`commands/files.rs`).

### 10. Standardize / compress embedded cover art
New **Standardize Art** toolbar button: for every selected file it re-encodes
the embedded cover to **JPEG** and scales the longest side down to a target
(default **1000 px**, never upscaled) at a set **JPEG quality** (default 85).
Both configurable under Settings → "Standardize Art — max size / JPEG quality".

- Skips files with no art, and JPEGs already within bounds that a re-encode
  wouldn't shrink by >10% (no needless generation loss).
- Non-JPEG covers (PNG/…) are always converted.
- Each change goes through the existing `__coverArt` undo/redo history with the
  original bytes stored, so **Undo restores the exact original losslessly**.
- Uses the `image` crate (already a dependency). Pixel pipeline is
  `recompress_cover()` in `commands/files.rs`, covered by `cargo test`.

Touched: `models.rs` (`ArtworkChange`), `commands/files.rs` +
`main.rs` (`standardize_artwork` command), `types.ts` / `useSettings.ts`
(2 settings), `App.tsx` (`standardizeArtwork`), `LibraryPage.tsx` (button),
`SettingsPage.tsx` (2 rows).

### 11. "Open with MusicTagCleaner" from Windows Explorer
The installer now registers the app for `.mp3 .flac .ogg .aac .m4a .wav .aiff
.aif` (`bundle.fileAssociations` in `tauri.conf.json`) so it shows up under
Explorer's **Open with**. The app handles being launched with file/folder
arguments:

- `tauri-plugin-single-instance` (registered first) — selecting N files spawns
  N processes; the first opens the app, the rest push their paths onto a shared
  queue and nudge the running window, then exit.
- `openable_paths()` in `main.rs` keeps only audio files / folders from argv.
- `take_opened_files` command drains the queue; the UI calls it on mount, on
  the `open-files` event, and twice more (800 ms / 2.5 s) to catch the launch
  burst, then feeds the paths through the normal `importPaths`.

Does **not** make the app the default handler — just adds it to "Open with".

### 12. Opening ~400 files froze the app
Two causes:

1. `useCovers` fetched the **full-resolution** embedded art for *every* file and
   `setCovers`'d once per file — for 400 files that's hundreds of MB of base64
   held in one state object cloned 400× and 400 whole-table re-renders.
   **Fix:** new `read_cover_thumbnail` command returns a ~128 px JPEG
   (~3 KB); `useCovers` uses it and flushes state in batches of 20.
2. `scan_folder` / `list_files` / `import_paths` / `read_tags_batch` each did
   one sequential `lofty` parse per file. **Fix:** `par_map()` in `files.rs`
   spreads the parses across up to 8 threads for inputs > 16.

### 13. Track table row virtualization
The table now renders only the rows near the viewport, with spacer `<tr>`s
standing in for the rest (`src/hooks/useVirtualRows.ts`). Fixed-height
windowing: row height is measured from a real rendered row (so it tracks the
row-height setting and zoom), `overscan` 8. Kicks in above 60 rows; at or
below that everything renders as before. Search jump (`goToMatch`) scrolls by
computed index so it can reach rows that aren't currently mounted. The
spacer-row technique keeps `<colgroup>` widths, `table-layout: fixed`, the
sticky header and sticky first column all working; verified in Chromium that
an empty `<td colSpan height>` takes the requested height.

## Backlog

- Optional one-click "move Track Number ids into Track ID" for pre-v4
  libraries (use `isUid()` to pick which Track Number values are app ids).
- `useImageInfo.fetchOne` fires on every row `onMouseEnter` (for the thumbnail
  tooltip) — a fast mouse sweep over a big list queues hundreds of image
  decodes. Debounce / hover-dwell, or drop the per-row size tooltip.
- `file_info` does a full tag parse just for `hasBackup` + `duration`; making
  those lazy would make import near-instant (`fs::metadata` only).


- No automated tests for `standardize.ts` or the table selection logic — add
  Vitest and cover the cases above so they don't regress.
- Capitalization "casing exceptions" — a user-editable list of protected
  tokens (`AC/DC`, `feat.`, `McFly`, …) to override the default recasing.
- `settings.columnWidths` accumulates an `extra:<key>` entry for every raw
  field ever resized and never prunes them — harmless but untidy.
- (add items here)
