import { describe, expect, it, vi } from "vitest";
import { publish, subscribe } from "@/signals/bus";
import { judgesMode } from "@/signals/judges";

describe("Judges integration", () => {
  it("uses mock voices without a backend by default", () => {
    expect(judgesMode("")).toBe("mock");
    expect(judgesMode("?source=mock")).toBe("mock");
  });
  it("allows explicitly connecting the brain", () => {
    expect(judgesMode("?source=backend&brain=ws://localhost:8787")).toBe("backend");
  });
  it("delivers per-judge speech and reactions and disconnects on exit", () => {
    const handler = vi.fn();
    const unsubscribe = subscribe("judgeCommand", handler);
    publish("judgeCommand", { type: "say", judge: 3, text: "Who pays?" });
    expect(handler).toHaveBeenLastCalledWith({ type: "say", judge: 3, text: "Who pays?" });
    publish("judgeCommand", { type: "react", judge: 0, reaction: "nod" });
    expect(handler).toHaveBeenLastCalledWith({ type: "react", judge: 0, reaction: "nod" });
    unsubscribe();
    publish("judgeCommand", { type: "react", judge: 0, reaction: "idle" });
    expect(handler).toHaveBeenCalledTimes(2);
  });
});