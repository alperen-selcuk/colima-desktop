// Minimal in-memory `Storage` + `window` stand-in for unit tests that
// exercise localStorage-backed helpers (recent-files lists, persisted
// toggles, ...) in this project's plain-Node vitest environment (no
// jsdom/happy-dom is configured). Not a full Storage/Window polyfill —
// just enough surface (getItem/setItem/removeItem/clear) for the helpers
// under test, which is all `window.localStorage.*` calls in this codebase
// ever use.
class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem" | "clear"> {
  private store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

/** Installs a `globalThis.window.localStorage` if one doesn't already
 * exist (idempotent — safe to call from multiple test files' `beforeAll`).
 * Existing installs are left untouched, including their contents. */
export function installMemoryLocalStorage(): void {
  const g = globalThis as unknown as { window?: { localStorage?: Storage } };
  if (!g.window) {
    g.window = {} as { localStorage?: Storage };
  }
  if (!g.window.localStorage) {
    g.window.localStorage = new MemoryStorage() as unknown as Storage;
  }
}
