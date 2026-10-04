import { Plus, X } from "lucide-react";
import type { SessionTabView } from "../hooks/useSessionTabs";
import { cn } from "./ui";

/**
 * Thin strip above the track table: one tab per session (a hand-built batch
 * or a loaded genre). Switching is locked while a long action runs, since
 * its results land in the live tab.
 */
export function SessionTabs({
  tabs,
  activeId,
  disabled,
  onSelect,
  onNew,
  onClose,
}: {
  tabs: SessionTabView[];
  activeId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={cn(
            "group flex max-w-[200px] shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs",
            t.id === activeId
              ? "bg-accent font-medium"
              : "cursor-pointer text-muted-foreground hover:bg-accent/60",
            disabled && "pointer-events-none opacity-60",
          )}
          onClick={() => onSelect(t.id)}
          title={t.title}
        >
          <span className="min-w-0 truncate">{t.title}</span>
          <span className="shrink-0 text-muted-foreground">({t.fileCount})</span>
          {tabs.length > 1 && (
            <button
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      ))}
      <button
        className={cn(
          "shrink-0 rounded-md border p-1 text-muted-foreground hover:bg-accent",
          disabled && "pointer-events-none opacity-60",
        )}
        title="New empty tab"
        onClick={onNew}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
