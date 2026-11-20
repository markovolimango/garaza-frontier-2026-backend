# Research: dalja poboljšanja

Pregled stanja i predlozi za frontend, backend, senzore i nove feature. Napisano 2026-11-20, posle sređivanja repoa
(sve u `main`, jedan monorepo).

## Stanje

| Deo | Veličina | Napomena |
| --- | --- | --- |
| `apps/brain` | ~9.500 linija TS | jedna globalna sesija, čuvanje kao JSON na disku (`persist.ts`), ručni HTTP router (`http.ts`) |
| `apps/frontend` | ~12.000 linija TS | Lovable app (subtree), naš sloj u `src/brain/` |
| `packages/protocol` | ~900 linija | zod šeme poruka između fronta i backa |
| `services/coach` | ~6.200 linija Python | pose/govor/puls metrike, deterministička pravila |
| `vision/` | Python + YOLO | venv ~1,1 GB, kamera preko Continuity Camera |

Nedostaje: CI, lint/format za brain, typecheck frontenda u `pnpm typecheck`, auth, više korisnika.

## 1. Osnova (pre novih featura)

- **CI (GitHub Actions):** na svaki push `pnpm typecheck`, `pnpm test`, `pnpm test:frontend` i coach `pytest`.
- **Frontend u typecheck:** `pnpm typecheck` proverava samo protocol, web i brain. Frontend danas prolazi `tsc`, ali to
  niko ne proverava automatski.
- **Lint i format za ceo repo:** [Biome](https://biomejs.dev): jedan brz alat za lint i format, za ceo monorepo.
- **Lovable → sopstveni frontend:** novi frontend kao **`apps/app`** pored `apps/frontend`, ne prepravka Lovable koda.
  Lovable radi dok novi nije spreman, bez subtree konflikata. `src/brain/` (BrainSource, audio, mapping, deck) se
  prenosi skoro direktno.
- **Zavisnosti:** Lovable je ubacio ~30 Radix/shadcn paketa (calendar, carousel, OTP, menubar…). Novi frontend kreće
  samo sa onim što koristi.

## 2. Backend (brain)

- **Više korisnika i sesija:** sesija po korisniku umesto jedne globalne.
  - Baza: **SQLite + [Drizzle](https://orm.drizzle.team)** lokalno, **Postgres** (Neon/Supabase) u cloudu. Tabele:
    korisnici, sesije, runovi, izveštaji, ciljevi.
  - Snimci i deck u object storage (S3 / Cloudflare R2), ne na lokalni disk.
- **Auth:** Better Auth ili Clerk (ili Supabase Auth uz Supabase bazu).
- **HTTP sloj:** [Hono](https://hono.dev) umesto ručnog routera: tipizirane rute, middleware, lak deploy; `hono/client`
  daje frontendu tipove za REST kao što `packages/protocol` daje za WebSocket.
- **Refaktor velikih fajlova:** `swarm/listener.ts` (521), `jj/tools.ts` (470), `jj/engine.ts` (456),
  `director/agent.ts` (435), `session.ts` (429).
- **Observability za LLM:** 5 Gemini agenata + Gemini Live + ElevenLabs. [Langfuse](https://langfuse.com) ili
  OpenTelemetry trace po runu: latencija, cena, odluke svakog agenta.
- **Iz `TODO.md`:** `JudgeVoices.stop()` za prekid sudije na barge-in, retry na ElevenLabs 429/5xx, `/debug/judge-say`
  samo u debug modu.

## 3. Frontend

- **Stack za `apps/app`:** zadržati Vite + React 19 + TanStack Router. Dodati **Zustand** za stanje sesije (umesto
  ručnog signal busa) i TanStack Query za REST.
- **3D sudije:** `public/judges/character.fbx` ima 52 MB i stoji u gitu. Konverzija u **GLB sa Draco/Meshopt
  kompresijom** (`gltf-transform`) ga višestruko smanjuje i ubrzava učitavanje. Veliki asseti → **Git LFS**.
- **Izveštaj:** vremenska linija runa sa markerima (poštapalice, prekrštene ruke) sinhronizovana sa snimkom; tempo po
  slajdu.
- **Mobilni / PWA:** vežbanje sa telefona, kamera i mikrofon iz browsera; delimično zamenjuje Swift app.

## 4. Senzori i ML

- **Pose u browseru:** [MediaPipe Pose Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker)
  (WASM/WebGPU) u realnom vremenu, bez Python venv-a, YOLO-a, mosta coach→brain i Continuity Camera setupa. Najveće
  pojednostavljenje za korisnika: otvori stranicu i radi. Pravila iz `services/coach` se prenose u TS ili ostaju
  servis.
- **„Kamera ne vidi kukove za stolom“:** upper-body pravila; MediaPipe face landmarks daju i kontakt očima sa kamerom.
- **Govor bez ključa:** Whisper (whisper.cpp ili `transformers.js`) kao fallback za transkript i poštapalice kad nema
  Gemini ključa.

## 5. Featuri

- **Napredak kroz dane:** grafik poštapalica/min kroz nedelje, streak-ovi, ciljevi koji se prenose između sesija
  (danas je napredak samo unutar jedne sesije).
- **Persone sudija:** investitor, tehnički žiri, klijent, intervju za posao; prompt i glas po personi, korisnik bira
  panel.
- **Replay sa anotacijama:** snimak + transkript, klik na reč skače na trenutak, JJ-ovi komentari na vremenskoj liniji.
- **Coach za slajdove:** feedback na deck pre runa (previše teksta, nema „ask“ slajda) i provera da li je rečeno ono
  što piše na slajdu.
- **Q&A drill:** samo pitanja sudija, bez prezentacije, ocena odgovora (direktnost, konkretan broj, trajanje).
- **Deljenje izveštaja:** read-only link za mentora ili tim, komentari na trenutke u snimku.
- **Srpski jezik:** JJ i sudije na srpskom; poštapalice posebno definisane („ovaj“, „znači“, „kao“).

## Predlog redosleda

1. CI + frontend u typecheck + Biome (pola dana).
2. Novi frontend u `apps/app` sa MediaPipe pose-om u browseru: bolji frontend i uklanja najteži deo setupa.
3. SQLite/Drizzle + istorija napretka.
4. Auth i deploy (Hono na Fly.io/Railway, frontend na Vercel/Cloudflare), pa featuri iz tačke 5.
