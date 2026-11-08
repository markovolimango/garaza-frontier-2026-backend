# AI Presentation Coach

Rehearse a talk with JJ, a voice coach, and a panel of AI judges. One web app plus a Node
brain; see the spec (`AI Presentation Coach — Component & Interface Spec.md`) for the system.

- **[docs/integration.md](docs/integration.md)**: how the components fit together and where each lane plugs in.
- **[docs/brain-api.md](docs/brain-api.md)**: the brain's HTTP routes and WebSocket messages.
- **[docs/extensions.md](docs/extensions.md)**: every addition beyond the spec, with timestamps. Record yours there before merging.
- **[apps/brain/src/jj/VERIFY.md](apps/brain/src/jj/VERIFY.md)**: checking JJ against real Gemini Live.

```bash
corepack pnpm install
cp .env.example .env               # JJ_FAKE=1 runs without a Gemini key
corepack pnpm test && corepack pnpm typecheck
corepack pnpm dev:brain            # brain on :8787 (watch: restarts on every code change)
corepack pnpm dev:frontend         # Lovable app on :5174, wired to the brain
```

### Agent swarm: JJ vodi tim agenata

JJ (Gemini Live) razgovara sa tobom i vodi pet agenata koji rade preko zajedničke table (`apps/brain/src/swarm/`):

| Agent | Šta radi |
| --- | --- |
| Slušalac | tokom prezentacije i Q&A sluša mikrofon (Gemini Live), piše transkript i hvata poštapalice ~1–2 s posle fraze |
| Feedback | crvena vinjeta na nalet poštapalica (2+ u 10 s) u trening runu |
| Režiser | dok pričaš planira pitanja sudija iz tvog transkripta; u Q&A postavlja dopunska pitanja na tvoj odgovor; sluša JJ-ove naloge ("neka budu strožiji", "pitaj o ceni") |
| Telo | kamera (YOLO) uživo; posle runa Gemini gleda snimak i opisuje pokrete; JJ nudi isečke |
| Izveštač | izveštaj po runu i za celu sesiju (JSON za ekran), PDF za preuzimanje |

Panel "JJ's team" na ekranu pokazuje šta koji agent radi (taster A ga skuplja). JJ-u možeš reći: "make the judges
tougher and ask me about pricing", "how many times did I say um?", "show me where I crossed my arms",
"make the final report". Bez Gemini ključa svaki agent ima rezervni put (šabloni, izveštaj iz brojki).

**Ceo test (sa ključem):**
1. `.env`: `GEMINI_API_KEY` (obavezno), `ELEVENLABS_API_KEY` (glasovi sudija; bez njega sudije pišu titl). Slušalice
   preporučene (Slušalac se gasi dok sudije pričaju, ali eho sa zvučnika može da prođe).
2. `bash scripts/demo.sh --takeover --fresh --camera N` (stari servisi iz drugih terminala se gase).
3. U browseru (`localhost:5174`): klik bilo gde (zvuk + mikrofon), ubaci PDF deck, dozvoli snimanje.
4. JJ: odgovori na pitanja; reci "make the judges tough and ask about pricing". U panelu se vidi naredba Režiseru.
5. Run 1 (Start run): pričaj sa "um/uh" i prekrsti ruke. Panel: Slušalac broji poštapalice, Telo vidi ruke,
   Režiser planira pitanja. U baseline runu nema vinjete (to je namerno).
6. Q&A: prvo pitanje treba da bude o ceni; odgovori izbegavajući broj, pa očekuj dopunsko pitanje istog sudije.
7. Izveštaj: "Coach's analysis" stiže 10–25 s posle runa; JJ u debriefu pominje šta su agenti videli.
8. Pitaj JJ "how many times did I say um?" i "show me where I crossed my arms".
9. Run 2 "With live feedback": "um um" → crvena ivica posle ~1–2 s.
10. Progress kartica → "Export report" (PDF; "Printable page" je ista strana za štampu).

Bez browsera i mikrofona, isti tok sa sintetičkim glasom (pravi Gemini, brain na posebnom portu):
`BRAIN_URL=http://127.0.0.1:18871 node e2e/swarm-live.mjs pitch.wav answer.wav` (vidi zaglavlje skripte).

### Demo: jedna komanda

```bash
bash scripts/demo.sh --camera 1     # brain, frontend, coach, most i kamera (1 je primer: bash vision/run.sh --list-cameras)
bash scripts/demo.sh --no-camera    # bez Mac kamere
bash scripts/demo.sh --fresh        # nova sesija umesto nastavka sačuvane
```

Pokreće sve redom, čeka da se svaki deo javi, zagreje ekrane u Vite-u i otvori aplikaciju. Brain radi bez
watch moda. Ako brain, frontend, coach ili most padnu, skripta ih ponovo pokrene. Ctrl+C gasi sve.
Ako su portovi zauzeti (servisi iz starih terminala), skripta kaže ko ih drži; `--takeover` ih gasi. Isto važi
za stari `coach-brain-bridge.sh` (ne drži port, ali bi brainu slao kameru umesto demo mosta).
Ostale opcije: `--force` (vinjeta na svaki predlog), `--no-coach`, `--no-open`, `--dev`. Logovi su u
`data/demo-logs/`. Kameru možeš upisati u `.env` kao `DEMO_CAMERA=1`; `BRAIN_PORT` i `BRAIN_FRESH` se takođe
čitaju iz `.env`.

**Sesija se čuva na disk** (`data/sessions/`): runovi, izveštaji, coach i deck ostaju posle restarta
braina. Run koji je bio u toku se prekida, a sesija nastavlja od izveštaja poslednjeg runa. Za novu
sesiju koristi `--fresh` (stara ostaje na disku) ili dugme **Delete and start over** na kartici Progress
(= `curl -X POST localhost:8787/api/session/reset`): to **briše** prethodnu sesiju sa diska (runovi,
izveštaji, lični ciljevi, slajdovi) i njene coach sesije iz memorije. `{"keepData": true}` je zadržava,
`{"full": false}` zadržava deck i preskače JJ-ov uvod (ništa ne briše).

**Tok:** "Talk to JJ first →" na početnom ekranu počinje sesiju i pre deck-a (JJ pita šta želiš da
popraviš, uz mogućnost da preskočiš, pa traži slajdove: "Upload slides (PDF)" na JJ-ovom ekranu); run traži deck.
Kad kažeš da si gotov ("kraj"), JJ pokaže finalni izveštaj sa brojevima prvi → poslednji run.
**Export report** (`GET /api/session/export.html`) je stranica za štampu/PDF za šefa: samo izmereno
ponašanje, bez ličnih ciljeva.

**Deck:** PDF ili PowerPoint (`.pptx`). `.pptx` pretvara Microsoft PowerPoint na ovom Macu (otvori se u pozadini,
~3 s; prvi put macOS pita da li terminal sme da upravlja PowerPoint-om) i zadržava trajanja slajdova iz `.pptx`
(Transitions → After) kao tajminge prezentera. Bez PowerPoint-a: File → Export → PDF. Test: `pnpm e2e:pptx`.

**Pre runa:** kartica "Before you start" (JJ-ov ekran i izveštaj, između runova) pokazuje da li te kamera vidi
(bridge između runova drži "standby" coach sesiju samo za status kamere), da li mikrofon radi (nivo) i da li se
snima. Ne blokira run; ako nešto ne radi, `start_run` JJ-u vrati `not_measured` i on to kaže u jednoj rečenici.
API: `GET /api/sensors/check`.

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
- epizode ponašanja (`behavior.episode`, svaka pojava sa svojim početkom i krajem) → `behavior` start/end,
  uloga `sensor`, samo dok traje run: kretanje → `sway`, brze ruke → `fast_hands`, prekrštene ruke →
  `arms_crossed`, ruka na licu → `face_touch`, pogled nadole → `looking_down`, nagnuta glava → `head_tilt`,
  ruke u džepovima → `hands_in_pockets`. Poslednja dva nemaju coaching pravilo: idu samo u izveštaj, bez vinjete;
- coaching predlozi → `coach.observation` (izveštaj runa i JJ-ov izbor ciljeva) i crvena vinjeta na ekranu
  (`operator.override`) za ponašanje (ruke, kretanje, držanje, pogled, tempo, pauze, poštapalice), samo dok
  traje run, kad JJ ne sluša i kad run ima uključen feedback (baseline i test run su namerno bez feedbacka);
  ako run ima ciljeve, samo za njih. Kad epizoda cilja prestane, zelena vinjeta. Puls i gubitak praćenja ne
  pale vinjetu.

```bash
JJ_FAKE=1 corepack pnpm dev:brain             # brain → :8787
bash scripts/coach-serve.sh                    # coach → :8765
bash scripts/coach-brain-bridge.sh             # most; sam se ponovo povezuje ako nešto restartuješ
bash scripts/coach-brain-bridge.sh --force     # demo: vinjeta na svaki predlog tokom runa
bash scripts/coach-brain-bridge.sh --no-vignette   # kad je otvoren pravi operator panel (brain dozvoljava jednog)
```

Most i pravi coach sesije: kad u aplikaciji krene prezentacija, napravi sesiju runa i pokrene je, pauzira je
dok JJ sluša i zaustavi je na kraju runa. Između runova (JJ-ov uvod, debrief) drži "standby" sesiju samo za
status kamere (kartica "Before you start"); ponašanja, predlozi i vinjete idu brainu samo iz runa. Posle
restarta coacha ili isteka sesije most sam napravi novu. `--no-sessions` isključuje sve to (npr. kad sesije
vodi iPhone aplikacija).

**Kamera (Mac + iPhone preko Continuity Camera, YOLO26):**

```bash
bash vision/setup.sh                          # jednom
bash vision/run.sh --list-cameras             # nađi indeks kamere (iPhone ili ugrađena)
bash vision/run.sh --camera 1 --coach         # slika + tačke, šalje pokrete coachu (1 je primer)
```

Redosled: brain, `coach-serve.sh`, `coach-brain-bridge.sh`, pa kamera. Kamera se sama upari sa coachom na
istom Macu i šalje pokrete dok postoji coach sesija: u runu i između runova (standby, za proveru kamere).
Vinjeta se pali u runu "With live feedback" (ruke, kretanje, prekrštene ruke, ruka na licu, pogled nadole);
nagnuta glava i ruke u džepovima su samo u izveštaju. Predlozi o govoru (tempo, pauze, poštapalice) traže
iPhone aplikaciju (`apple/`), jer Mac kamera nema zvuk.

#### Podešavanje pragova kamerom (tuning)

Pragovi za telo su procene, provereni samo na sintetičkim tačkama. Podešavaju se u jednom fajlu,
`services/coach/tuning.json` (bez izmene koda): most ga čita za svaku novu sesiju (run i standby), a
`coach-tune.sh` ga primenjuje na svoju sesiju čim sačuvaš fajl. Neispravan fajl se prijavi (koji ključ i
zašto) i koriste se podrazumevane vrednosti.

```bash
bash scripts/coach-serve.sh                    # 1. coach → :8765
bash scripts/coach-tune.sh                     # 2. merenja uživo; bez aktivne sesije napravi "tune" sesiju
bash vision/run.sh --camera 1 --coach          # 3. kamera se priključi toj sesiji (1 je primer)
```

Brain i most nisu potrebni. Ako uz to radi i most, kameru drži njegova sesija (standby između runova, pa sesija
runa): `coach-tune.sh` prati nju umesto svoje, pa izmena `tuning.json` važi tek od sledećeg runa. Za podešavanje
uživo zaustavi most (ili `demo.sh`) dok podešavaš. Ekran pokazuje, za svako ponašanje, trenutnu vrednost (`now`), prag
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
- [docs/brain-api.md](docs/brain-api.md): rute i poruke braina (`apps/brain`);
- [docs/device-setup.md](docs/device-setup.md): iPhone i Watch;
- [docs/architecture.md](docs/architecture.md): arhitektura;
- [docs/platform-notes.md](docs/platform-notes.md): proverene činjenice i ograničenja.

Generisani ugovori su u `contracts/`, a simulirani fixture u `fixtures/`.
