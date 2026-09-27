import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  message?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ icon: Icon, title, message, action }: EmptyStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div
        className="flex h-12 w-12 items-center justify-center rounded-full"
        style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
      >
        <Icon size={22} style={{ color: "var(--text-faint)" }} />
      </div>
      <div className="text-[14px] font-semibold" style={{ color: "var(--text)" }}>
        {title}
      </div>
      {message && (
        <div className="max-w-[420px] text-[12.5px]" style={{ color: "var(--text-dim)" }}>
          {message}
        </div>
      )}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
