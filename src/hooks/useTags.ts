import { useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  basename,
  FIELD_LABELS,
  KEPT_FIELD_KEYS,
  type AudioFile,
  type PendingChange,
  type Settings,
  type TagData,
  type TagReadResult,
} from "../types";
import { buildRenameStem, formatTrackId, isUid } from "../lib/standardize";

/** Backup-field argument for write_tags (null disables the searchable backup). */
function backupArg(s: Settings): string | null {
  return s.searchableBackup ? s.backupField : null;
}

/**
 * Builds the argument object for the `write_tags` command. Every call site goes
 * through here: the keys must match write_tags' Rust parameter names exactly,
 * and a mismatched optional key (e.g. `backupField`) deserializes to None
 * rather than erroring, which silently disables the searchable backup.
 */
function writeTagsArgs(
  path: string,
  tags: TagData,
  settings: Settings,
  keepExtra: string[],
): Record<string, unknown> {
  return {
    path,
    tags,
    backup: settings.backupBeforeChanges,
    keepExtra,
    preserveArt: settings.preserveCoverArt,
    backupField: backupArg(settings),
  };
}

export interface ApplyResult {
  written: number;
  errors: string[];
  /** True if a backup/restore run was stopped early by the user. */
  stopped?: boolean;
}

export type Progress = (done: number, total: number) => void;

const DISPLAY_FIELDS = Object.keys(FIELD_LABELS) as (keyof TagData & string)[];

/** Fields the Standardize action transforms. */
export const STANDARDIZE_FIELDS = ["title", "artist", "album", "albumArtist"] as const;

function groupByPath(rows: PendingChange[]): Map<string, PendingChange[]> {
  const map = new Map<string, PendingChange[]>();
  for (const row of rows) {
    const list = map.get(row.path);
    if (list) list.push(row);
    else map.set(row.path, [row]);
  }
  return map;
}

/** keepExtra for a merge write: preserve every non-common field untouched. */
function preserveExtras(tags: TagData): string[] {
  return Object.keys(tags.allFields).filter((k) => !KEPT_FIELD_KEYS.has(k));
}

export function useTags() {
  const stopRef = useRef(false);

  const read = async (paths: string[]) => {
    const results = await invoke<TagReadResult[]>("read_tags_batch", { paths });
    const map: Record<string, TagData> = {};
    const errors: string[] = [];
    for (const r of results) {
      if (r.tags) map[r.path] = r.tags;
      else errors.push(`${basename(r.path)}: ${r.error ?? "could not read tags"}`);
    }
    return { map, errors };
  };

  /** Rows for the strip preview: kept fields (unchanged) + extras to remove. */
  const buildStripPreview = (map: Record<string, TagData>): PendingChange[] => {
    const rows: PendingChange[] = [];
    for (const [path, tags] of Object.entries(map)) {
      const filename = basename(path);
      for (const field of DISPLAY_FIELDS) {
        const value = (tags[field] as string | undefined) ?? "";
        if (!value) continue;
        rows.push({
          id: `${path}::keep::${field}`,
          path,
          filename,
          field,
          before: value,
          after: value,
          include: false,
          changed: false,
          kind: "update",
        });
      }
      for (const [key, value] of Object.entries(tags.allFields)) {
        if (KEPT_FIELD_KEYS.has(key)) continue;
        rows.push({
          id: `${path}::remove::${key}`,
          path,
          filename,
          field: key,
          before: value,
          after: "(removed)",
          include: true,
          changed: true,
          kind: "remove",
        });
      }
    }
    return rows;
  };

  /** Rows for the Clear Fields preview: empties each chosen field. */
  const buildClearPreview = (
    paths: string[],
    map: Record<string, TagData>,
    fields: string[],
  ): PendingChange[] => {
    const rows: PendingChange[] = [];
    for (const path of paths) {
      const tags = map[path];
      if (!tags) continue;
      const filename = basename(path);
      for (const field of fields) {
        const isRaw = field.startsWith("raw:");
        const key = isRaw ? field.slice(4) : field;
        const before = String(
          isRaw
            ? (tags.allFields?.[key] ?? "")
            : ((tags as unknown as Record<string, string | undefined>)[key] ?? ""),
        ).trim();
        const changed = before.length > 0;
        rows.push({
          id: `${path}::clear::${field}`,
          path,
          filename,
          field: key,
          before,
          after: "",
          include: changed,
          changed,
          // Every cleared field reads as a removal in the preview, curated or
          // raw — the value is struck through and gone.
          kind: "remove",
          raw: isRaw,
        });
      }
    }
    return rows;
  };

  /**
   * Rows for the standardize preview: applies `transform` to each editable
   * field. Rows whose value actually changes are included by default.
   */
  const buildStandardizePreview = (
    paths: string[],
    map: Record<string, TagData>,
    transform: (value: string, field: string) => string,
    fields: readonly string[] = STANDARDIZE_FIELDS,
  ): PendingChange[] => {
    const rows: PendingChange[] = [];
    for (const path of paths) {
      const tags = map[path];
      if (!tags) continue;
      const filename = basename(path);
      for (const field of fields) {
        const before = ((tags as unknown as Record<string, string | undefined>)[field] ?? "").trim();
        if (!before) continue;
        const after = transform(before, field);
        const changed = after !== before;
        rows.push({
          id: `${path}::std::${field}`,
          path,
          filename,
          field,
          before,
          after,
          include: changed,
          changed,
          kind: "update",
        });
      }
    }
    return rows;
  };

  /**
   * Writes the strip result. Unchecked removal rows are passed to the
   * backend as keepExtra so those fields survive.
   */
  const applyStrip = async (
    rows: PendingChange[],
    map: Record<string, TagData>,
    settings: Settings,
    onProgress?: Progress,
  ): Promise<ApplyResult> => {
    let written = 0;
    const errors: string[] = [];
    const groups = groupByPath(rows);
    let done = 0;
    for (const [path, fileRows] of groups) {
      done++;
      onProgress?.(done, groups.size);
      const tags = map[path];
      if (!tags) continue;
      const removals = fileRows.filter((r) => r.kind === "remove");
      if (!removals.some((r) => r.include)) continue; // nothing to strip for this file
      const keepExtra = removals.filter((r) => !r.include).map((r) => r.field);
      try {
        await invoke("write_tags", writeTagsArgs(path, tags, settings, keepExtra));
        written++;
      } catch (e) {
        errors.push(`${basename(path)}: ${e}`);
      }
    }
    return { written, errors };
  };

  /**
   * Writes included field updates (AI / standardize / clear) merged over the
   * current tags. `keepAllExtras` forces every non-common field to survive
   * regardless of the strip setting (used by targeted actions like Clear).
   */
  const applyUpdates = async (
    rows: PendingChange[],
    map: Record<string, TagData>,
    settings: Settings,
    keepAllExtras = false,
    onProgress?: Progress,
  ): Promise<ApplyResult> => {
    let written = 0;
    const errors: string[] = [];
    const groups = groupByPath(rows);
    let done = 0;
    for (const [path, fileRows] of groups) {
      done++;
      onProgress?.(done, groups.size);
      const current = map[path];
      if (!current) continue;
      const included = fileRows.filter((r) => r.changed && r.include);
      if (!included.length) continue;
      const tags: TagData = { ...current };
      const clearedRaw = new Set<string>();
      for (const r of included) {
        if (r.raw) clearedRaw.add(r.field);
        else (tags as unknown as Record<string, string>)[r.field] = r.after;
      }
      // When stripping is disabled (or forced), carry every non-common field
      // over untouched; otherwise the write also strips (per settings). Raw
      // fields the user asked to clear are dropped from that carry-over list —
      // an extra frame is cleared by not preserving it.
      let keepExtra = keepAllExtras || !settings.stripToCommon ? preserveExtras(current) : [];
      if (clearedRaw.size) keepExtra = keepExtra.filter((k) => !clearedRaw.has(k));
      try {
        await invoke("write_tags", writeTagsArgs(path, tags, settings, keepExtra));
        written++;
      } catch (e) {
        errors.push(`${basename(path)}: ${e}`);
      }
    }
    return { written, errors };
  };

  /** Inline edit of a single field; preserves all other tags untouched. */
  const updateField = async (
    path: string,
    current: TagData,
    field: keyof TagData & string,
    value: string | number,
    settings: Settings,
  ): Promise<void> => {
    const tags = { ...current, [field]: value } as TagData;
    await invoke("write_tags", writeTagsArgs(path, tags, settings, preserveExtras(current)));
  };

  /**
   * Assigns sequential zero-padded 6-digit ids to the Track ID of each
   * selected file (a private TXXX:TRACKID frame — never Track Number, which
   * players use for album/playlist order), starting from `settings.nextTrackId`
   * and overwriting any existing value. Returns the next unused counter so it
   * can be persisted; reset it in Settings to regenerate from a chosen number.
   */
  const generateIds = async (
    paths: string[],
    map: Record<string, TagData>,
    settings: Settings,
  ): Promise<ApplyResult & { assigned: number; nextId: number }> => {
    let counter = settings.nextTrackId;
    let written = 0;
    const errors: string[] = [];
    for (const path of paths) {
      const current = map[path];
      if (!current) continue;
      const id = formatTrackId(counter, settings.trackIdDigits);
      try {
        await updateField(path, current, "trackId", id, settings);
        written++;
        counter++;
      } catch (e) {
        errors.push(`${basename(path)}: ${e}`);
      }
    }
    return { written, assigned: written, errors, nextId: counter };
  };

  /**
   * Renames files to "artist - title - uid" (sanitized), or the fully
   * lowercase dash-only "artist-title-uid" when `strict` is set. Returns a
   * mapping of old path -> new AudioFile so the caller can update its list.
   */
  const renameFiles = async (
    files: AudioFile[],
    map: Record<string, TagData>,
    trackIdDigits = 6,
    strict = false,
  ): Promise<ApplyResult & { mapping: Record<string, AudioFile> }> => {
    let written = 0;
    const errors: string[] = [];
    const mapping: Record<string, AudioFile> = {};
    for (const file of files) {
      const tags = map[file.path];
      if (!tags) continue;
      const uid = isUid(tags.trackId, trackIdDigits) ? tags.trackId : undefined;
      const stem = buildRenameStem(tags.artist, tags.title, uid, strict);
      if (!stem) {
        errors.push(`${file.filename}: no usable characters to build a name from`);
        continue;
      }
      try {
        const newPath = await invoke<string>("rename_file", { path: file.path, newStem: stem });
        const [updated] = await invoke<AudioFile[]>("list_files", { paths: [newPath] });
        if (updated) mapping[file.path] = updated;
        written++;
      } catch (e) {
        errors.push(`${file.filename}: ${e}`);
      }
    }
    return { written, errors, mapping };
  };

  /**
   * Explicit backup of the selected files: writes the full JSON snapshot and
   * the searchable backup field, preserving everything else. Runs regardless
   * of the auto-backup toggles and works on untagged (filename-only) files.
   * Each file gets a server-side timeout, so one locked/cloud-only file
   * reports an error instead of hanging the whole run.
   */
  const backupSelected = async (
    paths: string[],
    settings: Settings,
    onProgress?: Progress,
  ): Promise<ApplyResult> => {
    stopRef.current = false;
    let written = 0;
    const errors: string[] = [];
    onProgress?.(0, paths.length);
    for (let i = 0; i < paths.length; i++) {
      if (stopRef.current) return { written, errors, stopped: true };
      const path = paths[i];
      try {
        await invoke("backup_file", { path, backupField: settings.backupField });
        written++;
      } catch (e) {
        errors.push(`${basename(path)}: ${e}`);
      }
      onProgress?.(i + 1, paths.length);
    }
    return { written, errors };
  };

  const restore = async (paths: string[], onProgress?: Progress): Promise<ApplyResult> => {
    stopRef.current = false;
    let written = 0;
    const errors: string[] = [];
    onProgress?.(0, paths.length);
    for (let i = 0; i < paths.length; i++) {
      if (stopRef.current) return { written, errors, stopped: true };
      const path = paths[i];
      try {
        await invoke("restore_from_backup", { path });
        written++;
      } catch (e) {
        errors.push(`${basename(path)}: ${e}`);
      }
      onProgress?.(i + 1, paths.length);
    }
    return { written, errors };
  };

  /** Requests the in-progress backup/restore run to stop after the current file. */
  const stopBackup = () => {
    stopRef.current = true;
  };

  return {
    read,
    buildStripPreview,
    buildStandardizePreview,
    buildClearPreview,
    applyStrip,
    applyUpdates,
    updateField,
    generateIds,
    renameFiles,
    backupSelected,
    restore,
    stopBackup,
  };
}
