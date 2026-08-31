import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface VirtualRows {
  /** First row index to render. */
  start: number;
  /** One past the last row index to render. */
  end: number;
  /** Filler height (px) standing in for rows above `start`. */
  padTop: number;
  /** Filler height (px) standing in for rows below `end`. */
  padBottom: number;
  /** Measured (or estimated) height of one row, px. */
  rowHeight: number;
  /** Scrolls the container so row `index` sits roughly centred. */
  scrollToIndex: (index: number) => void;
}

/**
 * Fixed-height row windowing for a scrollable table. Only the rows near the
 * viewport are rendered; spacer rows above and below keep the scrollbar and
 * every row's on-screen position honest. Row height is measured from a real
 * rendered row, so it tracks the row-height setting and browser zoom without
 * being told.
 *
 * Pass `enabled: false` (e.g. for short lists) to render everything and skip
 * the spacers entirely — `scrollToIndex` still works.
 */
export function useVirtualRows(
  scrollRef: React.RefObject<HTMLElement | null>,
  count: number,
  opts: { estimateRowHeight: number; overscan?: number; enabled?: boolean },
): VirtualRows {
  const { estimateRowHeight, overscan = 8, enabled = true } = opts;
  const [rowHeight, setRowHeight] = useState(estimateRowHeight);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const rowHeightRef = useRef(rowHeight);
  rowHeightRef.current = rowHeight;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const sync = () => {
      setScrollTop(el.scrollTop);
      setViewport(el.clientHeight);
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", sync);
      ro.disconnect();
    };
  }, [scrollRef]);

  // Measure a real row's height when the row-height setting changes or rows
  // first appear — not on every render, since getBoundingClientRect forces a
  // reflow and this component re-renders on every scroll frame.
  const hasRows = count > 0;
  useLayoutEffect(() => {
    const row = scrollRef.current?.querySelector<HTMLElement>("tbody tr[data-path]");
    if (!row) return;
    const h = row.getBoundingClientRect().height;
    if (h > 0 && Math.abs(h - rowHeightRef.current) > 0.5) setRowHeight(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimateRowHeight, hasRows, scrollRef]);

  const scrollToIndex = (index: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const headH = el.querySelector("thead")?.getBoundingClientRect().height ?? 0;
    const h = rowHeightRef.current || estimateRowHeight;
    el.scrollTo({ top: Math.max(0, headH + index * h - el.clientHeight / 2 + h / 2) });
  };

  if (!enabled || count === 0) {
    return { start: 0, end: count, padTop: 0, padBottom: 0, rowHeight, scrollToIndex };
  }

  const h = rowHeight || estimateRowHeight;
  const start = Math.max(0, Math.floor(scrollTop / h) - overscan);
  const end = Math.min(count, Math.ceil((scrollTop + viewport) / h) + overscan);
  return {
    start,
    end,
    padTop: start * h,
    padBottom: Math.max(0, (count - end) * h),
    rowHeight: h,
    scrollToIndex,
  };
}
