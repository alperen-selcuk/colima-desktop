import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Layers,
  MoreHorizontal,
  Play,
  RotateCw,
  ScrollText,
  Square,
} from "lucide-react";
import { Td } from "../Table";
import { Button } from "../Button";
import type { ComposeActionKind } from "../../lib/types";

interface ComposeGroupRowProps {
  project: string;
  status: string; // e.g. "running(2), exited(1)"
  count: number;
  collapsed: boolean;
  selected: boolean;
  onToggle: () => void;
  /** Opens the project's detail panel (§6.7's "aggregate stream in the
   * detail panel"), on the Overview tab — separate from `onToggle`
   * (collapse/expand) so clicking the project name doesn't also collapse
   * the group. */
  onOpenDetail: () => void;
  /** Re-up with the project's stored compose files (`compose_up`, not
   * `compose_action` — Compose's "up" is a distinct command from
   * stop/start/restart/down/pull). */
  onUp: () => void;
  onAction: (action: ComposeActionKind) => void;
  onDown: () => void;
  /** Opens the project's detail panel directly on the Logs tab. */
  onLogs: () => void;
  colSpan: number;
}

/** Header row for a compose project group in the Containers table (§6.7):
 * shows the compose badge, aggregate status text, and a compact action menu
 * (Up / Restart / Stop / Start / Down / Pull / Logs). Clicking the row opens
 * the project's detail panel; the leading chevron alone collapses/expands
 * the group without opening it. */
export function ComposeGroupRow({
  project,
  status,
  count,
  collapsed,
  selected,
  onToggle,
  onOpenDetail,
  onUp,
  onAction,
  onDown,
  onLogs,
  colSpan,
}: ComposeGroupRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <tr
      onClick={onOpenDetail}
      className="cursor-pointer"
      style={{
        background: selected ? "var(--accent-soft)" : "var(--surface-2)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <Td colSpan={colSpan} className="py-1.5">
        <div className="flex items-center gap-2">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
          >
            {collapsed ? (
              <ChevronRight size={12} style={{ color: "var(--text-faint)" }} />
            ) : (
              <ChevronDown size={12} style={{ color: "var(--text-faint)" }} />
            )}
            <Layers size={12} style={{ color: "var(--docker-blue)", flexShrink: 0 }} />
            <span className="ctr-compose-badge">Compose</span>
            <span className="truncate text-[11.5px] font-medium" style={{ color: "var(--text)" }}>
              {project}
            </span>
            <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
              {status} · {count} container{count === 1 ? "" : "s"}
            </span>
          </button>
          <div className="relative flex-shrink-0" onClick={(e) => e.stopPropagation()}>
            <Button variant="ghost" size="sm" onClick={() => setMenuOpen((v) => !v)} title="Compose actions">
              <MoreHorizontal size={13} />
            </Button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div
                  className="absolute right-0 top-full z-20 mt-1 min-w-[170px] rounded-md border py-1 shadow-lg"
                  style={{ background: "var(--surface-1)", borderColor: "var(--border)" }}
                >
                  <MenuItem
                    icon={<Play size={11} />}
                    label="Up"
                    onClick={() => {
                      setMenuOpen(false);
                      onUp();
                    }}
                  />
                  <MenuItem
                    icon={<RotateCw size={11} />}
                    label="Restart"
                    onClick={() => {
                      setMenuOpen(false);
                      onAction("restart");
                    }}
                  />
                  <MenuItem
                    icon={<Square size={11} />}
                    label="Stop"
                    onClick={() => {
                      setMenuOpen(false);
                      onAction("stop");
                    }}
                  />
                  <MenuItem
                    icon={<Play size={11} />}
                    label="Start"
                    onClick={() => {
                      setMenuOpen(false);
                      onAction("start");
                    }}
                  />
                  <MenuItem
                    icon={<ScrollText size={11} />}
                    label="Pull"
                    onClick={() => {
                      setMenuOpen(false);
                      onAction("pull");
                    }}
                  />
                  <MenuItem
                    icon={<ScrollText size={11} />}
                    label="Logs"
                    onClick={() => {
                      setMenuOpen(false);
                      onLogs();
                    }}
                  />
                  <div className="my-1 border-t" style={{ borderColor: "var(--border)" }} />
                  <MenuItem
                    icon={<Square size={11} />}
                    label="Down…"
                    danger
                    onClick={() => {
                      setMenuOpen(false);
                      onDown();
                    }}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </Td>
    </tr>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  danger = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-[var(--surface-2)]"
      style={{ color: danger ? "var(--danger)" : "var(--text)" }}
    >
      {icon}
      {label}
    </button>
  );
}
