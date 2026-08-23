import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AudioFile } from "../types";

export interface ImageInfo {
  mime: string;
  sizeBytes: number;
  width: number;
  height: number;
}

/**
 * Lazily loads embedded cover art size/dimensions/format, one file at a time.
 * Only fetches while `enabled` is true, but keeps whatever it already loaded
 * cached so toggling the column back on doesn't refetch. A null cache entry
 * means "loaded, no art"; undefined means "not yet loaded".
 */
export function useImageInfo(files: AudioFile[], enabled: boolean) {
  const [info, setInfo] = useState<Record<string, ImageInfo | null>>({});
  // See useCovers: dropping cache entries alone won't re-run the loader,
  // because `files` keeps its identity when only the artwork changed.
  const [reloadToken, setReloadToken] = useState(0);
  const infoRef = useRef(info);
  infoRef.current = info;
  // Paths with a fetch already in flight, so a hover storm can't queue duplicates.
  const inFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const queue = files.filter((f) => !(f.path in infoRef.current));
    if (queue.length === 0) return;

    (async () => {
      for (const f of queue) {
        if (cancelled) return;
        try {
          const result = await invoke<ImageInfo | null>("image_info", { path: f.path });
          if (cancelled) return;
          setInfo((prev) => ({ ...prev, [f.path]: result }));
        } catch {
          if (cancelled) return;
          setInfo((prev) => ({ ...prev, [f.path]: null }));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [files, enabled, reloadToken]);

  /** Fetches a single file on demand (e.g. row hover) regardless of `enabled`. */
  const fetchOne = useCallback(async (path: string) => {
    if (path in infoRef.current || inFlightRef.current.has(path)) return;
    inFlightRef.current.add(path);
    try {
      const result = await invoke<ImageInfo | null>("image_info", { path });
      setInfo((prev) => ({ ...prev, [path]: result }));
    } catch {
      setInfo((prev) => ({ ...prev, [path]: null }));
    } finally {
      inFlightRef.current.delete(path);
    }
  }, []);

  const invalidate = useCallback((paths: string[]) => {
    if (!paths.length) return;
    for (const p of paths) inFlightRef.current.delete(p);
    setInfo((prev) => {
      const next = { ...prev };
      for (const p of paths) delete next[p];
      return next;
    });
    setReloadToken((t) => t + 1);
  }, []);

  return { info, fetchOne, invalidate };
}
