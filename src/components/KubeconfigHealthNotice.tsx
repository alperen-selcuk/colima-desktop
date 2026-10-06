import { useState } from "react";
import { AlertCircle, X } from "lucide-react";
import * as api from "../lib/api";
import { Button } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { useToast } from "./Toasts";

interface KubeconfigHealthNoticeProps {
  profile: string;
  contextName: string;
  onDismiss: () => void;
}

/** Small, dismissible notice shown on the Kubernetes page when
 * `host_kubeconfig_health` reports `credentialsMatch: false` — i.e. `kubectl`
 * in the user's own terminal would fail against this cluster even though the
 * app itself (via the app-managed kubeconfig, §2.1a) works fine. The **Fix**
 * button explains exactly what will change and writes a backup before
 * touching anything. */
export function KubeconfigHealthNotice({ profile, contextName, onDismiss }: KubeconfigHealthNoticeProps) {
  const toast = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleFix = async () => {
    try {
      const result = await api.repairHostKubeconfig(profile);
      toast.success("kubeconfig repaired", `Backup written to ${result.backupPath}`);
      onDismiss();
    } catch (e) {
      toast.error("Failed to repair kubeconfig", String(e));
    }
  };

  return (
    <>
      <div
        className="flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-[12.5px]"
        style={{ background: "var(--surface-2)", borderColor: "var(--warn)", color: "var(--text)" }}
      >
        <AlertCircle size={15} style={{ color: "var(--warn)", flexShrink: 0, marginTop: 1 }} />
        <div className="min-w-0 flex-1">
          <div>
            kubectl in your terminal can&rsquo;t reach this cluster: <code className="font-mono-app">~/.kube/config</code>{" "}
            has outdated credentials for context <code className="font-mono-app">{contextName}</code>.
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setConfirmOpen(true)}>
          Fix
        </Button>
        <Button variant="ghost" size="sm" onClick={onDismiss} title="Dismiss"><X size={14} /></Button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleFix}
        title="Fix kubeconfig credentials"
        message={
          <div className="space-y-2">
            <p>
              This updates ONLY the <code className="font-mono-app">users.{contextName}</code> and{" "}
              <code className="font-mono-app">clusters.{contextName}</code> entries in your real{" "}
              <code className="font-mono-app">~/.kube/config</code>, copying the current client certificate, client
              key, CA certificate, and server address from this app&rsquo;s own working connection to the cluster.
            </p>
            <p>No other context, user, cluster, or your current-context is touched.</p>
            <p>
              A full backup of your kubeconfig is written first, to{" "}
              <code className="font-mono-app">~/.kube/config.colima-desktop-bak-&lt;timestamp&gt;</code>, before any
              change is made.
            </p>
          </div>
        }
        confirmLabel="Back up & fix"
        danger={false}
      />
    </>
  );
}
