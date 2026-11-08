"""Hardware-free simulated session (no Apple devices, no model downloads).

Every event is marked source.simulated = true and the session is created with simulated = true,
so simulated data can never mix with real measurements. The scenario (session-relative seconds):

   0-20  quiet calibration: heart-rate session reference, body visible, no speech
  20-40  normal speech (~135 wpm)
  22-34  fast, continuous hand movement -> body.hand_movement_high
  40-60  faster speech (~205 wpm) -> speech.rate_high suggestion, then cooldown
  40-75  simulated pulse rises above the session reference -> heart.above_reference observation
  60-75  normal speech again (rule clears / re-arms; cooldown visible in the snapshot)
  61-73  walking back and forth -> body.torso_movement_high
  75-80  person leaves the frame -> body.tracking_lost, then recovery
  84-104 Watch unreachable: no samples, heart data goes stale, dependent rule suppressed;
         at 104 queued (old) samples arrive and are stored as late, never as current
 104-114 speech with long pauses -> speech.long_pauses
    116  stop -> summary
Also injected: a duplicate event, an out-of-order frame and a sequence gap.
With --speed > 1 the session uses the event_time timeline (deterministic, faster than real time).
"""

from __future__ import annotations

import asyncio
import json
import math
import random
import time
from dataclasses import dataclass, field
from pathlib import Path

from coach.client import CoachClient, DeviceConnection, operator_token, stream
from coach.timeutil import to_iso

IPHONE_ID, WATCH_ID = "sim-iphone-01", "sim-watch-01"
IPHONE_SKEW_S, WATCH_SKEW_S = 0.120, 0.400     # simulated device clocks run ahead of the server
SCENARIO_END_S = 116.0
DEMO_CONFIG = {
    "speech": {"language": "en-US", "target_wpm_max": 165, "wpm_window_s": 15, "min_words_for_rate": 10,
               "min_speaking_s_for_rate": 4, "long_pause_s": 2.0},
    "heart": {"calibration_s": 20, "min_reference_samples": 5, "rise_threshold_bpm": 12, "clear_margin_bpm": 4,
              "evaluation_window_s": 20, "min_fresh_samples": 3, "fresh_max_age_s": 12},
    "coaching": {"global_min_interval_s": 6, "display_s": 5, "rules": {
        "speech.rate_high": {"sustain_s": 5, "cooldown_s": 30},
        "heart.above_reference": {"sustain_s": 10, "cooldown_s": 60},
        "body.tracking_lost": {"sustain_s": 2.5, "cooldown_s": 20},
        "body.hand_movement_high": {"sustain_s": 5, "cooldown_s": 40},
        "body.torso_movement_high": {"sustain_s": 5, "cooldown_s": 40},
        "speech.long_pauses": {"count": 2, "window_s": 30, "cooldown_s": 40},
        "speech.fillers": {"count": 3, "window_s": 30, "cooldown_s": 40}}},
}
TEXT = ("today I want to walk you through three ideas about how small teams can ship reliable software "
        "first we look at feedback loops then at how we measure progress and finally at what we learned "
        "from running these experiments over the last year with real users and real constraints").split()


@dataclass(order=True)
class Planned:
    t: float                                   # session-relative seconds (virtual)
    order: int
    kind: str = field(compare=False)           # "iphone" | "watch" | "watch_status" | "anomaly"
    event_type: str = field(compare=False)
    payload: dict = field(compare=False)
    captured_rel: float | None = field(default=None, compare=False)  # capture time if different from send time
    tag: str | None = field(default=None, compare=False)


def _pose(t: float, present: bool, rng: random.Random) -> dict:
    if not present:
        return {"mode": "2d", "detector": "simulated", "image": {"width": 1920, "height": 1080, "orientation": "up",
                "mirrored": False, "camera_position": "back"}, "persons_detected": 0, "tracking_state": "no_person",
                "inference_ms": round(16 + rng.random() * 4, 2), "joints_2d": []}
    sway = 0.01 * math.sin(t * 0.7)
    if 61 <= t < 73:
        sway += 0.18 * math.sin((t - 61) * 0.8)        # walking back and forth across the frame
    gesture = 0.05 * math.sin(t * 2.1) if 20 <= t <= 75 else 0.0
    left_wrist, right_wrist = (0.60, 0.56 - gesture), (0.40, 0.56 + gesture / 2)
    if 22 <= t < 34:                                    # fast, continuous hand movement
        left_wrist = (0.60 + 0.06 * math.sin(t * 5), 0.56 - 0.12 * math.sin(t * 5))
        right_wrist = (0.40 - 0.06 * math.sin(t * 5 + 1), 0.56 - 0.12 * math.sin(t * 5 + 1))
    base = {"nose": (0.50, 0.22), "neck": (0.50, 0.31), "left_shoulder": (0.56, 0.33), "right_shoulder": (0.44, 0.33),
            "left_elbow": (0.60, 0.45), "right_elbow": (0.40, 0.45), "left_wrist": left_wrist,
            "right_wrist": right_wrist, "left_hip": (0.54, 0.58), "right_hip": (0.46, 0.58),
            "root": (0.50, 0.58), "left_knee": (0.54, 0.75), "right_knee": (0.46, 0.75)}
    joints = [{"name": name, "x": round(x + sway + rng.gauss(0, 0.002), 4), "y": round(y + rng.gauss(0, 0.002), 4),
               "confidence": round(0.85 + rng.random() * 0.1, 3)} for name, (x, y) in base.items()]
    return {"mode": "2d", "detector": "simulated", "image": {"width": 1920, "height": 1080, "orientation": "up",
            "mirrored": False, "camera_position": "back"}, "persons_detected": 1, "tracking_state": "tracking",
            "inference_ms": round(16 + rng.random() * 4, 2), "joints_2d": joints}


def build_plan(seed: int = 7, pose_hz: float = 12.0) -> list[Planned]:
    rng = random.Random(seed)
    plan: list[Planned] = []
    order = 0

    def add(t, kind, etype, payload, captured_rel=None, tag=None):
        nonlocal order
        order += 1
        plan.append(Planned(round(t, 4), order, kind, etype, payload, captured_rel, tag))

    add(0.0, "iphone", "device.status", {"status": "online", "app_version": "simulator", "pose_mode": "2d",
        "pose_rate_hz": pose_hz, "speech": {"authorized": True, "on_device": True, "locale": "en-US",
        "recognizer": "simulated"}, "watch": {"paired": True, "reachable": True, "authorized": True,
        "collection_mode": "simulated"}, "thermal_state": "nominal"})
    # pose frames
    t = 0.0
    while t < SCENARIO_END_S - 1:
        add(t, "iphone", "pose.frame", _pose(t, not (75 <= t < 80), rng))
        t += 1.0 / pose_hz
    # speech
    word_index = 0

    def utterances(start, end, wpm, pause_s, words_per, fillers=()):
        nonlocal word_index
        t, n = start, 0
        while t < end:
            words = [TEXT[(word_index + i) % len(TEXT)] for i in range(words_per)]
            word_index += words_per
            for position, filler in fillers:
                if n == position:
                    words[3:3] = filler.split()
            duration = len(words) * 60.0 / wpm
            if t + duration > end:
                break
            uid = f"utt-{int(t * 1000)}"
            add(t, "iphone", "speech.activity", {"transition": "speech_start", "vad_method": "simulated_vad",
                "level_dbfs": -24.0, "threshold_dbfs": -42.0, "noise_floor_dbfs": -55.0, "calibrated": True})
            add(t + duration, "iphone", "speech.activity", {"transition": "speech_end", "vad_method": "simulated_vad",
                "level_dbfs": -50.0, "threshold_dbfs": -42.0, "noise_floor_dbfs": -55.0, "calibrated": True})
            step = duration / len(words)
            segments = [{"text": w, "start_s": round(i * step, 3), "duration_s": round(step * 0.9, 3),
                         "confidence": None} for i, w in enumerate(words)]
            common = {"utterance_id": uid, "language": "en-US", "on_device": True, "recognizer": "simulated",
                      "audio_start_at": None}
            half = len(words) // 2
            add(t + duration * 0.55, "iphone", "speech.transcript.partial",
                {**common, "revision": 0, "text": " ".join(words[:half]), "segments": segments[:half]},
                tag=f"audio_start:{t}")
            add(t + duration + 0.35, "iphone", "speech.transcript.final",
                {**common, "revision": 1, "text": " ".join(words), "segments": segments}, tag=f"audio_start:{t}")
            t += duration + pause_s
            n += 1

    utterances(20, 40, 135, 0.7, 10)
    utterances(40, 60, 205, 0.3, 12, fillers=((1, "um"), (3, "you know")))
    utterances(60, 75, 140, 0.7, 10)
    utterances(81, 100, 140, 0.8, 10)
    utterances(104, 114, 140, 2.6, 5)
    # heart rate (simulated Watch, relayed by the simulated iPhone)
    def bpm_at(t):
        if t < 40:
            return 72.0 + (1.0 if t >= 20 else 0.0)
        if t < 60:
            return 73.0 + (t - 40) * 1.1
        if t < 84:
            return 95.0
        return 90.0 - (t - 104) * 0.3
    t = 1.0
    while t < SCENARIO_END_S - 1:
        if not (84 <= t < 104):
            add(t, "watch", "heart_rate.sample", {"bpm": round(bpm_at(t) + rng.gauss(0, 0.8), 1),
                "collection_mode": "simulated", "delivery": "live_message", "availability": "available"})
        t += 2.0
    add(84.0, "iphone", "device.status", {"status": "heartbeat", "watch": {"paired": True, "reachable": False,
        "authorized": True, "collection_mode": "simulated"}, "reason": "simulated Watch disconnect"})
    for measured in (86.0, 88.0, 90.0):  # queued while disconnected, delivered late at 104
        add(104.0, "watch", "heart_rate.sample", {"bpm": round(93.0 + rng.gauss(0, 0.8), 1),
            "collection_mode": "simulated", "delivery": "queued_transfer", "availability": "available"},
            captured_rel=measured)
    add(104.0, "iphone", "device.status", {"status": "heartbeat", "watch": {"paired": True, "reachable": True,
        "authorized": True, "collection_mode": "simulated"}, "reason": "simulated Watch reconnect"})
    # anomalies to exercise de-duplication, ordering and gap detection
    add(30.0, "anomaly", "duplicate", {})
    add(32.0, "anomaly", "out_of_order", {})
    add(35.0, "anomaly", "sequence_gap", {})
    plan.sort()
    return plan


class VirtualClock:
    """Real time until begin(); afterwards time runs `speed` times faster (event_time sessions)."""

    def __init__(self, speed: float):
        self.speed, self.started = speed, False

    def begin(self) -> None:
        self.start, self.m0, self.started = time.time(), time.monotonic(), True

    def now(self) -> float:
        if not self.started:
            return time.time()
        return self.start + (time.monotonic() - self.m0) * self.speed


async def run(base_url: str, *, speed: float = 8.0, export: Path | None = None, quiet: bool = False,
              ca_file: str | None = None, seed: int = 7) -> dict:
    token = operator_token()
    api = CoachClient(base_url, token, ca_file=ca_file)
    timeline = "live" if speed == 1.0 else "event_time"
    code = api.pairing_code()["code"]
    device_token = api.pair(code, IPHONE_ID, "simulator", "Simulated iPhone")["device_token"]
    session = api.create_session(label="simulated presentation practice", simulated=True, timeline=timeline,
                                 mic_source="iphone", config=DEMO_CONFIG)
    sid = session["session_id"]
    clock = VirtualClock(speed)
    phone_clock = lambda: clock.now() + IPHONE_SKEW_S  # noqa: E731
    log = _Printer(quiet)
    log.line(f"session {sid} (simulated, timeline={timeline}, speed x{speed:g})")
    async with DeviceConnection(base_url, device_token, IPHONE_ID, "iphone", simulated=True,
                                device_clock=phone_clock, ca_file=ca_file) as phone:
        estimate = await phone.sync_clock()
        log.line(f"clock handshake: offset {estimate['offset_ms']:+.1f} ms +/- {estimate['uncertainty_ms']:.1f} ms "
                 f"(simulated iPhone clock is {IPHONE_SKEW_S * 1000:+.0f} ms ahead)")
        await phone.join(sid)
        api.action(sid, "start")
        api.calibrate(sid, DEMO_CONFIG["heart"]["calibration_s"])
        clock.begin()
        session_start = clock.now()
        feedback_queue: asyncio.Queue = asyncio.Queue()
        watcher = asyncio.create_task(_watch(base_url, token, sid, session_start, log, feedback_queue, ca_file))
        await asyncio.sleep(0.2)
        plan = build_plan(seed)
        pending_pose: list[dict] = []
        scheduled: list[tuple[float, dict]] = []   # (device time, payload) of playback completions
        sent_for_duplicate: dict | None = None
        index = 0
        snapshot_shown = False
        while index < len(plan):
            rel_now = clock.now() - session_start
            batch: list[dict] = []
            while index < len(plan) and plan[index].t <= rel_now:
                item = plan[index]
                index += 1
                if item.kind == "anomaly":
                    if item.event_type == "duplicate" and sent_for_duplicate:
                        batch.append(sent_for_duplicate)               # identical event_id: must be de-duplicated
                    elif item.event_type == "sequence_gap":
                        phone.sequences[IPHONE_ID] = phone.sequences.get(IPHONE_ID, 0) + 1  # never sent
                    elif item.event_type == "out_of_order":
                        held = next((p for p in plan[index:] if p.event_type == "pose.frame"), None)
                        if held:
                            plan.remove(held)
                            pending_pose.append(_make(phone, sid, held, session_start))
                    continue
                event = _make(phone, sid, item, session_start)
                batch.append(event)
                if item.event_type == "pose.frame" and sent_for_duplicate is None and item.t > 25:
                    sent_for_duplicate = event
            while not feedback_queue.empty():
                started, finished_at = _playback_started(phone, sid, await feedback_queue.get(), clock)
                batch.append(started)
                scheduled.append(finished_at)
            due = [item for item in scheduled if item[0] <= clock.now()]
            for item in due:
                scheduled.remove(item)
                batch.append(phone.event(sid, "audio.playback", item[1], captured_at=item[0]))
            if pending_pose and rel_now > 32.5:
                batch.append(pending_pose.pop())                      # earlier sequence, sent late
            if batch:
                for chunk in (batch[i:i + 100] for i in range(0, len(batch), 100)):
                    await phone.send(chunk)
            if not snapshot_shown and rel_now > 66:
                snapshot_shown = True
                rules = api.snapshot(sid)["coaching"]["rules"]["speech.rate_high"]
                log.at(rel_now, "snapshot", f"speech.rate_high armed={rules['armed']} fired={rules['fired']} "
                                            f"last_fired={rules.get('last_fired_at')} (cooldown 30 s)")
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.3)
        api.action(sid, "stop")
        await asyncio.sleep(0.3)
        watcher.cancel()
    summary = api.summary(sid, narrative=False)
    log.summary(summary)
    if export:
        export.parent.mkdir(parents=True, exist_ok=True)
        api.export(sid, export)
        log.line(f"exported {export}")
    return summary


def _make(phone, sid: str, item: Planned, session_start: float) -> dict:
    captured_rel = item.captured_rel if item.captured_rel is not None else item.t
    payload = dict(item.payload)
    if item.kind == "watch":
        captured = session_start + captured_rel + WATCH_SKEW_S
        payload["measured_at"] = to_iso(captured)
        payload["sample_age_ms_at_send"] = round((item.t - captured_rel) * 1000, 1)
        source = {"device_id": WATCH_ID, "kind": "watch", "simulated": True, "relay_device_id": IPHONE_ID}
        return phone.event(sid, item.event_type, payload, captured_at=captured, source=source)
    if item.tag and item.tag.startswith("audio_start:"):
        payload["audio_start_at"] = to_iso(session_start + float(item.tag.split(":")[1]) + IPHONE_SKEW_S)
    return phone.event(sid, item.event_type, payload, captured_at=session_start + captured_rel + IPHONE_SKEW_S)


def _playback_started(phone: DeviceConnection, sid: str, feedback: dict, clock: VirtualClock):
    """The simulated iPhone 'speaks' the suggestion; speech analysis must ignore this interval.
    The 'finished' event is sent later, when (virtual) time reaches the end of playback."""
    start = clock.now() + IPHONE_SKEW_S
    duration = max(1.5, len(feedback["display_text"]) / 16.0)
    pid = f"pb-{feedback['feedback_id'][3:]}"
    base = {"playback_id": pid, "feedback_id": feedback["feedback_id"], "engine": "simulated",
            "language": feedback["language"], "text": feedback["display_text"][:500]}
    started = phone.event(sid, "audio.playback", {**base, "state": "started"}, captured_at=start)
    return started, (start + duration, {**base, "state": "finished"})


async def _watch(base_url, token, sid, session_start, log, feedback_queue, ca_file) -> None:
    last_tracking, last_hr = None, None
    async for msg in stream(base_url, token, session_id=sid, ca_file=ca_file,
                            event_types=["session.*", "coaching.*", "heart_rate.state", "system.warning",
                                         "body.metrics", "audio.playback", "device.status"]):
        if msg.get("type") != "event":
            continue
        event = msg["event"]
        from datetime import datetime
        t = datetime.fromisoformat(event["timing"]["corrected_captured_at"].replace("Z", "+00:00")).timestamp()
        rel = t - session_start
        etype, p = event["event_type"], event["payload"]
        if etype == "coaching.feedback":
            await feedback_queue.put(p)
            log.at(rel, "COACHING", f"[{p['rule_id']}] {p['observation']} -> {p['suggested_action']} "
                                    f"(priority {p['priority']}, cooldown {p['cooldown']['rule_cooldown_s']:.0f} s)")
        elif etype == "body.metrics" and p["tracking_state"] != last_tracking:
            last_tracking = p["tracking_state"]
            log.at(rel, "body", f"tracking_state={p['tracking_state']} quality={p['quality']}")
        elif etype == "heart_rate.state":
            ref = p["reference"]
            key = (p["availability"], ref["status"])
            if key != last_hr:
                last_hr = key
                latest = p["latest"] or {}
                log.at(rel, "heart", f"availability={p['availability']} reference={ref['status']}"
                                     f"{' ' + str(ref['bpm']) + ' bpm' if ref['bpm'] else ''} latest={latest.get('bpm')} "
                                     f"delta={p['delta_from_reference_bpm']}")
        elif etype == "system.warning":
            log.at(rel, "warning", f"{p['code']}: {p['message']}")
        elif etype == "session.state":
            log.at(rel, "session", f"{p['previous']} -> {p['state']}")
        elif etype == "audio.playback" and event["source"]["kind"] != "server":
            note = "speech metrics suppressed meanwhile" if p["state"] == "started" else "speech metrics resume"
            log.at(rel, "playback", f"{p['state']} ({p['engine']}): {note}")


class _Printer:
    def __init__(self, quiet: bool):
        self.quiet = quiet

    def line(self, text: str) -> None:
        if not self.quiet:
            print(text, flush=True)

    def at(self, rel: float, tag: str, text: str) -> None:
        if not self.quiet:
            print(f"  t={rel:6.1f}s  {tag:<9} {text}", flush=True)

    def summary(self, summary: dict) -> None:
        if self.quiet:
            return
        sp, hr, dq = summary["speech"], summary["heart_rate"], summary["data_quality"]
        print("\nSUMMARY (simulated data)")
        print(f"  state={summary['state']} running={summary['running_time_s']} s  sources="
              + ", ".join(f"{s['device_id']}({s['kind']}, simulated={s['simulated']})" for s in summary["sources"]))
        print(f"  speech: {sp['words']} final words, {sp['rate_wpm_session']} wpm while speaking, "
              f"{sp['long_pauses']} long pauses, fillers {sp['fillers']}, VAD={sp['vad_method']}")
        print(f"  body: {summary['body']['frames_with_body']}/{summary['body']['pose_frames']} frames with a body")
        print(f"  heart: reference {hr['reference']['status']} {hr['reference']['bpm']} bpm, {hr['samples']} samples, "
              f"{hr['late_samples']} late; {hr['note']}")
        print(f"  coaching: {summary['coaching']['by_rule']}")
        print(f"  data quality: duplicates={dq['duplicates']} out_of_order={dq['out_of_order']} "
              f"sequence_gaps={dq['sequence_gaps']} late={dq['late']} dropped_pose={dq['dropped_pose_frames']} "
              f"rejected={dq['rejected']}")


def run_in_process(manager, seed: int = 7, start: float = 1_900_000_000.0, pose_hz: float = 12.0):
    """Same scenario without a network or server: deterministic, used by tests and fixtures."""
    from coach.client import EventFactory
    from coach.timeutil import EventTimeClock
    from coach.wire import EventIn

    phone_clock = manager.registry.get(IPHONE_ID, "simulator", True).clock
    import time as _time
    now_ms = _time.time() * 1000  # clock handshake sample: device runs IPHONE_SKEW_S ahead
    phone_clock.add(now_ms + IPHONE_SKEW_S * 1000, now_ms + 1, now_ms + 1,
                    now_ms + IPHONE_SKEW_S * 1000 + 2, _time.time())
    session = manager.create(label="simulated presentation practice (in-process)", mic_source="iphone",
                             timeline="event_time", simulated=True, config=DEMO_CONFIG, clock=EventTimeClock(start))
    session.transition("start")
    session.start_calibration(DEMO_CONFIG["heart"]["calibration_s"])
    factory = EventFactory(IPHONE_ID, "iphone", simulated=True)
    plan = build_plan(seed, pose_hz=pose_hz)
    held: list[dict] = []
    duplicate: dict | None = None
    scheduled: list[tuple[float, dict]] = []
    seen_feedback = 0

    def send(event: dict) -> None:
        session.accept(EventIn.model_validate(event), principal_device=IPHONE_ID, connection_kind="simulator")
        session.process_pending()

    index = 0
    while index < len(plan):
        item = plan[index]
        index += 1
        for due in sorted(d for d in scheduled if d[0] <= start + item.t + IPHONE_SKEW_S):
            scheduled.remove(due)
            send(factory.event(session.id, "audio.playback", due[1], captured_at=due[0]))
        if item.kind == "anomaly":
            if item.event_type == "duplicate" and duplicate:
                send(duplicate)
            elif item.event_type == "sequence_gap":
                factory.sequences[IPHONE_ID] = factory.sequences.get(IPHONE_ID, 0) + 1
            elif item.event_type == "out_of_order":
                frame = next((p for p in plan[index:] if p.event_type == "pose.frame"), None)
                if frame:
                    plan.remove(frame)
                    held.append(_make(factory, session.id, frame, start))
            continue
        event = _make(factory, session.id, item, start)
        send(event)
        if duplicate is None and item.event_type == "pose.frame" and item.t > 25:
            duplicate = event
        if held and item.t > 32.5:
            send(held.pop())
        while seen_feedback < len(session.coach.history):
            feedback = session.coach.history[seen_feedback]
            seen_feedback += 1
            begin = feedback["t"] + IPHONE_SKEW_S
            duration = max(1.5, len(feedback["display_text"]) / 16.0)
            base = {"playback_id": f"pb-{feedback['feedback_id'][3:]}", "feedback_id": feedback["feedback_id"],
                    "engine": "simulated", "language": feedback["language"], "text": feedback["display_text"][:500]}
            send(factory.event(session.id, "audio.playback", {**base, "state": "started"}, captured_at=begin))
            scheduled.append((begin + duration, {**base, "state": "finished"}))
    session.transition("stop")
    return session


def main_sync(base_url: str, speed: float, export: Path | None, quiet: bool, ca_file: str | None) -> dict:
    return asyncio.run(run(base_url, speed=speed, export=export, quiet=quiet, ca_file=ca_file))


if __name__ == "__main__":  # pragma: no cover
    print(json.dumps(main_sync("http://127.0.0.1:8765", 8.0, None, False, None)["coaching"], indent=2))
