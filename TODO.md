# TODO: judge voices (`judge-voices` branch)

Status: `JudgeVoices` (`apps/brain/src/voices/judgeVoice.ts`) and `POST /debug/judge-say` are built and unit-tested.
They haven't been tried against real ElevenLabs or a real stage yet.

## Verify
- [ ] Run `JJ_FAKE=1 ELEVENLABS_API_KEY=… pnpm dev:brain`, then `curl -X POST localhost:8787/debug/judge-say -H 'content-type: application/json' -d '{"judge":2,"text":"…"}'`, and check that the voice plays on the stage.
- [ ] Check that each of the 4 default premade voices (Rachel, Adam, Antoni, Sarah) is available on our ElevenLabs account and sounds different. If not, set `JUDGE_VOICE_IDS`.
- [ ] Measure the time to first audio with `eleven_flash_v2_5`. If it's too slow, try `optimize_streaming_latency`.
- [ ] Check that the stage sends `audio.playback` `ended` for judge utterances, so `idle` lines up with the end of the audio. Otherwise the 1.5 s fallback after the audio length kicks in.

## Stage / scene
- [ ] `judge_4` isn't in the default scene (3 judges). Add a 4th judge to the scene, or limit the debug route to the judges currently seated.
- [ ] Make sure the stage plays audio from sources 1–4 and drives lip-sync or the talk gesture from `actor.say` + `actor.gesture`.

## Behaviour
- [ ] Add cancellation: `audio.stop` for the current judge utterance on wake / barge-in / run end, and clear the queue (`JudgeVoices.stop()`).
- [ ] Pace the audio to real time (or cap how far ahead it gets) if sending ElevenLabs' bursts straight through overflows the stage's buffer.
- [ ] Add a retry or a shorter error path on ElevenLabs 429 / 5xx.
- [ ] Use each judge's scene `voiceId` (`JudgeDef.voiceId`) once personas pick voices, instead of a fixed index-based list. Settle how this relates to the existing `JUDGE_VOICES` key.

## Integration
- [ ] Director (Q&A): call `speakJudge` for judge questions, and dispatch `qa_done` when the panel is done.
- [ ] Recorder: log judge utterances (`ext` lines) once the recorder lands.
- [ ] Gate or remove `/debug/judge-say` before the demo (e.g. only when `LOG_LEVEL=debug` or `JUDGE_DEBUG=1`).
