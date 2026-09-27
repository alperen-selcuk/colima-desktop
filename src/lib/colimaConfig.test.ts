import { describe, expect, it } from "vitest";
import upstreamDefaultYaml from "../../src-tauri/resources/colima-default.yaml?raw";
import {
  getDockerConfig,
  getFullConfig,
  getIn,
  getKubernetes,
  getMounts,
  getNetwork,
  getProvision,
  getStringList,
  getStringMap,
  parseConfig,
  setDockerConfig,
  setIn,
  setMounts,
  setProvision,
  setStringList,
  setStringMap,
  stringifyConfig,
} from "./colimaConfig";

function commentLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("#"));
}

describe("round-trip", () => {
  it("keeps every comment line of the real upstream template", () => {
    const doc = parseConfig(upstreamDefaultYaml);
    const out = stringifyConfig(doc);
    expect(commentLines(out)).toEqual(commentLines(upstreamDefaultYaml));
  });

  it("keeps every comment line after an edit", () => {
    const doc = parseConfig(upstreamDefaultYaml);
    setIn(doc, ["cpu"], 8);
    setIn(doc, ["kubernetes", "enabled"], true);
    const out = stringifyConfig(doc);
    expect(commentLines(out)).toEqual(commentLines(upstreamDefaultYaml));
    expect(out).toContain("cpu: 8");
  });

  it("preserves unknown/older-version keys verbatim", () => {
    const src = "cpu: 2\nsomeFutureKey: true\nnested:\n  another: 1\n";
    const doc = parseConfig(src);
    setIn(doc, ["cpu"], 4);
    const out = stringifyConfig(doc);
    expect(out).toContain("someFutureKey: true");
    expect(out).toContain("another: 1");
  });
});

describe("scalar getters against the real template", () => {
  const doc = parseConfig(upstreamDefaultYaml);

  it("reads top-level scalars", () => {
    expect(getIn(doc, ["cpu"], 0)).toBe(2);
    expect(getIn(doc, ["disk"], 0)).toBe(100);
    expect(getIn(doc, ["memory"], 0)).toBe(2);
    expect(getIn(doc, ["arch"], "")).toBe("host");
    expect(getIn(doc, ["runtime"], "")).toBe("docker");
    expect(getIn(doc, ["vmType"], "")).toBe("qemu");
    expect(getIn(doc, ["mountType"], "")).toBe("sshfs");
  });

  it("falls back for a key the template's version predates", () => {
    const older = "cpu: 2\n"; // no modelRunner/rootDisk/portForwarder
    const olderDoc = parseConfig(older);
    expect(getIn(olderDoc, ["modelRunner"], "docker")).toBe("docker");
    expect(getIn(olderDoc, ["rootDisk"], 20)).toBe(20);
    expect(getIn(olderDoc, ["portForwarder"], "ssh")).toBe("ssh");
  });
});

describe("kubernetes.enabled / k3sArgs", () => {
  it("sets enabled and reads it back", () => {
    const doc = parseConfig(upstreamDefaultYaml);
    setIn(doc, ["kubernetes", "enabled"], true);
    expect(getKubernetes(doc).enabled).toBe(true);
    expect(stringifyConfig(doc)).toContain("enabled: true");
  });

  it("reads default k3sArgs from the template", () => {
    const doc = parseConfig(upstreamDefaultYaml);
    expect(getStringList(doc, ["kubernetes", "k3sArgs"])).toEqual(["--disable=traefik"]);
  });

  it("sets k3sArgs as a block list", () => {
    const doc = parseConfig(upstreamDefaultYaml);
    setStringList(doc, ["kubernetes", "k3sArgs"], [
      "--disable=traefik",
      "--disable=servicelb",
      "--disable=metrics-server",
    ]);
    const out = stringifyConfig(doc);
    expect(getStringList(doc, ["kubernetes", "k3sArgs"])).toEqual([
      "--disable=traefik",
      "--disable=servicelb",
      "--disable=metrics-server",
    ]);
    expect(out).toContain("- --disable=traefik");
    expect(out).toContain("- --disable=servicelb");
  });
});

describe("network.dns", () => {
  it("sets a list of IPs and reads it back", () => {
    const doc = parseConfig(upstreamDefaultYaml);
    setStringList(doc, ["network", "dns"], ["8.8.8.8", "1.1.1.1"]);
    expect(getNetwork(doc).dns).toEqual(["8.8.8.8", "1.1.1.1"]);
  });

  it("creates network.dns when starting from a doc missing the key entirely", () => {
    const doc = parseConfig("cpu: 2\n");
    setStringList(doc, ["network", "dns"], ["8.8.8.8"]);
    expect(getStringList(doc, ["network", "dns"])).toEqual(["8.8.8.8"]);
    expect(stringifyConfig(doc)).toContain("network:");
  });
});

describe("mounts", () => {
  it("reads the template's empty mounts list", () => {
    const doc = parseConfig(upstreamDefaultYaml);
    expect(getMounts(doc)).toEqual([]);
  });

  it("sets mount rows and reads them back with mountPoint omitted when empty", () => {
    const doc = parseConfig(upstreamDefaultYaml);
    setMounts(doc, [
      { location: "~/projects", mountPoint: "", writable: true },
      { location: "~/secrets", mountPoint: "/mnt/secrets", writable: false },
    ]);
    const rows = getMounts(doc);
    expect(rows).toEqual([
      { location: "~/projects", mountPoint: "", writable: true },
      { location: "~/secrets", mountPoint: "/mnt/secrets", writable: false },
    ]);
    const out = stringifyConfig(doc);
    expect(out).toContain("- location: ~/projects");
    expect(out).not.toContain("mountPoint: ''");
  });
});

describe("provision", () => {
  it("sets provision rows including a multi-line script", () => {
    const doc = parseConfig(upstreamDefaultYaml);
    setProvision(doc, [
      { mode: "system", script: "apt-get install htop" },
      { mode: "user", script: "echo one\necho two\n" },
    ]);
    const rows = getProvision(doc);
    expect(rows[0]).toEqual({ mode: "system", script: "apt-get install htop" });
    expect(rows[1].mode).toBe("user");
    expect(rows[1].script).toContain("echo one");
    expect(rows[1].script).toContain("echo two");
  });
});

describe("env", () => {
  it("sets env vars as a block map", () => {
    const doc = parseConfig(upstreamDefaultYaml);
    setStringMap(doc, ["env"], { FOO: "bar", BAZ: "qux" });
    expect(getStringMap(doc, ["env"])).toEqual({ FOO: "bar", BAZ: "qux" });
    const out = stringifyConfig(doc);
    expect(out).toContain("FOO: bar");
    expect(out).toContain("BAZ: qux");
  });

  it("creates env when missing from an older/minimal file", () => {
    const doc = parseConfig("cpu: 2\n");
    setStringMap(doc, ["env"], { KEY: "value" });
    expect(getStringMap(doc, ["env"])).toEqual({ KEY: "value" });
  });
});

describe("docker (daemon.json map)", () => {
  it("sets an arbitrary nested docker config and reads it back as JSON-able object", () => {
    const doc = parseConfig(upstreamDefaultYaml);
    setDockerConfig(doc, {
      "insecure-registries": ["myregistry.com:5000"],
      features: { buildkit: false },
    });
    const cfg = getDockerConfig(doc);
    expect(cfg["insecure-registries"]).toEqual(["myregistry.com:5000"]);
    expect(cfg.features).toEqual({ buildkit: false });
  });
});

describe("creating keys absent from an older (0.8.1) template", () => {
  it("inserts modelRunner, rootDisk, portForwarder sensibly", () => {
    const older = [
      "cpu: 2",
      "disk: 40",
      "memory: 3",
      "arch: aarch64",
      "runtime: docker",
      "hostname: colima",
      "kubernetes:",
      "  enabled: false",
      "  version: v1.30.0+k3s1",
      "",
    ].join("\n");
    const doc = parseConfig(older);
    expect(getIn(doc, ["modelRunner"], "docker")).toBe("docker"); // fallback, key absent
    setIn(doc, ["modelRunner"], "ramalama");
    setIn(doc, ["rootDisk"], 30);
    setIn(doc, ["portForwarder"], "grpc");
    const out = stringifyConfig(doc);
    expect(out).toContain("modelRunner: ramalama");
    expect(out).toContain("rootDisk: 30");
    expect(out).toContain("portForwarder: grpc");
    // Existing keys/values remain untouched.
    expect(out).toContain("cpu: 2");
    expect(out).toContain("arch: aarch64");
  });
});

describe("getFullConfig", () => {
  it("returns every section for the real template", () => {
    const doc = parseConfig(upstreamDefaultYaml);
    const full = getFullConfig(doc);
    expect(full.resources.cpu).toBe(2);
    expect(full.runtime.runtime).toBe("docker");
    expect(full.kubernetes.k3sArgs).toEqual(["--disable=traefik"]);
    expect(full.vm.vmType).toBe("qemu");
    expect(full.network.gatewayAddress).toBe("192.168.5.2");
    expect(full.mounts.mountType).toBe("sshfs");
    expect(full.ssh.sshPort).toBe(0);
    expect(full.env).toEqual({});
    expect(full.docker).toEqual({});
    expect(full.provision).toEqual([]);
  });
});
