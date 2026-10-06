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
        variant="ghost"
        size={size}
        onClick={onLocal}
        title={`Local shell (${shell})`}
        className="rounded-r-none"
      >
        <TerminalSquare size={size === "sm" ? 11 : 12} /> {label}
      </Button>
      <Button
        variant="ghost"
        size={size}
        onClick={() => setOpen((v) => !v)}
        className="rounded-l-none px-1"
        aria-label="Terminal options"
      >
        <ChevronDown size={size === "sm" ? 11 : 12} />
      </Button>
      {open && (
        <div
          className="absolute right-0 top-full z-30 mt-1 min-w-[230px] rounded-md border py-1 shadow-lg"
          style={{ background: "var(--surface-1)", borderColor: "var(--border)", boxShadow: "0 12px 32px var(--shadow-color-lg)" }}
        >
          <button
            onClick={() => {
              setOpen(false);
              onLocal();
            }}
            className="block w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-[var(--surface-2)]"
            style={{ color: "var(--text)" }}
          >
            Local shell ({shell})
          </button>
          <button
            disabled={!vmEnabled}
            onClick={() => {
              setOpen(false);
              onVm();
            }}
            className="block w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-[var(--surface-2)] disabled:opacity-40"
            style={{ color: "var(--text)" }}
          >
            Colima VM shell ({profile ?? "default"})
          </button>
        </div>
      )}
    </div>
  );
}
