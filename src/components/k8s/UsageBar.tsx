import { selectUsage, usageTone, usageTooltip, type UsageTone } from "../../lib/k8sView";

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
  /** When the cluster-wide metrics API isn't available, show "—" rather
   * than a bar (§6.6: "Metrics unavailable -> subtle note, columns show "—""). */
  metricsAvailable: boolean;
}

/** Coloured CPU/Memory usage bar for a pod or node row + a tooltip with
 * exact values (e.g. "120m / 500m limit"). Renders "—" when there's no
 * metrics value or no denominator to compute a percentage against. */
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
      <div className="k8s-usage-bar">
        <span style={{ width: `${width}%`, background: TONE_VAR[tone] }} />
      </div>
      <span className="font-mono-app text-[10.5px] tabular-nums" style={{ color: "var(--text-faint)", minWidth: 30 }}>
        {Math.round(result.percent)}%
      </span>
    </div>
  );
}
