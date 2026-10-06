import { CheckCircle2, XCircle, TerminalSquare } from "lucide-react";
import type { EnvInfo } from "../lib/types";
import { Button } from "../components/Button";
import { isHealthy, useDeps } from "../lib/useDeps";

interface SetupPageProps {
  envInfo: EnvInfo | undefined;
  standalone?: boolean;
}

function CheckRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center gap-2 py-1 text-[13px]" style={{ color: ok ? "var(--text)" : "var(--text-dim)" }}>
      {ok ? (
        <CheckCircle2 size={15} style={{ color: "var(--accent)" }} />
      ) : (
        <XCircle size={15} style={{ color: "var(--danger)" }} />
      )}
      {label}
    </div>
  );
}

export function SetupPage({ envInfo, standalone = false }: SetupPageProps) {
  const isLinux = envInfo?.platform === "linux";
  const { deps, fixing, error, fix } = useDeps();
  const fixable = (deps ?? []).filter((d) => d.fix && (d.required || !d.installed)).map((d) => d.name);

  const body = (
    <div className="mx-auto max-w-[560px] px-6 py-10">
      <div className="mb-6 flex items-center gap-3">
        <div
          className="flex h-10 w-10 items-center justify-center rounded-lg"
          style={{ background: "var(--accent-soft)" }}
        >
          <TerminalSquare size={20} style={{ color: "var(--accent)" }} />
        </div>
        <div>
          <h1 className="text-[16px] font-semibold" style={{ color: "var(--text)" }}>
            {standalone ? "Set up Colima" : "Environment"}
          </h1>
          <p className="text-[12.5px]" style={{ color: "var(--text-dim)" }}>
            {standalone
              ? "Colima Desktop needs colima, docker and kubectl on your PATH."
              : "Detected tools and versions."}
          </p>
        </div>
      </div>

      {!standalone && (
        <p className="mb-3 text-[11px]" style={{ color: "var(--text-faint)" }}>
          Colima Desktop v{__APP_VERSION__} — an independent, open-source desktop app for Colima. Not affiliated
          with the Colima maintainers; it uses Colima as its engine.
        </p>
      )}

      {deps && (
        <div
          className="mb-4 rounded-lg border p-4"
          style={{ background: "var(--surface-1)", borderColor: "var(--border)" }}
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-medium" style={{ color: "var(--text-faint)" }}>
              Dependencies
            </span>
            {fixable.length > 1 && (
              <Button size="sm" variant="secondary" disabled={!!fixing} onClick={() => fix(fixable)}>
                Fix all
              </Button>
            )}
          </div>
          {deps.map((d) => (
            <div key={d.name} className="flex items-start justify-between gap-3 py-1.5">
              <div className="min-w-0">
                <CheckRow
                  ok={isHealthy(d)}
                  label={`${d.name}${d.required ? "" : " (optional)"} — ${
                    d.installed ? (d.linked === false ? "installed but not linked" : d.version ?? "found") : "not found"
                  }`}
                />
                {!isHealthy(d) && (
                  <div className="pl-[23px] text-[11.5px]" style={{ color: "var(--text-faint)" }}>
                    {d.purpose}
                  </div>
                )}
              </div>
              {d.fix && !isHealthy(d) && (
                <Button size="sm" variant="primary" disabled={!!fixing} onClick={() => fix([d.name])}>
                  {fixing === d.name ? "Working…" : d.fix.label}
                </Button>
              )}
            </div>
          ))}
          {error && (
            <div className="mt-2 text-[12px]" style={{ color: "var(--danger)" }}>
              {error}
            </div>
          )}
        </div>
      )}

      {envInfo && (
        <div
          className="mb-6 rounded-lg border p-4"
          style={{ background: "var(--surface-1)", borderColor: "var(--border)" }}
        >
          {!standalone && (
            <div className="mb-2 text-[11px] font-medium" style={{ color: "var(--text-faint)" }}>
              Dependencies
            </div>
          )}
          <CheckRow label={envInfo.limactlAvailable ? "limactl — found" : "limactl — not found"} ok={envInfo.limactlAvailable} />
        </div>
      )}

      <div
        className="rounded-lg border p-4 font-mono-app text-[12px]"
        style={{ background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text-dim)" }}
      >
        {isLinux ? (
          <>
            <div className="mb-2" style={{ color: "var(--text-faint)" }}># Linux (Debian/Ubuntu example)</div>
            <div>curl -LO https://github.com/abiosoft/colima/releases/latest/download/colima-Linux-x86_64</div>
            <div>sudo install colima-Linux-x86_64 /usr/local/bin/colima</div>
            <div className="mt-2">sudo apt-get install docker.io</div>
            <div>curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"</div>
          </>
        ) : (
          <>
            <div className="mb-2" style={{ color: "var(--text-faint)" }}># macOS (Homebrew)</div>
            <div>brew install colima docker kubectl</div>
          </>
        )}
      </div>

      <p className="mt-4 text-[12px]" style={{ color: "var(--text-faint)" }}>
        After installing, restart Colima Desktop. If tools are installed but still not detected, make sure
        they are on your shell PATH (e.g. Homebrew's <code className="font-mono-app">/opt/homebrew/bin</code>).
      </p>
    </div>
  );

  if (standalone) {
    return (
      <div className="flex h-screen w-screen items-start justify-center overflow-y-auto" style={{ background: "var(--surface-0)" }}>
        {body}
      </div>
    );
  }

  return <div className="flex flex-1 flex-col overflow-y-auto">{body}</div>;
}
