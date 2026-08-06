import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { AUDIO_EXTENSIONS, type AudioFile } from "../types";

export type Notify = (message: string, kind?: "success" | "error" | "info") => void;

export function useFiles(
  recursive: boolean,
  notify: Notify,
  onFolderPicked: (path: string) => void,
  defaultFolder: string,
) {
  const [files, setFiles] = useState<AudioFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);

  const merge = (incoming: AudioFile[]) => {
    setFiles((prev) => {
      const byPath = new Map(prev.map((f) => [f.path, f]));
      for (const f of incoming) byPath.set(f.path, f);
      return [...byPath.values()];
    });
    setSelected((prev) => {
      const next = new Set(prev);
      for (const f of incoming) next.add(f.path);
      return next;
    });
  };

  const selectFolder = async () => {
    try {
      const dir = await open({
        directory: true,
        title: "Select music folder",
        defaultPath: defaultFolder || undefined,
      });
      if (typeof dir !== "string") return;
      setScanning(true);
      const found = await invoke<AudioFile[]>("scan_folder", { path: dir, recursive });
      merge(found);
      onFolderPicked(dir);
      notify(
        found.length
          ? `Found ${found.length} audio file${found.length === 1 ? "" : "s"}`
          : "No audio files found in that folder",
        found.length ? "success" : "info",
      );
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setScanning(false);
    }
  };

  const addFiles = async () => {
    try {
      const picked = await open({
        multiple: true,
        title: "Add audio files",
        filters: [{ name: "Audio files", extensions: [...AUDIO_EXTENSIONS] }],
      });
      if (!picked) return;
      const paths = Array.isArray(picked) ? picked : [picked];
      const found = await invoke<AudioFile[]>("list_files", { paths });
      merge(found);
      notify(`Added ${found.length} file${found.length === 1 ? "" : "s"}`, "success");
    } catch (e) {
      notify(String(e), "error");
    }
  };

  /** Imports dropped paths (files and/or folders). */
  const importPaths = async (paths: string[]) => {
    if (!paths.length) return;
    try {
      setScanning(true);
      const found = await invoke<AudioFile[]>("import_paths", { paths, recursive });
      merge(found);
      notify(
        found.length
          ? `Added ${found.length} file${found.length === 1 ? "" : "s"}`
          : "No audio files in the dropped items",
        found.length ? "success" : "info",
      );
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setScanning(false);
    }
  };

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const setAll = (checked: boolean) => {
    setSelected(checked ? new Set(files.map((f) => f.path)) : new Set());
  };

  const setManySelected = (paths: string[], checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (checked) next.add(p);
        else next.delete(p);
      }
      return next;
    });
  };

  const clearList = () => {
    setFiles([]);
    setSelected(new Set());
  };

  /** Re-reads file info (size, hasBackup) after writes. */
  const refresh = async () => {
    if (!files.length) return;
    try {
      const updated = await invoke<AudioFile[]>("list_files", {
        paths: files.map((f) => f.path),
      });
      setFiles(updated);
    } catch (e) {
      console.error("Failed to refresh file list:", e);
    }
  };

  /** Drops files from the list (e.g. after they were deleted from disk). */
  const removeFiles = (paths: string[]) => {
    const gone = new Set(paths);
    setFiles((prev) => prev.filter((f) => !gone.has(f.path)));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of paths) next.delete(p);
      return next;
    });
  };

  /** Applies path changes after a rename, preserving order and selection. */
  const remap = (mapping: Record<string, AudioFile>) => {
    setFiles((prev) => prev.map((f) => mapping[f.path] ?? f));
    setSelected((prev) => {
      const next = new Set<string>();
      for (const p of prev) next.add(mapping[p]?.path ?? p);
      return next;
    });
  };

  const selectedPaths = useMemo(
    () => files.filter((f) => selected.has(f.path)).map((f) => f.path),
    [files, selected],
  );
  const totalSize = useMemo(() => files.reduce((sum, f) => sum + f.size, 0), [files]);

  return {
    files,
    selected,
    selectedPaths,
    totalSize,
    scanning,
    selectFolder,
    addFiles,
    importPaths,
    toggle,
    setAll,
    setManySelected,
    clearList,
    refresh,
    remap,
    removeFiles,
  };
}
