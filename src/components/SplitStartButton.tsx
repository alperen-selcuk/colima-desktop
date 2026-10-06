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
        className="btn-join-l"
      >
        <Play size={size === "sm" ? 11 : 12} /> {label}
      </Button>
      <Button
        variant="primary"
        size={size}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="btn-join-r !px-0 !w-7"
        style={{ borderLeft: "1px solid rgba(0,0,0,0.2)" }}
        title="Start options"
        aria-label="Start options"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <ChevronDown size={size === "sm" ? 11 : 12} />
      </Button>
      {open && (
        <div
          className="menu absolute left-0 top-full z-30 mt-1 min-w-[220px]" role="menu"
        >
          <button
            onClick={() => {
              setOpen(false);
              onConfigure();
            }}
            className="menu-item" role="menuitem"
          >
            Start with configuration…
          </button>
          {onQuickStartOptions && (
            <button
              onClick={() => {
                setOpen(false);
                onQuickStartOptions();
              }}
              className="menu-item" role="menuitem"
            >
              Quick start options…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
