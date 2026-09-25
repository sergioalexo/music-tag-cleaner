import { useState } from "react";
import { BarChart3, CheckCircle2, ChevronDown, ChevronRight, Copy, Info, Terminal, Trash2, XCircle } from "lucide-react";
import type { LogEntry } from "../App";
import type { ActionCounts } from "../hooks/useAnalytics";
import { Button, Card, cn } from "../components/ui";

interface Props {
  logs: LogEntry[];
  onClear: () => void;
  actionCounts: ActionCounts;
  onResetActionCounts: () => void;
}

const KIND_ICON = {
  error: XCircle,
  success: CheckCircle2,
  info: Info,
};

const KIND_COLOR = {
  error: "text-destructive",
  success: "text-primary",
  info: "text-muted-foreground",
};

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function LogsPage({ logs, onClear, actionCounts, onResetActionCounts }: Props) {
  const [filter, setFilter] = useState<"all" | "error">("all");
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const visible = filter === "error" ? logs.filter((l) => l.kind === "error") : logs;

  const toggleExpanded = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Every entry's structured `details` (a fetched URL, a match's score and
  // runner-ups, an export's file list, …) is included under its line, so
  // pasting this into an AI carries the whole story — not just "Matched to
  // X" with no idea what else was considered or why.
  const copyAll = async () => {
    const text = visible
      .map((l) => {
        const line = `[${formatTime(l.time)}] ${l.kind.toUpperCase()}: ${l.message}`;
        return l.details !== undefined ? `${line}\n${JSON.stringify(l.details, null, 2)}` : line;
      })
      .join("\n");
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const topActions = Object.entries(actionCounts).sort((a, b) => b[1] - a[1]);

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col gap-4 overflow-y-auto p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold">
            <Terminal className="h-5 w-5" />
            Logs
          </h1>
          <p className="text-sm text-muted-foreground">
            Everything the app has reported this session — the detail behind each toast, kept around
            so you can scroll back and copy it for troubleshooting.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={copyAll} disabled={visible.length === 0}>
            <Copy />
            {copied ? "Copied!" : "Copy All"}
          </Button>
          <Button variant="secondary" size="sm" onClick={onClear} disabled={logs.length === 0}>
            <Trash2 />
            Clear
          </Button>
        </div>
      </div>

      <div className="flex gap-1">
        <button
          onClick={() => setFilter("all")}
          className={cn(
            "rounded-md px-3 py-1 text-xs font-medium",
            filter === "all" ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground",
          )}
        >
          All ({logs.length})
        </button>
        <button
          onClick={() => setFilter("error")}
          className={cn(
            "rounded-md px-3 py-1 text-xs font-medium",
            filter === "error" ? "bg-destructive text-destructive-foreground" : "bg-secondary text-secondary-foreground",
          )}
        >
          Errors ({logs.filter((l) => l.kind === "error").length})
        </button>
      </div>

      <Card className="max-h-[50vh] overflow-y-auto">
        {visible.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">Nothing logged yet.</p>
        ) : (
          <div className="divide-y divide-border/50 font-mono text-xs">
            {[...visible].reverse().map((l) => {
              const Icon = KIND_ICON[l.kind];
              const hasDetails = l.details !== undefined;
              const isOpen = expanded.has(l.id);
              return (
                <div key={l.id} className="px-3 py-2">
                  <div
                    className={cn("flex items-start gap-2", hasDetails && "cursor-pointer")}
                    onClick={() => hasDetails && toggleExpanded(l.id)}
                  >
                    {hasDetails ? (
                      isOpen ? (
                        <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )
                    ) : (
                      <span className="w-3.5 shrink-0" />
                    )}
                    <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", KIND_COLOR[l.kind])} />
                    <span className="shrink-0 text-muted-foreground">{formatTime(l.time)}</span>
                    <span className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words", KIND_COLOR[l.kind])}>
                      {l.message}
                    </span>
                  </div>
                  {hasDetails && isOpen && (
                    <pre className="ml-9 mt-1 max-h-48 overflow-auto rounded-md bg-secondary/50 p-2 text-[10px] text-foreground">
                      {JSON.stringify(l.details, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card>
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <BarChart3 className="h-4 w-4" />
            Action Usage
          </h2>
          <Button variant="ghost" size="sm" onClick={onResetActionCounts} disabled={topActions.length === 0}>
            <Trash2 />
            Reset
          </Button>
        </div>
        {topActions.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            Nothing tracked yet — this fills in as you use the app.
          </p>
        ) : (
          <div className="max-h-64 overflow-y-auto p-3">
            {topActions.map(([action, count]) => {
              const max = topActions[0][1];
              return (
                <div key={action} className="mb-1.5 flex items-center gap-2 text-xs">
                  <span className="w-40 shrink-0 truncate font-mono text-muted-foreground" title={action}>
                    {action}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${(count / max) * 100}%` }}
                    />
                  </div>
                  <span className="w-8 shrink-0 text-right font-mono">{count}</span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
