import { describe, expect, it } from "vitest";
import { parseColor } from "@/lib/wclParseColor";

describe("parseColor", () => {
  it("maps each WCL percentile band to its known color", () => {
    expect(parseColor(0)).toBe("#666666"); // grey
    expect(parseColor(24)).toBe("#666666"); // grey
    expect(parseColor(25)).toBe("#1eff00"); // green
    expect(parseColor(49)).toBe("#1eff00"); // green
    expect(parseColor(50)).toBe("#0070ff"); // blue
    expect(parseColor(74)).toBe("#0070ff"); // blue
    expect(parseColor(75)).toBe("#a335ee"); // purple
    expect(parseColor(94)).toBe("#a335ee"); // purple
    expect(parseColor(95)).toBe("#ff8000"); // orange
    expect(parseColor(98)).toBe("#ff8000"); // orange
    expect(parseColor(99)).toBe("#e268a8"); // pink
    expect(parseColor(100)).toBe("#e5cc80"); // gold
  });
});
