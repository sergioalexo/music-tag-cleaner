import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  basename,
  type CleanedTrack,
  type OllamaStatus,
  type PendingChange,
  type Settings,
  type TagData,
} from "../types";

/** One track as the clean prompt sees it. `index` is 1-based and global to the run. */
export interface TrackInput {
  index: number;
  filename: string;
  artist: string;
  title: string;
  year: string;
  genre: string;
}

/** One track as the genre prompt sees it. */
export interface GenreInput {
  index: number;
  artist: string;
  title: string;
  genre: string;
}

export interface GenreResult {
  index: number;
  genre?: string;
}

const AI_FIELDS = ["artist", "title", "year", "genre"] as const;

/**
 * Batch size clamped to a sane range. A zero/negative/NaN value from settings
 * would otherwise make the batching loops never advance, hanging the app with
 * no way out short of killing it.
 */
function safeBatchSize(n: number): number {
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** Filename without its extension — given to the AI as a fallback source. */
function stem(path: string): string {
  return basename(path).replace(/\.[^.]+$/, "");
}

export interface CleanResult {
  rows: PendingChange[];
  stopped: boolean;
  /** Tracks the AI could not identify from tags or filename. */
  unresolved: string[];
}

/** Builds the clean prompt's track list. Indexes are 1-based over `paths`. */
export function cleanInputs(paths: string[], map: Record<string, TagData>): TrackInput[] {
  return paths.map((p, i) => ({
    index: i + 1,
    filename: stem(p),
    artist: map[p]?.artist ?? "",
    title: map[p]?.title ?? "",
    year: map[p]?.year ?? "",
    genre: map[p]?.genre ?? "",
  }));
}

/** Builds the genre prompt's track list. Indexes are 1-based over `paths`. */
export function genreInputs(paths: string[], map: Record<string, TagData>): GenreInput[] {
  return paths.map((p, i) => ({
    index: i + 1,
    artist: map[p]?.artist ?? "",
    title: map[p]?.title ?? "",
    genre: map[p]?.genre ?? "",
  }));
}

/**
 * Turns cleaned tracks (keyed by their 1-based index) into preview rows.
 * Shared by the Ollama run and manual mode so a pasted answer is treated
 * exactly like a locally generated one.
 */
export function buildCleanRows(
  paths: string[],
  map: Record<string, TagData>,
  cleanedByIndex: Map<number, CleanedTrack>,
): { rows: PendingChange[]; unresolved: string[] } {
  const rows: PendingChange[] = [];
  const unresolved: string[] = [];
  paths.forEach((path, i) => {
    const tags = map[path];
    const cleaned = cleanedByIndex.get(i + 1);
    const filename = basename(path);

    // Unresolved: no artist AND no title survive, from tags or filename.
    const finalTitle = (cleaned?.title ?? "").trim() || (tags.title ?? "").trim();
    const finalArtist = (cleaned?.artist ?? "").trim() || (tags.artist ?? "").trim();
    if (!finalTitle && !finalArtist) unresolved.push(path);

    // Only build change rows for tracks we actually got a result for.
    if (!cleaned) return;

    for (const field of AI_FIELDS) {
      const before = (tags[field] ?? "").trim();
      let after = (cleaned?.[field] ?? "").trim();
      // Keep the original year unless the AI returned a plausible one.
      if (field === "year" && after && !/^\d{4}([-.].*)?$/.test(after)) after = "";
      const changed = !!after && after !== before;
      rows.push({
        id: `${path}::ai::${field}`,
        path,
        filename,
        field,
        before,
        after: changed ? after : before,
        include: changed,
        changed,
        kind: "update",
      });
    }

    // Rule: if Album Artist is empty and Artist is set, copy it.
    const albumArtist = (tags.albumArtist ?? "").trim();
    if (!albumArtist && finalArtist) {
      rows.push({
        id: `${path}::ai::albumArtist`,
        path,
        filename,
        field: "albumArtist",
        before: "",
        after: finalArtist,
        include: true,
        changed: true,
        kind: "update",
      });
    }
  });
  return { rows, unresolved };
}

/** Turns matched genres (keyed by their 1-based index) into preview rows. */
export function buildGenreRows(
  paths: string[],
  map: Record<string, TagData>,
  byIndex: Map<number, string>,
): PendingChange[] {
  const rows: PendingChange[] = [];
  paths.forEach((path, i) => {
    const after = byIndex.get(i + 1);
    if (!after) return;
    const before = (map[path].genre ?? "").trim();
    const changed = after !== before;
    rows.push({
      id: `${path}::genre::genre`,
      path,
      filename: basename(path),
      field: "genre",
      before,
      after,
      include: changed,
      changed,
      kind: "update",
    });
  });
  return rows;
}

export function useAI() {
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const stopRef = useRef(false);

  /** Requests the in-progress AI run to stop after the current batch. */
  const stop = () => {
    stopRef.current = true;
  };

  const check = async (url: string): Promise<OllamaStatus> => {
    try {
      const result = await invoke<OllamaStatus>("check_ollama", { url });
      setStatus(result);
      return result;
    } catch (e) {
      const failed: OllamaStatus = { running: false, models: [], error: String(e) };
      setStatus(failed);
      return failed;
    }
  };

  /**
   * Runs the AI cleanup over `paths` in batches and returns preview rows.
   * Malformed or missing AI values fall back to the original (no row).
   */
  const runClean = async (
    paths: string[],
    map: Record<string, TagData>,
    settings: Settings,
    model: string,
    onProgress: (done: number, total: number) => void,
  ): Promise<CleanResult> => {
    stopRef.current = false;
    const valid = paths.filter((p) => map[p]);
    const inputs = cleanInputs(valid, map);

    const cleanedByIndex = new Map<number, CleanedTrack>();
    const batchSize = safeBatchSize(settings.batchSize);
    onProgress(0, valid.length);
    for (let start = 0; start < inputs.length; start += batchSize) {
      if (stopRef.current) break;
      const batch = inputs.slice(start, start + batchSize);
      const results = await invoke<CleanedTrack[]>("ai_clean_batch", {
        url: settings.ollamaUrl,
        model,
        tracks: batch,
        transliterateScripts: settings.transliterateScripts,
      });
      // Discard a batch that finished after the user asked to stop.
      if (stopRef.current) break;
      for (const r of results) cleanedByIndex.set(r.index, r);
      onProgress(Math.min(start + batch.length, valid.length), valid.length);
    }

    const { rows, unresolved } = buildCleanRows(valid, map, cleanedByIndex);
    return { rows, stopped: stopRef.current, unresolved };
  };

  /** Maps each track's genre to the best fit from `genres` via the model. */
  const runGenre = async (
    paths: string[],
    map: Record<string, TagData>,
    settings: Settings,
    model: string,
    genres: string[],
    onProgress: (done: number, total: number) => void,
  ): Promise<CleanResult> => {
    stopRef.current = false;
    const valid = paths.filter((p) => map[p]);
    const inputs = genreInputs(valid, map);

    const byIndex = new Map<number, string>();
    const batchSize = safeBatchSize(settings.batchSize);
    onProgress(0, valid.length);
    for (let start = 0; start < inputs.length; start += batchSize) {
      if (stopRef.current) break;
      const batch = inputs.slice(start, start + batchSize);
      const results = await invoke<GenreResult[]>("ai_map_genre_batch", {
        url: settings.ollamaUrl,
        model,
        tracks: batch,
        genres,
      });
      if (stopRef.current) break;
      for (const r of results) if (r.genre) byIndex.set(r.index, r.genre);
      onProgress(Math.min(start + batch.length, valid.length), valid.length);
    }

    const rows = buildGenreRows(valid, map, byIndex);
    return { rows, stopped: stopRef.current, unresolved: [] };
  };

  return { status, check, runClean, runGenre, stop };
}
