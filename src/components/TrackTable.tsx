import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Filter, Music, Rows3, SlidersHorizontal } from "lucide-react";
import type { AudioFile, RowHeight, TagData } from "../types";
import { formatBytes } from "../types";
import { hasWeirdChars, markWeird } from "../lib/standardize";
import { AudioPreview } from "./AudioPreview";
import { Combobox } from "./Combobox";
import { Stars } from "./Stars";
import { Button, cn } from "./ui";

export interface ColumnDef {
  id: string;
  label: string;
  width: number;
  field?: keyof TagData & string;
  value: (file: AudioFile, tags?: TagData) => string;
  align?: "right" | "center";
  /** Rendered with a custom cell (not text/editable). */
  custom?: "preview" | "rating";
}

export const ALL_COLUMNS: ColumnDef[] = [
  { id: "preview", label: "Preview", width: 150, value: () => "", custom: "preview" },
  { id: "filename", label: "File Name", width: 230, value: (f) => f.filename },
  { id: "title", label: "Title", width: 200, field: "title", value: (_f, t) => t?.title ?? "" },
  { id: "artist", label: "Artist", width: 170, field: "artist", value: (_f, t) => t?.artist ?? "" },
  { id: "album", label: "Album", width: 160, field: "album", value: (_f, t) => t?.album ?? "" },
  {
    id: "albumArtist",
    label: "Album Artist",
    width: 150,
    field: "albumArtist",
    value: (_f, t) => t?.albumArtist ?? "",
  },
  { id: "year", label: "Year", width: 66, field: "year", value: (_f, t) => t?.year ?? "" },
  { id: "genre", label: "Genre", width: 130, field: "genre", value: (_f, t) => t?.genre ?? "" },
  { id: "rating", label: "Rating", width: 100, value: () => "", custom: "rating" },
  {
    id: "trackNumber",
    label: "Track # / ID",
    width: 90,
    field: "trackNumber",
    value: (_f, t) => t?.trackNumber ?? "",
  },
  {
    id: "discNumber",
    label: "Disc #",
    width: 66,
    field: "discNumber",
    value: (_f, t) => t?.discNumber ?? "",
  },
  { id: "composer", label: "Composer", width: 170, field: "composer", value: (_f, t) => t?.composer ?? "" },
  {
    id: "originalArtist",
    label: "Original Artist",
    width: 180,
    field: "originalArtist",
    value: (_f, t) => t?.originalArtist ?? "",
  },
  { id: "comment", label: "Comment", width: 200, field: "comment", value: (_f, t) => t?.comment ?? "" },
  { id: "format", label: "Format", width: 72, value: (f) => f.format.toUpperCase() },
  { id: "size", label: "Size", width: 84, value: (f) => formatBytes(f.size), align: "right" },
];

const HIGHLIGHT_FIELDS = new Set(["title", "artist"]);
const MIN_WIDTH = 50;

const ROW_STYLE: Record<RowHeight, { py: string; img: string; art: number }> = {
  compact: { py: "py-0.5", img: "h-7 w-7", art: 40 },
  normal: { py: "py-1.5", img: "h-10 w-10", art: 52 },
  tall: { py: "py-2.5", img: "h-14 w-14", art: 68 },
};

const ROW_HEIGHTS: RowHeight[] = ["compact", "normal", "tall"];

interface Props {
  files: AudioFile[];
  tags: Record<string, TagData>;
  covers: Record<string, string | null>;
  unresolved: Set<string>;
  selected: Set<string>;
  visibleColumns: string[];
  columnWidths: Record<string, number>;
  highlightSymbols: boolean;
  rowHeight: RowHeight;
  genreOptions: string[];
  onToggle: (path: string) => void;
  onSetAll: (checked: boolean) => void;
  onVisibleColumnsChange: (columns: string[]) => void;
  onColumnWidthsChange: (widths: Record<string, number>) => void;
  onRowHeightChange: (height: RowHeight) => void;
  onEditField: (path: string, field: keyof TagData & string, value: string) => void;
  onEditRating: (path: string, stars: number) => void;
  onInspect: (file: AudioFile) => void;
}

export function TrackTable({
  files,
  tags,
  covers,
  unresolved,
  selected,
  visibleColumns,
  columnWidths,
  highlightSymbols,
  rowHeight,
  genreOptions,
  onToggle,
  onSetAll,
  onVisibleColumnsChange,
  onColumnWidthsChange,
  onRowHeightChange,
  onEditField,
  onEditRating,
  onInspect,
}: Props) {
  const [widths, setWidths] = useState<Record<string, number>>(columnWidths);
  const widthsRef = useRef(widths);
  widthsRef.current = widths;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [onlyUnresolved, setOnlyUnresolved] = useState(false);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ path: string; field: string } | null>(null);
  const [draft, setDraft] = useState("");
  const pickerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const close = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [pickerOpen]);

  const rh = ROW_STYLE[rowHeight];
  const columns = ALL_COLUMNS.filter((c) => visibleColumns.includes(c.id));
  const widthOf = (c: ColumnDef) => widths[c.id] ?? c.width;
  const totalWidth = 36 + rh.art + columns.reduce((sum, c) => sum + widthOf(c), 0);

  const flagged = useMemo(() => {
    const set = new Set<string>();
    for (const f of files) {
      const t = tags[f.path];
      if (t && (hasWeirdChars(t.title ?? "") || hasWeirdChars(t.artist ?? ""))) set.add(f.path);
    }
    return set;
  }, [files, tags]);

  let rows = files;
  if (onlyFlagged) rows = rows.filter((f) => flagged.has(f.path));
  if (onlyUnresolved) rows = rows.filter((f) => unresolved.has(f.path));

  const startResize = (e: React.MouseEvent, colId: string, startWidth: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(MIN_WIDTH, startWidth + ev.clientX - startX);
      setWidths((w) => ({ ...w, [colId]: next }));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      onColumnWidthsChange(widthsRef.current);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp, { once: true });
  };

  const toggleColumn = (id: string) => {
    const next = visibleColumns.includes(id)
      ? visibleColumns.filter((c) => c !== id)
      : ALL_COLUMNS.map((c) => c.id).filter((c) => visibleColumns.includes(c) || c === id);
    if (next.length === 0) return;
    onVisibleColumnsChange(next);
  };

  const cycleRowHeight = () => {
    const i = ROW_HEIGHTS.indexOf(rowHeight);
    onRowHeightChange(ROW_HEIGHTS[(i + 1) % ROW_HEIGHTS.length]);
  };

  const beginEdit = (path: string, field: string, value: string) => {
    setEditing({ path, field });
    setDraft(value);
  };

  const commitEdit = (override?: string) => {
    if (!editing) return;
    const value = override ?? draft;
    const current = tags[editing.path];
    const original = current
      ? ((current as unknown as Record<string, string | undefined>)[editing.field] ?? "")
      : "";
    if (value !== original) {
      onEditField(editing.path, editing.field as keyof TagData & string, value);
    }
    setEditing(null);
  };

  const allChecked = files.length > 0 && files.every((f) => selected.has(f.path));

  const renderCellValue = (col: ColumnDef, value: string) => {
    if (highlightSymbols && col.field && HIGHLIGHT_FIELDS.has(col.field) && value) {
      return markWeird(value).map((seg, i) =>
        seg.weird ? (
          <mark key={i} className="rounded-sm bg-amber-500/30 text-amber-300">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      );
    }
    return value;
  };

  const headerSep = "border-r border-border/70";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {rows.length} track{rows.length === 1 ? "" : "s"}
          {onlyFlagged ? " flagged" : ""} ·{" "}
          {files.filter((f) => selected.has(f.path)).length} selected
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={cycleRowHeight}
            title={`Row height: ${rowHeight} (click to change)`}
          >
            <Rows3 />
            {rowHeight}
          </Button>
          {unresolved.size > 0 && (
            <Button
              variant={onlyUnresolved ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setOnlyUnresolved((v) => !v)}
              className="text-amber-500"
              title="Tracks the AI couldn't identify from tags or filename — edit them manually"
            >
              <AlertTriangle />
              Needs edit ({unresolved.size})
            </Button>
          )}
          <Button
            variant={onlyFlagged ? "default" : "ghost"}
            size="sm"
            onClick={() => setOnlyFlagged((v) => !v)}
            title="Show only tracks with unusual symbols in Title/Artist"
          >
            <Filter />
            Flagged{flagged.size > 0 ? ` (${flagged.size})` : ""}
          </Button>
          <div className="relative" ref={pickerRef}>
            <Button variant="ghost" size="sm" onClick={() => setPickerOpen((o) => !o)}>
              <SlidersHorizontal />
              Columns
            </Button>
            {pickerOpen && (
              <div className="absolute right-0 top-9 z-30 max-h-80 w-44 overflow-y-auto rounded-lg border bg-popover p-2 shadow-lg">
                {ALL_COLUMNS.map((c) => (
                  <label
                    key={c.id}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                  >
                    <input
                      type="checkbox"
                      className="accent-[var(--primary)]"
                      checked={visibleColumns.includes(c.id)}
                      onChange={() => toggleColumn(c.id)}
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 py-16 text-muted-foreground">
            <p className="text-sm">
              {files.length === 0
                ? "No tracks loaded"
                : onlyUnresolved
                  ? "No unidentified tracks"
                  : "No flagged tracks"}
            </p>
            <p className="text-xs">
              {files.length === 0
                ? "Use Select Folder, Add Files, or drag tracks in"
                : "Every loaded track looks clean"}
            </p>
          </div>
        ) : (
          <table
            className="border-collapse text-left text-xs"
            style={{ width: totalWidth, tableLayout: "fixed" }}
          >
            <colgroup>
              <col style={{ width: 36 }} />
              <col style={{ width: rh.art }} />
              {columns.map((c) => (
                <col key={c.id} style={{ width: widthOf(c) }} />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="border-b">
                <th className={cn("px-2 py-2", headerSep)}>
                  <input
                    type="checkbox"
                    className="accent-[var(--primary)]"
                    checked={allChecked}
                    onChange={(e) => onSetAll(e.target.checked)}
                  />
                </th>
                <th className={cn("px-1 py-2 text-center text-[10px] font-medium text-muted-foreground", headerSep)}>
                  Art
                </th>
                {columns.map((c) => (
                  <th
                    key={c.id}
                    className={cn(
                      "relative select-none whitespace-nowrap px-3 py-2 font-medium text-muted-foreground",
                      headerSep,
                      c.align === "right" && "text-right",
                      c.align === "center" && "text-center",
                    )}
                  >
                    {c.label}
                    <span
                      className="group absolute -right-px top-0 z-20 flex h-full w-2 cursor-col-resize items-center justify-center"
                      onMouseDown={(e) => startResize(e, c.id, widthOf(c))}
                      title="Drag to resize"
                    >
                      <span className="h-3.5 w-px bg-border group-hover:h-full group-hover:w-0.5 group-hover:bg-primary" />
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => {
                const t = tags[f.path];
                const cover = covers[f.path];
                const isUnresolved = unresolved.has(f.path);
                return (
                  <tr
                    key={f.path}
                    className={cn(
                      "border-b border-border/50 transition-colors",
                      selected.has(f.path)
                        ? "bg-accent/60"
                        : isUnresolved
                          ? "bg-amber-500/10 hover:bg-amber-500/20"
                          : activePath === f.path
                            ? "bg-accent/30"
                            : "hover:bg-accent/20",
                    )}
                    onClick={() => setActivePath(f.path)}
                  >
                    <td className={cn("px-2", rh.py)} onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="accent-[var(--primary)]"
                        checked={selected.has(f.path)}
                        onChange={() => onToggle(f.path)}
                      />
                    </td>
                    <td
                      className={cn("px-1", rh.py)}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={() => onInspect(f)}
                      title="Double-click for all tag fields"
                    >
                      <div className="relative mx-auto w-fit">
                        <div
                          className={cn(
                            "flex cursor-pointer items-center justify-center overflow-hidden rounded bg-secondary",
                            rh.img,
                          )}
                        >
                          {cover ? (
                            <img src={cover} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <Music className="h-4 w-4 text-muted-foreground" />
                          )}
                        </div>
                        {isUnresolved && (
                          <AlertTriangle
                            className="absolute -right-1.5 -top-1.5 h-3.5 w-3.5 rounded-full bg-card text-amber-500"
                            aria-label="Couldn't identify — edit manually"
                          />
                        )}
                      </div>
                      <div className="mt-0.5 text-center text-[9px] uppercase text-muted-foreground">
                        {f.format}
                      </div>
                    </td>
                    {columns.map((c) => {
                      if (c.custom === "preview") {
                        return (
                          <td key={c.id} className={cn("px-2", rh.py)}>
                            <AudioPreview path={f.path} />
                          </td>
                        );
                      }
                      if (c.custom === "rating") {
                        return (
                          <td
                            key={c.id}
                            className={cn("px-3", rh.py)}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Stars
                              value={t?.rating ?? 0}
                              readOnly={!t}
                              onChange={(n) => onEditRating(f.path, n)}
                            />
                          </td>
                        );
                      }
                      const isEditing = editing?.path === f.path && editing.field === c.id && c.field;
                      const value = c.value(f, t);
                      return (
                        <td
                          key={c.id}
                          className={cn(
                            "truncate px-3",
                            rh.py,
                            c.id === "filename" ? "text-foreground" : "text-muted-foreground",
                            c.align === "right" && "text-right",
                            c.align === "center" && "text-center",
                            c.field && "cursor-text",
                          )}
                          title={c.id === "filename" ? f.path : value}
                          onClick={(e) => {
                            if (isEditing) e.stopPropagation();
                          }}
                          onDoubleClick={(e) => {
                            if (!c.field) return;
                            e.stopPropagation();
                            beginEdit(f.path, c.id, value);
                          }}
                        >
                          {isEditing && c.field === "genre" && genreOptions.length > 0 ? (
                            <Combobox
                              value={draft}
                              options={genreOptions}
                              allowCustom
                              autoFocus
                              onChange={(v) => commitEdit(v)}
                              onClose={() => setEditing(null)}
                            />
                          ) : isEditing ? (
                            <input
                              autoFocus
                              value={draft}
                              onChange={(e) => setDraft(e.target.value)}
                              onBlur={() => commitEdit()}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") commitEdit();
                                else if (e.key === "Escape") setEditing(null);
                              }}
                              className="w-full rounded border border-primary bg-background px-1 py-0.5 text-xs outline-none"
                            />
                          ) : t || !c.field ? (
                            renderCellValue(c, value)
                          ) : (
                            <span className="italic opacity-50">…</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
