import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { ClipboardCopy, FolderOpen, Info, ListPlus, Play } from "lucide-react";
import { cn } from "./ui";

export interface MenuItem {
  icon: typeof Play;
  label: string;
  run: () => unknown;
  danger?: boolean;
}

export type MenuEntry = MenuItem | null;

export interface TrackMenuState {
  x: number;
  y: number;
  /** The paths the menu acts on — more than one when right-clicking inside
   * an existing multi-selection. */
  paths: string[];
}

/**
 * Right-click menu state shared by every place a track row appears (the
 * working batch table, the library search dock, YT-import matched rows).
 * Positioned at the pointer; closed on any outside click, Escape, or scroll —
 * the same behavior `TrackTable` already had before this was pulled out.
 */
export function useTrackContextMenu() {
  const [menu, setMenu] = useState<TrackMenuState | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const openMenu = (e: React.MouseEvent, paths: string[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, paths });
  };

  const closeMenu = () => setMenu(null);

  return { menu, openMenu, closeMenu };
}

/**
 * The items every track row should offer: open, add to the working batch,
 * reveal on disk, copy the path, and inspect tags. Callers that also need
 * row-specific actions (Open with…, Convert, Delete) splice this list with
 * their own before/after it rather than reimplementing these five.
 */
export function trackMenuItems(opts: {
  paths: string[];
  /** Omit when the row is already in the working batch (the table itself),
   * where "add to working batch" is meaningless. */
  onAddToBatch?: (paths: string[]) => unknown;
  onInspect?: (path: string) => unknown;
}): MenuEntry[] {
  const n = opts.paths.length;
  const suffix = n > 1 ? ` ${n} songs` : "";
  const items: MenuEntry[] = [
    {
      icon: Play,
      label: `Open${suffix}`,
      run: () => Promise.all(opts.paths.map((p) => openPath(p))),
    },
  ];
  if (opts.onAddToBatch) {
    items.push({
      icon: ListPlus,
      label: n > 1 ? `Add ${n} to working batch` : "Add to working batch",
      run: () => opts.onAddToBatch!(opts.paths),
    });
  }
  items.push(
    {
      icon: FolderOpen,
      label: "Reveal in File Explorer",
      run: () => Promise.all(opts.paths.map((p) => revealItemInDir(p))),
    },
    {
      icon: ClipboardCopy,
      label: "Copy path",
      run: () => navigator.clipboard.writeText(opts.paths.join("\n")),
    },
  );
  if (opts.onInspect && n === 1) {
    items.push({ icon: Info, label: "Inspect tags", run: () => opts.onInspect!(opts.paths[0]) });
  }
  return items;
}

/** Renders the floating menu itself. `onRun` wraps each item's action so the
 * caller can log failures its own way (TrackTable logs to console, for
 * instance) before the menu closes. */
export function TrackContextMenu({
  menu,
  items,
  onRun,
}: {
  menu: TrackMenuState;
  items: MenuEntry[];
  onRun: (fn: () => unknown) => void;
}) {
  return createPortal(
    <div
      className="fixed z-[60] min-w-[200px] overflow-hidden rounded-md border bg-popover py-1 text-sm shadow-lg"
      style={{
        left: Math.min(menu.x, window.innerWidth - 220),
        top: Math.min(menu.y, window.innerHeight - 300),
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item === null ? (
          <div key={`sep${i}`} className="my-1 border-t" />
        ) : (
          <button
            key={item.label}
            onClick={() => onRun(item.run)}
            className={cn(
              "flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-accent",
              item.danger && "text-destructive hover:bg-destructive/10",
            )}
          >
            <item.icon className="h-3.5 w-3.5 shrink-0" />
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
