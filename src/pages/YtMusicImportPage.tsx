import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Download,
  ExternalLink,
  FileJson,
  Link2,
  ListMusic,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type {
  AudioFile,
  ImportSession,
  ImportSessionSummary,
  PlaylistEntry,
  PlaylistFetchResult,
  TagData,
  YtDlpInfo,
} from "../types";
import { AudioPreview } from "../components/AudioPreview";
import {
  AMBIGUOUS_THRESHOLD,
  buildWanted,
  CONFIDENT_THRESHOLD,
  matchPlaylist,
  type EntryMatch,
  type MatchCandidate,
} from "../lib/ytMatch";
import { buildMatchLog, matchLogToMarkdown, type DecisionState } from "../lib/ytMatchLog";
import { buildM3u8, buildRekordboxPlaylistXml } from "../lib/rekordboxExport";
import { Button, Card, CardHeader, cn } from "../components/ui";
import { Combobox } from "../components/Combobox";
import { LibrarySearchPanel } from "../components/LibrarySearchPanel";

function sanitizeFilenamePart(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, " ").trim() || "playlist";
}

/**
 * Everything about one import run that is worth surviving the app closing.
 *
 * Matching a playlist is rarely a single sitting: you match what you own, go
 * and buy the rest, and come back days later to re-fetch. Without this, that
 * second pass starts from nothing — every confirmation and, worse, every
 * *denial* is lost, so the matcher cheerfully re-proposes exactly the matches
 * already rejected.
 *
 * Decisions are keyed by video id, never by position, so they survive the
 * playlist gaining, losing or reordering tracks, and they survive the library
 * growing — which is the whole reason to come back.
 */
interface SessionPayload {
  version: 1;
  entries: PlaylistEntry[];
  overrides: Record<string, string>;
  denied: Record<string, string[]>;
  candIndex: Record<string, number>;
  fromSearch: Record<string, boolean>;
}

/**
 * Stable identity for a playlist. The `list=` id is the same across
 * `music.youtube.com` and `youtube.com` and survives extra query params, so
 * a session saved from one link is found again from the other.
 */
export function sessionKeyFor(url: string): string {
  const m = url.match(/[?&]list=([^&]+)/i);
  if (m) return `list:${m[1]}`;
  const v = url.match(/[?&]v=([^&]+)/i);
  if (v) return `video:${v[1]}`;
  return `url:${url.trim()}`;
}

type EffectiveStatus = "matched" | "ambiguous" | "missing";

function StatusBadge({ status, score }: { status: EffectiveStatus; score?: number }) {
  if (status === "matched") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary"
        title={score !== undefined ? `Match confidence ${(score * 100).toFixed(0)}%` : undefined}
      >
        <Check className="h-3 w-3" /> Matched
      </span>
    );
  }
  if (status === "ambiguous") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
        title={score !== undefined ? `Only ${(score * 100).toFixed(0)}% sure — confirm or deny` : undefined}
      >
        <AlertTriangle className="h-3 w-3" /> Confirm
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      Missing
    </span>
  );
}

export function YtMusicImportPage({
  files,
  tags,
  indexedCount,
  notify,
  onInspect,
}: {
  /** The whole collection: indexed tracks plus this session's loaded files. */
  files: AudioFile[];
  tags: Record<string, TagData>;
  /** How many of `files` came from the index, for the "index your library" hint. */
  indexedCount: number;
  notify: (message: string, kind?: "success" | "error" | "info") => void;
  onInspect: (path: string) => void;
}) {
  const [ytdlp, setYtdlp] = useState<YtDlpInfo | null>(null);
  const [checkingYtdlp, setCheckingYtdlp] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState<{ downloaded: number; total: number } | null>(null);

  const [url, setUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [playlist, setPlaylist] = useState<PlaylistFetchResult | null>(null);
  const [fetchedUrl, setFetchedUrl] = useState("");
  const [matches, setMatches] = useState<EntryMatch[] | null>(null);
  const [exporting, setExporting] = useState(false);

  // --- User decisions, kept separate from the matcher's own output so
  // "reset" can always fall back to what the matcher originally proposed.
  /** videoId -> chosen path; "" means explicitly marked missing. */
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  /** videoId -> candidate paths the user rejected with the deny button. */
  const [denied, setDenied] = useState<Record<string, string[]>>({});
  /** videoId -> which of the surviving candidates is currently shown. */
  const [candIndex, setCandIndex] = useState<Record<string, number>>({});
  /** videoIds whose match was picked by hand in the search dock. */
  const [fromSearch, setFromSearch] = useState<Record<string, boolean>>({});
  const [focusedId, setFocusedId] = useState<string | null>(null);
  /** The saved session this run was resumed from, if any. */
  const [resumedFrom, setResumedFrom] = useState<ImportSession | null>(null);
  const [rematching, setRematching] = useState(false);

  // --- Bottom library-search dock.
  const [panelHeight, setPanelHeight] = useState(180);
  const [panelCollapsed, setPanelCollapsed] = useState(false);

  const fileByPath = useMemo(() => Object.fromEntries(files.map((f) => [f.path, f])), [files]);

  /** A library path split into the two lines the UI shows for it. */
  const trackLabel = useMemo(() => {
    return (p: string): { title: string; artist: string } => {
      const t = tags[p];
      const f = fileByPath[p];
      return {
        title: t?.title?.trim() || f?.filename || p,
        artist: t?.artist?.trim() || "",
      };
    };
  }, [tags, fileByPath]);

  const flatLabel = useMemo(() => {
    return (p: string) => {
      const l = trackLabel(p);
      return l.artist ? `${l.artist} - ${l.title}` : l.title;
    };
  }, [trackLabel]);

  const allLabels = useMemo(() => files.map((f) => flatLabel(f.path)), [files, flatLabel]);
  const labelToPath = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of files) m.set(flatLabel(f.path), f.path);
    return m;
  }, [files, flatLabel]);

  /**
   * Restores the most recent import session when the page mounts.
   *
   * Page state is component-local, so switching to Settings — which is
   * exactly where you go to index your library mid-session — used to throw
   * the fetched playlist away and leave you re-pasting the URL. The saved
   * session already carries the entries, so this rebuilds the whole screen
   * with no network call at all; matching re-runs from the effect below.
   */
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    void (async () => {
      try {
        const sessions = await invoke<ImportSessionSummary[]>("list_import_sessions");
        const latest = sessions[0];
        if (!latest) return;
        const saved = await invoke<ImportSession | null>("load_import_session", {
          key: latest.key,
        });
        if (!saved) return;
        const payload = JSON.parse(saved.payload) as SessionPayload;
        if (!payload.entries?.length) return;
        setPlaylist({ title: saved.title, entries: payload.entries });
        setFetchedUrl(saved.url);
        setUrl(saved.url);
        setOverrides(payload.overrides ?? {});
        setDenied(payload.denied ?? {});
        setCandIndex(payload.candIndex ?? {});
        setFromSearch(payload.fromSearch ?? {});
        setResumedFrom(saved);
      } catch {
        // Nothing to restore is the normal case on a first run.
      }
    })();
  }, []);

  /**
   * Keeps the matches in step with whatever the playlist and the collection
   * currently are. Re-scoring never discards anything: every decision lives
   * in its own state, layered on top. So finishing an index (which grows
   * `files`) re-matches automatically, and the explicit Re-match button is
   * just a way to force it.
   */
  useEffect(() => {
    if (!playlist?.entries.length) {
      setMatches(null);
      return;
    }
    setMatches(matchPlaylist(playlist.entries, files, tags));
  }, [playlist, files, tags]);

  const refreshYtdlp = async () => {
    setCheckingYtdlp(true);
    try {
      setYtdlp(await invoke<YtDlpInfo>("ytdlp_info"));
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setCheckingYtdlp(false);
    }
  };

  useEffect(() => {
    refreshYtdlp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const installYtdlp = async () => {
    setInstalling(true);
    setInstallProgress(null);
    const unlisten = await listen<{ phase: string; downloaded: number; total: number }>(
      "ytdlp-install-progress",
      (e) => setInstallProgress(e.payload),
    );
    try {
      await invoke("install_ytdlp");
      notify("yt-dlp installed", "success");
      await refreshYtdlp();
    } catch (e) {
      notify(String(e), "error");
    } finally {
      unlisten();
      setInstalling(false);
      setInstallProgress(null);
    }
  };

  const fetchPlaylist = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setFetching(true);
    setPlaylist(null);
    setMatches(null);
    setResumedFrom(null);
    setOverrides({});
    setDenied({});
    setCandIndex({});
    setFromSearch({});
    try {
      const result = await invoke<PlaylistFetchResult>("fetch_ytmusic_playlist", { url: trimmed });
      setPlaylist(result);
      setFetchedUrl(trimmed);
      // Matching is driven by the effect above, so it happens here too.
      notify(`Fetched ${result.entries.length} track(s) from "${result.title}"`, "success");

      // Re-fetching a playlist that was matched before restores every
      // decision made last time. The matcher has just re-run against the
      // (possibly larger) collection, and these decisions are layered on
      // top — so newly-acquired tracks get matched while past confirmations
      // and denials stand.
      const saved = await invoke<ImportSession | null>("load_import_session", {
        key: sessionKeyFor(trimmed),
      });
      if (saved) {
        try {
          const payload = JSON.parse(saved.payload) as SessionPayload;
          setOverrides(payload.overrides ?? {});
          setDenied(payload.denied ?? {});
          setCandIndex(payload.candIndex ?? {});
          setFromSearch(payload.fromSearch ?? {});
          setResumedFrom(saved);
          const decided = Object.keys(payload.overrides ?? {}).length;
          notify(
            `Resumed ${decided} saved decision(s) from ${new Date(saved.savedAt * 1000).toLocaleDateString()}`,
            "info",
          );
        } catch {
          notify("A saved session for this playlist could not be read — starting fresh", "info");
        }
      }
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setFetching(false);
    }
  };

  // --- Resolution -----------------------------------------------------------
  // Candidates the user hasn't rejected, in matcher order.
  const liveCandidates = (m: EntryMatch): MatchCandidate[] => {
    const rejected = denied[m.entry.videoId];
    if (!rejected?.length) return m.candidates;
    return m.candidates.filter((c) => !rejected.includes(c.path));
  };

  /** The candidate currently on screen for an entry (not necessarily accepted). */
  const shownCandidate = (m: EntryMatch): MatchCandidate | null => {
    const live = liveCandidates(m);
    if (!live.length) return null;
    const i = Math.min(candIndex[m.entry.videoId] ?? 0, live.length - 1);
    return live[i] ?? null;
  };

  /**
   * An explicit override (including "" for "marked missing") always wins;
   * otherwise a confident candidate is taken as-is. An ambiguous one stays
   * unresolved until the user confirms it — the matcher never silently
   * accepts a match it isn't sure about.
   */
  const resolvedPath = (m: EntryMatch): string | null => {
    const override = overrides[m.entry.videoId];
    if (override !== undefined) return override || null;
    const shown = shownCandidate(m);
    return shown && shown.score >= CONFIDENT_THRESHOLD ? shown.path : null;
  };

  const effectiveStatus = (m: EntryMatch): EffectiveStatus => {
    if (resolvedPath(m)) return "matched";
    return shownCandidate(m) && overrides[m.entry.videoId] === undefined ? "ambiguous" : "missing";
  };

  const resolved = matches?.map((m) => ({ m, path: resolvedPath(m) })) ?? [];
  const matchedList = resolved.filter((r): r is { m: EntryMatch; path: string } => !!r.path);
  const missingList = resolved.filter((r) => !r.path);

  // --- Decision actions -----------------------------------------------------
  const setOverride = (videoId: string, path: string) =>
    setOverrides((prev) => ({ ...prev, [videoId]: path }));

  const confirmMatch = (m: EntryMatch) => {
    const shown = shownCandidate(m);
    if (shown) setOverride(m.entry.videoId, shown.path);
  };

  /** Rejects the candidate on screen. The next best takes its place; when
   * none is left the entry falls through to "missing", which is how the
   * deny button doubles as "this isn't in my collection". */
  const denyMatch = (m: EntryMatch) => {
    const shown = shownCandidate(m);
    if (!shown) return;
    const id = m.entry.videoId;
    setDenied((prev) => ({ ...prev, [id]: [...(prev[id] ?? []), shown.path] }));
    setCandIndex((prev) => ({ ...prev, [id]: 0 }));
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setFromSearch((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const skipEntry = (m: EntryMatch) => setOverride(m.entry.videoId, "");

  const cycleCandidate = (m: EntryMatch, delta: number) => {
    const live = liveCandidates(m);
    if (live.length < 2) return;
    const id = m.entry.videoId;
    const current = Math.min(candIndex[id] ?? 0, live.length - 1);
    const next = (current + delta + live.length) % live.length;
    setCandIndex((prev) => ({ ...prev, [id]: next }));
    // Stepping to an alternate is an explicit choice, so it replaces any
    // auto-acceptance — but it still needs confirming, exactly like an
    // ambiguous suggestion does.
    setOverrides((prev) => {
      const nextOv = { ...prev };
      delete nextOv[id];
      return nextOv;
    });
  };

  const resetEntry = (m: EntryMatch) => {
    const id = m.entry.videoId;
    const drop = <T,>(o: Record<string, T>) => {
      const next = { ...o };
      delete next[id];
      return next;
    };
    setOverrides(drop);
    setDenied(drop);
    setCandIndex(drop);
    setFromSearch(drop);
  };

  const assignFromSearch = (videoId: string, path: string) => {
    setOverride(videoId, path);
    setFromSearch((prev) => ({ ...prev, [videoId]: true }));
  };

  const touched = (videoId: string) =>
    overrides[videoId] !== undefined ||
    (denied[videoId]?.length ?? 0) > 0 ||
    (candIndex[videoId] ?? 0) !== 0;

  // --- Session persistence --------------------------------------------------
  const sessionKey = fetchedUrl ? sessionKeyFor(fetchedUrl) : null;

  const buildPayload = (): SessionPayload => ({
    version: 1,
    entries: playlist?.entries ?? [],
    overrides,
    denied,
    candIndex,
    fromSearch,
  });

  const persist = async (quiet: boolean) => {
    if (!sessionKey || !playlist) return;
    try {
      await invoke("save_import_session", {
        key: sessionKey,
        title: playlist.title,
        url: fetchedUrl,
        payload: JSON.stringify(buildPayload()),
      });
      if (!quiet) notify("Import session saved", "success");
    } catch (e) {
      if (!quiet) notify(String(e), "error");
    }
  };

  // Autosave, debounced: every decision is a keystroke-scale event and each
  // one is a sqlite write, so they are coalesced rather than written per
  // click. The explicit Save button exists for reassurance, not necessity.
  useEffect(() => {
    if (!sessionKey || !matches) return;
    const t = setTimeout(() => void persist(true), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrides, denied, candIndex, fromSearch, sessionKey, matches]);

  const forgetSession = async () => {
    if (!sessionKey) return;
    await invoke("delete_import_session", { key: sessionKey });
    setResumedFrom(null);
    setOverrides({});
    setDenied({});
    setCandIndex({});
    setFromSearch({});
    notify("Saved decisions for this playlist discarded", "info");
  };

  /**
   * Re-runs matching against the collection as it is *now*, keeping every
   * decision. This is the "I went and bought the missing ones" button: the
   * new files get matched, and nothing already settled moves.
   */
  const rematch = () => {
    if (!playlist) return;
    setRematching(true);
    try {
      setMatches(matchPlaylist(playlist.entries, files, tags));
      notify(`Re-matched against ${files.length} track(s) — your decisions were kept`, "success");
    } finally {
      setRematching(false);
    }
  };

  /** Clears the screen without touching the saved session. */
  const closePlaylist = () => {
    setPlaylist(null);
    setFetchedUrl("");
    setResumedFrom(null);
  };

  // --- Clipboard / export ---------------------------------------------------
  const copyMissingLinks = async () => {
    if (!missingList.length) return;
    await navigator.clipboard.writeText(missingList.map(({ m }) => m.entry.url).join("\n"));
    notify(`Copied ${missingList.length} link(s) to the clipboard`, "success");
  };

  const copyMissingTitles = async () => {
    if (!missingList.length) return;
    const text = missingList
      .map(({ m }) => {
        const w = buildWanted(m.entry);
        return w.artist ? `${w.artist} - ${w.title}` : w.title;
      })
      .join("\n");
    await navigator.clipboard.writeText(text);
    notify(`Copied ${missingList.length} title(s) to the clipboard`, "success");
  };

  const decisionState = (): DecisionState => ({ overrides, denied, fromSearch });

  const makeLog = () =>
    buildMatchLog(
      playlist?.title ?? "YouTube Music Import",
      fetchedUrl,
      matches ?? [],
      decisionState(),
      resolvedPath,
      flatLabel,
      files.length,
      AMBIGUOUS_THRESHOLD,
    );

  const copyMatchLog = async () => {
    if (!matches) return;
    await navigator.clipboard.writeText(JSON.stringify(makeLog(), null, 2));
    notify("Match log copied — paste it into an AI to tune the matcher", "success");
  };

  const saveMatchLog = async () => {
    if (!matches) return;
    const base = sanitizeFilenamePart(playlist?.title || "playlist");
    const dest = await saveDialog({
      title: "Save Match Log",
      defaultPath: `${base} - match log.json`,
      filters: [
        { name: "JSON (for feeding to an AI)", extensions: ["json"] },
        { name: "Markdown (to read)", extensions: ["md"] },
      ],
    });
    if (!dest) return;
    try {
      const log = makeLog();
      const contents = dest.toLowerCase().endsWith(".md")
        ? matchLogToMarkdown(log)
        : JSON.stringify(log, null, 2);
      await invoke("write_text_file", { path: dest, contents });
      notify(`Match log saved to ${dest}`, "success");
      await revealItemInDir(dest);
    } catch (e) {
      notify(String(e), "error");
    }
  };

  const runExport = async (kind: "m3u8" | "rekordbox") => {
    if (!matchedList.length) return;
    const base = sanitizeFilenamePart(playlist?.title || "playlist");
    const dest = await saveDialog({
      title: kind === "m3u8" ? "Export M3U8 Playlist" : "Export Rekordbox XML",
      defaultPath: kind === "m3u8" ? `${base}.m3u8` : `${base}.xml`,
      filters: [
        kind === "m3u8"
          ? { name: "M3U8 Playlist", extensions: ["m3u8"] }
          : { name: "Rekordbox XML", extensions: ["xml"] },
      ],
    });
    if (!dest) return;
    setExporting(true);
    try {
      const paths = matchedList.map((r) => r.path);
      const contents =
        kind === "m3u8"
          ? buildM3u8(paths, fileByPath, tags)
          : buildRekordboxPlaylistXml(playlist?.title || "YouTube Music Import", paths, fileByPath, tags);
      await invoke("write_text_file", { path: dest, contents });
      notify(`Exported ${paths.length} track(s) to ${dest}`, "success");
      await revealItemInDir(dest);
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
        <div>
          <h1 className="text-xl font-bold">YouTube Music Import</h1>
          <p className="text-sm text-muted-foreground">
            Paste a YouTube Music (or YouTube) playlist link, match it against your collection, and export a
            Rekordbox playlist — matching against {files.length} track{files.length === 1 ? "" : "s"}
            {indexedCount > 0 ? ` (${indexedCount} from your library index)` : ""}
          </p>
        </div>

        {!checkingYtdlp && !ytdlp?.installed && (
          <Card className="p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium">yt-dlp is required to fetch playlists</div>
                <p className="text-xs text-muted-foreground">
                  A one-time download (no installer, no PATH changes) — used only to read playlist metadata, never to
                  download audio.
                </p>
              </div>
              <Button size="sm" onClick={installYtdlp} disabled={installing}>
                {installing ? <Loader2 className="animate-spin" /> : <Download />}
                {installing ? "Installing…" : "Install yt-dlp"}
              </Button>
            </div>
            {installing && (
              <div className="mt-3">
                <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{
                      width:
                        installProgress && installProgress.total > 0
                          ? `${(installProgress.downloaded / installProgress.total) * 100}%`
                          : "15%",
                    }}
                  />
                </div>
              </div>
            )}
          </Card>
        )}

        <Card>
          <CardHeader title="Playlist" hint="A public YouTube Music or YouTube playlist URL" />
          <div className="flex gap-2 px-5 py-3">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && fetchPlaylist()}
              placeholder="https://music.youtube.com/playlist?list=…"
              className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <Button onClick={fetchPlaylist} disabled={fetching || !url.trim() || !ytdlp?.installed}>
              {fetching ? <Loader2 className="animate-spin" /> : <Search />}
              {fetching ? "Fetching…" : "Fetch Playlist"}
            </Button>
          </div>
        </Card>

        {matches && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm">
                <ListMusic className="h-4 w-4 text-primary" />
                <span className="font-semibold">{playlist?.title}</span>
                <span className="text-xs text-muted-foreground">
                  {matchedList.length} matched · {missingList.length} missing · {matches.length} total
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={rematch}
                  disabled={rematching}
                  title="Re-run matching against the collection as it is now, keeping every decision you've made"
                >
                  <RefreshCw className={rematching ? "animate-spin" : undefined} />
                  Re-match
                </Button>
                <Button variant="secondary" size="sm" onClick={() => void persist(false)}>
                  <Save />
                  Save Session
                </Button>
                <Button variant="secondary" size="sm" onClick={copyMatchLog}>
                  <ClipboardCopy />
                  Copy Match Log
                </Button>
                <Button variant="secondary" size="sm" onClick={saveMatchLog}>
                  <FileJson />
                  Save Match Log…
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => runExport("m3u8")}
                  disabled={!matchedList.length || exporting}
                >
                  <Download />
                  Export M3U8
                </Button>
                <Button size="sm" onClick={() => runExport("rekordbox")} disabled={!matchedList.length || exporting}>
                  <Download />
                  Export Rekordbox XML
                </Button>
              </div>
            </div>

            {resumedFrom && (
              <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
                <RotateCcw className="h-3.5 w-3.5 shrink-0 text-primary" />
                <span className="min-w-0 flex-1">
                  Resumed the decisions you saved on{" "}
                  {new Date(resumedFrom.savedAt * 1000).toLocaleString()}. Newly-acquired tracks
                  were matched on top — press <span className="font-medium">Re-match</span> after
                  indexing more music.
                </span>
                <button
                  onClick={closePlaylist}
                  className="flex shrink-0 items-center gap-1 text-muted-foreground hover:text-foreground"
                  title="Close this playlist — the saved decisions are kept"
                >
                  <X className="h-3.5 w-3.5" />
                  Close
                </button>
                <button
                  onClick={() => void forgetSession()}
                  className="flex shrink-0 items-center gap-1 text-muted-foreground hover:text-destructive"
                  title="Discard the saved decisions for this playlist"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Forget
                </button>
              </div>
            )}

            <Card className="p-2">
              <div className="space-y-1">
                {matches.map((m) => {
                  const id = m.entry.videoId;
                  const path = resolvedPath(m);
                  const status = effectiveStatus(m);
                  const shown = shownCandidate(m);
                  const live = liveCandidates(m);
                  const shownIndex = Math.min(candIndex[id] ?? 0, Math.max(0, live.length - 1));
                  const want = buildWanted(m.entry);
                  const displayPath = path ?? shown?.path ?? null;
                  const lib = displayPath ? trackLabel(displayPath) : null;

                  return (
                    <div
                      key={id}
                      onClick={() => setFocusedId(id)}
                      className={cn(
                        "flex items-center gap-3 rounded-md px-2 py-1.5",
                        focusedId === id ? "bg-accent/30" : "hover:bg-accent/20",
                      )}
                    >
                      <span className="w-6 shrink-0 text-right text-xs text-muted-foreground">
                        {m.entry.index + 1}
                      </span>

                      {/* What YouTube has — title on top, artist underneath. */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm" title={m.entry.title}>
                            {want.title}
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void openUrl(m.entry.url);
                            }}
                            className="shrink-0 text-muted-foreground hover:text-primary"
                            title="Open on YouTube Music"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </button>
                        </div>
                        <div className="truncate text-xs text-muted-foreground" title={want.artist ?? ""}>
                          {want.artist || "Unknown artist"}
                        </div>
                      </div>

                      {/* What it matched in the collection — same two lines, so
                          a long "Artist - Title" is readable instead of clipped. */}
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        {displayPath && lib ? (
                          <>
                            <AudioPreview path={displayPath} compact />
                            <button
                              className={cn(
                                "min-w-0 flex-1 text-left",
                                !path && "opacity-70",
                              )}
                              onClick={(e) => {
                                e.stopPropagation();
                                onInspect(displayPath);
                              }}
                              title={displayPath}
                            >
                              <div className="truncate text-xs hover:underline">{lib.title}</div>
                              <div className="truncate text-[10px] text-muted-foreground">
                                {lib.artist || "—"}
                                {shown && !path ? ` · ${(shown.score * 100).toFixed(0)}% · via ${shown.via}` : ""}
                              </div>
                            </button>
                          </>
                        ) : (
                          <span className="flex-1 text-xs text-muted-foreground">
                            Not found — pick one from the search below
                          </span>
                        )}
                        <StatusBadge status={status} score={shown?.score} />
                      </div>

                      <div className="flex w-[13.5rem] shrink-0 items-center justify-end gap-1">
                        {live.length > 1 && (
                          <span className="flex items-center text-muted-foreground">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                cycleCandidate(m, -1);
                              }}
                              className="rounded p-0.5 hover:bg-accent hover:text-foreground"
                              title="Previous candidate"
                            >
                              <ChevronLeft className="h-3.5 w-3.5" />
                            </button>
                            <span className="min-w-[2.2rem] text-center text-[10px] tabular-nums">
                              {shownIndex + 1}/{live.length}
                            </span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                cycleCandidate(m, 1);
                              }}
                              className="rounded p-0.5 hover:bg-accent hover:text-foreground"
                              title="Next candidate — other mixes and near-misses"
                            >
                              <ChevronRight className="h-3.5 w-3.5" />
                            </button>
                          </span>
                        )}

                        {shown && !path && (
                          <button
                            title="Confirm this match"
                            onClick={(e) => {
                              e.stopPropagation();
                              confirmMatch(m);
                            }}
                            className="rounded-md border border-primary bg-primary/10 p-1 text-primary hover:bg-primary/20"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </button>
                        )}

                        {shown && (
                          <button
                            title={
                              live.length > 1
                                ? "Deny this match — show the next candidate instead"
                                : "Deny this match — nothing else fits, so it becomes Missing"
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              denyMatch(m);
                            }}
                            className="rounded-md border border-input p-1 text-muted-foreground hover:border-destructive hover:text-destructive"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}

                        {overrides[id] !== "" && (
                          <button
                            title="Mark as missing — I don't have this one"
                            onClick={(e) => {
                              e.stopPropagation();
                              skipEntry(m);
                            }}
                            className="rounded-md border border-input p-1 text-muted-foreground hover:bg-accent"
                          >
                            <Ban className="h-3.5 w-3.5" />
                          </button>
                        )}

                        <Combobox
                          value=""
                          options={allLabels}
                          placeholder="Pick…"
                          className="w-20"
                          onChange={(label) => {
                            const p = labelToPath.get(label);
                            if (p) assignFromSearch(id, p);
                          }}
                          onClose={undefined}
                        />

                        {touched(id) && (
                          <button
                            title="Reset to the automatic match"
                            onClick={(e) => {
                              e.stopPropagation();
                              resetEntry(m);
                            }}
                            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>

            {missingList.length > 0 && (
              <Card>
                <CardHeader
                  title={`Still to get — ${missingList.length} track${missingList.length === 1 ? "" : "s"}`}
                  hint="Everything the collection doesn't have yet, with its link"
                />
                <div className="flex flex-wrap gap-2 px-5 pb-2 pt-1">
                  <Button variant="secondary" size="sm" onClick={copyMissingLinks}>
                    <Link2 />
                    Copy All Links ({missingList.length})
                  </Button>
                  <Button variant="secondary" size="sm" onClick={copyMissingTitles}>
                    <ClipboardCopy />
                    Copy Titles
                  </Button>
                </div>
                <div className="max-h-64 overflow-y-auto px-5 pb-4">
                  <ol className="space-y-0.5">
                    {missingList.map(({ m }) => {
                      const w = buildWanted(m.entry);
                      return (
                        <li key={m.entry.videoId} className="flex items-baseline gap-2 text-xs">
                          <span className="w-6 shrink-0 text-right text-muted-foreground">
                            {m.entry.index + 1}
                          </span>
                          <span className="min-w-0 flex-1 truncate" title={m.entry.title}>
                            <span className="text-muted-foreground">{w.artist ? `${w.artist} — ` : ""}</span>
                            {w.title}
                          </span>
                          <button
                            onClick={() => void openUrl(m.entry.url)}
                            className="shrink-0 font-mono text-[10px] text-primary hover:underline"
                            title="Open on YouTube Music"
                          >
                            {m.entry.url}
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              </Card>
            )}
          </>
        )}

        {!matches && !fetching && (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Fetch a playlist to match it against your collection.
          </div>
        )}
      </div>

      {matches && (
        <LibrarySearchPanel
          files={files}
          tags={tags}
          height={panelHeight}
          collapsed={panelCollapsed}
          label={trackLabel}
          onHeightChange={setPanelHeight}
          onCollapsedChange={setPanelCollapsed}
          onPick={(p) => {
            if (!focusedId) {
              notify("Click a playlist row first, then press Match on a result", "info");
              return;
            }
            assignFromSearch(focusedId, p);
            notify(`Matched to ${flatLabel(p)}`, "success");
          }}
        />
      )}

    </div>
  );
}
