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

/** Applies enabled character replacements (literal, all occurrences). */
export function applyReplacements(value: string, rules: CharReplacement[]): string {
  let out = value;
  for (const r of rules) {
    if (!r.enabled || !r.from) continue;
    out = out.split(r.from).join(r.to);
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
  let seenWord = 0;
  return words
    .map((token) => {
      if (/^\s+$/.test(token) || token === "") return token;
      const lower = token.toLowerCase();
      const isFirstOrLast = seenWord === 0;
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

/** A track number counts as a generated UID if it is exactly 6 digits. */
export function isUid(value: string | undefined): boolean {
  return !!value && /^\d{6}$/.test(value.trim());
}

/** Formats a sequential id as a zero-padded 6-digit string (0 -> "000000"). */
export function formatTrackId(n: number): string {
  return String(Math.max(0, Math.floor(n)) % 1000000).padStart(6, "0");
}
