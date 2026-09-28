import { useState } from "react";
import { ExternalLink, KeyRound, MoreHorizontal, Play, RotateCw, Square, Trash2 } from "lucide-react";
import type { CatalogItem, InstalledApp } from "../../lib/types";
import { primaryEndpoint } from "../../lib/marketplace";
import { StatusDot, statusTone } from "../StatusDot";
import { Button } from "../Button";
import { CatalogIcon } from "./CatalogIcon";
import { useToast } from "../Toasts";

/** Same dynamic-import opener pattern as `PortChips`/`EndpointsView` — keeps
 * the plugin out of the browser dev-mode bundle and falls back to
 * `window.open` outside Tauri. */
async function openEndpointUrl(url: string): Promise<void> {
  try {
    const opener = await import("@tauri-apps/plugin-opener");
    await opener.openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

interface InstalledAppCardProps {
  app: InstalledApp;
  item: CatalogItem | null; // null if the catalog no longer lists this item (still shown, degraded)
  onCredentials: () => void;
  onAction: (action: "stop" | "start" | "restart") => void;
  onUninstall: () => void;
}

/** One Installed-tab card (§6.8): live status, Open (primary endpoint),
 * Credentials (opens the Ready view in a dialog), Stop/Start/Restart via the
 * existing compose_action API, Uninstall. */
export function InstalledAppCard({ app, item, onCredentials, onAction, onUninstall }: InstalledAppCardProps) {
  const toast = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const missing = app.status === "missing";
  const running = app.status.startsWith("running") && !app.status.includes("exited");
  const primary = primaryEndpoint(app.endpoints);
  const category = item?.category ?? "devtools";

  const handleOpen = async () => {
    if (!primary?.url) return;
    try {
      await openEndpointUrl(primary.url);
    } catch (e) {
      toast.error("Failed to open URL", String(e));
    }
  };

  return (
    <div className="mkt-card" style={{ cursor: "default" }}>
      <div className="flex items-start justify-between gap-2">
        <CatalogIcon icon={app.icon} category={category} size={32} />
        <div className="relative flex-shrink-0">
          <Button variant="ghost" size="sm" onClick={() => setMenuOpen((v) => !v)} title="Actions">
            <MoreHorizontal size={13} />
          </Button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div
                className="absolute right-0 top-full z-20 mt-1 min-w-[160px] rounded-md border py-1 shadow-lg"
                style={{ background: "var(--surface-1)", borderColor: "var(--border)" }}
              >
                <MenuItem icon={<Play size={11} />} label="Start" disabled={running} onClick={() => { setMenuOpen(false); onAction("start"); }} />
                <MenuItem icon={<Square size={11} />} label="Stop" disabled={!running} onClick={() => { setMenuOpen(false); onAction("stop"); }} />
                <MenuItem icon={<RotateCw size={11} />} label="Restart" disabled={!running} onClick={() => { setMenuOpen(false); onAction("restart"); }} />
                <div className="my-1 border-t" style={{ borderColor: "var(--border)" }} />
                <MenuItem icon={<Trash2 size={11} />} label="Uninstall…" danger onClick={() => { setMenuOpen(false); onUninstall(); }} />
              </div>
            </>
          )}
        </div>
      </div>

      <div>
        <div className="truncate text-[13px] font-semibold" style={{ color: "var(--text)" }}>
          {app.name}
        </div>
        <div className="mt-0.5 truncate font-mono-app text-[10.5px]" style={{ color: "var(--text-faint)" }}>
          {app.projectName}
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <StatusDot tone={missing ? "warn" : statusTone(app.status)} pulse={running} />
        <span className="text-[11.5px]" style={{ color: missing ? "var(--warn)" : "var(--text-dim)" }}>
          {missing ? "Missing" : app.status}
        </span>
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        <Button variant="primary" size="sm" onClick={handleOpen} disabled={!primary?.url || !running} className="flex-1 justify-center">
          <ExternalLink size={11} /> Open
        </Button>
        <Button variant="secondary" size="sm" onClick={onCredentials}>
          <KeyRound size={11} /> Credentials
        </Button>
      </div>
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  danger = false,
  disabled = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-[var(--surface-2)] disabled:opacity-40"
      style={{ color: danger ? "var(--danger)" : "var(--text)" }}
    >
      {icon}
      {label}
    </button>
  );
}
