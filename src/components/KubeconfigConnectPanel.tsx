import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ClipboardCopy, Download, GitMerge, Plug } from "lucide-react";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import * as api from "../lib/api";
import { isTauriRuntime } from "../lib/api";
import { connectSnippets, defaultKubeconfigFileName } from "../lib/kubeConnect";
import { Button } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { useToast } from "./Toasts";

/** Collapsible "Connect" card on the Kubernetes page: context, API server and
 * ways to get the kubeconfig into the user's own terminal. Never changes
 * current-context; only touches ~/.kube/config via the explicit Merge action. */
export function KubeconfigConnectPanel({ profile, contextName }: { profile: string; contextName: string }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);

  const infoQuery = useQuery({
    queryKey: ["k8sKubeconfig", profile],
    queryFn: () => api.k8sKubeconfig(profile),
    enabled: open,
    staleTime: 15000,
  });
  const info = infoQuery.data;
  const snippets = connectSnippets(contextName, savedPath);

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`Copied ${what}`);
    } catch (e) {
      toast.error(`Could not copy ${what}`, String(e));
    }
  };

  const copyKubeconfig = async () => {
    try {
      const fresh = await api.k8sKubeconfig(profile);
      await navigator.clipboard.writeText(fresh.content);
      toast.success("Copied kubeconfig", "It contains cluster credentials — treat it like a password.");
    } catch (e) {
      toast.error("Could not copy kubeconfig", String(e));
    }
  };

  const saveAs = async () => {
    if (!isTauriRuntime()) {
      toast.info("Saving files is only available in the desktop app");
      return;
    }
    try {
      const target = await saveFileDialog({
        defaultPath: defaultKubeconfigFileName(contextName),
        filters: [{ name: "kubeconfig", extensions: ["yaml", "yml"] }],
      });
      if (!target) return;
      const written = await api.k8sExportKubeconfig(profile, target);
      setSavedPath(written);
      toast.success("Kubeconfig saved", written);
    } catch (e) {
      toast.error("Could not save kubeconfig", String(e));
    }
  };

  const merge = async () => {
    try {
      const r = await api.k8sMergeKubeconfig(profile);
      toast.success(
        `Merged ${contextName} into your kubeconfig`,
        r.backupPath ? `Backup: ${r.backupPath}` : "No existing kubeconfig, so nothing to back up.",
      );
    } catch (e) {
      toast.error("Could not merge kubeconfig", String(e));
    }
  };

  return (
    <div className="px-4 pt-3">
      <div className="rounded-md border" style={{ background: "var(--surface-1)", borderColor: "var(--border)" }}>
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] font-medium"
          style={{ color: "var(--text)" }}
          aria-expanded={open}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <Plug size={13} style={{ color: "var(--k8s-blue)" }} />
          Connect
          <span className="font-normal" style={{ color: "var(--text-faint)" }}>
            use this cluster from your terminal
          </span>
        </button>
        {open && (
          <div className="space-y-3 border-t px-3 py-3 text-[12px]" style={{ borderColor: "var(--border)" }}>
            <div className="grid grid-cols-[110px_1fr] gap-y-1" style={{ color: "var(--text-dim)" }}>
              <span>Context</span>
              <code className="font-mono-app" style={{ color: "var(--text)" }}>{contextName}</code>
              <span>API server</span>
              <code className="font-mono-app" style={{ color: "var(--text)" }}>
                {infoQuery.isLoading ? "…" : info?.server || "unknown"}
              </code>
              <span>Kubeconfig</span>
              <code className="font-mono-app break-all" style={{ color: "var(--text)" }}>{info?.path ?? "…"}</code>
            </div>
            {infoQuery.isError && (
              <div style={{ color: "var(--danger)" }}>{String(infoQuery.error)}</div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={copyKubeconfig}>
                <ClipboardCopy size={12} /> Copy kubeconfig
              </Button>
              <Button variant="secondary" size="sm" onClick={saveAs}>
                <Download size={12} /> Save kubeconfig as…
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setMergeOpen(true)}>
                <GitMerge size={12} /> Merge into ~/.kube/config
              </Button>
            </div>

            <div className="space-y-1.5">
              {snippets.map((s) => (
                <div key={s.id} className="flex items-center gap-2">
                  <code
                    className="font-mono-app min-w-0 flex-1 truncate rounded px-2 py-1"
                    style={{ background: "var(--surface-2)", color: "var(--text)" }}
                    title={s.label}
                  >
                    {s.text}
                  </code>
                  <button
                    onClick={() => copy(s.text, "command")}
                    className="opacity-60 hover:opacity-100"
                    aria-label={`Copy: ${s.label}`}
                    style={{ color: "var(--text-dim)" }}
                  >
                    <ClipboardCopy size={13} />
                  </button>
                </div>
              ))}
            </div>

            <p style={{ color: "var(--text-faint)" }}>
              Note: when colima starts Kubernetes it may switch kubectl&rsquo;s current-context to{" "}
              <code className="font-mono-app">{contextName}</code> (autoActivate). To go back to your other cluster run{" "}
              <code className="font-mono-app">kubectl config use-context &lt;name&gt;</code>. This app never changes your
              current-context and always passes <code className="font-mono-app">--context {contextName}</code>.
            </p>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
        onConfirm={merge}
        title="Merge into ~/.kube/config"
        message={
          <div className="space-y-2">
            <p>
              This adds or updates ONLY the <code className="font-mono-app">{contextName}</code> user, cluster and context
              entries in your real kubeconfig (<code className="font-mono-app">~/.kube/config</code>, or the first path of{" "}
              <code className="font-mono-app">$KUBECONFIG</code>).
            </p>
            <p>Other contexts and your current-context are never changed.</p>
            <p>A timestamped backup of the file is written first.</p>
          </div>
        }
        confirmLabel="Back up & merge"
        danger={false}
      />
    </div>
  );
}
