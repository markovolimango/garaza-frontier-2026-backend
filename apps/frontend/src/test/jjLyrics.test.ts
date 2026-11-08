import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publish } from "@/signals/bus";
import { JJ_SAMPLE_LINES, useJjLyrics } from "@/signals/useJjLyrics";

afterEach(() => {
  publish("jjLine", "");
  vi.useRealTimers();
});

describe("JJ line playback", () => {
  it("loops through three sample lines", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(useJjLyrics);
    expect(result.current.line).toBe(JJ_SAMPLE_LINES[0]);
    for (const index of [1, 2, 0]) {
      act(() => vi.advanceTimersByTime(3500));
      expect(result.current.line).toBe(JJ_SAMPLE_LINES[index]);
    }
    unmount();
  });

  it("accepts one incoming line at a time and stops the demo", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(useJjLyrics);
    act(() => publish("jjLine", "First incoming line"));
    expect(result.current.line).toBe("First incoming line");
    act(() => vi.advanceTimersByTime(10500));
    expect(result.current.line).toBe("First incoming line");
    act(() => publish("jjLine", "Second incoming line"));
    expect(result.current.line).toBe("Second incoming line");
    expect(result.current.previous).toBe("First incoming line");
    unmount();
  });
});