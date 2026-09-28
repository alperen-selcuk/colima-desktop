import { Boxes, Container as ContainerIcon, HardDrive, Layers, Monitor, Moon, Server, Settings, Store, Sun } from "lucide-react";
import type { EnvInfo } from "../lib/types";
import { useTheme } from "../lib/useTheme";
import type { ThemePreference } from "../lib/format";

export type Page = "machines" | "containers" | "images" | "volumes" | "marketplace" | "kubernetes" | "setup";

interface NavItem {
  id: Page;
  label: string;
  icon: typeof Boxes;
}

const NAV_ITEMS: NavItem[] = [
  { id: "machines", label: "Machines", icon: Server },
  { id: "containers", label: "Containers", icon: ContainerIcon },
  { id: "images", label: "Images", icon: Layers },
  { id: "volumes", label: "Volumes", icon: HardDrive },
  { id: "marketplace", label: "Marketplace", icon: Store },
  { id: "kubernetes", label: "Kubernetes", icon: Boxes },
];

const THEME_OPTIONS: { id: ThemePreference; icon: typeof Sun; label: string }[] = [
  { id: "system", icon: Monitor, label: "System" },
  { id: "light", icon: Sun, label: "Light" },
  { id: "dark", icon: Moon, label: "Dark" },
];

interface SidebarProps {
  page: Page;
  onNavigate: (page: Page) => void;
  kubernetesEnabled: boolean;
  envInfo?: EnvInfo;
}

export function Sidebar({ page, onNavigate, kubernetesEnabled }: SidebarProps) {
  const { preference, setPreference } = useTheme();

  return (
    <aside
      className="flex w-[196px] flex-shrink-0 flex-col border-r"
      style={{ background: "var(--surface-1)", borderColor: "var(--border)" }}
    >
      <div className="flex items-center gap-2 px-4 py-4">
        <img src="/logo.svg" alt="" width={22} height={22} />
        <span className="text-[13px] font-semibold" style={{ color: "var(--text)" }}>
          Colima Desktop
        </span>
      </div>

      <nav className="flex-1 px-2 py-1">
        {NAV_ITEMS.map((item) => {
          const isKube = item.id === "kubernetes";
          const active = page === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className="mb-0.5 flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[12.5px] font-medium transition-colors"
              style={{
                background: active ? "var(--accent-soft)" : "transparent",
                color: active ? "var(--accent-strong)" : "var(--text-dim)",
                borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
              }}
            >
              <Icon size={15} style={{ flexShrink: 0 }} />
              <span className="flex-1">{item.label}</span>
              {isKube && !kubernetesEnabled && (
                <span
                  className="rounded px-1.5 py-0.5 text-[10px]"
                  style={{ background: "var(--surface-3)", color: "var(--text-faint)" }}
                >
                  off
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="border-t px-3 py-3" style={{ borderColor: "var(--border)" }}>
        <div
          className="mb-2.5 flex items-center gap-0.5 rounded-md p-0.5"
          style={{ background: "var(--surface-2)" }}
          role="radiogroup"
          aria-label="Theme"
        >
          {THEME_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const active = preference === opt.id;
            return (
              <button
                key={opt.id}
                role="radio"
                aria-checked={active}
                title={opt.label}
                onClick={() => setPreference(opt.id)}
                className="flex flex-1 items-center justify-center rounded py-1"
                style={{
                  background: active ? "var(--surface-1)" : "transparent",
                  color: active ? "var(--accent)" : "var(--text-faint)",
                  boxShadow: active ? "0 1px 2px var(--shadow-color)" : undefined,
                }}
              >
                <Icon size={13} />
              </button>
            );
          })}
        </div>

        <button
          onClick={() => onNavigate("setup")}
          className="flex w-full items-center gap-2 text-left text-[11.5px] hover:opacity-80"
          style={{ color: "var(--text-faint)" }}
        >
          <Settings size={13} />
          <span>Colima Desktop v{__APP_VERSION__}</span>
        </button>
      </div>
    </aside>
  );
}
