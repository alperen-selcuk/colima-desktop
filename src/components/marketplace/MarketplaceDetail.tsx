import { useMemo, useState } from "react";
import { ExternalLink, Layers, ScrollText, X } from "lucide-react";
import type { CatalogItem } from "../../lib/types";
import { CATEGORY_LABEL, composeDeclaredPorts, parseComposeServices } from "../../lib/marketplace";
import { Button } from "../Button";
import { ImageIcon } from "../containers/ImageIcon";
import { CatalogIcon } from "./CatalogIcon";
import { CATEGORY_ACCENT_VAR } from "./categoryAccent";

type Tab = "overview" | "compose";

interface MarketplaceDetailProps {
  item: CatalogItem;
  installed: boolean;
  onClose: () => void;
  onInstall: () => void;
}

/** Right-side detail drawer for a catalog item (§6.8): services/images
 * parsed from the embedded compose text, declared ports, source + license
 * attribution, and a read-only compose preview. Mirrors
 * ComposeProjectDetail/K8sDetail's shape (header + tab strip + content) so
 * it feels like the same family of panel as the rest of the app. */
export function MarketplaceDetail({ item, installed, onClose, onInstall }: MarketplaceDetailProps) {
  const [tab, setTab] = useState<Tab>("overview");
  const services = useMemo(() => parseComposeServices(item.compose), [item.compose]);
  const ports = useMemo(() => composeDeclaredPorts(item.compose), [item.compose]);
  const accentVar = CATEGORY_ACCENT_VAR[item.category];

  return (
    <div
      className="flex w-[420px] flex-shrink-0 flex-col border-l"
      style={{ background: "var(--surface-1)", borderColor: "var(--border)" }}
    >
      <div className="flex items-start justify-between border-b px-3 py-3" style={{ borderColor: "var(--border)" }}>
        <div className="flex min-w-0 items-start gap-2.5">
          <CatalogIcon icon={item.icon} category={item.category} size={56} />
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-semibold" style={{ color: "var(--text)" }}>
              {item.name}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className="mkt-category-badge" style={{ ["--badge-accent" as string]: `var(${accentVar})`, ["--badge-accent-soft" as string]: `var(${accentVar}-soft)` }}>
                {CATEGORY_LABEL[item.category]}
              </span>
              {installed && <span className="mkt-badge">Installed</span>}
            </div>
          </div>
        </div>
        <button onClick={onClose} className="flex-shrink-0 opacity-60 hover:opacity-100" style={{ color: "var(--text-dim)" }}>
          <X size={15} />
        </button>
      </div>

      <div className="flex border-b px-3" style={{ borderColor: "var(--border)" }}>
        {(["overview", "compose"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="px-3 py-2 text-[12px] font-medium capitalize"
            style={{
              color: tab === t ? "var(--text)" : "var(--text-dim)",
              borderBottom: tab === t ? `2px solid var(${accentVar})` : "2px solid transparent",
            }}
          >
            {t === "compose" ? "Compose file" : t}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "overview" && (
          <div className="flex flex-col gap-4 p-3">
            <p className="text-[12.5px]" style={{ color: "var(--text-dim)" }}>
              {item.description}
            </p>

            <div className="flex flex-wrap gap-3 text-[11.5px]" style={{ color: "var(--text-faint)" }}>
              <span>{item.architectures.join(" / ")}</span>
              <span>·</span>
              <span>{item.minMemoryMB >= 1024 ? `${(item.minMemoryMB / 1024).toFixed(1)} GiB` : `${item.minMemoryMB} MiB`} recommended</span>
            </div>

            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium" style={{ color: "var(--text-faint)" }}>
                <ScrollText size={11} /> Services
              </div>
              <div className="flex flex-col gap-1.5">
                {services.length === 0 ? (
                  <div className="text-[12px]" style={{ color: "var(--text-faint)" }}>
                    No services found in the compose file.
                  </div>
                ) : (
                  services.map((svc) => (
                    <div
                      key={svc.name}
                      className="flex items-center gap-2 rounded border px-2 py-1.5 text-[11.5px]"
                      style={{ borderColor: "var(--border)" }}
                    >
                      <ImageIcon image={svc.image ?? svc.name} size={20} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium" style={{ color: "var(--text)" }}>
                          {svc.name}
                        </div>
                        <div className="truncate font-mono-app text-[10.5px]" style={{ color: "var(--text-faint)" }}>
                          {svc.image ?? "built locally"}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {ports.length > 0 && (
              <div>
                <div className="mb-1.5 text-[11px] font-medium" style={{ color: "var(--text-faint)" }}>
                  Ports
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {ports.map((p) => (
                    <span key={p} className="mkt-badge-neutral font-mono-app">
                      {p}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div>
              <div className="mb-1.5 text-[11px] font-medium" style={{ color: "var(--text-faint)" }}>
                Source
              </div>
              <div className="text-[12px]" style={{ color: "var(--text-dim)" }}>
                {item.source.name} · {item.source.license}
              </div>
              <a
                href={item.website}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-[11.5px] hover:underline"
                style={{ color: "var(--info)" }}
              >
                {item.website.replace(/^https?:\/\//, "")}
                <ExternalLink size={9} />
              </a>
            </div>
          </div>
        )}

        {tab === "compose" && (
          <div className="p-3">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium" style={{ color: "var(--text-faint)" }}>
              <Layers size={11} /> compose.yml (read-only)
            </div>
            <pre
              className="overflow-x-auto whitespace-pre rounded-md border p-2.5 font-mono-app text-[11px] leading-[1.55]"
              style={{ borderColor: "var(--border)", background: "var(--surface-2)", color: "var(--text-dim)" }}
            >
              {item.compose}
            </pre>
          </div>
        )}
      </div>

      <div className="flex-shrink-0 border-t px-3 py-3" style={{ borderColor: "var(--border)" }}>
        <Button variant="primary" size="md" onClick={onInstall} className="w-full justify-center">
          Install…
        </Button>
      </div>
    </div>
  );
}
