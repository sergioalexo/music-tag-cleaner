import { useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Folder, Music2, Search, User, X } from "lucide-react";
import type { AudioFile, TagData } from "../types";
import { cn } from "./ui";

export type SidebarMode = "folders" | "genres" | "artists";

/** What the sidebar currently narrows the track table down to, if anything. */
export type SidebarFilter = { mode: "folder"; value: string } | { mode: "genre" | "artist"; value: string };

interface FolderNode {
  name: string;
  fullPath: string;
  count: number;
  children: Map<string, FolderNode>;
}

const SEP = /[/\\]/;

function buildFolderTree(files: AudioFile[]): FolderNode {
  const root: FolderNode = { name: "", fullPath: "", count: 0, children: new Map() };
  for (const f of files) {
    const parts = f.path.split(SEP).filter(Boolean);
    parts.pop(); // drop the filename itself
    let node = root;
    let acc = "";
    root.count++;
    for (const part of parts) {
      acc = acc ? `${acc}${f.path.includes("\\") ? "\\" : "/"}${part}` : part;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, fullPath: acc, count: 0, children: new Map() };
        node.children.set(part, child);
      }
      child.count++;
      node = child;
    }
  }
  return root;
}

/** Tallies raw string values (e.g. every track's genre or artist), unmerged — this is for exact-match browsing, not the fuzzy grouping Detect Genres does. */
function tally(values: (string | undefined | null)[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const v of values) {
    const t = v?.trim();
    if (!t) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function FolderRow({
  node,
  depth,
  query,
  filter,
  onSelect,
}: {
  node: FolderNode;
  depth: number;
  query: string;
  filter: SidebarFilter | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const children = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
  const q = query.trim().toLowerCase();
  const selfMatches = !q || node.name.toLowerCase().includes(q);
  const visibleChildren = q ? children.filter((c) => subtreeMatches(c, q)) : children;
  if (q && !selfMatches && visibleChildren.length === 0) return null;
  const active = filter?.mode === "folder" && filter.value === node.fullPath;

  return (
    <div>
      <div
        className={cn(
          "flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-sm hover:bg-accent",
          active && "bg-accent font-medium",
        )}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => onSelect(node.fullPath)}
      >
        {children.length > 0 ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setOpen((o) => !o);
            }}
            className="shrink-0 text-muted-foreground"
          >
            {open || q ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate" title={node.fullPath}>
          {node.name}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{node.count}</span>
      </div>
      {(open || q) &&
        visibleChildren.map((c) => (
          <FolderRow key={c.fullPath} node={c} depth={depth + 1} query={query} filter={filter} onSelect={onSelect} />
        ))}
    </div>
  );
}

function subtreeMatches(node: FolderNode, q: string): boolean {
  if (node.name.toLowerCase().includes(q)) return true;
  for (const c of node.children.values()) if (subtreeMatches(c, q)) return true;
  return false;
}

/**
 * Library browser: Folders / Genres / Artists, each filtering the track
 * table down to an exact match — a plain in-memory filter over what's
 * already loaded, never a disk rescan. A search box narrows the tree/list
 * itself, separate from the table's own row search.
 */
export function LibrarySidebar({
  files,
  tags,
  width,
  collapsed,
  filter,
  onFilterChange,
  onWidthChange,
  onCollapsedChange,
}: {
  files: AudioFile[];
  tags: Record<string, TagData>;
  width: number;
  collapsed: boolean;
  filter: SidebarFilter | null;
  onFilterChange: (filter: SidebarFilter | null) => void;
  onWidthChange: (width: number) => void;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const [mode, setMode] = useState<SidebarMode>("folders");
  const [query, setQuery] = useState("");

  const folderTree = useMemo(() => buildFolderTree(files), [files]);
  const genreCounts = useMemo(
    () => tally(files.map((f) => tags[f.path]?.genre)),
    [files, tags],
  );
  const artistCounts = useMemo(
    () => tally(files.map((f) => tags[f.path]?.artist)),
    [files, tags],
  );

  const select = (mode: SidebarFilter["mode"], value: string) => {
    if (filter?.mode === mode && filter.value === value) onFilterChange(null);
    else onFilterChange({ mode, value } as SidebarFilter);
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev: MouseEvent) => {
      onWidthChange(Math.max(160, Math.min(420, startWidth + ev.clientX - startX)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp, { once: true });
  };

  if (collapsed) {
    return (
      <button
        onClick={() => onCollapsedChange(false)}
        className="flex w-6 shrink-0 items-center justify-center border-r bg-card/50 text-muted-foreground hover:bg-accent"
        title="Show library browser"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    );
  }

  const q = query.trim().toLowerCase();
  const filteredGenres = q ? genreCounts.filter((g) => g.name.toLowerCase().includes(q)) : genreCounts;
  const filteredArtists = q ? artistCounts.filter((a) => a.name.toLowerCase().includes(q)) : artistCounts;

  return (
    <div
      className="relative flex shrink-0 flex-col border-r bg-card/50"
      style={{ width }}
    >
      <div className="flex items-center gap-1 border-b p-2">
        {(
          [
            { id: "folders", label: "Folders", icon: Folder },
            { id: "genres", label: "Genres", icon: Music2 },
            { id: "artists", label: "Artists", icon: User },
          ] as const
        ).map((m) => (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            className={cn(
              "flex flex-1 flex-col items-center gap-0.5 rounded-md py-1.5 text-[10px] font-medium",
              mode === m.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60",
            )}
            title={m.label}
          >
            <m.icon className="h-3.5 w-3.5" />
            {m.label}
          </button>
        ))}
        <button
          onClick={() => onCollapsedChange(true)}
          className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent"
          title="Hide library browser"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-1.5 border-b px-2 py-1.5">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Find a ${mode === "folders" ? "folder" : mode === "genres" ? "genre" : "artist"}…`}
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
        {query && (
          <button onClick={() => setQuery("")} className="shrink-0 text-muted-foreground hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {filter && (
        <div
          className="flex items-center gap-1.5 border-b bg-primary/5 px-2 py-1.5 text-xs"
          title={filter.mode === "folder" ? filter.value : undefined}
        >
          <span className="min-w-0 flex-1 truncate">
            Filtered to{" "}
            <span className="font-medium">
              {filter.mode === "folder" ? filter.value.split(SEP).pop() : filter.value}
            </span>
          </span>
          <button onClick={() => onFilterChange(null)} className="shrink-0 text-muted-foreground hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-1.5">
        {mode === "folders" &&
          (folderTree.children.size === 0 ? (
            <p className="px-1.5 py-2 text-xs text-muted-foreground">No folders loaded.</p>
          ) : (
            [...folderTree.children.values()]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((c) => (
                <FolderRow
                  key={c.fullPath}
                  node={c}
                  depth={0}
                  query={query}
                  filter={filter}
                  onSelect={(p) => select("folder", p)}
                />
              ))
          ))}
        {mode === "genres" &&
          (filteredGenres.length === 0 ? (
            <p className="px-1.5 py-2 text-xs text-muted-foreground">No genres found.</p>
          ) : (
            filteredGenres.map((g) => (
              <button
                key={g.name}
                onClick={() => select("genre", g.name)}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm hover:bg-accent",
                  filter?.mode === "genre" && filter.value === g.name && "bg-accent font-medium",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{g.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{g.count}</span>
              </button>
            ))
          ))}
        {mode === "artists" &&
          (filteredArtists.length === 0 ? (
            <p className="px-1.5 py-2 text-xs text-muted-foreground">No artists found.</p>
          ) : (
            filteredArtists.map((a) => (
              <button
                key={a.name}
                onClick={() => select("artist", a.name)}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm hover:bg-accent",
                  filter?.mode === "artist" && filter.value === a.name && "bg-accent font-medium",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{a.count}</span>
              </button>
            ))
          ))}
      </div>

      <div
        className="absolute -right-1 top-0 h-full w-2 cursor-col-resize"
        onMouseDown={startResize}
        title="Drag to resize"
      />
    </div>
  );
}

/** Whether `file` matches the current sidebar filter (folder/genre/artist). */
export function matchesSidebarFilter(
  file: AudioFile,
  tags: Record<string, TagData>,
  filter: SidebarFilter | null,
): boolean {
  if (!filter) return true;
  if (filter.mode === "folder") {
    const sep = file.path.includes("\\") ? "\\" : "/";
    return file.path === filter.value || file.path.startsWith(filter.value + sep);
  }
  const t = tags[file.path];
  if (filter.mode === "genre") return (t?.genre ?? "") === filter.value;
  return (t?.artist ?? "") === filter.value;
}
