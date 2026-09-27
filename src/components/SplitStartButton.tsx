import { useEffect, useRef, useState } from "react";
import { ChevronDown, Play } from "lucide-react";
import { Button } from "./Button";

interface SplitStartButtonProps {
  onQuickStart: () => void;
  onConfigure: () => void;
  /** Opens the legacy quick-options dialog (field grid, no comments/raw YAML). */
  onQuickStartOptions?: () => void;
  disabled?: boolean;
  size?: "sm" | "md";
  label?: string;
}

/** Split button: primary "Start" action plus a caret menu with "Start with
 * configuration…" (opens the full machine configuration editor instead).
 * Used on Machines cards and in the top bar per §6.4. */
export function SplitStartButton({
  onQuickStart,
  onConfigure,
  onQuickStartOptions,
  disabled,
  size = "sm",
  label = "Start",
}: SplitStartButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDocClick);
    return () => window.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div className="relative flex" ref={ref}>
      <Button
        variant="primary"
        size={size}
        onClick={onQuickStart}
        disabled={disabled}
        className="rounded-r-none"
      >
        <Play size={size === "sm" ? 11 : 12} /> {label}
      </Button>
      <Button
        variant="primary"
        size={size}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="rounded-l-none border-l px-1.5"
        style={{ borderLeft: "1px solid rgba(0,0,0,0.15)" }}
        aria-label="Start options"
      >
        <ChevronDown size={size === "sm" ? 11 : 12} />
      </Button>
      {open && (
        <div
          className="absolute left-0 top-full z-30 mt-1 min-w-[220px] rounded-md border py-1 shadow-lg"
          style={{ background: "var(--surface-1)", borderColor: "var(--border)", boxShadow: "0 12px 32px var(--shadow-color-lg)" }}
        >
          <button
            onClick={() => {
              setOpen(false);
              onConfigure();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-[var(--surface-2)]"
            style={{ color: "var(--text)" }}
          >
            Start with configuration…
          </button>
          {onQuickStartOptions && (
            <button
              onClick={() => {
                setOpen(false);
                onQuickStartOptions();
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-[var(--surface-2)]"
              style={{ color: "var(--text)" }}
            >
              Quick start options…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
