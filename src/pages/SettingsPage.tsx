import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, PlugZap, X } from "lucide-react";
import type {
  Capitalization,
  CharReplacement,
  GenrePreset,
  OllamaStatus,
  Settings,
} from "../types";
import { CLEARABLE_FIELDS, FIELD_LABELS, TRANSLITERATE_SCRIPTS } from "../types";
import { Badge, Button, Card, CardHeader, Row, cn, inputClass, selectClass } from "../components/ui";
import { Combobox } from "../components/Combobox";

interface Props {
  settings: Settings;
  onSave: (settings: Settings) => void;
  checkOllama: (url: string) => Promise<OllamaStatus>;
}

const BATCH_SIZES = [10, 25, 50, 100];

const CAP_OPTIONS: { value: Capitalization; label: string }[] = [
  { value: "asis", label: "Leave as is" },
  { value: "upper", label: "AA" },
  { value: "title", label: "Aa" },
  { value: "lower", label: "aa" },
];

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 rounded-full transition-colors",
        checked ? "bg-primary" : "bg-input",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all",
          checked ? "left-[18px]" : "left-0.5",
        )}
      />
    </button>
  );
}

export function SettingsPage({ settings, onSave, checkOllama }: Props) {
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [url, setUrl] = useState(settings.ollamaUrl);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptText, setPromptText] = useState("");
  const [promptLoading, setPromptLoading] = useState(false);

  const viewPrompt = async () => {
    setPromptOpen(true);
    setPromptLoading(true);
    try {
      const text = await invoke<string>("ai_preview_prompt", {
        transliterateScripts: settings.transliterateScripts,
      });
      setPromptText(text);
    } catch (e) {
      setPromptText(`Could not load the prompt: ${e}`);
    } finally {
      setPromptLoading(false);
    }
  };

  const toggleScript = (id: string) =>
    set(
      "transliterateScripts",
      settings.transliterateScripts.includes(id)
        ? settings.transliterateScripts.filter((s) => s !== id)
        : [...settings.transliterateScripts, id],
    );

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    onSave({ ...settings, [key]: value });

  // Genre-preset editing (keyed by index so renames are safe).
  const gIdx = Math.max(
    0,
    settings.genrePresets.findIndex((p) => p.name === settings.activeGenrePreset),
  );
  const gPreset: GenrePreset = settings.genrePresets[gIdx] ?? settings.genrePresets[0];
  const updateGenres = (genres: string[]) =>
    set(
      "genrePresets",
      settings.genrePresets.map((p, i) => (i === gIdx ? { ...p, genres } : p)),
    );
  const renamePreset = (name: string) =>
    onSave({
      ...settings,
      activeGenrePreset: name,
      genrePresets: settings.genrePresets.map((p, i) => (i === gIdx ? { ...p, name } : p)),
    });
  const addPreset = () => {
    const name = `Preset ${settings.genrePresets.length + 1}`;
    onSave({
      ...settings,
      genrePresets: [...settings.genrePresets, { name, genres: [] }],
      activeGenrePreset: name,
    });
  };
  const deletePreset = () => {
    if (settings.genrePresets.length <= 1) return;
    const next = settings.genrePresets.filter((_, i) => i !== gIdx);
    onSave({ ...settings, genrePresets: next, activeGenrePreset: next[0].name });
  };

  const test = async (u: string) => {
    setTesting(true);
    const result = await checkOllama(u);
    setStatus(result);
    setTesting(false);
    if (result.running && result.models.length && !result.models.includes(settings.ollamaModel)) {
      onSave({ ...settings, ollamaUrl: u, ollamaModel: result.models[0] });
    }
  };

  useEffect(() => {
    test(settings.ollamaUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div>
        <h1 className="text-xl font-bold">Settings</h1>
        <p className="text-sm text-muted-foreground">Changes apply immediately</p>
      </div>

      <Card>
        <CardHeader title="AI Backend" />
        <div className="px-5 py-2">
          <Row label="Local (Ollama)" hint="Runs entirely on this machine">
            <input
              type="radio"
              name="backend"
              className="accent-[var(--primary)]"
              checked={settings.aiBackend === "ollama"}
              onChange={() => set("aiBackend", "ollama")}
            />
          </Row>
          <div
            className="cursor-not-allowed opacity-50"
            title="Claude API integration coming in a future update"
          >
            <Row label="Claude API" hint="Cloud-based cleanup">
              <span className="flex items-center gap-2">
                <Badge className="bg-secondary text-amber-500">Coming Soon</Badge>
                <input type="radio" name="backend" disabled />
              </span>
            </Row>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Ollama" />
        <div className="px-5 py-3">
          <Row label="URL">
            <input
              type="text"
              className={cn(inputClass, "w-64")}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => set("ollamaUrl", url)}
            />
          </Row>
          <Row label="Model" hint="Type to filter installed models">
            {status?.running && status.models.length > 0 ? (
              <Combobox
                className="w-64"
                value={settings.ollamaModel}
                options={status.models}
                allowCustom
                onChange={(v) => set("ollamaModel", v)}
                placeholder="Select a model"
              />
            ) : (
              <input
                type="text"
                className={cn(inputClass, "w-64")}
                placeholder="e.g. deepseek-r1:14b"
                value={settings.ollamaModel}
                onChange={(e) => set("ollamaModel", e.target.value)}
              />
            )}
          </Row>
          <Row label="Connection">
            <Button variant="secondary" size="sm" onClick={() => test(url)} disabled={testing}>
              <PlugZap />
              {testing ? "Testing…" : "Test Connection"}
            </Button>
          </Row>
          {status && (
            <p className={cn("pb-2 text-xs", status.running ? "text-primary" : "text-destructive")}>
              {status.running
                ? `✅ Ollama running — ${status.models.length} model${
                    status.models.length === 1 ? "" : "s"
                  } found`
                : `❌ Ollama not detected${
                    status.error ? ` (${status.error})` : ""
                  }. Make sure Ollama is running locally. Download at ollama.com`}
            </p>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="AI Clean"
          hint="What the AI Clean button actually does to Artist, Title, Year, and Genre"
        />
        <div className="px-5 py-2">
          <Row label="See the exact instructions" hint="The real prompt sent to the model, not a summary">
            <Button variant="secondary" size="sm" onClick={viewPrompt}>
              View AI instructions
            </Button>
          </Row>
          <div className="border-t py-3">
            <div className="mb-1 text-sm font-medium">Foreign alphabets</div>
            <p className="mb-2 text-xs text-muted-foreground">
              For scripts you check here, AI Clean transliterates Artist/Title into Latin letters
              (phonetic spelling) instead of keeping the original script — handy if you can't read
              it yourself. Unchecked scripts are always preserved exactly as written.
            </p>
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              {TRANSLITERATE_SCRIPTS.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm" title={s.hint}>
                  <input
                    type="checkbox"
                    className="accent-[var(--primary)]"
                    checked={settings.transliterateScripts.includes(s.id)}
                    onChange={() => toggleScript(s.id)}
                  />
                  {s.label}
                </label>
              ))}
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Tag Processing" />
        <div className="px-5 py-2">
          <Row
            label="Backup original tags before changes"
            hint="Full JSON snapshot stored inside the file (TAGBACKUP_v1)"
          >
            <Toggle
              checked={settings.backupBeforeChanges}
              onChange={(v) => set("backupBeforeChanges", v)}
            />
          </Row>
          <Row
            label="Searchable backup"
            hint='Writes "file name - artist - title - year" into a chosen field before the first change'
          >
            <Toggle
              checked={settings.searchableBackup}
              onChange={(v) => set("searchableBackup", v)}
            />
          </Row>
          {settings.searchableBackup && (
            <Row label="Backup field" hint="An existing value here is never overwritten">
              <select
                className={cn(selectClass, "w-40")}
                value={settings.backupField}
                onChange={(e) => set("backupField", e.target.value as Settings["backupField"])}
              >
                <option value="Composer">Composer</option>
                <option value="OriginalArtist">Original Artist</option>
                <option value="Comment">Comment</option>
              </select>
            </Row>
          )}
          <Row label="Strip to common tags only">
            <Toggle checked={settings.stripToCommon} onChange={(v) => set("stripToCommon", v)} />
          </Row>
          <Row label="Preserve embedded cover art">
            <Toggle
              checked={settings.preserveCoverArt}
              onChange={(v) => set("preserveCoverArt", v)}
            />
          </Row>
          <Row label="Process subdirectories recursively">
            <Toggle checked={settings.recursive} onChange={(v) => set("recursive", v)} />
          </Row>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Standardization"
          hint="Used by the Standardize action on Title & Artist"
        />
        <div className="px-5 py-2">
          <Row
            label="Highlight unusual symbols"
            hint="Flags characters like & $ ! in Title/Artist so you can filter them"
          >
            <Toggle
              checked={settings.highlightSymbols}
              onChange={(v) => set("highlightSymbols", v)}
            />
          </Row>
          <Row label="Capitalization" hint="How to re-case values when standardizing">
            <div className="flex gap-1">
              {CAP_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  onClick={() => set("capitalization", o.value)}
                  className={cn(
                    "h-8 rounded-md px-3 text-xs font-medium transition-colors",
                    settings.capitalization === o.value
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-secondary-foreground hover:bg-accent",
                  )}
                  title={
                    o.value === "upper"
                      ? "UPPERCASE"
                      : o.value === "title"
                        ? "Title Case"
                        : o.value === "lower"
                          ? "lowercase"
                          : "Leave as is"
                  }
                >
                  {o.label}
                </button>
              ))}
            </div>
          </Row>

          <Row
            label="Characters to remove"
            hint='The "Remove" button deletes each of these characters'
          >
            <input
              className={cn(inputClass, "w-40 text-center font-mono")}
              value={settings.removeChars}
              placeholder=",."
              onChange={(e) => set("removeChars", e.target.value)}
            />
          </Row>

          <div className="border-t py-3">
            <div className="mb-2 text-sm font-medium">Character replacements</div>
            <div className="space-y-2">
              {settings.replacements.map((r: CharReplacement, i: number) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    className={cn(inputClass, "h-8 w-16 text-center")}
                    value={r.from}
                    maxLength={4}
                    placeholder="&"
                    onChange={(e) =>
                      set(
                        "replacements",
                        settings.replacements.map((x, idx) =>
                          idx === i ? { ...x, from: e.target.value } : x,
                        ),
                      )
                    }
                  />
                  <span className="text-muted-foreground">→</span>
                  <input
                    className={cn(inputClass, "h-8 w-16 text-center")}
                    value={r.to}
                    maxLength={8}
                    placeholder="N"
                    onChange={(e) =>
                      set(
                        "replacements",
                        settings.replacements.map((x, idx) =>
                          idx === i ? { ...x, to: e.target.value } : x,
                        ),
                      )
                    }
                  />
                  <div className="ml-auto flex items-center gap-2">
                    <Toggle
                      checked={r.enabled}
                      onChange={(v) =>
                        set(
                          "replacements",
                          settings.replacements.map((x, idx) =>
                            idx === i ? { ...x, enabled: v } : x,
                          ),
                        )
                      }
                    />
                    <button
                      className="text-muted-foreground hover:text-destructive"
                      title="Remove rule"
                      onClick={() =>
                        set(
                          "replacements",
                          settings.replacements.filter((_, idx) => idx !== i),
                        )
                      }
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() =>
                set("replacements", [
                  ...settings.replacements,
                  { from: "", to: "", enabled: true },
                ])
              }
            >
              <Plus />
              Add rule
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Clear Fields"
          hint="The Clear Fields button erases these fields on the selected tracks"
        />
        <div className="flex flex-wrap gap-x-6 gap-y-1 px-5 py-3">
          {CLEARABLE_FIELDS.map((f) => (
            <label key={f} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="accent-[var(--primary)]"
                checked={settings.clearFields.includes(f)}
                onChange={(e) =>
                  set(
                    "clearFields",
                    e.target.checked
                      ? [...settings.clearFields, f]
                      : settings.clearFields.filter((x) => x !== f),
                  )
                }
              />
              {FIELD_LABELS[f] ?? f}
            </label>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Genre Presets"
          hint="The Genre button snaps each track's genre to the active preset"
        />
        <div className="px-5 py-3">
          <Row label="Active preset" hint="Used by the Genre action and the genre dropdown">
            <div className="flex items-center gap-2">
              <select
                className={cn(selectClass, "w-44")}
                value={settings.activeGenrePreset}
                onChange={(e) => set("activeGenrePreset", e.target.value)}
              >
                {settings.genrePresets.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
              <Button variant="ghost" size="sm" onClick={addPreset} title="Add a new preset">
                <Plus />
              </Button>
              <button
                className="text-muted-foreground hover:text-destructive disabled:opacity-30"
                onClick={deletePreset}
                disabled={settings.genrePresets.length <= 1}
                title="Delete this preset"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </Row>
          <Row label="Preset name">
            <input
              className={cn(inputClass, "w-44")}
              value={gPreset.name}
              onChange={(e) => renamePreset(e.target.value)}
            />
          </Row>

          <div className="border-t py-3">
            <div className="mb-2 text-sm font-medium">Genres in "{gPreset.name}"</div>
            <div className="space-y-2">
              {gPreset.genres.map((g, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    className={cn(inputClass, "h-8 flex-1")}
                    value={g}
                    onChange={(e) =>
                      updateGenres(gPreset.genres.map((x, idx) => (idx === i ? e.target.value : x)))
                    }
                  />
                  <button
                    className="text-muted-foreground hover:text-destructive"
                    title="Remove genre"
                    onClick={() => updateGenres(gPreset.genres.filter((_, idx) => idx !== i))}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
              {gPreset.genres.length === 0 && (
                <p className="text-xs text-muted-foreground">No genres yet — add one below.</p>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => updateGenres([...gPreset.genres, ""])}
            >
              <Plus />
              Add genre
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Track IDs" hint="Sequential 6-digit IDs written to the Track # field" />
        <div className="px-5 py-3">
          <Row
            label="Next track ID"
            hint="The next number Generate IDs will assign — reset it to regenerate"
          >
            <input
              type="number"
              min={0}
              max={999999}
              className={cn(inputClass, "w-28 text-center font-mono")}
              value={settings.nextTrackId}
              onChange={(e) => set("nextTrackId", Math.max(0, Number(e.target.value) || 0))}
            />
          </Row>
        </div>
      </Card>

      <Card>
        <CardHeader title="AI Batch Size" hint="Tracks sent per Ollama call" />
        <div className="px-5 py-3">
          <Row label="Batch size">
            <select
              className={cn(selectClass, "w-24")}
              value={settings.batchSize}
              onChange={(e) => set("batchSize", Number(e.target.value))}
            >
              {BATCH_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Row>
        </div>
      </Card>
    </div>

    {promptOpen && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
        onClick={() => setPromptOpen(false)}
      >
        <Card className="max-h-[85vh] w-[700px] overflow-y-auto">
          <div onClick={(e) => e.stopPropagation()} className="p-5">
            <div className="mb-1 flex items-start justify-between gap-4">
              <h2 className="text-sm font-semibold">Exact AI Clean instructions</h2>
              <button
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setPromptOpen(false)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mb-4 text-xs text-muted-foreground">
              This is the literal system prompt sent to the model for every AI Clean run, including
              your current foreign-alphabet choices above. The track list (filename, artist, title,
              year, genre) is appended after it.
            </p>
            {promptLoading ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : (
              <pre className="whitespace-pre-wrap rounded-md border bg-secondary/40 p-3 text-xs">
                {promptText}
              </pre>
            )}
          </div>
        </Card>
      </div>
    )}
    </>
  );
}
