import { useRef } from "react";

interface YamlEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  minRows?: number;
}

/** Monospace textarea with a synced line-number gutter, used by the
 * Kubernetes YAML edit dialog (§6.6). Kept as a plain textarea (matching the
 * app's existing raw-YAML editor in MachineConfigDialog) rather than pulling
 * in a code-editor dependency. */
export function YamlEditor({ value, onChange, readOnly = false, minRows = 16 }: YamlEditorProps) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const lines = Math.max(minRows, value.split("\n").length);

  const syncScroll = () => {
    if (gutterRef.current && areaRef.current) {
      gutterRef.current.scrollTop = areaRef.current.scrollTop;
    }
  };

  return (
    <div
      className="flex overflow-hidden rounded-md border"
      style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
    >
      <div
        ref={gutterRef}
        className="select-none overflow-hidden px-2 py-2 text-right font-mono-app text-[11.5px] leading-[1.6]"
        style={{ color: "var(--text-faint)", background: "var(--surface-1)", borderRight: "1px solid var(--border)" }}
      >
        {Array.from({ length: lines }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        ref={areaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        readOnly={readOnly}
        spellCheck={false}
        rows={lines}
        className="min-h-[320px] flex-1 resize-none px-2.5 py-2 font-mono-app text-[11.5px] leading-[1.6] outline-none"
        style={{ background: "transparent", color: "var(--text)" }}
      />
    </div>
  );
}
