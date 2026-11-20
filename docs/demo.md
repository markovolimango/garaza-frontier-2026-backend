# Demo, agent swarm i pitch mod

Uputstva za pokretanje celog sistema za demo (preuzeto iz starog README-a).
Za razvoj vidi [README](../README.md).

## Agent swarm: JJ vodi tim agenata

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

## Pitch mod: dashboard posle pitch-a (demo na bini)

JJ ćuti; samo ispričaš pitch, pa jednim klikom dobiješ dashboard: trajanje, tempo (reči u minuti), poštapalice
sa vremenskom linijom, govor tela (kamera) i analizu JJ-ovog tima.

```bash
bash scripts/demo.sh --pitch --camera N    # otvori http://localhost:5174/pitch
```

1. **Start listening** (klik pali mikrofon; kvačica "Record" uključuje snimak za analizu pokreta).
2. Pričaj. Nema odbrojavanja, slajdova ni pitanja sudija; "Hey JJ" ne prekida.
3. **Show dashboard** (ili taster D). Brojke su odmah tu, poštapalice stižu za par sekundi, a analiza
   10–25 s posle (dok se piše, piše "The reporter is writing…"). **New pitch** za sledeći.

**Kamera** meri telo samo kad vidi ramena **i kukove**: za laptopom (kukovi ispod stola) ne vidi ništa, pa stani
~2 m od kamere. Ekran pokazuje status kamere pre i tokom govora; ako te kamera nije videla, dashboard to kaže
("camera saw you N% of the time") umesto da prijavi čist govor tela.

Bez Gemini ključa nema transkripta (tempo i poštapalice "—"), ostalo radi. API: `/api/pitch/*`
([docs/brain-api.md](brain-api.md)). Testovi: `pnpm e2e:pitch` (browser, lažna kamera) i
`node e2e/pitch-live.mjs pitch.wav` (pravi Gemini, glas iz WAV-a; vidi zaglavlje skripte).

## Demo: jedna komanda

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
