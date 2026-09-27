import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Trash2 } from "lucide-react";
import { onLogEnd, onLogLine, startLogStream, stopLogStream } from "../lib/api";
import type { LogTarget } from "../lib/types";
import { stripAnsi } from "../lib/format";

interface LogLine {
  id: number;
  line: string;
  stream: "stdout" | "stderr";
}

const MAX_LINES = 5000;

export function LogViewer({ profile, target }: { profile: string; target: LogTarget }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [filter, setFilter] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [ended, setEnded] = useState<number | null>(null);
  const idRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlistenLine: (() => void) | undefined;
    let unlistenEnd: (() => void) | undefined;

    setLines([]);
    setEnded(null);

    (async () => {
      const streamId = await startLogStream(profile, target);
      if (cancelled) {
        stopLogStream(streamId);
        return;
      }
      streamIdRef.current = streamId;

      unlistenLine = await onLogLine((payload) => {
        if (payload.streamId !== streamId) return;
        setLines((prev) => {
          const next = [...prev, { id: idRef.current++, line: payload.line, stream: payload.stream }];
          return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
        });
      });

      unlistenEnd = await onLogEnd((payload) => {
        if (payload.streamId !== streamId) return;
        setEnded(payload.code);
      });
    })();

    return () => {
      cancelled = true;
      unlistenLine?.();
      unlistenEnd?.();
      if (streamIdRef.current) {
        stopLogStream(streamIdRef.current);
        streamIdRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, JSON.stringify(target)]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  const filtered = filter
    ? lines.filter((l) => l.line.toLowerCase().includes(filter.toLowerCase()))
    : lines;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2 flex-shrink-0" style={{ borderColor: "var(--border)" }}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter logs…"
          className="flex-1 rounded border px-2 py-1 text-[12px] outline-none"
          style={{ background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text)" }}
        />
        <button
          onClick={() => setAutoScroll((v) => !v)}
          title="Auto-scroll"
          className="flex items-center gap-1 rounded border px-2 py-1 text-[11.5px]"
          style={{
            borderColor: autoScroll ? "var(--accent)" : "var(--border)",
            color: autoScroll ? "var(--accent)" : "var(--text-dim)",
            background: autoScroll ? "var(--accent-soft)" : "transparent",
          }}
        >
          <ArrowDownToLine size={12} /> Auto-scroll
        </button>
        <button
          onClick={() => setLines([])}
          title="Clear"
          className="flex items-center gap-1 rounded border px-2 py-1 text-[11.5px]"
          style={{ borderColor: "var(--border)", color: "var(--text-dim)" }}
        >
          <Trash2 size={12} /> Clear
        </button>
      </div>
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          setAutoScroll(atBottom);
        }}
        className="font-mono-app text-[11.5px] flex-1 overflow-y-auto px-3 py-2"
        style={{ color: "var(--text)" }}
      >
        {filtered.length === 0 ? (
          <div className="py-8 text-center" style={{ color: "var(--text-faint)" }}>
            {lines.length === 0 ? "Waiting for log output…" : "No lines match filter"}
          </div>
        ) : (
          filtered.map((l) => (
            <div
              key={l.id}
              className="whitespace-pre-wrap break-all"
              style={{ color: l.stream === "stderr" ? "var(--danger)" : "var(--text)" }}
            >
              {stripAnsi(l.line)}
            </div>
          ))
        )}
        {ended !== null && (
          <div className="mt-2 pt-2" style={{ color: "var(--text-faint)", borderTop: "1px dashed var(--border)" }}>
            stream ended (exit code {ended})
          </div>
        )}
      </div>
    </div>
  );
}
