import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, ListMusic, Loader2, X } from "lucide-react";

import type { Notify } from "../hooks/useFiles";
import type { PlaylistExportResult, PlaylistNode } from "../types";
import { Button, Card, cn } from "./ui";

interface Props {
  xmlPath: string;
  onClose: () => void;
  notify: Notify;
}

/** Every playlist (non-folder) id in the tree, root included. */
function allPlaylistIds(node: PlaylistNode, out: string[] = []): string[] {
  if (node.isFolder) {
    for (const child of node.children) allPlaylistIds(child, out);
  } else {
    out.push(node.id);
  }
  return out;
}

function folderState(node: PlaylistNode, selected: Set<string>): "checked" | "unchecked" | "indeterminate" {
  const ids = allPlaylistIds(node);
  if (ids.length === 0) return "unchecked";
  const checkedCount = ids.filter((id) => selected.has(id)).length;
  if (checkedCount === 0) return "unchecked";
  if (checkedCount === ids.length) return "checked";
  return "indeterminate";
}

function TreeRow({
  node,
  depth,
  selected,
  onToggle,
}: {
  node: PlaylistNode;
  depth: number;
  selected: Set<string>;
  onToggle: (ids: string[], check: boolean) => void;
}) {
  if (node.isFolder) {
    const state = folderState(node, selected);
    return (
      <div>
        <label
          className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-accent"
          style={{ paddingLeft: depth * 16 + 8 }}
        >
          <input
            type="checkbox"
            checked={state === "checked"}
            ref={(el) => {
              if (el) el.indeterminate = state === "indeterminate";
            }}
            onChange={(e) => onToggle(allPlaylistIds(node), e.target.checked)}
          />
          <span className="font-medium">{node.name}</span>
          <span className="text-xs text-muted-foreground">({node.trackCount})</span>
        </label>
        {node.children.map((child) => (
          <TreeRow key={child.id} node={child} depth={depth + 1} selected={selected} onToggle={onToggle} />
        ))}
      </div>
    );
  }
  return (
    <label
      className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-accent"
      style={{ paddingLeft: depth * 16 + 8 }}
    >
      <input
        type="checkbox"
        checked={selected.has(node.id)}
        onChange={(e) => onToggle([node.id], e.target.checked)}
      />
      <ListMusic className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{node.name}</span>
      <span className="text-xs text-muted-foreground">({node.trackCount})</span>
    </label>
  );
}

/**
 * Reads a rekordbox.xml's `<PLAYLISTS>` tree and exports the chosen
 * playlists as `.m3u8` files Mixxx's "Import Playlist" reads directly — no
 * USB/SD device export required. Folder structure is mirrored on disk.
 */
export function RekordboxMixxxExportDialog({ xmlPath, onClose, notify }: Props) {
  const [tree, setTree] = useState<PlaylistNode | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<PlaylistNode>("read_rekordbox_playlists", { xmlPath })
      .then((root) => {
        if (cancelled) return;
        setTree(root);
        setSelected(new Set(allPlaylistIds(root)));
      })
      .catch((e) => !cancelled && setLoadError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [xmlPath]);

  const total = useMemo(() => (tree ? allPlaylistIds(tree).length : 0), [tree]);

  const toggle = (ids: string[], check: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (check) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const pickOutputDir = async () => {
    const picked = await openDialog({ directory: true, multiple: false, title: "Where should the .m3u8 files go?" });
    if (typeof picked === "string") setOutputDir(picked);
  };

  const runExport = async () => {
    if (!outputDir || selected.size === 0) return;
    setExporting(true);
    try {
      const playlistIds = selected.size === total ? null : Array.from(selected);
      const result = await invoke<PlaylistExportResult>("export_rekordbox_playlists_for_mixxx", {
        xmlPath,
        outputDir,
        playlistIds,
      });
      const totalTracks = result.exported.reduce((sum, e) => sum + e.matched, 0);
      notify(
        `Exported ${result.exported.length} playlist${result.exported.length === 1 ? "" : "s"} ` +
          `(${totalTracks} tracks) to ${outputDir}. In Mixxx, right-click Playlists → Import Playlist for each file.`,
        "success",
      );
      onClose();
    } catch (e) {
      notify(`Could not export playlists: ${e}`, "error");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <Card className="flex max-h-full w-[520px] flex-col overflow-hidden">
        <div className="flex items-start justify-between gap-4 border-b px-5 py-3.5">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <ListMusic className="h-4 w-4" /> Export Rekordbox Playlists for Mixxx
            </h2>
            <p className="text-xs text-muted-foreground">
              Each selected playlist is written as a standalone .m3u8 file — no USB/SD device needed.
              Rekordbox folders become subfolders of your chosen output folder.
            </p>
          </div>
          <button className="text-muted-foreground hover:text-foreground" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-[120px] flex-1 overflow-y-auto px-2 py-3">
          {loadError ? (
            <p className="px-3 text-sm text-destructive">{loadError}</p>
          ) : !tree ? (
            <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Reading playlists…
            </div>
          ) : total === 0 ? (
            <p className="px-3 text-sm text-muted-foreground">This rekordbox.xml has no playlists.</p>
          ) : (
            tree.children.map((child) => (
              <TreeRow key={child.id} node={child} depth={0} selected={selected} onToggle={toggle} />
            ))
          )}
        </div>

        <div className="flex items-center justify-between gap-4 border-t px-5 py-3">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={pickOutputDir}>
              <FolderOpen />
              {outputDir ? "Change Folder" : "Choose Output Folder"}
            </Button>
            {outputDir && <span className={cn("max-w-[160px] truncate text-xs text-muted-foreground")}>{outputDir}</span>}
          </div>
          <Button size="sm" onClick={runExport} disabled={!outputDir || selected.size === 0 || exporting}>
            <ListMusic />
            {exporting ? "Exporting…" : `Export ${selected.size}`}
          </Button>
        </div>
      </Card>
    </div>
  );
}
