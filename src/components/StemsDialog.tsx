import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Notify } from "../hooks/useFiles";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Cpu, FolderOpen, Layers, Loader2, Play, X, Zap } from "lucide-react";
import {
  DEMUCS_MODELS,
  DEMUCS_TWO_STEMS,
  type DemucsInfo,
  type StemOptions,
  type StemOutcome,
  type StemProgress,
} from "../types";
import { basename } from "../types";
import { Button, cn, inputClass, selectClass } from "./ui";

/**
 * Stem separation settings and progress.
 *
 * Separation is slow in a way the rest of the app isn't — minutes per track
 * on CPU — so this dialog leans hard on telling the user what a choice will
 * cost *before* they start it, and on showing demucs' own output while it
 * runs. A progress bar that only moves once per finished track looks frozen
 * for ten minutes; the live log line is what makes it obviously alive.
 */
export function StemsDialog({
  paths,
  info,
  options: initial,
  onSaveOptions,
  onClose,
  notify,
}: {
  paths: string[];
  info: DemucsInfo;
  options: StemOptions;
  onSaveOptions: (options: StemOptions) => void;
  onClose: () => void;
  notify: Notify;
}) {
  const [opts, setOpts] = useState<StemOptions>(initial);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<StemProgress | null>(null);
  const [logLine, setLogLine] = useState("");
  const [results, setResults] = useState<StemOutcome[] | null>(null);

  const set = <K extends keyof StemOptions>(key: K, value: StemOptions[K]) =>
    setOpts((prev) => ({ ...prev, [key]: value }));

  // The detected device is the right default, but it's only known once the
  // probe has run — so apply it when the dialog opens rather than baking a
  // guess into the stored defaults.
  useEffect(() => {
    if (info.device && initial.device !== "cuda" && info.device === "cuda") {
      setOpts((prev) => ({ ...prev, device: "cuda" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const unlisten = listen<StemProgress>("stems-progress", (e) => {
      const p = e.payload;
      if (p.line !== undefined) {
        // demucs redraws its progress bar with carriage returns; keep only
        // the last chunk so the label doesn't turn into a wall of text.
        const text = String(p.line).split("\r").pop()?.trim() ?? "";
        if (text) setLogLine(text);
        return;
      }
      setProgress(p);
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  const pickOutput = async () => {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Where should the stems go?",
    });
    if (typeof picked === "string") set("outputDir", picked);
  };

  const run = async () => {
    setRunning(true);
    setResults(null);
    setProgress({ done: 0, total: paths.length, phase: "separating" });
    onSaveOptions(opts);
    try {
      const outcomes = await invoke<StemOutcome[]>("separate_stems", {
        paths,
        options: { ...opts, twoStems: opts.twoStems || null },
      });
      setResults(outcomes);
      const ok = outcomes.filter((o) => o.ok).length;
      const failed = outcomes.length - ok;
      notify(
        `Separated ${ok} track${ok === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}`,
        failed ? "error" : "success",
      );
    } catch (e) {
      notify(String(e), "error");
      setResults(null);
    } finally {
      setRunning(false);
      setProgress(null);
      setLogLine("");
    }
  };

  /**
   * A rough cost estimate. Deliberately rough — it exists to stop someone
   * queueing 200 tracks with shifts=10 on a CPU and assuming it will be
   * done by lunch, not to be accurate.
   */
  const estimate = useMemo(() => {
    const perTrackBase = info.device === "cuda" ? 0.25 : 3.5; // minutes per track
    const modelFactor = opts.model === "htdemucs_ft" ? 4 : opts.model === "htdemucs_6s" ? 1.4 : 1;
    const shiftFactor = Math.max(1, opts.shifts);
    const total = paths.length * perTrackBase * modelFactor * shiftFactor;
    if (total < 1) return "under a minute";
    if (total < 60) return `roughly ${Math.round(total)} min`;
    return `roughly ${(total / 60).toFixed(1)} hours`;
  }, [paths.length, opts.model, opts.shifts, info.device]);

  const pct =
    progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <div className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-bold">
              Separate Stems — {paths.length} track{paths.length === 1 ? "" : "s"}
            </h2>
          </div>
          <button
            onClick={onClose}
            disabled={running}
            className="text-muted-foreground hover:text-foreground disabled:opacity-30"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {results ? (
            <div className="space-y-1">
              {results.map((r) => (
                <div
                  key={r.source}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent/40"
                >
                  <span
                    className={cn(
                      "h-2 w-2 shrink-0 rounded-full",
                      r.ok ? "bg-primary" : "bg-destructive",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate" title={r.source}>
                    {basename(r.source)}
                  </span>
                  {r.ok && r.outputDir ? (
                    <button
                      onClick={() => void revealItemInDir(r.outputDir!)}
                      className="shrink-0 text-primary hover:underline"
                    >
                      Show stems
                    </button>
                  ) : (
                    <span className="min-w-0 shrink-0 truncate text-destructive" title={r.error ?? ""}>
                      {r.error}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium">Model</span>
                  <select
                    className={cn(selectClass, "w-full")}
                    value={opts.model}
                    disabled={running}
                    onChange={(e) => set("model", e.target.value)}
                  >
                    {DEMUCS_MODELS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <span className="mt-1 block text-[10px] text-muted-foreground">
                    {DEMUCS_MODELS.find((m) => m.value === opts.model)?.hint}
                  </span>
                </label>

                <label className="block">
                  <span className="mb-1 block text-xs font-medium">Stems</span>
                  <select
                    className={cn(selectClass, "w-full")}
                    value={opts.twoStems ?? ""}
                    disabled={running}
                    onChange={(e) => set("twoStems", e.target.value)}
                  >
                    {DEMUCS_TWO_STEMS.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <span className="mt-1 block text-[10px] text-muted-foreground">
                    Two-stem mode is the same separation, just mixed back into two files.
                  </span>
                </label>

                <label className="block">
                  <span className="mb-1 block text-xs font-medium">Output format</span>
                  <select
                    className={cn(selectClass, "w-full")}
                    value={opts.format}
                    disabled={running}
                    onChange={(e) => set("format", e.target.value as StemOptions["format"])}
                  >
                    <option value="wav">WAV — lossless, big</option>
                    <option value="flac">FLAC — lossless, compressed</option>
                    <option value="mp3">MP3 — lossy</option>
                  </select>
                </label>

                {opts.format === "mp3" && (
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium">MP3 bitrate</span>
                    <select
                      className={cn(selectClass, "w-full")}
                      value={opts.mp3Bitrate}
                      disabled={running}
                      onChange={(e) => set("mp3Bitrate", Number(e.target.value))}
                    >
                      {[128, 192, 256, 320].map((b) => (
                        <option key={b} value={b}>
                          {b} kbps
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <label className="block">
                  <span className="mb-1 block text-xs font-medium">
                    Quality passes (shifts): {opts.shifts || "off"}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={10}
                    step={1}
                    value={opts.shifts}
                    disabled={running}
                    onChange={(e) => set("shifts", Number(e.target.value))}
                    className="w-full accent-[var(--primary)]"
                  />
                  <span className="mt-1 block text-[10px] text-muted-foreground">
                    Averages several shifted passes. Cleaner, and linearly slower — 2 is a good
                    compromise, 10 is the research setting.
                  </span>
                </label>

                <label className="block">
                  <span className="mb-1 block text-xs font-medium">
                    Window overlap: {opts.overlap.toFixed(2)}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={0.9}
                    step={0.05}
                    value={opts.overlap}
                    disabled={running}
                    onChange={(e) => set("overlap", Number(e.target.value))}
                    className="w-full accent-[var(--primary)]"
                  />
                  <span className="mt-1 block text-[10px] text-muted-foreground">
                    Higher hides seams between chunks. 0.25 is the default.
                  </span>
                </label>

                <label className="block">
                  <span className="mb-1 block text-xs font-medium">Device</span>
                  <select
                    className={cn(selectClass, "w-full")}
                    value={opts.device}
                    disabled={running}
                    onChange={(e) => set("device", e.target.value)}
                  >
                    <option value="cpu">CPU</option>
                    <option value="cuda" disabled={info.device !== "cuda"}>
                      GPU (CUDA){info.device === "cuda" ? ` — ${info.gpuName ?? "detected"}` : " — not available"}
                    </option>
                  </select>
                  <span className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                    {info.device === "cuda" ? <Zap className="h-3 w-3" /> : <Cpu className="h-3 w-3" />}
                    {info.device === "cuda"
                      ? "A GPU is available — much faster."
                      : "No CUDA GPU detected; CPU separation takes minutes per track."}
                  </span>
                </label>

                {opts.device !== "cuda" && (
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium">Parallel jobs</span>
                    <input
                      type="number"
                      min={1}
                      max={16}
                      className={cn(inputClass, "w-full")}
                      value={opts.jobs}
                      disabled={running}
                      onChange={(e) => set("jobs", Math.max(1, Math.min(16, Number(e.target.value) || 1)))}
                    />
                    <span className="mt-1 block text-[10px] text-muted-foreground">
                      Uses more cores and more RAM. Ignored on GPU.
                    </span>
                  </label>
                )}
              </div>

              <div>
                <span className="mb-1 block text-xs font-medium">Output folder</span>
                <div className="flex gap-2">
                  <input
                    className={cn(inputClass, "flex-1")}
                    value={opts.outputDir}
                    disabled={running}
                    placeholder="A “stems” folder beside each track"
                    onChange={(e) => set("outputDir", e.target.value)}
                  />
                  <Button variant="secondary" size="sm" onClick={pickOutput} disabled={running}>
                    <FolderOpen />
                    Browse
                  </Button>
                  {opts.outputDir && (
                    <Button variant="ghost" size="sm" onClick={() => set("outputDir", "")} disabled={running}>
                      Reset
                    </Button>
                  )}
                </div>
                <span className="mt-1 block text-[10px] text-muted-foreground">
                  Demucs writes to <span className="font-mono">{"<folder>/<model>/<track>/<stem>"}</span>.
                </span>
              </div>

              <p className="rounded-md bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
                Estimated time: <span className="font-medium text-foreground">{estimate}</span> for{" "}
                {paths.length} track{paths.length === 1 ? "" : "s"}. The first run with a new model
                also downloads its weights (a few hundred MB).
              </p>
            </div>
          )}
        </div>

        {running && (
          <div className="border-t px-5 py-3">
            <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
              <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-1 truncate text-[10px] text-muted-foreground" title={logLine}>
              {progress ? `${progress.done} / ${progress.total}` : ""}
              {progress?.file ? ` — ${basename(progress.file)}` : ""}
              {logLine ? ` · ${logLine}` : ""}
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2 border-t px-5 py-3">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={running}>
            {results ? "Close" : "Cancel"}
          </Button>
          {!results && (
            <Button size="sm" onClick={run} disabled={running || paths.length === 0}>
              {running ? <Loader2 className="animate-spin" /> : <Play />}
              {running ? "Separating…" : "Separate"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
