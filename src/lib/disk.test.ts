import { describe, expect, it } from "vitest";
import { isDiskShrink, reclaimResultMessage, shrinkMessage } from "./disk";

describe("disk helpers", () => {
  it("detects shrink only when smaller", () => {
    expect(isDiskShrink(10, 40)).toBe(true);
    expect(isDiskShrink(40, 40)).toBe(false);
    expect(isDiskShrink(60, 40)).toBe(false);
    expect(isDiskShrink(10, null)).toBe(false);
  });
  it("formats the shrink message", () => {
    expect(shrinkMessage(40)).toBe(
      "A VM disk can't be shrunk (current size 40 GiB). Recreate the machine to use a smaller disk.",
    );
  });
  it("reports freed space or no change", () => {
    const GiB = 1024 ** 3;
    expect(reclaimResultMessage(10 * GiB, 7 * GiB)).toBe("Freed 3.00 GiB on your Mac");
    expect(reclaimResultMessage(10 * GiB, 10 * GiB)).toContain("didn't shrink");
    expect(reclaimResultMessage(null, 1)).toBe("Reclaim finished");
  });
});
