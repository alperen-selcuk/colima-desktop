import { useState } from "react";
import { Copy, Eye, EyeOff } from "lucide-react";
import * as api from "../../lib/api";
import { useToast } from "../Toasts";

interface SecretKeyRowProps {
  profile: string;
  namespace: string;
  name: string;
  secretKey: string;
}

/** One secret key row in the detail drawer: hidden by default, per-key
 * "Reveal" fetches the value on demand via `k8s_secret_value` (never in
 * bulk), plus Copy. Re-hidden automatically whenever the drawer closes,
 * since this component unmounts with it — no lingering revealed state. */
export function SecretKeyRow({ profile, namespace, name, secretKey }: SecretKeyRowProps) {
  const toast = useToast();
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [value, setValue] = useState<{ value: string; binary: boolean } | null>(null);

  const handleReveal = async () => {
    if (revealed) {
      setRevealed(false);
      return;
    }
    if (value) {
      setRevealed(true);
      return;
    }
    setLoading(true);
    try {
      const v = await api.k8sSecretValue(profile, namespace, name, secretKey);
      setValue(v);
      setRevealed(true);
    } catch (e) {
      toast.error(`Failed to reveal ${secretKey}`, String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    try {
      let v = value;
      if (!v) {
        v = await api.k8sSecretValue(profile, namespace, name, secretKey);
        setValue(v);
      }
      await navigator.clipboard.writeText(v.value);
      toast.success(`Copied ${secretKey}`);
    } catch (e) {
      toast.error(`Failed to copy ${secretKey}`, String(e));
    }
  };

  return (
    <div
      className="flex items-center gap-2 rounded-md border px-2.5 py-1.5"
      style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
    >
      <span className="font-mono-app text-[11.5px] font-medium" style={{ color: "var(--text)" }}>
        {secretKey}
      </span>
      <span
        className="min-w-0 flex-1 truncate font-mono-app text-[11px]"
        style={{ color: revealed ? "var(--text-dim)" : "var(--text-faint)" }}
      >
        {revealed && value ? (value.binary ? `${value.value} (base64)` : value.value) : "••••••••••"}
      </span>
      <button
        onClick={handleReveal}
        disabled={loading}
        title={revealed ? "Hide" : "Reveal"}
        className="flex-shrink-0 opacity-70 hover:opacity-100 disabled:opacity-40"
        style={{ color: "var(--text-dim)" }}
      >
        {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
      </button>
      <button
        onClick={handleCopy}
        title="Copy"
        className="flex-shrink-0 opacity-70 hover:opacity-100"
        style={{ color: "var(--text-dim)" }}
      >
        <Copy size={13} />
      </button>
    </div>
  );
}
