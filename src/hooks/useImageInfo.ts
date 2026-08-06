import { useEffect, useRef, useState } from "react";
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
  const infoRef = useRef(info);
  infoRef.current = info;

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
  }, [files, enabled]);

  /** Fetches a single file on demand (e.g. row hover) regardless of `enabled`. */
  const fetchOne = async (path: string) => {
    if (path in infoRef.current) return;
    try {
      const result = await invoke<ImageInfo | null>("image_info", { path });
      setInfo((prev) => ({ ...prev, [path]: result }));
    } catch {
      setInfo((prev) => ({ ...prev, [path]: null }));
    }
  };

  const invalidate = (paths: string[]) => {
    setInfo((prev) => {
      const next = { ...prev };
      for (const p of paths) delete next[p];
      return next;
    });
  };

  return { info, fetchOne, invalidate };
}
