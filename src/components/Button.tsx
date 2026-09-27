import { forwardRef, type ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const VARIANT_STYLES: Record<Variant, { base: string; style: React.CSSProperties }> = {
  primary: {
    base: "hover:brightness-110 active:brightness-95",
    style: { background: "var(--accent)", color: "var(--accent-contrast)", border: "1px solid transparent" },
  },
  secondary: {
    base: "hover:brightness-110",
    style: { background: "var(--surface-3)", color: "var(--text)", border: "1px solid var(--border-strong)" },
  },
  ghost: {
    base: "hover:bg-[var(--surface-2)]",
    style: { background: "transparent", color: "var(--text-dim)", border: "1px solid transparent" },
  },
  danger: {
    base: "hover:brightness-110",
    style: { background: "var(--danger)", color: "#fff", border: "1px solid transparent" },
  },
};

const SIZE_STYLES: Record<Size, string> = {
  sm: "px-2 py-1 text-[12px] gap-1",
  md: "px-3 py-1.5 text-[13px] gap-1.5",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "secondary", size = "md", className = "", style, disabled, children, ...rest }, ref) => {
    const v = VARIANT_STYLES[variant];
    return (
      <button
        ref={ref}
        disabled={disabled}
        className={`inline-flex items-center justify-center rounded-md font-medium transition-[filter] disabled:opacity-45 disabled:cursor-not-allowed whitespace-nowrap ${v.base} ${SIZE_STYLES[size]} ${className}`}
        style={{ ...v.style, ...style }}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";
