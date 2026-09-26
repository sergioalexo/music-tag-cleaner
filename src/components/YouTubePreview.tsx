import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Loader2, Pause, Play } from "lucide-react";
import { cn } from "./ui";
import { formatDuration, releasePlayback, takeOverPlayback } from "./AudioPreview";

/**
 * Prelisten for a YouTube-import playlist row, the same shape as
 * `AudioPreview`'s local-file prelisten (play/pause + a scrub bar), but
 * playing the actual YouTube video instead of a file on disk.
 *
 * Built on the YouTube IFrame Player API, loaded lazily — once for the
 * whole app, and per-row only when that row's Play button is actually
 * pressed. The matcher list can show hundreds of rows at once, so creating
 * an embedded player for all of them up front (the same mistake the local
 * `AudioPreview` used to make with `preload="metadata"`) would be exactly
 * the kind of freeze this app has already been burned by once.
 *
 * Some videos refuse to play outside youtube.com (the uploader disabled
 * embedding, or it's age/region restricted) — the IFrame API reports that
 * as an error code, not a slow failure, so this falls back to opening the
 * video in the browser instead of showing a dead play button.
 */

// --- Minimal ambient types for the bits of the IFrame API actually used.
// There's no bundled @types/youtube in this project, and pulling in a
// dependency for four method signatures isn't worth it.
interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  destroy(): void;
}
interface YTPlayerEvent {
  data: number;
  target: YTPlayer;
}
interface YTNamespace {
  Player: new (
    el: HTMLElement | string,
    opts: {
      videoId: string;
      width: string | number;
      height: string | number;
      playerVars?: Record<string, number | string>;
      events?: {
        onReady?: (e: YTPlayerEvent) => void;
        onError?: (e: { data: number }) => void;
        onStateChange?: (e: YTPlayerEvent) => void;
      };
    },
  ) => YTPlayer;
  PlayerState: { PLAYING: number; PAUSED: number; ENDED: number };
}
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

// Loaded once and shared by every instance — the script tag itself, and the
// single global `onYouTubeIframeAPIReady` callback it calls when ready.
let apiPromise: Promise<YTNamespace> | null = null;
function loadYouTubeApi(): Promise<YTNamespace> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve) => {
    if (window.YT?.Player) {
      resolve(window.YT);
      return;
    }
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT!);
    };
    if (!document.getElementById("youtube-iframe-api")) {
      const script = document.createElement("script");
      script.id = "youtube-iframe-api";
      script.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(script);
    }
  });
  return apiPromise;
}

let mountSeq = 0;

type Status = "idle" | "loading" | "ready" | "unavailable";

export function YouTubePreview({
  videoId,
  url,
  durationSecs,
}: {
  videoId: string;
  url: string;
  /** The video's length from the playlist fetch, if yt-dlp reported one —
   * sizes the bar before the embedded player has loaded, exactly like
   * `AudioPreview`'s `durationSecs` hint. */
  durationSecs?: number | null;
}) {
  const mountId = useRef(`yt-preview-${++mountSeq}`).current;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const pollRef = useRef<number | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [loadedDuration, setLoadedDuration] = useState(0);
  const duration = loadedDuration || durationSecs || 0;
  /** A scrub before the player exists yet — applied once `onReady` fires. */
  const pendingSeekRef = useRef<number | null>(null);

  const stopPolling = () => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const pause = () => {
    try {
      playerRef.current?.pauseVideo();
    } catch {
      // Player may already be torn down.
    }
    setPlaying(false);
    stopPolling();
  };

  // Reset per-video and tear the player down whenever the row switches to a
  // different video (candidate cycling reuses this component the same way
  // AudioPreview's does).
  useEffect(() => {
    setStatus("idle");
    setPlaying(false);
    setTime(0);
    setLoadedDuration(0);
    pendingSeekRef.current = null;
    return () => {
      stopPolling();
      try {
        playerRef.current?.destroy();
      } catch {
        // Already gone.
      }
      playerRef.current = null;
      releasePlayback(pause);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  const openInBrowser = () => void openUrl(url);

  const createPlayer = async () => {
    setStatus("loading");
    const YT = await loadYouTubeApi();
    const host = hostRef.current;
    if (!host) return;
    const player = new YT.Player(host, {
      videoId,
      width: "1",
      height: "1",
      playerVars: { controls: 0, disablekb: 1, modestbranding: 1, playsinline: 1, origin: window.location.origin },
      events: {
        onReady: (e) => {
          setLoadedDuration(e.target.getDuration() || 0);
          setStatus("ready");
          takeOverPlayback(pause);
          if (pendingSeekRef.current !== null) {
            e.target.seekTo(pendingSeekRef.current, true);
            pendingSeekRef.current = null;
          }
          e.target.playVideo();
        },
        onError: () => {
          // 2 invalid id, 5 HTML5 player error, 100 not found/private,
          // 101/150 embedding disabled by the uploader — all dead ends for
          // an embedded player, so fall back to the real thing.
          setStatus("unavailable");
          openInBrowser();
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.PLAYING) {
            setPlaying(true);
            stopPolling();
            pollRef.current = window.setInterval(() => {
              setTime(playerRef.current?.getCurrentTime() ?? 0);
            }, 400);
          } else {
            setPlaying(false);
            stopPolling();
            if (e.data === YT.PlayerState.ENDED) setTime(0);
          }
        },
      },
    });
    playerRef.current = player;
  };

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (status === "unavailable") {
      openInBrowser();
      return;
    }
    if (playing) {
      pause();
      return;
    }
    if (status === "idle") {
      void createPlayer();
      return;
    }
    takeOverPlayback(pause);
    try {
      playerRef.current?.playVideo();
    } catch {
      setStatus("unavailable");
      openInBrowser();
    }
  };

  const seek = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    const seconds = Number(e.target.value);
    setTime(seconds);
    if (status === "idle") {
      // No player yet — create one and apply this scrub once it's ready,
      // the same lazy-load-on-first-touch behavior as the play button.
      pendingSeekRef.current = seconds;
      void createPlayer();
      return;
    }
    try {
      playerRef.current?.seekTo(seconds, true);
      if (!playing) {
        takeOverPlayback(pause);
        playerRef.current?.playVideo();
      }
    } catch {
      // No player yet — nothing to scrub.
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      {/* The IFrame API needs a real element to mount into, but nothing
          about this preview is meant to be looked at — it's 1x1 and hidden. */}
      <div ref={hostRef} id={mountId} className="h-0 w-0 overflow-hidden" aria-hidden />
      <button
        onClick={toggle}
        disabled={status === "loading"}
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
          playing ? "bg-primary text-primary-foreground" : "bg-secondary hover:bg-accent",
        )}
        title={
          status === "unavailable"
            ? "This video can't play outside YouTube — opening it in your browser"
            : playing
              ? "Pause"
              : "Prelisten on YouTube"
        }
      >
        {status === "loading" ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : status === "unavailable" ? (
          <ExternalLink className="h-3 w-3" />
        ) : playing ? (
          <Pause className="h-3 w-3" />
        ) : (
          <Play className="h-3 w-3" />
        )}
      </button>
      {/*
        The bar is always shown, exactly like the local-file AudioPreview —
        sized from `durationSecs` (yt-dlp's reported length) before the
        embedded player has even been created, so it looks and behaves like
        every other row instead of only growing in once you've pressed Play.
        Disabled until there's a duration to scrub against (a handful of
        entries have none). Fixed (not flex-1) width on purpose: this
        preview sits as a plain flex item next to the row's title/artist
        text, which is what shrinks to make room.
      */}
      <input
        type="range"
        min={0}
        max={duration || 0}
        step={0.1}
        value={time}
        onChange={seek}
        onMouseDown={(e) => e.stopPropagation()}
        disabled={!duration || status === "unavailable"}
        className="h-1 w-16 shrink-0 cursor-pointer accent-[var(--primary)] disabled:opacity-40"
        title="Scrub — click to play from here"
      />
      <span className="w-9 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
        {formatDuration(duration)}
      </span>
    </div>
  );
}
