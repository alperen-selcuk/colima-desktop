import { useEffect, useRef, useState } from "react";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/Button";
import { useToast } from "../components/Toasts";
import * as api from "../lib/api";
import { formatGiB } from "../lib/disk";

interface RecreateDialogProps {
  open: boolean;
  profile: string;
  /** Full colima.yaml text to write back after the delete. */
  configContent: string;
  currentGiB: number;
  newGiB: number;
  onClose: () => void;
  onDone: () => void;
}

/** Confirm + run "recreate with smaller disk" (§6.4): requires typing the profile name. */
export function RecreateDialog({ open, profile, configContent, currentGiB, newGiB, onClose, onDone }: RecreateDialogProps) {
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!open) {
      setTyped("");
      setLines([]);
    }
  }, [open]);
  useEffect(() => () => unlistenRef.current?.(), []);

  const handleConfirm = async () => {
    setBusy(true);
    setLines([]);
    unlistenRef.current = await api.onOpLog((p) => {
      if (p.profile === profile && p.op === "recreate") setLines((l) => [...l.slice(-30), p.line]);
    });
    try {
      await api.recreateProfile(profile, configContent);
      toast.success(`${profile} recreated with a ${formatGiB(newGiB)} disk`);
      onDone();
      onClose();
    } catch (e) {
      toast.error(`Failed to recreate ${profile}`, String(e));
    } finally {
      unlistenRef.current?.();
      unlistenRef.current = null;
      setBusy(false);
    }
  };

  const guardedClose = () => {
    if (!busy) onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={guardedClose}
      title={`Recreate ${profile} with a smaller disk`}
      zIndex={200}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={guardedClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleConfirm} disabled={busy || typed !== profile}>
            {busy ? "Recreating…" : "Delete and recreate"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]" style={{ color: "var(--text-dim)" }}>
        <p>
          Disk: <b style={{ color: "var(--text)" }}>{formatGiB(currentGiB)}</b> →{" "}
          <b style={{ color: "var(--text)" }}>{formatGiB(newGiB)}</b>
        </p>
        <ul className="list-disc pl-5">
          <li>
            All images, containers, volumes and the Kubernetes cluster on this machine are{" "}
            <b style={{ color: "var(--danger)" }}>deleted</b>.
          </li>
          <li>The configuration, including the Kubernetes settings, is kept.</li>
          <li>The machine is stopped, deleted, then started again with the new configuration.</li>
        </ul>
        <div>
          <div className="mb-1 text-[12px]" style={{ color: "var(--text-faint)" }}>
            Type <span className="font-mono-app" style={{ color: "var(--text)" }}>{profile}</span> to confirm
          </div>
          <input
            autoFocus
            value={typed}
            disabled={busy}
            onChange={(e) => setTyped(e.target.value)}
            className="w-full rounded border px-2.5 py-1.5 text-[13px] font-mono-app outline-none"
            style={{ background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text)" }}
          />
        </div>
        {busy && (
          <pre
            className="max-h-40 overflow-auto rounded border p-2 text-[11px] font-mono-app"
            style={{ background: "var(--surface-2)", borderColor: "var(--border)" }}
          >
            {lines.join("\n") || "Working…"}
          </pre>
        )}
      </div>
    </Dialog>
  );
}
