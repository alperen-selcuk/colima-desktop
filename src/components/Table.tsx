import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";

export function Table({ children }: { children: ReactNode }) {
  return (
    <table className="w-full border-collapse text-[12.5px]" style={{ color: "var(--text)" }}>
      {children}
    </table>
  );
}

export function Thead({ children }: { children: ReactNode }) {
  return (
    <thead
      className="sticky top-0 z-10"
      style={{ background: "var(--surface-1)", borderBottom: "1px solid var(--border)" }}
    >
      <tr>{children}</tr>
    </thead>
  );
}

export function Th({ children, className = "", ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={`px-3 py-2 text-left text-[11px] font-medium tracking-wide ${className}`}
      style={{ color: "var(--text-faint)" }}
      {...rest}
    >
      {children}
    </th>
  );
}

export function Td({ children, className = "", ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={`px-3 py-2 align-middle ${className}`} {...rest}>
      {children}
    </td>
  );
}

export function Tr({
  children,
  onClick,
  selected = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  selected?: boolean;
}) {
  return (
    <tr
      onClick={onClick}
      className={onClick ? "cursor-pointer" : ""}
      style={{
        borderBottom: "1px solid var(--border)",
        background: selected ? "var(--accent-soft)" : undefined,
      }}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.background = "var(--surface-2)";
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.background = "";
      }}
    >
      {children}
    </tr>
  );
}
