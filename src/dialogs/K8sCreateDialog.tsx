// "Create" dialog for the Kubernetes tabs (§6.10): a simple form per kind that
// renders a live YAML preview (switchable to an editable YAML mode), with
// "Validate" (server dry-run) and "Create". Manifests come from the pure
// builders in lib/k8sManifests.ts; the backend (`k8s_create`) re-validates.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Plus, X } from "lucide-react";
import * as api from "../lib/api";
import {
  buildDaemonSet,
  buildDeployment,
  buildHeadlessService,
  buildIngress,
  buildPod,
  buildService,
  buildStatefulSet,
  parseIntStrict,
  selectorOptions,
  validateDaemonSet,
  validateDeployment,
  validateIngress,
  validatePod,
  validateService,
  validateStatefulSet,
  NODE_PORT_MAX,
  NODE_PORT_MIN,
  type CreatableKind,
  type LabelSource,
  type ServiceType,
} from "../lib/k8sManifests";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/Button";
import { K8sIcon, KIND_LABEL } from "../components/k8s/K8sIcon";
import { YamlEditor } from "../components/k8s/YamlEditor";
import { Field, SelectInput, TextInput } from "../components/k8s/FormField";
import { useToast } from "../components/Toasts";

export const NO_INGRESS_CONTROLLER_WARNING =
  "No ingress controller in this cluster — colima disables Traefik by default (k3s arg --disable=traefik); remove it in Configure › Kubernetes to use Ingress";

interface FormState {
  name: string;
  image: string;
  port: string; // container port
  replicas: string;
  env: { key: string; value: string }[];
  svcType: ServiceType;
  svcPort: string;
  targetPort: string;
  nodePort: string;
  selKey: string;
  selVal: string;
  host: string;
  path: string;
  pathType: "Prefix" | "Exact" | "ImplementationSpecific";
  backend: string;
  backendPort: string;
  ingressClass: string;
  headless: boolean;
  storage: string;
}

const INITIAL: FormState = {
  name: "",
  image: "",
  port: "",
  replicas: "1",
  env: [],
  svcType: "ClusterIP",
  svcPort: "80",
  targetPort: "80",
  nodePort: "",
  selKey: "app",
  selVal: "",
  host: "",
  path: "/",
  pathType: "Prefix",
  backend: "",
  backendPort: "",
  ingressClass: "",
  headless: true,
  storage: "",
};

interface K8sCreateDialogProps {
  open: boolean;
  profile: string;
  kind: CreatableKind;
  /** Namespace currently selected on the page (null = all). */
  currentNamespace: string | null;
  onClose: () => void;
  onCreated: (kind: CreatableKind) => void;
}

export function K8sCreateDialog({ open, profile, kind, currentNamespace, onClose, onCreated }: K8sCreateDialogProps) {
  const toast = useToast();
  const [ns, setNs] = useState(currentNamespace ?? "default");
  const [f, setF] = useState<FormState>(INITIAL);
  const [mode, setMode] = useState<"form" | "yaml">("form");
  const [yamlText, setYamlText] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState<"validate" | "create" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [classTouched, setClassTouched] = useState(false);
  const headlessCreated = useRef(false);

  const set = (patch: Partial<FormState>) => {
    setF((prev) => ({ ...prev, ...patch }));
    if (result) setResult(null);
  };

  useEffect(() => {
    if (open) {
      setNs(currentNamespace ?? "default");
      setF(INITIAL);
      setMode("form");
      setYamlText("");
      setShowErrors(false);
      setBusy(null);
      setResult(null);
      setClassTouched(false);
      headlessCreated.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind]);

  const namespacesQuery = useQuery({
    queryKey: ["k8sNamespaces", profile],
    queryFn: () => api.k8sNamespaces(profile),
    enabled: open,
  });
  const namespaces = useMemo(() => {
    const list = namespacesQuery.data ?? [];
    return list.includes(ns) ? list : [ns, ...list];
  }, [namespacesQuery.data, ns]);

  // --- Service: selector suggestions ---
  const isService = kind === "service";
  const depsQ = useQuery({ queryKey: ["k8sDeployments", profile, ns], queryFn: () => api.k8sDeployments(profile, ns), enabled: open && isService });
  const stsQ = useQuery({ queryKey: ["k8sStatefulSets", profile, ns], queryFn: () => api.k8sStatefulSets(profile, ns), enabled: open && isService });
  const dsQ = useQuery({ queryKey: ["k8sDaemonSets", profile, ns], queryFn: () => api.k8sDaemonSets(profile, ns), enabled: open && isService });
  const podsQ = useQuery({ queryKey: ["k8sPods", profile, ns], queryFn: () => api.k8sPods(profile, ns), enabled: open && isService });
  const options = useMemo(() => {
    const sources: LabelSource[] = [
      ...(depsQ.data ?? []).map((d) => ({ kind: "deployment", name: d.name, labels: d.podLabels })),
      ...(stsQ.data ?? []).map((d) => ({ kind: "statefulset", name: d.name, labels: d.podLabels })),
      ...(dsQ.data ?? []).map((d) => ({ kind: "daemonset", name: d.name, labels: d.podLabels })),
      ...(podsQ.data ?? []).map((p) => ({ kind: "pod", name: p.name, labels: p.labels })),
    ];
    return selectorOptions(sources);
  }, [depsQ.data, stsQ.data, dsQ.data, podsQ.data]);

  // --- Ingress: services + classes ---
  const isIngress = kind === "ingress";
  const servicesQ = useQuery({ queryKey: ["k8sServices", profile, ns], queryFn: () => api.k8sServices(profile, ns), enabled: open && isIngress });
  const classesQ = useQuery({ queryKey: ["k8sIngressClasses", profile], queryFn: () => api.k8sIngressClasses(profile), enabled: open && isIngress });
  const services = servicesQ.data ?? [];
  const classes = classesQ.data ?? [];
  const chosenService = services.find((s) => s.name === f.backend);

  useEffect(() => {
    if (!isIngress || !open) return;
    if (!chosenService) {
      if (services.length > 0 && f.backend === "") {
        const first = services[0];
        set({ backend: first.name, backendPort: String(first.portList[0]?.port ?? "") });
      }
      return;
    }
    if (!chosenService.portList.some((p) => String(p.port) === f.backendPort)) {
      set({ backendPort: String(chosenService.portList[0]?.port ?? "") });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isIngress, open, services.length, f.backend, chosenService?.name]);

  useEffect(() => {
    if (isIngress && open && !classTouched && f.ingressClass === "" && classes.length > 0) {
      setF((prev) => ({ ...prev, ingressClass: classes[0] }));
    }
  }, [isIngress, open, classTouched, f.ingressClass, classes]);

  // --- Derived manifest + errors ---
  const port = parseIntStrict(f.port);
  const replicas = parseIntStrict(f.replicas);
  const built = useMemo(() => {
    const base = { name: f.name, namespace: ns };
    switch (kind) {
      case "pod": {
        const i = { ...base, image: f.image, containerPort: port, env: f.env };
        return { yaml: buildPod(i), errors: validatePod(i) };
      }
      case "deployment": {
        const i = { ...base, image: f.image, replicas, containerPort: port };
        return { yaml: buildDeployment(i), errors: validateDeployment(i) };
      }
      case "daemonset": {
        const i = { ...base, image: f.image, containerPort: port };
        return { yaml: buildDaemonSet(i), errors: validateDaemonSet(i) };
      }
      case "statefulset": {
        const i = { ...base, image: f.image, replicas, containerPort: port, headlessService: f.headless, storageSize: f.storage };
        return { yaml: buildStatefulSet(i), errors: validateStatefulSet(i) };
      }
      case "service": {
        const i = {
          ...base,
          type: f.svcType,
          port: parseIntStrict(f.svcPort),
          targetPort: parseIntStrict(f.targetPort),
          nodePort: parseIntStrict(f.nodePort),
          selectorKey: f.selKey,
          selectorValue: f.selVal,
        };
        return { yaml: buildService(i), errors: validateService(i) };
      }
      case "ingress": {
        const i = {
          ...base,
          host: f.host,
          path: f.path,
          pathType: f.pathType,
          serviceName: f.backend,
          servicePort: parseIntStrict(f.backendPort),
          ingressClassName: f.ingressClass,
        };
        return { yaml: buildIngress(i), errors: validateIngress(i) };
      }
    }
  }, [kind, f, ns, port, replicas]);

  const headlessYaml =
    kind === "statefulset" && f.headless ? buildHeadlessService({ name: f.name, namespace: ns, containerPort: port }) : null;

  const switchMode = (next: "form" | "yaml") => {
    if (next === mode) return;
    if (next === "yaml") setYamlText(built.yaml);
    setMode(next);
    setResult(null);
  };

  const submit = async (dryRun: boolean) => {
    if (mode === "form" && built.errors.length > 0) {
      setShowErrors(true);
      return;
    }
    const content = mode === "yaml" ? yamlText : built.yaml;
    setBusy(dryRun ? "validate" : "create");
    setResult(null);
    try {
      const out: string[] = [];
      if (headlessYaml && (dryRun || !headlessCreated.current)) {
        out.push(await api.k8sCreate(profile, ns, headlessYaml, dryRun));
        if (!dryRun) headlessCreated.current = true;
      }
      out.push(await api.k8sCreate(profile, ns, content, dryRun));
      const message = out.filter(Boolean).join("\n") || (dryRun ? "Valid — nothing was created." : "Created.");
      if (dryRun) {
        setResult({ ok: true, message });
        toast.success(`${f.name || "Manifest"} is valid`);
      } else {
        toast.success(`Created ${KIND_LABEL[kind].toLowerCase()} ${f.name}`);
        onCreated(kind);
        onClose();
      }
    } catch (e) {
      setResult({ ok: false, message: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const label = KIND_LABEL[kind];
  const noController = isIngress && classesQ.isSuccess && classes.length === 0;
  const isWorkload = kind === "deployment" || kind === "statefulset";
  const showPort = kind === "pod" || kind === "deployment" || kind === "statefulset" || kind === "daemonset";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Create ${label}`}
      width={760}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy != null}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={() => submit(true)} disabled={busy != null}>
            {busy === "validate" ? "Validating…" : "Validate"}
          </Button>
          <Button variant="primary" onClick={() => submit(false)} disabled={busy != null}>
            {busy === "create" ? "Creating…" : "Create"}
          </Button>
        </>
      }
    >
      <div className="mb-3 flex items-center gap-2">
        <K8sIcon kind={kind} size={16} />
        <span className="text-[12px]" style={{ color: "var(--text-faint)" }}>
          {label} · {ns}
        </span>
        <div className="ml-auto flex overflow-hidden rounded border" style={{ borderColor: "var(--border)" }}>
          {(["form", "yaml"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => switchMode(m)}
              className="px-2.5 py-1 text-[11.5px] font-medium"
              style={{
                background: mode === m ? "var(--surface-3)" : "transparent",
                color: mode === m ? "var(--text)" : "var(--text-dim)",
              }}
            >
              {m === "form" ? "Form" : "Edit YAML"}
            </button>
          ))}
        </div>
      </div>

      {mode === "form" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Namespace">
            <SelectInput value={ns} onChange={(e) => setNs(e.target.value)}>
              {namespaces.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field label="Name">
            <TextInput autoFocus value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder={`my-${kind}`} />
          </Field>

          {kind !== "service" && kind !== "ingress" && (
            <Field label="Image" className="col-span-2">
              <TextInput value={f.image} onChange={(e) => set({ image: e.target.value })} placeholder="nginx:1.27" />
            </Field>
          )}
          {isWorkload && (
            <Field label="Replicas">
              <TextInput type="number" min={0} value={f.replicas} onChange={(e) => set({ replicas: e.target.value })} />
            </Field>
          )}
          {showPort && (
            <Field label="Container port" hint={kind === "statefulset" && f.headless ? "Required for the headless service" : "Optional"}>
              <TextInput type="number" min={1} max={65535} value={f.port} onChange={(e) => set({ port: e.target.value })} placeholder="80" />
            </Field>
          )}

          {kind === "pod" && (
            <div className="col-span-2 flex flex-col gap-1.5">
              <span className="text-[11.5px] font-medium" style={{ color: "var(--text-faint)" }}>
                Environment variables (optional)
              </span>
              {f.env.map((row, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <TextInput
                    value={row.key}
                    placeholder="KEY"
                    onChange={(e) => set({ env: f.env.map((r, j) => (j === idx ? { ...r, key: e.target.value } : r)) })}
                  />
                  <TextInput
                    value={row.value}
                    placeholder="value"
                    onChange={(e) => set({ env: f.env.map((r, j) => (j === idx ? { ...r, value: e.target.value } : r)) })}
                  />
                  <Button variant="ghost" size="sm" title="Remove" onClick={() => set({ env: f.env.filter((_, j) => j !== idx) })}>
                    <X size={13} />
                  </Button>
                </div>
              ))}
              <div>
                <Button variant="ghost" size="sm" onClick={() => set({ env: [...f.env, { key: "", value: "" }] })}>
                  <Plus size={12} /> Add variable
                </Button>
              </div>
            </div>
          )}

          {kind === "statefulset" && (
            <>
              <Field label="Storage size (optional)" hint="Adds a volumeClaimTemplate (storageClass local-path)">
                <TextInput value={f.storage} onChange={(e) => set({ storage: e.target.value })} placeholder="1Gi" />
              </Field>
              <label className="flex items-center gap-2 self-end pb-2 text-[12.5px]" style={{ color: "var(--text)" }}>
                <input type="checkbox" checked={f.headless} onChange={(e) => set({ headless: e.target.checked })} />
                Create headless Service “{f.name || "name"}”
              </label>
            </>
          )}

          {kind === "service" && (
            <>
              <Field label="Type">
                <SelectInput value={f.svcType} onChange={(e) => set({ svcType: e.target.value as ServiceType })}>
                  <option value="ClusterIP">ClusterIP</option>
                  <option value="NodePort">NodePort</option>
                  <option value="LoadBalancer">LoadBalancer</option>
                </SelectInput>
              </Field>
              <div />
              <Field label="Port">
                <TextInput type="number" min={1} max={65535} value={f.svcPort} onChange={(e) => set({ svcPort: e.target.value })} />
              </Field>
              <Field label="Target port">
                <TextInput type="number" min={1} max={65535} value={f.targetPort} onChange={(e) => set({ targetPort: e.target.value })} />
              </Field>
              {f.svcType === "NodePort" && (
                <Field label="Node port (optional)" hint={`${NODE_PORT_MIN}–${NODE_PORT_MAX}; blank = auto`}>
                  <TextInput
                    type="number"
                    min={NODE_PORT_MIN}
                    max={NODE_PORT_MAX}
                    value={f.nodePort}
                    onChange={(e) => set({ nodePort: e.target.value })}
                    placeholder="30080"
                  />
                </Field>
              )}
              <Field label="Selector from existing workloads" className="col-span-2">
                <SelectInput
                  value=""
                  onChange={(e) => {
                    const o = options[Number(e.target.value)];
                    if (o) set({ selKey: o.key, selVal: o.value });
                  }}
                >
                  <option value="">{options.length ? "Pick a label…" : "No labelled workloads in this namespace"}</option>
                  {options.map((o, idx) => (
                    <option key={o.label} value={idx}>
                      {o.label}
                    </option>
                  ))}
                </SelectInput>
              </Field>
              <Field label="Selector key">
                <TextInput value={f.selKey} onChange={(e) => set({ selKey: e.target.value })} placeholder="app" />
              </Field>
              <Field label="Selector value">
                <TextInput value={f.selVal} onChange={(e) => set({ selVal: e.target.value })} placeholder="my-app" />
              </Field>
            </>
          )}

          {kind === "ingress" && (
            <>
              <Field label="Host (optional)">
                <TextInput value={f.host} onChange={(e) => set({ host: e.target.value })} placeholder="app.localhost" />
              </Field>
              <Field label="Ingress class">
                <SelectInput
                  value={f.ingressClass}
                  onChange={(e) => {
                    setClassTouched(true);
                    set({ ingressClass: e.target.value });
                  }}
                >
                  <option value="">(none)</option>
                  {classes.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </SelectInput>
              </Field>
              {noController && (
                <div
                  className="col-span-2 flex items-start gap-2 rounded-md border px-3 py-2 text-[12px]"
                  style={{ borderColor: "var(--warn)", color: "var(--text)" }}
                >
                  <AlertTriangle size={14} style={{ color: "var(--warn)", marginTop: 1, flexShrink: 0 }} />
                  <span>{NO_INGRESS_CONTROLLER_WARNING}</span>
                </div>
              )}
              <Field label="Path">
                <TextInput value={f.path} onChange={(e) => set({ path: e.target.value })} placeholder="/" />
              </Field>
              <Field label="Path type">
                <SelectInput value={f.pathType} onChange={(e) => set({ pathType: e.target.value as FormState["pathType"] })}>
                  <option value="Prefix">Prefix</option>
                  <option value="Exact">Exact</option>
                  <option value="ImplementationSpecific">ImplementationSpecific</option>
                </SelectInput>
              </Field>
              <Field label="Backend service">
                <SelectInput value={f.backend} onChange={(e) => set({ backend: e.target.value })}>
                  {services.length === 0 && <option value="">No services in this namespace</option>}
                  {services.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </SelectInput>
              </Field>
              <Field label="Service port">
                <SelectInput value={f.backendPort} onChange={(e) => set({ backendPort: e.target.value })}>
                  {(chosenService?.portList ?? []).length === 0 && <option value="">—</option>}
                  {(chosenService?.portList ?? []).map((p) => (
                    <option key={`${p.port}/${p.protocol}`} value={p.port}>
                      {p.name ? `${p.port} (${p.name})` : p.port}
                    </option>
                  ))}
                </SelectInput>
              </Field>
            </>
          )}
        </div>
      )}

      {mode === "yaml" && (
        <div className="mb-2 text-[11.5px]" style={{ color: "var(--text-faint)" }}>
          Editing raw YAML — the form is ignored until you switch back (which discards these edits).
          {headlessYaml ? " The headless Service is still created from the form." : ""}
        </div>
      )}

      {mode === "form" && showErrors && built.errors.length > 0 && (
        <ul className="mt-3 list-disc pl-5 text-[12px]" style={{ color: "var(--danger)" }}>
          {built.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <div className="mb-1 mt-4 text-[11.5px] font-medium" style={{ color: "var(--text-faint)" }}>
        {mode === "form" ? "YAML preview" : "YAML"}
      </div>
      <YamlEditor
        value={mode === "form" ? built.yaml : yamlText}
        onChange={(v) => {
          setYamlText(v);
          if (result) setResult(null);
        }}
        readOnly={mode === "form"}
        minRows={10}
      />
      {headlessYaml && mode === "form" && (
        <div className="mt-1 text-[11px]" style={{ color: "var(--text-faint)" }}>
          A headless Service “{f.name}” (clusterIP: None) is created first, then the StatefulSet.
        </div>
      )}

      {result && (
        <div
          className="mt-3 rounded-md border px-3 py-2.5 text-[12px]"
          style={{
            borderColor: result.ok ? "var(--accent)" : "var(--danger)",
            background: result.ok ? "var(--accent-soft)" : "var(--danger-soft)",
          }}
        >
          <div className="flex items-start gap-2">
            {result.ok ? (
              <CheckCircle2 size={14} style={{ color: "var(--accent)", marginTop: 1, flexShrink: 0 }} />
            ) : (
              <AlertTriangle size={14} style={{ color: "var(--danger)", marginTop: 1, flexShrink: 0 }} />
            )}
            <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono-app text-[11.5px]" style={{ color: "var(--text)" }}>
              {result.message}
            </pre>
          </div>
        </div>
      )}
    </Dialog>
  );
}
