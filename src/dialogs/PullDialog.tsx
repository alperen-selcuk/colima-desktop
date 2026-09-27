import { useState } from "react";
import * as api from "../lib/api";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/Button";
import { useToast } from "../components/Toasts";

interface PullDialogProps {
  open: boolean;
  profile: string;
  onClose: () => void;
  onPulled: () => void;
}

export function PullDialog({ open, profile, onClose, onPulled }: PullDialogProps) {
  const toast = useToast();
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);

  const handlePull = async () => {
    const ref = reference.trim();
    if (!ref) {
      toast.error("Image reference is required");
      return;
    }
    setBusy(true);
    try {
      await api.pullImage(profile, ref);
      toast.success(`Pulled ${ref}`);
      onPulled();
      onClose();
      setReference("");
    } catch (e) {
      toast.error(`Failed to pull ${ref}`, String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Pull image"
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handlePull} disabled={busy}>
            {busy ? "Pulling…" : "Pull"}
          </Button>
        </>
      }
    >
      <label className="flex flex-col gap-1">
        <span className="text-[11.5px] font-medium" style={{ color: "var(--text-faint)" }}>
          Image reference
        </span>
        <input
          autoFocus
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handlePull()}
          placeholder="nginx:latest"
          className="w-full rounded border px-2.5 py-1.5 text-[12.5px] font-mono-app outline-none"
          style={{ background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text)" }}
        />
      </label>
      <p className="mt-2 text-[11.5px]" style={{ color: "var(--text-faint)" }}>
        Progress streams into the operation console at the bottom of the window.
      </p>
    </Dialog>
  );
}
