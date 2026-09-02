import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Type } from "lucide-react";
import { CAP_OPTIONS, type Capitalization } from "../types";
import { Button, cn } from "./ui";

interface Props {
  /** Persisted last-used mode (`settings.capitalization`). */
  mode: Capitalization;
  disabled?: boolean;
  /** Runs capitalization with `mode` and stores it as the new default. */
  onRun: (mode: Capitalization) => void;
}

/**
 * Split button for the Capitalization action, pulled out of the old
 * do-everything Standardize button. The left half re-runs the remembered
 * mode; the caret opens a one-click list of the other modes — picking one
 * runs it immediately and becomes the new remembered default, same pattern
 * as `ClearFieldsMenu`.
 */
export function CapitalizationMenu({ mode, disabled, onRun }: Props) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

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

  const current = CAP_OPTIONS.find((o) => o.value === mode) ?? CAP_OPTIONS[0];

  const run = (m: Capitalization) => {
    setOpen(false);
    onRun(m);
  };

  return (
    <div ref={wrapRef} className="relative inline-flex">
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled}
        onClick={() => run(mode)}
        title={`Capitalization: ${current.label}`}
        className="rounded-r-none"
      >
        <Type />
        Capitalization: {current.label}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title="Choose a capitalization mode"
        className="rounded-l-none border-l border-border/60 px-1.5"
        aria-label="Choose a capitalization mode"
      >
        <ChevronDown />
      </Button>

      {open &&
        rect &&
        createPortal(
          <div
            ref={popRef}
            className="z-[100] w-48 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg"
            style={{ position: "fixed", top: rect.bottom + 4, left: rect.left }}
          >
            {CAP_OPTIONS.map((o) => (
              <button
                key={o.value}
                onClick={() => run(o.value)}
                className={cn(
                  "flex w-full items-center rounded px-2 py-1.5 text-left text-sm hover:bg-accent/60",
                  o.value === mode && "bg-accent font-medium",
                )}
              >
                {o.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
