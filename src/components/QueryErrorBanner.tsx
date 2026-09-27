import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "./Button";

interface QueryErrorBannerProps {
  error: unknown;
  onRetry: () => void;
}

/** Error banner shown in place of an (empty, misleadingly so) table when a
 * react-query fetch failed — used across the Kubernetes page's namespaces/
 * pods/deployments/services/nodes queries so a real backend error (e.g.
 * "Kubernetes is not reachable: ...") is never silently rendered as "no
 * rows" via a `data ?? []` fallback. */
export function QueryErrorBanner({ error, onRetry }: QueryErrorBannerProps) {
  return (
    <div
      className="flex items-center gap-3 rounded-md border px-3 py-2.5 text-[12.5px]"
      style={{ background: "var(--surface-2)", borderColor: "var(--danger)", color: "var(--text)" }}
    >
      <AlertTriangle size={15} style={{ color: "var(--danger)", flexShrink: 0 }} />
      <div className="min-w-0 flex-1">
        <div className="font-medium">Failed to load</div>
        <div className="truncate" style={{ color: "var(--text-dim)" }} title={String(error)}>
          {String(error)}
        </div>
      </div>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        <RotateCw size={11} /> Retry
      </Button>
    </div>
  );
}
