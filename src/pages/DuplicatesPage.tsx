import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { Notify } from "../hooks/useFiles";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, Copy, Loader2, Play, Square, Trash2 } from "lucide-react";
import type { AudioFile, DuplicateGroup, TagData } from "../types";
import { formatBytes } from "../types";
import { Button, Card, cn } from "../components/ui";
import { Waveform } from "../components/Waveform";
import { formatDuration, releasePlayback, takeOverPlayback } from "../components/AudioPreview";

type RowState = "keep" | "remove" | "skip";

const LOSSLESS = new Set(["flac", "wav", "aiff", "aif"]);
const COMPLETENESS_FIELDS: (keyof TagData)[] = [
  "title",
  "artist",
  "album",
  "albumArtist",
  "year",
  "genre",
  "trackNumber",
];

function tagCompleteness(t?: TagData): number {
  if (!t) return 0;
  const filled = COMPLETENESS_FIELDS.filter((k) => {
    const v = t[k];
    return typeof v === "string" && v.trim().length > 0;
  }).length;
  return filled + (t.hasCoverArt ? 1 : 0);
}

/** Highest quality → most complete tags → shortest/first path as a
 * deterministic tie-break (a true "oldest file" tie-break would need file
 * mtime surfaced to the frontend, which isn't wired up here). */
function suggestKeeper(paths: string[], files: Record<string, AudioFile>, tags: Record<string, TagData>): string {
  return [...paths].sort((a, b) => {
    const fa = files[a];
    const fb = files[b];
    const rankA = fa && LOSSLESS.has(fa.format.toLowerCase()) ? 1 : 0;
    const rankB = fb && LOSSLESS.has(fb.format.toLowerCase()) ? 1 : 0;
    if (rankA !== rankB) return rankB - rankA;
    const brA = fa?.bitrateKbps ?? 0;
    const brB = fb?.bitrateKbps ?? 0;
    if (brA !== brB) return brB - brA;
    const tagA = tagCompleteness(tags[a]);
    const tagB = tagCompleteness(tags[b]);
    if (tagA !== tagB) return tagB - tagA;
    return a.localeCompare(b);
  })[0];
}

function fileFacts(f: AudioFile | undefined, t: TagData | undefined): string {
  if (!f) return "file no longer loaded";
  const parts = [
    f.format.toUpperCase(),
    f.bitrateKbps ? `${f.bitrateKbps}kbps` : null,
    f.sampleRateHz ? `${(f.sampleRateHz / 1000).toFixed(1)}kHz` : null,
    f.durationSecs ? `${Math.round(f.durationSecs)}s` : null,
    formatBytes(f.size),
    t?.hasCoverArt ? "has artwork" : "no artwork",
    `${tagCompleteness(t)}/${COMPLETENESS_FIELDS.length + 1} tags filled`,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function DuplicatesPage({
  files,
  tags,
  notify,
  onDelete,
  onInspect,
}: {
  files: AudioFile[];
  tags: Record<string, TagData>;
  notify: Notify;
  onDelete: (paths: string[]) => Promise<boolean>;
  onInspect: (path: string) => void;
}) {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; phase: string } | null>(null);
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});

  const fileByPath = Object.fromEntries(files.map((f) => [f.path, f]));

  // One shared <audio> for the whole page: groups can hold hundreds of rows, so
  // an element per row (what <AudioPreview> does) is off the table.
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playingPath, setPlayingPath] = useState<string | null>(null);
  const [lastPath, setLastPath] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);

  // Stable identity on purpose: takeOverPlayback() compares stop functions by
  // reference to decide whether the "active" player is someone else.
  const stopPlayback = useCallback(() => {
    const el = audioRef.current;
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
    setPlayingPath(null);
    setTime(0);
  }, []);

  /** Release the webview's handle on the file (a playing/loaded file can't be
   * recycled cleanly on Windows). Same reason App.tsx does it for Genre Mode. */
  const unloadAudio = useCallback(() => {
    stopPlayback();
    const el = audioRef.current;
    if (el) {
      el.removeAttribute("src");
      el.load();
    }
  }, [stopPlayback]);

  useEffect(() => {
    const el = audioRef.current;
    return () => {
      if (el) {
        el.pause();
        el.removeAttribute("src");
      }
      releasePlayback(stopPlayback);
    };
  }, [stopPlayback]);

  const playAt = (path: string, fraction?: number) => {
    const el = audioRef.current;
    if (!el) return;
    const url = convertFileSrc(path);
    if (el.src !== url) {
      el.src = url;
      setTime(0);
      setDur(fileByPath[path]?.durationSecs ?? 0);
    }
    // Prefer the already-known duration so the seek needs no metadata wait;
    // a currentTime set before metadata loads is queued by the webview.
    const d = fileByPath[path]?.durationSecs || (Number.isFinite(el.duration) ? el.duration : 0);
    if (fraction != null && d) {
      el.currentTime = fraction * d;
      setTime(fraction * d);
    }
    takeOverPlayback(stopPlayback);
    el.play().catch(() => {});
    setPlayingPath(path);
    setLastPath(path);
  };

  // Space toggles the row that last played (not while typing / on a button).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !lastPath) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, button, [contenteditable]") || t.isContentEditable)) return;
      e.preventDefault();
      if (playingPath) stopPlayback();
      else playAt(lastPath);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const scan = async () => {
    if (!files.length) return notify("No files loaded — select a folder in Library first", "info");
    setScanning(true);
    setProgress({ done: 0, total: files.length, phase: "fingerprinting" });
    const unlisten = await listen<{ done: number; total: number; phase: string }>(
      "duplicate-scan-progress",
      (e) => setProgress(e.payload),
    );
    try {
      const result = await invoke<DuplicateGroup[]>("scan_duplicates", {
        paths: files.map((f) => f.path),
      });
      unloadAudio();
      setGroups(result);
      // Pre-select: keep the suggested keeper, remove everything else in
      // "duplicate" groups; "alternate" groups default to Skip (never
      // auto-suggested for deletion — different edits, not duplicates).
      const initial: Record<string, RowState> = {};
      for (const g of result) {
        const keeper = suggestKeeper(g.paths, fileByPath, tags);
        for (const p of g.paths) {
          initial[p] = g.kind === "alternate" ? "skip" : p === keeper ? "keep" : "remove";
        }
      }
      setRowStates(initial);
      if (!result.length) notify("No duplicates found", "success");
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setScanning(false);
      setProgress(null);
      unlisten();
    }
  };

  const playDur = dur || (playingPath ? fileByPath[playingPath]?.durationSecs ?? 0 : 0);

  const toRemove = Object.entries(rowStates)
    .filter(([, s]) => s === "remove")
    .map(([p]) => p);
  const removeBytes = toRemove.reduce((sum, p) => sum + (fileByPath[p]?.size ?? 0), 0);

  const runDelete = async () => {
    if (playingPath && toRemove.includes(playingPath)) unloadAudio();
    const ok = await onDelete(toRemove);
    if (ok) {
      setGroups(
        (prev) =>
          prev
            ?.map((g) => ({ ...g, paths: g.paths.filter((p) => !toRemove.includes(p)) }))
            .filter((g) => g.paths.length > 1) ?? null,
      );
      setRowStates((prev) => {
        const next = { ...prev };
        for (const p of toRemove) delete next[p];
        return next;
      });
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <audio
        ref={audioRef}
        preload="none"
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
        onEnded={stopPlayback}
      />
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-bold">Duplicates</h1>
          <p className="text-sm text-muted-foreground">
            Find duplicate tracks by audio content, not just file name — {files.length} loaded track
            {files.length === 1 ? "" : "s"}
          </p>
        </div>
        <Button variant="secondary" onClick={scan} disabled={scanning || !files.length}>
          {scanning ? <Loader2 className="animate-spin" /> : <Copy />}
          {scanning ? "Scanning…" : "Scan for Duplicates"}
        </Button>
      </div>

      {scanning && progress && (
        <div className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 text-sm">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
          <span className="flex-1">
            {progress.phase === "fingerprinting" ? "Fingerprinting" : "Comparing"} {progress.done} of{" "}
            {progress.total}
          </span>
          <div className="h-1.5 w-40 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
            />
          </div>
        </div>
      )}

      {groups === null ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Scan the loaded collection to find duplicate and alternate-version tracks.
        </div>
      ) : groups.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          No duplicates found in the loaded collection.
        </div>
      ) : (
        <>
          <div className="flex-1 space-y-4 overflow-y-auto pr-1">
            {groups.map((g) => (
              <Card key={g.id} className="p-4">
                <div className="mb-2 flex items-center gap-2">
                  {g.kind === "alternate" ? (
                    <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
                  ) : (
                    <Copy className="h-4 w-4 shrink-0 text-primary" />
                  )}
                  <span className="text-sm font-semibold">
                    {g.kind === "alternate" ? "Alternate versions" : "Duplicate"} — {g.paths.length} files
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {g.kind === "alternate" ? "different edit — never auto-suggested for removal" : `match score ${g.score.toFixed(1)}`}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {g.paths.map((p) => {
                    const f = fileByPath[p];
                    const state = rowStates[p] ?? "skip";
                    return (
                      <div key={p} className="rounded-md px-2 py-1.5 hover:bg-accent/40">
                        <div className="flex items-center gap-2">
                          <button
                            className="min-w-0 flex-1 truncate text-left text-sm"
                            onClick={() => onInspect(p)}
                            title={p}
                          >
                            {f?.filename ?? p}
                            <span className="ml-2 text-xs text-muted-foreground">{fileFacts(f, tags[p])}</span>
                          </button>
                          <div className="flex shrink-0 gap-1">
                            {(["keep", "remove", "skip"] as const).map((s) => (
                              <button
                                key={s}
                                onClick={() => setRowStates((prev) => ({ ...prev, [p]: s }))}
                                className={cn(
                                  "rounded-md border px-2 py-1 text-xs font-medium capitalize",
                                  state === s
                                    ? s === "remove"
                                      ? "border-destructive bg-destructive text-destructive-foreground"
                                      : "border-primary bg-primary text-primary-foreground"
                                    : "border-input bg-background text-muted-foreground hover:bg-accent",
                                )}
                              >
                                {s}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                          <button
                            onClick={() => (playingPath === p ? stopPlayback() : playAt(p, undefined))}
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-input bg-background text-muted-foreground hover:bg-accent"
                            title={playingPath === p ? "Stop" : "Play"}
                          >
                            {playingPath === p ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                          </button>
                          <Waveform
                            path={p}
                            height={32}
                            className="min-w-0 flex-1"
                            onSeek={(fr) => playAt(p, fr)}
                            progress={playingPath === p && playDur ? time / playDur : undefined}
                          />
                          {playingPath === p && (
                            <span className="w-20 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                              {formatDuration(time)} / {formatDuration(playDur)}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            ))}
          </div>

          <div className="flex items-center justify-between rounded-lg border bg-card px-4 py-3">
            <span className="text-sm text-muted-foreground">
              {toRemove.length} file{toRemove.length === 1 ? "" : "s"} marked for removal
              {toRemove.length > 0 && ` (${formatBytes(removeBytes)})`}
            </span>
            <Button variant="destructive" onClick={runDelete} disabled={toRemove.length === 0}>
              <Trash2 />
              Remove {toRemove.length || ""} to Recycle Bin
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
