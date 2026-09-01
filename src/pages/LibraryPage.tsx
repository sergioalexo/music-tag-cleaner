import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Eraser,
  FilePlus2,
  FolderOpen,
  GitCompare,
  Hash,
  History,
  ImageDown,
  Paintbrush,
  RotateCcw,
  RotateCw,
  Sparkles,
  SquarePen,
  StopCircle,
  Tags,
  Trash2,
  Type,
  Undo2,
  Wand2,
} from "lucide-react";
import type { AudioFile, PendingChange, PreviewMode, RowHeight, Settings, TagData } from "../types";
import { KEPT_FIELD_KEYS } from "../types";
import type { ImageInfo as ImgInfo } from "../hooks/useImageInfo";
import { activePreset } from "../lib/genres";
import { shortcutFor } from "../lib/shortcuts";
import { TrackTable } from "../components/TrackTable";
import PreviewTable from "../components/PreviewTable";
import { ClearFieldsMenu } from "../components/ClearFieldsMenu";
import { Button } from "../components/ui";

interface FilesApi {
  files: AudioFile[];
  selected: Set<string>;
  selectedPaths: string[];
  scanning: boolean;
  selectFolder: () => void;
  addFiles: () => void;
  toggle: (path: string) => void;
  setAll: (checked: boolean) => void;
  setManySelected: (paths: string[], checked: boolean) => void;
  clearList: () => void;
}

interface Props {
  filesApi: FilesApi;
  libraryTags: Record<string, TagData>;
  covers: Record<string, string | null>;
  unresolved: Set<string>;
  settings: Settings;
  busy: boolean;
  aiRunning: boolean;
  backupRunning: boolean;
  onStopBackup: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  historyTimeline: { label: string; changeCount: number }[];
  historyIndex: number;
  onJumpToHistory: (index: number) => void;
  onCompare: () => void;
  pending: PendingChange[] | null;
  previewMode: PreviewMode;
  lastFolder: string;
  onPendingChange: (rows: PendingChange[]) => void;
  onApplyPending: () => void;
  onCancelPending: () => void;
  onCleanTags: () => void;
  onAIClean: () => void;
  onStopAI: () => void;
  onStandardize: () => void;
  onRemoveChars: () => void;
  onGenre: () => void;
  onGenerateIds: () => void;
  onStandardizeArt: () => void;
  onRename: () => void;
  onClearFields: (fields: string[]) => void;
  onAddGenre: (genre: string) => void;
  onRenameGenre: (oldName: string, newName: string) => void;
  onBackup: () => void;
  onRestore: () => void;
  onEditField: (paths: string[], field: keyof TagData & string, value: string) => void;
  onEditRawField: (paths: string[], rawKey: string, value: string) => void;
  onEditRating: (paths: string[], stars: number) => void;
  onInspect: (file: AudioFile) => void;
  onDeleteFile: (file: AudioFile) => void;
  onRenameFile: (path: string, newStem: string) => void;
  onSaveSettings: (settings: Settings) => void;
  backupFieldId: string | null;
  shortcuts: Record<string, string>;
  onTrack: (name: string) => void;
  imageInfo: Record<string, ImgInfo | null>;
  onFetchImageInfo: (path: string) => void;
  onSetCoverArt: (file: AudioFile) => void;
  onRemoveCoverArt: (file: AudioFile) => void;
}

export function LibraryPage({
  filesApi,
  libraryTags,
  covers,
  unresolved,
  settings,
  busy,
  aiRunning,
  backupRunning,
  onStopBackup,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  historyTimeline,
  historyIndex,
  onJumpToHistory,
  onCompare,
  pending,
  previewMode,
  lastFolder,
  onPendingChange,
  onApplyPending,
  onCancelPending,
  onCleanTags,
  onAIClean,
  onStopAI,
  onStandardize,
  onRemoveChars,
  onGenre,
  onGenerateIds,
  onStandardizeArt,
  onRename,
  onClearFields,
  onAddGenre,
  onRenameGenre,
  onBackup,
  onRestore,
  onEditField,
  onEditRawField,
  onEditRating,
  onInspect,
  onDeleteFile,
  onRenameFile,
  onSaveSettings,
  backupFieldId,
  shortcuts,
  onTrack,
  imageInfo,
  onFetchImageInfo,
  onSetCoverArt,
  onRemoveCoverArt,
}: Props) {
  const selectedCount = filesApi.selectedPaths.length;
  const noSel = busy || selectedCount === 0;
  const backupCount = filesApi.files.filter(
    (f) => filesApi.selected.has(f.path) && f.hasBackup,
  ).length;
  const genreOptions = activePreset(settings.genrePresets, settings.activeGenrePreset)?.genres ?? [];

  // Extra tag-frame keys present on the currently selected files, offered as
  // additional Clear Fields targets (curated fields already have their own).
  const clearableRawKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const path of filesApi.selectedPaths) {
      const extra = libraryTags[path]?.allFields;
      if (!extra) continue;
      for (const [k, v] of Object.entries(extra)) if (v && !KEPT_FIELD_KEYS.has(k)) keys.add(k);
    }
    return [...keys].sort();
  }, [filesApi.selectedPaths, libraryTags]);

  const [historyOpen, setHistoryOpen] = useState(false);
  const historyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!historyOpen) return;
    const close = (e: MouseEvent) => {
      if (!historyRef.current?.contains(e.target as Node)) setHistoryOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [historyOpen]);

  // AI/Standardize/Genre/Clear previews are shown inline in the table itself.
  // Strip keeps the dedicated table below, since it removes arbitrary custom
  // tag fields that have no corresponding column to show a diff in.
  // "history" is a read-only session diff and "strip" needs its own table, so
  // neither gets the inline editable preview (or its Apply bar).
  const inlinePreview = !!pending && previewMode !== "strip" && previewMode !== "history";
  const changedCount = pending?.filter((r) => r.changed).length ?? 0;
  const includedCount = pending?.filter((r) => r.changed && r.include).length ?? 0;
  const fileCount = pending
    ? new Set(pending.filter((r) => r.changed && r.include).map((r) => r.path)).size
    : 0;
  const modeLabel =
    previewMode === "ai"
      ? "AI Cleanup"
      : previewMode === "genre"
        ? "Genre Match"
        : previewMode === "clear"
          ? "Clear Fields"
          : "Standardize";

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-bold">Library</h1>
          <p className="truncate text-sm text-muted-foreground" title={lastFolder}>
            {lastFolder || "Strip messy tags, then let AI clean the rest"}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="secondary"
            onClick={filesApi.selectFolder}
            disabled={busy}
            title={`Choose a folder of music files to load (${shortcutFor("selectFolder", settings.shortcuts)})`}
          >
            <FolderOpen />
            Select Folder
          </Button>
          <Button variant="secondary" onClick={filesApi.addFiles} disabled={busy}>
            <FilePlus2 />
            Add Files
          </Button>
          {filesApi.files.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              onClick={filesApi.clearList}
              disabled={busy}
              title="Clear the list (files are not touched)"
            >
              <Trash2 />
            </Button>
          )}
        </div>
      </div>

      {inlinePreview && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2.5">
          <div className="min-w-0">
            <span className="text-sm font-semibold">{modeLabel} preview</span>
            <p className="text-xs text-muted-foreground">
              {includedCount} of {changedCount} change{changedCount === 1 ? "" : "s"} selected across{" "}
              {fileCount} file{fileCount === 1 ? "" : "s"} — nothing is written until you apply.
              Click a highlighted cell to include/exclude it, or the box in a column header to do
              the whole column. Select rows first (Shift/Ctrl+click) and one click covers that
              column across the selection. Double-click a cell to edit the new value.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                onPendingChange(pending!.map((r) => (r.changed ? { ...r, include: true } : r)))
              }
            >
              Select All
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                onPendingChange(pending!.map((r) => (r.changed ? { ...r, include: false } : r)))
              }
            >
              Deselect All
            </Button>
            <Button variant="outline" size="sm" onClick={onCancelPending} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={onApplyPending} disabled={busy || includedCount === 0}>
              Apply Selected ({includedCount})
            </Button>
          </div>
        </div>
      )}

      {!pending && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={onUndo}
            disabled={busy || !canUndo}
            title={`Undo the last change (${shortcutFor("undo", settings.shortcuts)})`}
          >
            <RotateCcw />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onRedo}
            disabled={busy || !canRedo}
            title={`Redo the last undone change (${shortcutFor("redo", settings.shortcuts)})`}
          >
            <RotateCw />
          </Button>
          <div className="relative" ref={historyRef}>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setHistoryOpen((o) => !o)}
              disabled={historyTimeline.length === 0}
              title="Version history — jump to any point in this session"
            >
              <History />
            </Button>
            {historyOpen && (
              <div className="absolute left-0 top-9 z-30 max-h-80 w-72 overflow-y-auto rounded-lg border bg-popover p-1.5 shadow-lg">
                <button
                  onClick={() => {
                    onJumpToHistory(-1);
                    setHistoryOpen(false);
                  }}
                  className={`w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent ${
                    historyIndex === -1 ? "bg-accent/60 font-medium" : "text-muted-foreground"
                  }`}
                >
                  Session start
                </button>
                {historyTimeline.map((entry, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      onJumpToHistory(i);
                      setHistoryOpen(false);
                    }}
                    className={`w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent ${
                      historyIndex === i ? "bg-accent/60 font-medium" : ""
                    }`}
                  >
                    {entry.label}
                    <span className="ml-1 text-muted-foreground">
                      ({entry.changeCount} change{entry.changeCount === 1 ? "" : "s"})
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onCompare}
            disabled={historyTimeline.length === 0}
            title="Compare — see everything changed this session"
          >
            <GitCompare />
          </Button>
          <span className="mx-1 h-6 w-px bg-border" />

          {backupRunning ? (
            <Button variant="destructive" onClick={onStopBackup}>
              <StopCircle />
              Stop
            </Button>
          ) : (
            <Button
              onClick={onBackup}
              disabled={noSel}
              title="Write the full + searchable backup for the selected files"
            >
              <Archive />
              Backup
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={onRestore}
            disabled={busy || backupCount === 0}
            title={
              backupCount === 0
                ? "None of the selected files contain a tag backup"
                : `${backupCount} selected file(s) contain a backup`
            }
          >
            <Undo2 />
            Restore{backupCount > 0 ? ` (${backupCount})` : ""}
          </Button>

          <span className="mx-1 h-6 w-px bg-border" />

          <Button variant="secondary" onClick={onCleanTags} disabled={noSel}>
            <Paintbrush />
            Clean Tags
          </Button>
          {aiRunning ? (
            <Button variant="destructive" onClick={onStopAI}>
              <StopCircle />
              Stop AI
            </Button>
          ) : (
            <Button
              variant="violet"
              onClick={onAIClean}
              disabled={noSel}
              title={
                settings.aiBackend === "manual"
                  ? "Copy the prompt into any AI (ChatGPT, Claude, Gemini…) and paste its answer back"
                  : "Clean Artist, Title, Year and Genre with the local Ollama model"
              }
            >
              <Sparkles />
              AI Clean{settings.aiBackend === "manual" ? " (manual)" : ""}
            </Button>
          )}

          <span className="mx-1 h-6 w-px bg-border" />

          <Button variant="secondary" size="sm" onClick={onStandardize} disabled={noSel}>
            <Wand2 />
            Standardize
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onRemoveChars}
            disabled={noSel}
            title={`Remove these characters: ${settings.removeChars || "(none set)"}`}
          >
            <Eraser />
            Remove {settings.removeChars || "chars"}
          </Button>
          <ClearFieldsMenu
            selected={settings.clearFields}
            rawKeys={clearableRawKeys}
            disabled={noSel}
            backupFieldKey={backupFieldId ?? undefined}
            onRun={onClearFields}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={onGenre}
            disabled={noSel}
            title={
              settings.aiBackend === "manual"
                ? `Match each genre to the "${settings.activeGenrePreset}" preset by copy/paste into any AI`
                : `Match each genre to the "${settings.activeGenrePreset}" preset using the local model`
            }
          >
            <Tags />
            Genre: {settings.activeGenrePreset}
          </Button>

          <span className="mx-1 h-6 w-px bg-border" />

          <Button variant="secondary" size="sm" onClick={onGenerateIds} disabled={noSel}>
            <Hash />
            Generate IDs
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onStandardizeArt}
            disabled={noSel}
            title={`Re-encode embedded cover art to JPEG q${settings.artworkJpegQuality}, longest side ≤ ${settings.artworkMaxDim}px`}
          >
            <ImageDown />
            Standardize Art
          </Button>
          <Button variant="secondary" size="sm" onClick={onRename} disabled={noSel}>
            <Type />
            Rename to Standard
          </Button>

          <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <SquarePen className="h-3.5 w-3.5" />
            Click to select, Shift/Ctrl to extend, Esc to clear · tick the box to choose targets
          </span>
        </div>
      )}

      {pending && (previewMode === "strip" || previewMode === "history") ? (
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-card">
          <PreviewTable
            rows={pending}
            mode={previewMode}
            busy={busy}
            onRowsChange={onPendingChange}
            onApply={onApplyPending}
            onCancel={onCancelPending}
          />
        </div>
      ) : (
        <TrackTable
          files={filesApi.files}
          tags={libraryTags}
          covers={covers}
          imageInfo={imageInfo}
          onFetchImageInfo={onFetchImageInfo}
          onSetCoverArt={onSetCoverArt}
          onRemoveCoverArt={onRemoveCoverArt}
          unresolved={unresolved}
          selected={filesApi.selected}
          visibleColumns={settings.visibleColumns}
          columnWidths={settings.columnWidths}
          highlightSymbols={settings.highlightSymbols}
          rowHeight={settings.rowHeight}
          genreOptions={genreOptions}
          onToggle={filesApi.toggle}
          onSetAll={filesApi.setAll}
          onSetMany={filesApi.setManySelected}
          onVisibleColumnsChange={(cols) => onSaveSettings({ ...settings, visibleColumns: cols })}
          onColumnWidthsChange={(widths) => onSaveSettings({ ...settings, columnWidths: widths })}
          onRowHeightChange={(h: RowHeight) => onSaveSettings({ ...settings, rowHeight: h })}
          onEditField={onEditField}
          onEditRawField={onEditRawField}
          onEditRating={onEditRating}
          onInspect={onInspect}
          onAddGenre={onAddGenre}
          onRenameGenre={onRenameGenre}
          onDeleteFile={onDeleteFile}
          onRenameFile={onRenameFile}
          backupFieldId={backupFieldId}
          shortcuts={shortcuts}
          onTrack={onTrack}
          pending={inlinePreview ? pending : null}
          onPendingChange={onPendingChange}
          previewMode={previewMode}
        />
      )}
    </div>
  );
}
