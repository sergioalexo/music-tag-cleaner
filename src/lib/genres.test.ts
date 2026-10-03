import { describe, expect, it } from "vitest";
import type { GenreCount, TagData } from "../types";
import { detectGenreGroups, libraryGenreNames } from "./genres";

function tag(genre?: string): TagData {
  return { hasCoverArt: false, allFields: {}, genre };
}

describe("libraryGenreNames", () => {
  const indexed: GenreCount[] = [
    { name: "Techno", count: 120 },
    { name: "House Melodic", count: 40 },
  ];

  it("orders by how much the collection actually uses each genre", () => {
    expect(libraryGenreNames(indexed, {})).toEqual(["Techno", "House Melodic"]);
  });

  it("includes a genre typed on a loaded track that the index has not seen yet", () => {
    const names = libraryGenreNames(indexed, { "a.mp3": tag("Techno Hard") });
    expect(names).toContain("Techno Hard");
    // Still ranked below the ones the collection leans on.
    expect(names.indexOf("Techno")).toBeLessThan(names.indexOf("Techno Hard"));
  });

  it("ignores blank and whitespace-only genres", () => {
    const names = libraryGenreNames(indexed, { "a.mp3": tag("   "), "b.mp3": tag(undefined) });
    expect(names).toEqual(["Techno", "House Melodic"]);
  });

  it("does not double-count a loaded track the index already knows about", () => {
    const names = libraryGenreNames(indexed, { "a.mp3": tag("Techno") });
    expect(names.filter((n) => n === "Techno")).toHaveLength(1);
  });

  it("returns nothing when there is no collection yet, rather than inventing a taxonomy", () => {
    expect(libraryGenreNames([], {})).toEqual([]);
  });

  it("offers every Library genre even when the open batch lives outside the Library folder", () => {
    // Workstream A5: opening a batch from e.g. Downloads must never hide the
    // Library's genre vocabulary — `libraryGenreNames` takes the indexed
    // tally and the loaded tracks' tags as plain inputs, with no notion of
    // "where" either one lives, so a batch opened from anywhere still sees
    // the full Library list plus whatever it adds on top.
    const batchTags: Record<string, TagData> = {
      "C:/Users/sopas/Downloads/new-rip.mp3": tag("Downloads-Only Genre"),
    };
    const names = libraryGenreNames(indexed, batchTags);
    for (const g of indexed) expect(names).toContain(g.name);
    expect(names).toContain("Downloads-Only Genre");
  });
});

describe("detectGenreGroups", () => {
  it("groups spellings that differ only by case, separator or and/&", () => {
    const groups = detectGenreGroups(["Hip-Hop", "Hip Hop", "hip hop", "Techno"]);
    const hiphop = groups.find((g) => g.count === 3);
    expect(hiphop).toBeDefined();
    expect(hiphop!.variants.map((v) => v.name).sort()).toEqual(["Hip Hop", "Hip-Hop", "hip hop"]);
    // The most common raw spelling is the one suggested to keep.
    expect(hiphop!.canonical).toBe("Hip-Hop");
  });

  it("keeps genuinely different genres apart", () => {
    const groups = detectGenreGroups(["Techno", "Techno Melodic"]);
    expect(groups).toHaveLength(2);
  });
});
