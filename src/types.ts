export interface AudioFile {
  path: string;
  filename: string;
  format: string;
  size: number;
  hasBackup: boolean;
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
}

export type Capitalization = "asis" | "upper" | "title" | "lower";

export type BackupField = "Composer" | "OriginalArtist" | "Comment";

export type RowHeight = "compact" | "normal" | "tall";

export interface GenrePreset {
  name: string;
  genres: string[];
}

export interface Settings {
  aiBackend: "ollama" | "claude";
  ollamaUrl: string;
  ollamaModel: string;
  batchSize: number;
  backupBeforeChanges: boolean;
  stripToCommon: boolean;
  preserveCoverArt: boolean;
  recursive: boolean;
  /** When true, write "file name - artist - title - year" into the backup field. */
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
  /** Next sequential track ID to assign (6-digit, zero-padded). */
  nextTrackId: number;
  /** Fields the "Clear Fields" action empties. */
  clearFields: string[];
  /**
   * Non-Latin scripts (from TRANSLITERATE_SCRIPTS) that AI Clean should
   * romanize to Latin letters instead of preserving as-is.
   */
  transliterateScripts: string[];
  /** Bumped when defaults change so saved settings can be migrated. */
  settingsVersion: number;
}

/** Non-Latin scripts AI Clean can optionally transliterate — must match SCRIPTS in ai.rs. */
export const TRANSLITERATE_SCRIPTS = [
  { id: "Cyrillic", label: "Cyrillic", hint: "Russian, Ukrainian, Bulgarian, Serbian…" },
  { id: "Hebrew", label: "Hebrew", hint: "" },
  { id: "Arabic", label: "Arabic", hint: "" },
  { id: "Greek", label: "Greek", hint: "" },
  { id: "Chinese/Japanese/Korean", label: "Chinese / Japanese / Korean", hint: "" },
] as const;

export type PreviewMode = "strip" | "ai" | "standardize" | "genre" | "clear";

/** Fields the Clear Fields action can target. */
export const CLEARABLE_FIELDS = [
  "album",
  "albumArtist",
  "comment",
  "genre",
  "year",
  "discNumber",
  "trackNumber",
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
]);

export const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  artist: "Artist",
  album: "Album",
  albumArtist: "Album Artist",
  trackNumber: "Track # / ID",
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
