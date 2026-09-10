import { useCallback, useEffect, useRef, useState } from "react";
import { load, type Store } from "@tauri-apps/plugin-store";
import type { Settings } from "../types";
import { DEFAULT_FLAG_EXTRA_CHARS, DEFAULT_REPLACEMENTS } from "../lib/standardize";
import { DEFAULT_GENRE_PRESETS } from "../lib/genres";

export const CURRENT_SETTINGS_VERSION = 6;

export const DEFAULT_SETTINGS: Settings = {
  aiBackend: "ollama",
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "",
  batchSize: 50,
  backupBeforeChanges: true,
  preserveCoverArt: true,
  autoUpdate: true,
  artworkMaxDim: 600,
  artworkJpegQuality: 85,
  recursive: true,
  searchableBackup: true,
  backupField: "Composer",
  djApp: { primary: "other", secondary: "other" },
  lastFolder: "",
  theme: "dark",
  visibleColumns: [
    "preview",
    "filename",
    "title",
    "artist",
    "album",
    "year",
    "genre",
    "rating",
    "trackNumber",
    "trackId",
  ],
  columnWidths: {},
  rowHeight: "normal",
  sidebarWidth: 220,
  sidebarCollapsed: false,
  replacements: DEFAULT_REPLACEMENTS,
  capitalization: "asis",
  highlightSymbols: false,
  flagExtraChars: DEFAULT_FLAG_EXTRA_CHARS,
  fieldNaming: "friendly",
  removeChars: ",.",
  genrePresets: DEFAULT_GENRE_PRESETS,
  activeGenrePreset: "Sergio Alexo",
  nextTrackId: 0,
  trackIdDigits: 6,
  strictFilenames: true,
  clearFields: ["album"],
  transliterateScripts: [],
  settingsVersion: CURRENT_SETTINGS_VERSION,
  shortcuts: {},
  usage: { totalPromptTokens: 0, totalCompletionTokens: 0, totalCalls: 0, songsProcessed: 0 },
  plan: { tier: "free", creditsTotal: 5000 },
  standardizeFields: ["title", "artist", "album", "albumArtist"],
  standardizeFilename: false,
  manualChunkSize: 50,
  convertPreset: "mp3-320",
  convertOutput: "alongside",
};

const STORE_FILE = "settings.json";

/**
 * Brings older saved settings up to date. v2 ensures the Preview and Rating
 * columns (added after some users' settings were first saved) are visible.
 * v3 retires the never-shipped "claude" backend in favour of "manual".
 * v4 adds the dedicated "Track ID" column (Generate IDs no longer writes to
 * Track Number). v5 adds Convert defaults (`convertPreset`, `convertOutput`) —
 * both already filled in by the `{ ...DEFAULT_SETTINGS, ...saved }` merge, so
 * this bump only records that the shape grew. v6 retires "Strip to common
 * tags only" along with the Clean Tags action, and lowers the artwork target.
 */
export function migrate(s: Settings, savedVersion: number): Settings {
  const next = { ...s };
  if (savedVersion < 2) {
    const cols = [...next.visibleColumns];
    if (!cols.includes("preview")) cols.unshift("preview");
    if (!cols.includes("rating")) {
      const gi = cols.indexOf("genre");
      if (gi >= 0) cols.splice(gi + 1, 0, "rating");
      else cols.push("rating");
    }
    next.visibleColumns = cols;
  }
  if (savedVersion < 3 && next.aiBackend !== "ollama" && next.aiBackend !== "manual") {
    next.aiBackend = "ollama";
  }
  if (savedVersion < 4 && !next.visibleColumns.includes("trackId")) {
    const cols = [...next.visibleColumns];
    const ti = cols.indexOf("trackNumber");
    if (ti >= 0) cols.splice(ti + 1, 0, "trackId");
    else cols.push("trackId");
    next.visibleColumns = cols;
  }
  if (savedVersion < 6) {
    // "Strip to common tags only" is gone: nothing removes tag fields
    // silently any more, only an explicit Clear Fields run. Drop the stored
    // flag so it can't linger in the settings file.
    delete (next as unknown as Record<string, unknown>).stripToCommon;
    // Lower the artwork target to the new 600px default, but only for users
    // still on the old default — a deliberately chosen size is left alone.
    if (next.artworkMaxDim === 1000) next.artworkMaxDim = DEFAULT_SETTINGS.artworkMaxDim;
  }
  next.settingsVersion = CURRENT_SETTINGS_VERSION;
  return next;
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const storeRef = useRef<Store | null>(null);
  // Mirrors the newest settings *synchronously*, before React re-renders, so
  // back-to-back writers (e.g. a burst of ai-usage events) each build on the
  // previous value instead of all reading the same stale render snapshot.
  const latestRef = useRef(settings);

  useEffect(() => {
    (async () => {
      try {
        const store = await load(STORE_FILE);
        storeRef.current = store;
        const saved = await store.get<Partial<Settings>>("settings");
        if (saved) {
          const merged = { ...DEFAULT_SETTINGS, ...saved };
          const savedVersion = saved.settingsVersion ?? 1;
          const next =
            savedVersion < CURRENT_SETTINGS_VERSION ? migrate(merged, savedVersion) : merged;
          latestRef.current = next;
          setSettings(next);
          if (savedVersion < CURRENT_SETTINGS_VERSION) {
            await store.set("settings", next);
            await store.save();
          }
        }
      } catch (e) {
        console.error("Failed to load settings:", e);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const save = useCallback(async (next: Settings) => {
    latestRef.current = next;
    setSettings(next);
    try {
      const store = storeRef.current ?? (storeRef.current = await load(STORE_FILE));
      await store.set("settings", next);
      await store.save();
    } catch (e) {
      console.error("Failed to save settings:", e);
    }
  }, []);

  /**
   * Read-modify-write against the newest settings rather than a render
   * snapshot. Use this for anything that accumulates (usage counters), where
   * two events firing between renders would otherwise clobber each other.
   */
  const update = useCallback(
    (fn: (prev: Settings) => Settings) => save(fn(latestRef.current)),
    [save],
  );

  return { settings, save, update, loaded };
}
