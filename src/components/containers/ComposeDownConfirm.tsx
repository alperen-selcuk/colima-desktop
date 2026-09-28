import { useState } from "react";
import { Dialog } from "../Dialog";
import { Button } from "../Button";

interface ComposeDownConfirmProps {
  open: boolean;
  project: string | null;
  onClose: () => void;
  onConfirm: (removeVolumes: boolean) => void | Promise<void>;
}

/** "Down" confirm for a compose project (§6.7): a plain confirm plus an
 * explicit "also remove volumes" checkbox (defaults unchecked — the more
 * destructive option is opt-in, never the default). */
export function ComposeDownConfirm({ open, project, onClose, onConfirm }: ComposeDownConfirmProps) {
  const [removeVolumes, setRemoveVolumes] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await onConfirm(removeVolumes);
      setRemoveVolumes(false);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Down ${project ?? ""}`}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleConfirm} disabled={busy}>
            {busy ? "Working…" : "Down"}
          </Button>
        </>
      }
    >
      <div className="text-[13px]" style={{ color: "var(--text-dim)" }}>
        This stops and removes every container in the <span className="font-mono-app">{project}</span> project. This
        can't be undone.
      </div>
      <label className="mt-3 flex items-center gap-2 text-[12.5px]" style={{ color: "var(--text)" }}>
        <input type="checkbox" checked={removeVolumes} onChange={(e) => setRemoveVolumes(e.target.checked)} />
        Also remove volumes
      </label>
    </Dialog>
  );
}
