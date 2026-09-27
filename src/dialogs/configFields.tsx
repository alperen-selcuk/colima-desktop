// Small, reusable form controls shared by the machine configuration editor
// (§6.4). Kept separate from MachineConfigDialog.tsx to keep that file
// focused on section layout and state wiring.
import { Minus, Plus, X } from "lucide-react";
import type { ReactNode } from "react";

const inputBase =
  "w-full rounded border px-2.5 py-1.5 text-[12.5px] outline-none disabled:opacity-50";
const inputStyle = { background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text)" };

/** Label + YAML key + one-line help + modified marker, wrapping any control. */
export function FieldRow({
  label,
  yamlKey,
  help,
  modified,
  children,
  invalid,
}: {
  label: string;
  yamlKey: string;
  help?: string;
  modified?: boolean;
  invalid?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5">
        <span className="text-[12px] font-medium" style={{ color: "var(--text)" }}>
          {label}
        </span>
        {modified && (
          <span
            title="Modified"
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: "var(--accent)" }}
          />
        )}
        <code
          className="ml-auto rounded px-1 py-0.5 font-mono-app text-[10px]"
          style={{ background: "var(--surface-3)", color: "var(--text-faint)" }}
        >
          {yamlKey}
        </code>
      </span>
      {children}
      {help && (
        <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
          {help}
        </span>
      )}
      {invalid && (
        <span className="text-[11px]" style={{ color: "var(--danger)" }}>
          {invalid}
        </span>
      )}
    </label>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className = "", style, ...rest } = props;
  return <input className={`${inputBase} ${className}`} style={{ ...inputStyle, ...style }} {...rest} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = "", style, ...rest } = props;
  return (
    <textarea
      className={`${inputBase} font-mono-app resize-y ${className}`}
      style={{ ...inputStyle, ...style }}
      {...rest}
    />
  );
}

export function NumberStepper({
  value,
  min = 0,
  step = 1,
  onChange,
  disabled,
}: {
  value: number;
  min?: number;
  step?: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-stretch gap-1">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(Math.max(min, roundStep(value - step, step)))}
        className="flex w-7 items-center justify-center rounded border disabled:opacity-50"
        style={{ borderColor: "var(--border)", color: "var(--text-dim)" }}
        aria-label="Decrease"
      >
        <Minus size={12} />
      </button>
      <input
        type="number"
        value={value}
        min={min}
        step={step}
        disabled={disabled}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) ? n : min);
        }}
        className={`${inputBase} text-center`}
        style={inputStyle}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(roundStep(value + step, step))}
        className="flex w-7 items-center justify-center rounded border disabled:opacity-50"
        style={{ borderColor: "var(--border)", color: "var(--text-dim)" }}
        aria-label="Increase"
      >
        <Plus size={12} />
      </button>
    </div>
  );
}

function roundStep(v: number, step: number): number {
  if (step >= 1) return Math.round(v);
  const factor = 1 / step;
  return Math.round(v * factor) / factor;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-md p-0.5"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
      role="radiogroup"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className="rounded px-2.5 py-1 text-[12px] font-medium disabled:opacity-50"
            style={{
              background: active ? "var(--accent-soft)" : "transparent",
              color: active ? "var(--accent-strong)" : "var(--text-dim)",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[12.5px]" style={{ color: "var(--text)" }}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="relative h-[18px] w-[32px] flex-shrink-0 rounded-full transition-colors disabled:opacity-50"
        style={{ background: checked ? "var(--accent)" : "var(--surface-3)" }}
      >
        <span
          className="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-transform"
          style={{ transform: checked ? "translateX(16px)" : "translateX(2px)" }}
        />
      </button>
      {label}
    </label>
  );
}

/** Chip list editor: add via input+Enter, remove via × on each chip. */
export function ChipList({
  values,
  onChange,
  placeholder,
  quickAdd,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  quickAdd?: { label: string; value: string }[];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {values.map((v, i) => (
          <span
            key={`${v}-${i}`}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono-app text-[11.5px]"
            style={{ background: "var(--surface-3)", color: "var(--text)" }}
          >
            {v}
            <button type="button" onClick={() => onChange(values.filter((_, idx) => idx !== i))}>
              <X size={10} style={{ color: "var(--text-faint)" }} />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-1.5">
        <ChipInput placeholder={placeholder} onAdd={(v) => onChange([...values, v])} />
      </div>
      {quickAdd && quickAdd.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {quickAdd.map((qa) => {
            const active = values.includes(qa.value);
            return (
              <button
                key={qa.value}
                type="button"
                onClick={() =>
                  onChange(active ? values.filter((v) => v !== qa.value) : [...values, qa.value])
                }
                className="rounded-full border px-2 py-0.5 text-[11px]"
                style={{
                  borderColor: active ? "var(--accent)" : "var(--border)",
                  color: active ? "var(--accent)" : "var(--text-faint)",
                  background: active ? "var(--accent-soft)" : "transparent",
                }}
              >
                {qa.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ChipInput({ placeholder, onAdd }: { placeholder?: string; onAdd: (v: string) => void }) {
  return (
    <TextInput
      placeholder={placeholder}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          const input = e.currentTarget;
          const v = input.value.trim();
          if (v) {
            onAdd(v);
            input.value = "";
          }
          e.preventDefault();
        }
      }}
    />
  );
}

/** Key-value map editor (rows of key/value text inputs). */
export function KeyValueEditor({
  entries,
  onChange,
  keyPlaceholder = "KEY",
  valuePlaceholder = "value",
}: {
  entries: Record<string, string>;
  onChange: (entries: Record<string, string>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const rows = Object.entries(entries);

  const updateRow = (index: number, key: string, value: string) => {
    const next = rows.map((r, i) => (i === index ? [key, value] : r));
    onChange(Object.fromEntries(next));
  };

  const removeRow = (index: number) => {
    onChange(Object.fromEntries(rows.filter((_, i) => i !== index)));
  };

  return (
    <div className="flex flex-col gap-1.5">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-1.5">
          <TextInput
            className="font-mono-app"
            value={k}
            placeholder={keyPlaceholder}
            onChange={(e) => updateRow(i, e.target.value, v)}
          />
          <TextInput
            className="font-mono-app"
            value={v}
            placeholder={valuePlaceholder}
            onChange={(e) => updateRow(i, k, e.target.value)}
          />
          <button type="button" onClick={() => removeRow(i)} aria-label="Remove">
            <X size={13} style={{ color: "var(--text-faint)" }} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange({ ...entries, "": "" })}
        className="flex items-center gap-1 self-start text-[11.5px]"
        style={{ color: "var(--accent)" }}
      >
        <Plus size={12} /> Add entry
      </button>
    </div>
  );
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-3 text-[13px] font-semibold" style={{ color: "var(--text)" }}>
      {children}
    </h3>
  );
}

export function Banner({ tone = "warn", children }: { tone?: "warn" | "danger" | "info"; children: ReactNode }) {
  const colors = {
    warn: { bg: "var(--warn-soft)", fg: "var(--warn)" },
    danger: { bg: "var(--danger-soft)", fg: "var(--danger)" },
    info: { bg: "var(--info-soft)", fg: "var(--info)" },
  }[tone];
  return (
    <div className="rounded-md px-3 py-2 text-[12px]" style={{ background: colors.bg, color: colors.fg }}>
      {children}
    </div>
  );
}
