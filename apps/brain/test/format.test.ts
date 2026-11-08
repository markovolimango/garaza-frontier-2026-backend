/** Shared helpers: one clock format and one HTML escape for every report, note and page. */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { esc, mmss } from "../src/format.ts";
import { readBody } from "../src/http.ts";

describe("shared helpers", () => {
  it("mmss reads like a clock: whole seconds rounded down, never negative", () => {
    expect(mmss(79_600)).toBe("1:19");
    expect(mmss(80_000)).toBe("1:20");
    expect(mmss(999)).toBe("0:00");
    expect(mmss(-5_000)).toBe("0:00");
    expect(mmss(605_000)).toBe("10:05");
  });

  it("esc escapes HTML", () => {
    expect(esc(`<b class="x">Tom & Jerry's</b>`)).toBe("&lt;b class=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/b&gt;");
    expect(esc(null)).toBe("");
  });

  it("readBody gives the body, or null past the limit", async () => {
    const read = async (chunks: string[], max: number) => {
      const req = new PassThrough();
      const out = readBody(req as never, max);
      for (const c of chunks) req.write(c);
      req.end();
      return out;
    };
    expect(String(await read(["ab", "cd"], 4))).toBe("abcd");
    expect(await read(["ab", "cde"], 4)).toBeNull();
  });
});
