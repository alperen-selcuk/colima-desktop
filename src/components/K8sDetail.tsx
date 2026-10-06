import { useEffect, useState } from "react";
import { Button } from "./Button";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, X } from "lucide-react";
import * as api from "../lib/api";
import type { K8sConfigMap, K8sIngress, K8sKind, K8sSecret } from "../lib/types";
import { formatIngressRule, ingressHostUrl } from "../lib/k8sView";
import { LogViewer } from "./LogViewer";
import { K8sIcon, KIND_ACCENT_VAR, KIND_LABEL } from "./k8s/K8sIcon";
import { SecretKeyRow } from "./k8s/SecretKeyRow";

type Tab = "logs" | "describe" | "yaml" | "data";

interface K8sDetailProps {
  profile: string;
  kind: K8sKind;
  namespace: string | null;
  name: string;
  containers?: string[];
  /** Present only when kind is configmap/secret/ingress — lets the drawer
   * render a rich "data" tab without a redundant extra fetch. */
  configMap?: K8sConfigMap;
  secret?: K8sSecret;
  ingress?: K8sIngress;
  onClose: () => void;
}

export function K8sDetail({
  profile,
  kind,
  namespace,
  name,
  containers,
  configMap,
  secret,
  ingress,
  onClose,
}: K8sDetailProps) {
  const hasLogs = kind === "pod";
  const hasData = kind === "configmap" || kind === "secret" || kind === "ingress";
  const defaultTab: Tab = hasLogs ? "logs" : hasData ? "data" : "describe";
  const [tab, setTab] = useState<Tab>(defaultTab);
  const [container, setContainer] = useState<string | null>(containers?.[0] ?? null);

  useEffect(() => {
    setTab(defaultTab);
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

  const tabs: Tab[] = [...(hasLogs ? (["logs"] as Tab[]) : []), ...(hasData ? (["data"] as Tab[]) : []), "describe", "yaml"];

  return (
    <div
      className="flex w-[460px] flex-shrink-0 flex-col border-l"
      style={{ background: "var(--surface-1)", borderColor: "var(--border)" }}
    >
      <div className="flex items-center justify-between border-b px-3 py-2.5" style={{ borderColor: "var(--border)" }}>
        <div className="flex min-w-0 items-center gap-2">
          <K8sIcon kind={kind} size={18} />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold" style={{ color: "var(--text)" }}>
              {name}
            </div>
            <div className="truncate text-[11px]" style={{ color: `var(${KIND_ACCENT_VAR[kind]})` }}>
              {namespace ? `${namespace} · ` : ""}
              {KIND_LABEL[kind]}
            </div>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} title="Close"><X size={14} /></Button>
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

        {tab === "data" && configMap && (
          <div className="h-full overflow-y-auto p-3">
            {configMap.keys.length === 0 ? (
              <div className="text-[12px]" style={{ color: "var(--text-faint)" }}>
                No data keys.
              </div>
            ) : (
              <ConfigMapData profile={profile} namespace={namespace!} name={name} keys={configMap.keys} />
            )}
          </div>
        )}

        {tab === "data" && secret && (
          <div className="flex h-full flex-col gap-2 overflow-y-auto p-3">
            <div className="mb-1 text-[11px]" style={{ color: "var(--text-faint)" }}>
              Type: <span className="font-mono-app">{secret.type}</span>
            </div>
            {secret.keys.length === 0 ? (
              <div className="text-[12px]" style={{ color: "var(--text-faint)" }}>
                No data keys.
              </div>
            ) : (
              secret.keys.map((k) => (
                <SecretKeyRow key={k} profile={profile} namespace={namespace!} name={name} secretKey={k} />
              ))
            )}
          </div>
        )}

        {tab === "data" && ingress && (
          <div className="h-full overflow-y-auto p-3">
            <div className="mb-3 flex flex-wrap gap-1.5">
              {ingress.hosts.length === 0 ? (
                <span className="text-[12px]" style={{ color: "var(--text-faint)" }}>
                  No hosts
                </span>
              ) : (
                ingress.hosts.map((h) => {
                  const url = ingressHostUrl(h, ingress.tls);
                  return url ? (
                    <a
                      key={h}
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="k8s-chip inline-flex items-center gap-1 hover:brightness-110"
                      style={{ color: "var(--info)" }}
                    >
                      {h}
                      <ExternalLink size={10} />
                    </a>
                  ) : (
                    <span key={h} className="k8s-chip">
                      {h}
                    </span>
                  );
                })
              )}
            </div>
            <div className="mb-1.5 text-[11px] font-medium" style={{ color: "var(--text-faint)" }}>
              Rules
            </div>
            <div className="flex flex-col gap-1">
              {ingress.rules.length === 0 ? (
                <div className="text-[12px]" style={{ color: "var(--text-faint)" }}>
                  No rules (default backend).
                </div>
              ) : (
                ingress.rules.map((r, i) => (
                  <div
                    key={i}
                    className="rounded-md border px-2.5 py-1.5 font-mono-app text-[11px]"
                    style={{ borderColor: "var(--border)", background: "var(--surface-2)", color: "var(--text-dim)" }}
                  >
                    {formatIngressRule(r)}
                  </div>
                ))
              )}
            </div>
          </div>
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

/** ConfigMap values are not secret (§6.6) — fetched via yaml and shown
 * plainly, keyed off the same list of keys the row already has. */
function ConfigMapData({ profile, namespace, name, keys }: { profile: string; namespace: string; name: string; keys: string[] }) {
  const yamlQuery = useQuery({
    queryKey: ["k8sYaml", profile, "configmap", namespace, name],
    queryFn: () => api.k8sYaml(profile, "configmap", namespace, name),
  });

  if (yamlQuery.isLoading) {
    return (
      <div className="text-[12px]" style={{ color: "var(--text-faint)" }}>
        Loading…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="mb-1 flex flex-wrap gap-1.5">
        {keys.map((k) => (
          <span key={k} className="k8s-chip">
            {k}
          </span>
        ))}
      </div>
      <pre className="whitespace-pre-wrap break-all font-mono-app text-[11px]" style={{ color: "var(--text-dim)" }}>
        {yamlQuery.data}
      </pre>
    </div>
  );
}
