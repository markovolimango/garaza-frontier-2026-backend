/** Writes fixtures/messages/<direction>.<type>.json from samples.ts. Run: pnpm gen:fixtures */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DOWNLINK_SAMPLES, UPLINK_SAMPLES } from "./samples.ts";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/messages");
mkdirSync(dir, { recursive: true });
for (const f of readdirSync(dir)) if (f.endsWith(".json")) rmSync(join(dir, f));

const env = (type: string, payload: unknown, i: number) => ({ v: 1, type, id: `fx_${type.replace(/\W/g, "_")}_${i}`, ts: 1_762_540_000_000 + i, payload });
let n = 0;
for (const [direction, table] of [["down", DOWNLINK_SAMPLES], ["up", UPLINK_SAMPLES]] as const) {
  for (const [type, s] of Object.entries(table) as [string, { valid: unknown[]; invalid: { why: string; payload: unknown }[] }][]) {
    const file = { type, direction, valid: s.valid.map((p, i) => env(type, p, i)), invalid: s.invalid.map((x, i) => ({ why: x.why, message: env(type, x.payload, 100 + i) })) };
    writeFileSync(join(dir, `${direction}.${type}.json`), JSON.stringify(file, null, 2) + "\n");
    n++;
  }
}
console.log(`wrote ${n} fixture files to ${dir}`);
