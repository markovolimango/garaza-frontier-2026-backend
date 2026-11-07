import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ALL_DOWNLINK_TYPES, ALL_UPLINK_TYPES, AUDIO_FLAG, DOWNLINK, GREYBOX_VENUE, ToolArgs, UPLINK, UPLINK_SENDERS,
  VenueDef, decodeAudioFrame, encodeAudioFrame, micFrameToPcm, parseDownlink, parseUplink,
} from "../src/index.ts";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/messages");
type Fixture = { type: string; direction: "up" | "down"; valid: unknown[]; invalid: { why: string; message: unknown }[] };
const fixtures: Fixture[] = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));

describe("protocol schemas", () => {
  it("every message type has a fixture file with at least one valid and one invalid sample", () => {
    const down = fixtures.filter((f) => f.direction === "down").map((f) => f.type).sort();
    const up = fixtures.filter((f) => f.direction === "up").map((f) => f.type).sort();
    expect(down).toEqual([...ALL_DOWNLINK_TYPES].sort());
    expect(up).toEqual([...ALL_UPLINK_TYPES].sort());
    for (const f of fixtures) { expect(f.valid.length, f.type).toBeGreaterThan(0); expect(f.invalid.length, f.type).toBeGreaterThan(0); }
  });

  for (const f of fixtures) {
    const parse = f.direction === "up" ? parseUplink : parseDownlink;
    it(`${f.direction} ${f.type}: valid samples parse, invalid ones are rejected`, () => {
      for (const v of f.valid) {
        const r = parse(v);
        expect(r.ok, r.ok ? "" : r.message).toBe(true);
        expect(parse(JSON.stringify(v)).ok).toBe(true);
      }
      for (const bad of f.invalid) {
        const r = parse(bad.message);
        expect(r.ok, `should reject: ${bad.why}`).toBe(false);
        if (!r.ok) { expect(r.code).toBe("invalid_message"); expect(r.refId).toBeDefined(); }
      }
    });
  }

  it("rejects bad envelopes, unknown types and other protocol versions", () => {
    expect(parseUplink("{nope")).toMatchObject({ ok: false, code: "invalid_message" });
    expect(parseUplink({ v: 1, type: "ptt", ts: 1, payload: { down: true } })).toMatchObject({ ok: false, code: "invalid_message" });
    expect(parseUplink({ v: 1, type: "scene.apply", id: "a", ts: 1, payload: {} })).toMatchObject({ ok: false, code: "invalid_message", refId: "a" });
    expect(parseUplink({ v: 2, type: "hello", id: "a", ts: 1, payload: {} })).toMatchObject({ ok: false, code: "protocol_mismatch" });
  });

  it("every uplink type has a sender list", () => {
    expect(Object.keys(UPLINK_SENDERS).sort()).toEqual(Object.keys(UPLINK).sort());
  });

  it("all schemas convert to JSON Schema (for docs and the operator panel)", () => {
    for (const s of [...Object.values(DOWNLINK), ...Object.values(UPLINK), ...Object.values(ToolArgs)]) expect(() => z.toJSONSchema(s as z.ZodType, { unrepresentable: "any" })).not.toThrow();
  });

  it("the greybox venue is valid; a venue without seats is not", () => {
    expect(VenueDef.safeParse(GREYBOX_VENUE).success).toBe(true);
    const { judge_seat_3: _, ...anchors } = GREYBOX_VENUE.anchors;
    expect(VenueDef.safeParse({ ...GREYBOX_VENUE, anchors }).success).toBe(false);
  });
});

describe("audio framing", () => {
  it("round-trips header and PCM", () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768]);
    const bytes = encodeAudioFrame(2, AUDIO_FLAG.utteranceStart, 0x1_0005, pcm);
    expect([...bytes.slice(0, 4)]).toEqual([2, 1, 5, 0]);
    const f = decodeAudioFrame(bytes);
    expect(f).toMatchObject({ source: 2, flags: 1, seq: 5 });
    expect([...f.pcm]).toEqual([...pcm]);
    expect(decodeAudioFrame(encodeAudioFrame(0, AUDIO_FLAG.utteranceEnd, 1, new Int16Array(0))).pcm).toHaveLength(0);
  });

  it("reads mic frames at odd offsets", () => {
    const buf = new Uint8Array(5); buf.set([0, 0x34, 0x12, 0xff, 0xff], 0);
    expect([...micFrameToPcm(buf.subarray(1))]).toEqual([0x1234, -1]);
  });
});
