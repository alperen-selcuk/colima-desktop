import { useState } from "react";
import type { InstalledApp } from "../lib/types";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/Button";

interface MarketplaceUninstallDialogProps {
  open: boolean;
  app: InstalledApp | null;
  onClose: () => void;
  onConfirm: (removeVolumes: boolean) => void | Promise<void>;
}

/** Uninstall confirmation (§6.8): "also delete data volumes" checkbox ->
 * `marketplace_uninstall(profile, projectName, removeVolumes)`. Separate
 * from the generic `ConfirmDialog` because of that extra checkbox. */
export function MarketplaceUninstallDialog({ open, app, onClose, onConfirm }: MarketplaceUninstallDialogProps) {
  const [removeVolumes, setRemoveVolumes] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!app) return null;

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
      title={`Uninstall ${app.name}`}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleConfirm} disabled={busy}>
            {busy ? "Uninstalling…" : "Uninstall"}
          </Button>
        </>
      }
    >
      <div className="text-[13px]" style={{ color: "var(--text-dim)" }}>
        This stops and removes the "{app.projectName}" containers. This can't be undone.
      </div>
      <label className="mt-3 flex items-start gap-2 text-[12.5px]" style={{ color: "var(--text)" }}>
        <input
          type="checkbox"
          checked={removeVolumes}
          onChange={(e) => setRemoveVolumes(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          Also delete data volumes
          <span className="block text-[11.5px]" style={{ color: "var(--text-faint)" }}>
            Removes any stored data (databases, indexes, uploaded files). Leave unchecked to keep it for a future install.
          </span>
        </span>
      </label>
    </Dialog>
  );
}
