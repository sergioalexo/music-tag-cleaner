import { useCallback, useEffect, useRef, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Upload, X } from "lucide-react";

import { Sidebar, type Page } from "./components/Sidebar";
import StatusBar from "./components/StatusBar";
import { Card, cn } from "./components/ui";
import { useAI } from "./hooks/useAI";
import { useCovers } from "./hooks/useCovers";
import { useFiles } from "./hooks/useFiles";
import { useSettings } from "./hooks/useSettings";
import { useTags } from "./hooks/useTags";
import { ComponentsPage } from "./pages/ComponentsPage";
import { LibraryPage } from "./pages/LibraryPage";
import { SettingsPage } from "./pages/SettingsPage";
import {
  applyCapitalization,
  applyReplacements,
  removeCharsFrom,
} from "./lib/standardize";
import { activePreset } from "./lib/genres";
import {
  FIELD_LABELS,
  type AudioFile,
  type PendingChange,
  type PreviewMode,
  type TagData,
} from "./types";

interface Toast {
  id: number;
  message: string;
  kind: "success" | "error" | "info";
}

interface HistoryChange {
  path: string;
  field: string;
  before: string | number;
  after: string | number;
}

interface HistoryEntry {
  label: string;
  changes: HistoryChange[];
}

const HISTORY_LIMIT = 50;

let toastId = 0;

export default function App() {
  const { settings, save, loaded } = useSettings();
  const [page, setPage] = useState<Page>("library");
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback((message: string, kind: Toast["kind"] = "info") => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);

  // Keep a live reference so async callbacks always see current settings.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const filesApi = useFiles(
    settings.recursive,
    notify,
    (folder) => save({ ...settingsRef.current, lastFolder: folder }),
    settings.lastFolder,
  );
  const tagsApi = useTags();
  const ai = useAI();
  const { covers, invalidate: invalidateCovers } = useCovers(filesApi.files);

  const [libraryTags, setLibraryTags] = useState<Record<string, TagData>>({});
  const [pending, setPending] = useState<PendingChange[] | null>(null);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("strip");
  const [tagsMap, setTagsMap] = useState<Record<string, TagData>>({});
  const [busy, setBusy] = useState(false);
  const [aiRunning, setAiRunning] = useState(false);
  const [backupRunning, setBackupRunning] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryEntry[]>([]);

  const pushHistory = (entry: HistoryEntry) => {
    if (!entry.changes.length) return;
    setHistory((h) => [...h.slice(-(HISTORY_LIMIT - 1)), entry]);
    setRedoStack([]);
  };

  /** Writes `before` (undo) or `after` (redo) for every change in `changes`. */
  const applyHistoryChanges = async (changes: HistoryChange[], useAfter: boolean) => {
    const paths = [...new Set(changes.map((c) => c.path))];
    const { map } = await tagsApi.read(paths);
    for (const c of changes) {
      const current = map[c.path];
      if (!current) continue;
      const value = useAfter ? c.after : c.before;
      const field = c.field as keyof TagData & string;
      const tagsForWrite = c.field === "rating" ? { ...current, rating: Number(value) } : current;
      await tagsApi.updateField(c.path, tagsForWrite, field, value, settings);
      (map[c.path] as unknown as Record<string, string | number>)[c.field] = value;
    }
  };

  const undo = async () => {
    const entry = history[history.length - 1];
    if (!entry || busy) return;
    setBusy(true);
    try {
      await applyHistoryChanges(entry.changes, false);
      setHistory((h) => h.slice(0, -1));
      setRedoStack((r) => [...r, entry]);
      setLibraryTags({});
      await filesApi.refresh();
      notify(`Undid: ${entry.label}`, "success");
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const redo = async () => {
    const entry = redoStack[redoStack.length - 1];
    if (!entry || busy) return;
    setBusy(true);
    try {
      await applyHistoryChanges(entry.changes, true);
      setRedoStack((r) => r.slice(0, -1));
      setHistory((h) => [...h, entry]);
      setLibraryTags({});
      await filesApi.refresh();
      notify(`Redid: ${entry.label}`, "success");
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const [dropActive, setDropActive] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(
    null,
  );
  const [inspected, setInspected] = useState<{ file: AudioFile; tags: TagData } | null>(null);
  // Tracks the AI could not identify from tags or filename — flagged for manual edit.
  const [unresolved, setUnresolved] = useState<Set<string>>(new Set());

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

  useEffect(() => {
    if (loaded) ai.check(settings.ollamaUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // Eagerly read tags for files in the list so table columns fill in.
  useEffect(() => {
    const missing = filesApi.files.map((f) => f.path).filter((p) => !libraryTags[p]);
    if (!missing.length) return;
    let cancelled = false;
    (async () => {
      try {
        const { map } = await tagsApi.read(missing);
        if (!cancelled) setLibraryTags((prev) => ({ ...prev, ...map }));
      } catch (e) {
        console.error("Failed to read tags for table:", e);
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

  const afterWrite = async (affected: string[] = []) => {
    setPending(null);
    setInspected(null);
    setLibraryTags({});
    if (affected.length) invalidateCovers(affected);
    await filesApi.refresh();
  };

  const runCleanTags = async () => {
    const paths = filesApi.selectedPaths;
    if (!paths.length) return notify("No files selected", "info");
    if (!settings.stripToCommon)
      return notify('Enable "Strip to common tags only" in Settings to use Clean Tags', "info");
    setBusy(true);
    try {
      const { map, errors } = await tagsApi.read(paths);
      errors.forEach((e) => notify(e, "error"));
      const rows = tagsApi.buildStripPreview(map);
      setTagsMap(map);
      setPreviewMode("strip");
      setPending(rows);
      if (!rows.some((r) => r.changed))
        notify("Nothing to strip — these files already contain only common tags", "info");
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const runStandardize = async (
    mode: PreviewMode,
    transform: (value: string, field: string) => string,
    emptyMessage: string,
  ) => {
    const paths = filesApi.selectedPaths;
    if (!paths.length) return notify("No files selected", "info");
    setBusy(true);
    try {
      const { map, errors } = await tagsApi.read(paths);
      errors.forEach((e) => notify(e, "error"));
      const rows = tagsApi.buildStandardizePreview(paths, map, transform);
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

  const runGenre = async () => {
    const paths = filesApi.selectedPaths;
    if (!paths.length) return notify("No files selected", "info");
    const preset = activePreset(settings.genrePresets, settings.activeGenrePreset);
    if (!preset || preset.genres.length === 0)
      return notify("The active genre preset has no genres — add some in Settings", "info");

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
    const affected = [...new Set(pending.map((r) => r.path))];
    setBusy(true);
    try {
      const result =
        previewMode === "strip"
          ? await tagsApi.applyStrip(pending, tagsMap, settings)
          : await tagsApi.applyUpdates(pending, tagsMap, settings, previewMode === "clear");
      result.errors.forEach((e) => notify(e, "error"));
      if (result.written)
        notify(`Updated ${result.written} file${result.written === 1 ? "" : "s"}`, "success");
      // Strip removes arbitrary non-common fields we don't have "before" values
      // for beyond what's shown here, so it isn't added to the undo stack —
      // "Restore Backup" is the full-fidelity revert path for that action.
      if (previewMode !== "strip") {
        const changes = pending
          .filter((r) => r.kind === "update" && r.changed && r.include)
          .map((r) => ({ path: r.path, field: r.field, before: r.before, after: r.after }));
        pushHistory({ label: `Apply ${previewMode}`, changes });
      }
      await afterWrite(affected);
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
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
      if (result.assigned) save({ ...settingsRef.current, nextTrackId: result.nextId });
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

  const renameToStandard = async () => {
    const files = filesApi.files.filter((f) => filesApi.selected.has(f.path));
    if (!files.length) return notify("No files selected", "info");
    const ok = await confirm(
      `Rename ${files.length} file${files.length === 1 ? "" : "s"} to "artist - title - id"? ` +
        "Original tags are not affected.",
      { title: "Rename to Standard", kind: "info" },
    );
    if (!ok) return;
    setBusy(true);
    try {
      const { map, errors } = await tagsApi.read(files.map((f) => f.path));
      errors.forEach((e) => notify(e, "error"));
      const result = await tagsApi.renameFiles(files, map);
      result.errors.forEach((e) => notify(e, "error"));
      if (Object.keys(result.mapping).length) {
        invalidateCovers(Object.keys(result.mapping));
        filesApi.remap(result.mapping);
        setLibraryTags({});
      }
      if (result.written)
        notify(`Renamed ${result.written} file${result.written === 1 ? "" : "s"}`, "success");
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
      for (const path of paths) {
        const current = libraryTags[path];
        if (!current) continue;
        const before = (current as unknown as Record<string, string | undefined>)[field] ?? "";
        if (before === value) continue;
        await tagsApi.updateField(path, current, field, value, settings);
        changes.push({ path, field, before, after: value });
        clearUnresolved(path);
      }
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
      }
      await filesApi.refresh();
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
      for (const path of paths) {
        const current = libraryTags[path];
        if (!current) continue;
        const before = current.rating ?? 0;
        if (before === stars) continue;
        await tagsApi.updateField(path, { ...current, rating: stars }, "rating", stars, settings);
        changes.push({ path, field: "rating", before, after: stars });
      }
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
      }
      await filesApi.refresh();
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

  const runClearFields = async () => {
    const paths = filesApi.selectedPaths;
    if (!paths.length) return notify("No files selected", "info");
    if (!settings.clearFields.length)
      return notify("No fields chosen to clear — pick some in Settings", "info");
    setBusy(true);
    try {
      const { map, errors } = await tagsApi.read(paths);
      errors.forEach((e) => notify(e, "error"));
      const rows = tagsApi.buildClearPreview(paths, map, settings.clearFields);
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

  /** Renames a genre within the active preset in place. */
  const renameGenreInPreset = (oldName: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;
    save({
      ...settings,
      genrePresets: settings.genrePresets.map((p) =>
        p.name === settings.activeGenrePreset
          ? { ...p, genres: p.genres.map((g) => (g === oldName ? trimmed : g)) }
          : p,
      ),
    });
  };

  const inspect = (file: AudioFile) => {
    const tags = libraryTags[file.path];
    if (tags) setInspected({ file, tags });
  };

  // Keyboard shortcuts: Ctrl+O folder, Ctrl+A select all, Ctrl+Z/Shift+Z undo/redo, Escape close.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Let the browser handle native undo/redo while typing in a cell editor
      // or any other text field instead of hijacking it for tag history.
      const isEditable =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;

      if (e.ctrlKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        if (!busy) filesApi.selectFolder();
      } else if (e.ctrlKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        filesApi.setAll(true);
      } else if (e.ctrlKey && !isEditable && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) void redo();
        else void undo();
      } else if (e.ctrlKey && !isEditable && e.key.toLowerCase() === "y") {
        e.preventDefault();
        void redo();
      } else if (e.key === "Escape") {
        if (inspected) setInspected(null);
        else if (pending) setPending(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  return (
    <div className="flex h-screen flex-col">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar
          page={page}
          setPage={setPage}
          theme={settings.theme}
          onToggleTheme={() => save({ ...settings, theme: settings.theme === "dark" ? "light" : "dark" })}
          fileCount={filesApi.files.length}
          ollamaRunning={ai.status ? ai.status.running : null}
        />
        <main className="relative min-w-0 flex-1 overflow-y-auto">
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
              canUndo={history.length > 0}
              canRedo={redoStack.length > 0}
              onUndo={undo}
              onRedo={redo}
              pending={pending}
              previewMode={previewMode}
              lastFolder={settings.lastFolder}
              onPendingChange={setPending}
              onApplyPending={applyPending}
              onCancelPending={() => setPending(null)}
              onCleanTags={runCleanTags}
              onAIClean={runAIClean}
              onStopAI={ai.stop}
              onStandardize={runStandardizeRules}
              onRemoveChars={runRemoveChars}
              onGenre={runGenre}
              onGenerateIds={generateIds}
              onRename={renameToStandard}
              onClearFields={runClearFields}
              onAddGenre={addGenreToPreset}
              onRenameGenre={renameGenreInPreset}
              onBackup={runBackup}
              onRestore={restoreBackup}
              onEditField={editField}
              onEditRating={editRating}
              onInspect={inspect}
              onSaveSettings={save}
            />
          ) : page === "components" ? (
            <ComponentsPage
              ollamaUrl={settings.ollamaUrl}
              notify={notify}
              onOllamaChanged={() => void ai.check(settingsRef.current.ollamaUrl)}
            />
          ) : (
            <SettingsPage settings={settings} onSave={save} checkOllama={ai.check} />
          )}
        </main>
      </div>

      <StatusBar
        fileCount={filesApi.files.length}
        selectedCount={filesApi.selectedPaths.length}
        totalSize={filesApi.totalSize}
        ollama={ai.status}
        progress={progress}
      />

      {dropActive && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-primary/10 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-primary bg-card/90 px-10 py-8 text-primary">
            <Upload className="h-8 w-8" />
            <span className="text-sm font-medium">Drop audio files or folders to add them</span>
          </div>
        </div>
      )}

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
