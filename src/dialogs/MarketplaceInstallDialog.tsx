import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Eye, EyeOff, RefreshCw, XCircle } from "lucide-react";
import * as api from "../lib/api";
import type { CatalogItem, InstalledApp, PreflightResult, PreparedVariable } from "../lib/types";
import { generatePassword, isMaskedVariableType, isPortConflict, splitAdvancedVariables } from "../lib/marketplace";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/Button";
import { useToast } from "../components/Toasts";
import { EndpointsView } from "../components/marketplace/EndpointsView";

interface MarketplaceInstallDialogProps {
  open: boolean;
  profile: string;
  item: CatalogItem | null;
  /** Host ports already in use (from `Container.portLinks` + other installed
   * apps' port variables) — used for the client-side conflict hint next to
   * an edited port field; the backend re-validates authoritatively. */
  takenPorts: number[];
  onClose: () => void;
  onInstalled: (app: InstalledApp) => void;
}

const inputClass = "w-full rounded border px-2.5 py-1.5 text-[12.5px] font-mono-app outline-none";
const inputStyle = { background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text)" };

type Stage = "form" | "installing" | "ready";

const INSTALL_STEPS = ["Writing files", "Starting containers", "Waiting until ready", "Ready"] as const;

function stepIndexForLine(line: string): number {
  const lower = line.toLowerCase();
  if (lower.includes("ready")) return 3;
  if (lower.includes("waiting")) return 2;
  if (lower.includes("starting")) return 1;
  if (lower.includes("writing")) return 0;
  return -1;
}

/** The Install dialog (§6.8): project name, a variables form (passwords
 * masked with reveal/regenerate, ports editable with a conflict hint, hidden
 * variables collapsed under "Advanced"), a preflight list with Fix buttons,
 * an in-dialog progress step indicator while `marketplace_install` runs
 * (driven by `colima-op-log` lines under op "marketplace-install", the same
 * event the Output dock renders), and finally the Ready card. */
export function MarketplaceInstallDialog({ open, profile, item, takenPorts, onClose, onInstalled }: MarketplaceInstallDialogProps) {
  const toast = useToast();
  const [stage, setStage] = useState<Stage>("form");
  const [loading, setLoading] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [variables, setVariables] = useState<PreparedVariable[]>([]);
  const [preflight, setPreflight] = useState<PreflightResult[]>([]);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [fixingId, setFixingId] = useState<string | null>(null);
  const [installBusy, setInstallBusy] = useState(false);
  const [stepIndex, setStepIndex] = useState(-1);
  const [installedApp, setInstalledApp] = useState<InstalledApp | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!open || !item) return;
    setStage("form");
    setLoading(true);
    setInstalledApp(null);
    setStepIndex(-1);
    setRevealed(new Set());
    setAdvancedOpen(false);
    api
      .marketplacePrepare(profile, item.id)
      .then((result) => {
        setProjectName(result.projectName);
        setVariables(result.variables);
        setPreflight(result.preflight);
      })
      .catch((e) => toast.error("Failed to prepare install", String(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.id, profile]);

  useEffect(() => {
    return () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  if (!item) return null;

  const { visible, advanced } = splitAdvancedVariables(variables);
  const hasErrorCheck = preflight.some((p) => !p.ok && p.severity === "error");

  const updateVariable = (name: string, value: string) => {
    setVariables((prev) => prev.map((v) => (v.name === name ? { ...v, value } : v)));
  };

  const toggleReveal = (name: string) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const regenerate = (v: PreparedVariable) => {
    const catalogVar = item.variables.find((cv) => cv.name === v.name);
    updateVariable(v.name, generatePassword(catalogVar?.length ?? 24));
  };

  const handleFix = async (checkId: string) => {
    setFixingId(checkId);
    try {
      await api.marketplaceFixPreflight(profile, checkId);
      const results = await api.marketplacePreflight(profile, item.id);
      setPreflight(results);
      toast.success("Preflight check fixed");
    } catch (e) {
      toast.error("Failed to apply fix", String(e));
    } finally {
      setFixingId(null);
    }
  };

  const handleInstall = async () => {
    setInstallBusy(true);
    setStage("installing");
    setStepIndex(0);
    const values: Record<string, string> = {};
    for (const v of variables) values[v.name] = v.value;

    const unlisten = await api.onOpLog((payload) => {
      if (payload.profile !== profile || payload.op !== "marketplace-install") return;
      const idx = stepIndexForLine(payload.line);
      if (idx >= 0) setStepIndex(idx);
    });
    unlistenRef.current = unlisten;

    try {
      const app = await api.marketplaceInstall(profile, item.id, projectName, values);
      setStepIndex(3);
      setInstalledApp(app);
      setStage("ready");
      toast.success(`${item.name} installed`);
      onInstalled(app);
    } catch (e) {
      toast.error("Install failed", String(e));
      setStage("form");
    } finally {
      setInstallBusy(false);
      unlisten();
      unlistenRef.current = null;
    }
  };

  const title = stage === "ready" ? `${item.name} is ready` : `Install ${item.name}`;

  return (
    <Dialog open={open} onClose={onClose} title={title} width={560}
      footer={
        stage === "form" ? (
          <>
            <Button variant="ghost" onClick={onClose} disabled={installBusy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleInstall} disabled={loading || installBusy || hasErrorCheck || !projectName.trim()}>
              Install
            </Button>
          </>
        ) : stage === "installing" ? (
          <Button variant="ghost" disabled>
            Installing…
          </Button>
        ) : (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        )
      }
    >
      {stage === "form" && (
        <div className="flex flex-col gap-4">
          {loading ? (
            <div className="py-8 text-center text-[12.5px]" style={{ color: "var(--text-faint)" }}>
              Preparing install…
            </div>
          ) : (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-[11.5px] font-medium" style={{ color: "var(--text-faint)" }}>
                  Project name
                </span>
                <input
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  className={inputClass}
                  style={inputStyle}
                />
              </label>

              {visible.length > 0 && (
                <div className="flex flex-col gap-2.5">
                  {visible.map((v) => (
                    <VariableField
                      key={v.name}
                      variable={v}
                      revealed={revealed.has(v.name)}
                      onToggleReveal={() => toggleReveal(v.name)}
                      onChange={(value) => updateVariable(v.name, value)}
                      onRegenerate={() => regenerate(v)}
                      conflict={
                        v.type === "port" && isPortConflict(Number(v.value), takenPorts, Number(v.value))
                      }
                    />
                  ))}
                </div>
              )}

              {advanced.length > 0 && (
                <div>
                  <button
                    onClick={() => setAdvancedOpen((s) => !s)}
                    className="flex items-center gap-1.5 text-[11.5px] font-medium"
                    style={{ color: "var(--text-faint)" }}
                  >
                    {advancedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    Advanced ({advanced.length})
                  </button>
                  {advancedOpen && (
                    <div className="mt-2 flex flex-col gap-2.5">
                      {advanced.map((v) => (
                        <VariableField
                          key={v.name}
                          variable={v}
                          revealed={revealed.has(v.name)}
                          onToggleReveal={() => toggleReveal(v.name)}
                          onChange={(value) => updateVariable(v.name, value)}
                          onRegenerate={() => regenerate(v)}
                          conflict={false}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div>
                <div className="mb-1.5 text-[11px] font-medium" style={{ color: "var(--text-faint)" }}>
                  Preflight checks
                </div>
                <div className="flex flex-col gap-1.5">
                  {preflight.map((check) => (
                    <PreflightRow key={check.id} check={check} busy={fixingId === check.id} onFix={() => handleFix(check.id)} />
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {stage === "installing" && (
        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            {INSTALL_STEPS.map((label, i) => (
              <div key={label} className="mkt-step" data-state={i < stepIndex ? "done" : i === stepIndex ? "active" : "pending"}>
                <span className="mkt-step-dot">
                  {i < stepIndex ? <CheckCircle2 size={11} /> : i === stepIndex ? <RefreshCw size={10} className="spin" /> : ""}
                </span>
                {label}
              </div>
            ))}
          </div>
          <div className="text-[11.5px]" style={{ color: "var(--text-faint)" }}>
            Progress is also streaming to the Output dock.
          </div>
        </div>
      )}

      {stage === "ready" && installedApp && <EndpointsView endpoints={installedApp.endpoints} notes={installedApp.notes} />}
    </Dialog>
  );
}

function VariableField({
  variable,
  revealed,
  onToggleReveal,
  onChange,
  onRegenerate,
  conflict,
}: {
  variable: PreparedVariable;
  revealed: boolean;
  onToggleReveal: () => void;
  onChange: (value: string) => void;
  onRegenerate: () => void;
  conflict: boolean;
}) {
  const masked = isMaskedVariableType(variable.type) && !revealed;
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] font-medium" style={{ color: "var(--text-faint)" }}>
        {variable.label}
      </span>
      <div className="flex items-center gap-1.5">
        <input
          type={masked ? "password" : "text"}
          value={variable.value}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
          style={{ ...inputStyle, borderColor: conflict ? "var(--warn)" : inputStyle.borderColor }}
        />
        {variable.type === "password" && (
          <>
            <Button variant="ghost" size="sm" onClick={onToggleReveal} title={revealed ? "Hide" : "Reveal"}>
              {revealed ? <EyeOff size={12} /> : <Eye size={12} />}
            </Button>
            <Button variant="ghost" size="sm" onClick={onRegenerate} title="Regenerate">
              <RefreshCw size={12} />
            </Button>
          </>
        )}
      </div>
      {conflict && (
        <span className="flex items-center gap-1 text-[11px]" style={{ color: "var(--warn)" }}>
          <AlertTriangle size={10} /> This port looks like it's already in use.
        </span>
      )}
    </label>
  );
}

function PreflightRow({ check, busy, onFix }: { check: PreflightResult; busy: boolean; onFix: () => void }) {
  const Icon = check.ok ? CheckCircle2 : check.severity === "error" ? XCircle : AlertTriangle;
  const color = check.ok ? "var(--accent)" : check.severity === "error" ? "var(--danger)" : "var(--warn)";
  return (
    <div className="mkt-preflight-row" data-ok={check.ok} data-severity={check.severity}>
      <Icon size={14} style={{ color, flexShrink: 0, marginTop: 1 }} />
      <span className="flex-1" style={{ color: "var(--text)" }}>
        {check.message}
      </span>
      {!check.ok && check.fixable && (
        <Button variant="secondary" size="sm" onClick={onFix} disabled={busy}>
          {busy ? "Fixing…" : "Fix"}
        </Button>
      )}
    </div>
  );
}
