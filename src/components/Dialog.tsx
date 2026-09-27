import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}

export function Dialog({ open, onClose, title, children, footer, width = 480 }: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center fade-in"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex flex-col rounded-lg border shadow-2xl max-h-[85vh]"
        style={{
          background: "var(--surface-1)",
          borderColor: "var(--border)",
          width,
          boxShadow: "0 24px 64px var(--shadow-color)",
        }}
      >
        <div
          className="flex items-center justify-between border-b px-4 py-3 flex-shrink-0"
          style={{ borderColor: "var(--border)" }}
        >
          <h2 className="text-[13px] font-semibold" style={{ color: "var(--text)" }}>
            {title}
          </h2>
          <button
            onClick={onClose}
            className="opacity-60 hover:opacity-100"
            style={{ color: "var(--text-dim)" }}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-4 py-4 overflow-y-auto">{children}</div>
        {footer && (
          <div
            className="flex items-center justify-end gap-2 border-t px-4 py-3 flex-shrink-0"
            style={{ borderColor: "var(--border)" }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
