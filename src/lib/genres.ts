import type { GenrePreset } from "../types";

/** Ships with the user's own library taxonomy as the first preset. */
export const DEFAULT_GENRE_PRESETS: GenrePreset[] = [
  {
    name: "Sergio Alexo",
    genres: [
      "House Melodic",
      "House Tech",
      "Techno",
      "Techno Melodic",
      "Techno Hard",
      "Pop",
    ],
  },
  {
    name: "Standard",
    genres: [
      "Pop",
      "Rock",
      "Hip-Hop",
      "R&B",
      "Reggaeton",
      "House",
      "Techno",
      "Trance",
      "Electronic",
      "Dance",
      "Latin",
      "Reggae",
      "Indie",
      "Alternative",
    ],
  },
];

export function activePreset(
  presets: GenrePreset[],
  activeName: string,
): GenrePreset | undefined {
  return presets.find((p) => p.name === activeName) ?? presets[0];
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
