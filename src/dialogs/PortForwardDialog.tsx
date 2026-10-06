// Port-forward dialog (§6.10): pick the remote port (from the pod's container
// ports / the service's ports, or a custom one) and an optional local port.
import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { PortForward } from "../lib/types";
import { parseIntStrict, validatePort } from "../lib/k8sManifests";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/Button";
import { Field, SelectInput, TextInput } from "../components/k8s/FormField";
import { useToast } from "../components/Toasts";
import { openExternal } from "../lib/openExternal";

export interface PortChoice {
  port: number;
  label: string; // e.g. "80 (http)"
}

interface PortForwardDialogProps {
  open: boolean;
  profile: string;
  kind: "pod" | "service";
  namespace: string;
  name: string;
  ports: PortChoice[];
  onClose: () => void;
  onStarted: (pf: PortForward) => void;
}

const CUSTOM = "custom";

export function PortForwardDialog({ open, profile, kind, namespace, name, ports, onClose, onStarted }: PortForwardDialogProps) {
  const toast = useToast();
  const [choice, setChoice] = useState<string>(CUSTOM);
  const [custom, setCustom] = useState("");
  const [local, setLocal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setChoice(ports.length > 0 ? String(ports[0].port) : CUSTOM);
      setCustom("");
      setLocal("");
      setBusy(false);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind, namespace, name]);

  const remote = choice === CUSTOM ? parseIntStrict(custom) : Number(choice);
  const localNum = parseIntStrict(local);
  const problem = validatePort(remote, "Remote port") ?? (local.trim() ? validatePort(localNum, "Local port") : null);

  const start = async () => {
    if (problem || remote == null) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const pf = await api.k8sPortForwardStart(profile, kind, namespace, name, remote, local.trim() ? localNum : null);
      toast.success(`Forwarding ${pf.url} → ${kind}/${name}:${pf.remotePort}`, undefined, {
        label: "Open",
        onClick: () => void openExternal(pf.url),
      });
      onStarted(pf);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Port forward ${kind}/${name}`}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={start} disabled={busy}>
            {busy ? "Starting…" : "Start forwarding"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={kind === "pod" ? "Container port" : "Service port"}>
          <SelectInput value={choice} onChange={(e) => setChoice(e.target.value)}>
            {ports.map((p) => (
              <option key={p.port} value={p.port}>
                {p.label}
              </option>
            ))}
            <option value={CUSTOM}>Other…</option>
          </SelectInput>
        </Field>
        {choice === CUSTOM && (
          <Field label="Remote port">
            <TextInput autoFocus type="number" min={1} max={65535} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="8080" />
          </Field>
        )}
        <Field label="Local port (optional)" hint="Blank = pick a free port automatically (bound to 127.0.0.1)">
          <TextInput type="number" min={1} max={65535} value={local} onChange={(e) => setLocal(e.target.value)} placeholder="auto" />
        </Field>
        {error && (
          <pre className="whitespace-pre-wrap break-words text-[12px]" style={{ color: "var(--danger)" }}>
            {error}
          </pre>
        )}
      </div>
    </Dialog>
  );
}
