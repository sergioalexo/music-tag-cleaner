import { describe, expect, it } from "vitest";
import type { AudioFile, PlaylistEntry, TagData } from "../types";
import { matchPlaylist } from "./ytMatch";

/**
 * A stand-in for the user's real collection: 4,149 tracks matched against a
 * 70-entry playlist, which is what actually made the UI stall for seconds.
 * This is a guard, not a microbenchmark — it fails if matching regresses to
 * the point of being unusable again, and prints the real number so a change
 * in either direction is visible.
 */
const ARTISTS = [
  "Boris Brejcha", "Rihanna", "Cascada", "Pitbull", "Calvin Harris", "Fred again..",
  "Anna Asti", "Dzidzio", "Alexandra Stan", "Tale Of Us", "Kolsch", "Solomun",
  "Amelie Lens", "Charlotte de Witte", "Adam Beyer", "Nina Kraviz", "Jamie Jones",
];
const WORDS = [
  "Gravity", "Disturbia", "Summer", "Delilah", "Midnight", "Horizon", "Echoes",
  "Parallel", "Neon", "Velvet", "Cascade", "Fragments", "Lucid", "Mirage",
  "Pulse", "Drift", "Static", "Aurora", "Ember", "Solstice",
];

function makeCollection(n: number): { files: AudioFile[]; tags: Record<string, TagData> } {
  const files: AudioFile[] = [];
  const tags: Record<string, TagData> = {};
  for (let i = 0; i < n; i++) {
    const artist = ARTISTS[i % ARTISTS.length];
    const title = `${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]}`;
    const path = `C:/music/${i}-${artist}-${title}.mp3`.replace(/\s+/g, "-");
    files.push({
      path,
      filename: path.split("/").pop()!,
      format: "mp3",
      size: 1,
      hasBackup: false,
      durationSecs: 180 + (i % 200),
    });
    tags[path] = {
      hasCoverArt: false,
      allFields: {},
      artist,
      title,
      genre: "Techno",
      composer: `${artist} - ${title} | | ${artist} | | ${title} | | 2019`,
    };
  }
  return { files, tags };
}

function makePlaylist(n: number, files: AudioFile[], tags: Record<string, TagData>): PlaylistEntry[] {
  const entries: PlaylistEntry[] = [];
  for (let i = 0; i < n; i++) {
    // Half are real tracks from the collection (bare title, as YouTube Music
    // gives them), half are things that aren't there at all.
    const real = i % 2 === 0;
    const src = files[(i * 37) % files.length];
    const t = tags[src.path];
    entries.push({
      index: i,
      videoId: `v${i}`,
      url: `https://music.youtube.com/watch?v=v${i}`,
      title: real ? (t.title ?? "") : `Nothing Like This ${i}`,
      durationSecs: real ? src.durationSecs : 200,
      uploader: null,
    });
  }
  return entries;
}

describe("matchPlaylist performance", () => {
  it("matches a 70-track playlist against 4,149 tracks quickly", () => {
    const { files, tags } = makeCollection(4149);
    const entries = makePlaylist(70, files, tags);

    const started = performance.now();
    const result = matchPlaylist(entries, files, tags);
    const ms = performance.now() - started;

    // eslint-disable-next-line no-console
    console.log(`  matchPlaylist: 70 x ${files.length} in ${ms.toFixed(0)}ms`);

    expect(result).toHaveLength(70);
    expect(result.some((m) => m.status !== "missing")).toBe(true);
    // A regression guard, not a tight budget. The exhaustive, re-normalizing
    // version of this took 15,700ms; it now runs in roughly 350-550ms, so
    // anything past 2s means a real regression rather than a slow machine.
    expect(ms).toBeLessThan(2000);
  });
});
