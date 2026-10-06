import { useEffect, useState } from "react";
import { FileText, FolderOpen, History } from "lucide-react";
import * as api from "../lib/api";
import { isTauriRuntime } from "../lib/api";
import type { ComposePreview } from "../lib/types";
import {
  defaultProjectNameForFile,
  isValidComposeProjectName,
  readRecentComposeFiles,
  recordRecentComposeFile,
  type RecentComposeFile,
} from "../lib/compose";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/Button";
import { useToast } from "../components/Toasts";
import { useDock } from "../lib/useDock";

interface ComposeUpDialogProps {
  open: boolean;
  profile: string;
  onClose: () => void;
  onStarted: () => void;
}

const inputClass = "w-full rounded border px-2.5 py-1.5 text-[12.5px] outline-none";
const inputStyle = { background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text)" };

export function ComposeUpDialog({ open, profile, onClose, onStarted }: ComposeUpDialogProps) {
  const toast = useToast();
  const dock = useDock();
  const [files, setFiles] = useState<string[]>([]);
  const [projectName, setProjectName] = useState("");
  const [projectNameTouched, setProjectNameTouched] = useState(false);
  const [build, setBuild] = useState(false);
  const [pullAlways, setPullAlways] = useState(false);
  const [forceRecreate, setForceRecreate] = useState(false);
  const [recent, setRecent] = useState<RecentComposeFile[]>([]);
  const [preview, setPreview] = useState<ComposePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setFiles([]);
      setProjectName("");
      setProjectNameTouched(false);
      setBuild(false);
      setPullAlways(false);
      setForceRecreate(false);
      setPreview(null);
      setPreviewError(null);
      setRecent(readRecentComposeFiles());
    }
  }, [open]);

  // Live preview via compose_preview whenever the file selection or explicit
  // project name changes (debounced lightly by only firing on committed
  // state changes, not per keystroke — project name is a controlled input
  // but preview only re-fires from this effect).
  useEffect(() => {
    if (!open || files.length === 0) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    api
      .composePreview(profile, files, projectName.trim() || null)
      .then((result) => {
        if (cancelled) return;
        setPreview(result);
        if (!projectNameTouched) setProjectName(result.projectName);
      })
      .catch((e) => {
        if (cancelled) return;
        setPreview(null);
        setPreviewError(String(e));
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, profile, JSON.stringify(files)]);

  const pickFile = async () => {
    if (!isTauriRuntime()) {
      toast.info("File picker is only available in the desktop app");
      return;
    }
    const { open: openFileDialog } = await import("@tauri-apps/plugin-dialog");
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "Compose file", extensions: ["yml", "yaml"] }],
    });
    if (typeof selected === "string") {
      setFiles([selected]);
      if (!projectNameTouched) setProjectName(defaultProjectNameForFile(selected));
    }
  };

  const pickRecent = (path: string) => {
    setFiles([path]);
    if (!projectNameTouched) setProjectName(defaultProjectNameForFile(path));
  };

  const projectNameValid = projectName.trim() === "" || isValidComposeProjectName(projectName.trim());

  const handleUp = async () => {
    if (files.length === 0) {
      toast.error("Choose a compose file first");
      return;
    }
    const trimmed = projectName.trim();
    if (trimmed && !isValidComposeProjectName(trimmed)) {
      toast.error("Invalid project name", "Use lowercase letters, digits, underscore or hyphen, starting with a letter or digit.");
      return;
    }
    setBusy(true);
    try {
      await api.composeUp(profile, files, trimmed || null, build, pullAlways ? "always" : "missing", forceRecreate);
      recordRecentComposeFile(files[0]);
      toast.success(`Compose project ${trimmed || "started"} is coming up`);
      dock.openOutputTab();
      onStarted();
      onClose();
    } catch (e) {
      toast.error("Failed to start compose project", String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Compose up…"
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleUp} disabled={busy || files.length === 0 || !projectNameValid}>
            {busy ? "Starting…" : "Up"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div>
          <span className="mb-1.5 block text-[11.5px] font-medium" style={{ color: "var(--text-faint)" }}>
            Compose file
          </span>
          {files.length > 0 ? (
            <div
              className="flex items-center gap-2 rounded border px-2.5 py-1.5 font-mono-app text-[11.5px]"
              style={{ borderColor: "var(--border)", color: "var(--text)" }}
            >
              <FileText size={13} style={{ color: "var(--docker-blue)", flexShrink: 0 }} />
              <span className="flex-1 truncate">{files[0]}</span>
              <Button variant="ghost" size="sm" onClick={() => setFiles([])}>
                Change
              </Button>
            </div>
          ) : (
            <Button variant="secondary" size="sm" onClick={pickFile}>
              <FolderOpen size={12} /> Choose file (yml/yaml)…
            </Button>
          )}

          {files.length === 0 && recent.length > 0 && (
            <div className="mt-2">
              <div className="mb-1 flex items-center gap-1 text-[10.5px]" style={{ color: "var(--text-faint)" }}>
                <History size={10} /> Recent
              </div>
              <div className="flex flex-col gap-0.5">
                {recent.map((r) => (
                  <button
                    key={r.path}
                    onClick={() => pickRecent(r.path)}
                    className="truncate rounded px-2 py-1 text-left font-mono-app text-[11px] hover:bg-[var(--surface-2)]"
                    style={{ color: "var(--text-dim)" }}
                    title={r.path}
                  >
                    {r.path}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[11.5px] font-medium" style={{ color: "var(--text-faint)" }}>
            Project name
          </span>
          <input
            value={projectName}
            onChange={(e) => {
              setProjectName(e.target.value);
              setProjectNameTouched(true);
            }}
            placeholder="project"
            className={inputClass}
            style={{ ...inputStyle, borderColor: projectNameValid ? inputStyle.borderColor : "var(--danger)" }}
          />
          {!projectNameValid && (
            <span className="text-[11px]" style={{ color: "var(--danger)" }}>
              Use lowercase letters, digits, underscore or hyphen, starting with a letter or digit.
            </span>
          )}
        </label>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--text)" }}>
            <input type="checkbox" checked={build} onChange={(e) => setBuild(e.target.checked)} />
            Build
          </label>
          <label className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--text)" }}>
            <input type="checkbox" checked={pullAlways} onChange={(e) => setPullAlways(e.target.checked)} />
            Pull always
          </label>
          <label className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--text)" }}>
            <input type="checkbox" checked={forceRecreate} onChange={(e) => setForceRecreate(e.target.checked)} />
            Force recreate
          </label>
        </div>

        {files.length > 0 && (
          <div>
            <span className="mb-1.5 block text-[11.5px] font-medium" style={{ color: "var(--text-faint)" }}>
              Services
            </span>
            {previewLoading ? (
              <div className="text-[12px]" style={{ color: "var(--text-faint)" }}>
                Validating…
              </div>
            ) : previewError ? (
              <div
                className="rounded border px-2.5 py-2 text-[11.5px]"
                style={{ borderColor: "var(--danger)", color: "var(--danger)", background: "var(--danger-soft)" }}
              >
                {previewError}
              </div>
            ) : preview ? (
              <div className="flex flex-col gap-1">
                {preview.services.map((s) => (
                  <div
                    key={s.name}
                    className="flex items-center gap-2 rounded border px-2.5 py-1.5 text-[11.5px]"
                    style={{ borderColor: "var(--border)" }}
                  >
                    <span className="font-medium" style={{ color: "var(--text)" }}>
                      {s.name}
                    </span>
                    <span className="font-mono-app" style={{ color: "var(--text-faint)" }}>
                      {s.build ? "build" : s.image ?? "—"}
                    </span>
                    {s.ports.length > 0 && (
                      <span className="ml-auto font-mono-app text-[10.5px]" style={{ color: "var(--text-dim)" }}>
                        {s.ports.join(", ")}
                      </span>
                    )}
                  </div>
                ))}
                {preview.warnings.map((w, i) => (
                  <div key={i} className="text-[11px]" style={{ color: "var(--warn)" }}>
                    {w}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </Dialog>
  );
}
