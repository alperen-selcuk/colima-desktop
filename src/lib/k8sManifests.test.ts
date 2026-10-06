import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  buildDaemonSet,
  buildDeployment,
  buildHeadlessService,
  buildIngress,
  buildPod,
  buildService,
  buildStatefulSet,
  parseIntStrict,
  pickSelectorLabel,
  selectorOptions,
  validateDeployment,
  validateIngress,
  validateName,
  validateNodePort,
  validatePod,
  validatePort,
  validateService,
  validateStatefulSet,
} from "./k8sManifests";

describe("validators", () => {
  it("validates RFC1123 names", () => {
    expect(validateName("web-1")).toBeNull();
    expect(validateName("")).not.toBeNull();
    expect(validateName("Web")).not.toBeNull();
    expect(validateName("-web")).not.toBeNull();
    expect(validateName("web-")).not.toBeNull();
    expect(validateName("a".repeat(64))).not.toBeNull();
    expect(validateName("a.b")).not.toBeNull();
  });

  it("validates ports", () => {
    expect(validatePort(80, "Port")).toBeNull();
    expect(validatePort(0, "Port")).not.toBeNull();
    expect(validatePort(65536, "Port")).not.toBeNull();
    expect(validatePort(null, "Port")).not.toBeNull();
    expect(validatePort(null, "Port", false)).toBeNull();
  });

  it("validates nodePort range", () => {
    expect(validateNodePort(null)).toBeNull();
    expect(validateNodePort(30000)).toBeNull();
    expect(validateNodePort(32767)).toBeNull();
    expect(validateNodePort(29999)).not.toBeNull();
    expect(validateNodePort(32768)).not.toBeNull();
  });

  it("parseIntStrict", () => {
    expect(parseIntStrict(" 80 ")).toBe(80);
    expect(parseIntStrict("")).toBeNull();
    expect(parseIntStrict("8a")).toBeNull();
    expect(parseIntStrict("1.5")).toBeNull();
  });
});

describe("pod / deployment / daemonset", () => {
  it("builds a pod with labels, port and env", () => {
    const y = parse(
      buildPod({ name: "p", namespace: "dev", image: "nginx:1", containerPort: 80, env: [{ key: "A", value: "1" }, { key: "", value: "" }] }),
    );
    expect(y.kind).toBe("Pod");
    expect(y.metadata).toEqual({ name: "p", namespace: "dev", labels: { app: "p" } });
    expect(y.spec.containers[0]).toEqual({ name: "p", image: "nginx:1", ports: [{ containerPort: 80 }], env: [{ name: "A", value: "1" }] });
  });

  it("omits ports and env when unset", () => {
    const y = parse(buildPod({ name: "p", namespace: "d", image: "x", containerPort: null }));
    expect(y.spec.containers[0]).toEqual({ name: "p", image: "x" });
  });

  it("builds a deployment with app label selector", () => {
    const y = parse(buildDeployment({ name: "api", namespace: "d", image: "i", replicas: 3, containerPort: 8080 }));
    expect(y.apiVersion).toBe("apps/v1");
    expect(y.spec.replicas).toBe(3);
    expect(y.spec.selector.matchLabels).toEqual({ app: "api" });
    expect(y.spec.template.metadata.labels).toEqual({ app: "api" });
    expect(y.spec.template.spec.containers[0].ports).toEqual([{ containerPort: 8080 }]);
  });

  it("builds a daemonset", () => {
    const y = parse(buildDaemonSet({ name: "agent", namespace: "d", image: "i", containerPort: null }));
    expect(y.kind).toBe("DaemonSet");
    expect(y.spec.selector.matchLabels).toEqual({ app: "agent" });
  });

  it("validates inputs", () => {
    expect(validatePod({ name: "Bad", namespace: "d", image: "", containerPort: 70000 })).toHaveLength(3);
    expect(validateDeployment({ name: "ok", namespace: "d", image: "i", replicas: -1, containerPort: null })).toHaveLength(1);
    expect(validatePod({ name: "ok", namespace: "d", image: "i", containerPort: null, env: [{ key: "1BAD", value: "" }] })).toHaveLength(1);
  });
});

describe("statefulset", () => {
  const base = { name: "db", namespace: "d", image: "pg", replicas: 2, containerPort: 5432, headlessService: true, storageSize: "" };

  it("builds without storage", () => {
    const y = parse(buildStatefulSet(base));
    expect(y.spec.serviceName).toBe("db");
    expect(y.spec.volumeClaimTemplates).toBeUndefined();
  });

  it("adds volumeClaimTemplates with local-path", () => {
    const y = parse(buildStatefulSet({ ...base, storageSize: "1Gi" }));
    expect(y.spec.volumeClaimTemplates[0].spec.storageClassName).toBe("local-path");
    expect(y.spec.volumeClaimTemplates[0].spec.resources.requests.storage).toBe("1Gi");
    expect(y.spec.template.spec.containers[0].volumeMounts[0].name).toBe("data");
  });

  it("builds the headless service", () => {
    const y = parse(buildHeadlessService(base));
    expect(y.spec.clusterIP).toBe("None");
    expect(y.spec.ports).toEqual([{ port: 5432, targetPort: 5432 }]);
    expect(y.spec.selector).toEqual({ app: "db" });
  });

  it("requires a port for the headless service and a valid size", () => {
    expect(validateStatefulSet({ ...base, containerPort: null })).toHaveLength(1);
    expect(validateStatefulSet({ ...base, containerPort: null, headlessService: false })).toHaveLength(0);
    expect(validateStatefulSet({ ...base, storageSize: "lots" })).toHaveLength(1);
  });
});

describe("service", () => {
  const base = { name: "web", namespace: "d", type: "ClusterIP" as const, port: 80, targetPort: 8080, nodePort: null, selectorKey: "app", selectorValue: "web" };

  it("builds ClusterIP with selector", () => {
    const y = parse(buildService(base));
    expect(y.spec.type).toBe("ClusterIP");
    expect(y.spec.selector).toEqual({ app: "web" });
    expect(y.spec.ports).toEqual([{ port: 80, targetPort: 8080, protocol: "TCP" }]);
  });

  it("includes nodePort only for NodePort", () => {
    expect(parse(buildService({ ...base, type: "NodePort", nodePort: 30080 })).spec.ports[0].nodePort).toBe(30080);
    expect(parse(buildService({ ...base, type: "LoadBalancer", nodePort: 30080 })).spec.ports[0].nodePort).toBeUndefined();
  });

  it("omits the selector when empty", () => {
    expect(parse(buildService({ ...base, selectorKey: "", selectorValue: "" })).spec.selector).toBeUndefined();
  });

  it("validates nodePort only for NodePort", () => {
    expect(validateService({ ...base, nodePort: 5 })).toHaveLength(0);
    expect(validateService({ ...base, type: "NodePort", nodePort: 5 })).toHaveLength(1);
    expect(validateService({ ...base, selectorKey: "", selectorValue: "x" })).toHaveLength(1);
  });
});

describe("ingress", () => {
  const base = {
    name: "web", namespace: "d", host: "web.localhost", path: "/", pathType: "Prefix" as const,
    serviceName: "web", servicePort: 80, ingressClassName: "traefik",
  };

  it("builds a rule with class, host and backend", () => {
    const y = parse(buildIngress(base));
    expect(y.apiVersion).toBe("networking.k8s.io/v1");
    expect(y.spec.ingressClassName).toBe("traefik");
    expect(y.spec.rules[0].host).toBe("web.localhost");
    expect(y.spec.rules[0].http.paths[0]).toEqual({
      path: "/", pathType: "Prefix", backend: { service: { name: "web", port: { number: 80 } } },
    });
  });

  it("omits host and class when blank", () => {
    const y = parse(buildIngress({ ...base, host: "", ingressClassName: "" }));
    expect(y.spec.ingressClassName).toBeUndefined();
    expect(y.spec.rules[0].host).toBeUndefined();
  });

  it("validates", () => {
    expect(validateIngress(base)).toHaveLength(0);
    expect(validateIngress({ ...base, host: "Bad Host" })).toHaveLength(1);
    expect(validateIngress({ ...base, path: "x" })).toHaveLength(1);
    expect(validateIngress({ ...base, serviceName: "", servicePort: null })).toHaveLength(2);
  });
});

describe("selector options", () => {
  it("prefers app label", () => {
    expect(pickSelectorLabel({ tier: "x", app: "web" })).toEqual(["app", "web"]);
    expect(pickSelectorLabel({ tier: "x" })).toEqual(["tier", "x"]);
    expect(pickSelectorLabel({})).toBeNull();
  });

  it("dedupes by key=value and keeps order", () => {
    const opts = selectorOptions([
      { kind: "deployment", name: "api", labels: { app: "api" } },
      { kind: "pod", name: "api-abc", labels: { app: "api", "pod-template-hash": "z" } },
      { kind: "pod", name: "solo", labels: { app: "solo" } },
      { kind: "pod", name: "none", labels: {} },
    ]);
    expect(opts.map((o) => `${o.key}=${o.value}`)).toEqual(["app=api", "app=solo"]);
    expect(opts[0].label).toBe("deployment/api · app=api");
  });
});
