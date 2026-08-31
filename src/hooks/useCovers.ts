import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AudioFile } from "../types";

/** Longest side (px) of the table thumbnails — 2× the largest rendered size. */
const THUMB_SIZE = 128;

/**
 * Lazily loads small cover-art thumbnails for the given files, one at a time to
 * keep the UI responsive, and caches them by path. Thumbnails (not the full
 * embedded art) so a few hundred files cost ~1 MB of base64 rather than
 * hundreds; state is flushed in batches so the table re-renders ~20× fewer
 * times. A null cache entry means "loaded, no art"; undefined means "not yet
 * loaded".
 */
export function useCovers(files: AudioFile[]) {
  const [covers, setCovers] = useState<Record<string, string | null>>({});
  // Bumped by invalidate() so the loader re-runs — dropping cache entries alone
  // would not, since `files` keeps its identity when only the art changed.
  const [reloadToken, setReloadToken] = useState(0);
  const coversRef = useRef(covers);
  coversRef.current = covers;

  useEffect(() => {
    let cancelled = false;
    const queue = files.filter((f) => !(f.path in coversRef.current));
    if (queue.length === 0) return;

    (async () => {
      let batch: Record<string, string | null> = {};
      const flush = () => {
        if (cancelled || !Object.keys(batch).length) return;
        const pending = batch;
        batch = {};
        setCovers((prev) => ({ ...prev, ...pending }));
      };
      for (let i = 0; i < queue.length; i++) {
        if (cancelled) return;
        try {
          batch[queue[i].path] = await invoke<string | null>("read_cover_thumbnail", {
            path: queue[i].path,
            size: THUMB_SIZE,
          });
        } catch {
          batch[queue[i].path] = null;
        }
        if ((i + 1) % 20 === 0) flush();
      }
      flush();
    })();

    return () => {
      cancelled = true;
    };
  }, [files, reloadToken]);

  /** Drops cached art for paths that changed (after a write), forcing a reload. */
  const invalidate = useCallback((paths: string[]) => {
    if (!paths.length) return;
    setCovers((prev) => {
      const next = { ...prev };
      for (const p of paths) delete next[p];
      return next;
    });
    setReloadToken((t) => t + 1);
  }, []);

  return { covers, invalidate };
}
