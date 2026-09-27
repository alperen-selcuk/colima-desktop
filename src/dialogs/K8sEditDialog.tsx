// YAML editor dialog for editing any namespaced Kubernetes object (§6.6):
// "Validate" runs `k8s_apply_yaml(..., dryRun: true)`, "Save" runs it with
// dryRun: false. Errors from kubectl are shown inline; a "modified since you
// opened it" conflict is called out with a distinct hint + a Reload action.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, RotateCw } from "lucide-react";
import * as api from "../lib/api";
import type { K8sNamespacedKind } from "../lib/types";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/Button";
import { K8sIcon, KIND_LABEL } from "../components/k8s/K8sIcon";
import { YamlEditor } from "../components/k8s/YamlEditor";
import { useToast } from "../components/Toasts";

interface K8sEditDialogProps {
  open: boolean;
  profile: string;
  kind: K8sNamespacedKind;
  namespace: string | null;
  name: string;
  onClose: () => void;
  onSaved: () => void;
}

const CONFLICT_HINT_PATTERNS = ["modified since you opened it", "conflict", "resourceversion"];

function isConflict(message: string): boolean {
  const lower = message.toLowerCase();
  return CONFLICT_HINT_PATTERNS.some((p) => lower.includes(p));
}

export function K8sEditDialog({ open, profile, kind, namespace, name, onClose, onSaved }: K8sEditDialogProps) {
  const toast = useToast();
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"validate" | "save" | null>(null);
  const [result, setResult] = useState<{ kind: "success" | "error"; message: string; conflict?: boolean } | null>(
    null,
  );

  const yamlQuery = useQuery({
    queryKey: ["k8sEditYaml", profile, kind, namespace, name],
    queryFn: () => api.k8sEditYaml(profile, kind, namespace, name),
    enabled: open,
  });

  useEffect(() => {
    if (open && yamlQuery.data != null && !dirty) {
      setContent(yamlQuery.data);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, yamlQuery.data]);

  useEffect(() => {
    if (!open) {
      setDirty(false);
      setResult(null);
      setBusy(null);
    }
  }, [open]);

  const handleReload = () => {
    setDirty(false);
    setResult(null);
    yamlQuery.refetch();
  };

  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? "validate" : "save");
    setResult(null);
    try {
      const output = await api.k8sApplyYaml(profile, kind, namespace, name, content, dryRun);
      setResult({ kind: "success", message: output || (dryRun ? "Valid — no changes made." : "Saved.") });
      if (!dryRun) {
        toast.success(`Saved ${name}`);
        setDirty(false);
        onSaved();
      } else {
        toast.success(`${name} is valid`);
      }
    } catch (e) {
      const message = String(e);
      setResult({ kind: "error", message, conflict: isConflict(message) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Edit ${name}`}
      width={720}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={() => run(true)} disabled={busy != null || yamlQuery.isLoading}>
            {busy === "validate" ? "Validating…" : "Validate"}
          </Button>
          <Button variant="primary" onClick={() => run(false)} disabled={busy != null || yamlQuery.isLoading}>
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="mb-3 flex items-center gap-2">
        <K8sIcon kind={kind} size={16} />
        <span className="text-[12px]" style={{ color: "var(--text-faint)" }}>
          {KIND_LABEL[kind]}
          {namespace ? ` · ${namespace}` : ""}
        </span>
      </div>

      {yamlQuery.isLoading ? (
        <div className="py-10 text-center text-[12.5px]" style={{ color: "var(--text-faint)" }}>
          Loading…
        </div>
      ) : yamlQuery.isError ? (
        <div className="rounded-md border px-3 py-2.5 text-[12.5px]" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
          Failed to load: {String(yamlQuery.error)}
        </div>
      ) : (
        <YamlEditor
          value={content}
          onChange={(v) => {
            setContent(v);
            setDirty(true);
            if (result) setResult(null);
          }}
        />
      )}

      {result && (
        <div
          className="mt-3 rounded-md border px-3 py-2.5 text-[12px]"
          style={{
            borderColor: result.kind === "success" ? "var(--accent)" : "var(--danger)",
            background: result.kind === "success" ? "var(--accent-soft)" : "var(--danger-soft)",
          }}
        >
          <div className="flex items-start gap-2">
            {result.kind === "success" ? (
              <CheckCircle2 size={14} style={{ color: "var(--accent)", marginTop: 1, flexShrink: 0 }} />
            ) : (
              <AlertTriangle size={14} style={{ color: "var(--danger)", marginTop: 1, flexShrink: 0 }} />
            )}
            <div className="min-w-0 flex-1">
              <pre className="whitespace-pre-wrap break-words font-mono-app text-[11.5px]" style={{ color: "var(--text)" }}>
                {result.message}
              </pre>
              {result.conflict && (
                <div className="mt-2 flex items-center gap-2">
                  <span style={{ color: "var(--text-dim)" }}>
                    This object was modified since you opened it.
                  </span>
                  <Button variant="secondary" size="sm" onClick={handleReload}>
                    <RotateCw size={11} /> Reload
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
