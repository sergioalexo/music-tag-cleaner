import type { OllamaStatus } from "../types";
import { formatBytes } from "../types";
import { cn } from "./ui";

interface Props {
  fileCount: number;
  selectedCount: number;
  totalSize: number;
  ollama: OllamaStatus | null;
  progress: { done: number; total: number; label: string } | null;
}

export default function StatusBar({ fileCount, selectedCount, totalSize, ollama, progress }: Props) {
  return (
    <footer className="flex h-8 items-center gap-4 border-t bg-card/50 px-4 text-xs text-muted-foreground">
      <span>
        {fileCount} file{fileCount === 1 ? "" : "s"} · {selectedCount} selected ·{" "}
        {formatBytes(totalSize)}
      </span>

      {progress && (
        <span className="flex flex-1 items-center gap-2 text-foreground">
          <span className="whitespace-nowrap">{progress.label}</span>
          <span className="h-1.5 max-w-64 flex-1 overflow-hidden rounded-full bg-secondary">
            <span
              className="block h-full rounded-full bg-violet transition-all"
              style={{
                width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%`,
              }}
            />
          </span>
        </span>
      )}

      <span className="ml-auto flex items-center gap-1.5">
        <span
          className={cn(
            "inline-block h-2 w-2 rounded-full",
            ollama?.running ? "bg-primary" : "bg-muted-foreground/40",
          )}
        />
        {ollama?.running
          ? `Ollama · ${ollama.models.length} model${ollama.models.length === 1 ? "" : "s"}`
          : "Ollama offline"}
      </span>
    </footer>
  );
}
