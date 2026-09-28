import { AlertTriangle } from "lucide-react";

/** Shown instead of a working "Compose up…" button when `compose_info`
 * reports `available: false` (§6.7) — the button becomes disabled and this
 * inline hint (the backend-provided install instructions) is shown next to
 * it rather than letting the user click into a guaranteed failure. */
export function ComposeInstallHint({ hint }: { hint: string | null }) {
  return (
    <div
      className="flex items-start gap-2 rounded-md border px-2.5 py-2 text-[11.5px]"
      style={{ borderColor: "var(--border)", background: "var(--surface-2)", color: "var(--text-dim)" }}
    >
      <AlertTriangle size={13} style={{ color: "var(--warn)", flexShrink: 0, marginTop: 1 }} />
      <span>{hint ?? "Docker Compose isn't available for this machine."}</span>
    </div>
  );
}
