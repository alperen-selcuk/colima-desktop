import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { TerminalTarget } from "./types";

export interface TerminalTab {
  id: string; // stable tab id (also used as the React key)
  title: string;
  profile: string | null;
  target: TerminalTarget;
}

const HEIGHT_KEY = "colima-desktop.dockHeight";
const MIN_HEIGHT = 140;
const DEFAULT_HEIGHT = 260;

function readStoredHeight(): number {
  try {
    const v = window.localStorage.getItem(HEIGHT_KEY);
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) && n >= MIN_HEIGHT ? n : DEFAULT_HEIGHT;
  } catch {
    return DEFAULT_HEIGHT;
  }
}

function writeStoredHeight(h: number): void {
  try {
    window.localStorage.setItem(HEIGHT_KEY, String(h));
  } catch {
    // ignore
  }
}

export function targetTitle(target: TerminalTarget, profile: string | null, shell = "zsh"): string {
  switch (target.kind) {
    case "host":
      return shell;
    case "vm":
      return `vm: ${profile ?? "default"}`;
    case "container":
      return `ctr: ${target.id.slice(0, 12)}`;
    case "pod":
      return `pod: ${target.namespace}/${target.pod}`;
  }
}

interface DockContextValue {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
  height: number;
  setHeight: (h: number) => void;
  activeTab: string; // "output" or a terminal tab id
  setActiveTab: (id: string) => void;
  terminals: TerminalTab[];
  openTerminalTab: (target: TerminalTarget, profile: string | null, shell?: string) => void;
  closeTerminalTab: (id: string) => void;
  openOutputTab: () => void;
}

const DockContext = createContext<DockContextValue | null>(null);

export function DockProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [height, setHeightState] = useState<number>(() => readStoredHeight());
  const [activeTab, setActiveTab] = useState<string>("output");
  const [terminals, setTerminals] = useState<TerminalTab[]>([]);
  const counter = useRef(0);

  const setHeight = useCallback((h: number) => {
    const clamped = Math.max(MIN_HEIGHT, Math.min(h, Math.floor(window.innerHeight * 0.7)));
    setHeightState(clamped);
    writeStoredHeight(clamped);
  }, []);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  const openTerminalTab = useCallback((target: TerminalTarget, profile: string | null, shell?: string) => {
    const id = `term-${++counter.current}`;
    const tab: TerminalTab = { id, title: targetTitle(target, profile, shell), profile, target };
    setTerminals((prev) => [...prev, tab]);
    setActiveTab(id);
    setOpen(true);
  }, []);

  const closeTerminalTab = useCallback(
    (id: string) => {
      setTerminals((prev) => prev.filter((t) => t.id !== id));
      setActiveTab((current) => (current === id ? "output" : current));
    },
    [],
  );

  const openOutputTab = useCallback(() => {
    setActiveTab("output");
    setOpen(true);
  }, []);

  const value = useMemo<DockContextValue>(
    () => ({
      open,
      setOpen,
      toggle,
      height,
      setHeight,
      activeTab,
      setActiveTab,
      terminals,
      openTerminalTab,
      closeTerminalTab,
      openOutputTab,
    }),
    [open, toggle, height, setHeight, activeTab, terminals, openTerminalTab, closeTerminalTab, openOutputTab],
  );

  return <DockContext.Provider value={value}>{children}</DockContext.Provider>;
}

export function useDock(): DockContextValue {
  const ctx = useContext(DockContext);
  if (!ctx) throw new Error("useDock must be used within a DockProvider");
  return ctx;
}
