// Buffers `terminal-output` events that arrive before an xterm instance has
// attached its listener for a given sessionId, so the first prompt/banner
// isn't lost. Callers must start listening (subscribe) BEFORE calling
// terminalOpen, then drain the buffer once the xterm instance is mounted.
import { onTerminalOutput } from "./api";
import type { TerminalOutput } from "./types";

const pending = new Map<string, TerminalOutput[]>();
const liveHandlers = new Map<string, (payload: TerminalOutput) => void>();

let globalUnlisten: (() => void) | null = null;
let globalUnlistenPromise: Promise<void> | null = null;

function ensureGlobalListener(): void {
  if (globalUnlisten || globalUnlistenPromise) return;
  globalUnlistenPromise = onTerminalOutput((payload) => {
    const handler = liveHandlers.get(payload.sessionId);
    if (handler) {
      handler(payload);
    } else {
      const buf = pending.get(payload.sessionId) ?? [];
      buf.push(payload);
      pending.set(payload.sessionId, buf);
    }
  }).then((unlisten) => {
    globalUnlisten = unlisten;
  });
}

/** Start buffering output for a session before it's opened. Call once per session id. */
export function armSession(sessionId: string): void {
  ensureGlobalListener();
  if (!pending.has(sessionId)) pending.set(sessionId, []);
}

/**
 * Attach a live handler for a session and flush any buffered output to it
 * (in order). Returns a detach function.
 */
export function attachSession(sessionId: string, handler: (payload: TerminalOutput) => void): () => void {
  ensureGlobalListener();
  const buffered = pending.get(sessionId);
  if (buffered && buffered.length > 0) {
    for (const payload of buffered) handler(payload);
  }
  pending.delete(sessionId);
  liveHandlers.set(sessionId, handler);
  return () => {
    liveHandlers.delete(sessionId);
  };
}

export function forgetSession(sessionId: string): void {
  pending.delete(sessionId);
  liveHandlers.delete(sessionId);
}
