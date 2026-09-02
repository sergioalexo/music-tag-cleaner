import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronsUpDown, Pencil, Plus, X } from "lucide-react";
import { cn } from "./ui";

interface Props {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  placeholder?: string;
  /** Allow committing a value that isn't in the list (free text). */
  allowCustom?: boolean;
  className?: string;
  autoFocus?: boolean;
  onClose?: () => void;
  /**
   * When set, typing a value with no exact match in `options` shows an
   * "Add …" row that both saves it here (e.g. into a preset) and commits it
   * as the current value.
   */
  onCreate?: (value: string) => void;
  /** When set, each option gets a pencil icon to rename it in place. */
  onEditOption?: (option: string, next: string) => void;
}

/**
 * A type-to-filter dropdown: shows the options, narrows them as you type, and
 * lets you pick with the mouse or keyboard. The option list is portaled to the
 * body with fixed positioning so it is never clipped by a scrolling table.
 */
export function Combobox({
  value,
  options,
  onChange,
  placeholder,
  allowCustom = false,
  className,
  autoFocus,
  onClose,
  onCreate,
  onEditOption,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [editingOption, setEditingOption] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const triggerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = query
    ? options.filter((o) => o.toLowerCase().includes(query.toLowerCase()))
    : options;
  const trimmedQuery = query.trim();
  const hasExactMatch = options.some((o) => o.toLowerCase() === trimmedQuery.toLowerCase());
  const canCreate = !!onCreate && trimmedQuery.length > 0 && !hasExactMatch;

  const reposition = () => {
    if (triggerRef.current) setRect(triggerRef.current.getBoundingClientRect());
  };

  const openList = () => {
    reposition();
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
      openList();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !listRef.current?.contains(t)) {
        setOpen(false);
        onClose?.();
      }
    };
    // Keep the portaled list aligned while the table scrolls.
    const onScrollResize = () => reposition();
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("scroll", onScrollResize, true);
    window.addEventListener("resize", onScrollResize);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("scroll", onScrollResize, true);
      window.removeEventListener("resize", onScrollResize);
    };
  }, [open, onClose]);

  const commit = (v: string) => {
    onChange(v);
    setQuery("");
    setOpen(false);
    onClose?.();
  };

  const create = (v: string) => {
    onCreate?.(v);
    commit(v);
  };

  const commitTyped = () => {
    const match = filtered[highlight];
    if (match) commit(match);
    else if (canCreate) create(trimmedQuery);
    else if (allowCustom) commit(query.trim() || value);
    else {
      setOpen(false);
      onClose?.();
    }
  };

  return (
    <div ref={triggerRef} className={cn("relative", className)}>
      <div
        className="flex h-8 cursor-text items-center gap-1 rounded-md border border-input bg-background px-2 text-xs shadow-sm focus-within:ring-1 focus-within:ring-ring"
        onClick={openList}
      >
        <input
          ref={inputRef}
          value={open ? query : value}
          placeholder={value || placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) openList();
            setHighlight(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              if (!open) openList();
              setHighlight((h) => Math.min(h + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => Math.max(h - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              commitTyped();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
              onClose?.();
            }
          }}
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
        />
        {allowCustom && value && (
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              onChange("");
              setQuery("");
              setOpen(false);
              onClose?.();
            }}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            title="Clear"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </div>

      {open &&
        rect &&
        (filtered.length > 0 || canCreate) &&
        createPortal(
          <div
            ref={listRef}
            className="z-[100] max-h-56 overflow-y-auto rounded-md border bg-popover p-1 shadow-lg"
            style={{
              position: "fixed",
              top: rect.bottom + 4,
              left: rect.left,
              width: Math.max(rect.width, 160),
            }}
          >
            {filtered.map((o, i) =>
              editingOption === o ? (
                <input
                  key={o}
                  autoFocus
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  onMouseDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") {
                      const next = editDraft.trim();
                      if (next && next !== o) {
                        onEditOption?.(o, next);
                        // Renaming the option currently applied to this field
                        // should update the field too — otherwise the rename
                        // silently leaves the field pointing at the old name.
                        if (o === value) commit(next);
                      }
                      setEditingOption(null);
                    } else if (e.key === "Escape") {
                      setEditingOption(null);
                    }
                  }}
                  onBlur={() => {
                    const next = editDraft.trim();
                    if (next && next !== o) {
                      onEditOption?.(o, next);
                      if (o === value) commit(next);
                    }
                    setEditingOption(null);
                  }}
                  className="w-full rounded border border-primary bg-background px-2 py-1.5 text-xs outline-none"
                />
              ) : (
                <div
                  key={o}
                  onMouseEnter={() => setHighlight(i)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs",
                    i === highlight ? "bg-accent" : "hover:bg-accent/60",
                  )}
                >
                  <button
                    onMouseDown={(e) => {
                      e.preventDefault();
                      commit(o);
                    }}
                    className="flex flex-1 items-center gap-2 text-left"
                  >
                    <Check
                      className={cn("h-3 w-3 shrink-0", o === value ? "opacity-100" : "opacity-0")}
                    />
                    <span className="truncate">{o}</span>
                  </button>
                  {onEditOption && (
                    <button
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setEditingOption(o);
                        setEditDraft(o);
                      }}
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      title="Rename"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ),
            )}
            {canCreate && (
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  create(trimmedQuery);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-primary hover:bg-accent/60"
              >
                <Plus className="h-3 w-3 shrink-0" />
                Add "{trimmedQuery}"
              </button>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
