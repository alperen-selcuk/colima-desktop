import { Loader2, ChevronDown, RotateCw, Settings, Square } from "lucide-react";
import { useState } from "react";
import type { Profile, ProfileStatus } from "../lib/types";
import { StatusDot, statusTone } from "./StatusDot";
import { Button } from "./Button";
import { SplitStartButton } from "./SplitStartButton";
import { TerminalSplitButton } from "./TerminalSplitButton";
import { opLabel, type ActiveOp } from "../lib/opPhase";

interface TopBarProps {
  profiles: Profile[];
  selected: string | null;
  onSelect: (name: string) => void;
  status: ProfileStatus | null | undefined;
  currentProfile: Profile | undefined;
  busy: boolean;
  /** Lifecycle operations in flight for any profile (global activity indicator). */
  ops?: ActiveOp[];
  onStart: () => void;
  onConfigure: () => void;
  onQuickStartOptions: () => void;
  onStop: () => void;
  onRestart: () => void;
  /** Opens the local host shell tab. */
  onTerminal: () => void;
  /** Opens the Colima VM (`colima ssh`) shell tab. */
  onTerminalVm: () => void;
  shell: string;
}

export function TopBar({
  profiles,
  selected,
  onSelect,
  status,
  currentProfile,
  busy,
  ops = [],
  onStart,
  onConfigure,
  onQuickStartOptions,
  onStop,
  onRestart,
  onTerminal,
  onTerminalVm,
  shell,
}: TopBarProps) {
  const [open, setOpen] = useState(false);
  const running = currentProfile?.status === "Running";

  const pillLabel = busy
    ? running
      ? "Stopping…"
      : "Starting…"
    : currentProfile?.status ?? "Unknown";

  return (
    <div
      className="flex h-12 flex-shrink-0 items-center gap-3 border-b px-4"
      style={{ background: "var(--surface-1)", borderColor: "var(--border)" }}
    >
      <div className="relative">
        <button
          onClick={() => setOpen((o) => !o)}
          className="btn btn-secondary btn-sm gap-2 !px-2.5"
          aria-haspopup="menu"
          aria-expanded={open}
                  >
          <StatusDot tone={statusTone(currentProfile?.status ?? "")} pulse={running} />
          {selected ?? "no profile"}
          <ChevronDown size={13} style={{ color: "var(--text-faint)" }} />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <div
              className="menu absolute left-0 top-full z-20 mt-1" role="menu"
            >
              {profiles.map((p) => (
                <button
                  key={p.name}
                  onClick={() => {
                    onSelect(p.name);
                    setOpen(false);
                  }}
                  className="menu-item" role="menuitem"
                >
                  <StatusDot tone={statusTone(p.status)} />
                  {p.name}
                  <span className="ml-auto text-[11px]" style={{ color: "var(--text-faint)" }}>
                    {p.status}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div
        className="pill"
        style={{
          background: busy ? "var(--warn-soft)" : running ? "var(--accent-soft)" : "var(--surface-3)",
          color: busy ? "var(--warn)" : running ? "var(--accent-strong)" : "var(--text-dim)",
        }}
      >
        {pillLabel}
      </div>

      {ops.length > 0 && (
        <div
          className="pill"
          style={{ background: "var(--warn-soft)", color: "var(--warn)" }}
          title="Operation in progress — see the Output tab for details"
        >
          <Loader2 size={11} className="spin" />
          {ops.map(opLabel).join(" · ")}
        </div>
      )}

      {status?.kubernetes && (
        <div
          className="pill"
          style={{ background: "var(--info-soft)", color: "var(--info)" }}
        >
          k8s on
        </div>
      )}

      <div className="ml-auto flex items-center gap-2">
        {running ? (
          <Button variant="secondary" size="sm" onClick={onStop} disabled={busy}>
            <Square size={12} /> Stop
          </Button>
        ) : (
          <SplitStartButton
            onQuickStart={onStart}
            onConfigure={onConfigure}
            onQuickStartOptions={onQuickStartOptions}
            disabled={busy}
          />
        )}
        <Button variant="secondary" size="sm" onClick={onConfigure} disabled={busy} title="Configure machine">
          <Settings size={12} /> Configure
        </Button>
        <Button variant="ghost" size="sm" onClick={onRestart} disabled={busy || !running} title="Restart machine">
          <RotateCw size={13} />
        </Button>
        <TerminalSplitButton
          shell={shell}
          profile={selected}
          vmEnabled={running}
          onLocal={onTerminal}
          onVm={onTerminalVm}
          size="sm"
          label="Terminal"
        />
      </div>
    </div>
  );
}
