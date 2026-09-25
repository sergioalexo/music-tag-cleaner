import { describe, expect, it } from "vitest";
import type { CharReplacement } from "../types";
import {
  applyCapitalization,
  applyReplacements,
  buildRenameStem,
  formatTrackId,
  hasWeirdChars,
  isUid,
  markWeird,
  removeCharsFrom,
  safeTrackIdDigits,
  sanitizeForFilename,
  sanitizeForFilenameStrict,
} from "./standardize";

describe("applyReplacements", () => {
  const rule = (from: string, to: string, opts: Partial<CharReplacement> = {}): CharReplacement => ({
    from,
    to,
    enabled: true,
    ...opts,
  });

  it("replaces every occurrence of an enabled rule", () => {
    expect(applyReplacements("Rock & Roll & Blues", [rule("&", "N")])).toBe("Rock N Roll N Blues");
  });

  it("skips a disabled rule", () => {
    expect(applyReplacements("Rock & Roll", [rule("&", "N", { enabled: false })])).toBe("Rock & Roll");
  });

  it("skips a rule with an empty `from`", () => {
    expect(applyReplacements("Rock & Roll", [rule("", "N")])).toBe("Rock & Roll");
  });

  it("is case-insensitive when caseSensitive is explicitly false", () => {
    expect(applyReplacements("FEAT. and feat.", [rule("feat.", "ft.", { caseSensitive: false })])).toBe(
      "ft. and ft.",
    );
  });

  it("is case-sensitive (literal) by default", () => {
    expect(applyReplacements("FEAT. and feat.", [rule("feat.", "ft.")])).toBe("FEAT. and ft.");
  });

  it("collapses whitespace left behind by a replacement", () => {
    expect(applyReplacements("A & B", [rule("&", " ")])).toBe("A B");
  });
});

describe("removeCharsFrom", () => {
  it("removes every listed character and collapses the resulting spaces", () => {
    expect(removeCharsFrom("Song (Radio Edit)!", "()!")).toBe("Song Radio Edit");
  });

  it("returns the value unchanged when given no characters", () => {
    expect(removeCharsFrom("Song (Edit)", "")).toBe("Song (Edit)");
  });
});

describe("applyCapitalization", () => {
  it("uppercases everything for 'upper'", () => {
    expect(applyCapitalization("rivers flow in you", "upper")).toBe("RIVERS FLOW IN YOU");
  });

  it("lowercases everything for 'lower'", () => {
    expect(applyCapitalization("RIVERS FLOW IN YOU", "lower")).toBe("rivers flow in you");
  });

  it("leaves the value untouched for 'asis' (default branch)", () => {
    expect(applyCapitalization("rIvErS", "asis")).toBe("rIvErS");
  });

  describe("'sentence'", () => {
    it("capitalizes only the first letter, lowercasing the rest", () => {
      expect(applyCapitalization("RIVERS FLOW IN YOU", "sentence")).toBe("Rivers flow in you");
    });

    it("skips leading non-letters to find the first letter — the very first one in the string, not the first word", () => {
      expect(applyCapitalization("(intro) rivers", "sentence")).toBe("(Intro) rivers");
    });

    it("returns the lowercased value unchanged when there's no letter at all", () => {
      expect(applyCapitalization("123 !!", "sentence")).toBe("123 !!");
    });
  });

  describe("'title'", () => {
    it("capitalizes every word — no small-word lowercasing", () => {
      expect(applyCapitalization("rivers flow in you", "title")).toBe("Rivers Flow In You");
    });

    it("treats hyphens and slashes as word separators", () => {
      expect(applyCapitalization("rock-n-roll", "title")).toBe("Rock-N-Roll");
      expect(applyCapitalization("ac/dc", "title")).toBe("Ac/Dc");
    });

    it("keeps an already-uppercase Roman numeral as written", () => {
      expect(applyCapitalization("part III", "title")).toBe("Part III");
    });

    it("recases a lowercase Roman-numeral-shaped word normally — it only preserves one already uppercase", () => {
      expect(applyCapitalization("part iii", "title")).toBe("Part Iii");
    });

    it("keeps a short mixed-case initialism as written", () => {
      expect(applyCapitalization("DJ snake", "title")).toBe("DJ Snake");
    });

    it("keeps an already-uppercase, vowel-less initialism as written", () => {
      expect(applyCapitalization("MGMT live", "title")).toBe("MGMT Live");
    });

    it("recases a lowercase vowel-less token normally — only an already-uppercase run is kept", () => {
      expect(applyCapitalization("mgmt live", "title")).toBe("Mgmt Live");
    });

    it("does not treat an ordinary all-caps word as an initialism", () => {
      expect(applyCapitalization("i really LOVE this", "title")).toBe("I Really Love This");
    });

    it("recases every word, including short ones, when the whole value is shouting", () => {
      // Otherwise "IN" and "YOU" would be mistaken for initialisms.
      expect(applyCapitalization("RIVERS FLOW IN YOU", "title")).toBe("Rivers Flow In You");
    });

    it("recases a lowercase or mixed-case word normally", () => {
      expect(applyCapitalization("rIVERS", "title")).toBe("Rivers");
    });
  });
});

describe("hasWeirdChars / markWeird", () => {
  it("does not flag letters, numbers, spaces, or the default-allowed punctuation", () => {
    expect(hasWeirdChars("Boris Brejcha - Gravity (Extended Mix) 2019")).toBe(false);
  });

  it("flags a character outside the allowed set", () => {
    expect(hasWeirdChars("Song*")).toBe(true);
  });

  it("flags an allowed character when it's in the extra list", () => {
    expect(hasWeirdChars("Song (Edit)", "()")).toBe(true);
    expect(hasWeirdChars("Song Edit", "()")).toBe(false);
  });

  it("never flags whitespace even if listed as extra", () => {
    expect(hasWeirdChars("Song Edit", " ")).toBe(false);
  });

  it("splits a string into weird/non-weird runs", () => {
    expect(markWeird("Song*Edit")).toEqual([
      { text: "Song", weird: false },
      { text: "*", weird: true },
      { text: "Edit", weird: false },
    ]);
  });

  it("merges consecutive characters of the same weirdness into one run", () => {
    expect(markWeird("A**B")).toEqual([
      { text: "A", weird: false },
      { text: "**", weird: true },
      { text: "B", weird: false },
    ]);
  });
});

describe("sanitizeForFilename", () => {
  it("keeps letters, numbers and spaces; drops everything else", () => {
    expect(sanitizeForFilename('Song: "Title" (feat. X)!')).toBe("Song Title feat X");
  });

  it("keeps accented and Cyrillic letters", () => {
    expect(sanitizeForFilename("Beyoncé Мельница")).toBe("Beyoncé Мельница");
  });

  it("collapses runs of whitespace produced by stripped characters", () => {
    expect(sanitizeForFilename("A///B")).toBe("A B");
  });
});

describe("sanitizeForFilenameStrict", () => {
  it("folds accented Latin letters to plain ASCII", () => {
    expect(sanitizeForFilenameStrict("Beyoncé")).toBe("Beyonce");
    expect(sanitizeForFilenameStrict("Björk")).toBe("Bjork");
  });

  it("keeps Cyrillic letters unchanged rather than dropping them", () => {
    expect(sanitizeForFilenameStrict("Мельница")).toBe("Мельница");
  });

  it("does not corrupt й/ё the way naive NFKD folding of the whole string would", () => {
    // й = и + breve, ё = е + diaeresis under NFKD — folding blindly would
    // strip those combining marks and rewrite the letters.
    expect(sanitizeForFilenameStrict("Чайка")).toBe("Чайка");
    expect(sanitizeForFilenameStrict("Ёлка")).toBe("Ёлка");
  });

  it("turns punctuation/symbols into spaces so words don't run together", () => {
    expect(sanitizeForFilenameStrict("Song: (Radio Edit)!")).toBe("Song Radio Edit");
  });

  it("upper-cases the first letter even if the tag was all-lowercase", () => {
    expect(sanitizeForFilenameStrict("the weeknd")).toBe("The weeknd");
  });
});

describe("buildRenameStem", () => {
  it("joins artist, title and uid with ' - '", () => {
    expect(buildRenameStem("Boris Brejcha", "Gravity", "000123")).toBe("Boris Brejcha - Gravity - 000123");
  });

  it("drops empty parts without leaving a stray separator", () => {
    expect(buildRenameStem(undefined, "Gravity", undefined)).toBe("Gravity");
    expect(buildRenameStem("", "Gravity", "")).toBe("Gravity");
  });

  it("folds to ASCII in strict mode, keeps accents otherwise", () => {
    expect(buildRenameStem("Beyoncé", "Halo", undefined, false)).toBe("Beyoncé - Halo");
    expect(buildRenameStem("Beyoncé", "Halo", undefined, true)).toBe("Beyonce - Halo");
  });
});

describe("safeTrackIdDigits", () => {
  it("passes a normal value through", () => {
    expect(safeTrackIdDigits(6)).toBe(6);
  });

  it("clamps below 1 up to 1, and above 12 down to 12", () => {
    expect(safeTrackIdDigits(0)).toBe(1);
    expect(safeTrackIdDigits(-5)).toBe(1);
    expect(safeTrackIdDigits(99)).toBe(12);
  });

  it("falls back to 6 for a non-finite value", () => {
    expect(safeTrackIdDigits(NaN)).toBe(6);
    expect(safeTrackIdDigits(Infinity)).toBe(6);
  });

  it("floors a fractional value", () => {
    expect(safeTrackIdDigits(6.9)).toBe(6);
  });
});

describe("isUid", () => {
  it("is true for a value that is exactly `digits` digits long", () => {
    expect(isUid("000123", 6)).toBe(true);
  });

  it("is false for the wrong length, non-digits, or empty", () => {
    expect(isUid("12345", 6)).toBe(false);
    expect(isUid("00012a", 6)).toBe(false);
    expect(isUid(undefined, 6)).toBe(false);
    expect(isUid("", 6)).toBe(false);
  });

  it("trims surrounding whitespace before checking", () => {
    expect(isUid(" 000123 ", 6)).toBe(true);
  });
});

describe("formatTrackId", () => {
  it("zero-pads to the requested width", () => {
    expect(formatTrackId(42, 6)).toBe("000042");
  });

  it("wraps around at the max value for the width", () => {
    expect(formatTrackId(1_000_000, 6)).toBe("000000");
  });

  it("floors and clamps a negative or non-finite input to 0", () => {
    expect(formatTrackId(-5, 6)).toBe("000000");
    expect(formatTrackId(NaN, 6)).toBe("000000");
    expect(formatTrackId(3.7, 6)).toBe("000003");
  });
});
