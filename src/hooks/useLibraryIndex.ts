import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  indexedToFile,
  indexedToTags,
  type AudioFile,
  type GenreCount,
  type IndexProgress,
  type IndexSummary,
  type IndexedTrack,
  type LibraryStats,
  type TagData,
} from "../types";

/**
 * The whole-library index, as the UI sees it.
 *
 * The index answers questions about tracks nobody opened today — which
 * genres the collection actually uses, whether a playlist entry is something
 * already owned, where a half-remembered track lives. The rows are held in
 * memory once loaded: everything that consumes them (matching, the search
 * dock, the genre picker) needs the whole set anyway, and a query per
 * keystroke over IPC is slower than a filter over an array.
 *
 * `files`/`tags` are exposed in the app's usual `AudioFile` + `TagData`
 * shapes so `matchPlaylist` and `searchTracks` take indexed and loaded
 * tracks identically, with no second code path.
 */
export function useLibraryIndex() {
  const [tracks, setTracks] = useState<IndexedTrack[]>([]);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [genres, setGenres] = useState<GenreCount[]>([]);
  const [indexing, setIndexing] = useState(false);
  const [progress, setProgress] = useState<IndexProgress | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** Guards against two refreshes racing and the slower one winning. */
  const refreshSeq = useRef(0);

  const refreshStats = useCallback(async () => {
    try {
      setStats(await invoke<LibraryStats>("library_stats"));
      setGenres(await invoke<GenreCount[]>("library_genres"));
    } catch {
      // A missing/locked database is not worth a toast on every poll — the
      // Settings card shows "not indexed yet", which is the honest state.
    }
  }, []);

  const refreshTracks = useCallback(async () => {
    const seq = ++refreshSeq.current;
    try {
      const rows = await invoke<IndexedTrack[]>("library_tracks");
      if (seq === refreshSeq.current) setTracks(rows);
    } catch {
      if (seq === refreshSeq.current) setTracks([]);
    } finally {
      if (seq === refreshSeq.current) setLoaded(true);
    }
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([refreshStats(), refreshTracks()]);
  }, [refreshStats, refreshTracks]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unlisten = listen<IndexProgress>("library-index-progress", (e) => setProgress(e.payload));
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  const getRoots = useCallback(() => invoke<string[]>("library_roots"), []);

  const setRoots = useCallback(
    async (roots: string[]) => {
      await invoke("set_library_roots", { roots });
      await refresh();
    },
    [refresh],
  );

  const runIndex = useCallback(
    async (rescanAll = false): Promise<IndexSummary> => {
      setIndexing(true);
      setProgress(null);
      try {
        const summary = await invoke<IndexSummary>("index_library", { rescanAll });
        await refresh();
        return summary;
      } finally {
        setIndexing(false);
        setProgress(null);
      }
    },
    [refresh],
  );

  const clear = useCallback(async () => {
    await invoke("clear_library_index");
    await refresh();
  }, [refresh]);

  const pathsWithGenre = useCallback(
    (genre: string) => invoke<string[]>("library_paths_with_genre", { genre }),
    [],
  );

  const files = useMemo<AudioFile[]>(() => tracks.map(indexedToFile), [tracks]);
  const tags = useMemo<Record<string, TagData>>(() => {
    const out: Record<string, TagData> = {};
    for (const t of tracks) out[t.path] = indexedToTags(t);
    return out;
  }, [tracks]);

  return {
    tracks,
    files,
    tags,
    stats,
    genres,
    indexing,
    progress,
    loaded,
    refresh,
    refreshStats,
    getRoots,
    setRoots,
    runIndex,
    clear,
    pathsWithGenre,
  };
}

export type LibraryIndexApi = ReturnType<typeof useLibraryIndex>;

/**
 * Merges the indexed collection with the files loaded in this session,
 * letting the session win on any path they share.
 *
 * Both halves matter and for different reasons: the index is the only thing
 * that knows about unopened tracks, and the session is the only thing that
 * knows about edits made in the last minute but not yet re-indexed. Taking
 * the session's copy on a collision means a just-retagged track matches on
 * its new tags, not the stale row.
 */
export function mergeWithSession(
  indexFiles: AudioFile[],
  indexTags: Record<string, TagData>,
  sessionFiles: AudioFile[],
  sessionTags: Record<string, TagData>,
): { files: AudioFile[]; tags: Record<string, TagData> } {
  const byPath = new Map<string, AudioFile>();
  for (const f of indexFiles) byPath.set(f.path, f);
  for (const f of sessionFiles) byPath.set(f.path, f);
  const tags: Record<string, TagData> = { ...indexTags };
  for (const [path, t] of Object.entries(sessionTags)) tags[path] = t;
  return { files: [...byPath.values()], tags };
}
