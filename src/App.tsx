import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "./lib/api";
import { useProfile, useReconcileProfiles } from "./lib/useProfile";
import { ThemeProvider } from "./lib/useTheme";
import { DockProvider, useDock } from "./lib/useDock";
import { Sidebar, type Page } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { StatusBar } from "./components/StatusBar";
import { Dock } from "./components/Dock";
import { ToastProvider, useToast } from "./components/Toasts";
import { StartDialog } from "./dialogs/StartDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { MachinesPage } from "./pages/Machines";
import { ContainersPage } from "./pages/Containers";
import { ImagesPage } from "./pages/Images";
import { VolumesPage } from "./pages/Volumes";
import { KubernetesPage } from "./pages/Kubernetes";
import { SetupPage } from "./pages/Setup";

function AppShell() {
  const [page, setPage] = useState<Page>("machines");
  const [startDialogProfile, setStartDialogProfile] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const toast = useToast();
  const { selected, setSelected } = useProfile();
  const dock = useDock();

  const envQuery = useQuery({ queryKey: ["envInfo"], queryFn: api.envInfo });
  const profilesQuery = useQuery({
    queryKey: ["profiles"],
    queryFn: api.listProfiles,
    refetchInterval: 3000,
  });
  const busyQuery = useQuery({
    queryKey: ["busyProfiles"],
    queryFn: api.busyProfiles,
    refetchInterval: 3000,
  });

  useReconcileProfiles(profilesQuery.data);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    api.onProfilesChanged(() => {
      queryClient.invalidateQueries({ queryKey: ["profiles"] });
      queryClient.invalidateQueries({ queryKey: ["profileStatus"] });
      queryClient.invalidateQueries({ queryKey: ["busyProfiles"] });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [queryClient]);

  const profiles = profilesQuery.data ?? [];
  const currentProfile = profiles.find((p) => p.name === selected);
  const busyProfiles = busyQuery.data ?? [];
  const isBusy = selected ? busyProfiles.includes(selected) : false;

  const statusQuery = useQuery({
    queryKey: ["profileStatus", selected],
    queryFn: () => api.profileStatus(selected!),
    enabled: !!selected,
    refetchInterval: 3000,
  });

  const kubernetesEnabled = statusQuery.data?.kubernetes ?? false;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        const id = page === "containers" ? "containers-search" : page === "images" ? "images-search" : null;
        if (id) {
          e.preventDefault();
          document.getElementById(id)?.focus();
        }
      }
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        dock.toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const handleStart = () => {
    if (!selected) return;
    setStartDialogProfile(selected);
  };

  const handleStop = () => {
    if (!selected) return;
    setConfirmStop(selected);
  };

  const doStop = async (force: boolean) => {
    if (!confirmStop) return;
    try {
      await api.stopProfile(confirmStop, force);
      toast.success(`${confirmStop} stopped`);
    } catch (e) {
      toast.error(`Failed to stop ${confirmStop}`, String(e));
    }
  };

  const handleRestart = async () => {
    if (!selected) return;
    try {
      await api.restartProfile(selected);
      toast.success(`${selected} restarting`);
    } catch (e) {
      toast.error(`Failed to restart ${selected}`, String(e));
    }
  };

  const handleTerminal = () => {
    if (!selected) return;
    dock.openTerminalTab({ kind: "vm" }, selected);
  };

  // Missing dependencies full-page setup guide.
  if (envQuery.data && envQuery.data.colimaVersion === null) {
    return <SetupPage envInfo={envQuery.data} standalone />;
  }

  const pageContent = useMemo(() => {
    if (!selected) {
      return (
        <div className="flex flex-1 items-center justify-center" style={{ color: "var(--text-dim)" }}>
          No profile selected
        </div>
      );
    }
    switch (page) {
      case "machines":
        return (
          <MachinesPage
            profiles={profiles}
            busyProfiles={busyProfiles}
            selected={selected}
            onSelect={setSelected}
            onStartProfile={(name) => setStartDialogProfile(name)}
            onNewMachine={() => setStartDialogProfile("__new__")}
          />
        );
      case "containers":
        return <ContainersPage profile={selected} status={statusQuery.data} />;
      case "images":
        return <ImagesPage profile={selected} />;
      case "volumes":
        return <VolumesPage profile={selected} />;
      case "kubernetes":
        return <KubernetesPage profile={selected} status={statusQuery.data} />;
      case "setup":
        return <SetupPage envInfo={envQuery.data} />;
      default:
        return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, selected, profiles, busyProfiles, statusQuery.data, envQuery.data]);

  return (
    <div className="flex h-screen w-screen overflow-hidden" style={{ background: "var(--surface-0)" }}>
      <Sidebar page={page} onNavigate={setPage} kubernetesEnabled={kubernetesEnabled} envInfo={envQuery.data} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          profiles={profiles}
          selected={selected}
          onSelect={setSelected}
          status={statusQuery.data}
          currentProfile={currentProfile}
          busy={isBusy}
          onStart={handleStart}
          onStop={handleStop}
          onRestart={handleRestart}
          onTerminal={handleTerminal}
        />
        <div className="flex min-h-0 flex-1 flex-col">{pageContent}</div>
        <Dock profile={selected} running={currentProfile?.status === "Running"} />
        <StatusBar
          status={statusQuery.data}
          running={currentProfile?.status === "Running"}
          busy={isBusy}
          dockOpen={dock.open}
          onToggleDock={dock.toggle}
        />
      </div>

      <StartDialog
        open={!!startDialogProfile}
        profileName={startDialogProfile === "__new__" ? "" : (startDialogProfile ?? "")}
        isNew={startDialogProfile === "__new__"}
        onClose={() => setStartDialogProfile(null)}
        onStarted={(name) => {
          setSelected(name);
          queryClient.invalidateQueries({ queryKey: ["profiles"] });
        }}
      />

      <ConfirmDialog
        open={!!confirmStop}
        onClose={() => setConfirmStop(null)}
        onConfirm={() => doStop(false)}
        title={`Stop ${confirmStop ?? ""}`}
        message={`This will stop the "${confirmStop ?? ""}" machine and all its containers. You can start it again later.`}
        confirmLabel="Stop"
      />
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <DockProvider>
          <AppShell />
        </DockProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
