import { describe, expect, it } from "vitest";
import { metricForRole, roleForSpec } from "@/lib/wowSpecRoles";

describe("roleForSpec", () => {
  it("knows the three roles across a few different classes", () => {
    expect(roleForSpec("Priest", "Discipline")).toBe("healer");
    expect(roleForSpec("Priest", "Shadow")).toBe("dps");
    expect(roleForSpec("Warrior", "Protection")).toBe("tank");
    expect(roleForSpec("DemonHunter", "Vengeance")).toBe("tank");
    expect(roleForSpec("Druid", "Restoration")).toBe("healer");
  });

  it("falls back to dps for an unrecognized class/spec instead of throwing", () => {
    expect(roleForSpec("NotAClass", "NotASpec")).toBe("dps");
    expect(roleForSpec("Priest", "NotASpec")).toBe("dps");
  });
});

describe("metricForRole", () => {
  it("ranks healers by hps and everyone else (including tanks) by dps", () => {
    expect(metricForRole("healer")).toBe("hps");
    expect(metricForRole("dps")).toBe("dps");
    expect(metricForRole("tank")).toBe("dps");
  });
});
