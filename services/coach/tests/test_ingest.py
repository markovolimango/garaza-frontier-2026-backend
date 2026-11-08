from conftest import T0, Device, hr, make_session, pose2d, transcript


def test_duplicates_are_counted_once(manager, clock):
    s = make_session(manager, clock)
    d = Device()
    event = d.ev(s, "pose.frame", pose2d(), T0)
    assert s.accept(event, "phone-1", "iphone")["status"] == "accepted"
    assert s.accept(event, "phone-1", "iphone")["status"] == "duplicate"
    s.process_pending()
    assert s.counters["duplicates"] == 1
    assert sum(1 for e in s.log.all_events() if e["event_type"] == "pose.frame") == 1


def test_sequence_gap_then_out_of_order_fill(manager, clock):
    s = make_session(manager, clock)
    d = Device()
    for seq in (0, 1, 3):
        d.send(s, "pose.frame", pose2d(), T0 + seq * 0.1, seq=seq)
    assert s.counters["sequence_gaps"] == 1
    assert any(e["event_type"] == "system.warning" and e["payload"]["code"] == "sequence_gap"
               for e in s.log.all_events())
    d.send(s, "pose.frame", pose2d(), T0 + 0.2, seq=2)
    assert s.counters["sequence_gaps"] == 0 and s.counters["out_of_order"] == 1
    late = [e for e in s.log.all_events() if e["event_type"] == "pose.frame" and e["sequence"] == 2][0]
    assert late["timing"]["out_of_order"] is True


def test_capture_order_not_arrival_order_for_speech(manager, clock):
    s = make_session(manager, clock)
    d = Device()
    clock.advance(10)
    d.send(s, "speech.activity", {"transition": "speech_end", "vad_method": "v"}, T0 + 6)
    d.send(s, "speech.activity", {"transition": "speech_start", "vad_method": "v"}, T0 + 2)  # arrives later
    assert s.speech.speech_intervals(T0 + 10) == [(T0 + 2, T0 + 6)]


def test_stale_heart_rate_is_flagged_late_and_not_current(manager, clock):
    s = make_session(manager, clock)
    d = Device()
    clock.advance(120)
    watch = {"device_id": "watch-1", "kind": "watch", "simulated": False, "relay_device_id": "phone-1"}
    d.send(s, "heart_rate.sample", hr(80, T0 + 30, delivery="queued_transfer"), T0 + 30, source=watch)
    event = [e for e in s.log.all_events() if e["event_type"] == "heart_rate.sample"][0]
    assert event["timing"]["late"] is True and event["timing"]["clock_basis"] == "none"
    state = s.heart.evaluate(clock.now())
    assert state["latest"] is None and state["availability"] == "no_data"
    assert s.heart.late_samples == 1


def test_simulated_and_real_data_never_mix(manager, clock):
    real = make_session(manager, clock)
    sim = Device("sim-1", "iphone", simulated=True)
    assert sim.send(real, "pose.frame", pose2d(), T0, principal="sim-1", conn="simulator")["code"] == "simulation_mismatch"
    phone = Device("phone-1", "iphone", simulated=True)
    assert phone.send(real, "pose.frame", pose2d(), T0)["code"] == "simulated_flag_not_allowed"
    simulated_session = make_session(manager, clock, simulated=True)
    real_phone = Device("sim-2", "iphone", simulated=False)
    assert real_phone.send(simulated_session, "pose.frame", pose2d(), T0, principal="sim-2",
                           conn="simulator")["code"] == "simulated_flag_required"


def test_source_must_match_credentials_except_relayed_watch(manager, clock):
    s = make_session(manager, clock)
    d = Device("phone-2")
    assert d.send(s, "pose.frame", pose2d(), T0)["code"] == "source_mismatch"
    watch = {"device_id": "watch-1", "kind": "watch", "simulated": False, "relay_device_id": "phone-1"}
    assert Device().send(s, "heart_rate.sample", hr(70, T0), T0, source=watch)["status"] == "accepted"
    unrelayed = {"device_id": "watch-1", "kind": "watch", "simulated": False}
    assert Device().send(s, "heart_rate.sample", hr(70, T0), T0, source=unrelayed)["code"] == "source_mismatch"


def test_single_authoritative_microphone(manager, clock):
    s = make_session(manager, clock, mic="iphone")
    mac = Device("mac-1", "mac")
    assert mac.send(s, "speech.activity", {"transition": "speech_start", "vad_method": "v"}, T0,
                    principal="mac-1", conn="mac")["code"] == "not_authoritative_microphone"
    assert Device().send(s, "speech.transcript.final", transcript("u1", 0, "hello"), T0)["status"] == "accepted"
    other = Device("phone-2")
    assert other.send(s, "speech.transcript.final", transcript("u2", 0, "hi"), T0,
                      principal="phone-2")["code"] == "not_authoritative_microphone"


def test_bounded_pose_queue_drops_oldest_and_keeps_priority(manager, clock, settings):
    settings.ingest_pose_queue = 5
    s = make_session(manager, clock)
    d = Device()
    for i in range(12):
        assert s.accept(d.ev(s, "pose.frame", pose2d(), T0 + i * 0.05), "phone-1", "iphone")["status"] == "accepted"
    watch = {"device_id": "watch-1", "kind": "watch", "simulated": False, "relay_device_id": "phone-1"}
    s.accept(d.ev(s, "heart_rate.sample", hr(70, T0), T0, source=watch), "phone-1", "iphone")
    assert s.counters["dropped_pose_frames"] == 7 and len(s._pose) == 5
    assert s.backpressure_level() == 1.0
    first = s._next()
    assert first["event"].event_type.value == "heart_rate.sample"      # control/heart lane first
    s.process_pending()
    kept = [e["sequence"] for e in s.log.all_events() if e["event_type"] == "pose.frame"]
    assert kept == [7, 8, 9, 10, 11]                                     # oldest frames were dropped


def test_clock_offset_correction(manager, clock):
    info = manager.registry.get("phone-1", "iphone")
    info.clock.add(1000.0, 1000.0 - 250 + 5, 1000.0 - 250 + 5, 1010.0, clock.now())  # device 250 ms ahead
    s = make_session(manager, clock)
    Device().send(s, "pose.frame", pose2d(), T0 + 0.25)
    event = [e for e in s.log.all_events() if e["event_type"] == "pose.frame"][0]
    assert event["timing"]["clock_basis"] == "handshake"
    assert abs(event["timing"]["clock_offset_ms"] + 250) < 1e-6
    assert event["timing"]["corrected_captured_at"].startswith("2027-01-15T08:00:00.000")
    assert event["captured_at"] != event["timing"]["corrected_captured_at"]   # original preserved
