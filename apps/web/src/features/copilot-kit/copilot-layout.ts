import { useEffect, useState, type RefObject } from "react";

/**
 * Split: the main surface (browser, mail client) beside the rail. Stacked: one surface at a time
 * with the main surface as a rail tab and the tab strip at the bottom, for phones and narrow panes.
 */
export type CopilotLayout = "split" | "stacked";

/** Panes at most this wide (CSS px) stack; a 390–430px phone always does, a half-screen desktop pane does not. */
export const STACKED_LAYOUT_MAX_WIDTH = 640;

export function layoutForWidth(width: number): CopilotLayout {
  return width > 0 && width <= STACKED_LAYOUT_MAX_WIDTH ? "stacked" : "split";
}

/** The pane's own width decides the layout (a narrow desktop pane stacks like a phone); SSR and jsdom start from the window. */
export function useCopilotLayout(ref: RefObject<HTMLDivElement | null>): CopilotLayout {
  const [layout, setLayout] = useState<CopilotLayout>(() => layoutForWidth(typeof window === "undefined" ? 0 : window.innerWidth));
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const apply = (width: number) => setLayout((current) => { const next = layoutForWidth(width); return next === current ? current : next; });
    apply(element.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => { for (const entry of entries) apply(entry.contentRect.width); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return layout;
}
