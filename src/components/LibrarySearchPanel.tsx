import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { AudioFile, TagData } from "../types";
import type { MatchCandidate } from "../lib/ytMatch";
import { searchTracks } from "../lib/trackSearch";
import { AudioPreview } from "./AudioPreview";
import { cn } from "./ui";

/** Other candidates the matcher found for the currently-focused playlist
 * row — the "cycle through variants" arrows used to live in the row itself;
 * they live here now, next to the free-text search, so picking a different
 * mix works the same way as picking any other track. */
export interface RowVariants {
  videoId: string;
  /** "row 12" style label for the header. */
  rowLabel: string;
  candidates: MatchCandidate[];
}

const columnHeaders = [
  { label: "Title / Artist", className: "min-w-0 flex-1" },
  { label: "Album", className: "hidden w-40 shrink-0 truncate sm:block" },
  { label: "Genre", className: "hidden w-24 shrink-0 truncate md:block" },
  { label: "Year", className: "hidden w-12 shrink-0 text-right lg:block" },
];

/**
 * A dock at the bottom of the YouTube-import screen for finding a track by
 * hand when the matcher couldn't — laid out the same way the Library table
 * is (title/artist, album, genre, year, format), so it reads as "the
 * library, filtered" rather than a different, simpler search.
 *
 * Click the playlist row you want, then press **Match** on a result (or
 * double-click it). This used to be a drag gesture; dragging inside the
 * webview kept handing the mouse to an OS drag loop that blocked the
 * renderer, and a button does the same job without the failure mode.
 */
export function LibrarySearchPanel({
  files,
  tags,
  height,
  collapsed,
  label,
  variants,
  onHeightChange,
  onCollapsedChange,
  onPick,
  onPickVariant,
  onDenyVariant,
}: {
  files: AudioFile[];
  tags: Record<string, TagData>;
  height: number;
  collapsed: boolean;
  label: (path: string) => { title: string; artist: string };
  /** The focused row's other matcher-found candidates, shown above the
   * free-text search results so picking "the other mix" doesn't need
   * cycling arrows on the row itself. */
  variants?: RowVariants | null;
  onHeightChange: (height: number) => void;
  onCollapsedChange: (collapsed: boolean) => void;
  /** Assigns this file to whichever playlist row is focused. */
  onPick: (path: string) => void;
  /** Picks one of the matcher's own alternate candidates for the focused row. */
  onPickVariant?: (path: string) => void;
  /** Rejects one alternate candidate outright (it never fits, so hide it). */
  onDenyVariant?: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  // The query is searched debounced, not on every keystroke: with a 4000+
  // track library, re-scoring the whole collection on each character is
  // what made typing visibly glitch right after the first letter and only
  // catch up a moment later. Typing itself stays instant — only the search
  // that reacts to it is delayed.
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 150);
    return () => clearTimeout(t);
  }, [query]);

  // A one- or two-character query matches almost everything in a large
  // library, so it's capped tighter than a longer, more specific one — fewer
  // rows to render (and fewer `<AudioPreview>`s to mount) while you're still
  // mid-word.
  const resultLimit = debouncedQuery.trim().length < 3 ? 40 : 300;
  const results = useMemo(
    () => searchTracks(files, tags, debouncedQuery, resultLimit),
    [files, tags, debouncedQuery, resultLimit],
  );

  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = height;
    const onMove = (ev: MouseEvent) => {
      onHeightChange(Math.max(120, Math.min(560, startHeight + (startY - ev.clientY))));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp, { once: true });
  };

  /** One library-style row: player, title/artist, then the same columns the
   * main table shows, plus a Match button. Shared between the free-text
   * results and the variants list so both look identical. */
  const row = (
    path: string,
    key: string,
    opts: { score?: number; onMatch: () => void; onDeny?: () => void },
  ) => {
    const l = label(path);
    const file = byPath.get(path);
    const tag = tags[path];
    return (
      <div
        key={key}
        onDoubleClick={opts.onMatch}
        title={`${path}\n\nPress Match (or double-click) to use this for the highlighted playlist row`}
        className="flex select-none items-center gap-2 rounded-md px-2 py-1 hover:bg-accent/50"
      >
        <AudioPreview path={path} durationSecs={file?.durationSecs} dense />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs" title={l.title}>
            {l.title}
          </div>
          <div className="truncate text-[10px] text-muted-foreground" title={l.artist}>
            {l.artist || "—"}
            {opts.score !== undefined ? ` · ${(opts.score * 100).toFixed(0)}% match` : ""}
          </div>
        </div>
        <div className="hidden w-40 shrink-0 truncate text-[10px] text-muted-foreground sm:block" title={tag?.album}>
          {tag?.album || "—"}
        </div>
        <div className="hidden w-24 shrink-0 truncate text-[10px] text-muted-foreground md:block" title={tag?.genre}>
          {tag?.genre || "—"}
        </div>
        <div className="hidden w-12 shrink-0 text-right text-[10px] text-muted-foreground lg:block">
          {tag?.year || "—"}
        </div>
        <span className="shrink-0 rounded bg-secondary px-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
          {file?.format ?? ""}
        </span>
        <button
          onClick={opts.onMatch}
          title="Use this file for the highlighted playlist row"
          className="shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-medium hover:bg-accent"
        >
          <Check className="h-3 w-3" />
        </button>
        {opts.onDeny && (
          <button
            onClick={opts.onDeny}
            title="Not this one — remove it from the candidate list"
            className="shrink-0 rounded-md border border-input p-0.5 text-muted-foreground hover:border-destructive hover:text-destructive"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="relative shrink-0 border-t bg-card/60">
      {!collapsed && (
        <div
          className="absolute -top-1 left-0 h-2 w-full cursor-row-resize"
          onMouseDown={startResize}
          title="Drag to resize"
        />
      )}

      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => collapsed && onCollapsedChange(false)}
          placeholder="Search your library to match by hand — try artist:brejcha, or -live to exclude"
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
        {query && (
          <button
            onClick={() => {
              setQuery("");
              setDebouncedQuery("");
            }}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            title="Clear"
          >
            <X className="h-3 w-3" />
          </button>
        )}
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {query.trim() ? `${results.length} found` : `${files.length} loaded`}
        </span>
        <button
          onClick={() => onCollapsedChange(!collapsed)}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent"
          title={collapsed ? "Show search results" : "Hide search results"}
        >
          {collapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
      </div>

      {!collapsed && (
        <div className="overflow-y-auto" style={{ height }}>
          {variants && variants.candidates.length > 0 && (
            <div className="border-b px-1 pb-1 pt-1">
              <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Other versions for {variants.rowLabel}
              </div>
              <div className="space-y-px">
                {variants.candidates.map((c) =>
                  row(c.path, `variant-${c.path}`, {
                    score: c.score,
                    onMatch: () => onPickVariant?.(c.path),
                    onDeny: onDenyVariant ? () => onDenyVariant(c.path) : undefined,
                  }),
                )}
              </div>
            </div>
          )}

          {query.trim() && (
            <div className="hidden items-center gap-2 border-b px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:flex">
              <span className="w-[1.9rem] shrink-0" />
              {columnHeaders.map((c) => (
                <span key={c.label} className={c.className}>
                  {c.label}
                </span>
              ))}
            </div>
          )}

          {!query.trim() ? (
            !variants?.candidates.length && (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                Click a playlist row, then search here and press Match on the
                right track.
              </p>
            )
          ) : results.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              Nothing in the loaded collection matches “{query.trim()}”.
            </p>
          ) : (
            <div className={cn("space-y-px p-1")}>
              {results.map(({ file }) => row(file.path, file.path, { onMatch: () => onPick(file.path) }))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
