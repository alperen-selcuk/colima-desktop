import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import * as api from "../lib/api";
import type { StartOptions } from "../lib/types";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/Button";
import { useToast } from "../components/Toasts";

interface StartDialogProps {
  open: boolean;
  profileName: string;
  isNew: boolean;
  onClose: () => void;
  onStarted: (name: string) => void;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] font-medium" style={{ color: "var(--text-faint)" }}>
        {label}
      </span>
      {children}
    </label>
  );
}

const inputClass = "w-full rounded border px-2.5 py-1.5 text-[12.5px] outline-none";
const inputStyle = { background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text)" };

export function StartDialog({ open, profileName, isNew, onClose, onStarted }: StartDialogProps) {
  const toast = useToast();
  const [name, setName] = useState(profileName);
  const [cpu, setCpu] = useState(2);
  const [memory, setMemory] = useState(2);
  const [disk, setDisk] = useState(100);
  const [runtime, setRuntime] = useState("docker");
  const [vmType, setVmType] = useState("vz");
  const [arch, setArch] = useState("");
  const [mountType, setMountType] = useState("virtiofs");
  const [rosetta, setRosetta] = useState(false);
  const [networkAddress, setNetworkAddress] = useState(false);
  const [kubernetes, setKubernetes] = useState(false);
  const [kubernetesVersion, setKubernetesVersion] = useState("v1.30.0");
  const [activate, setActivate] = useState(true);
  const [mounts, setMounts] = useState<string[]>([]);
  const [mountInput, setMountInput] = useState("");
  const [busy, setBusy] = useState(false);

  const envQuery = useQuery({ queryKey: ["envInfo"], queryFn: api.envInfo, enabled: open });
  const isLinux = envQuery.data?.platform === "linux";

  const configQuery = useQuery({
    queryKey: ["profileConfig", profileName],
    queryFn: () => api.profileConfig(profileName),
    enabled: open && !isNew && !!profileName,
  });

  useEffect(() => {
    if (!open) return;
    setName(profileName);
    if (isNew) {
      setCpu(2);
      setMemory(2);
      setDisk(100);
      setRuntime("docker");
      setVmType(isLinux ? "qemu" : "vz");
      setArch(envQuery.data?.arch ?? "");
      setMountType("virtiofs");
      setRosetta(false);
      setNetworkAddress(false);
      setKubernetes(false);
      setKubernetesVersion("v1.30.0");
      setActivate(true);
      setMounts([]);
    } else if (configQuery.data) {
      const c = configQuery.data;
      setCpu(c.cpu);
      setMemory(c.memory);
      setDisk(c.disk);
      setRuntime(c.runtime);
      setVmType(c.vmType);
      setArch(c.arch);
      setMountType(c.mountType);
      setRosetta(c.rosetta);
      setNetworkAddress(c.networkAddress);
      setKubernetes(c.kubernetesEnabled);
      setKubernetesVersion(c.kubernetesVersion || "v1.30.0");
      setMounts(c.mounts);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isNew, profileName, configQuery.data, isLinux, envQuery.data]);

  const handleStart = async () => {
    const targetName = isNew ? name.trim() : profileName;
    if (!targetName) {
      toast.error("Machine name is required");
      return;
    }
    const options: StartOptions = {
      cpu,
      memory,
      disk,
      arch: arch || undefined,
      runtime,
      vmType,
      mountType,
      kubernetes,
      kubernetesVersion: kubernetes ? kubernetesVersion : undefined,
      vzRosetta: vmType === "vz" ? rosetta : undefined,
      networkAddress,
      activate,
      mounts: mounts.length > 0 ? mounts : undefined,
    };
    setBusy(true);
    try {
      await api.startProfile(targetName, options);
      toast.success(`${targetName} started`);
      onStarted(targetName);
      onClose();
    } catch (e) {
      toast.error(`Failed to start ${targetName}`, String(e));
    } finally {
      setBusy(false);
    }
  };

  const addMount = () => {
    const v = mountInput.trim();
    if (v) {
      setMounts((m) => [...m, v]);
      setMountInput("");
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isNew ? "New machine" : `Start ${profileName}`}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleStart} disabled={busy}>
            {busy ? "Starting…" : "Start"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        {isNew && (
          <div className="col-span-2">
            <Field label="Name">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="default"
                className={inputClass}
                style={inputStyle}
              />
            </Field>
          </div>
        )}

        <Field label="CPU">
          <input
            type="number"
            min={1}
            value={cpu}
            onChange={(e) => setCpu(Number(e.target.value))}
            className={inputClass}
            style={inputStyle}
          />
        </Field>
        <Field label="Memory (GiB)">
          <input
            type="number"
            min={1}
            value={memory}
            onChange={(e) => setMemory(Number(e.target.value))}
            className={inputClass}
            style={inputStyle}
          />
        </Field>
        <Field label="Disk (GiB)">
          <input
            type="number"
            min={10}
            value={disk}
            onChange={(e) => setDisk(Number(e.target.value))}
            className={inputClass}
            style={inputStyle}
          />
        </Field>
        <div className="col-span-2 -mt-2 text-[11px]" style={{ color: "var(--text-faint)" }}>
          Disk size can be increased but not shrunk once the machine has been created.
        </div>

        <Field label="Runtime">
          <select value={runtime} onChange={(e) => setRuntime(e.target.value)} className={inputClass} style={inputStyle}>
            <option value="docker">docker</option>
            <option value="containerd">containerd</option>
            <option value="incus">incus</option>
          </select>
        </Field>
        <Field label="VM type">
          <select value={vmType} onChange={(e) => setVmType(e.target.value)} className={inputClass} style={inputStyle}>
            {!isLinux && <option value="vz">vz</option>}
            <option value="qemu">qemu</option>
          </select>
        </Field>
        <Field label="Architecture">
          <select value={arch} onChange={(e) => setArch(e.target.value)} className={inputClass} style={inputStyle}>
            <option value="">(host)</option>
            <option value="aarch64">aarch64</option>
            <option value="x86_64">x86_64</option>
          </select>
        </Field>
        <Field label="Mount type">
          <select value={mountType} onChange={(e) => setMountType(e.target.value)} className={inputClass} style={inputStyle}>
            <option value="sshfs">sshfs</option>
            <option value="9p">9p</option>
            <option value="virtiofs">virtiofs</option>
          </select>
        </Field>

        <label className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--text)" }}>
          <input
            type="checkbox"
            checked={networkAddress}
            onChange={(e) => setNetworkAddress(e.target.checked)}
          />
          Network address
        </label>
        {!isLinux && vmType === "vz" && (
          <label className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--text)" }}>
            <input type="checkbox" checked={rosetta} onChange={(e) => setRosetta(e.target.checked)} />
            Rosetta (x86 emulation)
          </label>
        )}
        <label className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--text)" }}>
          <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
          Activate docker context
        </label>

        <div className="col-span-2 mt-1 border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <label className="flex items-center gap-2 text-[12.5px] font-medium" style={{ color: "var(--text)" }}>
            <input type="checkbox" checked={kubernetes} onChange={(e) => setKubernetes(e.target.checked)} />
            Enable Kubernetes
          </label>
          {kubernetes && (
            <div className="mt-2">
              <Field label="Kubernetes version">
                <input
                  value={kubernetesVersion}
                  onChange={(e) => setKubernetesVersion(e.target.value)}
                  className={inputClass}
                  style={inputStyle}
                />
              </Field>
            </div>
          )}
        </div>

        <div className="col-span-2 mt-1 border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <span className="mb-1.5 block text-[11.5px] font-medium" style={{ color: "var(--text-faint)" }}>
            Mounts
          </span>
          <div className="mb-2 flex flex-col gap-1">
            {mounts.map((m, i) => (
              <div
                key={i}
                className="flex items-center gap-2 rounded border px-2 py-1 text-[12px] font-mono-app"
                style={{ borderColor: "var(--border)", color: "var(--text)" }}
              >
                <span className="flex-1">{m}</span>
                <button onClick={() => setMounts((ms) => ms.filter((_, idx) => idx !== i))}>
                  <X size={12} style={{ color: "var(--text-faint)" }} />
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={mountInput}
              onChange={(e) => setMountInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addMount()}
              placeholder="~/projects:w"
              className={inputClass}
              style={inputStyle}
            />
            <Button variant="secondary" size="sm" onClick={addMount}>
              <Plus size={12} /> Add
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
