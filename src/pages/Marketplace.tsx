import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, Store } from "lucide-react";
import "../styles/marketplace.css";
import * as api from "../lib/api";
import type { CatalogItem, InstalledApp, MarketplaceCategory } from "../lib/types";
import {
  CATEGORY_LABEL,
  MARKETPLACE_CATEGORIES,
  categoryCounts,
  filterCatalog,
  installedItemIds,
} from "../lib/marketplace";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { QueryErrorBanner } from "../components/QueryErrorBanner";
import { useToast } from "../components/Toasts";
import { CatalogCard } from "../components/marketplace/CatalogCard";
import { InstalledAppCard } from "../components/marketplace/InstalledAppCard";
import { MarketplaceDetail } from "../components/marketplace/MarketplaceDetail";
import { MarketplaceInstallDialog } from "../dialogs/MarketplaceInstallDialog";
import { MarketplaceCredentialsDialog } from "../dialogs/MarketplaceCredentialsDialog";
import { MarketplaceUninstallDialog } from "../dialogs/MarketplaceUninstallDialog";

type Tab = "browse" | "installed";

interface MarketplacePageProps {
  profile: string;
}

export function MarketplacePage({ profile }: MarketplacePageProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("browse");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<MarketplaceCategory | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [installItem, setInstallItem] = useState<CatalogItem | null>(null);
  const [credentialsApp, setCredentialsApp] = useState<InstalledApp | null>(null);
  const [uninstallApp, setUninstallApp] = useState<InstalledApp | null>(null);

  const catalogQuery = useQuery({
    queryKey: ["marketplaceCatalog"],
    queryFn: () => api.marketplaceCatalog(false),
    staleTime: 5 * 60_000,
  });

  const installedQuery = useQuery({
    queryKey: ["marketplaceInstalled", profile],
    queryFn: () => api.marketplaceInstalled(profile),
    refetchInterval: 5000,
  });

  const containersQuery = useQuery({
    queryKey: ["containers", profile],
    queryFn: () => api.listContainers(profile),
    staleTime: 5000,
  });

  const invalidateInstalled = () => queryClient.invalidateQueries({ queryKey: ["marketplaceInstalled", profile] });

  const items = catalogQuery.data?.items ?? [];
  const installed = installedQuery.data ?? [];
  const installedIds = useMemo(() => installedItemIds(installed), [installed]);
  const counts = useMemo(() => categoryCounts(items), [items]);
  const filtered = useMemo(() => filterCatalog(items, category, search), [items, category, search]);
  const selectedItem = items.find((i) => i.id === selectedId) ?? null;

  // Host ports already in use, for the Install dialog's port-conflict hint:
  // running containers' published host ports + other installed apps' own
  // port-typed endpoint values (best-effort — only endpoints with a URL
  // expose a port directly).
  const takenPorts = useMemo(() => {
    const ports = new Set<number>();
    for (const c of containersQuery.data ?? []) {
      for (const link of c.portLinks) ports.add(link.hostPort);
    }
    for (const app of installed) {
      for (const ep of app.endpoints) {
        const m = ep.url?.match(/:(\d+)(?:\/|$)/);
        if (m) ports.add(Number(m[1]));
      }
    }
    return Array.from(ports);
  }, [containersQuery.data, installed]);

  const handleComposeAction = async (app: InstalledApp, action: "stop" | "start" | "restart") => {
    try {
      await api.composeAction(profile, app.projectName, action, [], false);
      toast.success(`${app.name}: ${action}`);
      invalidateInstalled();
    } catch (e) {
      toast.error(`Failed to ${action} ${app.name}`, String(e));
    }
  };

  const handleUninstall = async (removeVolumes: boolean) => {
    if (!uninstallApp) return;
    try {
      await api.marketplaceUninstall(profile, uninstallApp.projectName, removeVolumes);
      toast.success(`${uninstallApp.name} uninstalled`);
      invalidateInstalled();
    } catch (e) {
      toast.error(`Failed to uninstall ${uninstallApp.name}`, String(e));
    }
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-3 border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
          <div
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md"
            style={{ background: "var(--market-purple-soft)" }}
          >
            <Store size={15} style={{ color: "var(--market-purple)" }} />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-[12.5px] font-medium" style={{ color: "var(--market-purple)" }}>
              Marketplace
            </span>
            <span className="font-mono-app text-[10.5px]" style={{ color: "var(--text-faint)" }}>
              {profile}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1 border-b px-4" style={{ borderColor: "var(--border)" }}>
          <button className="mkt-tab" data-active={tab === "browse"} onClick={() => setTab("browse")}>
            Browse
            <span className="mkt-tab-count">{items.length}</span>
          </button>
          <button className="mkt-tab" data-active={tab === "installed"} onClick={() => setTab("installed")}>
            Installed
            <span className="mkt-tab-count">{installed.length}</span>
          </button>
        </div>

        {tab === "browse" && (
          <>
            <div className="flex items-center gap-2 px-4 py-3">
              <div className="relative w-full max-w-[280px]">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: "var(--text-faint)" }} />
                <input
                  id="marketplace-search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search apps and stacks…"
                  className="w-full rounded-md border py-1.5 pl-8 pr-2.5 text-[12.5px] outline-none"
                  style={{ background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text)" }}
                />
              </div>
            </div>

            <div className="flex items-center gap-1.5 overflow-x-auto px-4 pb-3">
              <button className="mkt-chip" data-active={category === null} onClick={() => setCategory(null)}>
                All
              </button>
              {MARKETPLACE_CATEGORIES.map((c) => (
                <button
                  key={c}
                  className="mkt-chip"
                  data-active={category === c}
                  onClick={() => setCategory(category === c ? null : c)}
                  style={{
                    ["--chip-accent" as string]: `var(--market-${c})`,
                    ["--chip-accent-soft" as string]: `var(--market-${c}-soft)`,
                  }}
                >
                  {CATEGORY_LABEL[c]} {counts[c] > 0 && <span style={{ opacity: 0.7 }}>{counts[c]}</span>}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto px-4 pb-4">
              {catalogQuery.isError ? (
                <QueryErrorBanner error={catalogQuery.error} onRetry={() => catalogQuery.refetch()} />
              ) : filtered.length === 0 ? (
                <EmptyState
                  icon={Store}
                  title={items.length === 0 ? "No catalog items available" : "No apps match your filters"}
                  message={
                    items.length === 0
                      ? catalogQuery.isLoading
                        ? undefined
                        : "The catalog couldn't be loaded. Try again later."
                      : "Try a different search or category."
                  }
                />
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {filtered.map((item) => (
                    <CatalogCard
                      key={item.id}
                      item={item}
                      installed={installedIds.has(item.id)}
                      selected={item.id === selectedId}
                      onClick={() => setSelectedId(item.id === selectedId ? null : item.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {tab === "installed" && (
          <div className="flex-1 overflow-y-auto px-4 py-4">
            {installedQuery.isError ? (
              <QueryErrorBanner error={installedQuery.error} onRetry={() => installedQuery.refetch()} />
            ) : installed.length === 0 ? (
              <EmptyState
                icon={Store}
                title="Nothing installed yet"
                message="Install an app or stack from Browse to see it here, with its live status and credentials."
                action={
                  <Button variant="primary" size="sm" onClick={() => setTab("browse")}>
                    Browse Marketplace
                  </Button>
                }
              />
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {installed.map((app) => (
                  <InstalledAppCard
                    key={app.projectName}
                    app={app}
                    item={items.find((i) => i.id === app.itemId) ?? null}
                    onCredentials={() => setCredentialsApp(app)}
                    onAction={(action) => handleComposeAction(app, action)}
                    onUninstall={() => setUninstallApp(app)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {tab === "browse" && selectedItem && (
        <MarketplaceDetail
          item={selectedItem}
          installed={installedIds.has(selectedItem.id)}
          onClose={() => setSelectedId(null)}
          onInstall={() => setInstallItem(selectedItem)}
        />
      )}

      <MarketplaceInstallDialog
        open={!!installItem}
        profile={profile}
        item={installItem}
        takenPorts={takenPorts}
        onClose={() => setInstallItem(null)}
        onInstalled={() => {
          invalidateInstalled();
          setTab("installed");
        }}
      />

      <MarketplaceCredentialsDialog open={!!credentialsApp} app={credentialsApp} onClose={() => setCredentialsApp(null)} />

      <MarketplaceUninstallDialog
        open={!!uninstallApp}
        app={uninstallApp}
        onClose={() => setUninstallApp(null)}
        onConfirm={handleUninstall}
      />
    </div>
  );
}
