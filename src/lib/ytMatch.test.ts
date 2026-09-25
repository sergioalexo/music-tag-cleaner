import { describe, expect, it } from "vitest";
import type { AudioFile, PlaylistEntry, TagData } from "../types";
import {
  buildIdentity,
  buildWanted,
  CONFIDENT_THRESHOLD,
  matchPlaylist,
  parseSearchableBackup,
  prepare,
  preparedTextSimilarity,
  splitArtistTitle,
  stringSimilarity,
  textSimilarity,
  tokenSimilarity,
  versionSignature,
} from "./ytMatch";

function file(path: string, durationSecs?: number): AudioFile {
  return {
    path,
    filename: path.split(/[\\/]/).pop() ?? path,
    format: "mp3",
    size: 1,
    hasBackup: false,
    durationSecs,
  };
}

function tag(partial: Partial<TagData>): TagData {
  return { hasCoverArt: false, allFields: {}, ...partial };
}

function entry(
  index: number,
  title: string,
  durationSecs?: number,
  uploader?: string,
  artist?: string,
): PlaylistEntry {
  return {
    index,
    videoId: `v${index}`,
    url: `https://music.youtube.com/watch?v=v${index}`,
    title,
    durationSecs,
    uploader,
    artist,
  };
}

describe("parseSearchableBackup", () => {
  it("parses the four-slot backup the app writes", () => {
    const parsed = parseSearchableBackup("01 track_final | | Boris Brejcha | | Gravity | | 2019");
    expect(parsed).toEqual({
      stem: "01 track_final",
      artist: "Boris Brejcha",
      title: "Gravity",
      year: "2019",
    });
  });

  it("ignores an ordinary Comment/Composer value that is not a backup", () => {
    expect(parseSearchableBackup("Ripped from vinyl, 2019")).toBeNull();
    expect(parseSearchableBackup("")).toBeNull();
    expect(parseSearchableBackup(undefined)).toBeNull();
  });
});

describe("splitArtistTitle", () => {
  it("splits on a dash and strips official-video noise", () => {
    expect(splitArtistTitle("Fred again.. - Delilah (Official Video)")).toEqual({
      artist: "Fred again..",
      title: "Delilah",
    });
  });

  it("leaves an unsplittable title whole", () => {
    expect(splitArtistTitle("Delilah")).toEqual({ artist: null, title: "Delilah" });
  });
});

describe("buildWanted — artist source priority", () => {
  it("prefers structured metadata over the title split and the channel", () => {
    const w = buildWanted(entry(0, "Some Video Title", undefined, "Some Channel - Topic", "Real Artist"));
    expect(w.artist).toBe("Real Artist");
    expect(w.artistSource).toBe("metadata");
  });

  it("falls back to splitting the title when there's no metadata artist", () => {
    const w = buildWanted(entry(0, "Boris Brejcha - Gravity", undefined, "Some Channel"));
    expect(w.artist).toBe("Boris Brejcha");
    expect(w.artistSource).toBe("title");
  });

  it("falls back to the uploading channel, flagged as a guess, when the title has no split", () => {
    const w = buildWanted(entry(0, "Gravity", undefined, "Boris Brejcha - Topic"));
    expect(w.artist).toBe("Boris Brejcha");
    expect(w.artistSource).toBe("channel");
  });

  it("has no artist at all when nothing is available", () => {
    const w = buildWanted(entry(0, "Gravity"));
    expect(w.artist).toBeNull();
    expect(w.artistSource).toBeNull();
  });
});

describe("versionSignature", () => {
  it("keeps the remixer's name and drops generic filler", () => {
    // "remix" itself is kept: a bare "(Remix)" really is a different
    // recording from the original, so it should still count against a file
    // that claims no version at all. "(Original Mix)" is pure filler.
    expect([...versionSignature("Gravity (Tale Of Us Remix)")]).toEqual(["tale", "of", "us", "remix"]);
    expect([...versionSignature("Gravity (Original Mix)")]).toEqual([]);
    expect([...versionSignature("Gravity (Extended Mix)")]).toEqual(["extended"]);
    expect([...versionSignature("Gravity")]).toEqual([]);
  });

  it("reads a version stated after a second dash", () => {
    expect([...versionSignature("Artist - Gravity - Kolsch Remix")]).toContain("kolsch");
  });
});

describe("textSimilarity", () => {
  it("is order-insensitive enough to survive a swapped artist/title", () => {
    expect(textSimilarity("Boris Brejcha Gravity", "Gravity Boris Brejcha")).toBeGreaterThan(0.95);
  });

  it("tolerates an extra featured artist", () => {
    expect(textSimilarity("Calvin Harris Summer", "Calvin Harris feat. Example Summer")).toBeGreaterThan(0.8);
  });
});

/**
 * The fast path skips the edit-distance DP whenever a character-histogram
 * bound proves it cannot beat the token score. That is only sound if the
 * answer is bit-for-bit identical to computing both and taking the max, so
 * this checks it against a naive implementation over adversarial inputs:
 * anagrams (identical histograms, different order), single-character typos,
 * shared prefixes, and disjoint strings.
 */
describe("textSimilarity pruning", () => {
  const naive = (a: string, b: string) => Math.max(stringSimilarity(a, b), tokenSimilarity(a, b));

  const CASES: [string, string][] = [
    ["", ""],
    ["", "gravity"],
    ["gravity", "gravity"],
    ["gravity", "gravty"],
    ["gravity", "ytivarg"],
    ["boris brejcha gravity", "gravity boris brejcha"],
    ["disturbia", "rihanna disturbia"],
    ["rihanna disturbia", "disturbia"],
    ["evacuate the dancefloor", "cascada evacuate the dancefloor"],
    ["metallica enter sandman", "boris brejcha gravity"],
    ["aaaa", "aaab"],
    ["abc def", "def abc"],
    ["a", "b"],
    ["the the the", "the"],
    ["hotel room service", "pitbull hotel room service"],
    ["calvin harris summer", "calvin harris feat example summer"],
  ];

  it("returns exactly what the unpruned definition returns", () => {
    for (const [a, b] of CASES) {
      expect(textSimilarity(a, b)).toBeCloseTo(naive(a, b), 12);
      // Symmetry matters too: the bound uses max(da, db), not one direction.
      expect(textSimilarity(b, a)).toBeCloseTo(naive(b, a), 12);
    }
  });

  it("is unaffected by the caller's minUseful floor when the result clears it", () => {
    // A floor only ever licenses returning a lower bound for results that
    // fall below it; anything at or above must still be exact.
    for (const [a, b] of CASES) {
      const exact = textSimilarity(a, b);
      for (const floor of [0, 0.3, 0.6, 0.87, 1]) {
        const v = preparedTextSimilarity(prepare(a), prepare(b), floor);
        if (exact >= floor) expect(v).toBeCloseTo(exact, 12);
        else expect(v).toBeLessThanOrEqual(exact + 1e-12);
      }
    }
  });

  it("agrees with the unpruned definition on random strings", () => {
    const alphabet = "abcdefg hij";
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const str = () => {
      const n = 1 + Math.floor(rnd() * 18);
      let out = "";
      for (let i = 0; i < n; i++) out += alphabet[Math.floor(rnd() * alphabet.length)];
      return out;
    };
    for (let i = 0; i < 2000; i++) {
      const a = str();
      const b = str();
      expect(textSimilarity(a, b)).toBeCloseTo(naive(a, b), 12);
    }
  });
});

describe("buildIdentity", () => {
  it("compares against tags, filename and the searchable backup", () => {
    const id = buildIdentity(
      file("C:/music/01-gravity_clean.mp3", 400),
      tag({
        artist: "Boris Brejcha",
        title: "Gravity",
        originalArtist: "BorisBrejcha-Gravity(ExtendedMix) | | Boris Brejcha | | Gravity | | 2019",
      }),
    );
    const vias = id.texts.map((t) => t.via);
    expect(vias).toContain("tags");
    expect(vias).toContain("filename");
    expect(vias).toContain("backup");
  });
});

describe("matchPlaylist", () => {
  it("auto-accepts a confident match and reports how it was found", () => {
    const files = [file("C:/music/gravity.mp3", 402)];
    const tags = { "C:/music/gravity.mp3": tag({ artist: "Boris Brejcha", title: "Gravity" }) };
    const [m] = matchPlaylist([entry(0, "Boris Brejcha - Gravity", 400)], files, tags);
    expect(m.status).toBe("matched");
    expect(m.candidates[0].path).toBe("C:/music/gravity.mp3");
    expect(m.candidates[0].via).toBe("tags");
  });

  it("does not confuse two different remixes of the same track", () => {
    const original = file("C:/music/gravity-original.mp3", 402);
    const remix = file("C:/music/gravity-tale-of-us.mp3", 480);
    const files = [original, remix];
    const tags = {
      [original.path]: tag({ artist: "Boris Brejcha", title: "Gravity (Original Mix)" }),
      [remix.path]: tag({ artist: "Boris Brejcha", title: "Gravity (Tale Of Us Remix)" }),
    };
    const matches = matchPlaylist(
      [
        entry(0, "Boris Brejcha - Gravity (Tale Of Us Remix)", 478),
        entry(1, "Boris Brejcha - Gravity", 400),
      ],
      files,
      tags,
    );
    expect(matches[0].candidates[0].path).toBe(remix.path);
    expect(matches[1].candidates[0].path).toBe(original.path);
  });

  it("never lets one file back two playlist entries", () => {
    const only = file("C:/music/gravity.mp3", 402);
    const tags = { [only.path]: tag({ artist: "Boris Brejcha", title: "Gravity" }) };
    const matches = matchPlaylist(
      [entry(0, "Boris Brejcha - Gravity", 402), entry(1, "Boris Brejcha - Gravity", 402)],
      [only],
      tags,
    );
    const claimed = matches.filter((m) => m.status !== "missing").map((m) => m.candidates[0].path);
    expect(claimed).toHaveLength(1);
    expect(matches.some((m) => m.status === "missing")).toBe(true);
  });

  it("matches a track whose tags were wiped, using its searchable backup", () => {
    const f = file("C:/music/track01.mp3", 402);
    const tags = {
      [f.path]: tag({
        title: "track01",
        composer: "BorisBrejcha - Gravity | | Boris Brejcha | | Gravity | | 2019",
      }),
    };
    const [m] = matchPlaylist([entry(0, "Boris Brejcha - Gravity", 402)], [f], tags);
    expect(m.status).not.toBe("missing");
    expect(m.candidates[0].via).toBe("backup");
  });

  it("matches from the filename when there are no tags at all", () => {
    const f = file("C:/music/Boris Brejcha - Gravity.mp3", 402);
    const [m] = matchPlaylist([entry(0, "Boris Brejcha - Gravity", 402)], [f], {});
    expect(m.status).toBe("matched");
    expect(m.candidates[0].via).toBe("filename");
  });

  it("reports an unrelated entry as missing rather than forcing a match", () => {
    const f = file("C:/music/gravity.mp3", 402);
    const tags = { [f.path]: tag({ artist: "Boris Brejcha", title: "Gravity" }) };
    const [m] = matchPlaylist([entry(0, "Metallica - Enter Sandman", 331)], [f], tags);
    expect(m.status).toBe("missing");
  });

  /**
   * The case that motivated the title-only comparison. A real YouTube Music
   * playlist ("(Dance) Wedding Music", 70 tracks) gave bare titles with no
   * uploader, so every entry had no artist. Scored against the library's
   * "artist title" the correct matches landed at 59-86% and *nothing*
   * auto-accepted — the artist tokens the entry could never have supplied
   * were counted against it.
   */
  it("auto-matches a bare title with no artist against the right track", () => {
    const f = file("C:/music/rihanna-disturbia.mp3", 238);
    const tags = { [f.path]: tag({ artist: "Rihanna", title: "Disturbia" }) };
    const [m] = matchPlaylist([entry(0, "Disturbia", 238)], [f], tags);
    expect(m.candidates[0].score).toBeGreaterThan(CONFIDENT_THRESHOLD);
    expect(m.status).toBe("matched");
  });

  it("still prefers the track whose artist also agrees", () => {
    const cascada = file("C:/music/cascada.mp3", 200);
    const cover = file("C:/music/cover.mp3", 200);
    const tags = {
      [cascada.path]: tag({ artist: "Cascada", title: "Evacuate The Dancefloor" }),
      [cover.path]: tag({ artist: "Someone Else", title: "Evacuate The Dancefloor" }),
    };
    const [m] = matchPlaylist(
      [entry(0, "Cascada - Evacuate the Dancefloor", 200)],
      [cascada, cover],
      tags,
    );
    expect(m.candidates[0].path).toBe(cascada.path);
  });

  /** A title-only entry must not become a licence to match anything. */
  it("does not let a bare title match an unrelated track", () => {
    const f = file("C:/music/gravity.mp3", 402);
    const tags = { [f.path]: tag({ artist: "Boris Brejcha", title: "Gravity" }) };
    const [m] = matchPlaylist([entry(0, "Enter Sandman", 331)], [f], tags);
    expect(m.status).toBe("missing");
  });

  it("offers alternates to step through when several mixes could fit", () => {
    const a = file("C:/music/gravity-a.mp3", 402);
    const b = file("C:/music/gravity-b.mp3", 405);
    const tags = {
      [a.path]: tag({ artist: "Boris Brejcha", title: "Gravity" }),
      [b.path]: tag({ artist: "Boris Brejcha", title: "Gravity (Extended Mix)" }),
    };
    const [m] = matchPlaylist([entry(0, "Boris Brejcha - Gravity", 402)], [a, b], tags);
    expect(m.candidates.length).toBeGreaterThan(1);
  });
});
