import { selectUsage, usageTone, usageTooltip, type UsageTone } from "../lib/k8sView";

const TONE_VAR: Record<UsageTone, string> = {
  good: "var(--accent)",
  warn: "var(--warn)",
  bad: "var(--danger)",
};

interface UsageBarProps {
  kind: "cpu" | "memory";
  usedValue: number | null;
  limit: number | null;
  request: number | null;
  allocatable: number | null;
  /** When live metrics aren't available, show "—" rather than a bar (used by
   * both the Kubernetes page's metrics-server integration and the
   * Containers page's `docker stats`). */
  metricsAvailable: boolean;
}

/** Coloured CPU/Memory usage bar + a tooltip with exact values (e.g. "120m /
 * 500m limit"). Shared by the Kubernetes page (pods/nodes, §6.6) and the
 * Containers page (§6.7); renders "—" when there's no metrics value or no
 * denominator to compute a percentage against.
 *
 * This was originally `src/components/k8s/UsageBar.tsx`; that file now
 * re-exports this one unchanged so the Kubernetes page keeps working
 * without any import changes. */
export function UsageBar({ kind, usedValue, limit, request, allocatable, metricsAvailable }: UsageBarProps) {
  if (!metricsAvailable || usedValue == null) {
    return (
      <span className="text-[12px]" style={{ color: "var(--text-faint)" }}>
        —
      </span>
    );
  }

  const result = selectUsage(usedValue, limit, request, allocatable);
  if (result.percent == null) {
    return (
      <span className="text-[12px]" style={{ color: "var(--text-faint)" }}>
        —
      </span>
    );
  }

  const tone = usageTone(result.percent);
  const tooltip = usageTooltip(usedValue, result, kind);
  const width = Math.max(2, Math.min(100, result.percent));

  return (
    <div className="flex min-w-[92px] items-center gap-1.5" title={tooltip}>
      <div
        style={{
          position: "relative",
          height: 5,
          width: "100%",
          borderRadius: 3,
          background: "var(--surface-3)",
          overflow: "hidden",
        }}
      >
        <span
          style={{
            display: "block",
            height: "100%",
            borderRadius: 3,
            width: `${width}%`,
            background: TONE_VAR[tone],
            transition: "width 0.25s ease",
          }}
        />
      </div>
      <span className="font-mono-app text-[10.5px] tabular-nums" style={{ color: "var(--text-faint)", minWidth: 30 }}>
        {Math.round(result.percent)}%
      </span>
    </div>
  );
}
