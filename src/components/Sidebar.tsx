import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Copy, Disc3, Moon, Music, Package, Settings, Sun, Terminal } from "lucide-react";
import { cn } from "./ui";

export type Page = "library" | "duplicates" | "components" | "settings" | "logs";

const NAV: { page: Page; label: string; icon: typeof Music }[] = [
  { page: "library", label: "Library", icon: Disc3 },
  { page: "duplicates", label: "Duplicates", icon: Copy },
  { page: "components", label: "Components", icon: Package },
  { page: "logs", label: "Logs", icon: Terminal },
  { page: "settings", label: "Settings", icon: Settings },
];

interface Props {
  page: Page;
  setPage: (page: Page) => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  fileCount: number;
  errorLogCount: number;
}

export function Sidebar({
  page,
  setPage,
  theme,
  onToggleTheme,
  fileCount,
  errorLogCount,
}: Props) {
  // getVersion() reads the real app version at runtime (package.json /
  // tauri.conf.json / Cargo.toml all stay in sync via `npm version`) instead
  // of a hardcoded string that silently goes stale across releases.
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion(null));
  }, []);

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r bg-card/50">
      <div className="flex items-center gap-2.5 px-5 pb-4 pt-5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary shadow-lg shadow-primary/25">
          <Music className="h-5 w-5 text-primary-foreground" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-bold leading-tight">
            <span className="text-muted-foreground">/ </span>MusicTagCleaner
          </div>
          <div className="text-[10px] text-muted-foreground">
            {version ? `v${version}` : "v…"} · lofty · ollama
          </div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-2">
        {NAV.map(({ page: p, label, icon: Icon }) => {
          const active = page === p;
          return (
            <button
              key={p}
              onClick={() => setPage(p)}
              className={cn(
                "relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              <span className="flex-1 text-left font-medium">{label}</span>
              {p === "library" && fileCount > 0 && (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                  {fileCount}
                </span>
              )}
              {p === "logs" && errorLogCount > 0 && (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-destructive px-1.5 text-[10px] font-semibold text-destructive-foreground">
                  {errorLogCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="border-t p-3">
        <button
          onClick={onToggleTheme}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          <span className="font-medium">{theme === "dark" ? "Light theme" : "Dark theme"}</span>
        </button>
      </div>
    </aside>
  );
}
