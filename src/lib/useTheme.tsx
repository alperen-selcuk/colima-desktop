import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { resolveTheme, type ResolvedTheme, type ThemePreference } from "./format";

const STORAGE_KEY = "colima-desktop.theme";

function readStoredTheme(): ThemePreference {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // ignore
  }
  return "system";
}

function writeStoredTheme(pref: ThemePreference): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // ignore (private mode, quota, etc.)
  }
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Read the app's current CSS theme tokens (for building the xterm.js theme object). */
export function readThemeTokens(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => style.getPropertyValue(name).trim();
  return {
    background: read("--term-bg"),
    foreground: read("--term-fg"),
    cursor: read("--term-cursor"),
    selectionBackground: read("--term-selection"),
    black: read("--term-black"),
    red: read("--term-red"),
    green: read("--term-green"),
    yellow: read("--term-yellow"),
    blue: read("--term-blue"),
    magenta: read("--term-magenta"),
    cyan: read("--term-cyan"),
    white: read("--term-white"),
    brightBlack: read("--term-bright-black"),
  };
}

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (pref: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readStoredTheme());
  const [systemDark, setSystemDark] = useState<boolean>(() => systemPrefersDark());

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolved = useMemo(() => resolveTheme(preference, systemDark), [preference, systemDark]);

  useEffect(() => {
    const root = document.documentElement;
    if (preference === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", preference);
    }
  }, [preference]);

  const setPreference = (pref: ThemePreference) => {
    setPreferenceState(pref);
    writeStoredTheme(pref);
  };

  const value = useMemo(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
