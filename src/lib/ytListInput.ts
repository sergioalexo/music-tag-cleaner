/**
 * Parses the multi-line import box on the YouTube Music import page: a
 * playlist URL (the original, single-line behavior), individual video
 * links, and/or plain typed song names, any mix, one per line.
 *
 * Pure and side-effect free on purpose — no network, no yt-dlp — so the
 * whole thing is fixture-tested here rather than only exercised by hand
 * through the page.
 */

export type ParsedImportItem =
  | { kind: "playlist"; url: string }
  | { kind: "video"; url: string; videoId: string }
  | { kind: "text"; line: string; raw: string };

const YOUTUBE_URL_RE = /^(https?:\/\/)?(www\.|music\.)?(youtube\.com|youtu\.be)\//i;

function isYoutubeUrl(s: string): boolean {
  return YOUTUBE_URL_RE.test(s);
}

function extractListId(url: string): string | null {
  const m = url.match(/[?&]list=([^&]+)/i);
  return m ? m[1] : null;
}

function extractVideoId(url: string): string | null {
  let m = url.match(/[?&]v=([^&]+)/i);
  if (m) return m[1];
  m = url.match(/youtu\.be\/([^?&/#]+)/i);
  if (m) return m[1];
  m = url.match(/shorts\/([^?&/#]+)/i);
  if (m) return m[1];
  return null;
}

/** Strips list-paste decoration that has nothing to do with the track name:
 * leading numbering ("1.", "01)", "3 -", "- ", "• ") and a trailing
 * duration ("3:45", "(1:02:03)"). Conservative — a real title starting with
 * a bare number ("24K Magic") has no punctuation right after the digits, so
 * it never matches the numbering patterns below. */
function stripListDecoration(line: string): string {
  let s = line.replace(/^\s*(?:\d{1,3}[.)]|\d{1,3}\s*-|[-••])\s+/, "");
  s = s.replace(/\s*\(?\d{1,2}:\d{2}(?::\d{2})?\)?\s*$/, "");
  return s.trim();
}

interface CsvHeader {
  delim: string;
  artistIdx: number;
  titleIdx: number;
}

/** Recognizes a header row like `artist,title` or `title\tartist` (any
 * order, comma or tab separated). Anything else isn't treated as CSV — a
 * plain line with a comma in it (a title with a comma, say) stays a normal
 * typed line rather than misfiring as tabular data. */
function tryParseCsvHeader(line: string): CsvHeader | null {
  const delim = line.includes("\t") ? "\t" : line.includes(",") ? "," : null;
  if (!delim) return null;
  const cols = line.split(delim).map((c) => c.trim().toLowerCase());
  const artistIdx = cols.indexOf("artist");
  const titleIdx = cols.indexOf("title");
  if (artistIdx === -1 || titleIdx === -1) return null;
  return { delim, artistIdx, titleIdx };
}

export function parseImportInput(text: string): ParsedImportItem[] {
  const rawLines = text.split(/\r?\n/);
  const items: ParsedImportItem[] = [];

  const firstContentIdx = rawLines.findIndex((l) => l.trim() && !l.trim().startsWith("#"));
  const header = firstContentIdx >= 0 ? tryParseCsvHeader(rawLines[firstContentIdx].trim()) : null;

  for (let i = 0; i < rawLines.length; i++) {
    const trimmed = rawLines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (header && i === firstContentIdx) continue; // the header row itself

    if (header) {
      const cols = trimmed.split(header.delim).map((c) => c.trim());
      const artist = cols[header.artistIdx] ?? "";
      const title = cols[header.titleIdx] ?? "";
      const line = artist && title ? `${artist} - ${title}` : artist || title;
      if (line) items.push({ kind: "text", line, raw: trimmed });
      continue;
    }

    const cleaned = stripListDecoration(trimmed);
    if (!cleaned) continue;

    if (isYoutubeUrl(cleaned)) {
      const listId = extractListId(cleaned);
      if (listId) {
        items.push({ kind: "playlist", url: cleaned });
        continue;
      }
      const videoId = extractVideoId(cleaned);
      if (videoId) {
        items.push({ kind: "video", url: cleaned, videoId });
        continue;
      }
    }

    items.push({ kind: "text", line: cleaned, raw: trimmed });
  }

  return items;
}

/**
 * A short, deterministic, non-cryptographic hash — used only to build a
 * stable session key/videoId for a piece of pasted text, never for
 * anything security-sensitive. FNV-1a, rendered as 8 hex characters.
 */
export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
