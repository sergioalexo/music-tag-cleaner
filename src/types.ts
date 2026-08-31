export interface AudioFile {
  path: string;
  filename: string;
  format: string;
  size: number;
  hasBackup: boolean;
  durationSecs?: number;
}

export interface TagData {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  trackNumber?: string;
  discNumber?: string;
  year?: string;
  genre?: string;
  comment?: string;
  composer?: string;
  originalArtist?: string;
  /** App-assigned unique id (from "Generate IDs"), kept in a private TXXX:TRACKID frame. */
  trackId?: string;
  /** Rating in stars, 0-5. */
  rating?: number;
  hasCoverArt: boolean;
  /** Full dump of every text field, keyed by canonical lofty key name. */
  allFields: Record<string, string>;
}

export interface TagReadResult {
  path: string;
  tags: TagData | null;
  error: string | null;
}

export interface CleanedTrack {
  index: number;
  artist?: string;
  title?: string;
  year?: string;
  genre?: string;
}

export interface OllamaStatus {
  running: boolean;
  models: string[];
  error?: string;
}

export interface OllamaInfo {
  running: boolean;
  serverVersion: string | null;
  installed: boolean;
  installPath: string | null;
}

export interface ComponentProgress {
  component: "ollama" | "model";
  phase: string;
  downloaded: number;
  total: number;
}

export interface CharReplacement {
  from: string;
  to: string;
  enabled: boolean;
  /** Defaults to true (preserves prior literal-match behavior) when unset. */
  caseSensitive?: boolean;
}

export type Capitalization = "asis" | "upper" | "title" | "lower";

export type BackupField = "Composer" | "OriginalArtist" | "Comment" | "Album" | "AlbumArtist" | "Genre";

export type RowHeight = "compact" | "normal" | "tall";

/** Cumulative local Ollama usage — tracked for the usage dashboard, not billed. */
export interface UsageStats {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCalls: number;
  songsProcessed: number;
}

/**
 * Scaffolding for a possible future paid/cloud tier. Ollama itself is local
 * and free — "credits" here are a placeholder unit (1 credit ≈ 1000 tokens)
 * so the usage UI has something concrete to show, not a real balance.
 */
export interface PlanInfo {
  tier: "free" | "pro";
  creditsTotal: number;
}

export interface GenrePreset {
  name: string;
  genres: string[];
}

export interface Settings {
  /**
   * "ollama" runs the local model; "manual" hands you the prompt to paste into
   * any AI (ChatGPT, Claude, Gemini…) and takes its answer back by paste.
   */
  aiBackend: "ollama" | "manual";
  ollamaUrl: string;
  ollamaModel: string;
  batchSize: number;
  backupBeforeChanges: boolean;
  stripToCommon: boolean;
  preserveCoverArt: boolean;
  /** "Standardize Art" downscales the longest side of embedded cover art to this many px. */
  artworkMaxDim: number;
  /** JPEG quality (1-100) "Standardize Art" re-encodes cover art at. */
  artworkJpegQuality: number;
  recursive: boolean;
  /** When true, write "file name | | artist | | title | | year" into the backup field. */
  searchableBackup: boolean;
  /** Tag field the searchable backup is written into. */
  backupField: BackupField;
  lastFolder: string;
  theme: "dark" | "light";
  visibleColumns: string[];
  columnWidths: Record<string, number>;
  rowHeight: RowHeight;
  /** Character replacement rules for the Standardize action. */
  replacements: CharReplacement[];
  capitalization: Capitalization;
  /** Highlight non-standard symbols in Title/Artist cells in the table. */
  highlightSymbols: boolean;
  /** Characters removed by the "Remove characters" action. */
  removeChars: string;
  /** Named genre presets; the Genre action snaps genres to the active one. */
  genrePresets: GenrePreset[];
  activeGenrePreset: string;
  /** Next sequential track ID to assign (zero-padded to trackIdDigits). */
  nextTrackId: number;
  /** Digit count for generated track IDs (also the required length to count as a UID). */
  trackIdDigits: number;
  /** Fields the "Clear Fields" action empties. */
  clearFields: string[];
  /**
   * Non-Latin scripts (from TRANSLITERATE_SCRIPTS) that AI Clean should
   * romanize to Latin letters instead of preserving as-is.
   */
  transliterateScripts: string[];
  /** Bumped when defaults change so saved settings can be migrated. */
  settingsVersion: number;
  /** Custom key-combo overrides, keyed by shortcut action id (see lib/shortcuts.ts). */
  shortcuts: Record<string, string>;
  usage: UsageStats;
  plan: PlanInfo;
  /** Tag fields the Standardize/Remove-Chars actions touch. */
  standardizeFields: string[];
  /** When true, Standardize also renames the file using the same rules. */
  standardizeFilename: boolean;
  /** Tracks per copy/paste batch in manual AI mode. */
  manualChunkSize: number;
}

/** Non-Latin scripts AI Clean can optionally transliterate — must match SCRIPTS in ai.rs. */
export const TRANSLITERATE_SCRIPTS = [
  { id: "Cyrillic", label: "Cyrillic", hint: "Russian, Ukrainian, Bulgarian, Serbian…" },
  { id: "Hebrew", label: "Hebrew", hint: "" },
  { id: "Arabic", label: "Arabic", hint: "" },
  { id: "Greek", label: "Greek", hint: "" },
  { id: "Chinese/Japanese/Korean", label: "Chinese / Japanese / Korean", hint: "" },
] as const;

export type PreviewMode = "strip" | "ai" | "standardize" | "genre" | "clear" | "history";

/** Fields the Clear Fields action can target. */
export const CLEARABLE_FIELDS = [
  "album",
  "albumArtist",
  "comment",
  "genre",
  "year",
  "discNumber",
  "trackNumber",
  "trackId",
  "composer",
  "originalArtist",
] as const;

export interface PendingChange {
  id: string;
  path: string;
  filename: string;
  /** A TagData field name for updates, or a canonical tag key for removals. */
  field: string;
  before: string;
  after: string;
  include: boolean;
  changed: boolean;
  kind: "update" | "remove";
  /**
   * When true, `field` is a raw tag-frame key (see `TagData.allFields`), not a
   * `TagData` field — the write path clears it by dropping the frame rather
   * than by setting a value.
   */
  raw?: boolean;
}

export const AUDIO_EXTENSIONS = ["mp3", "flac", "ogg", "aac", "m4a", "wav", "aiff", "aif"];

/** Canonical lofty key names that survive a strip (must match key_name() in Rust). */
export const KEPT_FIELD_KEYS = new Set([
  "TrackTitle",
  "TrackArtist",
  "AlbumTitle",
  "AlbumArtist",
  "TrackNumber",
  "TrackTotal",
  "DiscNumber",
  "DiscTotal",
  "Year",
  "RecordingDate",
  "Genre",
  "Comment",
  // Backup slots / extra editable fields that must survive a strip.
  "OriginalArtist",
  "Composer",
  "Popularimeter",
  // Private app-assigned track id — surfaced as its own "Track ID" column,
  // so it must not also appear as a raw "All Tags" column or a strip removal.
  "Unknown(TRACKID)",
]);

export const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  artist: "Artist",
  album: "Album",
  albumArtist: "Album Artist",
  trackNumber: "Track #",
  trackId: "Track ID",
  discNumber: "Disc #",
  year: "Year",
  genre: "Genre",
  comment: "Comment",
  composer: "Composer",
  originalArtist: "Original Artist",
  rating: "Rating",
};

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
