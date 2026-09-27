import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import * as api from "../lib/api";
import type { K8sKind } from "../lib/types";
import { LogViewer } from "./LogViewer";

type Tab = "logs" | "describe" | "yaml";

interface K8sDetailProps {
  profile: string;
  kind: K8sKind;
  namespace: string | null;
  name: string;
  containers?: string[];
  onClose: () => void;
}

export function K8sDetail({ profile, kind, namespace, name, containers, onClose }: K8sDetailProps) {
  const hasLogs = kind === "pod";
  const [tab, setTab] = useState<Tab>(hasLogs ? "logs" : "describe");
  const [container, setContainer] = useState<string | null>(containers?.[0] ?? null);

  useEffect(() => {
    setTab(hasLogs ? "logs" : "describe");
    setContainer(containers?.[0] ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, namespace, name]);

  const describeQuery = useQuery({
    queryKey: ["k8sDescribe", profile, kind, namespace, name],
    queryFn: () => api.k8sDescribe(profile, kind, namespace, name),
    enabled: tab === "describe",
  });

  const yamlQuery = useQuery({
    queryKey: ["k8sYaml", profile, kind, namespace, name],
    queryFn: () => api.k8sYaml(profile, kind, namespace, name),
    enabled: tab === "yaml",
  });

  const tabs: Tab[] = hasLogs ? ["logs", "describe", "yaml"] : ["describe", "yaml"];

  return (
    <div
      className="flex w-[460px] flex-shrink-0 flex-col border-l"
      style={{ background: "var(--surface-1)", borderColor: "var(--border)" }}
    >
      <div className="flex items-center justify-between border-b px-3 py-2.5" style={{ borderColor: "var(--border)" }}>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold" style={{ color: "var(--text)" }}>
            {name}
          </div>
          <div className="truncate text-[11px]" style={{ color: "var(--text-faint)" }}>
            {namespace ? `${namespace} · ` : ""}
            {kind}
          </div>
        </div>
        <button onClick={onClose} className="opacity-60 hover:opacity-100" style={{ color: "var(--text-dim)" }}>
          <X size={15} />
        </button>
      </div>

      <div className="flex items-center justify-between border-b px-3" style={{ borderColor: "var(--border)" }}>
        <div className="flex">
          {tabs.map((t) => (
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
        {tab === "logs" && containers && containers.length > 1 && (
          <select
            value={container ?? ""}
            onChange={(e) => setContainer(e.target.value)}
            className="rounded border px-1.5 py-0.5 text-[11px] outline-none"
            style={{ background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text)" }}
          >
            {containers.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {tab === "logs" && namespace && (
          <LogViewer
            profile={profile}
            target={{ kind: "pod", namespace, pod: name, container: containers && containers.length > 1 ? container : null, tail: 500 }}
          />
        )}
        {tab === "describe" && (
          <div className="h-full overflow-y-auto p-3">
            <pre className="whitespace-pre-wrap break-all font-mono-app text-[11px]" style={{ color: "var(--text-dim)" }}>
              {describeQuery.isLoading ? "Loading…" : describeQuery.data}
            </pre>
          </div>
        )}
        {tab === "yaml" && (
          <div className="h-full overflow-y-auto p-3">
            <pre className="whitespace-pre-wrap break-all font-mono-app text-[11px]" style={{ color: "var(--text-dim)" }}>
              {yamlQuery.isLoading ? "Loading…" : yamlQuery.data}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
