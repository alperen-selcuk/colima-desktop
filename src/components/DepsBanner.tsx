import { AlertTriangle } from "lucide-react";
import { Button } from "./Button";
import { requiredProblems, useDeps } from "../lib/useDeps";

/** Compact Machines-page banner when a required dependency is missing or unlinked (§6.9). */
export function DepsBanner({ onOpenSetup }: { onOpenSetup: () => void }) {
  const { deps, fixing, error, fix } = useDeps();
  const problems = requiredProblems(deps);
  if (problems.length === 0) return null;
  const fixable = problems.filter((d) => d.fix).map((d) => d.name);

  return (
    <div
      className="mx-5 mb-3 flex items-center gap-3 rounded-md px-3 py-2 text-[12px]"
      style={{ background: "var(--warn-soft)", color: "var(--warn)" }}
    >
      <AlertTriangle size={14} className="shrink-0" />
      <div className="min-w-0 flex-1">
        {problems.map((d) => `${d.name} ${d.installed ? "is not linked" : "is missing"}`).join(", ")}.
        {error && <span style={{ color: "var(--danger)" }}> {error}</span>}
      </div>
      {fixable.length > 0 && (
        <Button size="sm" variant="primary" disabled={!!fixing} onClick={() => fix(fixable)}>
          {fixing ? `Fixing ${fixing}…` : "Fix all"}
        </Button>
      )}
      <Button size="sm" variant="secondary" onClick={onOpenSetup}>
        Details
      </Button>
    </div>
  );
}
