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

const SMALL_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or",
  "the", "to", "vs", "via", "with",
]);

export function applyCapitalization(value: string, mode: Capitalization): string {
  switch (mode) {
    case "upper":
      return value.toUpperCase();
    case "lower":
      return value.toLowerCase();
    case "title":
      return toTitleCase(value);
    default:
      return value;
  }
}

function toTitleCase(value: string): string {
  const words = value.split(/(\s+)/); // keep the whitespace runs
  const wordIndexes = words
    .map((token, i) => (/^\s+$/.test(token) || token === "" ? -1 : i))
    .filter((i) => i !== -1);
  const lastWordIndex = wordIndexes[wordIndexes.length - 1];
  let seenWord = 0;
  return words
    .map((token, i) => {
      if (/^\s+$/.test(token) || token === "") return token;
      const lower = token.toLowerCase();
      const isFirstOrLast = seenWord === 0 || i === lastWordIndex;
      seenWord++;
      if (!isFirstOrLast && SMALL_WORDS.has(lower)) return lower;
      return capitalizeWord(token);
    })
    .join("");
}

function capitalizeWord(word: string): string {
  // Capitalize the first letter after any leading punctuation, e.g. (hello) -> (Hello).
  return word.replace(/\p{L}/u, (c) => c.toUpperCase()).replace(/(\p{L})(.*)/u, (_m, first, rest) => {
    return first + (rest as string).toLowerCase();
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

/** Builds the standard "artist - title - uid" file stem from tag values. */
export function buildRenameStem(
  artist: string | undefined,
  title: string | undefined,
  uid: string | undefined,
): string {
  const parts = [artist, title, uid]
    .map((p) => sanitizeForFilename((p ?? "").trim()))
    .filter((p) => p.length > 0);
  return parts.join(" - ");
}

/** A track number counts as a generated UID if it is exactly `digits` digits long. */
export function isUid(value: string | undefined, digits = 6): boolean {
  return !!value && new RegExp(`^\\d{${digits}}$`).test(value.trim());
}

/** Formats a sequential id as a zero-padded `digits`-digit string (0 -> "000...0"). */
export function formatTrackId(n: number, digits = 6): string {
  const max = 10 ** digits;
  return String(Math.max(0, Math.floor(n)) % max).padStart(digits, "0");
}
