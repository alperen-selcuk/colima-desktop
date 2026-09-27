import { useState } from "react";
import { Dialog } from "./Dialog";
import { Button } from "./Button";

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  message: ReactNodeLike;
  /** If set, the user must type this exact text to enable the confirm button (e.g. profile name). */
  requireTypedText?: string;
  confirmLabel?: string;
  danger?: boolean;
}

type ReactNodeLike = string | React.ReactNode;

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  requireTypedText,
  confirmLabel = "Confirm",
  danger = true,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  const canConfirm = requireTypedText ? typed === requireTypedText : true;

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
      setTyped("");
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={handleConfirm} disabled={!canConfirm || busy}>
            {busy ? "Working…" : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-[13px]" style={{ color: "var(--text-dim)" }}>
        {message}
      </div>
      {requireTypedText && (
        <div className="mt-3">
          <div className="mb-1 text-[12px]" style={{ color: "var(--text-faint)" }}>
            Type <span className="font-mono-app" style={{ color: "var(--text)" }}>{requireTypedText}</span> to
            confirm
          </div>
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="w-full rounded border px-2.5 py-1.5 text-[13px] font-mono-app outline-none"
            style={{ background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text)" }}
          />
        </div>
      )}
    </Dialog>
  );
}
