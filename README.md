# AI Presentation Coach

Rehearse a talk with JJ, a voice coach, and a panel of AI judges. One web app plus a Node
brain; see the spec (`AI Presentation Coach — Component & Interface Spec.md`) for the system.

- **[docs/integration.md](docs/integration.md)**: how the components fit together and where each lane plugs in.
- **[docs/extensions.md](docs/extensions.md)**: every addition beyond the spec, with timestamps. Record yours there before merging.
- **[apps/brain/src/jj/VERIFY.md](apps/brain/src/jj/VERIFY.md)**: checking JJ against real Gemini Live.

```bash
corepack pnpm install
cp .env.example .env               # JJ_FAKE=1 runs without a Gemini key
corepack pnpm test && corepack pnpm typecheck
corepack pnpm dev:brain            # brain on :8787
```

| Path | Lane | |
| --- | --- | --- |
| `packages/protocol` | lead | schemas, types, message catalogue |
| `apps/brain` | brain, agents, sensing | hub, session, JJ, mic routing |
| `apps/web` | stage, sensing, brain | pages; `src/net` is the shared WS client |
| `fixtures/` | all | message samples (generated), later pose/audio/sessions |
| `services/coach` | sensing | Python FastAPI: pose/speech/heart metrics, deterministic coaching rules |
| `vision/` | sensing | Mac camera (iPhone via Continuity Camera) + YOLO26 pose → `services/coach` |
| `apple/` | sensing | iPhone capture (Vision pose, speech), Watch heart rate, Mac assistant |
| `contracts/` | sensing | generated JSON schemas / TypeScript client for `services/coach` |

## Sensing lane (services/coach, vision, apple)

### Vision: praćenje položaja tela (iPhone + Mac)

Lokalni prototip: iPhone (Continuity Camera) je kamera, a Mac sa Apple Silicon čipom pokreće
YOLO26 pose model i prikazuje 17 tačaka tela, FPS i uređaj (MPS/CPU). Opciono beleži
koordinate. Detalji, povezivanje telefona i rešavanje problema su u [vision/README.md](vision/README.md).

```bash
bash vision/setup.sh                          # jednom: okruženje, zavisnosti, model, provere
bash vision/run.sh --list-cameras             # pronađi indeks iPhone kamere
bash vision/run.sh --camera 1 --preview-only  # potvrdi da je to iPhone (1 je primer)
bash vision/run.sh --camera 1                 # slika + tačke
bash vision/run.sh --camera 1 --save-points   # + zapis u vision/sessions/
bash vision/run.sh --camera 1 --coach         # + slanje poza servisu services/coach (vidi ispod)
bash vision/run.sh --doctor                   # dijagnostika bez kamere
```

### Coach: backend za vežbanje prezentacija (bez UI)

Headless servis na Macu prima opažanja pokreta (iPhone sa Apple Vision-om, ili Mac kamera sa
YOLO26 preko `vision/ --coach`), govora (Speech, VAD) i pulsa (Apple Watch). Računa merljive karakteristike (brzina ruku, kretanje po prostoru, tempo govora, pauze,
poštapalice, puls u odnosu na referencu sesije), daje kratke determinističke predloge i nudi
REST i WebSocket API za budući frontend. Nema medicinskih zaključaka niti procene emocija.

```bash
bash scripts/coach-setup.sh     # okruženje, zavisnosti, testovi
bash scripts/coach-demo.sh      # kompletna simulirana sesija, bez hardvera
bash scripts/coach-serve.sh     # backend na 127.0.0.1:8765
bash scripts/coach-stream.sh    # tok događaja
bash scripts/apple-check.sh     # Swift paket: build, testovi, Vision na slikama, Apple dostupnosti
```

Dokumentacija:

- [docs/api.md](docs/api.md): ugovor (REST, WebSocket, koordinate, vreme, greške, autentifikacija);
- [docs/device-setup.md](docs/device-setup.md): iPhone i Watch;
- [docs/architecture.md](docs/architecture.md): arhitektura;
- [docs/platform-notes.md](docs/platform-notes.md): proverene činjenice i ograničenja.

Generisani ugovori su u `contracts/`, a simulirani fixture u `fixtures/`.
