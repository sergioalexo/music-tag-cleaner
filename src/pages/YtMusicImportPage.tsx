import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Notify } from "../hooks/useFiles";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  Ban,
  Check,
  ClipboardCopy,
  Database,
  Download,
  ExternalLink,
  FileJson,
  FileUp,
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
  EntryMeta,
  ImportSession,
  ImportSessionSummary,
  PlaylistEntry,
  PlaylistFetchResult,
  TagData,
  YtDlpInfo,
} from "../types";
import { AudioPreview } from "../components/AudioPreview";
import { YouTubePreview } from "../components/YouTubePreview";
import {
  AMBIGUOUS_THRESHOLD,
  buildWanted,
  CONFIDENT_THRESHOLD,
  matchPlaylist,
  type EntryMatch,
  type MatchCandidate,
} from "../lib/ytMatch";
import { buildMatchLog, matchLogToMarkdown, type DecisionState } from "../lib/ytMatchLog";
import { parseImportInput, shortHash } from "../lib/ytListInput";
import { buildM3u8, buildRekordboxPlaylistXml } from "../lib/rekordboxExport";
import { Button, Card, CardHeader, cn } from "../components/ui";
import { LibrarySearchPanel, type RowVariants } from "../components/LibrarySearchPanel";

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
  /** The raw text pasted into the import box that produced `entries` —
   * absent on a session saved before list-import shipped (C5), in which
   * case the textarea falls back to the single playlist URL. Lets Re-match
   * and re-fetch work for a mixed playlist/video/text-line import, and
   * refills the textarea on restore. */
  sourceText?: string;
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
  indexing,
  lastIndexedAt,
  onIndexNow,
}: {
  /** The whole collection: indexed tracks plus this session's loaded files. */
  files: AudioFile[];
  tags: Record<string, TagData>;
  /** How many of `files` came from the index, for the "index your library" hint. */
  indexedCount: number;
  notify: Notify;
  onInspect: (path: string) => void;
  /** Whether a whole-library index run is currently in progress. */
  indexing: boolean;
  lastIndexedAt?: number | null;
  /** Kicks off (or re-runs) the whole-library index by hand. */
  onIndexNow: () => void;
}) {
  const [ytdlp, setYtdlp] = useState<YtDlpInfo | null>(null);
  const [checkingYtdlp, setCheckingYtdlp] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState<{ downloaded: number; total: number } | null>(null);

  /** The multi-line import box: a playlist URL, video links, and/or typed
   * song names, one per line — see `parseImportInput`. */
  const [sourceText, setSourceText] = useState("");
  const [fetching, setFetching] = useState(false);
  const [playlist, setPlaylist] = useState<PlaylistFetchResult | null>(null);
  const [fetchedUrl, setFetchedUrl] = useState("");
  /** The saved-session key for the current playlist — a single playlist
   * URL uses `sessionKeyFor` unchanged (C5: existing sessions must restore
   * the same way they always did); a mixed/list import hashes the input. */
  const [importKey, setImportKey] = useState<string | null>(null);
  /** The exact text that produced the current `playlist`, for persistence —
   * kept separate from the live `sourceText` so editing the box afterward
   * without re-fetching can never desync what gets saved. */
  const importedTextRef = useRef("");
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
  /** `{done, total}` while `enrich_ytmusic_entries` is fetching real YouTube
   * Music metadata for the current playlist; null when nothing is running. */
  const [enrichProgress, setEnrichProgress] = useState<{ done: number; total: number } | null>(null);
  const enrichRunRef = useRef<{ cancel: () => void } | null>(null);

  // --- Bottom library-search dock.
  const [panelHeight, setPanelHeight] = useState(180);
  const [panelCollapsed, setPanelCollapsed] = useState(false);

  // --- B2: a path saved in a session's overrides (from a previous run, or
  // matched against files opened in an earlier session) doesn't always come
  // back byte-identical to how the collection has it today — different case,
  // `/` vs `\`, a trailing space. Looked up as typed first, then again
  // case/slash-folded, before ever falling back to "not found".
  const fileByPath = useMemo(() => Object.fromEntries(files.map((f) => [f.path, f])), [files]);
  const normPath = (p: string) => p.trim().toLowerCase().replace(/\//g, "\\");
  const fileByNormPath = useMemo(() => {
    const m = new Map<string, AudioFile>();
    for (const f of files) if (!m.has(normPath(f.path))) m.set(normPath(f.path), f);
    return m;
  }, [files]);
  const tagsByNormPath = useMemo(() => {
    const m = new Map<string, TagData>();
    for (const [p, t] of Object.entries(tags)) if (!m.has(normPath(p))) m.set(normPath(p), t);
    return m;
  }, [tags]);

  /** Tags fetched on demand for a path the collection doesn't have — a match
   * from an earlier session pointing at a file outside the indexed roots
   * (see `useMissingPathLookup` below). */
  const [extraTags, setExtraTags] = useState<Record<string, TagData>>({});
  /** Paths a lookup confirmed no longer exist on disk. */
  const [missingPaths, setMissingPaths] = useState<Set<string>>(new Set());

  const basename = (p: string): string => {
    const base = p.split(/[\\/]/).pop() ?? p;
    return base.replace(/\.[^./\\]+$/, "");
  };

  /** A library path split into the two lines the UI shows for it. Falls back
   * to the bare filename, never the full path — the path is still available
   * as the row's `title=` tooltip. */
  const trackLabel = useMemo(() => {
    return (p: string): { title: string; artist: string; missing: boolean } => {
      if (missingPaths.has(p)) return { title: basename(p), artist: "", missing: true };
      const t = tags[p] ?? tagsByNormPath.get(normPath(p)) ?? extraTags[p];
      const f = fileByPath[p] ?? fileByNormPath.get(normPath(p));
      return {
        title: t?.title?.trim() || f?.filename || basename(p),
        artist: t?.artist?.trim() || "",
        missing: false,
      };
    };
  }, [tags, fileByPath, tagsByNormPath, fileByNormPath, extraTags, missingPaths]);

  const flatLabel = useMemo(() => {
    return (p: string) => {
      const l = trackLabel(p);
      return l.artist ? `${l.artist} - ${l.title}` : l.title;
    };
  }, [trackLabel]);


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
        const text = payload.sourceText ?? saved.url;
        setPlaylist({ title: saved.title, entries: payload.entries });
        setFetchedUrl(saved.url);
        setSourceText(text);
        importedTextRef.current = text;
        setImportKey(saved.key);
        setOverrides(payload.overrides ?? {});
        setDenied(payload.denied ?? {});
        setCandIndex(payload.candIndex ?? {});
        setFromSearch(payload.fromSearch ?? {});
        setResumedFrom(saved);
        const enrichable = payload.entries.filter((e) => e.source !== "text").map((e) => e.videoId);
        if (enrichable.length) void runEnrichment(enrichable);
      } catch {
        // Nothing to restore is the normal case on a first run.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /**
   * Fetches real per-track YouTube Music metadata (artist/album/year) for a
   * freshly-fetched or restored playlist — never guessed from the title or
   * the uploading channel, per the owner's "no guessing" rule.
   *
   * Cache hits paint instantly via `cached_ytmusic_meta` (no network); only
   * misses go through `enrich_ytmusic_entries`, which fetches 4 at a time
   * and emits each result as it lands. Results are buffered and flushed into
   * `playlist.entries` every 250ms rather than per-event, so a 90-track
   * playlist doesn't re-run matching 90 times in a few seconds.
   *
   * Superseded automatically if the owner fetches another playlist mid-run —
   * `enrichRunRef` cancels the previous run (both locally and via the Rust
   * `cancel_ytmusic_enrich` command) before starting a new one.
   */
  const runEnrichment = async (videoIds: string[]) => {
    enrichRunRef.current?.cancel();
    let cancelled = false;
    enrichRunRef.current = {
      cancel: () => {
        cancelled = true;
        void invoke("cancel_ytmusic_enrich");
      },
    };

    setPlaylist((prev) =>
      prev ? { ...prev, entries: prev.entries.map((e) => ({ ...e, metaStatus: "pending" })) } : prev,
    );

    const pending = new Map<string, EntryMeta>();
    const flush = () => {
      if (cancelled || !pending.size) return;
      const updates = new Map(pending);
      pending.clear();
      setPlaylist((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          entries: prev.entries.map((e) => {
            const m = updates.get(e.videoId);
            if (!m) return e;
            if (m.error) return { ...e, metaStatus: "failed" };
            return {
              ...e,
              title: m.title?.trim() || e.title,
              artists: m.artists,
              album: m.album ?? null,
              year: m.year ?? null,
              durationSecs: e.durationSecs ?? m.durationSecs ?? null,
              metaStatus: "done",
            };
          }),
        };
      });
    };

    const unlistenMeta = await listen<EntryMeta>("ytmusic-entry-meta", (e) => {
      pending.set(e.payload.videoId, e.payload);
    });
    const unlistenProgress = await listen<{ done: number; total: number }>(
      "ytmusic-enrich-progress",
      (e) => {
        if (!cancelled) setEnrichProgress(e.payload);
      },
    );
    const interval = window.setInterval(flush, 250);

    try {
      const cached = await invoke<EntryMeta[]>("cached_ytmusic_meta", { videoIds });
      if (cancelled) return;
      for (const m of cached) pending.set(m.videoId, m);
      flush();
      const cachedIds = new Set(cached.map((m) => m.videoId));
      const misses = videoIds.filter((id) => !cachedIds.has(id));
      if (misses.length && !cancelled) {
        setEnrichProgress({ done: 0, total: misses.length });
        await invoke("enrich_ytmusic_entries", { videoIds: misses });
      }
    } catch (e) {
      if (!cancelled) notify(String(e), "error", { details: { action: "enrich_ytmusic_entries" } });
    } finally {
      flush();
      window.clearInterval(interval);
      unlistenMeta();
      unlistenProgress();
      if (!cancelled) {
        setEnrichProgress(null);
        enrichRunRef.current = null;
      }
    }
  };

  useEffect(() => () => enrichRunRef.current?.cancel(), []);

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

  /**
   * Parses the (possibly multi-line) import box and fetches everything it
   * names: a playlist URL via the existing flat-playlist fetch, a bare
   * video link as its own entry (enriched the same way as a playlist
   * track), and a typed song name as a text entry that only ever goes
   * through the matcher — never YouTube (see `ParsedImportItem`).
   *
   * A single playlist URL and nothing else — the original, pre-C behavior —
   * keeps the exact same session key (`sessionKeyFor`) so a session saved
   * before this feature shipped restores unchanged (C5). Anything else gets
   * a `list:`-prefixed key hashed from the input text.
   */
  const runImport = async () => {
    const trimmed = sourceText.trim();
    if (!trimmed) return;
    setFetching(true);
    setPlaylist(null);
    setMatches(null);
    setResumedFrom(null);
    setOverrides({});
    setDenied({});
    setCandIndex({});
    setFromSearch({});
    const fetchStarted = Date.now();
    try {
      const items = parseImportInput(trimmed);
      if (!items.length) {
        notify("Nothing to import — paste a link, playlist URL, or song names", "info");
        return;
      }

      let title = "";
      let firstPlaylistUrl = "";
      const entries: PlaylistEntry[] = [];
      const seen = new Set<string>();
      let idx = 0;

      for (const item of items) {
        if (item.kind === "playlist") {
          if (!firstPlaylistUrl) firstPlaylistUrl = item.url;
          const result = await invoke<PlaylistFetchResult>("fetch_ytmusic_playlist", { url: item.url });
          if (!title) title = result.title;
          for (const e of result.entries) {
            if (seen.has(e.videoId)) continue;
            seen.add(e.videoId);
            entries.push({ ...e, index: idx++, source: "youtube" });
          }
        } else if (item.kind === "video") {
          if (seen.has(item.videoId)) continue;
          seen.add(item.videoId);
          entries.push({ index: idx++, videoId: item.videoId, url: item.url, title: item.url, source: "youtube" });
        } else {
          const videoId = `text:${shortHash(item.line)}`;
          if (seen.has(videoId)) continue;
          seen.add(videoId);
          entries.push({ index: idx++, videoId, url: "", title: item.line, source: "text", metaStatus: "done" });
        }
      }

      if (!entries.length) throw new Error("Nothing recognizable to import — check the pasted text");

      // A lone playlist or video link — the original, pre-list-import
      // behavior — keeps the exact same key `sessionKeyFor` always produced
      // for it, so a session saved before this feature shipped is still
      // found (C5). Anything else (a mix, several links, or typed text) is
      // new territory and gets a key hashed from the whole input.
      const singleUrlItem =
        items.length === 1 && (items[0].kind === "playlist" || items[0].kind === "video") ? items[0] : null;
      if (!title) title = `Pasted list (${entries.length} track${entries.length === 1 ? "" : "s"})`;
      const key = singleUrlItem ? sessionKeyFor(singleUrlItem.url) : `list:${shortHash(trimmed)}`;

      setPlaylist({ title, entries });
      setFetchedUrl(singleUrlItem?.url ?? firstPlaylistUrl);
      setImportKey(key);
      importedTextRef.current = trimmed;

      // Matching is driven by the effect above, so it happens here too.
      const noArtist = entries.filter((e) => e.source !== "text" && !buildWanted(e).artist).length;
      notify(`Fetched ${entries.length} track(s)${title ? ` from "${title}"` : ""}`, "success", {
        details: {
          itemCount: items.length,
          title,
          trackCount: entries.length,
          entriesWithNoIdentifiableArtist: noArtist,
          fetchMs: Date.now() - fetchStarted,
        },
      });

      const enrichableIds = entries.filter((e) => e.source !== "text").map((e) => e.videoId);
      if (enrichableIds.length) void runEnrichment(enrichableIds);

      // Re-importing something matched before restores every decision made
      // last time. The matcher has just re-run against the (possibly
      // larger) collection, and these decisions are layered on top — so
      // newly-acquired tracks get matched while past confirmations and
      // denials stand.
      const saved = await invoke<ImportSession | null>("load_import_session", { key });
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
      notify(String(e), "error", { details: { input: trimmed } });
    } finally {
      setFetching(false);
    }
  };

  const loadListFile = async () => {
    const picked = await openDialog({
      title: "Load a Track List",
      multiple: false,
      filters: [{ name: "Text or CSV", extensions: ["txt", "csv"] }],
    });
    if (!picked || typeof picked !== "string") return;
    try {
      const contents = await invoke<string>("read_text_file", { path: picked });
      setSourceText(contents);
    } catch (e) {
      notify(String(e), "error");
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
    const resolved = resolvedPath(m);
    if (resolved && !missingPaths.has(resolved)) return "matched";
    return shownCandidate(m) && overrides[m.entry.videoId] === undefined ? "ambiguous" : "missing";
  };

  const resolved = matches?.map((m) => ({ m, path: resolvedPath(m) })) ?? [];
  // A path confirmed gone from disk (see the lookup effect below) is treated
  // as unmatched for export — a link to a file that no longer exists isn't
  // a match, so it falls through to "Still to get" instead of the playlist.
  const matchedList = resolved.filter(
    (r): r is { m: EntryMatch; path: string } => !!r.path && !missingPaths.has(r.path),
  );
  const missingList = resolved.filter((r) => !r.path || missingPaths.has(r.path));

  /**
   * B2: fetches tags on demand for any displayed path the collection doesn't
   * have — a match saved in a previous session for a file that lives outside
   * the indexed roots (opened directly in an earlier session), or whose path
   * no longer byte-matches the index for some other reason. Runs off the
   * resolved/shown paths actually on screen, not the whole playlist, and
   * never re-fetches a path it already has an answer for (found or missing).
   */
  useEffect(() => {
    if (!matches) return;
    const shown = new Set<string>();
    for (const m of matches) {
      const p = resolvedPath(m) ?? shownCandidate(m)?.path;
      if (p) shown.add(p);
    }
    const unresolved = [...shown].filter(
      (p) =>
        !tags[p] &&
        !tagsByNormPath.has(normPath(p)) &&
        !(p in extraTags) &&
        !missingPaths.has(p),
    );
    if (!unresolved.length) return;
    void (async () => {
      try {
        const results = await invoke<{ path: string; tags: TagData | null; error: string | null }[]>(
          "read_tags_batch",
          { paths: unresolved },
        );
        const found: Record<string, TagData> = {};
        const gone: string[] = [];
        for (const r of results) {
          if (r.tags) found[r.path] = r.tags;
          else gone.push(r.path);
        }
        if (Object.keys(found).length) setExtraTags((prev) => ({ ...prev, ...found }));
        if (gone.length) setMissingPaths((prev) => new Set([...prev, ...gone]));
      } catch {
        // Best-effort — rows just keep showing the filename fallback.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, tags, tagsByNormPath, extraTags, missingPaths]);

  /**
   * The focused row's other matcher-found candidates, for the "Other
   * versions" list in the search dock — this replaced the row's own cycling
   * arrows, so a track with several mixes/remixes still has somewhere to
   * pick the right one from.
   */
  const focusedVariants: RowVariants | null = (() => {
    if (!focusedId || !matches) return null;
    const m = matches.find((mm) => mm.entry.videoId === focusedId);
    if (!m) return null;
    const shown = shownCandidate(m);
    const rest = liveCandidates(m).filter((c) => c.path !== shown?.path);
    if (!rest.length) return null;
    return { videoId: focusedId, rowLabel: `row ${m.entry.index + 1}`, candidates: rest };
  })();

  // --- Decision actions -----------------------------------------------------
  const setOverride = (videoId: string, path: string) =>
    setOverrides((prev) => ({ ...prev, [videoId]: path }));

  /**
   * A quiet log entry per click — confirm/deny/cycle/skip/reset never pop a
   * toast (dozens of these a minute would bury everything else), but each
   * one is worth having in the Logs page afterwards: which playlist row,
   * what YouTube called it, which file was involved, its score and why it
   * matched, and — for a deny — what's still in the running.
   */
  const logDecision = (action: string, m: EntryMatch, extra?: Record<string, unknown>) => {
    const w = buildWanted(m.entry);
    const shown = shownCandidate(m);
    notify(`${action}: row ${m.entry.index + 1} "${w.artist ? `${w.artist} - ${w.title}` : w.title}"`, "info", {
      silent: true,
      details: {
        action,
        row: m.entry.index + 1,
        videoId: m.entry.videoId,
        wantedArtist: w.artist,
        wantedTitle: w.title,
        shownCandidate: shown ? { path: shown.path, score: shown.score, via: shown.via } : null,
        remainingCandidates: liveCandidates(m).map((c) => ({ path: c.path, score: c.score, via: c.via })),
        ...extra,
      },
    });
  };

  /**
   * Jumps focus to the next row that still needs a decision — confirming,
   * denying or marking a row missing moves straight on to the next one that
   * isn't resolved yet, so working through a playlist is "keep clicking"
   * without having to find the next row by hand. Wraps around, and does
   * nothing if everything is already settled.
   */
  const advanceFocus = (afterId: string) => {
    if (!matches?.length) return;
    const startIdx = matches.findIndex((m) => m.entry.videoId === afterId);
    for (let step = 1; step <= matches.length; step++) {
      const m = matches[(startIdx + step + matches.length) % matches.length];
      if (effectiveStatus(m) !== "matched") {
        setFocusedId(m.entry.videoId);
        return;
      }
    }
  };

  const confirmMatch = (m: EntryMatch) => {
    const shown = shownCandidate(m);
    if (shown) {
      setOverride(m.entry.videoId, shown.path);
      logDecision("Confirmed", m);
      advanceFocus(m.entry.videoId);
    }
  };

  /** Rejects the candidate on screen. The next best takes its place; when
   * none is left the entry falls through to "missing", which is how the
   * deny button doubles as "this isn't in my collection". Either way,
   * focus moves on to the next row that needs a decision. */
  const denyMatch = (m: EntryMatch) => {
    const shown = shownCandidate(m);
    if (!shown) return;
    const id = m.entry.videoId;
    logDecision("Denied", m, { deniedPath: shown.path });
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
    advanceFocus(id);
  };

  /** Denies one specific candidate — used by the "Other versions" list in
   * the search dock, where the candidate on offer isn't necessarily the one
   * currently shown on the row. */
  const denyCandidatePath = (m: EntryMatch, path: string) => {
    const id = m.entry.videoId;
    setDenied((prev) => ({ ...prev, [id]: [...(prev[id] ?? []), path] }));
    logDecision("Denied", m, { deniedPath: path });
  };

  /** "I don't have it" — rejects every remaining candidate outright (not
   * just the one on screen), so the row can never keep showing a
   * suggestion after you've said you don't own it. */
  const skipEntry = (m: EntryMatch) => {
    const id = m.entry.videoId;
    const allPaths = m.candidates.map((c) => c.path);
    setDenied((prev) => ({ ...prev, [id]: [...new Set([...(prev[id] ?? []), ...allPaths])] }));
    setOverride(id, "");
    logDecision("Marked missing", m);
    advanceFocus(id);
  };

  /** Picks one of the matcher's own alternate candidates for a row — the
   * "Other versions" list in the search dock, replacing the old cycling
   * arrows on the row itself. */
  const chooseVariant = (m: EntryMatch, path: string) => {
    setOverride(m.entry.videoId, path);
    logDecision("Chose alternate version", m, { path });
  };

  const resetEntry = (m: EntryMatch) => {
    const id = m.entry.videoId;
    const drop = <T,>(o: Record<string, T>) => {
      const next = { ...o };
      delete next[id];
      return next;
    };
    logDecision("Reset to automatic match", m);
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
  const buildPayload = (): SessionPayload => ({
    version: 1,
    entries: playlist?.entries ?? [],
    overrides,
    denied,
    candIndex,
    fromSearch,
    sourceText: importedTextRef.current,
  });

  const persist = async (quiet: boolean) => {
    if (!importKey || !playlist) return;
    try {
      await invoke("save_import_session", {
        key: importKey,
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
    if (!importKey || !matches) return;
    const t = setTimeout(() => void persist(true), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrides, denied, candIndex, fromSearch, importKey, matches]);

  const forgetSession = async () => {
    if (!importKey) return;
    await invoke("delete_import_session", { key: importKey });
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
    const started = Date.now();
    try {
      const next = matchPlaylist(playlist.entries, files, tags);
      setMatches(next);
      const byStatus = { matched: 0, ambiguous: 0, missing: 0 };
      for (const m of next) byStatus[m.status]++;
      notify(`Re-matched against ${files.length} track(s) — your decisions were kept`, "success", {
        details: {
          trackCount: files.length,
          rematchMs: Date.now() - started,
          matcherStatus: byStatus,
          confidentThreshold: CONFIDENT_THRESHOLD,
          ambiguousThreshold: AMBIGUOUS_THRESHOLD,
        },
      });
    } finally {
      setRematching(false);
    }
  };

  /** Clears the screen without touching the saved session. */
  const closePlaylist = () => {
    setPlaylist(null);
    setFetchedUrl("");
    setImportKey(null);
    setResumedFrom(null);
  };

  // --- Clipboard / export ---------------------------------------------------
  /** The missing list as plain data, for logging/reporting — not just a count. */
  const missingListDetails = () =>
    missingList.map(({ m }) => {
      const w = buildWanted(m.entry);
      return { title: w.title, artist: w.artist, url: m.entry.url, videoId: m.entry.videoId };
    });

  const copyMissingLinks = async () => {
    if (!missingList.length) return;
    const text = missingList
      .map(({ m }) => {
        const w = buildWanted(m.entry);
        const label = w.artist ? `${w.artist} - ${w.title}` : w.title;
        return m.entry.url ? `${label} ${m.entry.url}` : label;
      })
      .join("\n");
    await navigator.clipboard.writeText(text);
    notify(`Copied ${missingList.length} link(s) to the clipboard`, "success", {
      details: missingListDetails(),
    });
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
    notify(`Copied ${missingList.length} title(s) to the clipboard`, "success", {
      details: missingListDetails(),
    });
  };

  /**
   * The second line under a row's YouTube title: real metadata only, never a
   * guess. `pending`/no status yet shows a loading hint; a failed fetch or a
   * successful one with no artist both say so plainly rather than falling
   * back to the channel name or a title split.
   */
  const metaLine = (entry: PlaylistEntry): { text: string; muted: boolean } => {
    // A typed song name (no YouTube link at all) is only ever matched
    // against the local collection — there's nothing to look up on YouTube
    // for it, so it gets no second line rather than a misleading status.
    if (entry.source === "text") return { text: "", muted: true };
    if (entry.metaStatus === "failed") return { text: "Artist unknown on YouTube", muted: true };
    if (entry.metaStatus !== "done") return { text: "Loading from YouTube Music…", muted: true };
    const want = buildWanted(entry);
    const parts = [want.artist, entry.album?.trim() || null, entry.year ? String(entry.year) : null].filter(
      (p): p is string => !!p,
    );
    if (!parts.length) return { text: "Artist unknown on YouTube", muted: true };
    return { text: parts.join(" • "), muted: false };
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
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <Database className="h-3 w-3" />
            {indexing ? (
              <span className="flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" /> Indexing your library…
              </span>
            ) : indexedCount > 0 ? (
              <span>
                Indexed once, always available — updated{" "}
                {lastIndexedAt ? new Date(lastIndexedAt * 1000).toLocaleString() : "recently"}
              </span>
            ) : (
              <span>Your library isn't indexed yet, so matching only sees files opened this session</span>
            )}
            <button
              onClick={onIndexNow}
              disabled={indexing}
              className="text-primary hover:underline disabled:opacity-50"
            >
              {indexedCount > 0 ? "Re-index now" : "Index now"}
            </button>
          </div>
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

        {!checkingYtdlp && ytdlp?.installed && ytdlp.stale && (
          <Card className="p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
                  Your yt-dlp is from {ytdlp.version?.slice(0, 7)} — YouTube often breaks old versions
                </div>
                <p className="text-xs text-muted-foreground">
                  Update it for reliable playlist fetching and metadata (also available on the Components page).
                </p>
              </div>
              <Button size="sm" variant="secondary" onClick={installYtdlp} disabled={installing}>
                {installing ? <Loader2 className="animate-spin" /> : <Download />}
                {installing ? "Updating…" : "Update yt-dlp"}
              </Button>
            </div>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Playlist or List"
            hint="A YouTube Music/YouTube playlist link, video links, or typed song names — one per line"
          />
          <div className="flex flex-col gap-2 px-5 py-3">
            <textarea
              value={sourceText}
              onChange={(e) => setSourceText(e.target.value)}
              onKeyDown={(e) => (e.key === "Enter" && (e.metaKey || e.ctrlKey)) && runImport()}
              placeholder={
                "Paste a YouTube / YouTube Music playlist, video links (one per line),\n" +
                "or just song names:\n" +
                "Flo Rida - Low\n" +
                "Bad Romance by Lady Gaga"
              }
              rows={4}
              className="min-h-20 flex-1 resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <div className="flex items-center justify-between gap-2">
              <Button variant="secondary" size="sm" onClick={loadListFile} disabled={fetching}>
                <FileUp />
                Load .txt / .csv
              </Button>
              <Button
                onClick={runImport}
                disabled={fetching || !sourceText.trim() || !ytdlp?.installed}
                title="Ctrl/Cmd+Enter also works"
              >
                {fetching ? <Loader2 className="animate-spin" /> : <Search />}
                {fetching ? "Fetching…" : "Fetch"}
              </Button>
            </div>
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

            {enrichProgress && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                <span className="shrink-0">
                  Reading track details from YouTube Music — {enrichProgress.done} / {enrichProgress.total}
                </span>
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{
                      width: `${enrichProgress.total > 0 ? (enrichProgress.done / enrichProgress.total) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
            )}

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

                      {/* What YouTube has — title on top, real YouTube Music
                          metadata (artist • album • year) underneath. Never a
                          channel name or a guess split out of the title. */}
                      <div className="flex min-w-0 flex-1 items-center gap-1.5">
                        {m.entry.source !== "text" && (
                          <YouTubePreview
                            videoId={m.entry.videoId}
                            url={m.entry.url}
                            durationSecs={m.entry.durationSecs}
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm" title={m.entry.title}>
                              {want.title}
                            </span>
                            {m.entry.source !== "text" && (
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
                            )}
                          </div>
                          {(() => {
                            const meta = metaLine(m.entry);
                            if (!meta.text) return null;
                            return (
                              <div className={cn("truncate text-xs", meta.muted && "text-muted-foreground")}>
                                {meta.text}
                              </div>
                            );
                          })()}
                        </div>
                      </div>

                      {/* What it matched in the collection — same two lines, so
                          a long "Artist - Title" is readable instead of clipped. */}
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        {displayPath && lib?.missing ? (
                          <span
                            className="flex-1 truncate text-xs text-muted-foreground"
                            title={displayPath}
                          >
                            File missing — {lib.title}
                          </span>
                        ) : displayPath && lib ? (
                          <>
                            <AudioPreview
                              path={displayPath}
                              durationSecs={fileByPath[displayPath]?.durationSecs}
                              dense
                            />
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

                      {/*
                        Every slot below has a fixed width and is always
                        rendered — a button that doesn't apply to the row's
                        current state is disabled and dimmed rather than
                        removed, so nothing here ever shifts sideways or pops
                        in/out under the mouse.
                      */}
                      <div className="flex w-28 shrink-0 items-center justify-end gap-1">
                        <span className="flex w-6 shrink-0 items-center justify-center">
                          <button
                            title="Confirm this match"
                            disabled={!shown || !!path}
                            onClick={(e) => {
                              e.stopPropagation();
                              confirmMatch(m);
                            }}
                            className="rounded-md border border-primary bg-primary/10 p-1 text-primary hover:bg-primary/20 disabled:pointer-events-none disabled:opacity-30"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </button>
                        </span>

                        <span className="flex w-6 shrink-0 items-center justify-center">
                          <button
                            title={
                              live.length > 1
                                ? "Deny this match — the next candidate takes its place"
                                : "Deny this match — nothing else fits, so it becomes Missing"
                            }
                            disabled={!shown}
                            onClick={(e) => {
                              e.stopPropagation();
                              denyMatch(m);
                            }}
                            className="rounded-md border border-input p-1 text-muted-foreground hover:border-destructive hover:text-destructive disabled:pointer-events-none disabled:opacity-30"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </span>

                        <span className="flex w-6 shrink-0 items-center justify-center">
                          <button
                            title="I don't have it — mark this row missing"
                            disabled={overrides[id] === ""}
                            onClick={(e) => {
                              e.stopPropagation();
                              skipEntry(m);
                            }}
                            className="rounded-md border border-input p-1 text-muted-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-30"
                          >
                            <Ban className="h-3.5 w-3.5" />
                          </button>
                        </span>

                        <span className="flex w-6 shrink-0 items-center justify-center">
                          <button
                            title="Reset to the automatic match"
                            disabled={!touched(id)}
                            onClick={(e) => {
                              e.stopPropagation();
                              resetEntry(m);
                            }}
                            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </button>
                        </span>
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
                          {m.entry.url && (
                            <button
                              onClick={() => void openUrl(m.entry.url)}
                              className="shrink-0 font-mono text-[10px] text-primary hover:underline"
                              title="Open on YouTube Music"
                            >
                              {m.entry.url}
                            </button>
                          )}
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
          variants={focusedVariants}
          onHeightChange={setPanelHeight}
          onCollapsedChange={setPanelCollapsed}
          onPick={(p) => {
            if (!focusedId) {
              notify("Click a playlist row first, then press Match on a result", "info");
              return;
            }
            assignFromSearch(focusedId, p);
            const row = matches?.find((m) => m.entry.videoId === focusedId);
            notify(`Matched to ${flatLabel(p)}`, "success", {
              details: {
                action: "Matched by hand search",
                row: row ? row.entry.index + 1 : null,
                videoId: focusedId,
                wantedTitle: row?.entry.title,
                path: p,
              },
            });
          }}
          onPickVariant={(p) => {
            const row = matches?.find((m) => m.entry.videoId === focusedId);
            if (row) chooseVariant(row, p);
          }}
          onDenyVariant={(p) => {
            const row = matches?.find((m) => m.entry.videoId === focusedId);
            if (row) denyCandidatePath(row, p);
          }}
        />
      )}

    </div>
  );
}
