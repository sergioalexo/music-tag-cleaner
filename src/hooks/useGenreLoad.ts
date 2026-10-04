import { useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TagData } from "../types";
import type { Notify, useFiles } from "./useFiles";
import type { LibraryIndexApi } from "./useLibraryIndex";
import type { useTags } from "./useTags";

/** Files per `read_tags_batch` call during the background refresh. */
const TAG_READ_CHUNK = 200;

interface Deps {
  libraryIndex: LibraryIndexApi;
  filesApi: ReturnType<typeof useFiles>;
  tagsApi: ReturnType<typeof useTags>;
  libraryTags: Record<string, TagData>;
  setLibraryTags: React.Dispatch<React.SetStateAction<Record<string, TagData>>>;
  notify: Notify;
}

/**
 * Loads a library genre into the batch: paints the table at once from the
 * index, then re-reads the real tags in the background.
 *
 * The index only keeps the curated fields, so the instant paint has no
 * `allFields` or cover data; the refresh below fills those in. Every click
 * bumps a generation counter and each await re-checks it, so flicking
 * House → Techno → House quickly can never leave rows or tags from the
 * superseded load behind.
 */
export function useGenreLoad({
  libraryIndex,
  filesApi,
  tagsApi,
  libraryTags,
  setLibraryTags,
  notify,
}: Deps) {
  const generation = useRef(0);

  /** Invalidates any in-flight load (e.g. when the batch is replaced some other way). */
  const cancel = () => {
    generation.current++;
  };

  const loadGenre = async (genre: string) => {
    const gen = ++generation.current;
    let paths: string[];
    try {
      paths = await libraryIndex.pathsWithGenre(genre);
    } catch (e) {
      notify(String(e), "error");
      return;
    }
    if (gen !== generation.current) return;

    const indexed = new Map(libraryIndex.files.map((f) => [f.path, f]));
    const rows = paths.flatMap((p) => indexed.get(p) ?? []);
    // Instant paint. Tags the session already holds are fuller than the
    // index's curated copy (and newer after an edit), so they win.
    const toRead = rows.map((f) => f.path).filter((p) => !libraryTags[p]);
    const seed: Record<string, TagData> = {};
    for (const f of rows) if (libraryIndex.tags[f.path]) seed[f.path] = libraryIndex.tags[f.path];
    filesApi.replaceWith(rows, { kind: "genre", genre });
    setLibraryTags((prev) => ({ ...seed, ...prev }));

    // Background refresh of the seeded rows, chunked like the table's own reader.
    let gone = 0;
    for (let i = 0; i < toRead.length; i += TAG_READ_CHUNK) {
      const chunk = toRead.slice(i, i + TAG_READ_CHUNK);
      try {
        const { map } = await tagsApi.read(chunk);
        if (gen !== generation.current) return;
        setLibraryTags((prev) => ({ ...prev, ...map }));
        // The index can outlive a file that was moved or deleted outside the
        // app. An unreadable row is only dropped once it's confirmed missing —
        // a corrupt file that still exists stays visible rather than vanishing.
        const unread = chunk.filter((p) => !map[p]);
        const missing: string[] = [];
        for (const p of unread) if (!(await invoke<boolean>("path_exists", { path: p }))) missing.push(p);
        if (gen !== generation.current) return;
        if (missing.length) {
          filesApi.removeFiles(missing);
          gone += missing.length;
        }
      } catch (e) {
        console.error("Failed to read tags for genre:", e);
        return;
      }
    }
    if (gone) {
      notify(`${gone} file${gone === 1 ? "" : "s"} no longer exist${gone === 1 ? "s" : ""}; re-index to tidy up`, "info");
    }
  };

  return { loadGenre, cancel };
}
