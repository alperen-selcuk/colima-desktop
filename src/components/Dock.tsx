import { useCallback, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Plus, ScrollText, X } from "lucide-react";
import { useDock } from "../lib/useDock";
import { OutputPanel } from "./OutputPanel";
import { TerminalView } from "./TerminalView";

interface DockProps {
  profile: string | null;
  running: boolean;
}

export function Dock({ profile, running }: DockProps) {
  const { open, setOpen, height, setHeight, activeTab, setActiveTab, terminals, openTerminalTab, closeTerminalTab } =
    useDock();
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const dragState = useRef<{ startY: number; startHeight: number } | null>(null);

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      dragState.current = { startY: e.clientY, startHeight: height };
      const onMove = (ev: MouseEvent) => {
        if (!dragState.current) return;
        const delta = dragState.current.startY - ev.clientY;
        setHeight(dragState.current.startHeight + delta);
      };
      const onUp = () => {
        dragState.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [height, setHeight],
  );

  return (
    <div className="flex flex-shrink-0 flex-col border-t" style={{ borderColor: "var(--border)" }}>
      <div
        onMouseDown={onDragStart}
        className="h-[3px] w-full flex-shrink-0 cursor-row-resize"
        style={{ background: "transparent" }}
      />
      <div
        className="flex items-center justify-between px-2 py-1 cursor-pointer select-none"
        style={{ background: "var(--surface-1)", borderBottom: open ? "1px solid var(--border)" : undefined }}
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center gap-0.5 overflow-x-auto">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setActiveTab("output");
              setOpen(true);
            }}
            className="flex items-center gap-1.5 rounded-t px-2.5 py-1 text-[12px] font-medium flex-shrink-0"
            style={{
              color: activeTab === "output" ? "var(--accent)" : "var(--text-dim)",
              background: activeTab === "output" && open ? "var(--surface-2)" : "transparent",
            }}
          >
            <ScrollText size={12} /> Output
          </button>
          {terminals.map((t) => (
            <div
              key={t.id}
              onClick={(e) => {
                e.stopPropagation();
                setActiveTab(t.id);
                setOpen(true);
              }}
              className="flex items-center gap-1.5 rounded-t px-2.5 py-1 text-[12px] font-medium flex-shrink-0 font-mono-app"
              style={{
                color: activeTab === t.id ? "var(--accent)" : "var(--text-dim)",
                background: activeTab === t.id && open ? "var(--surface-2)" : "transparent",
              }}
            >
              {t.title}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTerminalTab(t.id);
                }}
                className="opacity-50 hover:opacity-100"
              >
                <X size={11} />
              </button>
            </div>
          ))}
          <div className="relative flex-shrink-0">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setAddMenuOpen((v) => !v);
              }}
              className="flex items-center px-2 py-1 opacity-70 hover:opacity-100"
              style={{ color: "var(--text-dim)" }}
              title="New terminal"
            >
              <Plus size={13} />
            </button>
            {addMenuOpen && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAddMenuOpen(false);
                  }}
                />
                <div
                  className="absolute bottom-full left-0 z-20 mb-1 min-w-[220px] rounded-md border py-1 shadow-lg"
                  style={{ background: "var(--surface-1)", borderColor: "var(--border)", boxShadow: "0 -12px 32px var(--shadow-color)" }}
                >
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setAddMenuOpen(false);
                      openTerminalTab({ kind: "host" }, profile);
                    }}
                    className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--surface-2)]"
                    style={{ color: "var(--text)" }}
                  >
                    Local shell
                  </button>
                  <button
                    disabled={!running}
                    onClick={(e) => {
                      e.stopPropagation();
                      setAddMenuOpen(false);
                      openTerminalTab({ kind: "vm" }, profile);
                    }}
                    className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--surface-2)] disabled:opacity-40"
                    style={{ color: "var(--text)" }}
                  >
                    Colima VM shell ({profile ?? "default"})
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        <button className="opacity-60 hover:opacity-100 p-1 flex-shrink-0" style={{ color: "var(--text-dim)" }}>
          {open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </button>
      </div>
      {open && (
        <div style={{ height }}>
          <OutputPanel active={activeTab === "output"} />
          {terminals.map((t) => (
            <TerminalView
              key={t.id}
              profile={t.profile}
              target={t.target}
              active={activeTab === t.id}
              onExit={() => {}}
            />
          ))}
        </div>
      )}
    </div>
  );
}
