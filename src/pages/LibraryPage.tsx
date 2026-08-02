import {
  Archive,
  Eraser,
  FilePlus2,
  FolderOpen,
  Hash,
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
import { activePreset } from "../lib/genres";
import { TrackTable } from "../components/TrackTable";
import PreviewTable from "../components/PreviewTable";
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
  onRename: () => void;
  onClearFields: () => void;
  onAddGenre: (genre: string) => void;
  onRenameGenre: (oldName: string, newName: string) => void;
  onBackup: () => void;
  onRestore: () => void;
  onEditField: (paths: string[], field: keyof TagData & string, value: string) => void;
  onEditRating: (paths: string[], stars: number) => void;
  onInspect: (file: AudioFile) => void;
  onSaveSettings: (settings: Settings) => void;
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
  onRename,
  onClearFields,
  onAddGenre,
  onRenameGenre,
  onBackup,
  onRestore,
  onEditField,
  onEditRating,
  onInspect,
  onSaveSettings,
}: Props) {
  const selectedCount = filesApi.selectedPaths.length;
  const noSel = busy || selectedCount === 0;
  const backupCount = filesApi.files.filter(
    (f) => filesApi.selected.has(f.path) && f.hasBackup,
  ).length;
  const genreOptions = activePreset(settings.genrePresets, settings.activeGenrePreset)?.genres ?? [];

  // AI/Standardize/Genre/Clear previews are shown inline in the table itself.
  // Strip keeps the dedicated table below, since it removes arbitrary custom
  // tag fields that have no corresponding column to show a diff in.
  const inlinePreview = !!pending && previewMode !== "strip";
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
          <Button variant="secondary" onClick={filesApi.selectFolder} disabled={busy} title="Ctrl+O">
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
              Click a highlighted cell to include/exclude it, double-click to edit the new value.
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
            title="Undo (Ctrl+Z)"
          >
            <RotateCcw />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onRedo}
            disabled={busy || !canRedo}
            title="Redo (Ctrl+Shift+Z)"
          >
            <RotateCw />
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
            <Button variant="violet" onClick={onAIClean} disabled={noSel}>
              <Sparkles />
              AI Clean
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
          <Button
            variant="secondary"
            size="sm"
            onClick={onClearFields}
            disabled={noSel}
            title={`Erase these fields: ${settings.clearFields.join(", ") || "(none set)"}`}
          >
            <Trash2 />
            Clear Fields
          </Button>
          <Button variant="secondary" size="sm" onClick={onGenre} disabled={noSel}>
            <Tags />
            Genre: {settings.activeGenrePreset}
          </Button>

          <span className="mx-1 h-6 w-px bg-border" />

          <Button variant="secondary" size="sm" onClick={onGenerateIds} disabled={noSel}>
            <Hash />
            Generate IDs
          </Button>
          <Button variant="secondary" size="sm" onClick={onRename} disabled={noSel}>
            <Type />
            Rename to Standard
          </Button>

          <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <SquarePen className="h-3.5 w-3.5" />
            Double-click a field to edit · artwork for all tags
          </span>
        </div>
      )}

      {pending && previewMode === "strip" ? (
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
          unresolved={unresolved}
          selected={filesApi.selected}
          visibleColumns={settings.visibleColumns}
          columnWidths={settings.columnWidths}
          highlightSymbols={settings.highlightSymbols}
          rowHeight={settings.rowHeight}
          genreOptions={genreOptions}
          onToggle={filesApi.toggle}
          onSetAll={filesApi.setAll}
          onVisibleColumnsChange={(cols) => onSaveSettings({ ...settings, visibleColumns: cols })}
          onColumnWidthsChange={(widths) => onSaveSettings({ ...settings, columnWidths: widths })}
          onRowHeightChange={(h: RowHeight) => onSaveSettings({ ...settings, rowHeight: h })}
          onEditField={onEditField}
          onEditRating={onEditRating}
          onInspect={onInspect}
          onAddGenre={onAddGenre}
          onRenameGenre={onRenameGenre}
          pending={inlinePreview ? pending : null}
          onPendingChange={onPendingChange}
        />
      )}
    </div>
  );
}
