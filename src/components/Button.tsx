import { Children, forwardRef, isValidElement, type ButtonHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-outline";
export type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Square, bordered tile for icon-only buttons. Auto-enabled when every child is an element (no text). */
  iconOnly?: boolean;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
}

/**
 * Shared button. Styles live in index.css (`.btn*`) so hover / active / focus /
 * disabled behave identically in both themes. Icon-only buttons need a `title`;
 * it is mirrored into `aria-label` automatically.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "secondary", size = "md", iconOnly, loading, className = "", disabled, children, title, ...rest }, ref) => {
    const kids = Children.toArray(children);
    const icon = iconOnly ?? (kids.length > 0 && kids.every((c) => isValidElement(c)));
    return (
      <button
        ref={ref}
        type="button"
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        title={title}
        aria-label={rest["aria-label"] ?? (icon ? title : undefined)}
        className={`btn btn-${variant} btn-${size}${icon ? " btn-icon" : ""} ${className}`}
        {...rest}
      >
        {loading ? <Loader2 size={size === "sm" ? 12 : 14} className="spin" /> : null}
        {loading && icon ? null : children}
      </button>
    );
  },
);
Button.displayName = "Button";

/** Icon-only button: bordered tile + mandatory tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, Omit<ButtonProps, "iconOnly" | "title"> & { title: string }>(
  ({ variant = "ghost", ...props }, ref) => <Button ref={ref} variant={variant} iconOnly {...props} />,
);
IconButton.displayName = "IconButton";
