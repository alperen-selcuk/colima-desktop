import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/Button";
import { computePrunePreview, formatSizeBytes, volumeSourceLabel, type PruneScope } from "../lib/volumes";
import type { Volume } from "../lib/types";

interface PruneVolumesDialogProps {
  open: boolean;
  volumes: Volume[];
  onClose: () => void;
  onConfirm: (scope: PruneScope) => void | Promise<void>;
}

const REQUIRED_TYPED_TEXT = "delete";

/** Prune dialog (bug fix): the old "Prune unused" button ran a plain
 * `docker volume prune -f`, which — since Docker 23 — only removes
 * ANONYMOUS unused volumes, never named ones (the motivating bug report:
 * `compose down` without `-v` leaves named volumes behind, and the button
 * silently did nothing for them). This dialog makes the two scopes
 * explicit, previews exactly which volumes each one would remove (computed
 * client-side from the current list, matching the backend's own selection:
 * `!inUse && (all || anonymous)`), and requires typing "delete" before the
 * destructive "all" option (which can remove named volumes with real data)
 * can be confirmed. */
export function PruneVolumesDialog({ open, volumes, onClose, onConfirm }: PruneVolumesDialogProps) {
  const [scope, setScope] = useState<PruneScope>("anonymous");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  const preview = useMemo(() => computePrunePreview(volumes, scope), [volumes, scope]);
  const isEmpty = preview.volumes.length === 0;
  const requiresTyped = scope === "all" && preview.namedCount > 0;
  const canConfirm = !isEmpty && (!requiresTyped || typed === REQUIRED_TYPED_TEXT);

  const reset = () => {
    setScope("anonymous");
    setTyped("");
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await onConfirm(scope);
      reset();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Prune volumes"
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={handleConfirm}
            disabled={!canConfirm || busy}
            title={isEmpty ? "Nothing to prune" : undefined}
          >
            {busy ? "Pruning…" : isEmpty ? "Nothing to prune" : `Prune ${preview.volumes.length}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <label
          className="vol-prune-option"
          data-active={scope === "anonymous"}
          onClick={() => {
            setScope("anonymous");
            setTyped("");
          }}
        >
          <input
            type="radio"
            name="prune-scope"
            className="mt-0.5"
            checked={scope === "anonymous"}
            onChange={() => {
              setScope("anonymous");
              setTyped("");
            }}
          />
          <div>
            <div className="text-[12.5px] font-medium" style={{ color: "var(--text)" }}>
              Unused anonymous volumes
            </div>
            <div className="text-[11.5px]" style={{ color: "var(--text-dim)" }}>
              docker's own default (<code className="font-mono-app">volume prune</code>). Never touches named
              volumes.
            </div>
          </div>
        </label>

        <label
          className="vol-prune-option"
          data-active={scope === "all"}
          onClick={() => setScope("all")}
        >
          <input
            type="radio"
            name="prune-scope"
            className="mt-0.5"
            checked={scope === "all"}
            onChange={() => setScope("all")}
          />
          <div>
            <div className="text-[12.5px] font-medium" style={{ color: "var(--text)" }}>
              All unused volumes (including named)
            </div>
            <div className="text-[11.5px]" style={{ color: "var(--text-dim)" }}>
              <code className="font-mono-app">volume prune -a</code>. Also removes named volumes not used by any
              container — including leftovers from <code className="font-mono-app">compose down</code> without{" "}
              <code className="font-mono-app">-v</code>.
            </div>
          </div>
        </label>
      </div>

      {requiresTyped && (
        <div
          className="mt-3 flex items-start gap-2 rounded-md border px-3 py-2.5 text-[12px]"
          style={{ background: "var(--surface-2)", borderColor: "var(--danger)", color: "var(--text)" }}
        >
          <AlertTriangle size={14} style={{ color: "var(--danger)", flexShrink: 0, marginTop: 1 }} />
          <div>
            This permanently deletes {preview.namedCount} named volume{preview.namedCount === 1 ? "" : "s"} and all
            data stored in {preview.namedCount === 1 ? "it" : "them"}. This cannot be undone.
          </div>
        </div>
      )}

      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between text-[11px]" style={{ color: "var(--text-faint)" }}>
          <span>
            {isEmpty
              ? "Nothing matches this scope"
              : `${preview.volumes.length} volume${preview.volumes.length === 1 ? "" : "s"} will be removed`}
          </span>
          {!isEmpty && <span>{formatSizeBytes(preview.totalBytes)}{preview.unknownSizeCount > 0 ? " +?" : ""}</span>}
        </div>
        {!isEmpty && (
          <div
            className="max-h-[220px] overflow-y-auto rounded-md border px-3"
            style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
          >
            {preview.volumes.map((v) => (
              <div key={v.name} className="vol-prune-preview-row">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-mono-app" style={{ color: "var(--text)" }} title={v.name}>
                    {v.name}
                  </span>
                  <span style={{ color: "var(--text-faint)" }}>{volumeSourceLabel(v)}</span>
                </div>
                <span className="flex-shrink-0" style={{ color: "var(--text-dim)" }}>
                  {v.size ?? "—"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {requiresTyped && (
        <div className="mt-3">
          <div className="mb-1 text-[12px]" style={{ color: "var(--text-faint)" }}>
            Type{" "}
            <span className="font-mono-app" style={{ color: "var(--text)" }}>
              {REQUIRED_TYPED_TEXT}
            </span>{" "}
            to confirm
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
