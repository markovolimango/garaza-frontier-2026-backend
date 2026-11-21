# Research: dalja poboljšanja

Pregled stanja i predlozi za frontend, backend, senzore i nove feature. Napisano 2026-11-20, posle sređivanja repoa
(sve u `main`, jedan monorepo). **Ažurirano 2026-11-21:** rezultati stres testova, pregled open-source modela i
detaljan plan nadogradnje sa opcijama (§11–§14). Fokus je trenutno samo **engleski**.

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
- **Srpski jezik:** JJ i sudije na srpskom; poštapalice posebno definisane („ovaj“, „znači“, „kao“). *Odloženo
  (2026-11-21): trenutno je bitan samo engleski.*

## Predlog redosleda

1. CI + frontend u typecheck + Biome (pola dana).
2. Novi frontend u `apps/app` sa MediaPipe pose-om u browseru: bolji frontend i uklanja najteži deo setupa.
3. SQLite/Drizzle + istorija napretka.
4. Auth i deploy (Hono na Fly.io/Railway, frontend na Vercel/Cloudflare), pa featuri iz tačke 5.

Ažuriran redosled sa svim tačkama i opcijama je u §14 (2026-11-21).

---

## 6. Dizajn koji ne izgleda kao AI app

**Šta odaje AI app:** shadcn komponente bez izmena, ljubičasto-plavi gradijenti, glassmorphism, Inter, lucide ikonice
svuda, centrirane zaobljene kartice, emoji, generički tekstovi („Elevate your presentation skills“). Lovable pravi baš to.

- **Prvo dizajn, pa kod.** Ekrani u Figmi pre koda. 10–15 referenci van SaaS sveta (pozorište, studio za snimanje,
  Teenage Engineering, Apple Fitness, editorijalni sajtovi). **Jedna metafora** (npr. „proba u praznom pozorištu“)
  kojoj se podređuju boje, zvuk i tranzicije.
- **Tipografija:** font sa karakterom (Söhne, GT America, Neue Haas, ABC Diatype ili manje viđen Google Font), jasna
  skala veličina.
- **Uska paleta:** jedna akcentna boja, ostalo neutralno, bez gradijenata bez razloga.
- **Sopstvene komponente:** Radix primitivi + svoj CSS, bez shadcn defaulta; svoje ili manje viđene ikonice.
- **Tekst pisan ručno:** kratko i konkretno („Run 3: 4 poštapalice manje“, ne „Great job! 🎉“).
- **Animacija sa namerom** (Motion): pokret kao fizički objekat, ne fade-in svega.
- **Asimetrija i gustina:** kao pravi alati (DAW, video editor), ne prazno i centrirano.

## 7. Realističnost scene i sudija

**Uncanny valley:** skoro realističan lik deluje gore od dobro stilizovanog. Svesno izabrati: stilizovano i dosledno,
ili ozbiljno realistično.

- **Likovi:** MetaHuman (Unreal, najrealističnije) ili Character Creator 4, izvoz u GLB za web. Za maksimum: render u
  Unreal-u + Pixel Streaming u browser (traži GPU server).
- **Animacije:** Mixamo je generičan. Sopstveni mocap: telo preko Rokoko suit-a ili iz videa (Move.ai, DeepMotion);
  lice preko iPhone + **Live Link Face** (52 ARKit blendshape-a). Snimiti ljude kako sede, slušaju, beleže, sumnjaju.
- **Lip sync:** vremena po karakteru iz ElevenLabs-a → viseme, ili Rhubarb Lip Sync.
- **Render:** HDRI, PBR, baked lighting, suptilan SSAO i dubinska oštrina (`@react-three/postprocessing`).
- **Ponašanje važnije od poligona:** treptanje, mikropokreti, pogled koji prati govornika, sudija zapiše kad čuje broj,
  pauza pre pitanja, sudije se pogledaju.
- **Jeftina alternativa:** video petlje pravih ljudi (mirovanje, klimanje, pitanje). Realnije od 3D-a, manje
  fleksibilno.

## 8. Objektna dekompozicija backenda

Danas je logika rasuta po `session.ts`, `jj/engine.ts` i `swarm/*`, a domen je izmešan sa pozivima ka
Gemini/ElevenLabs. Predlog: **hexagonal arhitektura (ports & adapters)**.

```
apps/brain/src/
  domain/        // čist TS, bez I/O
    Session.ts  Run.ts  Deck.ts  Slide.ts  Judge.ts  Persona.ts  Question.ts
    BehaviorEpisode.ts  Metric.ts  Report.ts  Goal.ts
  application/   // use case-ovi: StartRun, EndRun, AskNextQuestion, BuildReport
  ports/         // SpeechToText, VoiceSynth, LanguageModel, BehaviorClassifier, SessionRepository
  adapters/      // gemini/, elevenlabs/, whisper/, ownModel/, sqlite/
  interface/     // HTTP + WebSocket
```

```ts
// domain/Run.ts: bez Gemini-ja i WebSocket-a, samo pravila
export class Run {
  private episodes: BehaviorEpisode[] = [];
  constructor(readonly id: RunId, readonly goals: Goal[], readonly feedback: boolean) {}
  record(e: BehaviorEpisode) { this.episodes.push(e); }
  shouldNudge(e: BehaviorEpisode) {
    return this.feedback && (this.goals.length === 0 || this.goals.some(g => g.covers(e.kind)));
  }
}

// ports/BehaviorClassifier.ts: danas pragovi/YOLO, sutra MediaPipe ili sopstveni model
export interface BehaviorClassifier { classify(window: PoseFrame[]): BehaviorEpisode[] }
```

- Faze sesije (intro → run → Q&A → izveštaj) kao state machine u **XState**.
- Domen se testira bez mreže; sopstveni modeli postaju samo adapteri iza portova.
- Frontend po feature-ima (`features/run`, `features/judges`, `features/report`), ne po tipu fajla.

## 9. Sopstveni mali modeli

Ne trenirati LLM od nule. Dobri kandidati za male modele trenirane na laptopu:

### A) Govor tela iz pose tačaka (prvi projekat)
Zamenjuje ručne pragove iz `services/coach/tuning.json`.
- **Ulaz:** ~2 s pose tačaka (17 × x, y, conf × 30 fps); snimanje već postoji (`vision/run.sh --save-points`).
- **Izlaz:** `neutral`, `arms_crossed`, `face_touch`, `looking_down`, `sway`, `gesturing_good`, `hands_in_pockets`.
- **Podaci:** 5–10 ljudi × 20–30 min, labeliranje u Label Studio.
- **Model:** mali 1D-CNN ili GRU (~50k parametara), PyTorch (MPS) ili MLX, trening u minutima.
- **Deploy:** ONNX → `onnxruntime-web` u browseru.

### B) Poštapalice iz zvuka
- **Podaci:** PodcastFillers (Adobe, ~35k anotiranih „um/uh“, engleski) + sopstveni snimci za srpski („ovaj“, „znači“,
  „kao“).
- **Model:** fine-tune wav2vec2 ili Whisper-tiny encodera, ili mali CNN nad log-mel spektrogramom.
- **Dobitak:** radi bez Gemini ključa, brže, jeftinije.

### C) Monotonija i prozodija
Pitch, energija, pauze → klasične osobine + gradient boosting; duboko učenje često nije potrebno.

### Pravila evaluacije
- Train/val/test deliti **po osobi**, ne po klipu (inače model nauči osobu, ne pokret).
- F1 po klasi i confusion matrix, ne samo tačnost. Eksperimenti u W&B ili MLflow.
- Baseline su današnji pragovi; model mora da ih pobedi na test skupu.

**Za učenje:** Karpathy „Neural Networks: Zero to Hero“, fast.ai, d2l.ai.

## 10. Fine-tune open-weight LLM-ova (Qwen, Kimi)

Proveriti najnovije verzije na Hugging Face-u; spisak ispod je stanje u trenutku pisanja.

| Model | Veličina | Gde se trenira (LoRA/QLoRA) | Za šta |
| --- | --- | --- | --- |
| Qwen3 4B / 8B | dense | Mac (MLX) ili GPU 24 GB | sudije, reporter, JJ tekst |
| Qwen3 14B / 32B | dense | A100/H100 80 GB, ili Mac 64 GB+ (MLX, sporo) | sudije visokog kvaliteta |
| Qwen3-30B-A3B | MoE, 3B aktivno | 1 H100 | brz i pametan kompromis |
| Qwen Omni (2.5-Omni 7B, Qwen3-Omni) | audio + video ulaz | 1–2 H100 | sudija koji gleda i sluša |
| Qwen-VL | slika i video | 1–2 H100 | govor tela iz videa |
| Kimi K2 | MoE, ~1T, ~32B aktivno | klaster više čvorova 8×H100 | ne za fine-tune; **učitelj** za distilaciju |

**Distilacija:** Kimi K2 ili Gemini generiše podatke za trening, a mali Qwen se trenira na njima. Mali model nauči
ponašanje velikog za uzak zadatak i radi lokalno, brzo i besplatno.

### Ambiciozno: Qwen-Omni kao sudija koji gleda i sluša
Zamenjuje i Gemini Live („uši“) i YOLO („oči“) jednim modelom:
- feedback o isporuci iz celog runa („na slajdu sa cenom si spustio pogled i ubrzao“);
- pitanja na osnovu viđenog i čujenog, ne samo transkripta;
- lokalno, bez slanja snimka u cloud (privatnost kao feature).

Treba nekoliko stotina do par hiljada anotiranih snimaka pitch-eva (prvu verziju anotacija generiše veliki model,
čovek pregleda), 1–2 iznajmljena H100, nekoliko sati treninga.

### Praktičan početak: sudije na Qwen3-8B
1. **Podaci:** 1–3k primera `(transkript + persona) → pitanje`, generisano Kimi K2 / Gemini-jem iz javnih pitch
   transkripata + sopstveni runovi iz `data/sessions/`; najbolji primeri ručno pregledani.
2. **SFT (LoRA):** Unsloth ili MLX-LM na Mac-u (~sat-dva za 8B).
3. **DPO:** parovi dobro/loše pitanje („oštro ali fer“ vs „generičko“) za karakter koji prompt teško daje.
4. **Serviranje:** vLLM, llama.cpp ili Ollama; u brain-u adapter iza `LanguageModel`, Gemini kao rezerva.
5. **Evaluacija:** 100 test pitch-eva, slepo poređenje sa Gemini-jem (čovek ili LLM-sudija).

### Alati
- Trening: Unsloth, LLaMA-Factory (podržava Qwen-Omni/VL), Axolotl, TRL (DPO), MLX-LM.
- GPU: RunPod, Lambda, Modal, vast.ai (proveriti aktuelne cene).
- Tenstorrent hardver (Wormhole/Blackhole): proveriti podršku za Qwen inference/trening kroz tt-metal / TT-Forge.

### Šta fine-tune donosi, a šta ne
- **Donosi:** stil i karakter, tačan format, nižu cenu i latenciju, offline i privatnost, srpski.
- **Ne donosi:** novo znanje ni bolje rezonovanje od velikog modela.
- **Usko grlo su podaci, ne GPU:** 500 dobrih primera vredi više od 50.000 loših.
- **Realtime glas** (zamena za Gemini Live u razgovoru) je najteži deo zbog latencije; ostaviti za kraj.

## 11. Stres testovi (2026-11-20/21)

Četiri agenta su izmerila brain, coach, vision i frontend na Apple M5 (24 GB), bez API ključeva (fake mod). Repo pri
merenju nije menjan; popravke su posle otišle u PR #2.

### Već popravljeno (PR #2, branch `fix/stress-test-hardening`)

| Problem | Popravka |
| --- | --- |
| WS poruka sa `type: "toString"` / `"__proto__"` obara ceo brain | šema samo iz sopstvenih ključeva tabele, try/catch u hub-u |
| Neuhvaćena greška gasi proces i gubi do 500 ms stanja | `uncaughtException` / `unhandledRejection` → log + `saveNow()` |
| WS ne proverava Origin, nema limita veličine poruke (100 MB) | 403 za strani Origin (localhost + `CORS_ORIGINS`), limit 1 MiB / 64 KiB / 4 KiB, `clientId` ≤ 128 |
| Chunked deck upload zaobilazi limit od 200 MB (RSS 1,5 GB) | brojanje stvarnih bajtova, 413 |
| Vision 3D: noge van kadra → ceo `pose.frame` odbijen | Swift izostavlja `image_point` van ±10 ili kad nije konačan broj |
| Most coach → brain ostavlja otvorene epizode posle restarta | zatvara ih na reconnect / promenu sesije, prati svoju sesiju umesto `"latest"` |

### Još otvoreno (mala, nefundamentalna poboljšanja)

**Brain**

| # | Predlog | Gde | Trud | Dobitak |
| --- | --- | --- | --- | --- |
| B1 | Debounce `refresh` u body agentu (~250 ms) ili inkrementalni brojači; `latest()` bez kopiranja mape | `swarm/body.ts:69,149`, `runlog.ts:159-166` | 30 min | uklanja O(n²) po događaju; pri 2000 msg/s CPU 6 % → 70 % za minut |
| B2 | Gornja granica za opservacije i epizode po runu (npr. 5k) | `runlog.ts:131,197` | 20 min | ograničena memorija i `session.json` |
| B3 | Keširati `catalogue()` | `jj/tools.ts:59` | 5 min | `/api/tools` 3,4k → ~60k rps, bez laga od 100 ms |
| B4 | Snapshot bez teksta slajdova | `sync.ts:117-122` | 20 min | 147 KB → ~3 KB, ide operatoru do 10×/s |
| B5 | 413 umesto `req.destroy()` za preveliko telo; `readBody` prekida čitanje | `persist.ts:180`, `http.ts:10` | 15 min | jasna greška umesto `fetch failed` |
| B6 | Slajdovi preko `createReadStream` + ETag | `context/uploads.ts:165` | 10 min | manji lag pri učitavanju decka |
| B7 | `fsync` pre `rename` | `persist.ts:140-144` | 10 min | otpornost na nestanak struje |
| B8 | `sceneHistory` samo za verzije koje čekaju ack | `session.ts:81,97,269` | 15 min | bez neograničenog rasta |
| B9 | Delimični reset ostavlja foldere prethodnih sesija | `persist.ts` | 20 min | disk se ne puni |

**Coach (tačnost pravila je važnija od brzine: pri 12 fps CPU je 1–2,5 %)**

| # | Predlog | Gde | Trud | Dobitak |
| --- | --- | --- | --- | --- |
| C1 | `pose.smoothing_beta` 0,4 → ~0,004–0,01 (proveriti kamerom) | `tuning.json` | 5 min | glačanje u 2D sada praktično ne radi; mirna osoba posle ~11 s dobija „previše kretanja“ |
| C2 | Ne resetovati sustain na kratak `insufficient_data` | `coaching.py:214-218` | 10 linija | prekrštene ruke se detektuju i kad YOLO gubi zglob |
| C3 | Leksikon poštapalica: „kind of“, „sort of“, „i mean“, „you know“ samo kad su izdvojene; normalizovati „uhhh“, „mmm“, „hmm“ | `coach/lexicons`, `metrics/speech.py` | JSON + 10 linija | manje lažnih `speech.fillers` |
| C4 | Reference od 60 s računati najviše 2×/s; prozore skenirati od kraja | `metrics/body.py:339,390,412-453` | ~30 linija | −32 % CPU po frejmu, isti izlaz |
| C5 | Ne odbacivati `session` / `backpressure` / `error` poruke iz reda ka uređaju | `api.py:322` | 15 linija | uređaj ne propušta pause/ended |
| C6 | `body.metrics` u poseban, kraći prsten; `_seen` 50k → 10k | `eventlog.py`, `session.py` | srednje | pun prsten ~190 → ~50 MB po sesiji |
| C7 | `pose_buffer` po vremenu ili 1500 | `config.py:54` | 1 linija | demo export ponovo prolazi `replay --strict` |
| C8 | `EventLog.since` preko bisect-a | `eventlog.py:58-60` | 10 linija | `/events` 6,5 → <1 ms |
| C9 | Zamrznuti referencu pogleda dok traje `looking_down` | `metrics/body.py` | 5 linija | čitanje beleški se ne „očisti“ posle 39 s |
| C10 | Proizvodne odluke: `long_pause_s` 2 → ~3 s; uporne navike da se ponovo jave posle cooldowna (`rearm_after_s`); napomena za ručni mikrofon (`face_touch`) | `tuning.json`, docs | config | manje kazni za namerne pauze, više podsetnika |

**Vision**

| # | Predlog | Trud | Dobitak |
| --- | --- | --- | --- |
| V1 | `--model s` kao default (`vision/app.py:56`) | 1 linija | COCO AP 0,538 → 0,608 za ~4 ms po frejmu |
| V2 | CoreML fp16 backend (s, 640, Neural Engine) | ~pola dana; eksport puca na coremltools 9 + numpy 2.5 | 5,9 ms uz tačnost modela s, oslobađa GPU |
| V3 | Jedna `.cpu()` kopija u `extract_people` | 5 min | −0,5 ms po frejmu |
| V4 | Vision 3D na iPhone-u: 10 Hz ili izmeriti (na M5 je ~75 ms) | merenje | bez gubljenja frejmova |
| V5 | Ispraviti `docs/platform-notes.md` (hladni start Vision 2D je 80–90 ms, ne 9,5 s) | 5 min | tačna dokumentacija |

Izmereno (YOLO, ms po frejmu / COCO AP): n/MPS/640 6,1 / 0,538 · s/MPS/640 10,1 / 0,608 · CoreML s fp16 5,9 / 0,605 ·
Apple Vision 2D ~5 / 0,313 · Apple Vision 3D ~75 / —. Manji `imgsz` na MPS-u skoro ne ubrzava, a gubi 6–15 AP.

**Frontend**

| # | Predlog | Trud | Dobitak |
| --- | --- | --- | --- |
| F1 | `character.fbx` + 9 animacija → jedan `judge.glb` bez tekstura, meshopt (skripta postoji u scratch-u agenta) | 2–4 h | 61,5 MB → 1,07 MB (−98 %), parse ~300 → ~15 ms |
| F2 | Ukloniti eager preload u `routes/__root.tsx:136-142` | 15 min | prva stranica bez 1,5 MB JS-a i 61 MB asseta |
| F3 | Frontend u `pnpm typecheck` (`tsc --noEmit -p apps/frontend` već prolazi) | 5 min | automatska provera |
| F4 | Validacija downlink poruka samo u dev-u | ~1 h | entry −115 KB raw |
| F5 | Biome samo kao linter (formatter preformatira ~95 % fajlova) | 1–2 h | ~38 stvarnih nalaza |
| F6 | 36 neiskorišćenih paketa i 45 ui fajlova obrisati tek u `apps/app` | — | subtree konflikti inače |

## 12. Open-source modeli (engleski, mogu da se dotreniraju)

Kriterijum: otvorene težine, licenca koja dozvoljava proizvod, alati za fine-tune. Brojke su uglavnom podaci samih
proizvođača; pre odluke izmeriti na našim podacima.

| Oblast | Danas | Kandidati | Licenca | Napomena |
| --- | --- | --- | --- | --- |
| Transkript + poštapalice | Gemini Live / Apple Speech (izbacuju „um“, „uh“) | **Whisper large-v3-turbo**, **Parakeet TDT 0.6B v3** (NeMo), Moonshine v2 | MIT / NVIDIA Open Model License / proveriti | Parakeet ~0,1 s latencije na Apple Silicon-u naspram 0,68 s Whisper turbo |
| | | CrisperWhisper 2.0 (doslovni transkript sa poštapalicama) | **nekomercijalna** (Nyra Health) | samo prototip ili uz komercijalnu licencu |
| Telo, šake, lice | YOLO26-pose, 17 tačaka | **RTMW** (133 tačke, ~70 mAP COCO-WholeBody), DWPose, Apple Vision hand pose (21 zglob/šaka) | Apache 2.0 / Apache / Apple | Meta Sapiens je tačniji, ali nekomercijalan |
| Kontakt očima | nagib glave iz YOLO-a | MediaPipe Face Landmarker + iris, EyeTheia, WebEyeTrack | Apache / otvoreno | radi i u browseru |
| Tekst (sudije, reporter, režiser, JJ) | Gemini (flash-lite) | **Qwen3 8B / 14B / 30B-A3B** | Apache 2.0 | LoRA preko Unsloth / MLX-LM / TRL |
| Glasovi sudija | ElevenLabs | **Qwen3-TTS** (~97 ms, kloniranje iz 3 s), **Chatterbox** (Turbo ~75 ms), **Kokoro** (82M), Orpheus | Apache / MIT / Apache / proveriti | dotreniranje na 1,5 h nije jasno nadmašilo kloniranje (Baseten) |
| Analiza snimka runa | Gemini (video) | **Qwen3-Omni 30B-A3B**, Qwen-VL | Apache 2.0 | trening na 1–2 H100 |
| JJ uživo | Gemini Live | **Kyutai STT + TTS** (MLX) + naš LLM; Moshi; NVIDIA Nemotron VoiceChat (11B, full-duplex, alati) | CC-BY (Kyutai) / proveriti | vidi §13.6 |
| 3D telo (mesh) | Apple Vision 3D | PEAR, SMPLify-M | istraživački | još nije zrelo za nas |

**Licence koje ograničavaju:** CrisperWhisper i PodcastFillers (anotacije) su samo za nekomercijalna istraživanja, i to
važi i za modele trenirane na njima. Google-ovi uslovi ograničavaju korišćenje Gemini izlaza za treniranje
konkurentskih modela: proveriti pre distilacije, ili generisati podatke otvorenim modelom koji to dozvoljava.

**Apple:** na WWDC26 nije bilo novog API-ja za telo u Vision-u. Već dostupno, a neiskorišćeno: hand pose i face
landmarks u Vision-u, SpeechAnalyzer (brz, lokalan, engleski), Foundation Models (već u `apple/MacAssistant`).

## 13. Plan nadogradnje sa opcijama

Svaki korak ima metriku i osnovu za poređenje (današnje ponašanje). Ništa se ne zamenjuje dok novo ne pobedi staro na
našem test skupu.

### 13.0 Osnova (pre svega ostalog, ~1 dan)

- PR #2 merge.
- CI (GitHub Actions): `pnpm typecheck` (sa frontendom, F3), `pnpm test`, `pnpm test:frontend`, coach `pytest`, Swift
  `swift test` na macOS runneru.
- Biome kao linter (F5).
- Brze popravke iz §11: B3, B4, B5, C1 (uz proveru kamerom), C2, C3, C5, C7, V1, F1, F2.

### 13.1 Prikupljanje podataka (preduslov za sav trening)

- **Šta:** svaki run čuva zvuk (16 kHz), tačke poze (`vision/run.sh --save-points`), transkript, epizode, JJ-ove i
  sudijske replike. Format pogodan za trening (JSONL + WAV po runu).
- **Pristanak:** eksplicitan opt-in u aplikaciji, brisanje na zahtev, ništa ne ide u cloud bez pristanka
  (`SWARM_VIDEO_ANALYSIS`).
- **Labeliranje:** Label Studio (poza: klase ponašanja; zvuk: doslovni transkript sa poštapalicama).
- **Cilj prve runde:** 10–50 h govora od 10+ ljudi; 5–10 ljudi × 20–30 min za pozu.
- **Podela:** train/val/test po osobi, ne po klipu.

### 13.2 Poštapalice i transkript

| Opcija | Šta | Prednost | Mana |
| --- | --- | --- | --- |
| A (preporuka) | Fine-tune **Whisper large-v3-turbo** na doslovni transkript | MIT, ogroman ekosistem, radi lokalno (whisper.cpp / MLX / CoreML) | sporiji od Parakeet-a |
| B | Fine-tune **Parakeet TDT 0.6B v3** (NeMo) | najbrži na Apple Silicon-u, odličan WER | NVIDIA licenca (proveriti uslove), NeMo je teži alat |
| C | Mali klasifikator nad log-mel spektrogramom (poštapalica / nije) uz postojeći STT | malo podataka, radi na CPU | ne daje transkript, samo događaje |
| D | CrisperWhisper 2.0 bez treninga | radi odmah | nekomercijalan |

- **Metrika:** F1 za poštapalice po tipu, WER, latencija do događaja. Osnova: današnji leksikon u coach-u.
- **Hardver:** 1× H100 (vast.ai ~$1,5–2/h), nekoliko sati po eksperimentu. Whisper turbo sa LoRA staje i u 24 GB.

### 13.3 Govor tela

| Opcija | Šta | Prednost | Mana |
| --- | --- | --- | --- |
| A (preporuka) | Mali 1D-CNN / GRU (~50k param.) nad tačkama (§9A) | trening na Mac-u za minute, ONNX → browser | treba labeliranih 5–10 ljudi |
| B | Prvo bolji ulaz: **RTMW** (133 tačke) umesto YOLO-a, pa model A nad njim | šake i lice: `face_touch`, `hands_in_pockets` postaju merljivi | sporije od YOLO-a, izmeriti na M5 |
| C | Apple Vision hand pose + face landmarks kao dodatak YOLO-u | već na uređaju, besplatno | samo Apple |
| D | MediaPipe u browseru (§4) | bez Python-a i kamere preko Continuity | 33 tačke, slabije šake od RTMW |

- **Metrika:** F1 po klasi, confusion matrix. Osnova: pragovi iz `tuning.json` (posle C1–C2).
- **Hardver:** Mac (MPS). RTMW fine-tune (mmpose): 1× GPU 24 GB, par sati.

### 13.4 Tekst: sudije, reporter, režiser

| Opcija | Šta | Prednost | Mana |
| --- | --- | --- | --- |
| A (preporuka) | **Qwen3-8B** + LoRA (SFT, pa DPO za karakter) | jeftino, lokalno na Mac-u (4-bit ~5 GB) | slabije rezonovanje od velikih |
| B | **Qwen3-30B-A3B** (MoE, 3B aktivno) | pametniji, i dalje brz | ~17 GB u 4-bit, tesno na 24 GB Mac-u |
| C | Qwen3-14B | sredina | sporiji od 8B |
| D | Ostati na Gemini-ju za tekst | nula posla | cloud, cena, nema kontrole stila |

- **Podaci:** 1–3k primera (transkript + persona → pitanje / odluka / izveštaj); izvor: naše sesije + generisano
  otvorenim modelom (vidi licence u §12); najbolji primeri ručno pregledani.
- **Metrika:** slepo poređenje sa Gemini-jem na 100 pitch-eva (čovek ili LLM sudija), validan JSON %, latencija.
- **Hardver:** 1× H100, 1–3 h po LoRA treningu.

### 13.5 Glasovi sudija

| Opcija | Šta | Prednost | Mana |
| --- | --- | --- | --- |
| A (preporuka) | **Qwen3-TTS** sa kloniranjem glasa (bez treninga) | Apache, ~97 ms, 4 različita glasa iz 4 kratka snimka | treba GPU ili jak Mac, izmeriti |
| B | Qwen3-TTS SFT po glasu | stabilniji karakter glasa | dobitak nad kloniranjem nije jasan |
| C | **Kokoro** lokalno | 82M, radi na laptopu | manje izražajan, bez kloniranja |
| D | **Chatterbox** (Turbo) | MIT, ~75 ms | proveriti kvalitet na engleskom pitch kontekstu |
| E | Ostati na ElevenLabs-u | radi danas | cena po karakteru, cloud |

- Uz bilo koju opciju: `JudgeVoices.stop()` za barge-in i retry na greške (TODO.md).
- **Metrika:** vreme do prvog zvuka, MOS (slušni test u timu), razlikovanje 4 glasa.

### 13.6 JJ uživo (zamena za Gemini Live), bez stalno upaljenog servera

| Opcija | Šta | Prednost | Mana |
| --- | --- | --- | --- |
| A (preporuka) | **Lokalno na Mac-u (MLX):** Kyutai `stt-1b-en_fr` (~0,5 s, semantički VAD) + naš Qwen3-8B 4-bit (`mlx-lm`) + Kyutai TTS ili Kokoro | bez troška po satu, privatno, radi offline | M5 istovremeno vrti YOLO + STT + LLM + TTS; kvalitet i latencija moraju da se izmere |
| B | **Serverless GPU po sesiji** (RunPod Serverless / Modal): brain ga budi na setup ekranu, gasi posle izveštaja | plaća se samo vreme vežbanja, jači modeli | hladni start za model od par GB je više sekundi; LoRA po tokenu skoro da više ne postoji, plaća se GPU po sekundi |
| C | **Apple stack bez treninga:** SpeechAnalyzer + Foundation Models + AVSpeechSynthesizer (`apple/MacAssistant`) | besplatno, već delom postoji | ne može da se dotrenira, slabiji razgovor |
| D | Ostati na Gemini Live | najbolji razgovor danas | cloud, ključ, nema dotreniranja |

- **Procena memorije za A** (nije mereno): STT ~2 GB + LLM ~5 GB + TTS ~2–3 GB ≈ 10 GB od 24 GB.
- **Prvi korak:** prototip A na M5 sa običnim (nedotreniranim) Qwen3-8B dok YOLO radi; meriti vreme od kraja rečenice
  do prvog zvuka, memoriju i FPS kamere. Ako je >1,5 s ili kamera pada ispod 12 Hz, prelazi se na B.
- Brain ostaje isti: novi `VoiceAgent` adapter pored Gemini-ja (vidi §8, ports & adapters), Gemini kao rezerva.

### 13.7 Analiza snimka runa

- **Opcija A:** Qwen3-Omni 30B-A3B posle runa (batch, ne uživo) na serverless GPU-u; snimak se briše posle analize.
- **Opcija B:** ostati na Gemini-ju (`SWARM_VIDEO_ANALYSIS`) dok A ne pobedi na slepom poređenju.
- Trening tek kad postoji nekoliko stotina anotiranih runova; prvu verziju anotacija pravi veliki model, čovek pregleda.

### 13.8 Hardver i troškovi

| Šta | Gde | Okvirna cena |
| --- | --- | --- |
| Model govora tela, mali eksperimenti | Mac (MPS / MLX) | 0 |
| LoRA 8B (2k primera) | 1× H100 | 1–3 h × $1,5–4/h |
| Whisper turbo fine-tune (20–50 h zvuka) | 1× H100 | nekoliko sati |
| RTMW / TTS fine-tune | 1× GPU 24–48 GB | par sati |
| Qwen3-Omni fine-tune | 1–2× H100 | nekoliko sati do dan |
| JJ uživo, opcija B | serverless GPU | samo vreme sesije, po sekundi |

Cene H100 (novembar 2026): vast.ai ~$1,5–2/h, RunPod ~$2–4/h, Lambda ~$4/h. Cela prva runda eksperimenata (STT,
sudije, TTS) je reda nekoliko stotina dolara. Usko grlo su podaci, ne GPU.

## 14. Redosled (ažurirano 2026-11-21)

| Faza | Šta | Zavisi od | Rezultat |
| --- | --- | --- | --- |
| 0 | PR #2, CI, Biome lint, brze popravke iz §11 (13.0) | — | stabilna osnova, automatske provere |
| 1 | Prikupljanje podataka + pristanak + labeliranje (13.1) | 0 | prvih 10+ h govora i poza |
| 2 | Prototip JJ lokalno na Mac-u, merenje (13.6 A) | 0 | odluka: lokalno ili serverless |
| 3 | Poštapalice: Whisper turbo fine-tune (13.2 A) | 1 | F1 bolji od leksikona |
| 4 | Govor tela: mali model, pa RTMW kao ulaz (13.3 A → B) | 1 | F1 bolji od pragova |
| 5 | Sudije, reporter, režiser na Qwen3-8B (13.4 A) | 1 | slepo poređenje sa Gemini-jem |
| 6 | Glasovi sudija: Qwen3-TTS kloniranje (13.5 A) | 0 | ElevenLabs postaje opcija, ne obaveza |
| 7 | JJ uživo na sopstvenom stack-u (13.6 A ili B) sa LLM-om iz faze 5 | 2, 5 | Gemini Live postaje rezerva |
| 8 | Dekompozicija backenda (§8), novi frontend `apps/app` (§3, §6) | paralelno sa 3–7 | lakše dodavanje adaptera |
| 9 | Qwen3-Omni analiza runa (13.7), istorija napretka, auth, deploy (§2, §5) | 5, 8 | — |

Faze 2 i 6 ne traže sopstvene podatke i mogu odmah, paralelno sa fazom 1.

### Izvori (2026-11-21)

- Poza: [RTMW](https://arxiv.org/abs/2407.08634), [rtmlib](https://github.com/Tau-J/rtmlib),
  [DWPose](https://arxiv.org/pdf/2307.15880), [MediaPipe Pose](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js)
- STT: [Whisper vs Parakeet na Apple Silicon-u](https://dev.to/konrad_sierzputowski_c86a/how-i-benchmarked-on-device-speech-to-text-on-apple-silicon-whisper-vs-parakeet-dne),
  [Parakeet v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), [NeMo fine-tuning](https://docs.nvidia.com/nemo/speech/latest/asr/fine_tuning.html),
  [CrisperWhisper 2.0](https://huggingface.co/nyralabs/CrisperWhisper2.0_turbo), [PodcastFillers](https://podcastfillers.github.io),
  [Apple SpeechAnalyzer](https://www.macstories.net/stories/hands-on-how-apples-new-speech-apis-outpace-whisper-for-lightning-fast-transcription/)
- TTS: [pregled open-source TTS](https://www.bentoml.com/blog/exploring-the-world-of-open-source-text-to-speech-models),
  [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS), [Baseten: fine-tune Qwen3-TTS](https://www.baseten.co/blog/fine-tuning-qwen3-tts-for-high-quality-voice-cloning/)
- Glas uživo: [Kyutai DSM / MLX](https://github.com/kyutai-labs/delayed-streams-modeling), [Kyutai Unmute](https://kyutai.org/2025/07/03/tts-unmute-open-source.html),
  [Nemotron VoiceChat](https://arxiv.org/abs/2609.21967v1), [Qwen3-Omni](https://huggingface.co/Qwen/Qwen3-Omni-30B-A3B-Instruct)
- Pogled: [EyeTheia](https://arxiv.org/abs/2601.06279), [WebEyeTrack](https://arxiv.org/html/2508.19544v1)
- Hardver: [cene H100](https://intuitionlabs.ai/articles/h100-rental-prices-cloud-comparison), [vast.ai](https://www.activepieces.com/blog/vast-ai-gpu-pricing-per-hour-in-2026-and-extra-fees),
  [RunPod Serverless](https://runpod.io/product/serverless), [Modal](https://modal.com/resources/best-gpu-clouds-scale-to-zero),
  [LoRA serving 2026](https://andrew.ooo/answers/best-inference-providers-for-lora-fine-tuned-models-2026/)
