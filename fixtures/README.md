# fixtures

`simulated_session.jsonl.gz` is **simulated data** (every event has `source.simulated: true`; the
session is `simulated: true`). It is the hardware-free scenario from `coach/simulator.py`:

- calibration;
- fast, continuous hand movement (`body.hand_movement_high`);
- normal speech, then faster speech, a coaching suggestion and its cooldown;
- heart rate above the session reference;
- walking back and forth (`body.torso_movement_high`);
- tracking loss and recovery;
- Watch disconnect and stale data;
- long pauses;
- stop.

```bash
gunzip -c fixtures/simulated_session.jsonl.gz | head -3                                    # inspect
services/coach/.venv/bin/python -m coach replay fixtures/simulated_session.jsonl.gz --strict  # deterministic replay
services/coach/.venv/bin/python -m coach fixture                                           # regenerate
```

`tests/test_assistant_and_replay.py` replays it and requires the same coaching sequence.
