import { describe, expect, it } from "vitest";
import { parseAdvTm } from "@/lib/pptxTimings";

describe("parseAdvTm", () => {
  it("reads advTm milliseconds as seconds", () => {
    expect(parseAdvTm('<p:transition spd="slow" advTm="12500"><p:fade/></p:transition>')).toBe(12.5);
  });
  it("returns null when the slide has no advTm", () => {
    expect(parseAdvTm('<p:transition spd="slow"/>')).toBeNull();
  });
});
