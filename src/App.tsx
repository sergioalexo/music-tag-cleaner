import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { Upload, X } from "lucide-react";

import { Sidebar, type Page } from "./components/Sidebar";
import StatusBar from "./components/StatusBar";
import type { ManualMode, ManualResults } from "./components/ManualAIDialog";
import type { ConvertOptions } from "./components/ConvertDialog";
import type { UnifyGroup } from "./components/UnifyDialog";
import { Card, cn } from "./components/ui";
import { buildCleanRows, buildGenreRows, useAI } from "./hooks/useAI";
import { useCovers } from "./hooks/useCovers";
import { useImageInfo } from "./hooks/useImageInfo";
import { useAnalytics } from "./hooks/useAnalytics";
import { useFiles } from "./hooks/useFiles";
import { useHistory, type HistoryChange } from "./hooks/useHistory";
import { useSettings } from "./hooks/useSettings";
import { useTags } from "./hooks/useTags";
import { LibraryPage } from "./pages/LibraryPage";
import {
  applyCapitalization,
  applyReplacements,
  buildRenameStem,
  formatTrackId,
  isUid,
  removeCharsFrom,
} from "./lib/standardize";
import { activePreset, detectGenreGroups } from "./lib/genres";
import { matchesShortcut } from "./lib/shortcuts";
import { internalDrag } from "./lib/internalDrag";
import {
  basename,
  FIELD_LABELS,
  formatBytes,
  type AudioFile,
  type Capitalization,
  type ConvertOutcome,
  type DuplicateGroup,
  type FfmpegInfo,
  type PendingChange,
  type PreviewMode,
  type TagData,
} from "./types";

/**
 * Everything that isn't the Library page — the app's landing screen — is split
 * into its own chunk so the initial bundle the webview parses at launch stays
 * small. `prefetchSecondaryChunks` pulls them in once the app is idle, so the
 * first click on Settings or Duplicates is still instant.
 */
const ComponentsPage = lazy(() =>
  import("./pages/ComponentsPage").then((m) => ({ default: m.ComponentsPage })),
);
const DuplicatesPage = lazy(() =>
  import("./pages/DuplicatesPage").then((m) => ({ default: m.DuplicatesPage })),
);
const YtMusicImportPage = lazy(() =>
  import("./pages/YtMusicImportPage").then((m) => ({ default: m.YtMusicImportPage })),
);
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);
const LogsPage = lazy(() => import("./pages/LogsPage").then((m) => ({ default: m.LogsPage })));
const ManualAIDialog = lazy(() =>
  import("./components/ManualAIDialog").then((m) => ({ default: m.ManualAIDialog })),
);
const ConvertDialog = lazy(() =>
  import("./components/ConvertDialog").then((m) => ({ default: m.ConvertDialog })),
);
const UnifyDialog = lazy(() =>
  import("./components/UnifyDialog").then((m) => ({ default: m.UnifyDialog })),
);

function prefetchSecondaryChunks() {
  void import("./pages/SettingsPage");
  void import("./pages/DuplicatesPage");
  void import("./pages/LogsPage");
  void import("./pages/ComponentsPage");
  void import("./pages/YtMusicImportPage");
  void import("./components/ManualAIDialog");
  void import("./components/ConvertDialog");
  void import("./components/UnifyDialog");
}

interface Toast {
  id: number;
  message: string;
  kind: "success" | "error" | "info";
}

export interface LogEntry {
  id: number;
  time: number;
  message: string;
  kind: "success" | "error" | "info";
}

const LOG_LIMIT = 500;

/** Files per `read_tags_batch` call when filling the table in the background. */
const TAG_READ_CHUNK = 200;

let toastId = 0;

export default function App() {
  const { settings, save, update, loaded } = useSettings();
  const [page, setPage] = useState<Page>("library");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const notify = useCallback((message: string, kind: Toast["kind"] = "info") => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
    setLogs((prev) => [...prev.slice(-(LOG_LIMIT - 1)), { id, time: Date.now(), message, kind }]);
  }, []);

  // Keep a live reference so async callbacks always see current settings.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const filesApi = useFiles(
    settings.recursive,
    notify,
    (folder) => void update((prev) => ({ ...prev, lastFolder: folder })),
    settings.lastFolder,
  );
  const tagsApi = useTags();
  const ai = useAI();
  const { covers, invalidate: invalidateCovers } = useCovers(filesApi.files);
  const imageInfoApi = useImageInfo(filesApi.files, settings.visibleColumns.includes("imageInfo"));
  const analytics = useAnalytics();
  const withTrack = (name: string, fn: () => void) => () => {
    analytics.track(name);
    fn();
  };
  const withTrack1 = <T,>(name: string, fn: (arg: T) => void) => (arg: T) => {
    analytics.track(name);
    fn(arg);
  };

  const [libraryTags, setLibraryTags] = useState<Record<string, TagData>>({});
  // Feeds Settings > Genre Presets > "Detect genres" — every distinct genre
  // spelling in the loaded collection, near-duplicates grouped together.
  const collectionGenreGroups = useMemo(
    () => detectGenreGroups(Object.values(libraryTags).map((t) => t.genre)),
    [libraryTags],
  );
  const [pending, setPending] = useState<PendingChange[] | null>(null);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("clear");
  const [tagsMap, setTagsMap] = useState<Record<string, TagData>>({});
  const [busy, setBusy] = useState(false);
  const [aiRunning, setAiRunning] = useState(false);
  const [backupRunning, setBackupRunning] = useState(false);
  const history = useHistory({
    tagsApi,
    settings,
    notify,
    busy,
    setBusy,
    invalidateCovers,
    dropLibraryTags: (paths) => dropLibraryTags(paths),
    resetLibraryTags: () => setLibraryTags({}),
    refreshPaths: (paths) => filesApi.refreshPaths(paths),
    refreshAll: () => filesApi.refresh(),
  });
  const pushHistory = history.push;

  /** Read-only diff of every change applied so far this session, reusing the preview table. */
  const showHistoryCompare = () => {
    setPreviewMode("history");
    setPending(history.compareRows());
  };

  const [dropActive, setDropActive] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(
    null,
  );
  const [inspected, setInspected] = useState<{ file: AudioFile; tags: TagData } | null>(null);
  // Tracks the AI could not identify from tags or filename — flagged for manual edit.
  const [unresolved, setUnresolved] = useState<Set<string>>(new Set());
  /** Open manual-AI session: the tracks and tags the copy/paste dialog works on. */
  const [manual, setManual] = useState<{
    mode: ManualMode;
    paths: string[];
    map: Record<string, TagData>;
    genres: string[];
  } | null>(null);

  // FFmpeg-backed conversion (v0.10). `ffmpegInfo` gates the Convert dialog.
  const [ffmpegInfo, setFfmpegInfo] = useState<FfmpegInfo | null>(null);
  const [convertOpen, setConvertOpen] = useState(false);
  /** A right-clicked file to convert on its own (vs. the whole selection). */
  const [convertSeedFile, setConvertSeedFile] = useState<AudioFile | null>(null);
  /** Preview state for "Unify Track IDs" — null when the dialog is closed. */
  const [unifyState, setUnifyState] = useState<{ groups: UnifyGroup[]; alternates: number } | null>(
    null,
  );

  const refreshFfmpeg = useCallback(async () => {
    try {
      setFfmpegInfo(await invoke<FfmpegInfo>("ffmpeg_info"));
    } catch {
      setFfmpegInfo({ installed: false, managed: false });
    }
  }, []);

  const clearUnresolved = (path: string) =>
    setUnresolved((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });

  // Theme class on <html> (dark is the default, set in index.html).
  useEffect(() => {
    document.documentElement.classList.toggle("dark", settings.theme === "dark");
  }, [settings.theme]);

  // Warm the code-split chunks once the first paint is done, so switching
  // pages or opening a dialog never waits on a chunk fetch. FFmpeg detection
  // rides along: the Convert dialog needs its answer before it can render
  // correctly, but nothing on screen at launch does, and probing it means
  // spawning `ffmpeg -version` — work worth keeping off the startup path.
  const warmUp = useCallback(() => {
    prefetchSecondaryChunks();
    void refreshFfmpeg();
  }, [refreshFfmpeg]);
  useEffect(() => {
    // Called through `window` on purpose: these are Window methods and throw
    // "Illegal invocation" when detached into a bare local.
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(warmUp, { timeout: 3000 });
      return () => window.cancelIdleCallback?.(handle);
    }
    const timer = setTimeout(warmUp, 1200);
    return () => clearTimeout(timer);
  }, [warmUp]);

  useEffect(() => {
    if (loaded) ai.check(settings.ollamaUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // Accumulates local Ollama token usage into settings.usage as AI calls complete.
  useEffect(() => {
    const unlisten = listen<{
      model: string;
      promptEvalCount: number;
      evalCount: number;
      tracks: number;
    }>("ai-usage", (e) => {
      const { promptEvalCount, evalCount, tracks } = e.payload;
      // Accumulate against the newest settings, not a render snapshot — batches
      // can complete faster than React re-renders, and a plain read-modify-write
      // on settingsRef would drop every count but the last.
      void update((prev) => ({
        ...prev,
        usage: {
          totalPromptTokens: prev.usage.totalPromptTokens + promptEvalCount,
          totalCompletionTokens: prev.usage.totalCompletionTokens + evalCount,
          totalCalls: prev.usage.totalCalls + 1,
          songsProcessed: prev.usage.songsProcessed + tracks,
        },
      }));
    });
    return () => {
      unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Eagerly read tags for files in the list so table columns fill in.
  // Chunked so a large folder paints its first rows in a fraction of a second
  // instead of showing an empty table until every file has been parsed —
  // each chunk is still parsed across several threads on the Rust side.
  useEffect(() => {
    const missing = filesApi.files.map((f) => f.path).filter((p) => !libraryTags[p]);
    if (!missing.length) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < missing.length; i += TAG_READ_CHUNK) {
        if (cancelled) return;
        try {
          const { map } = await tagsApi.read(missing.slice(i, i + TAG_READ_CHUNK));
          if (cancelled) return;
          setLibraryTags((prev) => ({ ...prev, ...map }));
        } catch (e) {
          console.error("Failed to read tags for table:", e);
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesApi.files]);

  // Native drag-and-drop of files/folders onto the window.
  const importPathsRef = useRef(filesApi.importPaths);
  importPathsRef.current = filesApi.importPaths;
  useEffect(() => {
    const promise = getCurrentWebview().onDragDropEvent((event) => {
      // On Windows, this fires for ANY drag over the webview — including an
      // in-page HTML5 drag like column reordering — not just an external OS
      // file drag. Ignore it while TrackTable reports one in progress, so
      // dragging a column header doesn't paint the "drop files" overlay.
      if (internalDrag.active) return;
      const p = event.payload;
      if (p.type === "over" || p.type === "enter") setDropActive(true);
      else if (p.type === "leave") setDropActive(false);
      else if (p.type === "drop") {
        setDropActive(false);
        if (p.paths?.length) void importPathsRef.current(p.paths);
      }
    });
    return () => {
      promise.then((unlisten) => unlisten());
    };
  }, []);

  // Files the app was launched with ("Open with MusicTagCleaner" in Explorer,
  // or a path on the command line). The Rust side keeps a queue; we drain it on
  // mount, whenever the "open-files" event nudges us (a later "Open with"), and
  // a couple more times to catch the burst of processes a multi-file selection
  // spawns before this webview had a listener.
  useEffect(() => {
    const drain = () =>
      invoke<string[]>("take_opened_files")
        .then((paths) => {
          if (paths.length) void importPathsRef.current(paths);
        })
        .catch(() => {});
    const promise = listen("open-files", drain);
    drain();
    const timers = [setTimeout(drain, 800), setTimeout(drain, 2500)];
    return () => {
      timers.forEach(clearTimeout);
      promise.then((unlisten) => unlisten());
    };
  }, []);

  /**
   * Drops the cached tags for just `paths`, so the "eagerly read tags" effect
   * re-parses only those files from disk. Clearing the whole `libraryTags`
   * map instead — the previous behaviour — made every single-track edit
   * (write, undo, redo) re-parse the *entire* library, which on a large
   * collection is slow enough to look like the edit did nothing.
   */
  const dropLibraryTags = (paths: string[]) => {
    setLibraryTags((prev) => {
      const next = { ...prev };
      for (const p of paths) delete next[p];
      return next;
    });
  };

  const afterWrite = async (affected: string[] = []) => {
    setPending(null);
    setInspected(null);
    if (affected.length) {
      dropLibraryTags(affected);
      invalidateCovers(affected);
      await filesApi.refreshPaths(affected);
    } else {
      setLibraryTags({});
      await filesApi.refresh();
    }
  };

  // Remembers the transform used to build the current standardize preview so
  // applyPending can also apply it to filenames (see standardizeFilename).
  const lastStandardizeTransformRef = useRef<((value: string) => string) | null>(null);

  const runStandardize = async (
    mode: PreviewMode,
    transform: (value: string, field: string) => string,
    emptyMessage: string,
  ) => {
    const paths = filesApi.selectedPaths;
    if (!paths.length) return notify("No files selected", "info");
    lastStandardizeTransformRef.current = (v: string) => transform(v, "filename");
    setBusy(true);
    try {
      const { map, errors } = await tagsApi.read(paths);
      errors.forEach((e) => notify(e, "error"));
      const rows = tagsApi.buildStandardizePreview(paths, map, transform, settingsRef.current.standardizeFields);
      setTagsMap(map);
      setPreviewMode(mode);
      setPending(rows);
      if (!rows.some((r) => r.changed)) notify(emptyMessage, "info");
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const runStandardizeRules = () =>
    runStandardize(
      "standardize",
      (value) =>
        applyCapitalization(
          applyReplacements(value, settingsRef.current.replacements),
          settingsRef.current.capitalization,
        ),
      "Nothing to standardize with the current rules",
    );

  const runRemoveChars = () =>
    runStandardize(
      "standardize",
      (value) => removeCharsFrom(value, settingsRef.current.removeChars),
      `No "${settingsRef.current.removeChars}" characters found`,
    );

  /**
   * Capitalization pulled out of Standardize as its own action (CapitalizationMenu):
   * runs `mode` immediately and remembers it as the new default, same split-button
   * pattern as Clear Fields.
   */
  const runCapitalizationOnly = (mode: Capitalization) => {
    void save({ ...settings, capitalization: mode });
    runStandardize(
      "standardize",
      (value) => applyCapitalization(value, mode),
      "Nothing to change with this capitalization",
    );
  };

  /**
   * The character/separator rules (feat. normalization, bracket style, dash
   * spacing, junk-suffix removal, whitespace collapse) pulled out of
   * Standardize as their own action — everything Standardize does *except*
   * recasing.
   */
  const runCharacterRules = () =>
    runStandardize(
      "standardize",
      (value) => applyReplacements(value, settingsRef.current.replacements),
      "Nothing to change with the current character rules",
    );

  /**
   * Manual backend: read the tags, then hand the tracks to the copy/paste
   * dialog instead of calling Ollama. Nothing leaves the app on its own — the
   * user pastes the prompt into whichever AI they like.
   */
  const openManual = async (mode: ManualMode, genres: string[] = []) => {
    const paths = filesApi.selectedPaths;
    setBusy(true);
    try {
      const { map, errors } = await tagsApi.read(paths);
      errors.forEach((e) => notify(e, "error"));
      const valid = paths.filter((p) => map[p]);
      if (!valid.length) return notify("Could not read tags for the selected files", "error");
      setManual({ mode, paths: valid, map, genres });
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  /** Turns the answers pasted into the dialog into the usual preview rows. */
  const applyManualResults = (results: ManualResults) => {
    if (!manual) return;
    const { paths, map } = manual;
    setTagsMap(map);
    if (results.mode === "clean") {
      const { rows, unresolved: unresolvedPaths } = buildCleanRows(paths, map, results.byIndex);
      setPreviewMode("ai");
      setUnresolved(new Set(unresolvedPaths));
      setPending(rows);
      if (!rows.some((r) => r.changed)) notify("That answer changes nothing", "info");
      if (unresolvedPaths.length)
        notify(
          `${unresolvedPaths.length} track${
            unresolvedPaths.length === 1 ? "" : "s"
          } couldn't be identified — highlighted in amber. Edit them manually.`,
          "error",
        );
    } else {
      const rows = buildGenreRows(paths, map, results.byIndex);
      setPreviewMode("genre");
      setPending(rows);
      if (!rows.some((r) => r.changed)) notify("Genres already match the preset", "info");
    }
    setManual(null);
  };

  const runGenre = async () => {
    const paths = filesApi.selectedPaths;
    if (!paths.length) return notify("No files selected", "info");
    const preset = activePreset(settings.genrePresets, settings.activeGenrePreset);
    if (!preset || preset.genres.length === 0)
      return notify("The active genre preset has no genres — add some in Settings", "info");

    if (settings.aiBackend === "manual") return openManual("genre", preset.genres);

    const status = await ai.check(settings.ollamaUrl);
    if (!status.running) {
      notify(
        "Ollama not detected. Make sure Ollama is running locally. Download at ollama.com",
        "error",
      );
      return;
    }
    const model = settings.ollamaModel || status.models[0];
    if (!model) {
      notify("No Ollama models installed. Pull one first, e.g.: ollama pull llama3.1", "error");
      return;
    }

    setBusy(true);
    setAiRunning(true);
    try {
      const { map, errors } = await tagsApi.read(paths);
      errors.forEach((e) => notify(e, "error"));
      const { rows, stopped } = await ai.runGenre(
        paths,
        map,
        settings,
        model,
        preset.genres,
        (done, total) =>
          setProgress({
            done,
            total,
            label: `Genre ${Math.min(done + 1, total)} of ${total}`,
          }),
      );
      setTagsMap(map);
      setPreviewMode("genre");
      if (stopped && rows.length === 0) {
        notify("Genre matching stopped — no results", "info");
      } else {
        setPending(rows);
        if (stopped) notify("Genre matching stopped — showing results so far", "info");
        else if (!rows.some((r) => r.changed)) notify("Genres already match the preset", "info");
      }
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setProgress(null);
      setAiRunning(false);
      setBusy(false);
    }
  };

  const runAIClean = async () => {
    const paths = filesApi.selectedPaths;
    if (!paths.length) return notify("No files selected", "info");

    if (settings.aiBackend === "manual") return openManual("clean");

    const status = await ai.check(settings.ollamaUrl);
    if (!status.running) {
      notify(
        "Ollama not detected. Make sure Ollama is running locally. Download at ollama.com",
        "error",
      );
      return;
    }
    const model = settings.ollamaModel || status.models[0];
    if (!model) {
      notify("No Ollama models installed. Pull one first, e.g.: ollama pull llama3.1", "error");
      return;
    }

    setBusy(true);
    setAiRunning(true);
    try {
      const { map, errors } = await tagsApi.read(paths);
      errors.forEach((e) => notify(e, "error"));
      const { rows, stopped, unresolved: unresolvedPaths } = await ai.runClean(
        paths,
        map,
        settings,
        model,
        (done, total) =>
          setProgress({
            done,
            total,
            label: `Processing track ${Math.min(done + 1, total)} of ${total}`,
          }),
      );
      setTagsMap(map);
      setPreviewMode("ai");
      setUnresolved(new Set(unresolvedPaths));
      if (stopped && rows.length === 0) {
        notify("AI stopped — no results to show", "info");
      } else {
        setPending(rows);
        if (stopped) notify("AI stopped — showing results processed so far", "info");
        else if (!rows.some((r) => r.changed)) notify("AI found nothing to change", "info");
      }
      if (unresolvedPaths.length)
        notify(
          `${unresolvedPaths.length} track${
            unresolvedPaths.length === 1 ? "" : "s"
          } couldn't be identified from tags or filename — highlighted in amber. Edit them manually.`,
          "error",
        );
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setProgress(null);
      setAiRunning(false);
      setBusy(false);
    }
  };

  const applyPending = async () => {
    if (!pending) return;
    // The Compare view reuses `pending` to render a read-only session diff. Its
    // rows carry synthetic fields (__coverArt, __raw:*) and no matching tagsMap,
    // so they must never be written back.
    if (previewMode === "history") return setPending(null);
    const affected = [...new Set(pending.map((r) => r.path))];
    setBusy(true);
    const onWriteProgress = (done: number, total: number) =>
      setProgress({ done, total, label: `Writing ${Math.min(done, total)} of ${total}` });
    try {
      const result = await tagsApi.applyUpdates(pending, tagsMap, settings, onWriteProgress);
      result.errors.forEach((e) => notify(e, "error"));
      if (result.written)
        notify(`Updated ${result.written} file${result.written === 1 ? "" : "s"}`, "success");
      // Cleared raw frames stay out of history — they can't be re-created from
      // the key alone, so "Restore Backup" is their revert path. Curated
      // clears are `kind: "remove"`, so match those too.
      const changes = pending
        .filter(
          (r) =>
            r.changed && r.include && !r.raw && (r.kind === "update" || previewMode === "clear"),
        )
        .map((r) => ({ path: r.path, field: r.field, before: r.before, after: r.after }));
      pushHistory({ label: `Apply ${previewMode}`, changes });
      await afterWrite(affected);
      if (previewMode === "standardize" && settings.standardizeFilename && lastStandardizeTransformRef.current) {
        await renameFilenamesInPlace(affected, lastStandardizeTransformRef.current);
      }
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setProgress(null);
      setBusy(false);
    }
  };

  /** Applies `transform` to each affected file's stem (extension preserved), used by Standardize's filename scope. */
  const renameFilenamesInPlace = async (paths: string[], transform: (stem: string) => string) => {
    let renamed = 0;
    for (const path of paths) {
      const file = filesApi.files.find((f) => f.path === path);
      if (!file) continue;
      const dot = file.filename.lastIndexOf(".");
      const stem = dot > 0 ? file.filename.slice(0, dot) : file.filename;
      const newStem = transform(stem).trim();
      if (!newStem || newStem === stem) continue;
      try {
        const newPath = await invoke<string>("rename_file", { path, newStem });
        const [updated] = await invoke<AudioFile[]>("list_files", { paths: [newPath] });
        if (updated) {
          invalidateCovers([path]);
          filesApi.remap({ [path]: updated });
          renamed++;
        }
      } catch (e) {
        notify(String(e), "error");
      }
    }
    if (renamed) notify(`Renamed ${renamed} file${renamed === 1 ? "" : "s"}`, "success");
  };

  const generateIds = async () => {
    const paths = filesApi.selectedPaths;
    if (!paths.length) return notify("No files selected", "info");
    setBusy(true);
    try {
      const { map, errors } = await tagsApi.read(paths);
      errors.forEach((e) => notify(e, "error"));
      const result = await tagsApi.generateIds(paths, map, settings);
      result.errors.forEach((e) => notify(e, "error"));
      if (result.assigned) void update((prev) => ({ ...prev, nextTrackId: result.nextId }));
      notify(
        result.assigned
          ? `Assigned ${result.assigned} ID${result.assigned === 1 ? "" : "s"} (next: ${result.nextId
              .toString()
              .padStart(6, "0")})`
          : "No tracks to assign",
        result.assigned ? "success" : "info",
      );
      await afterWrite(paths);
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  // ---- v0.10: format conversion + cross-format grouping -------------------

  /** Opens the Convert dialog, optionally seeded with one right-clicked file. */
  const openConvert = (file?: AudioFile) => {
    if (!file && filesApi.selectedPaths.length === 0) {
      return notify("No files selected", "info");
    }
    setConvertSeedFile(file ?? null);
    setConvertOpen(true);
    void refreshFfmpeg(); // pick up an install done since last check
  };

  const runConvert = async (opts: ConvertOptions) => {
    setConvertOpen(false);
    const paths = convertSeedFile
      ? [convertSeedFile.path]
      : filesApi.files.filter((f) => filesApi.selected.has(f.path)).map((f) => f.path);
    setConvertSeedFile(null);
    if (!paths.length) return;

    setBusy(true);
    setProgress({ done: 0, total: paths.length, label: "Converting…" });
    const unlisten = await listen<{ done: number; total: number; file: string | null }>(
      "convert-progress",
      (e) => {
        const { done, total, file } = e.payload;
        setProgress({
          done,
          total,
          label: file ? `Converting ${basename(file)} (${done + 1}/${total})` : "Finishing…",
        });
      },
    );
    try {
      const outcomes = await invoke<ConvertOutcome[]>("convert_files", {
        paths,
        preset: opts.preset,
        subfolder: opts.output === "subfolder",
        overwrite: false,
      });
      const ok = outcomes.filter((o) => o.ok);
      const failed = outcomes.filter((o) => !o.ok);
      failed.forEach((o) => notify(`${basename(o.source)}: ${o.error}`, "error"));
      ok.filter((o) => o.error).forEach((o) => notify(`${basename(o.source)}: ${o.error}`, "info"));

      const newPaths = ok.map((o) => o.output!).filter(Boolean);
      if (opts.addToLibrary && newPaths.length) {
        const added = await invoke<AudioFile[]>("list_files", { paths: newPaths });
        filesApi.merge(added);
        dropLibraryTags(newPaths);
      }
      if (opts.deleteOriginals && ok.length) {
        for (const o of ok) {
          try {
            await invoke("delete_file", { path: o.source });
          } catch (e) {
            notify(`Could not remove ${basename(o.source)}: ${e}`, "error");
          }
        }
        const removed = ok.map((o) => o.source);
        invalidateCovers(removed);
        filesApi.removeFiles(removed);
      }
      if (ok.length) {
        notify(
          `Converted ${ok.length} file${ok.length === 1 ? "" : "s"}${
            failed.length ? `, ${failed.length} failed` : ""
          }`,
          failed.length ? "info" : "success",
        );
      }
    } catch (e) {
      notify(String(e), "error");
    } finally {
      unlisten();
      setProgress(null);
      setBusy(false);
    }
  };

  /**
   * Scans the loaded files for same-recording clusters (reusing the duplicate
   * detector) and previews assigning each cluster a shared Track ID, so the
   * files group as one track. Nothing is written until the dialog is confirmed.
   */
  const startUnify = async () => {
    const paths = filesApi.files.map((f) => f.path);
    if (paths.length < 2) return notify("Load at least two files first", "info");
    setBusy(true);
    setProgress({ done: 0, total: paths.length, label: "Scanning for matches…" });
    const unlisten = await listen<{ done: number; total: number; phase: string }>(
      "duplicate-scan-progress",
      (e) => {
        const { done, total, phase } = e.payload;
        setProgress({ done, total, label: `${phase} ${done}/${total}` });
      },
    );
    try {
      const { map } = await tagsApi.read(paths);
      setLibraryTags((prev) => ({ ...prev, ...map }));
      const clusters = await invoke<DuplicateGroup[]>("scan_duplicates", { paths });
      const dupes = clusters.filter((c) => c.kind === "duplicate");
      const alternates = clusters.filter((c) => c.kind === "alternate").length;

      let counter = settings.nextTrackId;
      const groups: UnifyGroup[] = dupes.map((c) => {
        const existing = c.paths
          .map((p) => map[p]?.trackId)
          .find((id) => isUid(id, settings.trackIdDigits));
        const canonicalId = existing ?? formatTrackId(counter++, settings.trackIdDigits);
        return {
          canonicalId,
          generated: !existing,
          members: c.paths.map((p) => {
            const fromId = map[p]?.trackId;
            const file = filesApi.files.find((f) => f.path === p);
            return {
              path: p,
              format: (file?.format || "?").toUpperCase(),
              fromId,
              changes: fromId !== canonicalId,
            };
          }),
        };
      });

      if (groups.every((g) => g.members.every((m) => !m.changes))) {
        notify(
          dupes.length
            ? "All matching files already share a Track ID"
            : "No same-recording matches found",
          "info",
        );
        return;
      }
      setUnifyState({ groups, alternates });
    } catch (e) {
      notify(String(e), "error");
    } finally {
      unlisten();
      setProgress(null);
      setBusy(false);
    }
  };

  const applyUnify = async () => {
    const state = unifyState;
    setUnifyState(null);
    if (!state) return;
    setBusy(true);
    try {
      const changes: HistoryChange[] = [];
      const edits = [];
      let maxCounter = settings.nextTrackId;
      const { map } = await tagsApi.read(
        state.groups.flatMap((g) => g.members.filter((m) => m.changes).map((m) => m.path)),
      );
      for (const g of state.groups) {
        const idNum = Number(g.canonicalId);
        if (g.generated && Number.isFinite(idNum)) maxCounter = Math.max(maxCounter, idNum + 1);
        for (const m of g.members) {
          if (!m.changes) continue;
          const current = map[m.path];
          if (!current) continue;
          edits.push({
            path: m.path,
            current,
            field: "trackId" as keyof TagData & string,
            value: g.canonicalId,
          });
          changes.push({
            path: m.path,
            field: "trackId",
            before: m.fromId ?? "",
            after: g.canonicalId,
          });
        }
      }
      const result = await tagsApi.updateFieldMany(edits, settings);
      result.errors.forEach((e) => notify(e, "error"));
      if (changes.length) {
        setLibraryTags((prev) => {
          const next = { ...prev };
          for (const c of changes) {
            if (next[c.path]) next[c.path] = { ...next[c.path], trackId: String(c.after) };
          }
          return next;
        });
        pushHistory({ label: `Unify Track IDs (${changes.length})`, changes });
        if (maxCounter !== settings.nextTrackId) {
          void update((prev) => ({ ...prev, nextTrackId: maxCounter }));
        }
        await filesApi.refreshPaths(changes.map((c) => c.path));
        notify(
          `Linked ${changes.length} file${changes.length === 1 ? "" : "s"} across ${state.groups.length} track${
            state.groups.length === 1 ? "" : "s"
          }`,
          "success",
        );
      }
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const renameToStandard = async () => {
    const files = filesApi.files.filter((f) => filesApi.selected.has(f.path));
    if (!files.length) return notify("No files selected", "info");
    // A deliberately narrowed selection (not "everything") is already an explicit
    // choice — only prompt when acting on the full/default set, where the blast
    // radius is bigger and less obviously intentional.
    const isPartialSelection = files.length < filesApi.files.length;
    if (!isPartialSelection) {
      const pattern = settings.strictFilenames ? "artist-title-id" : "artist - title - id";
      const ok = await confirm(
        `Rename ${files.length} file${files.length === 1 ? "" : "s"} to "${pattern}"? ` +
          "Original tags are not affected.",
        { title: "Rename to Standard", kind: "info" },
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      const { map, errors } = await tagsApi.read(files.map((f) => f.path));
      errors.forEach((e) => notify(e, "error"));

      // Warn (don't block) when two files would land on the same stem —
      // Rename to Standard still appends " (2)" on a real collision, but
      // strict mode makes near-duplicates ("Beyoncé" / "Beyonce") collapse
      // far more often, so it's worth calling out before writing anything.
      const stemCounts = new Map<string, number>();
      for (const file of files) {
        const tags = map[file.path];
        if (!tags) continue;
        const uid = isUid(tags.trackId, settings.trackIdDigits) ? tags.trackId : undefined;
        const stem = buildRenameStem(tags.artist, tags.title, uid, settings.strictFilenames);
        if (stem) stemCounts.set(stem, (stemCounts.get(stem) ?? 0) + 1);
      }
      const collisions = [...stemCounts.values()].filter((n) => n > 1).length;
      if (collisions > 0) {
        const ok = await confirm(
          `${collisions} file name${collisions === 1 ? "" : "s"} would collapse to the same name as ` +
            `another file. They'll get " (2)", " (3)", … appended so nothing is overwritten. Continue?`,
          { title: "Rename to Standard", kind: "warning" },
        );
        if (!ok) return;
      }

      const result = await tagsApi.renameFiles(
        files,
        map,
        settings.trackIdDigits,
        settings.strictFilenames,
      );
      result.errors.forEach((e) => notify(e, "error"));
      if (Object.keys(result.mapping).length) {
        invalidateCovers(Object.keys(result.mapping));
        filesApi.remap(result.mapping);
        // A rename only changes the path, not the tags — carry the cached
        // TagData over to the new path instead of clearing everything and
        // forcing a full-library re-read from disk.
        setLibraryTags((prev) => {
          const next: Record<string, TagData> = {};
          for (const [path, tags] of Object.entries(prev)) {
            const newPath = result.mapping[path]?.path ?? path;
            next[newPath] = tags;
          }
          return next;
        });
      }
      if (result.written)
        notify(`Renamed ${result.written} file${result.written === 1 ? "" : "s"}`, "success");
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const deleteFile = async (file: AudioFile) => {
    const ok = await confirm(
      `Delete "${file.filename}"? It will be moved to the Recycle Bin.`,
      { title: "Delete File", kind: "warning" },
    );
    if (!ok) return;
    try {
      await invoke("delete_file", { path: file.path });
      invalidateCovers([file.path]);
      filesApi.removeFiles([file.path]);
      setLibraryTags((prev) => {
        const next = { ...prev };
        delete next[file.path];
        return next;
      });
      notify(`Deleted "${file.filename}"`, "success");
    } catch (e) {
      notify(String(e), "error");
    }
  };

  /**
   * Batch removal for the Duplicates page: confirms with the exact count and
   * total size, then moves each file to the Recycle Bin (never a hard
   * delete) via the same `delete_file` command as the single-file path
   * above. Returns whether anything was actually removed, so the caller
   * knows whether to update its own UI.
   */
  const deleteDuplicateFiles = async (paths: string[]): Promise<boolean> => {
    if (!paths.length) return false;
    const totalBytes = paths.reduce(
      (sum, p) => sum + (filesApi.files.find((f) => f.path === p)?.size ?? 0),
      0,
    );
    const ok = await confirm(
      `Move ${paths.length} file${paths.length === 1 ? "" : "s"} (${formatBytes(totalBytes)}) to the Recycle Bin?`,
      { title: "Remove Duplicates", kind: "warning" },
    );
    if (!ok) return false;
    setBusy(true);
    let removed = 0;
    const errors: string[] = [];
    for (const p of paths) {
      try {
        await invoke("delete_file", { path: p });
        removed++;
      } catch (e) {
        errors.push(`${basename(p)}: ${e}`);
      }
    }
    errors.forEach((e) => notify(e, "error"));
    if (removed) {
      invalidateCovers(paths);
      filesApi.removeFiles(paths);
      setLibraryTags((prev) => {
        const next = { ...prev };
        for (const p of paths) delete next[p];
        return next;
      });
      notify(`Removed ${removed} file${removed === 1 ? "" : "s"}`, "success");
    }
    setBusy(false);
    return removed > 0;
  };

  /**
   * Simple backup archive (v0.9 F6): a store-only ZIP of the selection (or
   * the whole loaded collection if nothing is ticked) with a generated
   * name, a size estimate up front, and a manifest inside for later
   * verification. The user picks where it goes and moves it somewhere safe
   * themselves — no scheduling, no cloud, no incremental logic.
   */
  const runBackupArchive = async () => {
    const paths = filesApi.selectedPaths.length ? filesApi.selectedPaths : filesApi.files.map((f) => f.path);
    if (!paths.length) return notify("No files loaded", "info");
    const totalBytes = paths.reduce(
      (sum, p) => sum + (filesApi.files.find((f) => f.path === p)?.size ?? 0),
      0,
    );
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    const defaultName = `MusicTagCleaner-backup-${stamp}-${paths.length}-tracks.zip`;

    const ok = await confirm(
      `Archive ${paths.length} file${paths.length === 1 ? "" : "s"} (${formatBytes(totalBytes)}, uncompressed) into a single ZIP?`,
      { title: "Backup Archive", kind: "info" },
    );
    if (!ok) return;

    const dest = await saveDialog({
      title: "Save Backup Archive",
      defaultPath: defaultName,
      filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
    });
    if (!dest) return;

    setBusy(true);
    setProgress({ done: 0, total: paths.length, label: `Archiving 0 of ${paths.length}` });
    const unlisten = await listen<{ done: number; total: number }>("backup-archive-progress", (e) =>
      setProgress({
        done: e.payload.done,
        total: e.payload.total,
        label: `Archiving ${e.payload.done} of ${e.payload.total}`,
      }),
    );
    try {
      await invoke("create_backup_archive", { paths, destPath: dest });
      notify(`Backup archive saved (${paths.length} tracks, ${formatBytes(totalBytes)})`, "success");
      await revealItemInDir(dest);
    } catch (e) {
      notify(String(e), "error");
    } finally {
      unlisten();
      setProgress(null);
      setBusy(false);
    }
  };

  const setCoverArt = async (file: AudioFile) => {
    const picked = await open({
      title: "Choose Artwork",
      multiple: false,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "bmp"] }],
    });
    if (!picked || typeof picked !== "string") return;
    try {
      const before = await invoke<string | null>("read_cover_art", { path: file.path });
      await invoke("set_cover_art", { path: file.path, imagePath: picked });
      const after = await invoke<string | null>("read_cover_art", { path: file.path });
      invalidateCovers([file.path]);
      imageInfoApi.invalidate([file.path]);
      pushHistory({
        label: "Set artwork",
        changes: [{ path: file.path, field: "__coverArt", before: before ?? "", after: after ?? "" }],
      });
      notify("Artwork updated", "success");
    } catch (e) {
      notify(String(e), "error");
    }
  };

  const removeCoverArt = async (file: AudioFile) => {
    try {
      const before = await invoke<string | null>("read_cover_art", { path: file.path });
      if (!before) return; // Nothing to remove — no history entry needed.
      await invoke("remove_cover_art", { path: file.path });
      invalidateCovers([file.path]);
      imageInfoApi.invalidate([file.path]);
      pushHistory({
        label: "Remove artwork",
        changes: [{ path: file.path, field: "__coverArt", before, after: "" }],
      });
      notify("Artwork removed", "success");
    } catch (e) {
      notify(String(e), "error");
    }
  };

  const standardizeArtwork = async () => {
    const paths = filesApi.selectedPaths;
    if (!paths.length) return notify("No files selected", "info");
    const { artworkMaxDim, artworkJpegQuality } = settingsRef.current;
    setBusy(true);
    setProgress({ done: 0, total: paths.length, label: `Compressing artwork 0 of ${paths.length}` });
    const changes: HistoryChange[] = [];
    let savedBytes = 0;
    try {
      for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        try {
          const res = await invoke<{
            beforeDataUrl: string;
            afterDataUrl: string;
            beforeBytes: number;
            afterBytes: number;
          } | null>("standardize_artwork", {
            path,
            maxDim: artworkMaxDim,
            quality: artworkJpegQuality,
          });
          if (res) {
            changes.push({ path, field: "__coverArt", before: res.beforeDataUrl, after: res.afterDataUrl });
            savedBytes += Math.max(0, res.beforeBytes - res.afterBytes);
          }
        } catch (e) {
          notify(`${basename(path)}: ${e}`, "error");
        }
        setProgress({
          done: i + 1,
          total: paths.length,
          label: `Compressing artwork ${Math.min(i + 1, paths.length)} of ${paths.length}`,
        });
      }
      if (changes.length) {
        invalidateCovers(changes.map((c) => c.path));
        imageInfoApi.invalidate(changes.map((c) => c.path));
        pushHistory({ label: `Standardize artwork (${changes.length})`, changes });
      }
      notify(
        changes.length
          ? `Recompressed ${changes.length} cover${changes.length === 1 ? "" : "s"}${
              savedBytes > 0 ? `, saved ${formatBytes(savedBytes)}` : ""
            }`
          : "Every selected cover already meets the target",
        changes.length ? "success" : "info",
      );
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setProgress(null);
      setBusy(false);
    }
  };

  const renameSingleFile = async (path: string, newStem: string) => {
    setBusy(true);
    try {
      const newPath = await invoke<string>("rename_file", { path, newStem });
      const [updated] = await invoke<AudioFile[]>("list_files", { paths: [newPath] });
      if (updated) {
        invalidateCovers([path]);
        filesApi.remap({ [path]: updated });
        setLibraryTags((prev) => {
          if (!prev[path]) return prev;
          const next = { ...prev };
          next[newPath] = next[path];
          delete next[path];
          return next;
        });
        notify(`Renamed to "${updated.filename}"`, "success");
      }
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  /** Edits `field` on every path in `paths` (multi-select bulk edit shares one value). */
  const editField = async (paths: string[], field: keyof TagData & string, value: string) => {
    setBusy(true);
    try {
      const changes: HistoryChange[] = [];
      const edits = [];
      for (const path of paths) {
        const current = libraryTags[path];
        if (!current) continue;
        const before = (current as unknown as Record<string, string | undefined>)[field] ?? "";
        if (before === value) continue;
        edits.push({ path, current, field, value });
        changes.push({ path, field, before, after: value });
        clearUnresolved(path);
      }
      const result = await tagsApi.updateFieldMany(edits, settings);
      result.errors.forEach((e) => notify(e, "error"));
      if (changes.length) {
        setLibraryTags((prev) => {
          const next = { ...prev };
          for (const c of changes) next[c.path] = { ...next[c.path], [field]: value };
          return next;
        });
        pushHistory({
          label: `Edit ${FIELD_LABELS[field] ?? field}${changes.length > 1 ? ` (${changes.length} tracks)` : ""}`,
          changes,
        });
        await filesApi.refreshPaths(changes.map((c) => c.path));
      }
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  /** Edits (or, when `value` is empty, completely deletes) a raw "All Tags" field. */
  const editRawField = async (paths: string[], rawKey: string, value: string) => {
    setBusy(true);
    try {
      const changes: HistoryChange[] = [];
      const edits = [];
      for (const path of paths) {
        const current = libraryTags[path];
        const before = current?.allFields?.[rawKey] ?? "";
        if (before === value) continue;
        edits.push({ path, fieldKey: rawKey, value });
        changes.push({ path, field: `__raw:${rawKey}`, before, after: value });
      }
      const result = await tagsApi.updateRawFieldMany(edits);
      result.errors.forEach((e) => notify(e, "error"));
      if (changes.length) {
        setLibraryTags((prev) => {
          const next = { ...prev };
          for (const c of changes) {
            const tags = next[c.path];
            if (!tags) continue;
            const allFields = { ...tags.allFields };
            if (value) allFields[rawKey] = value;
            else delete allFields[rawKey];
            next[c.path] = { ...tags, allFields };
          }
          return next;
        });
        pushHistory({
          label: `Edit ${rawKey}${changes.length > 1 ? ` (${changes.length} tracks)` : ""}`,
          changes,
        });
        await filesApi.refreshPaths(changes.map((c) => c.path));
      }
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const editRating = async (paths: string[], stars: number) => {
    setBusy(true);
    try {
      const changes: HistoryChange[] = [];
      const edits = [];
      for (const path of paths) {
        const current = libraryTags[path];
        if (!current) continue;
        const before = current.rating ?? 0;
        if (before === stars) continue;
        edits.push({ path, current: { ...current, rating: stars }, field: "rating" as const, value: stars });
        changes.push({ path, field: "rating", before, after: stars });
      }
      const result = await tagsApi.updateFieldMany(edits, settings);
      result.errors.forEach((e) => notify(e, "error"));
      if (changes.length) {
        setLibraryTags((prev) => {
          const next = { ...prev };
          for (const c of changes) next[c.path] = { ...next[c.path], rating: stars };
          return next;
        });
        pushHistory({
          label: `Set rating${changes.length > 1 ? ` (${changes.length} tracks)` : ""}`,
          changes,
        });
        await filesApi.refreshPaths(changes.map((c) => c.path));
      }
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const runBackup = async () => {
    const paths = filesApi.selectedPaths;
    if (!paths.length) return notify("No files selected", "info");
    setBusy(true);
    setBackupRunning(true);
    try {
      const result = await tagsApi.backupSelected(paths, settings, (done, total) =>
        setProgress({ done, total, label: `Backing up ${Math.min(done + 1, total)} of ${total}` }),
      );
      result.errors.forEach((e) => notify(e, "error"));
      if (result.written)
        notify(`Backed up ${result.written} file${result.written === 1 ? "" : "s"}`, "success");
      if (result.stopped) notify("Backup stopped", "info");
      await afterWrite(paths);
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setProgress(null);
      setBackupRunning(false);
      setBusy(false);
    }
  };

  const runClearFields = async (fields: string[]) => {
    const paths = filesApi.selectedPaths;
    if (!paths.length) return notify("No files selected", "info");
    if (!fields.length) return notify("No fields chosen to clear", "info");
    const backupFieldKey =
      settings.backupField.charAt(0).toLowerCase() + settings.backupField.slice(1);
    if (settings.searchableBackup && fields.includes(backupFieldKey)) {
      const ok = await confirm(
        `"${backupFieldKey}" currently holds your searchable backup text. Clearing it will erase that backup — continue?`,
        { title: "Clearing the backup field", kind: "warning" },
      );
      if (!ok) return;
    }
    // Remember this pick as the new default for next time.
    if (fields.slice().sort().join("\n") !== settingsRef.current.clearFields.slice().sort().join("\n")) {
      void update((prev) => ({ ...prev, clearFields: fields }));
    }
    setBusy(true);
    try {
      const { map, errors } = await tagsApi.read(paths);
      errors.forEach((e) => notify(e, "error"));
      const rows = tagsApi.buildClearPreview(paths, map, fields);
      setTagsMap(map);
      setPreviewMode("clear");
      setPending(rows);
      if (!rows.some((r) => r.changed)) notify("The chosen fields are already empty", "info");
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const restoreBackup = async () => {
    const paths = filesApi.files
      .filter((f) => filesApi.selected.has(f.path) && f.hasBackup)
      .map((f) => f.path);
    if (!paths.length) return;
    const ok = await confirm(
      `This will restore all original tags for ${paths.length} file${
        paths.length === 1 ? "" : "s"
      }. Continue?`,
      { title: "Restore Backup", kind: "warning" },
    );
    if (!ok) return;
    setBusy(true);
    setBackupRunning(true);
    try {
      const result = await tagsApi.restore(paths, (done, total) =>
        setProgress({ done, total, label: `Restoring ${Math.min(done + 1, total)} of ${total}` }),
      );
      result.errors.forEach((e) => notify(e, "error"));
      if (result.written)
        notify(
          `Restored original tags for ${result.written} file${result.written === 1 ? "" : "s"}`,
          "success",
        );
      if (result.stopped) notify("Restore stopped", "info");
      await afterWrite(paths);
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setProgress(null);
      setBackupRunning(false);
      setBusy(false);
    }
  };

  /** Adds a genre to the active preset (used by the "+" row in the table's genre editor). */
  const addGenreToPreset = (genre: string) => {
    const trimmed = genre.trim();
    if (!trimmed) return;
    const preset = activePreset(settings.genrePresets, settings.activeGenrePreset);
    if (!preset || preset.genres.some((g) => g.toLowerCase() === trimmed.toLowerCase())) return;
    save({
      ...settings,
      genrePresets: settings.genrePresets.map((p) =>
        p.name === settings.activeGenrePreset ? { ...p, genres: [...p.genres, trimmed] } : p,
      ),
    });
  };

  /**
   * Renames a genre within the active preset, then — if any loaded track
   * still carries the old name — offers to retag the collection to match,
   * so the preset and the actual files don't drift apart.
   */
  const renameGenreInPreset = async (oldName: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;
    await save({
      ...settings,
      genrePresets: settings.genrePresets.map((p) =>
        p.name === settings.activeGenrePreset
          ? { ...p, genres: p.genres.map((g) => (g === oldName ? trimmed : g)) }
          : p,
      ),
    });
    const matching = Object.entries(libraryTags)
      .filter(([, t]) => t.genre === oldName)
      .map(([path]) => path);
    if (!matching.length) return;
    const ok = await confirm(
      `${matching.length} track${matching.length === 1 ? "" : "s"} in the collection ` +
        `${matching.length === 1 ? "uses" : "use"} "${oldName}". Rename ${
          matching.length === 1 ? "it" : "them"
        } to "${trimmed}"?`,
      { title: "Rename Genre", kind: "info" },
    );
    if (!ok) return;
    await editField(matching, "genre", trimmed);
  };

  /** Appends genre names to the active preset (skipping ones already there). */
  const addGenresToPreset = async (names: string[]) => {
    const preset = settings.genrePresets.find((p) => p.name === settings.activeGenrePreset);
    if (!preset) return;
    const existing = new Set(preset.genres.map((g) => g.toLowerCase()));
    const toAdd = names.filter((n) => n.trim() && !existing.has(n.trim().toLowerCase()));
    if (!toAdd.length) return;
    await save({
      ...settings,
      genrePresets: settings.genrePresets.map((p) =>
        p.name === settings.activeGenrePreset ? { ...p, genres: [...p.genres, ...toAdd] } : p,
      ),
    });
  };

  /**
   * Detect Genres found several raw spellings that normalize to the same
   * thing (e.g. "Hip Hop" / "Hip-Hop"). Offers to retag every track using a
   * non-canonical variant so the collection converges on one spelling.
   */
  const mergeGenreVariants = async (variants: string[], canonical: string) => {
    const nonCanonical = new Set(variants.filter((v) => v !== canonical));
    if (!nonCanonical.size) return;
    const matching = Object.entries(libraryTags)
      .filter(([, t]) => t.genre && nonCanonical.has(t.genre))
      .map(([path]) => path);
    if (!matching.length) return;
    const ok = await confirm(
      `${matching.length} track${matching.length === 1 ? "" : "s"} in the collection use a ` +
        `different spelling of "${canonical}" (${[...nonCanonical].join(", ")}). ` +
        `Retag ${matching.length === 1 ? "it" : "them"} to "${canonical}"?`,
      { title: "Merge Genre Spellings", kind: "info" },
    );
    if (!ok) return;
    await editField(matching, "genre", canonical);
  };

  const inspect = (file: AudioFile) => {
    const tags = libraryTags[file.path];
    if (tags) setInspected({ file, tags });
  };

  // Keyboard shortcuts: customizable via settings.shortcuts (see lib/shortcuts.ts), Escape close.
  // The handler closes over state that changes constantly (busy, pending, …), so
  // it lives in a ref that is refreshed each render while the listener itself is
  // attached only once — re-binding a window listener on every render is pure waste.
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandlerRef.current = (e: KeyboardEvent) => {
    {
      const target = e.target as HTMLElement | null;
      // Let the browser handle native undo/redo while typing in a cell editor
      // or any other text field instead of hijacking it for tag history.
      const isEditable =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      const overrides = settingsRef.current.shortcuts;

      if (matchesShortcut(e, "selectFolder", overrides)) {
        e.preventDefault();
        if (!busy) filesApi.selectFolder();
      } else if (!isEditable && matchesShortcut(e, "undo", overrides)) {
        e.preventDefault();
        void history.undo();
      } else if (!isEditable && matchesShortcut(e, "redo", overrides)) {
        e.preventDefault();
        void history.redo();
      } else if (!isEditable && e.ctrlKey && e.key.toLowerCase() === "y") {
        // Legacy secondary redo binding, not user-customizable.
        e.preventDefault();
        void history.redo();
      } else if (e.key === "Escape") {
        if (inspected) setInspected(null);
        else if (pending) setPending(null);
      }
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-screen flex-col">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar
          page={page}
          setPage={setPage}
          theme={settings.theme}
          onToggleTheme={() => save({ ...settings, theme: settings.theme === "dark" ? "light" : "dark" })}
          fileCount={filesApi.files.length}
          errorLogCount={logs.filter((l) => l.kind === "error").length}
        />
        <main className="relative min-w-0 flex-1 overflow-y-auto">
          <Suspense fallback={null}>
          {page === "library" ? (
            <LibraryPage
              filesApi={filesApi}
              libraryTags={libraryTags}
              covers={covers}
              unresolved={unresolved}
              settings={settings}
              busy={busy || filesApi.scanning}
              aiRunning={aiRunning}
              backupRunning={backupRunning}
              onStopBackup={tagsApi.stopBackup}
              canUndo={history.canUndo}
              canRedo={history.canRedo}
              onUndo={withTrack("undo", () => void history.undo())}
              onRedo={withTrack("redo", () => void history.redo())}
              historyTimeline={history.timeline.map((e) => ({
                label: e.label,
                changeCount: e.changes.length,
              }))}
              historyIndex={history.index}
              onJumpToHistory={history.jumpTo}
              onCompare={withTrack("compare", showHistoryCompare)}
              pending={pending}
              previewMode={previewMode}
              lastFolder={settings.lastFolder}
              onPendingChange={setPending}
              onApplyPending={applyPending}
              onCancelPending={() => setPending(null)}
              onAIClean={withTrack("aiClean", runAIClean)}
              onStopAI={ai.stop}
              onStandardize={withTrack("standardize", runStandardizeRules)}
              onCapitalization={withTrack1<Capitalization>("capitalization", runCapitalizationOnly)}
              onCharacterRules={withTrack("characterRules", runCharacterRules)}
              onRemoveChars={withTrack("removeChars", runRemoveChars)}
              onGenre={withTrack("genre", runGenre)}
              onGenerateIds={withTrack("generateIds", generateIds)}
              onUnifyIds={withTrack("unifyIds", () => void startUnify())}
              onConvert={withTrack("convert", () => openConvert())}
              onConvertFile={withTrack1("convertFile", (f: AudioFile) => openConvert(f))}
              onStandardizeArt={withTrack("standardizeArt", standardizeArtwork)}
              onRename={withTrack("renameToStandard", renameToStandard)}
              onClearFields={withTrack1("clearFields", runClearFields)}
              onAddGenre={addGenreToPreset}
              onRenameGenre={renameGenreInPreset}
              onBackup={withTrack("backup", runBackup)}
              onRestore={withTrack("restore", restoreBackup)}
              onBackupArchive={withTrack("backupArchive", runBackupArchive)}
              onEditField={editField}
              onEditRawField={editRawField}
              onEditRating={editRating}
              onInspect={inspect}
              onDeleteFile={withTrack1("deleteFile", deleteFile)}
              onRenameFile={renameSingleFile}
              imageInfo={imageInfoApi.info}
              onFetchImageInfo={imageInfoApi.fetchOne}
              onSetCoverArt={withTrack1("setCoverArt", setCoverArt)}
              onRemoveCoverArt={withTrack1("removeCoverArt", removeCoverArt)}
              onSaveSettings={save}
              backupFieldId={
                settings.searchableBackup
                  ? settings.backupField.charAt(0).toLowerCase() + settings.backupField.slice(1)
                  : null
              }
              shortcuts={settings.shortcuts}
              onTrack={analytics.track}
            />
          ) : page === "duplicates" ? (
            <DuplicatesPage
              files={filesApi.files}
              tags={libraryTags}
              notify={notify}
              onDelete={deleteDuplicateFiles}
              onInspect={(path) => {
                const file = filesApi.files.find((f) => f.path === path);
                if (file) inspect(file);
              }}
            />
          ) : page === "ytmusic" ? (
            <YtMusicImportPage
              files={filesApi.files}
              tags={libraryTags}
              notify={notify}
              onInspect={(path) => {
                const file = filesApi.files.find((f) => f.path === path);
                if (file) inspect(file);
              }}
            />
          ) : page === "components" ? (
            <ComponentsPage
              ollamaUrl={settings.ollamaUrl}
              notify={notify}
              onOllamaChanged={() => void ai.check(settingsRef.current.ollamaUrl)}
              onFfmpegChanged={refreshFfmpeg}
            />
          ) : page === "logs" ? (
            <LogsPage
              logs={logs}
              onClear={() => setLogs([])}
              actionCounts={analytics.counts}
              onResetActionCounts={analytics.reset}
            />
          ) : (
            <SettingsPage
              settings={settings}
              onSave={save}
              onRenameGenre={renameGenreInPreset}
              collectionGenreGroups={collectionGenreGroups}
              onAddGenres={addGenresToPreset}
              onMergeGenreVariants={mergeGenreVariants}
              checkOllama={ai.check}
              notify={notify}
            />
          )}
          </Suspense>
        </main>
      </div>

      <StatusBar
        fileCount={filesApi.files.length}
        selectedCount={filesApi.selectedPaths.length}
        totalSize={filesApi.totalSize}
        ollama={ai.status}
        progress={progress}
        busy={busy || filesApi.scanning || backupRunning || aiRunning}
      />

      {dropActive && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-primary/10 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-primary bg-card/90 px-10 py-8 text-primary">
            <Upload className="h-8 w-8" />
            <span className="text-sm font-medium">Drop audio files or folders to add them</span>
          </div>
        </div>
      )}

      <Suspense fallback={null}>
      {manual && (
        <ManualAIDialog
          mode={manual.mode}
          paths={manual.paths}
          tags={manual.map}
          transliterateScripts={settings.transliterateScripts}
          genres={manual.genres}
          chunkSize={settings.manualChunkSize}
          onChunkSizeChange={(size) => void update((prev) => ({ ...prev, manualChunkSize: size }))}
          onCancel={() => setManual(null)}
          onDone={applyManualResults}
        />
      )}

      {convertOpen && (
        <ConvertDialog
          ffmpeg={ffmpegInfo}
          count={
            convertSeedFile
              ? 1
              : filesApi.files.filter((f) => filesApi.selected.has(f.path)).length
          }
          settings={settings}
          onSaveSettings={save}
          onCancel={() => {
            setConvertOpen(false);
            setConvertSeedFile(null);
          }}
          onConvert={runConvert}
          onGoComponents={() => {
            setConvertOpen(false);
            setConvertSeedFile(null);
            setPage("components");
          }}
        />
      )}

      {unifyState && (
        <UnifyDialog
          groups={unifyState.groups}
          alternates={unifyState.alternates}
          onCancel={() => setUnifyState(null)}
          onConfirm={() => void applyUnify()}
        />
      )}
      </Suspense>

      {inspected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setInspected(null)}
        >
          <Card className="max-h-[85vh] w-[600px] overflow-y-auto">
            <div onClick={(e) => e.stopPropagation()} className="p-5">
              <div className="mb-1 flex items-start justify-between gap-4">
                <h2 className="min-w-0 truncate text-sm font-semibold">
                  {inspected.file.filename}
                </h2>
                <button
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setInspected(null)}
                  title="Escape"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className="mb-4 text-xs text-muted-foreground">
                {inspected.file.format.toUpperCase()} ·{" "}
                {inspected.tags.hasCoverArt ? "has cover art" : "no cover art"} ·{" "}
                {inspected.file.hasBackup ? "backup present" : "no backup"}
              </p>
              <TagDetails tags={inspected.tags} />
            </div>
          </Card>
        </div>
      )}

      <div className="pointer-events-none fixed bottom-10 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto max-w-sm rounded-lg border px-3 py-2 text-xs shadow-lg",
              t.kind === "success"
                ? "border-primary/40 bg-card text-primary"
                : t.kind === "error"
                  ? "border-destructive/40 bg-card text-destructive"
                  : "bg-card text-foreground",
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}

function TagDetails({ tags }: { tags: TagData }) {
  const rows = Object.entries(FIELD_LABELS)
    .map(([field, label]) => ({
      label,
      value: (tags as unknown as Record<string, string | undefined>)[field],
    }))
    .filter((r) => r.value);
  const extras = Object.entries(tags.allFields);

  return (
    <>
      <table className="w-full text-left text-xs">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t border-border/50">
              <td className="w-32 py-1.5 pr-3 text-muted-foreground">{r.label}</td>
              <td className="py-1.5">{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {extras.length > 0 && (
        <>
          <h3 className="mb-1 mt-6 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            All tag fields ({extras.length})
          </h3>
          <table className="w-full text-left text-xs">
            <tbody>
              {extras.map(([key, value]) => (
                <tr key={key} className="border-t border-border/50">
                  <td className="w-48 py-1 pr-3 align-top font-mono text-[11px] text-muted-foreground">
                    {key}
                  </td>
                  <td className="max-w-0 truncate py-1" title={value}>
                    {value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
