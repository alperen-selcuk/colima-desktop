import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TerminalSquare, X } from "lucide-react";
import * as api from "../lib/api";
import type { Container, ContainerStats } from "../lib/types";
import { LogViewer } from "./LogViewer";
import { useDock } from "../lib/useDock";
import { ImageIcon } from "./containers/ImageIcon";

type Tab = "logs" | "inspect" | "stats";

interface ContainerDetailProps {
  profile: string;
  container: Container;
  stats: ContainerStats | undefined;
  onClose: () => void;
}

export function ContainerDetail({ profile, container, stats, onClose }: ContainerDetailProps) {
  const [tab, setTab] = useState<Tab>("logs");
  const dock = useDock();

  useEffect(() => {
    setTab("logs");
  }, [container.id]);

  const inspectQuery = useQuery({
    queryKey: ["containerInspect", profile, container.id],
    queryFn: () => api.containerInspect(profile, container.id),
    enabled: tab === "inspect",
  });

  return (
    <div
      className="flex w-[420px] flex-shrink-0 flex-col border-l"
      style={{ background: "var(--surface-1)", borderColor: "var(--border)" }}
    >
      <div className="flex items-center justify-between border-b px-3 py-2.5" style={{ borderColor: "var(--border)" }}>
        <div className="flex min-w-0 items-center gap-2.5">
          <ImageIcon image={container.image} size={26} />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold" style={{ color: "var(--text)" }}>
              {container.names}
            </div>
            <div className="truncate font-mono-app text-[11px]" style={{ color: "var(--text-faint)" }}>
              {container.id.slice(0, 12)}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={() => dock.openTerminalTab({ kind: "container", id: container.id }, profile)}
            title="Open shell in dock"
            className="opacity-60 hover:opacity-100 p-1"
            style={{ color: "var(--text-dim)" }}
          >
            <TerminalSquare size={14} />
          </button>
          <button onClick={onClose} className="opacity-60 hover:opacity-100 p-1" style={{ color: "var(--text-dim)" }}>
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="flex border-b px-3" style={{ borderColor: "var(--border)" }}>
        {(["logs", "inspect", "stats"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="px-3 py-2 text-[12px] font-medium capitalize"
            style={{
              color: tab === t ? "var(--accent)" : "var(--text-dim)",
              borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent",
            }}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1">
        {tab === "logs" && <LogViewer profile={profile} target={{ kind: "container", id: container.id, tail: 500 }} />}
        {tab === "inspect" && (
          <div className="h-full overflow-y-auto p-3">
            <pre className="whitespace-pre-wrap break-all font-mono-app text-[11px]" style={{ color: "var(--text-dim)" }}>
              {inspectQuery.isLoading ? "Loading…" : JSON.stringify(inspectQuery.data, null, 2)}
            </pre>
          </div>
        )}
        {tab === "stats" && (
          <div className="p-3">
            {stats ? (
              <div className="grid grid-cols-2 gap-3 text-[12px]">
                {[
                  ["CPU", stats.cpuPerc],
                  ["Memory", stats.memUsage],
                  ["Memory %", stats.memPerc],
                  ["Net I/O", stats.netIO],
                  ["Block I/O", stats.blockIO],
                  ["PIDs", stats.pids],
                ].map(([label, value]) => (
                  <div key={label} className="rounded border p-2" style={{ borderColor: "var(--border)" }}>
                    <div style={{ color: "var(--text-faint)" }}>{label}</div>
                    <div className="font-mono-app mt-0.5" style={{ color: "var(--text)" }}>
                      {value}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color: "var(--text-faint)" }}>No stats available (container not running).</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
