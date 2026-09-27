import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Profile } from "./types";

const STORAGE_KEY = "colima-desktop.selectedProfile";

function readStoredProfile(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredProfile(name: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // ignore (private mode, quota, etc.)
  }
}

interface ProfileContextValue {
  selected: string | null;
  setSelected: (name: string) => void;
  /** Reconcile the selected profile against the live profile list (call on every profiles fetch). */
  reconcile: (profiles: Profile[]) => void;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [selected, setSelectedState] = useState<string | null>(() => readStoredProfile());

  const setSelected = useCallback((name: string) => {
    setSelectedState(name);
    writeStoredProfile(name);
  }, []);

  const reconcile = useCallback(
    (profiles: Profile[]) => {
      if (profiles.length === 0) return;
      const names = new Set(profiles.map((p) => p.name));
      if (selected && names.has(selected)) return;

      const firstRunning = profiles.find((p) => p.status === "Running");
      const fallback = firstRunning?.name ?? (names.has("default") ? "default" : profiles[0].name);
      setSelected(fallback);
    },
    [selected, setSelected],
  );

  const value = useMemo(
    () => ({ selected, setSelected, reconcile }),
    [selected, setSelected, reconcile],
  );

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfile(): ProfileContextValue {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error("useProfile must be used within a ProfileProvider");
  return ctx;
}

/** Convenience hook: keeps the selected profile reconciled whenever a fresh profile list arrives. */
export function useReconcileProfiles(profiles: Profile[] | undefined): void {
  const { reconcile } = useProfile();
  useEffect(() => {
    if (profiles) reconcile(profiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles]);
}
