import { publish } from "../bus";
import { clamp01 } from "../mood";
import type { SignalSource } from "./types";

/**
 * Placeholder for the real data source.
 * TODO: confirm the server URL and message format.
 * TODO: reconnect with backoff on close.
 * TODO: validate incoming payloads before publishing.
 */
export class WebSocketSource implements SignalSource {
  private ws: WebSocket | null = null;
  constructor(private url: string) {}

  start() {
    // TODO: enable once the backend exists.
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string);
        // TODO: expected shape { channel: "orbLevel" | "feedback", value: ... }
        if (msg.channel === "orbLevel") publish("orbLevel", Number(msg.value));
        if (msg.channel === "feedback") publish("feedback", msg.value);
        if (msg.channel === "jjMood") publish("jjMood", clamp01(Number(msg.value)));
      } catch {
        // TODO: log malformed messages
      }
    };
  }

  stop() {
    this.ws?.close();
    this.ws = null;
  }
}
