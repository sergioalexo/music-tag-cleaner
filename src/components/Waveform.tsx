import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2 } from "lucide-react";
import { cn } from "./ui";

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
}: {
  path: string;
  height?: number;
  progress?: number;
  className?: string;
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
      {progress !== undefined && progress >= 0 && progress <= 1 && (
        <rect x={progress * n} y={0} width={Math.max(0.6, n * 0.003)} height={100} className="fill-primary" />
      )}
    </svg>
  );
}
