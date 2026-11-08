import { publish, type FeedbackColor } from "../bus";
import { clamp01 } from "../mood";
import type { SignalSource } from "./types";

const COLORS: FeedbackColor[] = ["red", "green", "neutral"];

export class MockSource implements SignalSource {
  private orbTimer: ReturnType<typeof setInterval> | null = null;
  private fbTimer: ReturnType<typeof setTimeout> | null = null;
  private moodTimer: ReturnType<typeof setInterval> | null = null;
  private level = 0.5;
  private velocity = 0;
  // Starts somewhere on the scale so the first screen doesn't always wear the same color.
  private mood = Math.random();
  private paused = false;

  constructor() {
    // Seed the channel so a screen that loads before the first tick still gets a color.
    publish("jjMood", this.mood);
  }

  start() {
    if (this.orbTimer) return;
    // Smooth random walk at ~20 Hz
    this.orbTimer = setInterval(() => {
      if (this.paused) return;
      this.velocity = this.velocity * 0.85 + (Math.random() - 0.5) * 0.04;
      this.level += this.velocity;
      if (this.level < 0) {
        this.level = 0;
        this.velocity = Math.abs(this.velocity);
      } else if (this.level > 1) {
        this.level = 1;
        this.velocity = -Math.abs(this.velocity);
      }
      publish("orbLevel", this.level);
    }, 50);
    // Mood drifts slowly — it is meant to be read once per screen load, not followed.
    this.moodTimer = setInterval(() => {
      if (this.paused) return;
      this.mood = clamp01(this.mood + (Math.random() - 0.5) * 0.16);
      publish("jjMood", this.mood);
    }, 1200);
    this.scheduleFeedback();
  }

  private scheduleFeedback() {
    this.fbTimer = setTimeout(() => {
      if (!this.paused) {
        publish("feedback", {
          color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
          intensity: Math.random(),
        });
      }
      this.scheduleFeedback();
    }, 2000 + Math.random() * 2000);
  }

  stop() {
    if (this.orbTimer) clearInterval(this.orbTimer);
    if (this.fbTimer) clearTimeout(this.fbTimer);
    if (this.moodTimer) clearInterval(this.moodTimer);
    this.orbTimer = null;
    this.fbTimer = null;
    this.moodTimer = null;
  }

  setPaused(p: boolean) {
    this.paused = p;
  }

  isPaused() {
    return this.paused;
  }
}
