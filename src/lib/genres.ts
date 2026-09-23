import type { GenreCount, TagData } from "../types";

/**
 * The genre vocabulary is **whatever the collection already uses** — there is
 * no stored preset list any more.
 *
 * A remembered list is wrong in both directions: it offers genres no track
 * carries, and it misses ones that were typed straight into a track and
 * never added back. Deriving it from the indexed library means the picker
 * can't drift from the files, and renaming a genre is a real operation on
 * the collection rather than an edit to a list that the files never hear
 * about.
 */

/**
 * Merges the indexed genre tally with the genres on the currently loaded
 * tracks, so a genre typed a minute ago is offered before the next re-index.
 * Ordered by how much the collection actually uses each one.
 */
export function libraryGenreNames(
  indexed: GenreCount[],
  loadedTags: Record<string, TagData>,
): string[] {
  const counts = new Map<string, number>();
  for (const g of indexed) {
    const name = g.name.trim();
    if (name) counts.set(name, (counts.get(name) ?? 0) + g.count);
  }
  for (const t of Object.values(loadedTags)) {
    const name = t.genre?.trim();
    if (!name) continue;
    // A loaded track already counted in the index would double-count; the
    // exact number doesn't matter here, only the ordering, and a genre in
    // active use ranking slightly higher is the behaviour we want anyway.
    if (!counts.has(name)) counts.set(name, 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);
}

/** Group of near-duplicate genre spellings found in the collection. */
export interface GenreGroup {
  /** The most common raw spelling in the group — suggested as the one to keep. */
  canonical: string;
  /** Total tracks across every variant in the group. */
  count: number;
  /** Every distinct raw spelling that normalized into this group, most common first. */
  variants: { name: string; count: number }[];
}

/**
 * Folds a genre string down to a normalized key so near-duplicate spellings
 * collapse together: case, "&" vs "and", and "-"/space as interchangeable
 * word separators. Deliberately loose — it's used only to *group* raw
 * values for review, never to silently rewrite anything.
 */
function normalizeGenreKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[-\s]+/g, " ")
    .trim();
}

/**
 * Tallies every distinct genre value across `genres` (typically every
 * loaded track's `TagData.genre`), grouping near-duplicate spellings
 * together via `normalizeGenreKey`. Returns groups sorted by total count,
 * each variant sorted by its own count — so the most common raw spelling is
 * always `variants[0]` and becomes `canonical`.
 */
export function detectGenreGroups(genres: (string | undefined | null)[]): GenreGroup[] {
  // normalized key -> raw spelling -> count
  const byKey = new Map<string, Map<string, number>>();
  for (const raw of genres) {
    const trimmed = raw?.trim();
    if (!trimmed) continue;
    const key = normalizeGenreKey(trimmed);
    if (!key) continue;
    const variants = byKey.get(key) ?? new Map<string, number>();
    variants.set(trimmed, (variants.get(trimmed) ?? 0) + 1);
    byKey.set(key, variants);
  }
  const groups: GenreGroup[] = [];
  for (const variantCounts of byKey.values()) {
    const variants = [...variantCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    groups.push({
      canonical: variants[0].name,
      count: variants.reduce((sum, v) => sum + v.count, 0),
      variants,
    });
  }
  return groups.sort((a, b) => b.count - a.count);
}
