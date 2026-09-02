import type { Capitalization, CharReplacement } from "../types";

export const DEFAULT_REPLACEMENTS: CharReplacement[] = [
  { from: "&", to: "N", enabled: true },
  { from: "$", to: "S", enabled: true },
  { from: "@", to: "a", enabled: false },
  { from: "!", to: "I", enabled: false },
  { from: "0", to: "O", enabled: false },
];

/** Characters considered "normal" in a title/artist — anything else is flagged. */
const ALLOWED = /[\p{L}\p{N}\s\-'()]/u;

/** Escapes regex metacharacters so a literal string can be used in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Applies enabled character replacements (literal, all occurrences). */
export function applyReplacements(value: string, rules: CharReplacement[]): string {
  let out = value;
  for (const r of rules) {
    if (!r.enabled || !r.from) continue;
    if (r.caseSensitive === false) {
      out = out.replace(new RegExp(escapeRegExp(r.from), "gi"), r.to);
    } else {
      out = out.split(r.from).join(r.to);
    }
  }
  return collapseSpaces(out);
}

/** Removes every character listed in `chars` from the value. */
export function removeCharsFrom(value: string, chars: string): string {
  if (!chars) return value;
  const set = new Set(chars.split(""));
  let out = "";
  for (const ch of value) if (!set.has(ch)) out += ch;
  return collapseSpaces(out);
}

export function applyCapitalization(value: string, mode: Capitalization): string {
  switch (mode) {
    case "upper":
      return value.toUpperCase();
    case "lower":
      return value.toLowerCase();
    case "title":
      return toTitleCase(value);
    case "sentence": {
      const lower = value.toLowerCase();
      const idx = lower.search(/\p{L}/u);
      if (idx === -1) return lower;
      return lower.slice(0, idx) + lower[idx].toUpperCase() + lower.slice(idx + 1);
    }
    default:
      return value;
  }
}

/**
 * Roman numerals I–XX, capped low on purpose: past XX the forms start
 * colliding with real words ("MIX", "DIV", "CIV"), and track titles never
 * need "Part XLII".
 */
const ROMAN_NUMERAL = /^(i{1,3}|iv|vi{0,3}|ix|xi{0,3}|xiv|xvi{0,3}|xix|xx)$/i;

function isRomanNumeral(token: string): boolean {
  const letters = token.replace(/[^\p{L}]/gu, "");
  return (
    letters === letters.toUpperCase() &&
    letters !== letters.toLowerCase() &&
    ROMAN_NUMERAL.test(letters)
  );
}

/**
 * True for a caps token we should leave exactly as written rather than
 * re-case: an existing all-caps run that reads as an initialism (DJ, MC, UK,
 * EDM, MGMT, SBTRKT). Deliberately conservative — a shouted ordinary word
 * like "LOVE" is *not* kept, so it normalizes to "Love".
 */
function keepAsWritten(token: string): boolean {
  const letters = token.replace(/[^\p{L}]/gu, "");
  if (letters.length < 2) return false;
  const allCaps = letters === letters.toUpperCase() && letters !== letters.toLowerCase();
  if (!allCaps) return false;
  if (letters.length <= 3) return true; // DJ, MC, UK, EP, RMX, VIP, EDM …
  return !/[AEIOU]/.test(letters); // longer runs only when vowel-less (MGMT, SBTRKT)
}

/** Uppercases the first letter of a run and lowercases the rest ("rIVERS" -> "Rivers"). */
function recaseWord(word: string): string {
  let seenLetter = false;
  let out = "";
  for (const ch of word) {
    if (/\p{L}/u.test(ch)) {
      out += seenLetter ? ch.toLowerCase() : ch.toUpperCase();
      seenLetter = true;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Capitalizes the first letter of every word. Letter runs separated by spaces,
 * hyphens or slashes each count as a word, so "rock-n-roll" -> "Rock-N-Roll"
 * and "ac/dc" -> "Ac/Dc". An already-uppercase roman numeral is kept
 * ("Part III" stays) and mixed-case initialisms are kept ("DJ Snake"). There
 * is intentionally no "small words stay lowercase" rule: "Rivers Flow In You"
 * stays fully capitalized.
 *
 * When the whole value is already shouting ("RIVERS FLOW IN YOU") the
 * keep-initialism rule is skipped — every word is recased — since otherwise
 * short real words like "IN"/"YOU" would be mistaken for initialisms.
 */
function toTitleCase(value: string): string {
  const cased = value.replace(/[^\p{L}]/gu, "");
  const shouting = cased.length > 1 && cased === cased.toUpperCase() && cased !== cased.toLowerCase();
  return value.replace(/\p{L}[\p{L}\p{M}\p{N}'’]*/gu, (word) => {
    if (isRomanNumeral(word)) return word.toUpperCase();
    if (!shouting && keepAsWritten(word)) return word;
    return recaseWord(word);
  });
}

function collapseSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** True if the string contains any character outside the allowed set. */
export function hasWeirdChars(value: string): boolean {
  for (const ch of value) {
    if (/\s/.test(ch)) continue;
    if (!ALLOWED.test(ch)) return true;
  }
  return false;
}

/** Splits a string into segments marking which characters are flagged. */
export function markWeird(value: string): { text: string; weird: boolean }[] {
  const out: { text: string; weird: boolean }[] = [];
  for (const ch of value) {
    const weird = !/\s/.test(ch) && !ALLOWED.test(ch);
    const last = out[out.length - 1];
    if (last && last.weird === weird) last.text += ch;
    else out.push({ text: ch, weird });
  }
  return out;
}

/**
 * Sanitizes a value for use in a filename: keeps only letters, numbers and
 * spaces (Unicode-aware, so accented and Cyrillic letters survive), and
 * collapses whitespace. Everything else is dropped.
 */
export function sanitizeForFilename(value: string): string {
  return collapseSpaces(value.replace(/[^\p{L}\p{N}\s]/gu, " "));
}

/**
 * Strict filename mode: ASCII-folds accented Latin letters (é → e, ñ → n, ü
 * → u, …) via Unicode NFKD decomposition, then forces the result down to
 * exactly `a-z`, `0-9` and `-` — the only characters guaranteed safe across
 * every filesystem, OS and DJ tool. Anything else (spaces, punctuation, and
 * — this can't attempt real script transliteration — any non-Latin
 * character) becomes a dash; runs of dashes collapse to one and the ends
 * are trimmed.
 */
export function sanitizeForFilenameStrict(value: string): string {
  const folded = value
    .normalize("NFKD")
    // Strip the combining diacritical marks NFKD split off (U+0300-U+036F).
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  return folded.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Builds the standard rename stem from tag values: "artist - title - uid"
 * normally, or "artist-title-uid" (fully lowercase, dash-only) when `strict`
 * is set. Empty parts are dropped, so a missing artist or uid doesn't leave
 * a stray separator.
 */
export function buildRenameStem(
  artist: string | undefined,
  title: string | undefined,
  uid: string | undefined,
  strict = false,
): string {
  const sanitize = strict ? sanitizeForFilenameStrict : sanitizeForFilename;
  const parts = [artist, title, uid]
    .map((p) => sanitize((p ?? "").trim()))
    .filter((p) => p.length > 0);
  return parts.join(strict ? "-" : " - ");
}

/**
 * Clamps a user-supplied track-id width to a usable range. `digits` reaches
 * these helpers straight from settings, and an out-of-range or non-numeric
 * value would otherwise build an invalid RegExp (throwing) or a nonsensical
 * padding width.
 */
export function safeTrackIdDigits(digits: number): number {
  if (!Number.isFinite(digits)) return 6;
  return Math.min(12, Math.max(1, Math.floor(digits)));
}

/** A track number counts as a generated UID if it is exactly `digits` digits long. */
export function isUid(value: string | undefined, digits = 6): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  const n = safeTrackIdDigits(digits);
  return trimmed.length === n && /^\d+$/.test(trimmed);
}

/** Formats a sequential id as a zero-padded `digits`-digit string (0 -> "000...0"). */
export function formatTrackId(n: number, digits = 6): string {
  const width = safeTrackIdDigits(digits);
  const max = 10 ** width;
  const value = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  return String(value % max).padStart(width, "0");
}
