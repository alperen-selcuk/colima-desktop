import { ExternalLink } from "lucide-react";
import type { Container } from "../../lib/types";

async function openUrl(url: string) {
  try {
    const opener = await import("@tauri-apps/plugin-opener");
    await opener.openUrl(url);
  } catch {
    window.open(url, "_blank");
  }
}

/** Clickable host-port chips for a container row/detail (opens the port's
 * URL in the system browser via the opener plugin, falling back to
 * `window.open` outside Tauri). */
export function PortChips({ portLinks }: { portLinks: Container["portLinks"] }) {
  if (portLinks.length === 0) {
    return (
      <span className="text-[11.5px]" style={{ color: "var(--text-faint)" }}>
        —
      </span>
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {portLinks.map((p, i) => (
        <button
          key={i}
          onClick={(e) => {
            e.stopPropagation();
            openUrl(p.url);
          }}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono-app text-[11px] hover:underline"
          style={{ background: "var(--surface-2)", color: "var(--info)" }}
          title={p.url}
        >
          {p.hostPort}
          <ExternalLink size={9} />
        </button>
      ))}
    </div>
  );
}
