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
corepack pnpm dev:brain            # brain on :8787 (watch: restarts on every code change)
corepack pnpm dev:frontend         # Lovable app on :5174, wired to the brain
```

### Demo: jedna komanda

```bash
bash scripts/demo.sh --camera 1     # brain, frontend, coach, most i kamera (1 je primer: bash vision/run.sh --list-cameras)
bash scripts/demo.sh --no-camera    # bez Mac kamere
bash scripts/demo.sh --fresh        # nova sesija umesto nastavka sačuvane
```

Pokreće sve redom, čeka da se svaki deo javi, zagreje ekrane u Vite-u i otvori aplikaciju. Brain radi bez
watch moda. Ako brain, frontend, coach ili most padnu, skripta ih ponovo pokrene. Ctrl+C gasi sve.
Ako su portovi zauzeti (servisi iz starih terminala), skripta kaže ko ih drži; `--takeover` ih gasi.
Ostale opcije: `--force` (vinjeta na svaki predlog), `--no-coach`, `--no-open`, `--dev`. Logovi su u
`data/demo-logs/`. Kameru možeš upisati u `.env` kao `DEMO_CAMERA=1`.

**Sesija se čuva na disk** (`data/sessions/`): runovi, izveštaji, coach i deck ostaju posle restarta
braina. Run koji je bio u toku se prekida, a sesija nastavlja od izveštaja poslednjeg runa. Za novu
sesiju koristi `--fresh` (stara ostaje na disku) ili dugme **Delete and start over** na kartici Progress
(= `curl -X POST localhost:8787/api/session/reset`): to **briše** prethodnu sesiju sa diska (runovi,
izveštaji, lični ciljevi, slajdovi) i njene coach sesije iz memorije. `{"keepData": true}` je zadržava,
`{"full": false}` zadržava deck i preskače JJ-ov uvod (ništa ne briše).

**Tok:** "Talk to JJ first →" na početnom ekranu počinje sesiju i pre deck-a (JJ pita šta želiš da
popraviš, uz mogućnost da preskočiš, pa traži slajdove: "Upload slides (PDF)" na JJ-ovom ekranu); run traži deck.
Kad kažeš da si gotov ("kraj"), JJ pokaže finalni izveštaj sa brojevima prvi → poslednji run.

**Snimanje:** posle pristanka na ekranu ("Record runs") browser snima kameru i mikrofon tokom runa i šalje
ih brainu (`data/sessions/<id>/media/`, samo na ovom računaru). JJ posle runa kaže npr. "prekrstio si ruke
5 puta" i alatom `show_moments` pusti te trenutke na ekranu (±1,5 s oko svake epizode, najviše 5);
na kraju može da pokaže prvi run naspram poslednjeg. "Delete and start over" briše i snimke.
Test: `pnpm e2e:recording` (lažna kamera u Chrome-u).

**Napredak kroz runove:** ekran izveštaja posle drugog runa prikazuje "run 1 → 2 → 3" (karticu Progress)
i naslov tipa "Moving around / swaying 3 → 0". JJ-ov `show_final` otvara isti prikaz. API: `GET /api/progress`.

The main app is built in Lovable in a separate repo and carried here as a git subtree at
`apps/frontend`; pull new Lovable commits with `pnpm frontend:pull` (docs/integration.md §14).

| Path | Lane | |
| --- | --- | --- |
| `packages/protocol` | lead | schemas, types, message catalogue |
| `apps/brain` | brain, agents, sensing | hub, session, JJ, mic routing |
| `apps/frontend` | stage (Lovable) | the main app; `src/brain/` is our integration layer |
| `apps/web` | stage, sensing, brain | `src/net`: the shared WS client |
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

#### Most ka brainu (coach → brain preko WebSocketa)

Coach (`services/coach`, Python) i brain (`apps/brain`, Node) su odvojeni procesi.
`coach-brain-bridge.sh` ih povezuje preko WebSocketa: prati poslednju
aktivnu coach sesiju (`/v1/stream`) i šalje brainu (`/ws/control`):

- `body.metrics` → `sensor.status` (kamera ok / nema osobe, fps), uloga `sensor`;
- pravila kamere → `behavior` start/end, uloga `sensor`: kretanje → `sway`, brze ruke → `fast_hands`,
  prekrštene ruke → `arms_crossed`, ruka na licu → `face_touch`, pogled nadole → `looking_down`;
- coaching predlozi o ponašanju (ruke, kretanje, držanje, pogled, tempo, pauze, poštapalice) → crvena
  vinjeta na ekranu (`operator.override`), samo dok traje run, kad JJ ne sluša i kad run ima uključen
  feedback (baseline i test run su namerno bez feedbacka). Puls i gubitak praćenja ne pale vinjetu.

```bash
JJ_FAKE=1 corepack pnpm dev:brain             # brain → :8787
bash scripts/coach-serve.sh                    # coach → :8765
bash scripts/coach-brain-bridge.sh             # most; sam se ponovo povezuje ako nešto restartuješ
bash scripts/coach-brain-bridge.sh --force     # demo: vinjeta na svaki predlog tokom runa
bash scripts/coach-brain-bridge.sh --no-vignette   # kad je otvoren pravi operator panel (brain dozvoljava jednog)
```

Most i pravi coach sesiju: kad u aplikaciji krene prezentacija, napravi je i pokrene, pauzira je dok JJ
sluša i zaustavi je na kraju runa (`--no-sessions` isključuje to, npr. kad sesije vodi iPhone aplikacija).

**Kamera (Mac + iPhone preko Continuity Camera, YOLO26):**

```bash
bash vision/setup.sh                          # jednom
bash vision/run.sh --list-cameras             # nađi indeks kamere (iPhone ili ugrađena)
bash vision/run.sh --camera 1 --coach         # slika + tačke, šalje pokrete coachu (1 je primer)
```

Redosled: brain, `coach-serve.sh`, `coach-brain-bridge.sh`, pa kamera. Kamera se sama upari sa coachom na
istom Macu i šalje pokrete samo dok traje run. Vinjeta se pali u runu "With live feedback" (ruke, kretanje,
prekrštene ruke, ruka na licu, pogled nadole); predlozi o govoru (tempo, pauze, poštapalice) traže iPhone
aplikaciju (`apple/`), jer Mac kamera nema zvuk.

#### Podešavanje pragova kamerom (tuning)

Pragovi za telo su procene, provereni samo na sintetičkim tačkama. Podešavaju se u jednom fajlu,
`services/coach/tuning.json` (bez izmene koda): most ga čita za svaki novi run, a `coach-tune.sh` ga
primenjuje na svoju sesiju čim sačuvaš fajl. Neispravan fajl se prijavi (koji ključ i zašto) i koriste se
podrazumevane vrednosti.

```bash
bash scripts/coach-serve.sh                    # 1. coach → :8765
bash scripts/coach-tune.sh                     # 2. merenja uživo; bez aktivne sesije napravi "tune" sesiju
bash vision/run.sh --camera 1 --coach          # 3. kamera se priključi toj sesiji (1 je primer)
```

Brain i most nisu potrebni. Ako uz to radi i most, `coach-tune.sh` prati i sesiju runa iz aplikacije (svoju
tada zaustavi, pa kamera pređe na run). Ekran pokazuje, za svako ponašanje, trenutnu vrednost (`now`), prag
na kom se pali (`fires`), prag na kom se ponovo naoružava (`clears`) i stanje pravila (`ready`, `pending
1.2/3.0s`, `fired, waits to clear`, `cooldown`). Crveno = preko praga, žuto = između, zeleno = čisto.

Pred kamerom (stani kao na prezentaciji, ceo gornji deo tela u kadru). Između dva ponašanja sačekaj
~8 s: coach daje jedan predlog na 8 s (`coaching.global_min_interval_s`), pa pravilo do tada stoji na
`pending …, held back`.

1. **10 s mirno, glava gore, ruke niz telo.** Tada nastaje referenca "glava gore" (`head-up reference`,
   treba joj 5 s). `looking down` treba da bude oko 0, `arms crossed` negativan, `hand at face` iznad 0.5.
2. **Prekrsti ruke** 5 s, pa spusti. `arms crossed` treba da pređe `fires` (obično 0.3–0.5) i da `in chest
   zone` bude `yes`. Ako je vrednost `-` dok su ruke prekrštene, model ne vidi zglob: smanji
   `min_confidence_2d`. Probaj i spojene šake ispred sebe: one ne smeju da pređu prag.
3. **Ruka na bradi, nosu, obrazu**, po 3 s. `hand at face` treba da padne ispod `fires`; gestovi u visini
   grudi treba da ostanu iznad `clears`.
4. **Gledaj u papir/laptop** 5 s, pa podigni glavu. `looking down` treba da pređe `fires`, a kad podigneš
   glavu da padne ispod `clears`.
5. **Mahni rukama** i **šetaj** (brze ruke, kretanje): `fast hands` i `moving around`.

Šta menjati u `tuning.json` (`pose`):

| ponašanje | ne pali se kad treba | pali se kad ne treba |
| --- | --- | --- |
| prekrštene ruke | smanji `arms_crossed_min_cross`, povećaj `arms_crossed_max_height` | povećaj `arms_crossed_min_cross` |
| ruka na licu | povećaj `face_touch_max_distance` | smanji `face_touch_max_distance` (i `face_touch_clear_distance`) |
| pogled nadole | smanji `looking_down_min_delta` | povećaj `looking_down_min_delta` |
| brze ruke / kretanje | smanji `hand_movement_high_per_s` / `torso_movement_high_per_s` | povećaj ih |

Prag za ponovno paljenje (`*_clear_*`) mora ostati na "čistoj" strani praga (inače fajl nije ispravan).
Koliko dugo ponašanje mora da traje i pauza između dva ista predloga su u `coaching.rules`
(`sustain_s`, `cooldown_s`); `enabled: false` gasi pravilo. Kad završiš, commituj `tuning.json`.

Dokumentacija:

- [docs/api.md](docs/api.md): ugovor (REST, WebSocket, koordinate, vreme, greške, autentifikacija);
- [docs/device-setup.md](docs/device-setup.md): iPhone i Watch;
- [docs/architecture.md](docs/architecture.md): arhitektura;
- [docs/platform-notes.md](docs/platform-notes.md): proverene činjenice i ograničenja.

Generisani ugovori su u `contracts/`, a simulirani fixture u `fixtures/`.
