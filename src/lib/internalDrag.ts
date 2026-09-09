/**
 * True while an in-page drag (currently: table column reordering) is in
 * progress.
 *
 * On Windows, Tauri's window-level `onDragDropEvent` fires for *any* drag
 * gesture over the webview — not just an external OS file drag — because it
 * hooks WebView2's drag events at the host level. Without this flag, dragging
 * a column header to reorder it also flips `dropActive` in App.tsx, which
 * paints the full-screen "Drop audio files or folders to add them" overlay
 * over the table mid-drag, making it look like the app mistook the column
 * drag for a file drop.
 *
 * Column reordering itself no longer uses HTML5 drag-and-drop — Tauri's own
 * OS drop target swallowed the `drop` event, so it runs on plain mouse events
 * now (see TrackTable's `startColumnDrag`) and this event never fires for it.
 * The flag is still set during the drag: it costs nothing and keeps the guard
 * honest for any in-page drag that does go through the OS path.
 *
 * A plain mutable object (not React state) so the drag handlers in
 * TrackTable can flip it synchronously without a render round-trip, and
 * App.tsx's event listener — set up once, outside React's render cycle — can
 * read the current value without being re-subscribed on every change.
 */
export const internalDrag = { active: false };
