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

Prošireni redosled sa svim tačkama je na kraju dokumenta.

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

## Prošireni redosled

1. CI + frontend u typecheck + Biome.
2. Dekompozicija backenda (domain / ports / adapters).
3. Model A: govor tela iz pose tačaka.
4. Dizajn u Figmi, pa novi frontend u `apps/app` (sa MediaPipe u browseru).
5. Qwen3-8B sudije (distilacija + SFT + DPO).
6. Model B: poštapalice (i srpski).
7. SQLite/Drizzle, istorija napretka, auth, deploy.
8. Qwen-Omni sudija; realistične sudije (mocap, lip sync).
