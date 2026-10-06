import { Copy, ExternalLink, Square } from "lucide-react";
import type { PortForward } from "../../lib/types";
import { Button } from "../Button";
import { K8sIcon } from "./K8sIcon";
import { openExternal } from "../../lib/openExternal";

interface PortForwardsPanelProps {
  forwards: PortForward[];
  onStop: (pf: PortForward) => void;
  onCopy: (pf: PortForward) => void;
}

/** Strip listing the active port-forwards (Open / Copy URL / Stop). */
export function PortForwardsPanel({ forwards, onStop, onCopy }: PortForwardsPanelProps) {
  return (
    <div className="k8s-pf-strip">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
        Active port-forwards
      </div>
      {forwards.length === 0 ? (
        <div className="py-1 text-[12px]" style={{ color: "var(--text-faint)" }}>
          None. Use “Port forward…” on a pod or service row.
        </div>
      ) : (
        forwards.map((pf) => (
          <div key={pf.id} className="k8s-pf-row">
            <K8sIcon kind={pf.kind} size={14} />
            <span className="font-medium">{pf.name}</span>
            <span style={{ color: "var(--text-faint)" }}>{pf.namespace}</span>
            <span className="font-mono-app text-[11.5px]" style={{ color: "var(--text-dim)" }}>
              127.0.0.1:{pf.localPort} → {pf.remotePort}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <Button variant="ghost" size="sm" title="Open in browser" onClick={() => void openExternal(pf.url)}>
                <ExternalLink size={11} /> Open
              </Button>
              <Button variant="ghost" size="sm" title="Copy URL" onClick={() => onCopy(pf)}>
                <Copy size={11} /> Copy URL
              </Button>
              <Button variant="ghost" size="sm" title="Stop" onClick={() => onStop(pf)}>
                <Square size={11} style={{ color: "var(--danger)" }} /> Stop
              </Button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
