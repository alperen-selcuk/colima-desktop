import { describe, expect, it } from "vitest";
import { autostopHint } from "./autostop";
import type { AutoStopStatus } from "./types";

const status = (over: Partial<AutoStopStatus>): AutoStopStatus => ({
  profile: "default",
  minutes: 15,
  idleSeconds: 0,
  busyReason: null,
  ...over,
});

describe("autostopHint", () => {
  it("is silent for a stopped machine or without status", () => {
    expect(autostopHint(status({}), false)).toBeNull();
    expect(autostopHint(undefined, true)).toBeNull();
    expect(autostopHint(status({ busyReason: "stopped" }), true)).toBeNull();
  });

  it("shows idle progress in whole minutes", () => {
    expect(autostopHint(status({ idleSeconds: 299 }), true)).toBe("Idle 4 min · stops at 15 min");
  });

  it("explains why the machine is not idle", () => {
    expect(autostopHint(status({ busyReason: "containers" }), true)).toBe("Not idle: containers are running");
    expect(autostopHint(status({ busyReason: "something new" }), true)).toBe("Not idle: something new");
  });
});
