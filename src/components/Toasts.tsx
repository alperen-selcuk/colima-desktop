import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";

type ToastKind = "success" | "error" | "info";

interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  action?: ToastAction;
}

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastContextValue {
  push: (kind: ToastKind, title: string, detail?: string, action?: ToastAction) => void;
  success: (title: string, detail?: string, action?: ToastAction) => void;
  error: (title: string, detail?: string, action?: ToastAction) => void;
  info: (title: string, detail?: string, action?: ToastAction) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const ICONS: Record<ToastKind, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

const COLORS: Record<ToastKind, string> = {
  success: "var(--accent)",
  error: "var(--danger)",
  info: "var(--info)",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, title: string, detail?: string, action?: ToastAction) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, kind, title, detail, action }]);
      window.setTimeout(() => dismiss(id), kind === "error" ? 7000 : action ? 10000 : 4000);
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      push,
      success: (title, detail, action) => push("success", title, detail, action),
      error: (title, detail, action) => push("error", title, detail, action),
      info: (title, detail, action) => push("info", title, detail, action),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-4 right-4 z-[200] flex flex-col gap-2 w-[340px]">
        {toasts.map((t) => {
          const Icon = ICONS[t.kind];
          return (
            <div
              key={t.id}
              className="fade-in flex items-start gap-2.5 rounded-md border px-3 py-2.5 shadow-lg"
              style={{
                background: "var(--surface-2)",
                borderColor: "var(--border)",
                boxShadow: "0 8px 24px var(--shadow-color-lg)",
              }}
            >
              <Icon size={16} style={{ color: COLORS[t.kind], marginTop: 2, flexShrink: 0 }} />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium" style={{ color: "var(--text)" }}>
                  {t.title}
                </div>
                {t.detail && (
                  <div className="mt-0.5 text-[12px] break-words" style={{ color: "var(--text-dim)" }}>
                    {t.detail}
                  </div>
                )}
                {t.action && (
                  <button
                    onClick={() => {
                      t.action?.onClick();
                      dismiss(t.id);
                    }}
                    className="mt-1.5 rounded border px-2 py-0.5 text-[12px] font-medium hover:bg-[var(--surface-3)]"
                    style={{ borderColor: "var(--border-strong)", color: "var(--text)" }}
                  >
                    {t.action.label}
                  </button>
                )}
              </div>
              <button
                onClick={() => dismiss(t.id)}
                className="flex-shrink-0 opacity-60 hover:opacity-100"
                style={{ color: "var(--text-dim)" }}
                aria-label="Dismiss"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}
