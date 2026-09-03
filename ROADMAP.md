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

### 14. No way to clear the selection (0.5.1)
After `Ctrl+A` highlighted every row there was no gesture to clear the
highlight, and the header checkbox ticked-all on the first click even when
some rows were already ticked.

**Fix** (`src/components/TrackTable.tsx`): `Escape` (with the table focused)
clears the row highlight; the header checkbox shows an indeterminate dash
when partly ticked and one click there clears every tick.

### 15. Clear Fields preview couldn't show fields with no column (0.5.2)
The inline preview only rendered the per-column checkbox + per-cell "spare
this one" checkbox for fields that had a visible column. Clearing a hidden
curated field (Comment, Composer, …) or a raw frame (Publisher, ISRC)
previewed as an empty table with just a Cancel bar.

**Fix** (`src/components/TrackTable.tsx`):
- A `previewColumns` memo adds a temporary column for any pending field with
  no column on screen — the hidden curated column from `ALL_COLUMNS`, or a
  synthesized one for a raw key. Cell and header pending lookups fall back to
  `c.rawKey`, so dynamic columns light up too.
- Every cleared field reads as a struck-through removal (`buildClearPreview`
  uses `kind: "remove"` for curated fields as well). `applyPending`'s history
  filter was widened to keep curated clears undoable despite the kind change;
  cleared raw frames stay out of history (Restore Backup reverts those).
- During a Clear Fields preview every tag column (visible ones without a
  pending change) shows a faint checkbox — ticking it adds that field to the
  clear for the previewed files.
- The temporary columns and add-boxes vanish when the preview closes.

Plus: the toolbar selection hint now mentions `Esc` clears the highlight.

### 16. "Working…" indicator so writes don't look like a freeze (0.5.2)
Only AI / artwork / backup ran a status-bar progress bar; every other write
(Apply for strip / standardize / genre / clear, Generate IDs, Rename, inline
edits, preview builds) just disabled the toolbar with no visible sign the app
was doing anything.

**Fix:** the status bar shows a spinning `Loader2` + "Working…" whenever
`busy` (or scanning / backup / AI) is set and there's no detailed progress.
`applyStrip` / `applyUpdates` now take an `onProgress` callback so **Apply**
shows "Writing N of M" with the bar; `renameSingleFile` sets `busy`.

### 17. Generate IDs (and the searchable backup, and raw-field edits) wrote nothing — v0.6
Three separate call sites wrote a private/unmapped tag key through lofty's
**checked** `Tag::insert`/`insert_text`, which internally calls
`ItemKey::re_map(tag_type)` with `allow_unknown: false` — so any
`ItemKey::Unknown` key without an entry in the format's own key map (private
frames like our `TRACKID`/`TAGBACKUP`, or an arbitrary raw "All Tags" field)
was **silently dropped before the item was even added to the tag**, with no
error anywhere. This wasn't a selection or UI problem — the write itself
never happened.

**Fix** (`src-tauri/src/commands/files.rs`): switched all three sites to
`insert_unchecked` — lofty's documented way to write `ItemKey::Unknown`
values; the format-specific writer still validates the key at actual save
time (confirmed via lofty source: ID3v2 writes it as a `TXXX` frame keyed by
description, Vorbis passes it through `verify_key`), so this doesn't bypass
real validation, only a redundant pre-check that has no entry for private
keys anyway:
- `set_text()` — fixes **Generate IDs** (Track ID silently never wrote).
- The backup-blob insert in `write_tags_blocking` and in
  `backup_file_blocking` — fixes the **searchable-backup JSON snapshot**,
  meaning **Restore Backup had nothing to restore from** for any ID3v2 file
  since this shipped. This was a real data-safety bug, not just a display one.
- `write_raw_field_blocking()` — fixes editing any raw **"All Tags"** field
  whose key isn't in lofty's built-in map.

Three Rust round-trip tests added (`track_id_round_trips_through_id3v2`,
`backup_blob_round_trips_through_id3v2`, `raw_field_edit_round_trips_through_id3v2`)
against a minimal synthesized MP3, each reproduced the bug before the fix and
passes after.

Separately, `afterWrite()` in `App.tsx` was clearing the **entire**
`libraryTags` cache on every single-track write (Generate IDs, an inline
edit, undo/redo), instead of just the touched paths — the "eagerly read
tags" effect then re-parsed the *whole library* from disk on every edit,
which on a large collection is slow enough to look like the edit did
nothing. Now only the affected paths are dropped from the cache
(`dropLibraryTags()`); `renameToStandard` remaps cached tags to the new
paths instead of wiping them, since a rename doesn't change the tags.

### 18. Column drag-reorder opened the file-drop overlay — v0.6
On Windows, Tauri's window-level `onDragDropEvent` ([App.tsx:328](src/App.tsx:328))
fires for **any** drag over the webview — not just an external OS file
drag — because it hooks WebView2's drag events at the host level. Dragging a
`<th>` to reorder a column ([TrackTable.tsx](src/components/TrackTable.tsx))
therefore also flipped `dropActive`, painting the "Drop audio files or
folders to add them" overlay mid-drag.

**Fix:** a plain module-level flag, [`src/lib/internalDrag.ts`](src/lib/internalDrag.ts),
set on the column header's `dragstart` and cleared on `dragend`; App.tsx's
listener bails out early while it's set. Reordering itself already worked
and already persisted via `settings.visibleColumns` (order *is* visibility
order) — the bug was purely the misleading overlay.

### 19. Editing a genre name didn't do what it looked like — v0.6
Two distinct paths, both fixed:
- **Settings → Genre Presets:** each genre `<input>` called `onSave` (which
  persists to the store) on every keystroke — no local draft — so editing
  felt unresponsive. Now a small `GenreRow` component
  ([SettingsPage.tsx](src/pages/SettingsPage.tsx)) holds its own draft,
  committed on blur/Enter (`Esc` reverts).
- **The inline genre dropdown's pencil-rename** (`Combobox`'s `onEditOption`,
  wired at [TrackTable.tsx:1308](src/components/TrackTable.tsx:1308)) renamed
  the *preset option* but never touched the value of the field actually being
  edited — so renaming "House Tech" to "Tech House" while editing a track's
  genre left that track showing the old name. **Fix**
  ([Combobox.tsx](src/components/Combobox.tsx)): renaming the option that
  matches the field's current value now also commits it as the new value.

### 20. Renaming a genre now offers to retag the collection — v0.6
Both rename paths above funnel through `renameGenreInPreset()` in
[App.tsx](src/App.tsx), which now — after updating the preset — counts
tracks in the loaded collection with the old genre and, if any exist, prompts
*"N tracks in the collection use 'House Tech'. Rename them to 'Tech
House'?"* via the native confirm dialog. Accepting runs the retag through the
existing `editField()` bulk-edit path, so it's a normal undoable history
entry. Scans only the loaded collection.

### 21. Version string was hardcoded — v0.6
[Sidebar.tsx](src/components/Sidebar.tsx) printed a literal `v0.1.0` while
the manifests were at 0.5.2. **Fix:** reads the real version via
`getVersion()` from `@tauri-apps/api/app` (same API `ComponentsPage.tsx`
already used for update checks).

### 22. Removed the Ollama attention dot — v0.6
The amber dot on the Components nav item appeared whenever Ollama wasn't
running, which is most of the time and isn't an error. Removed; Ollama
status stays on the Components page itself. (`Sidebar` no longer takes an
`ollamaRunning` prop.)

### 23. Artwork full screen — v0.6
Single-clicking the cover thumbnail opens a full-screen lightbox
(`ArtworkLightbox` in [TrackTable.tsx](src/components/TrackTable.tsx)):
fetches the true full-resolution embedded picture on demand via the
(already-existing but unused) `read_cover_art` command rather than the
table's small re-encoded thumbnails, fits to the window, `Esc`/click-outside
to close, Left/Right arrows step through the current sorted/filtered list,
and a caption shows the filename plus dimensions/format/size via the
existing `useImageInfo` data. A short click/dblclick timer keeps this from
firing on the first half of a double-click, which still opens the existing
"all tag fields" Inspect dialog.

### 24. Genre Mode — fast keyboard-driven genre assignment — v0.7
Toolbar toggle (`Headphones` button, [TrackTable.tsx](src/components/TrackTable.tsx))
that turns the table's own row-highlight (`rowSel`/`anchorPath`) and a single
shared `<audio>` element into a keyboard-only genre-tagging loop:

| Key | State | Action |
|---|---|---|
| `↑` / `↓` | any | Move the current row; playback keeps going |
| `Enter` | not playing | Play the current row **from its last position** |
| `Enter` | playing this row | Expand the genre picker inline, focused |
| `←` / `→` | playing, picker closed | Seek −10 s / +10 s |
| (type + `Enter`, or click an option) | picker open | Save genre → advance → old track stops, new one plays from its own resume point |
| `Esc` | picker open | Close without saving (existing `Combobox` behaviour, untouched) |
| `Space` | picker closed | Play / pause the current row |
| `1`–`9` | picker closed | Quick-tag the Nth preset genre directly, no picker, then advance |
| `Esc` | picker closed | Exit Genre Mode |

Implementation notes:
- One shared `<HTMLAudioElement>` (not a per-row player) with a
  `gmPositions` map of per-track resume seconds, kept for the session.
  Resuming the *same* track (Space pause/resume) skips the reload entirely —
  only switching tracks reloads `src` and seeks to the saved position.
- Registers with the same `takeOverPlayback`/`releasePlayback` module-level
  singleton a row's own prelisten button already used
  ([AudioPreview.tsx](src/components/AudioPreview.tsx), refactored out of
  its previous private `stopOthers` variable), so only one thing ever plays
  across the whole table.
- The keydown handling is merged into the table's existing window-level key
  handler rather than a second listener, gated the same way the rest of that
  handler already is (`e.target === document.body`) — which is also what
  makes it step aside automatically while the genre picker's own `<input>`
  has focus, letting `Combobox`'s existing Enter/Arrow/Escape handling run
  untouched with no event-propagation hacks needed.
- Saving from the picker reuses the existing `beginEdit`/`commitEdit`/
  `onEditField` pipeline — a genre-mode save is a completely normal
  undoable history entry.
- Up/Down and advance both call the existing virtualizer's `scrollToIndex`
  so the current row stays in view on a long list.
- A bottom strip shows the current filename, play/pause, elapsed/total time,
  the track's current genre, and the key legend.

**Simplified vs. the original plan, left as backlog:** the seek amount is a
hardcoded 10 s constant rather than a setting; `Tab`-to-accept-without-
advancing isn't implemented (only Enter/click advance); fuzzy filtering and
arrow-navigation *within* the open picker's own option list were already
present in `Combobox` before this feature and needed no changes.

### 25. Strict filename charset — v0.7
Settings → Track IDs → **Strict file names** (default **on**): Rename to
Standard now builds the stem with only `a-z`, `0-9` and `-`.

- `sanitizeForFilenameStrict()` ([standardize.ts](src/lib/standardize.ts)):
  Unicode NFKD-decomposes the value and strips the combining diacritical
  marks that split off (`Beyoncé` → `beyonce`, `Motörhead` → `motorhead`,
  `Ñoño & Zürich` → `nono-zurich`), lowercases, then maps every remaining
  non-`[a-z0-9]` character to `-`, collapsing runs and trimming both ends.
  `buildRenameStem()` takes a `strict` flag and joins parts with `-` instead
  of `" - "` when set.
- **Limitation, as scoped:** this ASCII-folds accented Latin script well but
  cannot romanize a genuinely different script (Cyrillic, CJK, Arabic, …) —
  those characters have no accent to strip, so they become dashes like any
  other unsupported character, same as the roadmap's "where possible" caveat.
- Falling back to the track id when artist/title sanitize to nothing, and
  refusing (reporting an error) a file with no usable characters at all, both
  fall out of the existing `[artist, title, uid].filter(nonEmpty).join()`
  structure — no special-case code needed, since `uid` was already one of
  the three parts.
- `renameToStandard()` in [App.tsx](src/App.tsx) now pre-counts stem
  collisions across the batch and warns (native confirm, not blocking) before
  writing anything; the existing rename-collision suffix (" (2)", " (3)", …)
  still guarantees nothing is overwritten either way.
- **Not built:** a dedicated before/after rename preview screen — there
  wasn't one before this change either, so this stayed scoped to the
  character-set enforcement itself rather than adding new UI.

### 26. Auto-detect genres from the collection — v0.7
Settings → Genre Presets → **Detect genres from collection**
([SettingsPage.tsx](src/pages/SettingsPage.tsx), `DetectGenresPanel`):

- `detectGenreGroups()` ([genres.ts](src/lib/genres.ts)) tallies every
  distinct `TagData.genre` across the loaded collection (`libraryTags` in
  App.tsx, kept live via a `useMemo`), grouping near-duplicate spellings by a
  normalized key (case, `&`/`and`, `-`/space all folded together — `Hip Hop`
  / `Hip-Hop` / `hip hop` collapse into one group). The most common raw
  spelling in a group becomes its suggested `canonical` name.
- The panel lists groups **not already in the active preset**, pre-ticked,
  sorted by track count, with the other spellings shown under each ("also
  seen as: …"). **Add N genres** appends the ticked canonical names to the
  preset via `addGenresToPreset()`.
- For any ticked group with more than one variant, adding it also calls the
  existing retag machinery (`mergeGenreVariants()`, built on the same
  confirm-then-`editField()` pattern as item 20's single-genre rename) —
  offering to retag every track using a non-canonical spelling to the
  canonical one, in a single native confirm covering the whole group.

Found and fixed one grouping bug while testing this: normalizing `&` to
`and` without surrounding spaces turned `R&B` into `rand b` instead of
`r and b`, so it never matched the `R and B` spelling it was supposed to
group with.

### 27. Raw field names as labels — v0.7
Settings → Standardization → **Field naming**: `Title` / `TIT2` / `Title
(TIT2)`. New [rawFieldNames.ts](src/lib/rawFieldNames.ts):

- A static table of each curated field's raw name in the three tag families
  this app writes — ID3v2 (`TIT2`, `TPE1`, …), Vorbis Comments (`TITLE`,
  `ARTIST`, …), MP4/iTunes atoms (`©nam`, `©ART`, …) — including the app's
  own private `Unknown(TRACKID)` field's real name per family.
- `familyForFormat()` maps a file extension to its tag family (mp3/wav/aiff
  → ID3v2, flac/ogg → Vorbis, m4a/aac → MP4); `dominantFamily()` picks the
  most common family across the loaded collection.

**Simplified vs. the original plan:** a table header is one label shared by
every row, so it can't literally "follow the format of the selected file"
per-row — it uses the collection's dominant family instead, with
`rawNameTooltip()` listing every family's name on hover so a mixed
collection is never misleading. Only table headers were wired up; the Clear
Fields checklist and the strip preview still show the friendly name
regardless of this setting — left as a follow-up rather than done partway.

### 28. Primary / secondary DJ app — v0.7
Settings → **DJ Software**: Primary and Secondary pickers (Rekordbox,
Serato DJ, Traktor, Engine DJ, VirtualDJ, djay, Mixxx, Other/none) — stored
now, for the recommended backup field below and as the app's own record of
the user's setup ahead of the v0.9 export targets.

- `recommendedBackupField(app)` in [types.ts](src/types.ts): Rekordbox
  reads Original Artist for the searchable backup; every other app here
  relies on Comment. When the current `backupField` doesn't match the
  primary app's recommendation, a note explains the mismatch with a one-click
  **Use it** button — it never silently changes the setting itself.
- Traktor's 0–255 internal rating scale is noted next to the picker (it's
  still shown/edited as 0–5 stars here either way — this is informational,
  not a scale-conversion feature).

**Simplified vs. the original plan:** the secondary app is stored but
nothing is written to a second field yet — "the secondary app's field
written too when the two differ" needs `write_tags_blocking` and
`backup_file_blocking` to accept and write a *second* backup field
(currently one `Option<String>` each), which is real Rust surface area
without a second real-world backup target to test against yet. Left for
whichever v0.9 export item first needs it, rather than built speculatively
now.

### 29. Split Standardize into separate Capitalization / Characters tools — v0.7
The old **Standardize** button ran `applyReplacements()` (character/separator
rules) and `applyCapitalization()` back to back with no way to run just one.
It turned out **Remove Chars** was already its own button (a *different*,
narrower thing — stripping a fixed literal character set from Settings, not
the feat./bracket/dash/junk-suffix rules) — so the real gap was pulling
capitalization and the character rules apart from each other, not from
Remove Chars.

- New [CapitalizationMenu.tsx](src/components/CapitalizationMenu.tsx) — the
  same split-button pattern as `ClearFieldsMenu`: the left half re-runs the
  remembered mode, the caret opens a one-click list of every mode. Picking
  one runs it immediately and becomes the new remembered default
  (`settings.capitalization`).
- Added the missing **Sentence case** mode to `applyCapitalization()`
  ([standardize.ts](src/lib/standardize.ts)) and the `Capitalization` type —
  the roadmap listed it but it didn't exist yet.
- New **Characters** button runs just `applyReplacements()` — the feat./
  bracket/dash/junk-suffix/whitespace rules from Settings, with no recasing.
- **Standardize** is unchanged: still runs both together in one pass, for
  the original one-click behaviour.
- `CAP_OPTIONS` moved from SettingsPage.tsx into types.ts (next to the
  `Capitalization` type) so the new toolbar component isn't importing
  constants out of a page module.

All three still build the same before/after pending-change preview as
before — no changes were needed there.

### 30. Library browser sidebar — v0.7 (v0.7 complete)
New [LibrarySidebar.tsx](src/components/LibrarySidebar.tsx): a collapsible,
resizable pane (drag the right edge, 160–420px, width and collapsed state
persisted to `settings.sidebarWidth`/`sidebarCollapsed`) to the left of the
track table, with a Folders / Genres / Artists mode switcher and its own
search box that filters the tree/list itself.

- **Folders** — a real nested tree built from every loaded file's path
  (`buildFolderTree()`), not just a flat list of parent directories; each
  folder shows its track count (including subfolders) and expands/collapses
  independently. Clicking a folder filters the table to that folder and
  everything under it.
- **Genres** / **Artists** — flat, count-sorted lists tallied directly from
  `TagData.genre`/`artist` with **no** near-duplicate merging — this is for
  exact-match browsing, not the fuzzy grouping Detect Genres (item 26) does,
  so what you click is exactly what you'll see. Clicking one filters to an
  exact match.
- Clicking the active filter again clears it; a banner shows the current
  filter with its own clear button. The filter narrows the `files` array
  passed into `TrackTable`, so it composes with — sits underneath — the
  table's own existing search/flagged filters rather than replacing them,
  and never triggers a disk rescan.

**Simplified vs. the original plan:**
- **Playlists** mode isn't included — there's no playlist import feature
  yet (that's v0.9 F4/F5), so it would have nothing to show.
- **Artists** is a flat list, not "expandable to that artist's tracks" —
  clicking an artist already filters the whole table to their tracks, which
  covers the same need without a second, nested tree UI.
- **Ctrl-click for unions** (selecting multiple folders/genres/artists at
  once) isn't implemented — one active filter at a time, click again to
  clear. Left as a follow-up if single-selection turns out to be limiting
  in practice.

### 31. Find duplicates by audio content — v0.8 F1
New Rust module [duplicates.rs](src-tauri/src/commands/duplicates.rs), three
stages as planned:

1. **Exact** — a blake3 hash of the file bytes.
2. **Fingerprint** — `rusty-chromaprint` (confirmed pure Rust: pulls in only
   `rustfft`/`realfft`/`rubato`, no C library or external binary) computes
   the fingerprint from PCM decoded by `symphonia` (also pure Rust). Both are
   cached in a local sqlite database (`rusqlite`, `bundled` feature — SQLite
   compiles from source, no external DLL needed) at
   `app_data_dir()/fingerprint-cache.sqlite`, keyed by path + mtime + size,
   so re-scanning an unchanged library only touches the exact-hash step.
   Only the first ~2 minutes of audio is decoded per file — plenty for a
   fingerprint match, far cheaper than decoding a whole DJ mix start to end.
3. **Match** — `rusty_chromaprint::match_fingerprints` returns alignment-
   tolerant segments; the *largest* segment's `.score` (chromaprint's own
   0–32 similarity measure, lower = more similar) and **coverage** (that
   segment's duration versus each file's own duration) drive classification.

**Radio edit vs. extended mix**, built exactly as planned: high similarity
**and** high coverage on **both** sides → `"duplicate"`; high similarity but
coverage only high on the *shorter* file → `"alternate"` (never suggested
for deletion). Verified with a dedicated test
(`radio_edit_inside_extended_mix_classifies_as_alternate_not_duplicate`)
using a synthetic melody embedded inside a longer one with a different
intro/outro — confirmed it classifies as Alternate, not Duplicate. Two more
tests confirm identical audio scores as a strong match and two different
melodies don't; a further two exercise the real file-decode path (a
synthesized WAV written to disk) and the sqlite cache actually being reused
on a second call. All 5 pass.

Transitively-related files (A matches B, B matches C) are merged into one
group via union-find rather than emitting overlapping pairs; a cluster is
only labeled `"duplicate"` if *every* compared pair inside it was a
duplicate match — one alternate-version pair downgrades the whole cluster,
so a radio edit + its extended mix + a byte-identical copy of the radio
edit doesn't get mislabeled as all being the same file. Progress is reported
via a `duplicate-scan-progress` event (the same `AppHandle::emit` pattern
`components.rs` already uses for download progress).

**Caveat, stated plainly:** the similarity/coverage thresholds
(`DUPLICATE_SCORE_MAX`, `DUPLICATE_MIN_COVERAGE`, etc.) are a reasoned
starting point, not a scientifically calibrated cutoff — they were validated
against synthetic sine-wave/melody fixtures (the only audio available in
this environment), not real music. They may need tuning against an actual
library; the constants are isolated at the top of the file specifically so
that's easy to do without touching the algorithm itself.

### 32. Duplicate review UI — v0.8 F2
New [DuplicatesPage.tsx](src/pages/DuplicatesPage.tsx), reachable from a new
**Duplicates** sidebar nav item:

- **Scan for Duplicates** runs the v0.8 F1 engine over every loaded file,
  with a live progress bar driven by the `duplicate-scan-progress` event.
- Results as groups, each row showing format, bitrate, sample rate,
  duration, file size, artwork presence and a tag-completeness count — the
  facts item 32 asked for, computed from the existing `AudioFile`/`TagData`
  the app already loads (extended `AudioFile` with `bitrateKbps`/
  `sampleRateHz` from lofty's `FileProperties`, which weren't surfaced to
  the frontend before this).
- An auto-suggested keeper (lossless format → highest bitrate → most
  complete tags → path as a deterministic last resort) is pre-selected as
  **Keep**, every other file in a `"duplicate"` group defaults to
  **Remove**; every file in an `"alternate"` group defaults to **Skip**
  (never auto-suggested for removal). Every row is a three-way
  Keep/Remove/Skip toggle, always overridable.
- Nothing is deleted until **Remove N to Recycle Bin**, which shows the
  exact count and total size and reuses the existing `delete_file` command
  — already Recycle-Bin-based, not a hard delete, so no new Rust command was
  needed for removal itself.

**Simplified vs. the original plan:**
- No **keeper rule bar** ("prefer FLAC", "prefer highest bitrate" applied
  across every group at once) — each group is reviewed individually. The
  per-group auto-suggestion already applies a sensible default rule; a bulk
  override bar is a reasonable follow-up if reviewing many groups by hand
  turns out to be tedious.
- **"Oldest path" tie-break** isn't really oldest-by-date — `AudioFile`
  doesn't carry file mtime to the frontend, so the tie-break after
  format/bitrate/tags is alphabetical path order instead. Surfacing mtime
  would be a small, isolated follow-up.
- **No undo manifest** and **no tag/artwork merge into the keeper** before
  removal — deletion goes to the Recycle Bin (itself a form of undo via the
  OS), but the specific "written alongside" manifest and the merge step
  weren't built.
- **No quarantine-folder option**, only the Recycle Bin.

### 33. Waveform preview — v0.8 F3 (completes v0.8)
`decode_to_pcm_capped()` in [duplicates.rs](src-tauri/src/commands/duplicates.rs)
was generalized to take an optional sample cap: fingerprinting still decodes
only the first ~2 minutes (`decode_to_pcm`), while a new `decode_full()`
decodes the whole file for a waveform's true shape — needed because a
fingerprint-only decode would truncate any track over 2 minutes to a
misleadingly short waveform. `compute_waveform_peaks()` downsamples the
decoded PCM (channels averaged to mono first) to 400 peak buckets; a new
`get_waveform` command caches them in the *same* `file_cache` sqlite table
the fingerprint cache uses, in a `waveform_peaks` column, keyed the same
way (path + mtime + size).

**A real bug found and fixed while building this:** the fingerprint cache
and the waveform cache are populated independently (whichever is requested
first), so the table's schema had to become "every non-identity column is
nullable, both sides upsert by path." A naive upsert — write your own
columns, leave the other side's alone — turns out to be unsafe: if a file
changes between the two writes, whichever write happens *after* the change
stamps the row with the new mtime/size while the *other* side's still-old
cached value is left in place, silently marking stale data (fingerprint or
waveform, whichever wasn't just recomputed) as valid for the new file
content. Fixed with a `CASE WHEN file_cache.mtime = excluded.mtime AND
file_cache.size = excluded.size THEN <old value> ELSE NULL END` guard in
both upserts, so the other side's cached value survives only when the file
genuinely hasn't changed. Caught by a dedicated test
(`waveform_and_fingerprint_caches_survive_each_other`) that writes a
fingerprint, then a waveform, and checks the fingerprint is still intact —
this would have been a real, silent duplicate-detection correctness bug
against a real library where files get edited between scans.

New [Waveform.tsx](src/components/Waveform.tsx): fetches and in-memory
caches peaks per path, renders as an SVG bar chart, with an optional
`progress` prop that draws a playhead line. Wired into:
- **Genre Mode's bottom strip** ([TrackTable.tsx](src/components/TrackTable.tsx)) —
  the current track's waveform with a live playhead synced to `gmTime`/`gmDuration`.
- **Duplicate review** ([DuplicatesPage.tsx](src/pages/DuplicatesPage.tsx)) —
  every file in a group shows its own waveform stacked under the next,
  making "same master, different length" (or a genuinely different
  recording) visible at a glance, exactly as planned.

**Not built:** using the waveform to expose song structure (intro/
breakdown/drop) for genre passes — the peaks are shown, but no structural
analysis (energy-based section detection) was added on top of them; and the
per-row `AudioPreview` prelisten scrub bar (used throughout the main track
table, outside Genre Mode) still uses a plain range input rather than this
waveform, to avoid restructuring an already-stable, widely-used component
in this pass.

This completes v0.8 (items 31–33: duplicate detection, review, waveform).

### 34. Real-library validation of duplicate detection — v0.8.2
Item 31 shipped calibrated only against synthetic sine-wave/melody fixtures
(the only audio available in that environment) — this item is running it
for real, against the user's own collection, and fixing what that turned up.

**Method:** `scan_duplicates_blocking` was split into a Tauri-independent
`scan_duplicates_core(conn, paths, on_progress)` — same production logic,
takes a plain `Connection` and a progress closure instead of an `AppHandle`
— so it can run from a `#[ignore]`d test outside a running app. Pointed at
`C:\Users\sopas\Music\backup` (484 real MP3s of varied bitrate/source):
~106s end to end (~0.22s/file), 9 groups on the first pass.

**Result — genuinely valuable, not clean on the first try:**
- 7 of 9 groups were correct real duplicates on the very first run, several
  non-trivial: an app-generated-Track-ID naming variant, a featured-artist
  retag ("Sao Paulo" / "The Weeknd- Anitta - Sao Paulo"), and straight
  re-downloads — all scoring 0.00–0.66 out of a 0–32 scale.
- **One real false positive**: three completely unrelated songs (Brutalismus
  3000 / Michael Sembello / The Police) clustered as "alternate version"
  (score 9.55). Diagnosed with a new `diagnose_pair` test that prints exact
  matched-segment timestamps rather than just the summary classification —
  it showed a genuine 46.6s audio match, but positioned at 0:00–0:47 in one
  file and 0:57–1:43 in the other: the signature of a shared promotional
  jingle/station-drop prepended by whatever tool the files were downloaded
  through, not the same recording.
- **One real under-classification**: a genuine duplicate pair ("Pitbull -
  Hotel Room Service") landed as "alternate" (score 2.34) instead of
  "duplicate", because the two re-encoded copies matched across 5 separate
  segments with small gaps between them (re-encoding artifacts), and
  `classify_pair` only measured coverage from the single largest segment —
  36.6s out of 120s, well under the 85% duplicate threshold.

**What was tried and reverted — worth recording so it isn't tried again the
same way:** to fix the under-classification, coverage was changed to span
every matching segment (first segment's start to last segment's end) instead
of just the biggest one, and score to a length-weighted average across all
segments. Re-run against the same 484 files: **14 groups, most of them
wrong** — unrelated songs merged as "duplicate" (score 8.87, 9.64, 9.57),
and one 14-file cluster combining completely unrelated tracks. Root cause:
several scattered, individually brief coincidental matches (shared drum
patterns/timbral similarity, common across unrelated electronic/pop
production) spread a first-to-last "span" across nearly a whole file, which
reads as high coverage despite almost none of the content actually
matching — span conflates "matched over a wide range" with "matched
densely," and real files apparently produce enough scattered noise for that
distinction to matter. **Reverted to single-largest-segment coverage** —
the under-classification bug stayed (recorded above, now backlog), rather
than trade it for something worse.

**What actually shipped, verified against the real false positive AND a
clean re-run of all 8 remaining groups:** `ALTERNATE_SCORE_MAX` tightened
from 14.0 to 6.0. Diagnostic data showed score was the reliable separator
all along — the shared-jingle false positive scored 9.55, while the
synthetic radio-edit/extended-mix fixture (item 31's own test) scored 0.03
— a wide, dependable gap that coverage-tuning alone couldn't replicate
(the false positive's coverage, 0.39, and the genuine synthetic case's,
0.44, were too close together to separate on that axis). Also added
silence removal to the shared fingerprint config (`with_removed_silence`)
on the hypothesis that quiet intros/outros were the cause — measurement
showed identical scores with or without it, so it did *not* explain this
particular false positive, but is a real, independently-justified
improvement (near-silent audio genuinely carries little discriminating
chroma information) kept regardless.

Re-run after the fix: **8 of 8 groups correct** — the false positive is
gone, all 7 duplicate pairs and the one under-classified-but-real alternate
pair are intact, no new false positives. Two new permanent test fixtures:
`diagnose_pair` (point it at any two real files, prints exact segment
timestamps/scores) and `real_library_scan_smoke_test` (point it at a real
folder, runs the actual production pipeline). Both `#[ignore]`d — opt-in via
env vars, not part of the normal suite — since they need real audio files
this repo doesn't ship.

**Left as backlog, not fixed:** the Hotel Room Service-style
under-classification (a genuine duplicate fragmenting into several segments
lands as "alternate" rather than "duplicate") is still present — it's a
real limitation, not a regression, and safer to leave than to re-attempt
with the span-based approach that made things worse. A cache schema/
algorithm-version stamp is also still missing (see Backlog) — this session
hand-cleared the sqlite cache directory before each re-test since
`fingerprint_config()` changed; without a version stamp, a *future* config
change could silently compare fingerprints computed under two different
configs against each other.

**Round two — a second, larger, more diverse real folder (v0.8.3):**
`C:\Users\sopas\Music\Collection`, 3726 files, mostly dance/EDM — a genuinely
different test of the same fix. First pass at `ALTERNATE_SCORE_MAX = 6.0`
found 41 groups, but **6 more shared-jingle false positives** slipped
through — clusters of unrelated artists across trance, indie pop and
techno, scoring 4.84–5.93, all clustered right under that ceiling. One
confirmed with `diagnose_pair`: two completely unrelated tracks (Angelo
Ferreri, Armin Van Buuren) both matching from 0.0s/1.2s — the same
"matches from the very start of the file" signature as the first false
positive. Meanwhile every *genuine* alternate found in this run — same-song
variants, edits, even a legitimate mashup that samples another track —
scored 3.14 or lower. That gap (genuine: 0.03–3.14, shared-jingle false
positives: 4.84–9.55) is now consistent across two independent real
libraries, so `ALTERNATE_SCORE_MAX` was tightened again, 6.0 → 4.0.
Re-verified against the same 3726 files (fast this time — the fingerprint
cache was already warm from the first pass, so this only re-ran the
comparison stage, ~278s instead of ~1170s): **35 groups, exactly the 6 false
positives gone, every remaining score ≤3.14** — no new omissions or false
positives introduced.

### 35. Simple backup archive — v0.9 F6
New **Backup Archive** button in the Library toolbar (distinct from the
existing tag-level "Backup"/"Restore" — this one archives whole *files*,
not tag snapshots): picks the ticked selection, or the whole loaded
collection if nothing's ticked, and writes a single **store-only ZIP**
(`CompressionMethod::Stored` — audio doesn't compress, and storing keeps it
fast and byte-exact) via the new [backup_archive.rs](src-tauri/src/commands/backup_archive.rs).

- A size estimate (from the already-loaded `AudioFile.size` values, no new
  Rust command needed) is shown in the confirm dialog before anything runs.
- The generated filename follows the planned pattern exactly:
  `MusicTagCleaner-backup-2026-09-02-1432-412-tracks.zip`; the user still
  picks the destination folder via the native save dialog.
- Progress reported via a `backup-archive-progress` event (the same
  `AppHandle::emit` pattern used elsewhere), shown in the existing status
  bar progress UI rather than new UI.
- Each entry is stored at a collision-proof path derived from the file's
  original absolute path (`C:\Users\x\Music\a.mp3` → `C/Users/x/Music/a.mp3`
  inside the zip) rather than flattened by filename, so two same-named files
  from different folders never collide and the original layout is
  recoverable.
- A `manifest.json` is written as the last entry, listing every file's
  original path, its path inside the archive, size, and a blake3 hash (the
  same hashing already used for exact-duplicate detection) — enough to
  verify or restore the archive later without opening every audio file. A
  `read_backup_manifest` command can read it back out of an existing zip
  without extracting anything else, though no frontend UI calls it yet
  (see below).
- On success, `revealItemInDir` (the frontend `@tauri-apps/plugin-opener`
  API — not previously used, only `openUrl` was) highlights the finished
  file in Explorer.
- Three Rust tests: the path-to-entry-name conversion (both backslash and
  forward-slash inputs), and a full round trip that writes a real archive,
  reads it back, and checks the stored bytes are byte-identical, the
  compression method is genuinely `Stored`, and the manifest parses with
  the right track count.

**Not built:** no UI to browse/verify an existing backup's manifest (the
`read_backup_manifest` command exists but nothing calls it yet) — left for
if it turns out to be needed, rather than built speculatively now.

### 36. Rekordbox cue import — v0.9 F5
New **Import Rekordbox Cues** button on the Settings page: picks a
`rekordbox.xml` export via a file dialog and reads every track's memory
cues, hot cues, loops, and beat grid/BPM out of it, via the new
[rekordbox_import.rs](src-tauri/src/commands/rekordbox_import.rs). Read-only
— nothing is ever written back to Rekordbox.

- Cues are stored keyed by **audio fingerprint, not file path** — reusing
  the exact same Chromaprint pipeline and sqlite cache `duplicates.rs`
  already built for duplicate detection (`get_or_compute`, `open_db` were
  made `pub(crate)` for this reuse). This means a cue survives a rename or a
  move; only a genuine re-encode changes the fingerprint.
- `rekordbox.xml`'s `TRACK` entries are parsed with a streaming `quick-xml`
  reader: `POSITION_MARK` elements with `Type="0"` and both a `Start` and
  `End` attribute become loops; the rest become hot cues (`Num >= 0`, giving
  the pad 0–7) or memory cues (`Num` negative/absent). `TEMPO` elements
  build the beat grid. Locations are `file://localhost/`-prefixed,
  percent-encoded paths (`%20`, multibyte UTF-8 escapes included) —
  `location_to_path()` strips the prefix, percent-decodes, and flips
  slashes for Windows.
- Progress reported via a `rekordbox-import-progress` event, shown next to
  the button; the result notification reports tracks matched vs. total,
  how many source entries weren't found on disk, and any per-track errors.
- The [Waveform](src/components/Waveform.tsx) component now accepts
  optional `cues`/`durationSecs` props and draws memory cues, hot cues (with
  Rekordbox's default pad colors when the XML has none), and loop regions
  as an overlay, positioned by `positionSecs / durationSecs`. Genre Mode's
  waveform strip in [TrackTable.tsx](src/components/TrackTable.tsx) fetches
  `get_cues_for_path` for whichever track is showing (cached per path,
  keyed off the same `anchorPath` the strip already tracks) and passes the
  result straight through.
- 5 Rust tests (4 passing, 1 `#[ignore]`d real-data test): percent-decoding
  (plain and multibyte UTF-8), a full parse of a real trimmed XML excerpt
  with cues/hot cues/a loop, and a SQL round trip confirming cues survive a
  path change under the same fingerprint but don't match a different one.

**Validated against the user's real `rekordbox.xml`** (145 KB, 89 `TRACK`
entries): parsed all 89 entries; 88/89 found on disk (one file — `Kye
Gibbon - Saving My Life.flac` — correctly reported missing); of the 88
found, 85 had memory cues, 86 had hot cues, 46 had loops, and all 89 had
tempo/beat-grid data.

**Not built:** ANLZ `.DAT`/`.EXT` sidecar parsing (mentioned as a maybe in
the original roadmap item) — `rekordbox.xml` already carries every cue type
tested against real data, so the extra analysis-file format wasn't needed.
Writing cues back out to Rekordbox/Serato/Traktor remains explicitly
out of scope, as planned.

## Roadmap — v0.9 → v1.0

Planning only from here on. v0.6, v0.7 and v0.8 are complete (items 1–34);
v0.9 F5 and F6 (items 35–36) are done — only F4 remains. Ordered by
release. Each item notes the suspected cause where the code has already
been read, so the fix doesn't start from zero.

---

# v0.9 — Library features

### F4. YouTube Music playlist → Rekordbox
Paste a YouTube Music playlist URL. The app:

1. fetches the playlist's entries (title / artist / duration / album)
2. matches each against the collection — normalized artist+title first, then
   fuzzy scoring with duration as tiebreaker, then optional fingerprint
   confirmation for near-misses
3. returns three lists:
   - **Matched** → exported as a Rekordbox playlist (`.m3u8` **and** rekordbox
     XML), in the playlist's original order
   - **Missing** → the tracks not in the collection, as a copyable list, with a
     hand-off to Media Fetch for downloading
   - **The source playlist** itself, with links back to each YouTube Music entry
4. flags ambiguous matches for manual confirmation rather than guessing — an
   80 % match asks, it never silently accepts

### F5. Rekordbox cue import — done, see item 36
---

# v1.0 — Accounts, pricing, payments

Built by **Sergio Alexo**, founder of **Forgexus**.

### P1. Forgexus account login
Sign in with a **Forgexus account** — the unified identity across the Forgexus
group's technology and manufacturing divisions, so one account covers
MusicTagCleaner, Media Fetch and everything that follows.

- OAuth 2.0 + PKCE in the system browser, tokens in the OS keychain
  (Windows Credential Manager / `tauri-plugin-stronghold`), background refresh,
  never a password typed into the app
- entitlements (tier, quota, device count) cached locally and signed, so the app
  works offline for a 7-day grace period before requiring a re-check
- **the app stays fully usable signed-out for everything local** — sign-in gates
  cloud AI and quota, not tag editing
- device management: 3 activations per account, self-service deactivation

### P2. Pricing structure — recommendation
The natural axis is *who does the thinking*, which is also what actually costs
money. Three AI modes, cheapest to dearest, exactly as the compute cost runs:

| Mode | What it is | Cost to you | Positioning |
|---|---|---|---|
| **Manual** | You edit; the app standardizes and validates | zero | Free |
| **Local (Ollama)** | The user's own machine runs the model | zero marginal, plus support | Mid |
| **Cloud (Claude API)** | Best quality, no setup, works anywhere | real per-track cost | Top |

Recommended shape — **subscription for the app, credits for cloud AI**:

- **Free** — full manual editing, standardize, rename, clear fields, backup ZIP,
  library browser. No time limit. This is the funnel; don't cripple it.
- **Pro — ~$8/mo or $60/yr** — local Ollama AI, auto genre detection, duplicate
  detection, playlist matching, waveform + cue import, preset sync across
  devices.
- **Studio — ~$18/mo or $150/yr** — everything in Pro plus cloud (Claude) AI
  with a monthly track allowance, priority processing, batches above 1000.
- **Cloud credit packs** — for anyone over their allowance, and for Pro users
  who want an occasional cloud run without upgrading. Price around 3–4× raw API
  cost to cover payment fees, retries and support.
- **Lifetime — ~$180, manual + local only, no cloud AI.** Worth offering once,
  early, as a founder's edition. Never bundle a recurring cost into a one-off
  price.

Per-feature placement, cheapest to dearest, as asked:

- *free:* manual editing, **auto genre detection** (it's a local tally, not AI),
  capitalization + character tools, filename rules, backup ZIP
- *Pro:* duplicate detection + fingerprinting, waveform, cue import, playlist
  matching, Ollama AI cleanup
- *Studio / credits:* Claude-powered auto-clean, genre *inference* for tracks
  with no usable tags, artwork lookup, bulk cross-library unification

**Free AI allowance:** first **3000 tracks free**, then **10 tracks/day free**
across all AI features. Counted server-side against the Forgexus account (a
local counter is trivially reset), shown as a remaining-count in the status bar,
and decremented **only on a successful write** — never charge for a failed or
rejected suggestion. Local Ollama should *not* consume the allowance: it costs
nothing to run, and letting it run free is the strongest argument for Pro.

### P3. Payments — recommendation
**Don't go crypto-only.** Plainly:

- The buyers are DJs, not crypto users. Crypto-only cuts off the large majority
  at checkout — the most expensive decision on this list.
- Subscriptions are the whole model, and crypto has no native recurring billing.
  Every renewal becomes a manual action the user must remember, which wrecks
  retention.
- Refunds, chargebacks and EU/UK **VAT on digital goods** are legal obligations
  a wallet doesn't handle for you.

**Recommended:** cards + PayPal + Apple/Google Pay through a **merchant of
record** — **Paddle** or **Lemon Squeezy** (Paddle if EU VAT and invoicing
matter most, which for a one-person company they do). They become the seller of
record, so global sales tax, invoicing and fraud are their problem, not yours:
roughly 5 % + fixed fee versus Stripe's ~2.9 % + 30¢ *plus* doing tax compliance
yourself. For a solo founder that difference is cheap.

**Add crypto as a secondary option**, not the only one: BTC / ETH / USDC via
Coinbase Commerce or BTCPay Server, offered for **one-time purchases only** —
lifetime licences and credit top-ups, where there's no recurring-billing problem
to solve. Cheap to add, appeals to part of the audience, takes nothing from
anyone else.

Practical notes: price in USD with local display currency; discount annual plans
~35 % to smooth cash flow; state a 14-day refund policy plainly (cheaper than
disputes); and make licence checks **fail open** — a payment-provider outage
must never lock someone out of editing their own files.

---

## Open questions

- ~~Does a local database become the source of truth~~ — **decided**: yes.
  F1 (item 31) added a local sqlite database at
  `app_data_dir()/fingerprint-cache.sqlite`, keyed by path + mtime + size.
  F3's waveform peaks are a natural fit for the same database/cache
  (same cache-invalidation story); F5's cues should use it too, keyed by
  fingerprint rather than path per the original plan, so cues survive a
  rename or move.
- YouTube Music has no official third-party playlist API. Confirm which access
  path is workable and acceptable before committing F4 to a release.
- Cross-library cue unification (F5's stated goal) is a large project in its own
  right — probably v1.1+, not a rider on v0.9.

---

## Backlog (unscheduled)

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
- The `file_cache` sqlite table (duplicate detection, item 31/34) has no
  algorithm-version stamp — if `fingerprint_config()` or the waveform bucket
  count ever changes again, old cached rows would silently compare against
  new ones as if they were the same algorithm. Add an `algo_version INTEGER`
  column, bump a constant whenever the algorithm changes, and treat a
  version mismatch as a cache miss.
- A genuine duplicate that fragments into several matching segments (re-
  encoding artifacts, minor structural drift) under-classifies as
  "alternate version" rather than "duplicate", because `classify_pair` only
  measures coverage from the single largest segment (see item 34's real
  false-positive-vs-worse-regression story before changing this) — real,
  reproducible (`Pitbull - Hotel Room Service` in the user's own library),
  left alone because the two fixes tried for it both made a different case
  much worse. Needs a coverage measure that distinguishes "matched fairly
  densely across a wide range" from "a handful of scattered short matches
  spread over a wide range" — simple span or simple sum both fail one real
  case or the other.
- (add items here)
