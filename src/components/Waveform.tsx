import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2 } from "lucide-react";
import type { CueData, CuePoint, LoopPoint } from "../types";
import { cn } from "./ui";

/** Rekordbox's default hot cue colors (pad 1-8), used when a cue has no
 * explicit color in the XML — matches what Rekordbox itself shows. */
const DEFAULT_HOT_CUE_COLORS = [
  "#ff2eb6", "#ff6600", "#ffcc00", "#4dff4d",
  "#00ccff", "#3366ff", "#9933ff", "#ff3333",
];

function cueColor(cue: CuePoint | LoopPoint, index: number): string {
  if (cue.color) {
    const [r, g, b] = cue.color;
    return `rgb(${r}, ${g}, ${b})`;
  }
  if (cue.pad != null) return DEFAULT_HOT_CUE_COLORS[cue.pad % DEFAULT_HOT_CUE_COLORS.length];
  return index === 0 ? "#4dff4d" : "#e0e0e0"; // memory cues: first one greenish, rest neutral
}

const cache: Record<string, number[]> = {};

/**
 * A track's waveform (peak amplitude per bucket, 0-1), fetched via the
 * `get_waveform` command (full-file decode, cached in the same sqlite
 * database the duplicate-detection fingerprint cache uses — see
 * duplicates.rs). Cached in memory per path for the life of the page so
 * switching between already-seen tracks (e.g. Genre Mode navigation) is instant.
 *
 * `progress` (0-1, optional) draws a playhead line — used by the Genre Mode
 * strip to show where playback currently is.
 */
export function Waveform({
  path,
  height = 32,
  progress,
  className,
  cues,
  durationSecs,
}: {
  path: string;
  height?: number;
  progress?: number;
  className?: string;
  /** Rekordbox cues/loops for this track (see `get_cues_for_path`), drawn as
   * an overlay on top of the waveform. Requires `durationSecs` to position
   * them — without it, cues are silently skipped. */
  cues?: CueData | null;
  durationSecs?: number;
}) {
  const [peaks, setPeaks] = useState<number[] | null>(cache[path] ?? null);

  useEffect(() => {
    if (cache[path]) {
      setPeaks(cache[path]);
      return;
    }
    let cancelled = false;
    setPeaks(null);
    invoke<number[]>("get_waveform", { path })
      .then((p) => {
        cache[path] = p;
        if (!cancelled) setPeaks(p);
      })
      .catch(() => {
        if (!cancelled) setPeaks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (peaks === null) {
    return (
      <div
        className={cn("flex items-center justify-center text-muted-foreground", className)}
        style={{ height }}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
      </div>
    );
  }
  if (peaks.length === 0) {
    return (
      <div
        className={cn("flex items-center justify-center text-xs text-muted-foreground", className)}
        style={{ height }}
      >
        No waveform
      </div>
    );
  }

  const n = peaks.length;
  return (
    <svg
      viewBox={`0 0 ${n} 100`}
      preserveAspectRatio="none"
      className={cn("block w-full", className)}
      style={{ height }}
    >
      {peaks.map((p, i) => {
        const barHeight = Math.max(2, p * 98);
        return (
          <rect
            key={i}
            x={i}
            y={(100 - barHeight) / 2}
            width={1}
            height={barHeight}
            className="fill-primary/60"
          />
        );
      })}
      {cues && durationSecs && durationSecs > 0 && (
        <>
          {cues.loops.map((loop, i) => {
            const x0 = (loop.startSecs / durationSecs) * n;
            const x1 = (loop.endSecs / durationSecs) * n;
            const color = cueColor(loop, i);
            return (
              <rect
                key={`loop-${i}`}
                x={Math.min(x0, x1)}
                y={0}
                width={Math.max(0.5, Math.abs(x1 - x0))}
                height={100}
                fill={color}
                opacity={0.22}
              >
                <title>{loop.name || `Loop ${i + 1}`}</title>
              </rect>
            );
          })}
          {cues.memoryCues.map((cue, i) => {
            const x = (cue.positionSecs / durationSecs) * n;
            const color = cueColor(cue, i);
            return (
              <rect key={`mem-${i}`} x={x} y={0} width={Math.max(0.5, n * 0.0025)} height={100} fill={color}>
                <title>{cue.name || `Memory Cue ${i + 1}`}</title>
              </rect>
            );
          })}
          {cues.hotCues.map((cue, i) => {
            const x = (cue.positionSecs / durationSecs) * n;
            const color = cueColor(cue, i);
            return (
              <g key={`hot-${i}`}>
                <rect x={x} y={0} width={Math.max(0.6, n * 0.003)} height={100} fill={color}>
                  <title>{cue.name || `Hot Cue ${(cue.pad ?? i) + 1}`}</title>
                </rect>
                <rect x={x} y={0} width={Math.max(2.5, n * 0.01)} height={10} fill={color} />
              </g>
            );
          })}
        </>
      )}
      {progress !== undefined && progress >= 0 && progress <= 1 && (
        <rect x={progress * n} y={0} width={Math.max(0.6, n * 0.003)} height={100} className="fill-primary" />
      )}
    </svg>
  );
}
