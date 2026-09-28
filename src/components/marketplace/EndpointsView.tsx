import { useState } from "react";
import { Copy, Eye, EyeOff, ExternalLink } from "lucide-react";
import type { MarketplaceEndpoint } from "../../lib/types";
import { Button } from "../Button";
import { useToast } from "../Toasts";

/** Opens a URL via the opener plugin (dynamically imported so it is never
 * pulled into the browser dev-mode bundle), falling back to `window.open`
 * outside Tauri — same pattern as `PortChips`/`TerminalView` on the
 * Containers page. */
async function openEndpointUrl(url: string): Promise<void> {
  try {
    const opener = await import("@tauri-apps/plugin-opener");
    await opener.openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

/** One endpoint row: Open (if it has a URL), Copy username, Copy/Reveal
 * password, Copy value (connection strings) — §6.8's "Ready card" contract,
 * reused verbatim for the Installed tab's Credentials dialog. */
function EndpointRow({ endpoint }: { endpoint: MarketplaceEndpoint }) {
  const toast = useToast();
  const [revealed, setRevealed] = useState(false);

  const handleOpen = async () => {
    if (!endpoint.url) return;
    try {
      await openEndpointUrl(endpoint.url);
    } catch (e) {
      toast.error("Failed to open URL", String(e));
    }
  };

  const handleCopy = async (label: string, value: string) => {
    try {
      await copyToClipboard(value);
      toast.success(`${label} copied`);
    } catch (e) {
      toast.error(`Failed to copy ${label.toLowerCase()}`, String(e));
    }
  };

  return (
    <div className="mkt-endpoint-row">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-medium" style={{ color: "var(--text)" }}>
            {endpoint.name}
          </span>
          {endpoint.primary && <span className="mkt-badge">Primary</span>}
        </div>
        {endpoint.url && (
          <div className="mt-0.5 truncate font-mono-app text-[11px]" style={{ color: "var(--text-faint)" }} title={endpoint.url}>
            {endpoint.url}
          </div>
        )}
        {endpoint.value && (
          <div
            className="mt-1 truncate rounded px-1.5 py-1 font-mono-app text-[11px]"
            style={{ background: "var(--surface-3)", color: "var(--text-dim)" }}
            title={endpoint.value}
          >
            {endpoint.value}
          </div>
        )}
      </div>

      <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5">
        {endpoint.url && (
          <Button variant="secondary" size="sm" onClick={handleOpen} title="Open">
            <ExternalLink size={11} /> Open
          </Button>
        )}
        {endpoint.username && (
          <Button variant="ghost" size="sm" onClick={() => handleCopy("Username", endpoint.username!)} title="Copy username">
            <Copy size={11} /> User
          </Button>
        )}
        {endpoint.password && (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRevealed((v) => !v)}
              title={revealed ? "Hide password" : "Reveal password"}
            >
              {revealed ? <EyeOff size={11} /> : <Eye size={11} />}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => handleCopy("Password", endpoint.password!)} title="Copy password">
              <Copy size={11} /> Pass
            </Button>
          </>
        )}
        {endpoint.value && (
          <Button variant="ghost" size="sm" onClick={() => handleCopy("Value", endpoint.value!)} title="Copy value">
            <Copy size={11} /> Copy
          </Button>
        )}
      </div>

      {endpoint.password && revealed && (
        <div
          className="mt-1 w-full rounded px-1.5 py-1 font-mono-app text-[11px]"
          style={{ background: "var(--surface-3)", color: "var(--text)" }}
        >
          {endpoint.password}
        </div>
      )}
    </div>
  );
}

/** The "Ready card" (§6.8): every endpoint as a row, plus notes. Shown at
 * the end of the Install dialog's progress and reused as-is for the
 * Installed tab's "Credentials" dialog. */
export function EndpointsView({ endpoints, notes }: { endpoints: MarketplaceEndpoint[]; notes: string | null }) {
  return (
    <div className="flex flex-col gap-2.5">
      {endpoints.length === 0 ? (
        <div className="text-[12.5px]" style={{ color: "var(--text-faint)" }}>
          This app has no endpoints to show.
        </div>
      ) : (
        endpoints.map((e) => <EndpointRow key={e.name} endpoint={e} />)
      )}
      {notes && (
        <div className="rounded-md px-3 py-2 text-[12px]" style={{ background: "var(--surface-2)", color: "var(--text-dim)" }}>
          {notes}
        </div>
      )}
    </div>
  );
}
