import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ArrowDown,
  ArrowUp,
  Clipboard,
  Download,
  ListMusic,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import type {
  AudioFile,
  GenreCount,
  IndexedTrack,
  PlaylistAiResult,
  PlaylistSetSpec,
  PlaylistTrackInput,
  Settings,
  TagData,
} from "../types";
import { searchTracks } from "../lib/trackSearch";
import { buildM3u8, buildRekordboxPlaylistXml } from "../lib/rekordboxExport";
import { Button, Card, CardHeader, cn, inputClass } from "./ui";
import { TrackContextMenu, trackMenuItems, useTrackContextMenu } from "./TrackContextMenu";
import type { Notify } from "../hooks/useFiles";

/** Presets for D4 — each a list of set names with no fixed per-set size,
 * letting the AI balance them. "Custom" switches to the free-form field. */
const SET_PRESETS: { label: string; sets: string[] }[] = [
  { label: "Warm-up / Peak", sets: ["Warm-up", "Peak"] },
  { label: "Warm-up / Build / Peak", sets: ["Warm-up", "Build", "Peak"] },
];

function sanitizeFilenamePart(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, " ").trim() || "playlist";
}

/** Parses a free-form split request like "split into 3: start, warm-up, peak"
 * or a plain comma list "start, warm-up, peak" into set names. Falls back to
 * a single "Playlist" set if nothing parses. */
function parseCustomSets(text: string): string[] {
  const afterColon = text.includes(":") ? text.slice(text.indexOf(":") + 1) : text;
  const names = afterColon
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length ? names : ["Playlist"];
}

interface BuilderResult {
  sets: { name: string; trackIds: number[] }[];
  suggestions: string[];
  droppedUnknownIds: number;
}

export function AiPlaylistBuilder({
  tracks,
  files,
  tags,
  genres,
  settings,
  notify,
  onAddToBatch,
  onInspect,
}: {
  /** The Library index only (D1) — never the working batch. */
  tracks: IndexedTrack[];
  files: AudioFile[];
  tags: Record<string, TagData>;
  genres: GenreCount[];
  settings: Settings;
  notify: Notify;
  onAddToBatch?: (paths: string[]) => unknown;
  onInspect?: (path: string) => unknown;
}) {
  const { menu, openMenu, closeMenu } = useTrackContextMenu();
  const runMenuAction = (fn: () => unknown) => {
    closeMenu();
    void Promise.resolve(fn()).catch((e) => console.error("row action failed:", e));
  };

  // --- D2: filters ---
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const [yearFrom, setYearFrom] = useState("");
  const [yearTo, setYearTo] = useState("");
  const [bpmFrom, setBpmFrom] = useState("");
  const [bpmTo, setBpmTo] = useState("");
  const [keyFilter, setKeyFilter] = useState("");
  const [artistInclude, setArtistInclude] = useState("");
  const [artistExclude, setArtistExclude] = useState("");
  const [minRating, setMinRating] = useState("");
  const [excludePathsText, setExcludePathsText] = useState("");

  // --- D3/D4 ---
  const [instructions, setInstructions] = useState("");
  const [presetIdx, setPresetIdx] = useState(0); // -1 = custom
  const [customSetsText, setCustomSetsText] = useState("start, warm-up, peak");

  // --- run state ---
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BuilderResult | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [activeSetIdx, setActiveSetIdx] = useState(0);
  /** `name -> ordered paths`, editable after the AI answers (D7). */
  const [setPaths, setSetPaths] = useState<Record<string, string[]>>({});
  const [addQuery, setAddQuery] = useState("");
  const [manualPrompt, setManualPrompt] = useState<string | null>(null);
  const [manualPasteText, setManualPasteText] = useState("");
  const [manualPoolIds, setManualPoolIds] = useState<number[]>([]);

  const excludePaths = useMemo(
    () => new Set(excludePathsText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)),
    [excludePathsText],
  );

  const pool = useMemo(() => {
    const yFrom = Number(yearFrom) || 0;
    const yTo = Number(yearTo) || 9999;
    const bFrom = Number(bpmFrom) || 0;
    const bTo = Number(bpmTo) || 9999;
    const includeTerm = artistInclude.trim().toLowerCase();
    const excludeTerm = artistExclude.trim().toLowerCase();
    const minR = Number(minRating) || 0;
    const key = keyFilter.trim().toLowerCase();

    return tracks.filter((t) => {
      if (excludePaths.has(t.path)) return false;
      if (selectedGenres.length && !selectedGenres.includes(t.genre ?? "")) return false;
      const year = Number(t.year) || 0;
      if (year && (year < yFrom || year > yTo)) return false;
      if (!year && (yearFrom || yearTo)) return false;
      const bpm = t.bpm ?? 0;
      if (bpm && (bpm < bFrom || bpm > bTo)) return false;
      if (!bpm && (bpmFrom || bpmTo)) return false;
      if (key && (t.key ?? "").toLowerCase() !== key) return false;
      if (includeTerm && !(t.artist ?? "").toLowerCase().includes(includeTerm)) return false;
      if (excludeTerm && (t.artist ?? "").toLowerCase().includes(excludeTerm)) return false;
      if (minR && (t.rating ?? 0) < minR) return false;
      return true;
    });
  }, [
    tracks,
    excludePaths,
    selectedGenres,
    yearFrom,
    yearTo,
    bpmFrom,
    bpmTo,
    keyFilter,
    artistInclude,
    artistExclude,
    minRating,
  ]);

  // Prompt-sized pool: too many tracks makes a prompt the model will choke
  // on (D5's "warn, don't silently truncate"). 600 lines is comfortably
  // inside every backend's context at the compact one-line-per-track format.
  const POOL_LIMIT = 600;
  const tooLarge = pool.length > POOL_LIMIT;

  const setSpecs: PlaylistSetSpec[] = useMemo(() => {
    const names = presetIdx === -1 ? parseCustomSets(customSetsText) : SET_PRESETS[presetIdx].sets;
    return names.map((name) => ({ name }));
  }, [presetIdx, customSetsText]);

  const poolInputs: PlaylistTrackInput[] = useMemo(
    () =>
      pool.map((t, i) => ({
        id: i + 1,
        artist: t.artist ?? "",
        title: t.title ?? t.filename,
        genre: t.genre ?? "",
        year: t.year ?? "",
        bpm: t.bpm ? String(t.bpm) : "",
      })),
    [pool],
  );

  const pathById = useMemo(() => {
    const m = new Map<number, string>();
    pool.forEach((t, i) => m.set(i + 1, t.path));
    return m;
  }, [pool]);

  const applyResult = (ai: PlaylistAiResult) => {
    const validIds = new Set(poolInputs.map((p) => p.id));
    let dropped = 0;
    const nextPaths: Record<string, string[]> = {};
    const sets = ai.sets.map((s) => {
      const ids = s.trackIds.filter((id) => {
        const ok = validIds.has(id);
        if (!ok) dropped++;
        return ok;
      });
      nextPaths[s.name] = ids.map((id) => pathById.get(id)!).filter(Boolean);
      return { name: s.name, trackIds: ids };
    });
    setResult({ sets, suggestions: ai.suggestions, droppedUnknownIds: dropped });
    setSuggestions(ai.suggestions);
    setSetPaths(nextPaths);
    setActiveSetIdx(0);
    if (dropped > 0) {
      notify(`The AI returned ${dropped} id(s) not in the pool — dropped, never trusted.`, "info");
    }
  };

  const generate = async () => {
    if (!pool.length) {
      notify("No tracks match the current filters.", "error");
      return;
    }
    if (tooLarge) {
      notify(
        `${pool.length} tracks match — that's too many for one prompt. Narrow the filters below ${POOL_LIMIT}.`,
        "error",
      );
      return;
    }
    if (settings.aiBackend === "manual") {
      try {
        const text = await invoke<string>("ai_playlist_prompt", {
          pool: poolInputs,
          instructions,
          sets: setSpecs,
        });
        setManualPrompt(text);
        setManualPoolIds(poolInputs.map((p) => p.id));
        setManualPasteText("");
      } catch (e) {
        notify(String(e), "error");
      }
      return;
    }
    setRunning(true);
    try {
      const ai =
        settings.aiBackend === "claude"
          ? await invoke<PlaylistAiResult>("claude_playlist_batch", {
              pool: poolInputs,
              instructions,
              sets: setSpecs,
              model: settings.claudeTasks.playlist.model || null,
              effort: settings.claudeTasks.playlist.effort || null,
            })
          : await invoke<PlaylistAiResult>("ai_playlist_batch", {
              url: settings.ollamaUrl,
              model: settings.ollamaModel,
              pool: poolInputs,
              instructions,
              sets: setSpecs,
            });
      applyResult(ai);
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setRunning(false);
    }
  };

  const parseManualPaste = async () => {
    try {
      const ai = await invoke<PlaylistAiResult>("ai_parse_playlist_response", {
        text: manualPasteText,
        poolIds: manualPoolIds,
      });
      applyResult(ai);
      setManualPrompt(null);
    } catch (e) {
      notify(String(e), "error");
    }
  };

  const activeSetName = result?.sets[activeSetIdx]?.name;
  const activePaths = activeSetName ? setPaths[activeSetName] ?? [] : [];

  const moveTrack = (idx: number, dir: -1 | 1) => {
    if (!activeSetName) return;
    const arr = [...(setPaths[activeSetName] ?? [])];
    const j = idx + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[idx], arr[j]] = [arr[j], arr[idx]];
    setSetPaths({ ...setPaths, [activeSetName]: arr });
  };

  const removeTrack = (path: string) => {
    if (!activeSetName) return;
    setSetPaths({ ...setPaths, [activeSetName]: (setPaths[activeSetName] ?? []).filter((p) => p !== path) });
  };

  const addResults = useMemo(() => {
    if (!addQuery.trim()) return [];
    return searchTracks(files, tags, addQuery, 20);
  }, [addQuery, files, tags]);

  const addTrack = (path: string) => {
    if (!activeSetName) return;
    const existing = setPaths[activeSetName] ?? [];
    if (existing.includes(path)) return;
    setSetPaths({ ...setPaths, [activeSetName]: [...existing, path] });
  };

  const exportSet = async (kind: "m3u8" | "rekordbox", setName: string, index: number) => {
    const paths = setPaths[setName] ?? [];
    if (!paths.length) return;
    const base = sanitizeFilenamePart(`${instructions.slice(0, 30) || "AI Playlist"} - ${index + 1} ${setName}`);
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
    try {
      const filesByPath: Record<string, AudioFile> = {};
      for (const f of files) filesByPath[f.path] = f;
      const contents =
        kind === "m3u8"
          ? buildM3u8(paths, filesByPath, tags)
          : buildRekordboxPlaylistXml(`${base}`, paths, filesByPath, tags);
      await invoke("write_text_file", { path: dest, contents });
      notify(`Exported ${paths.length} track(s) to ${dest}`, "success");
      await revealItemInDir(dest);
    } catch (e) {
      notify(String(e), "error");
    }
  };

  const copySuggestionsForImport = async () => {
    try {
      await navigator.clipboard.writeText(suggestions.join("\n"));
      notify("Copied — paste into the YouTube Music Import box to search for them.", "success");
    } catch (e) {
      notify(String(e), "error");
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-6">
      <div>
        <h1 className="text-xl font-bold">AI Playlists</h1>
        <p className="text-sm text-muted-foreground">
          Built from your Library only ({tracks.length} track{tracks.length === 1 ? "" : "s"}) — never the
          working batch.
        </p>
      </div>

      <Card>
        <CardHeader title="Filter the pool" hint="Narrows which Library tracks the AI even sees" />
        <div className="grid grid-cols-2 gap-3 px-5 py-3 sm:grid-cols-3">
          <div className="col-span-2 sm:col-span-3">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Genres</label>
            <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
              {genres.map((g) => {
                const active = selectedGenres.includes(g.name);
                return (
                  <button
                    key={g.name}
                    onClick={() =>
                      setSelectedGenres(
                        active ? selectedGenres.filter((x) => x !== g.name) : [...selectedGenres, g.name],
                      )
                    }
                    className={cn(
                      "rounded-md border px-2 py-0.5 text-xs",
                      active ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background",
                    )}
                  >
                    {g.name} ({g.count})
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Year</label>
            <div className="flex items-center gap-1">
              <input className={cn(inputClass, "w-16")} placeholder="from" value={yearFrom} onChange={(e) => setYearFrom(e.target.value)} />
              <span>–</span>
              <input className={cn(inputClass, "w-16")} placeholder="to" value={yearTo} onChange={(e) => setYearTo(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">BPM</label>
            <div className="flex items-center gap-1">
              <input className={cn(inputClass, "w-16")} placeholder="from" value={bpmFrom} onChange={(e) => setBpmFrom(e.target.value)} />
              <span>–</span>
              <input className={cn(inputClass, "w-16")} placeholder="to" value={bpmTo} onChange={(e) => setBpmTo(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Key</label>
            <input className={cn(inputClass, "w-20")} placeholder="e.g. Am" value={keyFilter} onChange={(e) => setKeyFilter(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Artist includes</label>
            <input className={inputClass} value={artistInclude} onChange={(e) => setArtistInclude(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Artist excludes</label>
            <input className={inputClass} value={artistExclude} onChange={(e) => setArtistExclude(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Min rating</label>
            <input type="number" min={0} max={5} className={cn(inputClass, "w-16")} value={minRating} onChange={(e) => setMinRating(e.target.value)} />
          </div>
          <div className="col-span-2 sm:col-span-3">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Exclude paths already in another playlist — one per line (paste from Copy path)
            </label>
            <textarea
              className={cn(inputClass, "h-14 w-full font-mono text-xs")}
              value={excludePathsText}
              onChange={(e) => setExcludePathsText(e.target.value)}
            />
          </div>
        </div>
        <div className="border-t px-5 py-2 text-xs text-muted-foreground">
          {tooLarge ? (
            <span className="text-destructive">
              {pool.length} tracks match — too many for one prompt. Narrow the filters to {POOL_LIMIT} or fewer.
            </span>
          ) : (
            <>{pool.length} track{pool.length === 1 ? "" : "s"} match the filters.</>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Instructions" hint='Free text, e.g. "wedding dance floor, no explicit lyrics"' />
        <div className="px-5 py-3">
          <textarea
            className={cn(inputClass, "h-20 w-full")}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="wedding dance floor, no explicit lyrics"
          />
        </div>
      </Card>

      <Card>
        <CardHeader title="Split into sets" />
        <div className="flex flex-wrap items-center gap-2 px-5 py-3">
          {SET_PRESETS.map((p, i) => (
            <button
              key={p.label}
              onClick={() => setPresetIdx(i)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs font-medium",
                presetIdx === i ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background",
              )}
            >
              {p.label}
            </button>
          ))}
          <button
            onClick={() => setPresetIdx(-1)}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs font-medium",
              presetIdx === -1 ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background",
            )}
          >
            Custom
          </button>
          {presetIdx === -1 && (
            <input
              className={cn(inputClass, "w-80")}
              value={customSetsText}
              onChange={(e) => setCustomSetsText(e.target.value)}
              placeholder="start, warm-up, peak"
            />
          )}
        </div>
      </Card>

      <div>
        <Button onClick={generate} disabled={running || !pool.length || tooLarge}>
          {running ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {running ? "Generating…" : "Generate playlists"}
        </Button>
      </div>

      {manualPrompt !== null && (
        <Card>
          <CardHeader title="Manual — paste into any AI" />
          <div className="space-y-2 px-5 py-3">
            <textarea readOnly className={cn(inputClass, "h-40 w-full font-mono text-xs")} value={manualPrompt} />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => navigator.clipboard.writeText(manualPrompt)}
            >
              <Clipboard /> Copy prompt
            </Button>
            <label className="block text-xs font-medium text-muted-foreground">Paste the answer here</label>
            <textarea
              className={cn(inputClass, "h-32 w-full font-mono text-xs")}
              value={manualPasteText}
              onChange={(e) => setManualPasteText(e.target.value)}
            />
            <Button size="sm" onClick={parseManualPaste} disabled={!manualPasteText.trim()}>
              Parse answer
            </Button>
          </div>
        </Card>
      )}

      {result && (
        <Card>
          <CardHeader
            title="Result"
            hint={
              result.droppedUnknownIds > 0
                ? `${result.droppedUnknownIds} id(s) the AI invented were dropped`
                : undefined
            }
          />
          <div className="flex flex-wrap gap-1.5 border-b px-5 py-2">
            {result.sets.map((s, i) => (
              <button
                key={s.name}
                onClick={() => setActiveSetIdx(i)}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs font-medium",
                  i === activeSetIdx ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background",
                )}
              >
                {s.name} ({(setPaths[s.name] ?? []).length})
              </button>
            ))}
          </div>
          <div className="px-5 py-3">
            <div className="mb-2 flex items-center gap-2">
              <input
                className={cn(inputClass, "flex-1")}
                placeholder="Add from your Library…"
                value={addQuery}
                onChange={(e) => setAddQuery(e.target.value)}
              />
            </div>
            {addQuery.trim() && (
              <div className="mb-3 max-h-40 space-y-1 overflow-y-auto rounded-md border p-1.5">
                {addResults.length === 0 ? (
                  <p className="px-1.5 text-xs text-muted-foreground">No matches.</p>
                ) : (
                  addResults.map((r) => (
                    <button
                      key={r.file.path}
                      onClick={() => addTrack(r.file.path)}
                      className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-accent"
                    >
                      <span className="min-w-0 truncate">
                        {tags[r.file.path]?.artist || "?"} – {tags[r.file.path]?.title || r.file.filename}
                      </span>
                      <Plus className="h-3 w-3 shrink-0" />
                    </button>
                  ))
                )}
              </div>
            )}
            <div className="space-y-1">
              {activePaths.length === 0 ? (
                <p className="text-xs text-muted-foreground">No tracks in this set yet.</p>
              ) : (
                activePaths.map((path, i) => (
                  <div
                    key={path}
                    onContextMenu={(e) => openMenu(e, [path])}
                    className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent"
                  >
                    <span className="w-6 shrink-0 text-right text-xs text-muted-foreground">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate">
                      {tags[path]?.artist || "?"} – {tags[path]?.title || path}
                    </span>
                    <button className="text-muted-foreground hover:text-foreground" onClick={() => moveTrack(i, -1)} disabled={i === 0}>
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => moveTrack(i, 1)}
                      disabled={i === activePaths.length - 1}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </button>
                    <button className="text-muted-foreground hover:text-destructive" onClick={() => removeTrack(path)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
            {activeSetName && (
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => exportSet("m3u8", activeSetName, activeSetIdx)}>
                  <Download /> Export .m3u8
                </Button>
                <Button size="sm" variant="secondary" onClick={() => exportSet("rekordbox", activeSetName, activeSetIdx)}>
                  <ListMusic /> Export Rekordbox XML
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}

      {suggestions.length > 0 && (
        <Card>
          <CardHeader
            title="Suggested to add"
            hint="AI suggestions — not in your Library. Not real tracks until you find and import them."
          />
          <div className="space-y-1 px-5 py-3">
            {suggestions.map((s) => (
              <div key={s} className="flex items-center justify-between gap-2 rounded-md bg-secondary/30 px-2 py-1 text-sm">
                <span className="min-w-0 truncate">{s}</span>
              </div>
            ))}
            <Button size="sm" variant="ghost" className="mt-1" onClick={copySuggestionsForImport}>
              <Clipboard /> Copy for YouTube Music Import
            </Button>
          </div>
        </Card>
      )}

      {menu &&
        (() => {
          const items = trackMenuItems({ paths: menu.paths, onAddToBatch, onInspect });
          return <TrackContextMenu menu={menu} items={items} onRun={runMenuAction} />;
        })()}
    </div>
  );
}
