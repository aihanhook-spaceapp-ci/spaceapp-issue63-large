/**
 * Short-lived store for desktop sign-in handoffs.
 *
 * The desktop client opens the system browser with a random handoff id and
 * polls for the session once Google sign-in completes. Entries are single-use,
 * expire quickly and the store is bounded so an unclaimed sign-in never keeps a
 * live session token in memory for longer than the handoff window.
 */
export interface DesktopAuthHandoffEntry {
  token: string;
  user: { id: string; email: string; role: string };
  createdAt: number;
}

export const DESKTOP_AUTH_HANDOFF_TTL_MS = 2 * 60 * 1000;
export const DESKTOP_AUTH_HANDOFF_MAX_ENTRIES = 200;

const handoffIdPattern = /^[A-Za-z0-9_-]{16,128}$/;

export function isValidDesktopAuthHandoffId(value: unknown): value is string {
  return typeof value === "string" && handoffIdPattern.test(value);
}

export interface DesktopAuthHandoffStore {
  store(handoffId: string, entry: Omit<DesktopAuthHandoffEntry, "createdAt">): void;
  take(handoffId: string): DesktopAuthHandoffEntry | null;
  readonly size: number;
}

export function createDesktopAuthHandoffStore(options: {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
} = {}): DesktopAuthHandoffStore {
  const ttlMs = Math.max(1000, Math.trunc(options.ttlMs ?? DESKTOP_AUTH_HANDOFF_TTL_MS));
  const maxEntries = Math.max(1, Math.trunc(options.maxEntries ?? DESKTOP_AUTH_HANDOFF_MAX_ENTRIES));
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, DesktopAuthHandoffEntry>();

  const sweep = (): void => {
    const cutoff = now() - ttlMs;
    for (const [id, entry] of entries) {
      if (entry.createdAt <= cutoff) {
        entries.delete(id);
      }
    }
  };

  return {
    store(handoffId, entry) {
      if (!isValidDesktopAuthHandoffId(handoffId)) {
        throw new Error("Invalid desktop handoff id.");
      }
      sweep();
      while (entries.size >= maxEntries) {
        // Map iteration follows insertion order, so the first key is the oldest.
        const oldest = entries.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        entries.delete(oldest);
      }
      entries.set(handoffId, { ...entry, createdAt: now() });
    },
    take(handoffId) {
      sweep();
      const entry = entries.get(handoffId);
      if (!entry) {
        return null;
      }
      entries.delete(handoffId);
      return entry;
    },
    get size() {
      return entries.size;
    }
  };
}
