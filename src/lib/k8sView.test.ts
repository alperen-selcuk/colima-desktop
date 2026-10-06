import { describe, expect, it } from "vitest";
import {
  formatBytesShort,
  formatMillicores,
  ingressAllHosts,
  ingressHostUrl,
  formatIngressRule,
  requiresTypedDeleteConfirm,
  selectUsage,
  usageTone,
  usageTooltip,
} from "./k8sView";

describe("selectUsage", () => {
  it("returns null percent when used value is null", () => {
    expect(selectUsage(null, 500, 100, 2000)).toEqual({ percent: null, basis: null, denominator: null });
  });

  it("prefers limit over request and allocatable", () => {
    const r = selectUsage(250, 500, 100, 2000);
    expect(r.basis).toBe("limit");
    expect(r.denominator).toBe(500);
    expect(r.percent).toBeCloseTo(50);
  });

  it("falls back to request when limit is missing", () => {
    const r = selectUsage(50, null, 100, 2000);
    expect(r.basis).toBe("request");
    expect(r.percent).toBeCloseTo(50);
  });

  it("falls back to request when limit is zero", () => {
    const r = selectUsage(50, 0, 100, 2000);
    expect(r.basis).toBe("request");
  });

  it("falls back to node allocatable when both limit and request are missing", () => {
    const r = selectUsage(1000, null, null, 2000);
    expect(r.basis).toBe("allocatable");
    expect(r.percent).toBeCloseTo(50);
  });

  it("returns null percent/basis when no denominator is available at all", () => {
    expect(selectUsage(100, null, null, null)).toEqual({ percent: null, basis: null, denominator: null });
  });

  it("ignores a negative/zero allocatable", () => {
    expect(selectUsage(100, null, null, 0).basis).toBeNull();
  });
});

describe("usageTone", () => {
  it("is good below 60%", () => {
    expect(usageTone(0)).toBe("good");
    expect(usageTone(59.9)).toBe("good");
  });

  it("is warn between 60% and 85%", () => {
    expect(usageTone(60)).toBe("warn");
    expect(usageTone(84.9)).toBe("warn");
  });

  it("is bad at or above 85%", () => {
    expect(usageTone(85)).toBe("bad");
    expect(usageTone(150)).toBe("bad");
  });
});

describe("formatMillicores", () => {
  it("formats sub-core values with an m suffix", () => {
    expect(formatMillicores(120)).toBe("120m");
    expect(formatMillicores(1)).toBe("1m");
  });

  it("formats whole cores without decimals", () => {
    expect(formatMillicores(1000)).toBe("1");
    expect(formatMillicores(2000)).toBe("2");
  });

  it("formats fractional cores with one decimal", () => {
    expect(formatMillicores(1500)).toBe("1.5");
  });
});

describe("formatBytesShort", () => {
  it("formats zero and small byte counts", () => {
    expect(formatBytesShort(0)).toBe("0 B");
    expect(formatBytesShort(512)).toBe("512 B");
  });

  it("formats mebibytes and gibibytes", () => {
    expect(formatBytesShort(256 * 1024 * 1024)).toBe("256 MiB");
    expect(formatBytesShort(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GiB");
  });
});

describe("usageTooltip", () => {
  it("renders exact CPU values against the limit", () => {
    const result = selectUsage(120, 500, null, null);
    expect(usageTooltip(120, result, "cpu")).toBe("120m / 500m limit");
  });

  it("renders exact memory values against node allocatable", () => {
    const result = selectUsage(180 * 1024 * 1024, null, null, 256 * 1024 * 1024);
    expect(usageTooltip(180 * 1024 * 1024, result, "memory")).toBe("180 MiB / 256 MiB node allocatable");
  });

  it("renders just the used value when there is no denominator", () => {
    const result = selectUsage(120, null, null, null);
    expect(usageTooltip(120, result, "cpu")).toBe("120m");
  });
});

describe("ingressHostUrl", () => {
  it("builds an https URL when tls is set", () => {
    expect(ingressHostUrl("app.example.com", true)).toBe("https://app.example.com");
  });

  it("builds an http URL when tls is not set", () => {
    expect(ingressHostUrl("app.example.com", false)).toBe("http://app.example.com");
  });

  it("returns null for an empty/null host", () => {
    expect(ingressHostUrl(null, true)).toBeNull();
    expect(ingressHostUrl("", true)).toBeNull();
  });
});

describe("ingressAllHosts", () => {
  it("dedupes hosts across the hosts field and rules", () => {
    const hosts = ingressAllHosts({
      hosts: ["a.example.com", "b.example.com"],
      rules: [
        { host: "a.example.com", path: "/", pathType: "Prefix", backend: "svc:80" },
        { host: "c.example.com", path: "/api", pathType: "Prefix", backend: "svc2:80" },
        { host: null, path: "/", pathType: null, backend: "svc3:80" },
      ],
    });
    expect(hosts.sort()).toEqual(["a.example.com", "b.example.com", "c.example.com"].sort());
  });
});

describe("formatIngressRule", () => {
  it("renders host, path and backend", () => {
    expect(
      formatIngressRule({ host: "app.example.com", path: "/api", pathType: "Prefix", backend: "svc:80" }),
    ).toBe("app.example.com/api -> svc:80");
  });

  it("uses a wildcard host and root path when missing", () => {
    expect(formatIngressRule({ host: null, path: "", pathType: null, backend: "svc:80" })).toBe("*/ -> svc:80");
  });
});

describe("requiresTypedDeleteConfirm", () => {
  it("always requires typing for deployments", () => {
    expect(requiresTypedDeleteConfirm("deployment", "default")).toBe(true);
    expect(requiresTypedDeleteConfirm("deployment", "kube-system")).toBe(true);
  });

  it("requires typing for statefulsets and daemonsets", () => {
    expect(requiresTypedDeleteConfirm("statefulset", "default")).toBe(true);
    expect(requiresTypedDeleteConfirm("daemonset", "default")).toBe(true);
  });

  it("requires typing for anything in kube-system", () => {
    expect(requiresTypedDeleteConfirm("pod", "kube-system")).toBe(true);
    expect(requiresTypedDeleteConfirm("configmap", "kube-system")).toBe(true);
    expect(requiresTypedDeleteConfirm("secret", "kube-system")).toBe(true);
  });

  it("does not require typing for ordinary namespaced objects elsewhere", () => {
    expect(requiresTypedDeleteConfirm("pod", "default")).toBe(false);
    expect(requiresTypedDeleteConfirm("service", "default")).toBe(false);
    expect(requiresTypedDeleteConfirm("ingress", null)).toBe(false);
  });
});
