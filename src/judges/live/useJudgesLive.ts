/**
 * Wires the brain (or the speech fallback) to a JudgesScene.
 *   ?source=backend (default) | mock      ?brain=ws://host:port (default ws://127.0.0.1:8787)
 * backend: actor.say -> subtitle + talking, glow/head bob from that source's live audio level,
 *          stops when the utterance's audio queue drains. actor.gesture -> react().
 * mock, or backend unreachable: local Say uses WebSpeechVoice.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { JudgeIndex, JudgeReaction, JudgesHandle } from "../types";
import { AudioPlayer } from "./AudioPlayer";
import { BackendSource, type ActorGesture, type ActorSay, type BackendGesture, type BackendStatus } from "./BackendSource";
import { WebSpeechVoice } from "./WebSpeechVoice";

export type LiveMode = "backend" | "mock";

export const GESTURE_TO_REACTION: Record<BackendGesture, JudgeReaction> = {
  idle: "idle",
  nod: "nod",
  cross_arms: "disapprove",
  note: "texting",
  check_watch: "texting",
  lean_in: "think",
  talk: "talking",
  shift: "idle-alt",
  lean_back: "idle-alt",
};

const DEFAULT_BRAIN = "ws://127.0.0.1:8787";
/** If actor.say arrives but no audio starts within this window, show a timed subtitle instead. */
const NO_AUDIO_MS = 2500;
const UNREACHABLE_MS = 3000;

export function readLiveParams(): { mode: LiveMode; url: string } {
  const q = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  return { mode: q.get("source") === "mock" ? "mock" : "backend", url: q.get("brain") ?? DEFAULT_BRAIN };
}

const judgeIndex = (actorId: string): JudgeIndex | null => {
  const m = /^judge_([1-4])$/.exec(actorId);
  return m ? ((Number(m[1]) - 1) as JudgeIndex) : null;
};

interface PendingSay {
  judge: JudgeIndex;
  text: string;
  utteranceId: string;
  source: number;
  fallback: ReturnType<typeof setTimeout>;
}

export function useJudgesLive(judges: RefObject<JudgesHandle | null>, mode: LiveMode, url: string) {
  const [status, setStatus] = useState<BackendStatus | "off">(mode === "backend" ? "connecting" : "off");
  const [audioOn, setAudioOn] = useState(false);
  const [unreachable, setUnreachable] = useState(mode === "mock");
  const player = useRef<AudioPlayer | null>(null);
  const backend = useRef<BackendSource | null>(null);
  const voice = useRef<WebSpeechVoice | null>(null);

  // per source: says waiting for audio, audio waiting for a say, and the live binding
  const pending = useRef(new Map<number, PendingSay[]>());
  const unboundSeq = useRef(new Map<number, number>());
  const live = useRef(new Map<string, { stop: () => void; utteranceId: string }>()); // key `${source}:${seq}`

  const bind = useCallback(
    (source: number, seq: number, say: PendingSay) => {
      clearTimeout(say.fallback);
      const p = player.current;
      const stop = judges.current?.speak(say.judge, say.text, () => p?.level(source) ?? 0) ?? (() => {});
      live.current.set(`${source}:${seq}`, { stop, utteranceId: say.utteranceId });
      backend.current?.playback(source, say.utteranceId, "started");
    },
    [judges],
  );

  const onSay = useCallback(
    (p: ActorSay) => {
      const judge = judgeIndex(p.actorId);
      if (judge === null) return;
      if (!player.current) {
        judges.current?.say(judge, p.text); // audio locked: timed subtitle only
        return;
      }
      const say: PendingSay = {
        judge,
        text: p.text,
        utteranceId: p.utteranceId,
        source: p.source,
        fallback: setTimeout(() => {
          const q = pending.current.get(p.source);
          const i = q?.indexOf(say) ?? -1;
          if (q && i >= 0) q.splice(i, 1);
          judges.current?.say(judge, p.text);
        }, NO_AUDIO_MS),
      };
      const seq = unboundSeq.current.get(p.source);
      if (seq !== undefined) {
        unboundSeq.current.delete(p.source);
        bind(p.source, seq, say);
      } else {
        const q = pending.current.get(p.source) ?? [];
        q.push(say);
        pending.current.set(p.source, q);
      }
    },
    [judges, bind],
  );

  const onGesture = useCallback(
    (g: ActorGesture) => {
      const judge = judgeIndex(g.actorId);
      const reaction = GESTURE_TO_REACTION[g.gesture];
      if (judge === null || !reaction) return;
      judges.current?.react(judge, reaction);
      if (g.durationMs && (reaction === "talking" || reaction === "texting" || reaction === "idle-alt"))
        setTimeout(() => judges.current?.react(judge, "idle"), g.durationMs);
    },
    [judges],
  );

  // Backend connection (no AudioContext needed to connect; audio attaches when enabled).
  useEffect(() => {
    if (mode !== "backend") return;
    const b = new BackendSource(url, () => player.current, {
      onSay,
      onGesture,
      onStatus: (s) => {
        setStatus(s);
        if (s === "open") setUnreachable(false);
      },
    }).connect();
    backend.current = b;
    const t = setTimeout(() => b.status !== "open" && setUnreachable(true), UNREACHABLE_MS);
    return () => {
      clearTimeout(t);
      b.close();
      backend.current = null;
    };
  }, [mode, url, onSay, onGesture]);

  const enableAudio = useCallback(async () => {
    if (!player.current) {
      const p = new AudioPlayer();
      p.onUtteranceStart = (source, seq) => {
        const say = pending.current.get(source)?.shift();
        if (say) bind(source, seq, say);
        else unboundSeq.current.set(source, seq);
      };
      p.onUtteranceDrained = (source, seq) => {
        const key = `${source}:${seq}`;
        const l = live.current.get(key);
        if (unboundSeq.current.get(source) === seq) unboundSeq.current.delete(source);
        if (!l) return;
        live.current.delete(key);
        l.stop();
        backend.current?.playback(source, l.utteranceId, "ended");
      };
      player.current = p;
    }
    if (!voice.current) voice.current = new WebSpeechVoice();
    await player.current.resume();
    setAudioOn(player.current.ctx.state === "running");
  }, [bind]);

  useEffect(
    () => () => {
      player.current?.close();
      voice.current?.cancel();
    },
    [],
  );

  /** Local test line through the speech fallback (works without the backend). */
  const sayLocal = useCallback(
    (judge: JudgeIndex, text: string) => {
      const v = voice.current;
      if (!v || !WebSpeechVoice.available()) return judges.current?.say(judge, text);
      const stop = judges.current?.speak(judge, text, () => v.level(judge)) ?? (() => {});
      const guard = setTimeout(stop, text.split(/\s+/).length * 900 + 3000);
      void v.speak(judge, text).then(() => {
        clearTimeout(guard);
        stop();
      });
    },
    [judges],
  );

  return { status, audioOn, unreachable, enableAudio, sayLocal, mode };
}
