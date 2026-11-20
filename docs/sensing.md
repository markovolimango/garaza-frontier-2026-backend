# Sensing: coach, vision, apple

### Vision: praćenje položaja tela (iPhone + Mac)

Lokalni prototip: iPhone (Continuity Camera) je kamera, a Mac sa Apple Silicon čipom pokreće
YOLO26 pose model i prikazuje 17 tačaka tela, FPS i uređaj (MPS/CPU). Opciono beleži
koordinate. Detalji, povezivanje telefona i rešavanje problema su u [vision/README.md](../vision/README.md).

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

- [docs/api.md](api.md): ugovor (REST, WebSocket, koordinate, vreme, greške, autentifikacija);
- [docs/brain-api.md](brain-api.md): rute i poruke braina (`apps/brain`);
- [docs/device-setup.md](device-setup.md): iPhone i Watch;
- [docs/architecture.md](architecture.md): arhitektura;
- [docs/platform-notes.md](platform-notes.md): proverene činjenice i ograničenja.

Generisani ugovori su u `contracts/`, a simulirani fixture u `fixtures/`.
