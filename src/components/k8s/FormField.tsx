import type { ReactNode } from "react";

const INPUT_STYLE: React.CSSProperties = {
  background: "var(--surface-2)",
  borderColor: "var(--border)",
  color: "var(--text)",
};

interface FieldProps {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}

/** Labelled form row used by the Kubernetes create / port-forward dialogs. */
export function Field({ label, hint, children, className = "" }: FieldProps) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <span className="text-[11.5px] font-medium" style={{ color: "var(--text-faint)" }}>
        {label}
      </span>
      {children}
      {hint && (
        <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
          {hint}
        </span>
      )}
    </label>
  );
}

export function TextInput({ className = "", ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      spellCheck={false}
      {...props}
      className={`w-full rounded border px-2.5 py-1.5 text-[13px] outline-none ${className}`}
      style={INPUT_STYLE}
    />
  );
}

export function SelectInput({ className = "", ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`w-full rounded border px-2 py-1.5 text-[13px] outline-none ${className}`}
      style={INPUT_STYLE}
    />
  );
}
