import type { AudioFile, PlaylistEntry, TagData } from "../types";

/**
 * Matches a fetched YouTube Music playlist (see `fetch_ytmusic_playlist`)
 * against the loaded collection. yt-dlp's flat-playlist fetch only reliably
 * gives a title, a duration and a video id — not separate artist/track/album
 * fields, even for videos on an artist's own channel (confirmed empirically
 * against real playlists before writing this) — so matching works from the
 * title text and duration alone, the same way a person would eyeball it.
 */

/** Strips the trailing " - Topic" YouTube appends to auto-generated-audio
 * upload channel names, so "Rick Astley - Topic" reads as "Rick Astley". */
function stripTopicSuffix(name: string): string {
  return name.replace(/\s*-\s*topic\s*$/i, "").trim();
}

/** Common video-title clutter that has nothing to do with the track's real
 * name — stripped before splitting/comparing so it doesn't drag the score
 * down. Deliberately conservative: only well-known suffixes, not a general
 * "guess what's noise" heuristic. */
const NOISE_PATTERNS: RegExp[] = [
  /\(\s*official\s*(music\s*)?video\s*\)/gi,
  /\(\s*official\s*(lyric[s]?\s*)?(video|audio)\s*\)/gi,
  /\(\s*lyric[s]?\s*(video)?\s*\)/gi,
  /\(\s*audio\s*\)/gi,
  /\(\s*visualizer\s*\)/gi,
  /\(\s*4k\s*remaster(ed)?\s*\)/gi,
  /\[\s*official\s*(music\s*)?video\s*\]/gi,
  /\[\s*lyric[s]?\s*(video)?\s*\]/gi,
  /\[\s*hd\s*\]/gi,
  /\[\s*4k\s*\]/gi,
];

function stripTitleNoise(title: string): string {
  let cleaned = title;
  for (const re of NOISE_PATTERNS) cleaned = cleaned.replace(re, " ");
  return cleaned.replace(/\s+/g, " ").trim();
}

/** Folds a string down for comparison: diacritics stripped (NFKD, same
 * approach as `sanitizeForFilenameStrict` in standardize.ts), lowercased,
 * punctuation collapsed to spaces, whitespace normalized. */
export function normalizeForMatch(value: string): string {
  const folded = value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return folded
    .replace(/\bfeat\.?\b|\bft\.?\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Splits a video title on the first "Artist - Title"-style separator.
 * yt-dlp doesn't give us structured artist/title, so this is the primary
 * signal, not a fallback. */
export function splitArtistTitle(rawTitle: string): { artist: string | null; title: string } {
  const cleaned = stripTitleNoise(rawTitle);
  const m = cleaned.match(/^(.{1,80}?)\s*[-–—:]\s*(.{1,120})$/);
  if (m && m[1].trim() && m[2].trim()) {
    return { artist: m[1].trim(), title: m[2].trim() };
  }
  return { artist: null, title: cleaned };
}

/** Levenshtein edit distance, iterative two-row DP — fine for track-title-length strings. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** 0-1 similarity ratio from edit distance, normalized by the longer string's length. */
export function stringSimilarity(a: string, b: string): number {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  const maxLen = Math.max(na.length, nb.length);
  return 1 - levenshtein(na, nb) / maxLen;
}

function durationScore(a: number | null | undefined, b: number | null | undefined): number {
  if (a == null || b == null || a <= 0 || b <= 0) return 0.5; // unknown — neutral, don't punish
  const diff = Math.abs(a - b);
  if (diff <= 2) return 1;
  if (diff >= 15) return 0;
  return 1 - (diff - 2) / 13;
}

export interface MatchCandidate {
  path: string;
  score: number;
  titleScore: number;
  artistScore: number;
}

export type MatchStatus = "matched" | "ambiguous" | "missing";

export interface EntryMatch {
  entry: PlaylistEntry;
  status: MatchStatus;
  /** Best candidates, best first — [0] is what "matched"/"ambiguous" point at. */
  candidates: MatchCandidate[];
}

/** A confident match auto-accepts; an ambiguous one is surfaced for the user
 * to confirm or override — the roadmap's "an 80% match asks, it never
 * silently accepts" (see ROADMAP.md's F4 section). */
const CONFIDENT_THRESHOLD = 0.9;
const AMBIGUOUS_THRESHOLD = 0.55;
/** Only the top few candidates are worth showing for manual confirmation. */
const MAX_CANDIDATES = 3;

function scoreCandidate(
  wantArtist: string | null,
  wantTitle: string,
  wantDuration: number | null | undefined,
  path: string,
  rawTitle: string,
  tag: TagData | undefined,
  file: AudioFile | undefined,
): MatchCandidate {
  const durScore = durationScore(wantDuration, file?.durationSecs);
  const tagTitle = tag?.title || file?.filename || "";
  const tagArtist = tag?.artist || "";

  // Strategy A: the split-out artist/title compared to their own tag
  // fields. Precise when the title actually had an "Artist - Title"
  // separator to split on.
  const splitTitleScore = stringSimilarity(wantTitle, tagTitle);
  const splitArtistScore = wantArtist && tagArtist ? stringSimilarity(wantArtist, tagArtist) : 0.5;
  const splitScore = splitTitleScore * 0.55 + splitArtistScore * 0.3 + durScore * 0.15;

  // Strategy B: the whole (unsplit) cleaned title compared against
  // "artist title" combined — covers video titles with no separator at
  // all, where splitting would otherwise compare the full string (artist
  // name included) against just the tag's title and unfairly tank the
  // score. Takes whichever strategy actually fits this entry better.
  const combinedTagText = `${tagArtist} ${tagTitle}`.trim();
  const wholeScore = stringSimilarity(rawTitle, combinedTagText) * 0.85 + durScore * 0.15;

  if (wholeScore > splitScore) {
    return { path, score: wholeScore, titleScore: wholeScore, artistScore: 0.5 };
  }
  return { path, score: splitScore, titleScore: splitTitleScore, artistScore: splitArtistScore };
}

/**
 * Matches every entry in a fetched playlist against the loaded collection.
 * Each entry's title is split into a candidate artist/title (falling back to
 * the uploading channel, minus a trailing " - Topic", as an extra artist
 * signal when the split found none) and scored against every loaded track's
 * tags plus duration; the best score decides matched/ambiguous/missing.
 */
export function matchPlaylist(
  entries: PlaylistEntry[],
  files: AudioFile[],
  tags: Record<string, TagData>,
): EntryMatch[] {
  return entries.map((entry) => {
    const split = splitArtistTitle(entry.title);
    const artist = split.artist ?? (entry.uploader ? stripTopicSuffix(entry.uploader) : null);
    const rawTitle = stripTitleNoise(entry.title);
    const candidates = files
      .map((f) =>
        scoreCandidate(artist, split.title, entry.durationSecs, f.path, rawTitle, tags[f.path], f),
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CANDIDATES);

    const best = candidates[0];
    const status: MatchStatus =
      !best || best.score < AMBIGUOUS_THRESHOLD
        ? "missing"
        : best.score >= CONFIDENT_THRESHOLD
          ? "matched"
          : "ambiguous";

    return { entry, status, candidates: best ? candidates : [] };
  });
}
