import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  Check,
  ClipboardCopy,
  Download,
  ExternalLink,
  ListMusic,
  Loader2,
  Search,
  X,
} from "lucide-react";
import type { AudioFile, PlaylistFetchResult, TagData, YtDlpInfo } from "../types";
import { formatDuration } from "../components/AudioPreview";
import { matchPlaylist, type EntryMatch } from "../lib/ytMatch";
import { buildM3u8, buildRekordboxPlaylistXml } from "../lib/rekordboxExport";
import { Button, Card, CardHeader, cn } from "../components/ui";
import { Combobox } from "../components/Combobox";

function sanitizeFilenamePart(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, " ").trim() || "playlist";
}

function StatusBadge({ status }: { status: EntryMatch["status"] }) {
  if (status === "matched") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
        <Check className="h-3 w-3" /> Matched
      </span>
    );
  }
  if (status === "ambiguous") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
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
  notify,
  onInspect,
}: {
  files: AudioFile[];
  tags: Record<string, TagData>;
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
  const [matches, setMatches] = useState<EntryMatch[] | null>(null);
  // videoId -> chosen path override; "" means explicitly marked missing.
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [exporting, setExporting] = useState(false);

  const fileByPath = useMemo(() => Object.fromEntries(files.map((f) => [f.path, f])), [files]);
  const pathLabel = useMemo(() => {
    return (p: string) => {
      const t = tags[p];
      const f = fileByPath[p];
      const title = t?.title?.trim() || f?.filename || p;
      return t?.artist?.trim() ? `${t.artist.trim()} - ${title}` : title;
    };
  }, [tags, fileByPath]);
  const allLabels = useMemo(() => files.map((f) => pathLabel(f.path)), [files, pathLabel]);
  const labelToPath = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of files) m.set(pathLabel(f.path), f.path);
    return m;
  }, [files, pathLabel]);

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
    setOverrides({});
    try {
      const result = await invoke<PlaylistFetchResult>("fetch_ytmusic_playlist", { url: trimmed });
      setPlaylist(result);
      setMatches(matchPlaylist(result.entries, files, tags));
      notify(`Fetched ${result.entries.length} track(s) from "${result.title}"`, "success");
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setFetching(false);
    }
  };

  // An explicit override (including "" for "marked missing") always wins;
  // otherwise a confident auto-match is used as-is; an ambiguous or missing
  // entry has no resolved path until the user confirms or picks one.
  const resolvedPath = (m: EntryMatch): string | null => {
    const override = overrides[m.entry.videoId];
    if (override !== undefined) return override || null;
    return m.status === "matched" ? (m.candidates[0]?.path ?? null) : null;
  };

  const resolved = matches?.map((m) => ({ m, path: resolvedPath(m) })) ?? [];
  const matchedList = resolved.filter((r): r is { m: EntryMatch; path: string } => !!r.path);
  const missingList = resolved.filter((r) => !r.path);

  const setOverride = (videoId: string, path: string) =>
    setOverrides((prev) => ({ ...prev, [videoId]: path }));
  const clearOverride = (videoId: string) =>
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[videoId];
      return next;
    });

  const copyMissing = async () => {
    const text = missingList.map(({ m }) => m.entry.title).join("\n");
    await navigator.clipboard.writeText(text);
    notify(`Copied ${missingList.length} missing track title(s) to the clipboard`, "success");
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
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <div>
        <h1 className="text-xl font-bold">YouTube Music Import</h1>
        <p className="text-sm text-muted-foreground">
          Paste a YouTube Music (or YouTube) playlist link, match it against your loaded collection, and export a
          Rekordbox playlist — {files.length} loaded track{files.length === 1 ? "" : "s"}
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
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-sm">
              <ListMusic className="h-4 w-4 text-primary" />
              <span className="font-semibold">{playlist?.title}</span>
              <span className="text-xs text-muted-foreground">
                {matchedList.length} matched · {missingList.length} missing · {matches.length} total
              </span>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={copyMissing} disabled={!missingList.length}>
                <ClipboardCopy />
                Copy Missing ({missingList.length})
              </Button>
              <Button variant="secondary" size="sm" onClick={() => runExport("m3u8")} disabled={!matchedList.length || exporting}>
                <Download />
                Export M3U8
              </Button>
              <Button size="sm" onClick={() => runExport("rekordbox")} disabled={!matchedList.length || exporting}>
                <Download />
                Export Rekordbox XML
              </Button>
            </div>
          </div>

          <Card className="flex-1 overflow-y-auto p-2">
            <div className="space-y-1">
              {matches.map((m) => {
                const path = resolvedPath(m);
                const status: EntryMatch["status"] = overrides[m.entry.videoId] !== undefined
                  ? path
                    ? "matched"
                    : "missing"
                  : m.status;
                const suggestion = m.candidates[0];
                return (
                  <div key={m.entry.videoId} className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent/40">
                    <span className="w-6 shrink-0 text-right text-xs text-muted-foreground">{m.entry.index + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm" title={m.entry.title}>
                          {m.entry.title}
                        </span>
                        <button
                          onClick={() => void openUrl(m.entry.url)}
                          className="shrink-0 text-muted-foreground hover:text-primary"
                          title="Open on YouTube Music"
                        >
                          <ExternalLink className="h-3 w-3" />
                        </button>
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {m.entry.durationSecs ? formatDuration(m.entry.durationSecs) : "—"}
                        {m.entry.uploader ? ` · ${m.entry.uploader}` : ""}
                      </div>
                    </div>

                    <div className="flex w-56 shrink-0 items-center gap-2">
                      {path ? (
                        <button
                          className="min-w-0 flex-1 truncate text-left text-xs hover:underline"
                          onClick={() => onInspect(path)}
                          title={path}
                        >
                          {pathLabel(path)}
                        </button>
                      ) : status === "ambiguous" && suggestion ? (
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={suggestion.path}>
                          {pathLabel(suggestion.path)}?
                        </span>
                      ) : (
                        <span className="flex-1 text-xs text-muted-foreground">Not found</span>
                      )}
                      <StatusBadge status={status} />
                    </div>

                    <div className="flex w-40 shrink-0 items-center gap-1">
                      {status === "ambiguous" && !path && suggestion && (
                        <button
                          title="Confirm this match"
                          onClick={() => setOverride(m.entry.videoId, suggestion.path)}
                          className="rounded-md border border-primary bg-primary/10 p-1 text-primary hover:bg-primary/20"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {path && (
                        <button
                          title="Mark as missing"
                          onClick={() => setOverride(m.entry.videoId, "")}
                          className="rounded-md border border-input p-1 text-muted-foreground hover:bg-accent"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <Combobox
                        value=""
                        options={allLabels}
                        placeholder="Pick…"
                        className="w-24"
                        onChange={(label) => {
                          const p = labelToPath.get(label);
                          if (p) setOverride(m.entry.videoId, p);
                        }}
                        onClose={undefined}
                      />
                      {overrides[m.entry.videoId] !== undefined && (
                        <button
                          title="Reset to automatic match"
                          onClick={() => clearOverride(m.entry.videoId)}
                          className={cn("text-[10px] text-muted-foreground hover:text-foreground")}
                        >
                          reset
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </>
      )}

      {!matches && !fetching && (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Fetch a playlist to match it against your loaded collection.
        </div>
      )}
    </div>
  );
}
