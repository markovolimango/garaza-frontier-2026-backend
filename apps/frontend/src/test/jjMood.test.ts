import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { getLast, publish } from "@/signals/bus";
import { moodColor, moodLabel, moodOrbPalette } from "@/signals/mood";
import { useJjMood } from "@/signals/useJjMood";

describe("jjMood color scale", () => {
  it("is red at 0 and green at 1", () => {
    expect(moodColor(0)).toBe("oklch(0.72 0.19 20)");
    expect(moodColor(1)).toBe("oklch(0.72 0.19 145)");
    expect(moodLabel(0)).toBe("red");
    expect(moodLabel(1)).toBe("green");
  });

  it("clamps values outside the scale", () => {
    expect(moodColor(-2)).toBe(moodColor(0));
    expect(moodColor(5)).toBe(moodColor(1));
  });
});

describe("useJjMood", () => {
  it("takes the color once on load and ignores later changes", () => {
    publish("jjMood", 0.2);

    const first = renderHook(() => useJjMood());
    expect(first.result.current).toBe(0.2);
    expect(getLast("jjMoodSampled")).toBe(0.2);

    // The variable keeps drifting while the screen is open; JJ must not follow.
    publish("jjMood", 0.9);
    expect(first.result.current).toBe(0.2);
    expect(getLast("jjMoodSampled")).toBe(0.2);

    first.unmount();

    // A fresh load picks up whatever the variable holds then.
    const second = renderHook(() => useJjMood());
    expect(second.result.current).toBe(0.9);
    expect(getLast("jjMoodSampled")).toBe(0.9);
    second.unmount();
  });

  it("applies the debug-selected color on remount, not before", () => {
    publish("jjMood", 0.2);
    const first = renderHook(() => useJjMood());
    publish("jjMood", 1);
    expect(first.result.current).toBe(0.2);
    first.unmount();
    const reloaded = renderHook(() => useJjMood());
    expect(reloaded.result.current).toBe(1);
    expect(getLast("jjMoodSampled")).toBe(1);
    reloaded.unmount();
  });
});

describe("moodOrbPalette", () => {
  const hue = (oklch: string) => Number(oklch.match(/oklch\([^)]*?\s([\d.]+)\)/)?.[1]);

  it("is a red family at 0 and a green family at 1", () => {
    const red = moodOrbPalette(0);
    const green = moodOrbPalette(1);
    for (const key of ["a", "b", "c", "hi"] as const) {
      expect(hue(red[key])).toBeLessThan(45);
      expect(hue(green[key])).toBeGreaterThan(140);
    }
  });

  it("sits on amber in the middle", () => {
    const mid = moodOrbPalette(0.5);
    expect(hue(mid.a)).toBeGreaterThan(45);
    expect(hue(mid.a)).toBeLessThan(110);
  });
});
