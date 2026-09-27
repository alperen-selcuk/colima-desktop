import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/Button";
import { useToast } from "../components/Toasts";

interface ScaleDialogProps {
  open: boolean;
  profile: string;
  namespace: string;
  name: string;
  currentReplicas: number;
  onClose: () => void;
  onScaled: () => void;
}

export function ScaleDialog({ open, profile, namespace, name, currentReplicas, onClose, onScaled }: ScaleDialogProps) {
  const toast = useToast();
  const [replicas, setReplicas] = useState(currentReplicas);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setReplicas(currentReplicas);
  }, [open, currentReplicas]);

  const handleScale = async () => {
    setBusy(true);
    try {
      await api.k8sScale(profile, namespace, name, replicas);
      toast.success(`Scaled ${name} to ${replicas} replicas`);
      onScaled();
      onClose();
    } catch (e) {
      toast.error(`Failed to scale ${name}`, String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Scale ${name}`}
      width={360}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleScale} disabled={busy}>
            {busy ? "Scaling…" : "Scale"}
          </Button>
        </>
      }
    >
      <label className="flex flex-col gap-1">
        <span className="text-[11.5px] font-medium" style={{ color: "var(--text-faint)" }}>
          Replicas
        </span>
        <input
          autoFocus
          type="number"
          min={0}
          value={replicas}
          onChange={(e) => setReplicas(Number(e.target.value))}
          className="w-full rounded border px-2.5 py-1.5 text-[13px] outline-none"
          style={{ background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text)" }}
        />
      </label>
    </Dialog>
  );
}
