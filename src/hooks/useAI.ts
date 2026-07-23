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

interface TrackInput {
  index: number;
  filename: string;
  artist: string;
  title: string;
  year: string;
  genre: string;
}

const AI_FIELDS = ["artist", "title", "year", "genre"] as const;

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
    const inputs: TrackInput[] = valid.map((p, i) => ({
      index: i + 1,
      filename: stem(p),
      artist: map[p].artist ?? "",
      title: map[p].title ?? "",
      year: map[p].year ?? "",
      genre: map[p].genre ?? "",
    }));

    const cleanedByIndex = new Map<number, CleanedTrack>();
    let processed = 0;
    onProgress(0, valid.length);
    for (let start = 0; start < inputs.length; start += settings.batchSize) {
      if (stopRef.current) break;
      const batch = inputs.slice(start, start + settings.batchSize);
      const results = await invoke<CleanedTrack[]>("ai_clean_batch", {
        url: settings.ollamaUrl,
        model,
        tracks: batch,
      });
      // Discard a batch that finished after the user asked to stop.
      if (stopRef.current) break;
      for (const r of results) cleanedByIndex.set(r.index, r);
      processed = Math.min(start + batch.length, valid.length);
      onProgress(processed, valid.length);
    }

    const rows: PendingChange[] = [];
    const unresolved: string[] = [];
    valid.forEach((path, i) => {
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
    const inputs = valid.map((p, i) => ({
      index: i + 1,
      artist: map[p].artist ?? "",
      title: map[p].title ?? "",
      genre: map[p].genre ?? "",
    }));

    const byIndex = new Map<number, string>();
    onProgress(0, valid.length);
    for (let start = 0; start < inputs.length; start += settings.batchSize) {
      if (stopRef.current) break;
      const batch = inputs.slice(start, start + settings.batchSize);
      const results = await invoke<{ index: number; genre?: string }[]>("ai_map_genre_batch", {
        url: settings.ollamaUrl,
        model,
        tracks: batch,
        genres,
      });
      if (stopRef.current) break;
      for (const r of results) if (r.genre) byIndex.set(r.index, r.genre);
      onProgress(Math.min(start + batch.length, valid.length), valid.length);
    }

    const rows: PendingChange[] = [];
    valid.forEach((path, i) => {
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
    return { rows, stopped: stopRef.current, unresolved: [] };
  };

  return { status, check, runClean, runGenre, stop };
}
