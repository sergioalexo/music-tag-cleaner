import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { AudioFile, TagData } from "../types";
import { searchTracks } from "../lib/trackSearch";
import { AudioPreview } from "./AudioPreview";

/**
 * A dock at the bottom of the YouTube-import screen for finding a track by
 * hand when the matcher couldn't.
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
  onHeightChange,
  onCollapsedChange,
  onPick,
}: {
  files: AudioFile[];
  tags: Record<string, TagData>;
  height: number;
  collapsed: boolean;
  label: (path: string) => { title: string; artist: string };
  onHeightChange: (height: number) => void;
  onCollapsedChange: (collapsed: boolean) => void;
  /** Assigns this file to whichever playlist row is focused. */
  onPick: (path: string) => void;
}) {
  const [query, setQuery] = useState("");

  const results = useMemo(
    () => searchTracks(files, tags, query, 300),
    [files, tags, query],
  );

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
            onClick={() => setQuery("")}
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
          {!query.trim() ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              Click a playlist row, then search here and press Match on the
              right track.
            </p>
          ) : results.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              Nothing in the loaded collection matches “{query.trim()}”.
            </p>
          ) : (
            <div className="space-y-px p-1">
              {results.map(({ file }) => {
                const l = label(file.path);
                return (
                  <div
                    key={file.path}
                    onDoubleClick={() => onPick(file.path)}
                    title={`${file.path}\n\nPress Match (or double-click) to use this for the highlighted playlist row`}
                    className="flex select-none items-center gap-2 rounded-md px-2 py-1 hover:bg-accent/50"
                  >
                    <AudioPreview path={file.path} compact />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs" title={l.title}>
                        {l.title}
                      </div>
                      <div className="truncate text-[10px] text-muted-foreground" title={l.artist}>
                        {l.artist || "—"}
                      </div>
                    </div>
                    <span className="shrink-0 rounded bg-secondary px-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {file.format}
                    </span>
                    <button
                      onClick={() => onPick(file.path)}
                      title="Use this file for the highlighted playlist row"
                      className="shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-medium hover:bg-accent"
                    >
                      Match
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
