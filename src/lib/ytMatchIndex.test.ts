import { describe, expect, it } from "vitest";
import type { AudioFile, PlaylistEntry, TagData } from "../types";
import { matchPlaylist } from "./ytMatch";

/**
 * The shortlist is the one part of matching that could silently lose a
 * result: it decides which tracks an entry is even compared against. So it
 * is checked against the exhaustive scan it replaced, over a collection the
 * size of the user's real one, with the awkward cases deliberately included.
 *
 * The contract it must hold is **decision equivalence**, not identity: every
 * status, every assignment, and every candidate at or above
 * `AMBIGUOUS_THRESHOLD` must be exactly what the full scan produces. Below
 * that the candidate list is padding for the carousel, and the shortlist may
 * legitimately drop a track scraping the floor — measured worst case 0.31,
 * against entries that are missing either way. Asserting full equality would
 * be asserting something untrue.
 */
const AMBIGUOUS = 0.52;

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

function file(path: string, durationSecs: number): AudioFile {
  return { path, filename: path.split("/").pop()!, format: "mp3", size: 1, hasBackup: false, durationSecs };
}
function tag(p: Partial<TagData>): TagData {
  return { hasCoverArt: false, allFields: {}, ...p };
}

function corpus(n: number) {
  const files: AudioFile[] = [];
  const tags: Record<string, TagData> = {};
  for (let i = 0; i < n; i++) {
    const artist = ARTISTS[i % ARTISTS.length];
    const title = `${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]}`;
    const path = `C:/music/${i}-${artist}-${title}.mp3`.replace(/\s+/g, "-");
    files.push(file(path, 180 + (i % 200)));
    tags[path] = tag({
      artist,
      title,
      genre: "Techno",
      composer: `${artist} - ${title} | | ${artist} | | ${title} | | 2019`,
    });
  }
  return { files, tags };
}

function entry(index: number, title: string, durationSecs?: number, uploader?: string | null): PlaylistEntry {
  return { index, videoId: `v${index}`, url: "", title, durationSecs, uploader: uploader ?? null };
}

/** Everything a match decision depends on. */
function decisions(ms: ReturnType<typeof matchPlaylist>) {
  return ms.map((m) => ({
    videoId: m.entry.videoId,
    status: m.status,
    // The assigned track, which is what export and the badge read.
    assigned: m.status === "missing" ? null : (m.candidates[0]?.path ?? null),
    // Every candidate strong enough to be offered as a real alternative.
    strong: m.candidates
      .filter((c) => c.score >= AMBIGUOUS)
      .map((c) => ({ path: c.path, score: Number(c.score.toFixed(9)), via: c.via })),
  }));
}

function expectSameDecisions(entries: PlaylistEntry[], files: AudioFile[], tags: Record<string, TagData>) {
  const viaIndex = matchPlaylist(entries, files, tags);
  const exhaustive = matchPlaylist(entries, files, tags, { exhaustive: true });
  expect(decisions(viaIndex)).toEqual(decisions(exhaustive));
}

/**
 * Every case here runs the exhaustive scan as its reference, which is the
 * slow path this whole change exists to avoid — seconds, by design. The
 * default 5s budget is not the point of these tests, so it is lifted rather
 * than shrinking the corpus, because matching at the real collection size is
 * exactly what is being checked.
 */
const SLOW = 60_000;

describe("collection index", () => {
  const { files, tags } = corpus(4149);

  it("finds everything the exhaustive scan does, on a full-size collection", () => {
    const entries: PlaylistEntry[] = [];
    let i = 0;
    // Exact titles, bare (no artist) — the common YouTube Music shape.
    for (; i < 20; i++) {
      const src = files[(i * 37) % files.length];
      entries.push(entry(i, tags[src.path].title!, src.durationSecs));
    }
    // "Artist - Title" form.
    for (; i < 35; i++) {
      const src = files[(i * 53) % files.length];
      const t = tags[src.path];
      entries.push(entry(i, `${t.artist} - ${t.title}`, src.durationSecs));
    }
    // Remixes and version qualifiers.
    for (; i < 45; i++) {
      const src = files[(i * 71) % files.length];
      const t = tags[src.path];
      entries.push(entry(i, `${t.artist} - ${t.title} (Tale Of Us Remix)`, src.durationSecs));
    }
    // Nothing in the collection at all.
    for (; i < 55; i++) entries.push(entry(i, `Completely Absent Track ${i}`, 200));
    // Uploader-supplied artist, " - Topic" style.
    for (; i < 65; i++) {
      const src = files[(i * 97) % files.length];
      const t = tags[src.path];
      entries.push(entry(i, t.title!, src.durationSecs, `${t.artist} - Topic`));
    }

    expectSameDecisions(entries, files, tags);
  }, SLOW);

  it("still finds a track when the entry misspells it", () => {
    // Typos after the opening letters, which is what the prefix bucket is for.
    const typos = [
      "Gravity Disturbia",
      "Gravty Disturbia",
      "Gravity Disturbya",
      "Gravitty Disturbia",
      "Boris Brejcha - Gravity Neon",
      "Boris Brejhca - Gravity Neon",
    ];
    expectSameDecisions(typos.map((t, i) => entry(i, t, 200)), files, tags);
  }, SLOW);

  it("agrees on entries made only of very common words", () => {
    // A worst case for an inverted index: every key has a huge posting list.
    const entries = ["Summer", "Neon Neon", "Pulse", "Static Drift"].map((t, i) =>
      entry(i, t, 200),
    );
    expectSameDecisions(entries, files, tags);
  }, SLOW);

  it("agrees when the collection has no usable tags at all", () => {
    const bare = files.slice(0, 500);
    expectSameDecisions([entry(0, "Gravity Disturbia", 200), entry(1, "Nothing Here", 200)], bare, {});
  }, SLOW);
});
