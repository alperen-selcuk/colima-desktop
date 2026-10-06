import { useEffect, useState } from "react";
import { Button } from "../Button";
import { Layers, ScrollText, X } from "lucide-react";
import type { Container } from "../../lib/types";
import { LogViewer } from "../LogViewer";
import { ImageIcon } from "./ImageIcon";
import { StatusDot, statusTone } from "../StatusDot";

export type ComposeProjectDetailTab = "overview" | "logs";
type Tab = ComposeProjectDetailTab;

interface ComposeProjectDetailProps {
  profile: string;
  project: string;
  status: string; // aggregate status text, e.g. "running(2), exited(1)"
  configFiles: string[];
  containers: Container[]; // this project's containers (already filtered/visible)
  /** Tab to show when the panel (re-)opens for this project — "logs" when
   * opened via the group's "Logs" action, "overview" otherwise. */
  initialTab?: Tab;
  onClose: () => void;
}

/** Right-side detail panel for a compose project group (§6.7: "Logs
 * (aggregate stream in the detail panel)"). Mirrors ContainerDetail's shape
 * (header + tab strip + content) so the two detail panels feel like the
 * same family of UI. Overview lists the project's config files and its
 * services (derived from the group's own containers); Logs reuses the
 * existing LogViewer with target `{ kind: "compose", project, tail: 500 }`,
 * which streams the aggregate `compose logs -f` output. */
export function ComposeProjectDetail({
  profile,
  project,
  status,
  configFiles,
  containers,
  initialTab = "overview",
  onClose,
}: ComposeProjectDetailProps) {
  const [tab, setTab] = useState<Tab>(initialTab);

  useEffect(() => {
    setTab(initialTab);
    // Re-sync whenever the caller opens a (possibly different) project, or
    // re-opens the same project via a different entry point (e.g. clicking
    // "Logs" after having had Overview open) — `initialTab` changing is the
    // caller's signal to jump tabs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, initialTab]);

  return (
    <div
      className="flex w-[420px] flex-shrink-0 flex-col border-l"
      style={{ background: "var(--surface-1)", borderColor: "var(--border)" }}
    >
      <div className="flex items-center justify-between border-b px-3 py-2.5" style={{ borderColor: "var(--border)" }}>
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-md"
            style={{ background: "var(--docker-blue-soft)" }}
          >
            <Layers size={14} style={{ color: "var(--docker-blue)" }} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold" style={{ color: "var(--text)" }}>
              {project}
            </div>
            <div className="truncate text-[11px]" style={{ color: "var(--text-faint)" }}>
              {status} · {containers.length} container{containers.length === 1 ? "" : "s"}
            </div>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} title="Close"><X size={14} /></Button>
      </div>

      <div className="flex border-b px-3" style={{ borderColor: "var(--border)" }}>
        {(["overview", "logs"] as Tab[]).map((t) => (
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
        {tab === "overview" && (
          <div className="h-full overflow-y-auto p-3">
            <div className="mb-4">
              <div className="mb-1.5 text-[11px] font-medium" style={{ color: "var(--text-faint)" }}>
                Config files
              </div>
              {configFiles.length === 0 ? (
                <div className="text-[12px]" style={{ color: "var(--text-faint)" }}>
                  Unknown
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {configFiles.map((f) => (
                    <div key={f} className="truncate font-mono-app text-[11px]" style={{ color: "var(--text-dim)" }} title={f}>
                      {f}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium" style={{ color: "var(--text-faint)" }}>
                <ScrollText size={11} /> Services
              </div>
              <div className="flex flex-col gap-1.5">
                {containers.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center gap-2 rounded border px-2 py-1.5 text-[11.5px]"
                    style={{ borderColor: "var(--border)" }}
                  >
                    <StatusDot tone={statusTone(c.state)} pulse={c.state === "running"} />
                    <ImageIcon image={c.image} size={18} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium" style={{ color: "var(--text)" }}>
                        {c.composeService ?? c.names}
                      </div>
                      <div className="truncate font-mono-app text-[10.5px]" style={{ color: "var(--text-faint)" }}>
                        {c.image}
                      </div>
                    </div>
                    <span className="flex-shrink-0 text-[10.5px]" style={{ color: "var(--text-dim)" }}>
                      {c.state}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        {tab === "logs" && <LogViewer profile={profile} target={{ kind: "compose", project, tail: 500 }} />}
      </div>
    </div>
  );
}
