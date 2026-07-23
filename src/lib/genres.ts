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
