import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";
import type { Settings } from "../types";
import { DEFAULT_STEM_OPTIONS } from "../types";
import { DEFAULT_FLAG_EXTRA_CHARS, DEFAULT_REPLACEMENTS } from "../lib/standardize";

export const CURRENT_SETTINGS_VERSION = 14;

export const DEFAULT_SETTINGS: Settings = {
  aiBackend: "ollama",
  claudeTasks: {
    clean: { model: "sonnet", effort: "low" },
    playlist: { model: "sonnet", effort: "medium" },
  },
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
  libraryFolder: "",
  rekordboxXmlPath: "",
  rekordboxXmlMtime: 0,
  theme: "system",
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
  casingExceptions: [],
  highlightSymbols: false,
  flagExtraChars: DEFAULT_FLAG_EXTRA_CHARS,
  fieldNaming: "friendly",
  removeChars: ",.",
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
  stemOptions: DEFAULT_STEM_OPTIONS,
  genreClickInManualSession: "ask",
};

const STORE_FILE = "settings.json";

/** Replaces any non-finite numeric field of `obj` with the default's value. */
function sanitizeNumbers<T extends object>(obj: T | undefined, defaults: T): T {
  const out = { ...defaults, ...obj } as Record<string, unknown>;
  for (const [k, def] of Object.entries(defaults)) {
    if (typeof def === "number" && !Number.isFinite(out[k])) out[k] = def;
  }
  return out as T;
}

/**
 * Brings older saved settings up to date. v2 ensures the Preview and Rating
 * columns (added after some users' settings were first saved) are visible.
 * v3 retires the never-shipped "claude" backend in favour of "manual".
 * v4 adds the dedicated "Track ID" column (Generate IDs no longer writes to
 * Track Number). v5 adds Convert defaults (`convertPreset`, `convertOutput`) —
 * both already filled in by the `{ ...DEFAULT_SETTINGS, ...saved }` merge, so
 * this bump only records that the shape grew. v6 retires "Strip to common
 * tags only" along with the Clean Tags action, and lowers the artwork target.
 * v7 retires the manual theme toggle: the app follows the OS theme.
 * v8 retires the stored genre presets: the genre vocabulary is now derived
 * from the indexed library, so a remembered list can no longer drift from
 * the files. v9 adds Demucs stem-separation defaults (`stemOptions`), filled
 * in by the `{ ...DEFAULT_SETTINGS, ...saved }` merge. v10 adds
 * `casingExceptions` (user-defined tokens Capitalize/Title Case always
 * renders as-typed), same merge-fills-it-in bump. v11 adds `libraryFolder`
 * (the one permanent Library folder, replacing the old multi-root model) —
 * seeded from the first existing `library_root` row by the loader below,
 * since that needs an `invoke` call `migrate` itself can't make. v12 splits
 * the single `claudeModel` into a model+effort pair per AI task
 * (`claudeTasks.clean` / `.playlist`) — a non-empty old `claudeModel`
 * becomes the Clean task's model, keeping the Clean task's default effort.
 * v13 adds `rekordboxXmlPath`/`rekordboxXmlMtime` (D0), both filled in by the
 * `{ ...DEFAULT_SETTINGS, ...saved }` merge — no migration logic needed.
 * v14 adds `genreClickInManualSession` (the remembered answer to the genre
 * session dialog, default "ask"), filled in by the same merge.
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
  if (
    savedVersion < 3 &&
    next.aiBackend !== "ollama" &&
    next.aiBackend !== "manual" &&
    next.aiBackend !== "claude"
  ) {
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
  if (savedVersion < 7) {
    // The in-app theme toggle is gone; the app follows the OS instead.
    // Everyone moves to "system" — the old stored value was the default
    // "dark" for all but a deliberate toggle, and there is no longer any
    // UI that would let someone restore a pinned choice.
    next.theme = "system";
  }
  if (savedVersion < 8) {
    const legacy = next as unknown as Record<string, unknown>;
    delete legacy.genrePresets;
    delete legacy.activeGenrePreset;
  }
  if (savedVersion < 12) {
    const legacy = next as unknown as Record<string, unknown>;
    const oldModel = legacy.claudeModel;
    if (typeof oldModel === "string" && oldModel.trim()) {
      next.claudeTasks = {
        ...next.claudeTasks,
        clean: { ...next.claudeTasks.clean, model: oldModel },
      };
    }
    delete legacy.claudeModel;
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
          // The merge is shallow, so a saved `usage`/`plan` replaces the default
          // object wholesale. A counter that was once NaN is persisted as JSON
          // `null`, which later crashes `.toLocaleString()` on the Settings page.
          merged.usage = sanitizeNumbers(merged.usage, DEFAULT_SETTINGS.usage);
          merged.plan = { ...merged.plan, ...sanitizeNumbers(merged.plan, DEFAULT_SETTINGS.plan) };
          const savedVersion = saved.settingsVersion ?? 1;
          let next =
            savedVersion < CURRENT_SETTINGS_VERSION ? migrate(merged, savedVersion) : merged;
          let dirty = savedVersion < CURRENT_SETTINGS_VERSION;
          if (!next.libraryFolder) {
            // Seed from the first root the old multi-root index already had,
            // so upgrading never shows an empty Library when one was already
            // indexed under the previous model.
            try {
              const roots = await invoke<string[]>("library_roots");
              if (roots.length) {
                next = { ...next, libraryFolder: roots[0] };
                dirty = true;
              }
            } catch {
              // No index yet (fresh install) — App's first-launch prompt handles it.
            }
          }
          latestRef.current = next;
          setSettings(next);
          if (dirty) {
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
