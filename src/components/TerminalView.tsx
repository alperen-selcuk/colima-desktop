import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import * as api from "../lib/api";
import type { TerminalTarget } from "../lib/types";
import { base64ToBytes } from "../lib/format";
import { readThemeTokens } from "../lib/useTheme";
import { armSession, attachSession, forgetSession } from "../lib/terminalBuffer";

interface TerminalViewProps {
  profile: string | null;
  target: TerminalTarget;
  active: boolean;
  onExit?: (code: number | null) => void;
}

async function openUrl(url: string) {
  try {
    const opener = await import("@tauri-apps/plugin-opener");
    await opener.openUrl(url);
  } catch {
    window.open(url, "_blank");
  }
}

export function TerminalView({ profile, target, active, onExit }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const exitedRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: readThemeTokens(),
      allowProposedApi: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        openUrl(uri);
      }),
    );
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;

    let cancelled = false;
    let unlistenOutput: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;

    (async () => {
      try {
        fit.fit();
      } catch {
        // container may not have a size yet on first paint; ResizeObserver will retry.
      }
      const cols = term.cols || 80;
      const rows = term.rows || 24;

      // Reserve the session id slot before terminal_open resolves? We can't —
      // the id only exists after terminal_open returns. So instead we open
      // first, then IMMEDIATELY arm + attach before yielding to the event
      // loop again; any output emitted synchronously-after in the backend
      // still queues on the JS microtask/event queue behind our listener
      // registration below, and armSession catches anything that races in.
      const sessionId = await api.terminalOpen(profile, target, cols, rows);
      if (cancelled) {
        api.terminalClose(sessionId);
        return;
      }
      sessionIdRef.current = sessionId;
      armSession(sessionId);

      unlistenOutput = attachSession(sessionId, (payload) => {
        const bytes = base64ToBytes(payload.data);
        term.write(bytes);
      });

      unlistenExit = await api.onTerminalExit((payload) => {
        if (payload.sessionId !== sessionId) return;
        exitedRef.current = true;
        term.write(`\r\n\u001b[2m[process exited with code ${payload.code ?? "?"}]\u001b[0m\r\n`);
        onExit?.(payload.code);
      });

      term.onData((data) => {
        if (exitedRef.current) return;
        api.terminalWrite(sessionId, data);
      });
    })();

    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
        const sid = sessionIdRef.current;
        if (sid && term.cols && term.rows) {
          api.terminalResize(sid, term.cols, term.rows);
        }
      } catch {
        // ignore transient resize errors while unmounting
      }
    });
    resizeObserver.observe(container);

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      unlistenOutput?.();
      unlistenExit?.();
      if (sessionIdRef.current) {
        forgetSession(sessionIdRef.current);
        api.terminalClose(sessionIdRef.current);
      }
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fit whenever this tab becomes active again (hidden tabs can't compute layout).
  useEffect(() => {
    if (active && fitRef.current) {
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
          const sid = sessionIdRef.current;
          const term = termRef.current;
          if (sid && term?.cols && term?.rows) {
            api.terminalResize(sid, term.cols, term.rows);
          }
        } catch {
          // ignore
        }
      });
    }
  }, [active]);

  // Live theme updates.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      if (termRef.current) {
        termRef.current.options.theme = readThemeTokens();
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onMq = () => {
      if (termRef.current) termRef.current.options.theme = readThemeTokens();
    };
    mq.addEventListener("change", onMq);
    return () => {
      observer.disconnect();
      mq.removeEventListener("change", onMq);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="h-full w-full px-2 py-1"
      style={{ display: active ? "block" : "none", background: "var(--term-bg, var(--surface-1))" }}
    />
  );
}
