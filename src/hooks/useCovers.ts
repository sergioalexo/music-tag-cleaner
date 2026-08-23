import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AudioFile } from "../types";

/**
 * Lazily loads embedded cover art for the given files, one at a time to keep
 * the UI responsive, and caches the results by path. A null cache entry means
 * "loaded, no art"; undefined means "not yet loaded".
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
      for (const f of queue) {
        if (cancelled) return;
        try {
          const url = await invoke<string | null>("read_cover_art", { path: f.path });
          if (cancelled) return;
          setCovers((prev) => ({ ...prev, [f.path]: url }));
        } catch {
          if (cancelled) return;
          setCovers((prev) => ({ ...prev, [f.path]: null }));
        }
      }
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
