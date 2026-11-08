/** Small HTTP helpers shared by the brain's routes. */
import type { IncomingMessage } from "node:http";

/** The request body as one Buffer; null when it is larger than `maxBytes` (the rest is read and dropped). */
export function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    let n = 0, over = false;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { n += c.length; if (n > maxBytes) over = true; else chunks.push(c); });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
