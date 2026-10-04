/**
 * Pure rules for the Library's session source and genre clicks. Kept out of
 * the hooks so the decision tree is unit-testable without React or Tauri.
 */

/** How the current batch was built. */
export type SessionSource =
  | { kind: "empty" }
  | { kind: "genre"; genre: string } // loaded from the library sidebar
  | { kind: "manual" }; // folder / files / drop / Open with / YouTube "Add to batch"

export const EMPTY_SOURCE: SessionSource = { kind: "empty" };
export const MANUAL_SOURCE: SessionSource = { kind: "manual" };

/**
 * Source after files are added by hand. Always `manual`: the user has now
 * built the batch themselves, so a genre session that gets an extra file
 * dropped on it no longer counts as "just a genre" and must not be replaced
 * silently by the next genre click.
 */
export function afterManualAdd(_prev: SessionSource): SessionSource {
  return MANUAL_SOURCE;
}

/** What a click on a library genre should do. */
export type GenreClickAction =
  /** Swap the batch to the genre right away. */
  | "load"
  /** Same, but an unapplied preview would be discarded, so confirm first. */
  | "confirm-load"
  /** A hand-built batch: the caller must decide (filter for now, a dialog later). */
  | "manual";

export function decideGenreClick(opts: {
  source: SessionSource;
  /** An AI/Standardize/Clear preview that hasn't been applied or cancelled. */
  hasUnappliedPreview: boolean;
}): GenreClickAction {
  if (opts.source.kind === "manual") return "manual";
  return opts.hasUnappliedPreview ? "confirm-load" : "load";
}
