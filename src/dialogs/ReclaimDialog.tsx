import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/Button";
import { useToast } from "../components/Toasts";
import * as api from "../lib/api";
import { formatBytes } from "../lib/format";
import { reclaimResultMessage } from "../lib/disk";

interface ReclaimDialogProps {
  open: boolean;
  profile: string;
  onClose: () => void;
  /** Navigate to the Volumes page for this machine. */
  onOpenVolumes?: (profile: string) => void;
}

/** "Reclaim space" (§6.4): prune unused docker data (not volumes) then fstrim the VM. */
export function ReclaimDialog({ open, profile, onClose, onOpenVolumes }: ReclaimDialogProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const unlistenRef = useRef<(() => void) | null>(null);

  const diskQuery = useQuery({
    queryKey: ["profileDiskInfo", profile],
    queryFn: () => api.profileDiskInfo(profile),
    enabled: open,
  });
  const before = diskQuery.data?.usedOnHostBytes ?? null;

  useEffect(() => {
    if (!open) setLines([]);
  }, [open]);
  useEffect(() => () => unlistenRef.current?.(), []);

  const handleRun = async () => {
    setBusy(true);
    setLines([]);
    unlistenRef.current = await api.onOpLog((p) => {
      if (p.profile === profile && p.op === "reclaim") setLines((l) => [...l.slice(-30), p.line]);
    });
    try {
      await api.reclaimSpace(profile);
      const after = (await api.profileDiskInfo(profile)).usedOnHostBytes;
      queryClient.invalidateQueries({ queryKey: ["profileDiskInfo", profile] });
      toast.success(reclaimResultMessage(before, after));
      onClose();
    } catch (e) {
      toast.error(`Failed to reclaim space on ${profile}`, String(e));
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
      title={`Reclaim space on ${profile}`}
      zIndex={200}
      width={500}
      footer={
        <>
          <Button variant="ghost" onClick={guardedClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleRun} disabled={busy}>
            {busy ? "Reclaiming…" : "Reclaim space"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]" style={{ color: "var(--text-dim)" }}>
        <p>
          The VM disk currently uses{" "}
          <b style={{ color: "var(--text)" }}>{before != null ? formatBytes(before) : "an unknown amount"}</b> on your Mac.
        </p>
        <p>
          This runs <span className="font-mono-app">docker system prune -af</span> (removes stopped containers, unused
          networks, and all unused images and build cache), then trims the VM disk so the freed space returns to your Mac.
        </p>
        <p>
          <b style={{ color: "var(--text)" }}>Volumes are not touched.</b> To remove unused volumes, use the{" "}
          {onOpenVolumes ? (
            <button
              className="underline"
              style={{ color: "var(--accent)" }}
              onClick={() => {
                onClose();
                onOpenVolumes(profile);
              }}
              disabled={busy}
            >
              Volumes page
            </button>
          ) : (
            "Volumes page"
          )}
          .
        </p>
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
