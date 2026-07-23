import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Pause, Play } from "lucide-react";
import { cn } from "./ui";

// Only one preview plays at a time across the whole table.
let stopOthers: (() => void) | null = null;

/** Inline prelisten: play/pause plus a scrub bar to rewind through the track. */
export function AudioPreview({ path }: { path: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    return () => {
      if (audioRef.current) audioRef.current.pause();
      if (stopOthers === pause) stopOthers = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pause = () => {
    audioRef.current?.pause();
    setPlaying(false);
  };

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      pause();
      return;
    }
    if (!ready) {
      el.src = convertFileSrc(path);
      setReady(true);
    }
    if (stopOthers && stopOthers !== pause) stopOthers();
    stopOthers = pause;
    void el.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  };

  const seek = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = Number(e.target.value);
    setTime(el.currentTime);
  };

  return (
    <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <audio
        ref={audioRef}
        preload="none"
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onEnded={() => {
          setPlaying(false);
          setTime(0);
        }}
      />
      <button
        onClick={toggle}
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
          playing ? "bg-primary text-primary-foreground" : "bg-secondary hover:bg-accent",
        )}
        title={playing ? "Pause" : "Prelisten"}
      >
        {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
      </button>
      <input
        type="range"
        min={0}
        max={duration || 0}
        step={0.1}
        value={time}
        onChange={seek}
        onMouseDown={(e) => e.stopPropagation()}
        disabled={!ready || !duration}
        className="h-1 flex-1 cursor-pointer accent-[var(--primary)] disabled:opacity-40"
        title="Scrub"
      />
    </div>
  );
}
