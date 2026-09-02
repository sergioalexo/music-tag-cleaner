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

## Roadmap — v0.7 → v1.0

Planning only; nothing below is implemented except items 24–26 above (Genre
Mode, strict filenames, genre auto-detect). Ordered by release. Each item
notes the suspected cause where the code has already been read, so the fix
doesn't start from zero.

---

# v0.7 — Editing UX

### U3. Split Standardize into three tools
Today one button does everything. Break it into:

1. **Capitalization** — split button with a dropdown (`Aa` Capitalize Each Word,
   `ALL CAPS`, `lowercase`, `Sentence case`, `Leave as-is`). The choice persists
   and the left half re-runs the remembered mode — exactly how Clear Fields
   already works.
2. **Characters** — the character/separator rules (feat. normalization, bracket
   style, dash spacing, junk-suffix removal, whitespace collapse), each
   toggleable, run as its own button.
3. **Standardize** — kept as "run everything currently enabled", for the old
   one-click behaviour.

All three still preview through the existing pending-change pipeline.

### U4. Raw field names as the labels
Setting **Field naming: Friendly / Raw / Both** — `Title` vs `TIT2` vs
`Title (TIT2)`. Affects table headers, the Clear Fields checklist and the strip
preview. Raw names are per-container (ID3 `TIT2`, Vorbis `TITLE`, MP4 `©nam`),
so the label follows the format of the selected file; a mixed selection shows
the ID3 name with the others in the tooltip.

### U6. Library browser sidebar
A second, narrow pane on the left of the Library page (collapsible, resizable,
width persisted) with a mode switcher:

- **Folders** — the folder tree of the imported roots, with track counts
- **Genres** — every genre in the collection with counts; click filters the table
- **Playlists** — imported playlists (Rekordbox XML / m3u8, see F4)
- **Artists** — grouped by artist, expandable to that artist's tracks

Plus a search box at the top that filters *the tree itself* (find the right
folder / genre / artist fast), separate from the existing track search.
Selection is a filter over the loaded collection — no disk rescan. Ctrl-click
for unions. Follows the Media Fetch sidebar design language.

### U7. Primary / secondary DJ app
Settings → **DJ software**: a primary and an optional secondary pick from
Rekordbox, Serato, Traktor, Engine DJ, VirtualDJ, djay, Mixxx, "Other". Stored
now, used for:

- which field holds the searchable backup — Rekordbox reads Original Artist
  (`TOPE`), Serato and Traktor don't and need Comment. Today's hardcoded
  Original Artist behaviour becomes "whatever the primary app reads", with the
  secondary app's field written too when the two differ.
- default field visibility and rating scale (Rekordbox/Serato 0–5,
  Traktor 0–255)
- the export targets offered in v0.9 (F4/F5)

A one-line explanation under the picker states exactly which fields the choice
changes — no silent behaviour switches.

---

# v0.8 — Duplicate detection

### F1. Find duplicates by audio, not by name
Three stages, cheapest first:

1. **Exact** — file hash (blake3) catches literal copies instantly.
2. **Fingerprint** — decode to mono 11 kHz, compute a Chromaprint-compatible
   fingerprint (Rust `rusty-chromaprint`, no external binary), cached per file
   in a local sqlite database keyed by path + mtime + size, so a rescan is
   near-free.
3. **Match** — alignment-tolerant comparison, so an MP3 and a FLAC of the same
   master, or two rips at different bitrates, still match.

**Radio edit vs extended mix — the important part.** A radio edit's fingerprint
*is* a subsequence of the extended mix, so naive matching flags them as
duplicates. The comparison therefore reports **similarity** and **coverage**
separately:

- high similarity **and** durations within ~5 % → *same recording*, a real duplicate
- high similarity on the overlapping region, but durations differing by more
  than ~20 s or the aligned section covering only part of the longer file
  → *different edit*

The second case gets its own category — **"Alternate versions"** — and is never
proposed for deletion. Title keywords (`Extended`, `Radio Edit`, `Club Mix`)
only *label* a group; they never decide it.

### F2. Duplicate review — you choose what to keep
Results as groups, one row per file, with the facts needed to judge: format,
bitrate / sample rate, duration, file size, has-artwork, tag-completeness score,
folder, date added. Then:

- an auto-suggested keeper (highest quality → most complete tags → oldest path),
  pre-selected but **always overridable**
- a rule bar to apply a keeper rule across every group at once ("prefer FLAC",
  "prefer highest bitrate", "prefer this folder")
- per file: **Keep** / **Remove** / **Skip group**
- nothing is deleted until a final confirmation showing exact count and total
  size, and **removal means the Recycle Bin or a quarantine folder — never a
  hard delete** — with an undo manifest written alongside
- optionally merge the loser's tags/artwork into the keeper before removal

### F3. Waveform preview
Generate peak/RMS waveforms (decoded once, peaks cached in the same sqlite
database) shown in the player strip and inside duplicate groups — two candidates
drawn one above the other makes "same master, different length" obvious at a
glance. It also exposes song structure (intro / breakdown / drop) well enough to
be useful during genre passes.

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

### F5. Rekordbox cue import
Read **memory cues, hot cues, beat grid and BPM** from Rekordbox — via
`rekordbox.xml` (the supported export path) and, where present, the ANLZ
`.DAT`/`.EXT` analysis files beside the tracks. Drawn over the F3 waveform.
Stored in the app's own sidecar database keyed by **fingerprint, not path**, so
cues survive renames and moves.

Longer-term goal: a neutral cue model that can be written back out to Rekordbox
/ Serato / Traktor so a library survives switching software. **This release only
reads and preserves — no writing back.**

### F6. Simple backup archive
Deliberately minimal: pick the selection or the whole collection → produce a
**store-only ZIP** (compression level 0 — audio doesn't compress, and storing
keeps it fast and byte-exact) with a generated name:

```
MusicTagCleaner-backup-2026-09-02-1432-412-tracks.zip
```

Size estimate before starting, progress bar during, reveal in Explorer when
done. A small `manifest.json` inside lists paths, sizes and hashes so the
archive can be verified later. No scheduling, no incremental logic, no cloud —
the user moves the file somewhere safe themselves.

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

- Does a local database become the source of truth (sqlite: fingerprints,
  waveform peaks, cues, playlists), or does the app stay stateless over the
  files? F1 / F3 / F5 all effectively require it — worth deciding **before**
  starting v0.8, since it changes the shape of everything after it.
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
- (add items here)
