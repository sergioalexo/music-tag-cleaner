export interface ShortcutAction {
  id: string;
  label: string;
  /** Default key combo, e.g. "Ctrl+O", "Ctrl+Shift+Z". */
  defaultKey: string;
}

export const SHORTCUTS: ShortcutAction[] = [
  { id: "selectFolder", label: "Select folder", defaultKey: "Ctrl+O" },
  { id: "selectAll", label: "Highlight all tracks", defaultKey: "Ctrl+A" },
  { id: "undo", label: "Undo", defaultKey: "Ctrl+Z" },
  { id: "redo", label: "Redo", defaultKey: "Ctrl+Shift+Z" },
  { id: "find", label: "Find in table", defaultKey: "Ctrl+F" },
];

/** Resolves the active key combo for an action: a custom override, or its default. */
export function shortcutFor(id: string, overrides: Record<string, string>): string {
  return overrides[id] || SHORTCUTS.find((s) => s.id === id)?.defaultKey || "";
}

/** Builds the "Ctrl+Shift+Z"-style combo string for a keydown event. */
export function comboFromEvent(e: KeyboardEvent | React.KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (!["Control", "Shift", "Alt", "Meta"].includes(e.key)) parts.push(key);
  return parts.join("+");
}

/** True if `e` matches the resolved combo for action `id`. */
export function matchesShortcut(
  e: KeyboardEvent,
  id: string,
  overrides: Record<string, string>,
): boolean {
  return comboFromEvent(e) === shortcutFor(id, overrides);
}
