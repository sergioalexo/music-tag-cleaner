import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Filter,
  ImageOff,
  ImagePlus,
  Layers,
  Music,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
  ZoomIn,
} from "lucide-react";
import type { AudioFile, PendingChange, RowHeight, TagData } from "../types";
import { formatBytes, KEPT_FIELD_KEYS } from "../types";
import type { ImageInfo as ImgInfo } from "../hooks/useImageInfo";
import { hasWeirdChars, markWeird } from "../lib/standardize";
import { matchesShortcut, shortcutFor } from "../lib/shortcuts";
import { useVirtualRows } from "../hooks/useVirtualRows";
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
  custom?: "preview" | "rating" | "imageInfo";
  /** Ad-hoc raw-tag column from the "All Tags" view — not draggable/resizable/persisted. */
  dynamic?: boolean;
  /** The raw allFields/key_name() key this dynamic column edits — unset for curated columns. */
  rawKey?: string;
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
    label: "Track #",
    width: 80,
    field: "trackNumber",
    value: (_f, t) => t?.trackNumber ?? "",
  },
  {
    id: "trackId",
    label: "Track ID",
    width: 96,
    field: "trackId",
    value: (_f, t) => t?.trackId ?? "",
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
  { id: "imageInfo", label: "Artwork", width: 150, value: () => "", custom: "imageInfo" },
];

export function formatImageInfo(info: { mime: string; sizeBytes: number; width: number; height: number } | null | undefined): string {
  if (info === null) return "no art";
  if (!info) return "…";
  const format = (info.mime.split("/")[1] || info.mime).toUpperCase();
  return `${info.width}×${info.height} · ${format} · ${formatBytes(info.sizeBytes)}`;
}

const HIGHLIGHT_FIELDS = new Set(["title", "artist"]);
const MIN_WIDTH = 50;

function stemOf(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx > 0 ? filename.slice(0, idx) : filename;
}

/** Splits `value` into segments, wrapping every case-insensitive match of `query`. */
function highlightSearch(value: string, query: string) {
  if (!query) return value;
  const lower = value.toLowerCase();
  const q = query.toLowerCase();
  if (!lower.includes(q)) return value;
  const segs: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (true) {
    const found = lower.indexOf(q, i);
    if (found === -1) {
      segs.push(<span key={key++}>{value.slice(i)}</span>);
      break;
    }
    if (found > i) segs.push(<span key={key++}>{value.slice(i, found)}</span>);
    segs.push(
      <mark key={key++} className="rounded-sm bg-yellow-400/70 text-black">
        {value.slice(found, found + query.length)}
      </mark>,
    );
    i = found + query.length;
  }
  return segs;
}

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
  imageInfo: Record<string, ImgInfo | null>;
  onFetchImageInfo: (path: string) => void;
  onSetCoverArt: (file: AudioFile) => void;
  onRemoveCoverArt: (file: AudioFile) => void;
  unresolved: Set<string>;
  selected: Set<string>;
  visibleColumns: string[];
  columnWidths: Record<string, number>;
  highlightSymbols: boolean;
  rowHeight: RowHeight;
  genreOptions: string[];
  onToggle: (path: string) => void;
  onSetAll: (checked: boolean) => void;
  onSetMany: (paths: string[], checked: boolean) => void;
  onVisibleColumnsChange: (columns: string[]) => void;
  onColumnWidthsChange: (widths: Record<string, number>) => void;
  onRowHeightChange: (height: RowHeight) => void;
  onEditField: (paths: string[], field: keyof TagData & string, value: string) => void;
  onEditRawField: (paths: string[], rawKey: string, value: string) => void;
  onEditRating: (paths: string[], stars: number) => void;
  onInspect: (file: AudioFile) => void;
  onAddGenre: (genre: string) => void;
  onRenameGenre: (oldName: string, newName: string) => void;
  onDeleteFile: (file: AudioFile) => void;
  onRenameFile: (path: string, newStem: string) => void;
  /** Column id of the field currently holding the searchable backup, if enabled. */
  backupFieldId: string | null;
  shortcuts: Record<string, string>;
  onTrack: (name: string) => void;
  /** Non-strip pending changes (AI/Standardize/Genre/Clear) shown inline as before → after diffs. */
  pending: PendingChange[] | null;
  onPendingChange: (rows: PendingChange[]) => void;
}

/**
 * Include/exclude every proposed change in one column. Shown in the header
 * only while a preview is on screen and that column actually has suggestions.
 */
function ColumnIncludeToggle({
  state,
  label,
  onChange,
}: {
  state?: { ids: Set<string>; included: number; total: number };
  label: string;
  onChange: (include: boolean) => void;
}) {
  if (!state) return null;
  const all = state.included === state.total;
  return (
    <input
      type="checkbox"
      className="accent-[var(--primary)]"
      checked={all}
      ref={(el) => {
        // Partially included reads as a dash rather than a misleading tick.
        if (el) el.indeterminate = state.included > 0 && !all;
      }}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.checked)}
      title={`${all ? "Exclude" : "Include"} all ${state.total} proposed ${label} change${
        state.total === 1 ? "" : "s"
      }`}
    />
  );
}

export function TrackTable({
  files,
  tags,
  covers,
  imageInfo,
  onFetchImageInfo,
  onSetCoverArt,
  onRemoveCoverArt,
  unresolved,
  selected,
  visibleColumns,
  columnWidths,
  highlightSymbols,
  rowHeight,
  genreOptions,
  onToggle,
  onSetAll,
  onSetMany,
  onVisibleColumnsChange,
  onColumnWidthsChange,
  onRowHeightChange,
  onEditField,
  onEditRawField,
  onEditRating,
  onInspect,
  onAddGenre,
  onRenameGenre,
  onDeleteFile,
  onRenameFile,
  backupFieldId,
  shortcuts,
  onTrack,
  pending,
  onPendingChange,
}: Props) {
  // Local mirror of the persisted widths so a drag can update at pointer speed
  // without a settings write per frame; re-synced when the prop changes from
  // the outside (settings import/restore, defaults reset).
  const [widths, setWidths] = useState<Record<string, number>>(columnWidths);
  const widthsRef = useRef(widths);
  widthsRef.current = widths;
  const draggingWidthRef = useRef(false);
  useEffect(() => {
    if (!draggingWidthRef.current) setWidths(columnWidths);
  }, [columnWidths]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [onlyUnresolved, setOnlyUnresolved] = useState(false);
  /**
   * Highlight selection — the rows the user has picked out by clicking. This
   * is deliberately NOT the checkbox state (`selected`): actions run on the
   * ticked rows, while this drives bulk ticking and multi-row edits.
   */
  const [rowSel, setRowSel] = useState<Set<string>>(new Set());
  const rowSelRef = useRef(rowSel);
  rowSelRef.current = rowSel;
  /** Last row clicked — anchor for Shift ranges and target for the Space key. */
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const anchorRef = useRef(anchorPath);
  anchorRef.current = anchorPath;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [editing, setEditing] = useState<{ path: string; field: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [showAllTags, setShowAllTags] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const close = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [pickerOpen]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (matchesShortcut(e, "find", shortcuts)) {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
        return;
      }
      // Ctrl/Cmd+A highlights every visible row (it does NOT tick them) so the
      // user can then Space / click a box to tick the whole selection.
      if (matchesShortcut(e, "selectAll", shortcuts)) {
        const t = e.target as HTMLElement | null;
        if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.isContentEditable) return;
        e.preventDefault();
        const paths = rowsRef.current.map((f) => f.path);
        setRowSel(new Set(paths));
        setAnchorPath(paths[paths.length - 1] ?? null);
        return;
      }
      // Space ticks the whole highlight selection (or just the anchor row when
      // nothing is selected). Only when nothing else holds focus, so it never
      // steals Space from an input or a button.
      if (e.key === " " && e.target === document.body) {
        const sel = rowSelRef.current;
        const targets = sel.size ? [...sel] : anchorRef.current ? [anchorRef.current] : [];
        if (!targets.length) return;
        e.preventDefault();
        onSetMany(targets, !selectedRef.current.has(targets[0]));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [shortcuts, onSetMany]);

  const rh = ROW_STYLE[rowHeight];
  // Order follows visibleColumns (drag-and-drop reorders that array), not
  // ALL_COLUMNS' fixed definition order.
  const curatedColumns = useMemo(() => {
    const byId = new Map(ALL_COLUMNS.map((c) => [c.id, c]));
    return visibleColumns.map((id) => byId.get(id)).filter((c): c is ColumnDef => !!c);
  }, [visibleColumns]);

  const flagged = useMemo(() => {
    const set = new Set<string>();
    for (const f of files) {
      const t = tags[f.path];
      if (t && (hasWeirdChars(t.title ?? "") || hasWeirdChars(t.artist ?? ""))) set.add(f.path);
    }
    return set;
  }, [files, tags]);

  const filteredRows = useMemo(() => {
    let out = files;
    if (onlyFlagged) out = out.filter((f) => flagged.has(f.path));
    if (onlyUnresolved) out = out.filter((f) => unresolved.has(f.path));
    return out;
  }, [files, onlyFlagged, onlyUnresolved, flagged, unresolved]);

  /**
   * Raw tag keys (from TagData.allFields) not already shown as a curated
   * column, one dynamic column per key found on any currently visible row,
   * auto-hidden the moment no visible row has a value for that key anymore.
   *
   * Keys in KEPT_FIELD_KEYS (TrackTitle, TrackArtist, Year, …) are the raw
   * frames the curated Title/Artist/Year columns already show, so they're
   * skipped here — otherwise every common field appears twice.
   */
  const extraColumns: ColumnDef[] = useMemo(() => {
    if (!showAllTags) return [];
    const keys = new Set<string>();
    for (const f of filteredRows) {
      const extra = tags[f.path]?.allFields;
      if (!extra) continue;
      for (const [k, v] of Object.entries(extra)) if (v && !KEPT_FIELD_KEYS.has(k)) keys.add(k);
    }
    return [...keys].sort().map((key) => ({
      id: `extra:${key}`,
      label: key,
      width: 140,
      dynamic: true,
      rawKey: key,
      value: (_f: AudioFile, t?: TagData) => t?.allFields?.[key] ?? "",
    }));
  }, [showAllTags, filteredRows, tags]);

  const columns = useMemo(
    () => [...curatedColumns, ...extraColumns],
    [curatedColumns, extraColumns],
  );
  const columnById = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  const widthOf = (c: ColumnDef) => widths[c.id] ?? c.width;
  const totalWidth = 36 + rh.art + 32 + columns.reduce((sum, c) => sum + widthOf(c), 0);

  /**
   * Display order. Sorting is memoized because it is O(n log n) over the whole
   * library with a per-comparison map lookup — re-running it on every render
   * (including every keystroke in the search box) is very visible on big lists.
   */
  const rows = useMemo(() => {
    if (!sortCol) return filteredRows;
    const col = columnById.get(sortCol);
    if (!col) return filteredRows;

    /** Comparable primitive for a cell — numeric where that makes sense, else lowercased text. */
    const sortValue = (f: AudioFile): string | number => {
      const t = tags[f.path];
      if (col.id === "rating") return t?.rating ?? 0;
      if (col.id === "size") return f.size;
      if (col.id === "preview") return f.durationSecs ?? -1;
      if (col.id === "imageInfo") return imageInfo[f.path]?.sizeBytes ?? 0;
      if (col.id === "year" || col.id === "trackNumber" || col.id === "discNumber") {
        const n = parseInt(col.value(f, t), 10);
        return Number.isNaN(n) ? -Infinity : n;
      }
      return col.value(f, t).toLowerCase();
    };

    // Decorate-sort-undecorate: sortValue re-parses tags per comparison
    // otherwise, which is the expensive part for large libraries.
    const keyed = filteredRows.map((f) => ({ f, k: sortValue(f) }));
    keyed.sort((a, b) => {
      const cmp =
        typeof a.k === "number" && typeof b.k === "number"
          ? a.k - b.k
          : String(a.k).localeCompare(String(b.k));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return keyed.map((x) => x.f);
  }, [filteredRows, sortCol, sortDir, columnById, tags, imageInfo]);

  // Current display rows, for the window keydown handler (which is bound once).
  const rowsRef = useRef<AudioFile[]>(rows);
  rowsRef.current = rows;

  // Only render the rows near the viewport once the list gets long — below
  // that the spacer rows aren't worth the (tiny) layout risk.
  const virtual = useVirtualRows(scrollRef, rows.length, {
    estimateRowHeight: rh.art + 8,
    enabled: rows.length > 60,
  });
  const visibleRows = rows.slice(virtual.start, virtual.end);
  const bodyColSpan = 3 + columns.length;

  const toggleSort = (colId: string) => {
    onTrack(`sortColumn:${colId}`);
    if (sortCol === colId) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(colId);
      setSortDir("asc");
    }
  };

  /** The rows between the anchor and `path`, in display order. */
  const rangeTo = (path: string): string[] => {
    const idxA = rows.findIndex((r) => r.path === anchorPath);
    const idxB = rows.findIndex((r) => r.path === path);
    if (idxA === -1 || idxB === -1) return [path];
    const [lo, hi] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
    return rows.slice(lo, hi + 1).map((r) => r.path);
  };

  /**
   * Clicking a row selects it — Shift extends a range, Ctrl adds/removes one.
   * Selecting never ticks anything: the checkbox is a separate state, so
   * editing or inspecting a field cannot change what an action will run on.
   *
   * A plain click on a row that is already part of a multi-row selection
   * keeps that selection intact (only the anchor moves), so a follow-up
   * double-click to edit a field lands on every selected row. To drop a
   * single row from the selection, Ctrl+click it.
   */
  const handleRowClick = (e: React.MouseEvent, path: string) => {
    if (e.shiftKey && anchorPath) {
      setRowSel(new Set(rangeTo(path)));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      setRowSel((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      setAnchorPath(path);
      return;
    }
    if (rowSel.has(path) && rowSel.size > 1) {
      setAnchorPath(path);
      return;
    }
    setRowSel(new Set([path]));
    setAnchorPath(path);
  };

  /**
   * Checkbox cell. Ticking a row that is part of the highlight selection
   * applies to the whole selection; ticking a row outside it affects only that
   * row and drops the selection, so the tick always matches what you can see.
   */
  const handleCheckClick = (path: string) => {
    const next = !selected.has(path);
    if (rowSel.has(path)) {
      onSetMany([...rowSel], next);
      return;
    }
    onToggle(path);
    setRowSel(new Set());
    setAnchorPath(path);
  };

  /** Rows (in display order) whose visible cell text matches the search query. */
  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return [] as string[];
    const q = searchQuery.trim().toLowerCase();
    const out: string[] = [];
    for (const f of rows) {
      const t = tags[f.path];
      const hit = columns.some((c) => {
        if (c.custom) return false;
        const v = c.value(f, t);
        return v && v.toLowerCase().includes(q);
      });
      if (hit) out.push(f.path);
    }
    return out;
  }, [rows, tags, columns, searchQuery]);

  useEffect(() => {
    setMatchIndex(0);
  }, [searchQuery]);

  const goToMatch = (delta: number) => {
    if (!searchMatches.length) return;
    const next = (matchIndex + delta + searchMatches.length) % searchMatches.length;
    setMatchIndex(next);
    const idx = rows.findIndex((r) => r.path === searchMatches[next]);
    if (idx >= 0) virtual.scrollToIndex(idx);
  };

  /** Pending AI/Standardize/Genre/Clear changes, keyed by "path::field" for O(1) cell lookup. */
  const pendingByKey = useMemo(() => {
    const m = new Map<string, PendingChange>();
    if (pending) for (const r of pending) if (r.changed) m.set(`${r.path}::${r.field}`, r);
    return m;
  }, [pending]);

  // Resizing ends in a mouseup on the header, which would otherwise also fire a
  // click there and toggle sort right after — this flag suppresses that one click.
  const resizingRef = useRef(false);

  const startResize = (e: React.MouseEvent, colId: string, startWidth: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    draggingWidthRef.current = true;
    const onMove = (ev: MouseEvent) => {
      resizingRef.current = true;
      const next = Math.max(MIN_WIDTH, startWidth + ev.clientX - startX);
      setWidths((w) => ({ ...w, [colId]: next }));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      draggingWidthRef.current = false;
      const dragged = resizingRef.current;
      if (dragged) onColumnWidthsChange(widthsRef.current);
      // The click that follows this mouseup is swallowed by the header handler
      // to avoid sorting; clear the flag afterwards so a later plain click on
      // the same header still sorts. Without this a drag that ends off-header
      // leaves the flag set and eats the next legitimate click.
      setTimeout(() => {
        resizingRef.current = false;
      }, 0);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp, { once: true });
  };

  const toggleColumn = (id: string) => {
    const next = visibleColumns.includes(id)
      ? visibleColumns.filter((c) => c !== id)
      : [...visibleColumns, id];
    if (next.length === 0) return;
    onVisibleColumnsChange(next);
  };

  const [dragCol, setDragCol] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);

  const reorderColumn = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const order = visibleColumns.slice();
    const fromIdx = order.indexOf(fromId);
    if (fromIdx === -1) return;
    order.splice(fromIdx, 1);
    const toIdx = order.indexOf(toId);
    if (toIdx === -1) return;
    order.splice(toIdx, 0, fromId);
    onVisibleColumnsChange(order);
  };

  /** Proposed changes grouped by column — drives the header include/exclude box. */
  const pendingByColumn = useMemo(() => {
    const map = new Map<string, { ids: Set<string>; included: number; total: number }>();
    for (const r of pending ?? []) {
      if (!r.changed) continue;
      const entry = map.get(r.field) ?? { ids: new Set<string>(), included: 0, total: 0 };
      entry.ids.add(r.id);
      entry.total++;
      if (r.include) entry.included++;
      map.set(r.field, entry);
    }
    return map;
  }, [pending]);

  const beginEdit = (path: string, field: string, value: string) => {
    setEditing({ path, field });
    setDraft(value);
  };

  /** An edit on a highlighted row applies to the whole selection, not just it. */
  const targetPaths = (path: string): string[] =>
    rowSel.has(path) && rowSel.size > 1 ? [...rowSel] : [path];

  /** Sets `include` on the given pending-change ids in one pass. */
  const setIncludeForIds = (ids: Set<string>, include: boolean) => {
    if (!pending || !ids.size) return;
    onPendingChange(pending.map((r) => (ids.has(r.id) ? { ...r, include } : r)));
  };

  /**
   * A proposed change's checkbox. With rows highlighted, it toggles that one
   * column across the whole selection — so you can knock out, say, every Year
   * suggestion for a block of tracks without touching their other fields.
   */
  const togglePendingCell = (path: string, field: string, id: string, include: boolean) => {
    const next = !include;
    if (rowSel.has(path)) {
      const ids = new Set(
        (pending ?? [])
          .filter((r) => r.changed && r.field === field && rowSel.has(r.path))
          .map((r) => r.id),
      );
      setIncludeForIds(ids, next);
      return;
    }
    setIncludeForIds(new Set([id]), next);
    setRowSel(new Set());
  };

  /** Edits the proposed "after" value of a pending change instead of writing to disk. */
  const editPendingAfter = (id: string, after: string) => {
    if (!pending) return;
    onPendingChange(
      pending.map((r) => (r.id === id ? { ...r, after, changed: after !== r.before, include: after !== r.before } : r)),
    );
  };

  const commitEdit = (override?: string, scope: "all" | "single" = "all") => {
    if (!editing) return;
    const value = override ?? draft;
    if (editing.field === "filename") {
      const file = files.find((x) => x.path === editing.path);
      const newStem = value.trim();
      if (file && newStem && newStem !== stemOf(file.filename)) {
        onRenameFile(editing.path, newStem);
      }
      setEditing(null);
      return;
    }
    const editingCol = columnById.get(editing.field);
    if (editingCol?.dynamic && editingCol.rawKey) {
      // The row can disappear mid-edit (delete, filter change, rename), so
      // bail out rather than dereferencing a missing file.
      const editingFile = files.find((x) => x.path === editing.path);
      if (!editingFile) {
        setEditing(null);
        return;
      }
      const original = editingCol.value(editingFile, tags[editing.path]);
      if (value !== original) {
        const paths = scope === "single" ? [editing.path] : targetPaths(editing.path);
        onEditRawField(paths, editingCol.rawKey, value);
      }
      setEditing(null);
      return;
    }
    const pend = pendingByKey.get(`${editing.path}::${editing.field}`);
    if (pend) {
      editPendingAfter(pend.id, value);
      setEditing(null);
      return;
    }
    const current = tags[editing.path];
    const original = current
      ? ((current as unknown as Record<string, string | undefined>)[editing.field] ?? "")
      : "";
    if (value !== original) {
      const paths = scope === "single" ? [editing.path] : targetPaths(editing.path);
      onEditField(paths, editing.field as keyof TagData & string, value);
    }
    setEditing(null);
  };

  const allChecked = files.length > 0 && files.every((f) => selected.has(f.path));

  const renderCellValue = (col: ColumnDef, value: string) => {
    if (searchQuery.trim() && value) {
      return highlightSearch(value, searchQuery.trim());
    }
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
            variant={searchOpen ? "secondary" : "ghost"}
            size="sm"
            onClick={() => {
              onTrack("search");
              setSearchOpen((o) => !o);
              requestAnimationFrame(() => searchInputRef.current?.focus());
            }}
            title={`Find in table (${shortcutFor("find", shortcuts)})`}
          >
            <Search />
          </Button>
          <div className="flex items-center gap-1.5 px-1.5" title={`Zoom: ${rowHeight} row height — drag to change`}>
            <ZoomIn className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="range"
              min={0}
              max={ROW_HEIGHTS.length - 1}
              step={1}
              value={ROW_HEIGHTS.indexOf(rowHeight)}
              onChange={(e) => onRowHeightChange(ROW_HEIGHTS[Number(e.target.value)])}
              className="h-1 w-16 cursor-pointer accent-[var(--primary)]"
            />
          </div>
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
          <Button
            variant={showAllTags ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setShowAllTags((v) => !v)}
            title="Show every raw tag field found on these tracks, as extra columns — a column hides itself once none of the visible tracks have a value for it"
          >
            <Layers />
            All Tags{extraColumns.length > 0 ? ` (${extraColumns.length})` : ""}
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

      {searchOpen && (
        <div className="flex items-center gap-2 border-b bg-secondary/30 px-3 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearchOpen(false);
                setSearchQuery("");
              } else if (e.key === "Enter") {
                goToMatch(e.shiftKey ? -1 : 1);
              }
            }}
            placeholder="Find in table…"
            className="h-6 flex-1 max-w-xs border-none bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {searchQuery.trim()
              ? searchMatches.length
                ? `${matchIndex + 1}/${searchMatches.length}`
                : "0/0"
              : ""}
          </span>
          <button
            onClick={() => goToMatch(-1)}
            disabled={!searchMatches.length}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent disabled:opacity-30"
            title="Previous match (Shift+Enter)"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => goToMatch(1)}
            disabled={!searchMatches.length}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent disabled:opacity-30"
            title="Next match (Enter)"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => {
              setSearchOpen(false);
              setSearchQuery("");
            }}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent"
            title="Close (Esc)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto"
        onWheel={(e) => {
          // Cross-mouse-hardware fallback: Shift+wheel always pans horizontally,
          // even on mice without a tilt wheel or trackpad gesture support.
          if (e.shiftKey && e.deltaY !== 0) {
            e.currentTarget.scrollLeft += e.deltaY;
          }
        }}
      >
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
              <col style={{ width: 32 }} />
              {columns.map((c) => (
                <col key={c.id} style={{ width: widthOf(c) }} />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-20 bg-card">
              <tr className="border-b">
                <th className={cn("sticky left-0 z-30 bg-card px-2 py-2", headerSep)}>
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
                <th className={cn("px-1 py-2", headerSep)} />
                {columns.map((c) => (
                  <th
                    key={c.id}
                    draggable={!c.dynamic}
                    onDragStart={
                      c.dynamic
                        ? undefined
                        : (e) => {
                            e.dataTransfer.effectAllowed = "move";
                            setDragCol(c.id);
                          }
                    }
                    onDragEnter={
                      c.dynamic ? undefined : () => dragCol && dragCol !== c.id && setDragOverCol(c.id)
                    }
                    onDragOver={c.dynamic ? undefined : (e) => e.preventDefault()}
                    onDrop={
                      c.dynamic
                        ? undefined
                        : (e) => {
                            e.preventDefault();
                            if (dragCol) reorderColumn(dragCol, c.id);
                            setDragCol(null);
                            setDragOverCol(null);
                          }
                    }
                    onDragEnd={
                      c.dynamic
                        ? undefined
                        : () => {
                            setDragCol(null);
                            setDragOverCol(null);
                          }
                    }
                    onClick={() => {
                      // Suppress the synthetic click that follows a resize drag
                      // (the flag is cleared by startResize's mouseup handler).
                      if (resizingRef.current) return;
                      toggleSort(c.id);
                    }}
                    className={cn(
                      "relative cursor-pointer select-none px-3 py-2 font-medium text-muted-foreground",
                      !c.dynamic && "cursor-move",
                      headerSep,
                      c.align === "right" && "text-right",
                      c.align === "center" && "text-center",
                      dragCol === c.id && "opacity-40",
                      dragOverCol === c.id && "bg-accent/40",
                      c.dynamic && "italic",
                    )}
                    title={
                      c.id === "preview"
                        ? "Click to sort by track length — drag to reorder"
                        : c.dynamic
                          ? `${c.label} — raw tag field, click to sort, drag edge to resize`
                          : "Click to sort — drag to reorder"
                    }
                  >
                    <span className="flex items-center gap-1 overflow-hidden">
                      <ColumnIncludeToggle
                        state={pendingByColumn.get(c.id)}
                        label={c.label}
                        onChange={(include) =>
                          setIncludeForIds(pendingByColumn.get(c.id)?.ids ?? new Set(), include)
                        }
                      />
                      <span className="min-w-0 flex-1 truncate">{c.label}</span>
                      {c.id === backupFieldId && (
                        <span className="shrink-0 text-[9px] font-normal text-amber-500">(Backup)</span>
                      )}
                      {sortCol === c.id &&
                        (sortDir === "asc" ? (
                          <ChevronUp className="h-3 w-3 shrink-0" />
                        ) : (
                          <ChevronDown className="h-3 w-3 shrink-0" />
                        ))}
                    </span>
                    <span
                      className="group absolute -right-px top-0 z-20 flex h-full w-2 cursor-col-resize items-center justify-center"
                      draggable
                      onDragStart={(e) => e.preventDefault()}
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
              {virtual.padTop > 0 && (
                <tr aria-hidden>
                  <td colSpan={bodyColSpan} style={{ height: virtual.padTop, padding: 0, border: 0 }} />
                </tr>
              )}
              {visibleRows.map((f) => {
                const t = tags[f.path];
                const cover = covers[f.path];
                const isUnresolved = unresolved.has(f.path);
                // The highlight selection reads first; whether a row is ticked
                // stays legible in its checkbox rather than competing for colour.
                const shared = rowSel.has(f.path)
                  ? "bg-primary/20 hover:bg-primary/25"
                  : selected.has(f.path)
                    ? "bg-accent/60"
                    : isUnresolved
                      ? "bg-amber-500/10 hover:bg-amber-500/20"
                      : null;
                const rowBg = shared ?? "hover:bg-accent/20";
                // The sticky checkbox cell needs an always-opaque resting
                // background so columns scrolling under it don't show through.
                const stickyBg = shared ?? "bg-card hover:bg-accent/20";
                return (
                  <tr
                    key={f.path}
                    data-path={f.path}
                    className={cn("border-b border-border/50 transition-colors", rowBg)}
                    onClick={(e) => handleRowClick(e, f.path)}
                  >
                    <td
                      className={cn("sticky left-0 z-10 cursor-pointer px-2", rh.py, stickyBg)}
                      title={
                        rowSel.has(f.path) && rowSel.size > 1
                          ? `Tick or untick all ${rowSel.size} selected tracks`
                          : "Tick to include this track in the toolbar actions (Space toggles the selection)"
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCheckClick(f.path);
                      }}
                    >
                      <input
                        type="checkbox"
                        // The cell owns the click so the hit area covers the whole
                        // cell and Shift+click ranges go through one code path.
                        className="pointer-events-none accent-[var(--primary)]"
                        checked={selected.has(f.path)}
                        readOnly
                      />
                    </td>
                    <td
                      className={cn("px-1", rh.py)}
                      onMouseEnter={() => onFetchImageInfo(f.path)}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        onInspect(f);
                      }}
                      title="Double-click for all tag fields"
                    >
                      <div className="group relative mx-auto w-fit">
                        <div
                          className={cn(
                            "flex cursor-pointer items-center justify-center overflow-hidden rounded bg-secondary",
                            rh.img,
                          )}
                          title={cover ? formatImageInfo(imageInfo[f.path]) : "No embedded artwork"}
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
                        <div
                          className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-0.5 bg-black/60 opacity-0 transition-opacity group-hover:opacity-100"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            onClick={() => onSetCoverArt(f)}
                            title={cover ? "Replace artwork" : "Add artwork"}
                            className="flex h-4 w-4 items-center justify-center text-white hover:text-primary"
                          >
                            <ImagePlus className="h-3 w-3" />
                          </button>
                          {cover && (
                            <button
                              onClick={() => onRemoveCoverArt(f)}
                              title="Remove artwork"
                              className="flex h-4 w-4 items-center justify-center text-white hover:text-destructive"
                            >
                              <ImageOff className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="mt-0.5 text-center text-[9px] uppercase text-muted-foreground">
                        {f.format}
                      </div>
                    </td>
                    <td className={cn("px-1", rh.py)} onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => onDeleteFile(f)}
                        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                        title="Delete this file (moves it to the Recycle Bin)"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                    {columns.map((c) => {
                      if (c.custom === "preview") {
                        return (
                          <td key={c.id} className={cn("overflow-hidden px-2", rh.py)}>
                            <AudioPreview path={f.path} />
                          </td>
                        );
                      }
                      if (c.custom === "imageInfo") {
                        return (
                          <td
                            key={c.id}
                            className={cn("truncate px-3 text-muted-foreground", rh.py)}
                            onMouseEnter={() => onFetchImageInfo(f.path)}
                            title={formatImageInfo(imageInfo[f.path])}
                          >
                            {formatImageInfo(imageInfo[f.path])}
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
                              onChange={(n) => onEditRating(targetPaths(f.path), n)}
                            />
                          </td>
                        );
                      }
                      const isEditing =
                        editing?.path === f.path &&
                        editing.field === c.id &&
                        (c.field || c.id === "filename" || c.dynamic);
                      const value = c.value(f, t);
                      const pend = c.field ? pendingByKey.get(`${f.path}::${c.id}`) : undefined;
                      return (
                        <td
                          key={c.id}
                          className={cn(
                            "truncate px-3",
                            rh.py,
                            c.id === "filename" ? "text-foreground" : "text-muted-foreground",
                            c.align === "right" && "text-right",
                            c.align === "center" && "text-center",
                            (c.field || c.id === "filename" || c.dynamic) && "cursor-text",
                            pend && "bg-primary/5",
                          )}
                          title={
                            pend
                              ? `${pend.before || "(empty)"} → ${pend.after || "(empty)"} — click to ${pend.include ? "exclude" : "include"}, double-click to edit`
                              : c.dynamic
                                ? `${value} — double-click to edit, clear it to delete this field entirely`
                                : c.id === "filename"
                                  ? `${f.path} — double-click to rename`
                                  : value
                          }
                          onClick={(e) => {
                            if (isEditing) e.stopPropagation();
                          }}
                          onDoubleClick={(e) => {
                            if (!c.field && c.id !== "filename" && !c.dynamic) return;
                            e.stopPropagation();
                            beginEdit(f.path, c.id, c.id === "filename" ? stemOf(f.filename) : pend ? pend.after : value);
                          }}
                        >
                          {isEditing && c.field === "genre" ? (
                            <Combobox
                              value={draft}
                              options={genreOptions}
                              allowCustom
                              autoFocus
                              onChange={(v) => commitEdit(v)}
                              onClose={() => setEditing(null)}
                              onCreate={onAddGenre}
                              onEditOption={onRenameGenre}
                            />
                          ) : isEditing ? (
                            <div className="flex items-center gap-1">
                              <input
                                autoFocus
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                onBlur={() => commitEdit()}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") commitEdit(undefined, e.altKey ? "single" : "all");
                                  else if (e.key === "Escape") setEditing(null);
                                }}
                                title={
                                  editing.field !== "filename" &&
                                  rowSel.has(f.path) &&
                                  rowSel.size > 1
                                    ? `Enter applies to all ${rowSel.size} selected — Alt+Enter applies to just this row`
                                    : undefined
                                }
                                className="w-full min-w-0 flex-1 rounded border border-primary bg-background px-1 py-0.5 text-xs outline-none"
                              />
                              {editing.field !== "filename" && rowSel.has(f.path) && rowSel.size > 1 && (
                                <button
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => commitEdit(undefined, "single")}
                                  title={`Apply to just this row instead of all ${rowSel.size} selected (or press Alt+Enter)`}
                                  className="shrink-0 whitespace-nowrap rounded bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground hover:bg-accent"
                                >
                                  just this
                                </button>
                              )}
                            </div>
                          ) : pend ? (
                            <span
                              className="flex cursor-pointer items-center gap-1"
                              onClick={(e) => {
                                e.stopPropagation();
                                togglePendingCell(f.path, c.id, pend.id, pend.include);
                              }}
                            >
                              <input
                                type="checkbox"
                                // The cell owns the click so one code path covers
                                // both the single row and the whole selection.
                                className="pointer-events-none shrink-0 accent-[var(--primary)]"
                                checked={pend.include}
                                readOnly
                              />
                              <span className={cn("truncate", !pend.include && "opacity-50")}>
                                {pend.kind === "remove" ? (
                                  <span className="text-destructive line-through">{pend.before}</span>
                                ) : (
                                  <>
                                    {pend.before && (
                                      <span className="text-muted-foreground line-through">
                                        {pend.before}
                                      </span>
                                    )}
                                    <span className="mx-1 text-muted-foreground">→</span>
                                    <span className="font-medium text-primary">{pend.after}</span>
                                  </>
                                )}
                              </span>
                            </span>
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
              {virtual.padBottom > 0 && (
                <tr aria-hidden>
                  <td
                    colSpan={bodyColSpan}
                    style={{ height: virtual.padBottom, padding: 0, border: 0 }}
                  />
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
