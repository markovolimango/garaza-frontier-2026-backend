# AI Presentation Coach

Vežbanje prezentacije sa JJ-em (glasovni coach, Gemini Live) i panelom AI sudija. Jedan monorepo: Node backend
("brain"), React frontend i Python servis za merenje pokreta i govora.

## Struktura

| Putanja | Šta je |
| --- | --- |
| `apps/brain` | **Backend.** Node + TS. HTTP + WebSocket na :8787: sesija, JJ, sudije, režiser, swarm agenti (`src/swarm/`) |
| `apps/frontend` | **Frontend.** Vite + React 19 + TanStack Router na :5174. `src/brain/` je sloj koji ga vezuje za brain |
| `packages/protocol` | Zajedničke šeme i tipovi poruka (zod) za brain i frontend |
| `apps/web` | Zajednički WebSocket klijent (`src/net/client.ts`), koriste ga frontend i testovi braina |
| `services/coach` | Python FastAPI na :8765: metrike pokreta, govora i pulsa, deterministička pravila |
| `vision/` | Mac/iPhone kamera + YOLO pose → `services/coach` |
| `apple/` | Swift: iPhone snimanje, Apple Watch puls |
| `contracts/`, `fixtures/` | Generisane šeme za coach, primeri poruka |
| `e2e/` | Browser i live testovi (Playwright) |
| `scripts/` | Skripte za coach, kameru i demo |

## Setup (jednom, na novom računaru)

```bash
corepack enable                    # da `pnpm` radi globalno (skripte ga zovu)
pnpm install
cp .env.example .env               # GEMINI_API_KEY; bez ključa brain radi u fake modu (JJ_FAKE)
git remote add frontend https://github.com/markovolimango/garaza-frontier-2026-frontend.git   # za Lovable pull
```

Za kameru/coach (opciono): `bash scripts/coach-setup.sh` i `bash vision/setup.sh`.

## Razvoj

Dva terminala:

```bash
pnpm dev:brain        # backend na :8787, restartuje se na svaku izmenu
pnpm dev:frontend     # frontend na http://localhost:5174, vezan za brain
```

Izmena poruke između fronta i backa ide u `packages/protocol`, pa u `apps/brain` i `apps/frontend/src/brain/`.

## Testovi

```bash
pnpm typecheck        # protocol, web, brain
pnpm test             # brain + protocol (vitest)
pnpm test:frontend    # frontend
cd services/coach && .venv/bin/python -m pytest -q   # coach
```

## Frontend i Lovable

Frontend se pravi i u Lovable-u (repo `garaza-frontier-2026-frontend`) i ovde ulazi kao git subtree u
`apps/frontend`. Nove Lovable izmene povlačiš sa `pnpm frontend:pull`. Naše izmene **ne** pushuj nazad u Lovable
repo. Lovable ne dira `src/brain/`. Detalji: [docs/integration.md §14](docs/integration.md).

## Dokumentacija

- [docs/integration.md](docs/integration.md): kako su delovi povezani
- [docs/brain-api.md](docs/brain-api.md): HTTP rute i WebSocket poruke braina
- [docs/extensions.md](docs/extensions.md): dodaci van originalnog speca
- [docs/sensing.md](docs/sensing.md): coach, kamera, most coach → brain, tuning pragova
- [docs/demo.md](docs/demo.md): demo jednom komandom, agent swarm, pitch mod
- [docs/api.md](docs/api.md): API servisa `services/coach`
- [TODO.md](TODO.md): otvoreni zadaci (glasovi sudija)
