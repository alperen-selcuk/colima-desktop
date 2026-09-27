import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import * as api from "../lib/api";
import type { RunOptions } from "../lib/types";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/Button";
import { useToast } from "../components/Toasts";

interface RunContainerDialogProps {
  open: boolean;
  profile: string;
  onClose: () => void;
  onRan: () => void;
  prefill: { image: string } | null;
}

const inputClass = "w-full rounded border px-2.5 py-1.5 text-[12.5px] outline-none";
const inputStyle = { background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text)" };

function ListEditor({
  items,
  setItems,
  placeholder,
}: {
  items: string[];
  setItems: (v: string[]) => void;
  placeholder: string;
}) {
  const [value, setValue] = useState("");
  const add = () => {
    const v = value.trim();
    if (v) {
      setItems([...items, v]);
      setValue("");
    }
  };
  return (
    <div>
      <div className="mb-1.5 flex flex-col gap-1">
        {items.map((it, i) => (
          <div
            key={i}
            className="flex items-center gap-2 rounded border px-2 py-1 font-mono-app text-[11.5px]"
            style={{ borderColor: "var(--border)", color: "var(--text)" }}
          >
            <span className="flex-1">{it}</span>
            <button onClick={() => setItems(items.filter((_, idx) => idx !== i))}>
              <X size={11} style={{ color: "var(--text-faint)" }} />
            </button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder={placeholder}
          className={inputClass}
          style={inputStyle}
        />
        <Button variant="secondary" size="sm" onClick={add}>
          <Plus size={12} />
        </Button>
      </div>
    </div>
  );
}

export function RunContainerDialog({ open, profile, onClose, onRan, prefill }: RunContainerDialogProps) {
  const toast = useToast();
  const [image, setImage] = useState("");
  const [name, setName] = useState("");
  const [ports, setPorts] = useState<string[]>([]);
  const [env, setEnv] = useState<string[]>([]);
  const [volumes, setVolumes] = useState<string[]>([]);
  const [command, setCommand] = useState("");
  const [restart, setRestart] = useState("no");
  const [network, setNetwork] = useState("");
  const [autoRemove, setAutoRemove] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setImage(prefill?.image ?? "");
      setName("");
      setPorts([]);
      setEnv([]);
      setVolumes([]);
      setCommand("");
      setRestart("no");
      setNetwork("");
      setAutoRemove(false);
    }
  }, [open, prefill]);

  const handleRun = async () => {
    if (!image.trim()) {
      toast.error("Image is required");
      return;
    }
    const options: RunOptions = {
      image: image.trim(),
      name: name.trim() || undefined,
      ports: ports.length ? ports : undefined,
      env: env.length ? env : undefined,
      volumes: volumes.length ? volumes : undefined,
      command: command.trim() || undefined,
      restart,
      network: network.trim() || undefined,
      autoRemove,
    };
    setBusy(true);
    try {
      const id = await api.runContainer(profile, options);
      toast.success(`Container started`, id.slice(0, 12));
      onRan();
      onClose();
    } catch (e) {
      toast.error("Failed to run container", String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Run container"
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleRun} disabled={busy}>
            {busy ? "Starting…" : "Run"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11.5px] font-medium" style={{ color: "var(--text-faint)" }}>
            Image
          </span>
          <input
            autoFocus
            value={image}
            onChange={(e) => setImage(e.target.value)}
            placeholder="nginx:latest"
            className={inputClass}
            style={inputStyle}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11.5px] font-medium" style={{ color: "var(--text-faint)" }}>
            Name (optional)
          </span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} style={inputStyle} />
        </label>

        <div>
          <span className="mb-1.5 block text-[11.5px] font-medium" style={{ color: "var(--text-faint)" }}>
            Ports (host:container)
          </span>
          <ListEditor items={ports} setItems={setPorts} placeholder="8080:80" />
        </div>

        <div>
          <span className="mb-1.5 block text-[11.5px] font-medium" style={{ color: "var(--text-faint)" }}>
            Environment
          </span>
          <ListEditor items={env} setItems={setEnv} placeholder="KEY=value" />
        </div>

        <div>
          <span className="mb-1.5 block text-[11.5px] font-medium" style={{ color: "var(--text-faint)" }}>
            Volumes
          </span>
          <ListEditor items={volumes} setItems={setVolumes} placeholder="/host:/container" />
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[11.5px] font-medium" style={{ color: "var(--text-faint)" }}>
            Command (optional)
          </span>
          <input value={command} onChange={(e) => setCommand(e.target.value)} className={inputClass} style={inputStyle} />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11.5px] font-medium" style={{ color: "var(--text-faint)" }}>
              Restart policy
            </span>
            <select value={restart} onChange={(e) => setRestart(e.target.value)} className={inputClass} style={inputStyle}>
              <option value="no">no</option>
              <option value="always">always</option>
              <option value="unless-stopped">unless-stopped</option>
              <option value="on-failure">on-failure</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11.5px] font-medium" style={{ color: "var(--text-faint)" }}>
              Network (optional)
            </span>
            <input value={network} onChange={(e) => setNetwork(e.target.value)} className={inputClass} style={inputStyle} />
          </label>
        </div>

        <label className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--text)" }}>
          <input type="checkbox" checked={autoRemove} onChange={(e) => setAutoRemove(e.target.checked)} />
          Automatically remove container when it exits (--rm)
        </label>
      </div>
    </Dialog>
  );
}
