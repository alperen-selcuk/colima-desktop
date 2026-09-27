import { useEffect, useRef, useState } from "react";
import { onOpLog } from "../lib/api";
import type { OpLog } from "../lib/types";
import { stripAnsi } from "../lib/format";
import { useDock } from "../lib/useDock";

interface OpLine extends OpLog {
  id: number;
}

const MAX_LINES = 2000;

/**
 * Content of the dock's "Output" tab — the former standalone OpConsole,
 * now hosted inside the bottom dock. Subscribes to `colima-op-log` for the
 * lifetime of the app (mounted once, alongside the dock) and auto-opens the
 * dock on the Output tab when a new operation starts.
 */
export function OutputPanel({ active }: { active: boolean }) {
  const [lines, setLines] = useState<OpLine[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const idRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeOps = useRef<Set<string>>(new Set());
  const { setOpen, openOutputTab } = useDock();

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onOpLog((payload) => {
      const key = `${payload.profile}:${payload.op}`;
      if (!activeOps.current.has(key)) {
        activeOps.current.add(key);
        openOutputTab();
        setOpen(true);
      }
      setLines((prev) => {
        const next = [...prev, { ...payload, id: idRef.current++ }];
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        setAutoScroll(atBottom);
      }}
      className="font-mono-app text-[11.5px] h-full overflow-y-auto px-3 py-2"
      style={{ display: active ? "block" : "none", color: "var(--text-dim)" }}
    >
      {lines.length === 0 ? (
        <div className="py-6 text-center" style={{ color: "var(--text-faint)" }}>
          Machine and image operations will stream their output here.
        </div>
      ) : (
        lines.map((l) => (
          <div key={l.id} className="whitespace-pre-wrap break-all">
            <span style={{ color: "var(--text-faint)" }}>
              [{l.profile}:{l.op}]
            </span>{" "}
            {stripAnsi(l.line)}
          </div>
        ))
      )}
    </div>
  );
}
