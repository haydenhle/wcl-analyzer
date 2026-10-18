import { describe, expect, it } from "vitest";
import { classColor, classDisplayName, normalizeClassName } from "@/lib/wowClassColors";

describe("normalizeClassName", () => {
  it("strips spaces/dashes and capitalizes the first letter", () => {
    expect(normalizeClassName("Death Knight")).toBe("DeathKnight");
    expect(normalizeClassName("death-knight")).toBe("DeathKnight");
    expect(normalizeClassName("DeathKnight")).toBe("DeathKnight");
  });
});

describe("classColor", () => {
  it("resolves a known class to its Blizzard hex color", () => {
    expect(classColor("Mage")).toBe("#69CCF0");
    expect(classColor("Death Knight")).toBe("#C41F3B");
  });

  it("falls back to a neutral color for unknown/missing input", () => {
    expect(classColor("SomeFutureClass")).toBe("#6b7280");
    expect(classColor(undefined)).toBe("#6b7280");
    expect(classColor(null)).toBe("#6b7280");
  });
});

describe("classDisplayName", () => {
  it("splits a two-word class name for display", () => {
    expect(classDisplayName("DeathKnight")).toBe("Death Knight");
    expect(classDisplayName("DemonHunter")).toBe("Demon Hunter");
  });

  it("passes single-word classes through unchanged", () => {
    expect(classDisplayName("Druid")).toBe("Druid");
  });
});
