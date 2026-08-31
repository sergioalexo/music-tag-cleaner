import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Trash2 } from "lucide-react";
import { CLEARABLE_FIELDS, FIELD_LABELS } from "../types";
import { Button, cn } from "./ui";

interface Props {
  /** Persisted last-used selection (`settings.clearFields`); may contain `raw:KEY` entries. */
  selected: string[];
  /** Extra tag-frame keys present on the current file selection (from `allFields`). */
  rawKeys: string[];
  disabled?: boolean;
  /** Curated field key that currently holds the searchable backup, or "" if none. */
  backupFieldKey?: string;
  /** Runs Clear Fields with `fields` and stores it as the new default. */
  onRun: (fields: string[]) => void;
}

const RAW_PREFIX = "raw:";

/**
 * Split button for the Clear Fields action. The left half runs immediately with
 * the remembered field set; the caret opens a checklist to change it. Changing
 * the set and running it makes that set the new default (the parent persists
 * `onRun`'s argument to settings).
 */
export function ClearFieldsMenu({ selected, rawKeys, disabled, backupFieldKey, onRun }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(selected);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Re-seed the checklist from the saved selection each time the menu opens.
  useEffect(() => {
    if (open) setDraft(selected);
  }, [open, selected]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => {
      if (wrapRef.current) setRect(wrapRef.current.getBoundingClientRect());
    };
    reposition();
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrapRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open]);

  const toggle = (key: string) =>
    setDraft((d) => (d.includes(key) ? d.filter((k) => k !== key) : [...d, key]));

  const run = (fields: string[]) => {
    setOpen(false);
    onRun(fields);
  };

  const summary =
    selected.length === 0
      ? "no fields chosen"
      : selected
          .map((k) => (k.startsWith(RAW_PREFIX) ? k.slice(RAW_PREFIX.length) : FIELD_LABELS[k] ?? k))
          .join(", ");

  const rawOptions = rawKeys.map((k) => RAW_PREFIX + k);

  return (
    <div ref={wrapRef} className="relative inline-flex">
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled || selected.length === 0}
        onClick={() => run(selected)}
        title={`Erase these fields: ${summary}`}
        className="rounded-r-none"
      >
        <Trash2 />
        Clear Fields
      </Button>
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title="Choose which fields to clear"
        className="rounded-l-none border-l border-border/60 px-1.5"
        aria-label="Choose which fields to clear"
      >
        <ChevronDown />
      </Button>

      {open &&
        rect &&
        createPortal(
          <div
            ref={popRef}
            className="z-[100] w-64 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg"
            style={{ position: "fixed", top: rect.bottom + 4, left: Math.max(8, rect.right - 256) }}
          >
            <p className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">Fields</p>
            {CLEARABLE_FIELDS.map((f) => (
              <Option
                key={f}
                label={FIELD_LABELS[f] ?? f}
                note={backupFieldKey && f === backupFieldKey ? "holds your backup" : undefined}
                checked={draft.includes(f)}
                onChange={() => toggle(f)}
              />
            ))}

            {rawOptions.length > 0 && (
              <>
                <p className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">
                  Other tags on the selection
                </p>
                <div className="max-h-48 overflow-y-auto">
                  {rawOptions.map((k) => (
                    <Option
                      key={k}
                      label={k.slice(RAW_PREFIX.length)}
                      checked={draft.includes(k)}
                      onChange={() => toggle(k)}
                    />
                  ))}
                </div>
              </>
            )}

            <div className="mt-1 border-t p-1">
              <Button
                size="sm"
                className="w-full"
                disabled={draft.length === 0}
                onClick={() => run(draft)}
              >
                Clear selected {draft.length > 0 ? `(${draft.length})` : ""}
              </Button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

function Option({
  label,
  note,
  checked,
  onChange,
}: {
  label: string;
  note?: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/60",
      )}
    >
      <input
        type="checkbox"
        className="accent-[var(--primary)]"
        checked={checked}
        onChange={onChange}
      />
      <span className="truncate">{label}</span>
      {note && <span className="ml-auto shrink-0 text-xs text-amber-500">{note}</span>}
    </label>
  );
}
