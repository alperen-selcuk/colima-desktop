import { useEffect, useRef, useState } from "react";
import { ChevronDown, TerminalSquare } from "lucide-react";
import { Button } from "./Button";

interface TerminalSplitButtonProps {
  /** Login shell basename, e.g. "zsh". */
  shell: string;
  profile: string | null;
  vmEnabled: boolean;
  onLocal: () => void;
  onVm: () => void;
  size?: "sm" | "md";
  label?: string;
}

/** Split button: main click opens the user's local login shell; the caret menu
 * opens the Colima VM shell (`colima ssh`). */
export function TerminalSplitButton({ shell, profile, vmEnabled, onLocal, onVm, size = "sm", label }: TerminalSplitButtonProps) {
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
        variant="secondary"
        size={size}
        onClick={onLocal}
        title={`Open local shell (${shell})`}
        aria-label={label ? undefined : `Open local shell (${shell})`}
        className="btn-join-l"
        iconOnly={!label}
      >
        <TerminalSquare size={size === "sm" ? 11 : 12} /> {label}
      </Button>
      <Button
        variant="secondary"
        size={size}
        onClick={() => setOpen((v) => !v)}
        className="btn-join-r !px-0 !w-7"
        style={{ marginLeft: -1 }}
        title="Terminal options"
        aria-label="Terminal options"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <ChevronDown size={size === "sm" ? 11 : 12} />
      </Button>
      {open && (
        <div
          className="menu absolute right-0 top-full z-30 mt-1 min-w-[230px]" role="menu"
        >
          <button
            onClick={() => {
              setOpen(false);
              onLocal();
            }}
            className="menu-item" role="menuitem"
          >
            Local shell ({shell})
          </button>
          <button
            disabled={!vmEnabled}
            onClick={() => {
              setOpen(false);
              onVm();
            }}
            className="menu-item" role="menuitem"
          >
            Colima VM shell ({profile ?? "default"})
          </button>
        </div>
      )}
    </div>
  );
}
