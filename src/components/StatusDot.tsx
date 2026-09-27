type Tone = "good" | "bad" | "warn" | "neutral" | "info";

const TONE_COLORS: Record<Tone, string> = {
  good: "var(--accent)",
  bad: "var(--danger)",
  warn: "var(--warn)",
  neutral: "var(--text-faint)",
  info: "var(--info)",
};

/** Map common colima/docker/k8s status strings to a semantic tone. */
export function statusTone(status: string): Tone {
  const s = status.toLowerCase();
  if (["running", "up", "ready", "active", "healthy"].some((k) => s.includes(k))) return "good";
  if (["crashloopbackoff", "error", "failed", "dead", "broken", "imagepullbackoff", "errimagepull"].some((k) => s.includes(k)))
    return "bad";
  if (["stopped", "exited", "paused", "terminating", "pending", "restarting", "unknown"].some((k) => s.includes(k)))
    return "warn";
  return "neutral";
}

export function StatusDot({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) {
  return (
    <span
      className="inline-block rounded-full flex-shrink-0"
      style={{
        width: 8,
        height: 8,
        background: TONE_COLORS[tone],
        boxShadow: pulse ? `0 0 0 3px ${TONE_COLORS[tone]}33` : undefined,
      }}
    />
  );
}
