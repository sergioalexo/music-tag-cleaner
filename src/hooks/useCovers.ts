import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AudioFile } from "../types";

/** Longest side (px) of the table thumbnails — 2× the largest rendered size. */
const THUMB_SIZE = 128;

/**
 * How many files one `read_cover_thumbnails` call covers. The backend fans a
 * batch out across several threads, so a bigger chunk is faster; a smaller one
 * paints sooner and loses less work when the loop is cancelled (a file list
 * change restarts it). This is the compromise.
 */
const CHUNK = 48;

interface CoverThumbnail {
  path: string;
  dataUrl: string | null;
}

/**
 * Lazily loads small cover-art thumbnails for the given files and caches them
 * by path. Thumbnails (not the full embedded art) so a few hundred files cost
 * ~1 MB of base64 rather than hundreds. A null cache entry means "loaded, no
 * art"; undefined means "not yet loaded".
 *
 * Files are fetched a chunk at a time rather than one by one: each thumbnail
 * costs a tag parse plus an image decode/resize/encode, so the old per-file
 * round trip made opening a large folder take tens of seconds of visibly
 * empty artwork cells. One call per chunk also means the table re-renders
 * once per chunk instead of once per 20 files.
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
    const queue = files.filter((f) => !(f.path in coversRef.current)).map((f) => f.path);
    if (queue.length === 0) return;

    (async () => {
      for (let i = 0; i < queue.length; i += CHUNK) {
        if (cancelled) return;
        const chunk = queue.slice(i, i + CHUNK);
        let results: CoverThumbnail[];
        try {
          results = await invoke<CoverThumbnail[]>("read_cover_thumbnails", {
            paths: chunk,
            size: THUMB_SIZE,
          });
        } catch {
          // Cache the whole chunk as "no art" so a hard failure can't put the
          // loader into a refetch loop on every re-render.
          results = chunk.map((path) => ({ path, dataUrl: null }));
        }
        if (cancelled) return;
        setCovers((prev) => {
          const next = { ...prev };
          for (const r of results) next[r.path] = r.dataUrl;
          return next;
        });
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
