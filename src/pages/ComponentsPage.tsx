import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { confirm } from "@tauri-apps/plugin-dialog";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  Boxes,
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
  RotateCw,
  Server,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react";
import type { ComponentProgress, OllamaInfo, OllamaStatus } from "../types";
import { formatBytes } from "../types";
import { Badge, Button, Card, cn, inputClass } from "../components/ui";

interface Props {
  ollamaUrl: string;
  notify: (message: string, kind?: "success" | "error" | "info") => void;
  onOllamaChanged: () => void;
}

/** Solid general-purpose models that fit typical desktop hardware. */
const RECOMMENDED_MODELS = [
  "qwen2.5:7b",
  "llama3.1:8b",
  "gemma2:9b",
  "qwen2.5:14b",
  "deepseek-r1:14b",
];

function ProgressBar({ value }: { value: number | null }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
      <div
        className={cn("h-full rounded-full bg-primary transition-all", value === null && "w-1/3 animate-pulse")}
        style={value === null ? undefined : { width: `${Math.round(value * 100)}%` }}
      />
    </div>
  );
}

/** Maps opaque Tauri updater errors to a plain-language explanation, with the raw error kept for debugging. */
function describeUpdateError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const lower = raw.toLowerCase();
  let hint: string;
  if (lower.includes("error sending request") || lower.includes("dns") || lower.includes("network")) {
    hint = "Could not reach the update server — check your internet connection.";
  } else if (lower.includes("404") || lower.includes("not found")) {
    hint = "No update endpoint found — a release may not be published yet.";
  } else if (lower.includes("signature")) {
    hint = "The update failed signature verification — it may be corrupted or tampered with.";
  } else if (lower.includes("json") || lower.includes("parse") || lower.includes("deserialize")) {
    hint = "The update server returned an unexpected response.";
  } else {
    hint = "Update check failed.";
  }
  return `${hint} (${raw})`;
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-secondary/50 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="truncate font-mono text-sm font-medium" title={value}>
        {value}
      </div>
    </div>
  );
}

export function ComponentsPage({ ollamaUrl, notify, onOllamaChanged }: Props) {
  const [info, setInfo] = useState<OllamaInfo | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [starting, setStarting] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pullName, setPullName] = useState("");
  const [deletingModel, setDeletingModel] = useState<string | null>(null);
  const [progress, setProgress] = useState<ComponentProgress | null>(null);
  const pollTimer = useRef<number | null>(null);

  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateChecked, setUpdateChecked] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion(null));
  }, []);

  const checkForUpdate = async () => {
    setCheckingUpdate(true);
    try {
      const result = await check();
      setUpdate(result);
      setUpdateChecked(true);
      if (!result) notify("You're on the latest version", "success");
    } catch (e) {
      notify(describeUpdateError(e), "error");
    } finally {
      setCheckingUpdate(false);
    }
  };

  const installUpdate = async () => {
    if (!update) return;
    setDownloading(true);
    setDownloadProgress(null);
    try {
      let total = 0;
      let done = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          setDownloadProgress({ done: 0, total });
        } else if (event.event === "Progress") {
          done += event.data.chunkLength;
          setDownloadProgress({ done, total });
        }
      });
      setInstalled(true);
      notify(`Version ${update.version} installed — restart to apply`, "success");
    } catch (e) {
      notify(`Update failed: ${describeUpdateError(e)}`, "error");
    } finally {
      setDownloading(false);
    }
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const i = await invoke<OllamaInfo>("ollama_info", { url: ollamaUrl });
      setInfo(i);
      if (i.running) {
        const status = await invoke<OllamaStatus>("check_ollama", { url: ollamaUrl });
        setModels(status.models);
      } else {
        setModels(null);
      }
      onOllamaChanged();
      return i;
    } catch (e) {
      notify(String(e), "error");
      return null;
    } finally {
      setLoading(false);
    }
  }, [ollamaUrl, notify, onOllamaChanged]);

  useEffect(() => {
    refresh();
    const unlisten = listen<ComponentProgress>("component-progress", (e) => {
      setProgress(e.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
      if (pollTimer.current) window.clearTimeout(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Polls until the server comes up (e.g. while the installer runs). */
  const pollUntilRunning = (attempts: number) => {
    if (pollTimer.current) window.clearTimeout(pollTimer.current);
    if (attempts <= 0) return;
    pollTimer.current = window.setTimeout(async () => {
      const i = await refresh();
      if (!i?.running) pollUntilRunning(attempts - 1);
    }, 3000);
  };

  const install = async () => {
    setInstalling(true);
    setProgress(null);
    try {
      await invoke("install_ollama");
      notify("Installer launched — follow the setup wizard", "success");
      pollUntilRunning(60);
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setInstalling(false);
      setProgress(null);
    }
  };

  const start = async () => {
    setStarting(true);
    try {
      await invoke("start_ollama");
      pollUntilRunning(10);
    } catch (e) {
      notify(String(e), "error");
      setStarting(false);
    }
  };

  useEffect(() => {
    if (info?.running) setStarting(false);
  }, [info?.running]);

  const pull = async (model: string) => {
    const name = model.trim();
    if (!name) return;
    setPulling(true);
    setProgress(null);
    try {
      await invoke("pull_model", { url: ollamaUrl, model: name });
      notify(`Model ${name} installed`, "success");
      setPullName("");
      await refresh();
    } catch (e) {
      notify(`Could not pull ${name}: ${e}`, "error");
    } finally {
      setPulling(false);
      setProgress(null);
    }
  };

  const deleteModel = async (name: string) => {
    const ok = await confirm(`Delete model "${name}"? You'll need to pull it again to use it.`, {
      title: "Delete Model",
      kind: "warning",
    });
    if (!ok) return;
    setDeletingModel(name);
    try {
      await invoke("delete_model", { url: ollamaUrl, model: name });
      notify(`Model ${name} deleted`, "success");
      await refresh();
    } catch (e) {
      notify(`Could not delete ${name}: ${e}`, "error");
    } finally {
      setDeletingModel(null);
    }
  };

  const ollamaProgress = progress?.component === "ollama" ? progress : null;
  const modelProgress = progress?.component === "model" ? progress : null;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Components</h1>
          <p className="text-sm text-muted-foreground">
            Everything AI Clean needs to run locally
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={loading ? "animate-spin" : ""} />
          Refresh
        </Button>
      </div>

      {/* Music Tag Cleaner itself */}
      <Card className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
              <Sparkles className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold">Music Tag Cleaner</span>
                <Badge className="bg-secondary">v{appVersion ?? "…"}</Badge>
                {update && (
                  <Badge className="gap-1 bg-primary/15 text-primary">
                    <CheckCircle2 className="h-3 w-3" /> v{update.version} available
                  </Badge>
                )}
              </div>
              <button
                onClick={() => void openUrl("https://github.com/sergioalexo/music-tag-cleaner/releases")}
                className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
              >
                Release notes <ExternalLink className="h-3 w-3" />
              </button>
            </div>
          </div>

          <div className="flex shrink-0 gap-2">
            {installed ? (
              <Button size="sm" onClick={() => void relaunch()}>
                <RefreshCw />
                Restart to Apply
              </Button>
            ) : update ? (
              <Button size="sm" onClick={installUpdate} disabled={downloading}>
                {downloading ? <Loader2 className="animate-spin" /> : <Download />}
                {downloading ? "Installing…" : `Install v${update.version}`}
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={checkForUpdate}
                disabled={checkingUpdate}
              >
                <RotateCw className={checkingUpdate ? "animate-spin" : ""} />
                {checkingUpdate ? "Checking…" : "Check for Updates"}
              </Button>
            )}
          </div>
        </div>

        {updateChecked && !update && !checkingUpdate && (
          <p className="mt-3 text-xs text-muted-foreground">
            You're running the latest version.
          </p>
        )}

        {update?.body && (
          <p className="mt-3 whitespace-pre-wrap rounded-md bg-secondary/50 p-3 text-xs text-muted-foreground">
            {update.body}
          </p>
        )}

        {downloading && (
          <div className="mt-3">
            <ProgressBar
              value={
                downloadProgress && downloadProgress.total > 0
                  ? downloadProgress.done / downloadProgress.total
                  : null
              }
            />
            <div className="mt-1 text-xs text-muted-foreground">
              {downloadProgress && downloadProgress.total > 0
                ? `Downloading ${formatBytes(downloadProgress.done)} / ${formatBytes(downloadProgress.total)}`
                : "Downloading update…"}
            </div>
          </div>
        )}
      </Card>

      {/* Ollama runtime */}
      <Card className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
              <Server className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold">Ollama</span>
                {info === null ? (
                  <Badge>…</Badge>
                ) : info.running ? (
                  <Badge className="gap-1 bg-primary/15 text-primary">
                    <CheckCircle2 className="h-3 w-3" /> Running
                  </Badge>
                ) : info.installed ? (
                  <Badge className="gap-1 bg-secondary text-amber-500">
                    <XCircle className="h-3 w-3" /> Not running
                  </Badge>
                ) : (
                  <Badge className="gap-1 bg-destructive/15 text-destructive">
                    <XCircle className="h-3 w-3" /> Not installed
                  </Badge>
                )}
              </div>
              <button
                onClick={() => void openUrl("https://ollama.com")}
                className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
              >
                ollama.com <ExternalLink className="h-3 w-3" />
              </button>
            </div>
          </div>

          <div className="flex shrink-0 gap-2">
            {info && !info.installed && (
              <Button size="sm" onClick={install} disabled={installing}>
                {installing ? <Loader2 className="animate-spin" /> : <Download />}
                Install
              </Button>
            )}
            {info && info.installed && !info.running && (
              <Button size="sm" onClick={start} disabled={starting}>
                {starting ? <Loader2 className="animate-spin" /> : <Play />}
                Start Ollama
              </Button>
            )}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <InfoTile label="Server version" value={info?.serverVersion ?? "—"} />
          <InfoTile label="Install path" value={info?.installPath ?? "—"} />
        </div>

        {installing && (
          <div className="mt-3">
            <ProgressBar
              value={
                ollamaProgress && ollamaProgress.total > 0
                  ? ollamaProgress.downloaded / ollamaProgress.total
                  : null
              }
            />
            <div className="mt-1 text-xs text-muted-foreground">
              {ollamaProgress?.phase === "launching"
                ? "Launching installer — follow the setup wizard"
                : `Downloading installer ${formatBytes(ollamaProgress?.downloaded ?? 0)}${
                    ollamaProgress && ollamaProgress.total > 0
                      ? ` / ${formatBytes(ollamaProgress.total)}`
                      : ""
                  }`}
            </div>
          </div>
        )}
      </Card>

      {/* Models */}
      <Card className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
              <Boxes className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold">AI Models</span>
                {models !== null && (
                  <Badge className="bg-secondary">
                    {models.length} installed
                  </Badge>
                )}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                Used by AI Clean — pick one in Settings
              </div>
            </div>
          </div>
        </div>

        {!info?.running ? (
          <p className="mt-4 text-sm text-muted-foreground">
            Start Ollama to manage models.
          </p>
        ) : (
          <>
            {models && models.length > 0 && (
              <ul className="mt-4 space-y-1">
                {models.map((m) => (
                  <li
                    key={m}
                    className="flex items-center gap-2 rounded-lg bg-secondary/50 px-3 py-2 font-mono text-sm"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                    <span className="flex-1">{m}</span>
                    <button
                      onClick={() => deleteModel(m)}
                      disabled={deletingModel === m}
                      className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/15 hover:text-destructive disabled:opacity-50"
                      title={`Delete ${m}`}
                    >
                      {deletingModel === m ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {models && models.length === 0 && (
              <p className="mt-4 text-sm text-muted-foreground">
                No models installed yet — pull one below to enable AI Clean.
              </p>
            )}

            <div className="mt-4 flex gap-2">
              <input
                type="text"
                className={cn(inputClass, "flex-1")}
                list="recommended-models"
                placeholder="Model to pull, e.g. qwen2.5:7b"
                value={pullName}
                onChange={(e) => setPullName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !pulling) pull(pullName);
                }}
                disabled={pulling}
              />
              <datalist id="recommended-models">
                {RECOMMENDED_MODELS.filter((m) => !models?.includes(m)).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <Button onClick={() => pull(pullName)} disabled={pulling || !pullName.trim()}>
                {pulling ? <Loader2 className="animate-spin" /> : <Download />}
                Pull
              </Button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {RECOMMENDED_MODELS.filter((m) => !models?.includes(m)).map((m) => (
                <button
                  key={m}
                  className="rounded-md border px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
                  onClick={() => setPullName(m)}
                  disabled={pulling}
                >
                  {m}
                </button>
              ))}
            </div>

            {pulling && (
              <div className="mt-3">
                <ProgressBar
                  value={
                    modelProgress && modelProgress.total > 0
                      ? modelProgress.downloaded / modelProgress.total
                      : null
                  }
                />
                <div className="mt-1 text-xs text-muted-foreground">
                  {modelProgress
                    ? `${modelProgress.phase}${
                        modelProgress.total > 0
                          ? ` — ${formatBytes(modelProgress.downloaded)} / ${formatBytes(modelProgress.total)}`
                          : ""
                      }`
                    : "Contacting Ollama…"}
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
