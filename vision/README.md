# vision — praćenje položaja tela (iPhone kamera + Mac)

Lokalni prototip: iPhone 14 Pro služi kao kamera (Apple Continuity Camera), a MacBook
(M1 Pro) radi obradu. U prozoru se vide živa slika, 17 tačaka tela sa vezama, izmereni FPS
i uređaj na kome model zaista radi (MPS ili CPU). Opciono se beleže koordinate tačaka.

Model: Ultralytics **YOLO26 pose** (`yolo26n-pose.pt`, opciono `yolo26s-pose.pt`), već
istrenirane težine. Sve se izvršava lokalno; internet je potreban samo za setup i prvo
preuzimanje modela. Ultralytics analitika (`sync`) je isključena u lokalnim podešavanjima
`vision/.ultralytics/`.

## Brzi početak (iz korena repoa)

```bash
bash vision/setup.sh                          # okruženje, zavisnosti, model, provere
bash vision/run.sh --list-cameras             # koji indeksi kamera rade
bash vision/run.sh --camera 1 --preview-only  # samo slika, bez modela — potvrdi da je to iPhone
bash vision/run.sh --camera 1                 # slika + tačke
bash vision/run.sh --camera 1 --model s       # veći model (prvi put se preuzima)
bash vision/run.sh --camera 1 --save-points   # + beleženje koordinata
bash vision/run.sh --camera 1 --coach         # + slanje poza coach backendu (services/coach)
```

Broj `1` je samo primer — pravi broj biraš u koraku 3.

## 1. Povezivanje iPhone-a (Continuity Camera)

1. Oba uređaja na **istom Apple nalogu** (Apple Account), sa uključenom dvofaktorskom
   zaštitom. Potrebni su iOS 16+ i macOS 13+.
2. Na iPhone-u: **Settings → General → AirPlay & Continuity** (na starijem iOS-u
   „AirPlay & Handoff”) → uključi **Continuity Camera**.
3. Uključi **Wi-Fi i Bluetooth** na oba uređaja i drži ih blizu. iPhone ne sme da deli
   mobilni internet (Personal Hotspot), a Mac ne sme da deli internet konekciju (Internet
   Sharing). Ako ne radi, proveri i da je Handoff uključen na Macu
   (System Settings → General → AirDrop & Handoff).
4. Poveži telefon **USB-C–Lightning kablom koji prenosi podatke**. Na telefonu prihvati
   **Trust This Computer**, a na Macu „Allow accessory to connect” ako se pojavi.
   Kabl daje stabilniju vezu i puni telefon; Wi-Fi, Bluetooth i isti nalog i dalje su potrebni.
5. Postavi telefon **stabilno** (stalak), horizontalno, **zadnjom kamerom prema sebi**,
   sa zaključanim ekranom. Celo telo i zglobovi treba da budu u kadru, uz dobro osvetljenje.
6. Proveri sliku u **FaceTime-u**: meni **Video** → izaberi iPhone kameru. Kada vidiš
   sliku, **zatvori FaceTime (Cmd+Q)** pre pokretanja programa, da kamera ne bi bila zauzeta.
7. U Control Center → Video Effects isključi Center Stage, Portrait, Studio Light i Reactions,
   da ne bi menjali kadar.

## 2. Dozvola za kameru (macOS)

- Dozvolu dobija **aplikacija iz koje pokrećeš komandu**: Terminal, iTerm ili VS Code
  (ili drugi IDE), a ne sam Python.
- Prvi put macOS prikaže pitanje. Program tada prijavi da dozvola još nije data: klikni
  **Allow**, pa ponovo pokreni istu komandu.
- Ako je pristup odbijen: **System Settings → Privacy & Security → Camera** → uključi
  Terminal (ili IDE), potpuno zatvori tu aplikaciju i otvori je ponovo.
- `tccutil reset Camera com.apple.Terminal` vraća odluku za Terminal na početno stanje
  (macOS će ponovo pitati). Program ne menja sistemske ni bezbednosne postavke.

## 3. Izbor pravog broja kamere

```bash
bash vision/run.sh --list-cameras
```

Proverava indekse 0–4 redom (najviše ~5 s po indeksu, svaki uređaj se odmah oslobađa) i za
svaki prijavi da li daje sliku i u kojoj rezoluciji. Staje čim OpenCV prijavi da indeks ne
postoji. Za više uređaja: `--list-cameras --max-index 8`.

- **iPhone nije uvek kamera 1.** OpenCV 4.x ređa AVFoundation uređaje po njihovom
  jedinstvenom ID-ju, pa iPhone može da bude 0, 1, 2…. Dodavanje ili uklanjanje uređaja
  (virtuelne kamere, Camo, OBS, spoljna kamera) može da promeni raspored.
- Ako macOS navodi tačno onoliko kamera koliko vidi OpenCV, pored indeksa piše i
  **izvedeni** naziv (`~ FaceTime HD Camera`). Taj naziv je zaključen iz istog redosleda,
  pa ga obavezno potvrdi preview-om. Ako se brojevi ne poklapaju, naziv se ne prikazuje.
  Continuity Camera se često ne pojavljuje u listi koju vraća macOS.
- **Potvrda:** za svaki indeks sa `OK` pokreni
  `bash vision/run.sh --camera N --preview-only`, pa pokrij zadnju kameru telefona prstom
  ili pomeri telefon. Pravi indeks odmah reaguje. Ugrađena kamera Maca uključuje zeleno
  svetlo pored sebe.
- Posle ponovnog povezivanja telefona ponovi `--list-cameras`.

## 4. Šta se vidi u prozoru

| Prikaz | Značenje |
|---|---|
| `24.8 FPS` | Obrađeni i prikazani frejmovi u sekundi, cela putanja kamera → model → ekran, poslednjih 30 frejmova. Ovo nije deklarisanih 30 FPS kamere niti samo brzina modela. |
| `MPS` / `CPU` / `CPU (MPS fallback)` | Uređaj na kome model zaista radi. |
| `model 15 ms/frame` | Samo inference i izdvajanje tačaka. |
| `camera in 30 fps` | Izmerena brzina pristizanja frejmova sa kamere. |
| `people N`, `No person detected` | Broj detekcija u trenutnom frejmu. Kada osoba nije detektovana, rad se nastavlja. |
| `REC points` | Uključeno je `--save-points`. |

- Boje: **plava** je leva strana tela osobe, **narandžasta** desna, a **bela** sredina i veze
  preko tela. Kod nezrcaljene zadnje kamere leva strana osobe je na desnoj strani slike.
- Tačke ispod `--keypoint-conf` (podrazumevano 0.5) se ne crtaju, a veza se crta samo kada
  su oba kraja validna.
- Nema vremenskog izglađivanja: svaki frejm je nezavisna procena modela, pa blago treperenje
  pokazuje stvarnu nesigurnost.
- `--mirror` prikazuje sliku kao u ogledalu. Tačke se okreću zajedno sa slikom, a zapisane
  koordinate ostaju u nezrcaljenoj slici.
- Izlaz: **Q** ili **Esc** (prvo klikni na prozor), zatvaranje prozora ili **Ctrl+C** u
  terminalu. Ne minimizuj prozor tokom rada, jer ga macOS tada može prijaviti kao nevidljiv,
  pa se program zatvori.
- Ako kamera ne pošalje nijedan frejm `--frame-timeout` sekundi (podrazumevano 5), program se
  zaustavlja sa porukom. Kamera se oslobađa, a fajlovi sesije se zatvaraju.
- Pri svakom startu sa modelom program pokrene model na zvaničnoj Ultralytics test slici
  (`bus.jpg`) na MPS-u i na CPU-u i uporedi rezultate. Ako MPS ne radi ili odstupa,
  `--device auto` prelazi na CPU i ispisuje razlog. Eksplicitno: `--device mps` ili `--device cpu`.

Ostale opcije: `--imgsz 640` (manja vrednost, npr. 480, je brža, ali slabija za male ili
udaljene osobe) i `--det-conf 0.25` (prag detekcije osobe). Sve opcije prikazuje
`bash vision/run.sh --help`.

## 5. Beleženje tačaka (`--save-points`)

Svako pokretanje pravi **novi** folder, a ranije sesije se nikad ne prepisuju:

```
vision/sessions/2026-11-07_20-33-20_cam1_yolo26n-pose/
  session.json   metapodaci; na kraju dobija status: completed | incomplete | interrupted | error
  frames.jsonl   jedan JSON red po frejmu koji je prošao kroz model
```

`session.json` sadrži vreme početka (UTC i lokalno), model (putanja, veličina, sha256,
imgsz), verzije Python-a, PyTorch-a, torchvision-a, Ultralytics-a, OpenCV-a i NumPy-ja,
aktivni uređaj sa rezultatom MPS provere, indeks kamere sa traženom i stvarnom rezolucijom,
prag poverenja, nazive tačaka, veze kostura i opis koordinata i vremena. Na kraju dobija i
`frames_written`, `duration_s` i razlog završetka.

Primer reda u `frames.jsonl` (skraćeno):

```json
{"frame_index":0,"t":0.073086,"camera_seq":2,"width":1280,"height":720,
 "people":[{"detection_index":0,"score":0.8566,"box_xyxy":[733.58,41.65,1127.14,711.2],
   "keypoints":[{"name":"nose","x":999.34,"y":194.07,"confidence":0.9981,"valid":true},
                {"name":"left_ear","x":1044.32,"y":187.15,"confidence":0.1808,"valid":false}, ...]}]}
```

- **Koordinate** su u pikselima originalne, nezrcaljene slike, sa početkom u gornjem levom
  uglu (x raste udesno, y nadole).
- **`t`** je broj sekundi od početka sesije po monotonom satu Maca. Meri se u niti kamere
  odmah nakon prijema frejma, pre inference-a. To je **vreme prijema na Macu, a ne vreme
  ekspozicije senzora na iPhone-u**: snimanje, prenos i dekodiranje dolaze pre njega.
- **`camera_seq`** je redni broj frejma primljenog sa kamere. Praznine pokazuju frejmove
  koji su preskočeni jer je prethodni još bio u obradi. Zapis obuhvata svaki frejm koji je
  prošao kroz model; prozor prikazuje samo najnoviji rezultat, pa neki zabeleženi frejmovi
  nikad nisu bili prikazani. To **nije video snimak niti zapis svakog frejma kamere**, i slike
  se ne čuvaju.
- **`valid: false`** znači da je confidence ispod praga, da vrednost nije konačan broj ili da
  je tačka van slike. `x`/`y` su tada sirova procena modela (ili `null`) i **ne treba ih
  koristiti kao izmerenu poziciju**. JSON ne sadrži NaN ni Infinity.
- **`detection_index`** je samo redosled detekcija unutar jednog frejma. Praćenje identiteta
  ne postoji, pa isti broj u dva frejma ne mora biti ista osoba.
- Frejmovi bez detekcija se beleže sa `"people": []`.
- Redovi se upisuju odmah. Pri Ctrl+C ili grešci fajl se zatvara, a `session.json` dobija status.
- Ako se nit za inference ne zaustavi na vreme (zaglavljen poziv modela), sesija dobija status
  `incomplete` i `worker_stopped: false`; kasniji upisi se odbacuju i broje u `late_writes_dropped`.
- Veličina je ~1,4 KB po osobi po frejmu, oko 150 MB na sat za jednu osobu pri 30 fps.

Čitanje u Python-u:

```python
import json
with open("vision/sessions/<folder>/frames.jsonl") as f:
    for line in f:
        frame = json.loads(line)
        for person in frame["people"]:
            wrist = person["keypoints"][9]          # left_wrist
            if wrist["valid"]:
                print(frame["t"], wrist["x"], wrist["y"])
```

## 5a. Slanje poza coach backendu (`--coach`)

`--coach` šalje svaki frejm koji je prošao kroz model kao `pose.frame` događaj na
`/v1/ingest` servisa `services/coach` (ugovor: `services/coach/coach/wire.py`, `docs/api.md`).
Tako `vision/` može da zameni ili dopuni pozu sa iPhone aplikacije (Apple Vision).

```bash
bash scripts/coach-serve.sh                    # backend na localhost:8765 (drugi terminal)
# napravi i pokreni sesiju (npr. POST /v1/sessions, pa /start), zatim:
bash vision/run.sh --camera 1 --coach          # backend na ovom Macu, uparivanje automatsko
bash vision/run.sh --camera 1 --coach https://mac.local:8765 --coach-code 12345678   # drugi računar
```

- **Uparivanje:** na istom Macu se operatorski token čita iz `COACH_API_TOKEN` ili
  `services/coach/.runtime/api_token` (`COACH_RUNTIME_DIR` menja folder); kod za uparivanje se
  pravi i menja za token uređaja automatski. Za backend na drugom računaru prosledi kod iz
  `POST /v1/pairing-codes` (`--coach-code`, jednokratan, važi 5 minuta). Uređaj je
  `kind: mac`, `device_id: mac-vision-<heš imena računara>`, `simulated: false`.
- **Sesija:** pridružuje se najnovijoj sesiji koja nije završena i ponavlja `join` na 2 s dok
  sesije nema ili je završena. Poze se šalju samo dok je sesija `running`, najviše
  `pose_rate_hz` puta u sekundi (iz kontrolne poruke sesije, podrazumevano 12).
- **Sadržaj:** `mode: 2d`, jedna osoba (najveći zbir confidence-a validnih tačaka),
  `persons_detected` za sve detekcije, `tracking_state: tracking | no_person`. Šalju se samo
  tačke sa `valid: true`, sa COCO imenima (`nose`, `left_wrist`, …) koja su ista kao Vision
  imena, u koordinatama 0..1 sa početkom gore levo. `captured_at` je vreme prijema frejma na
  Macu. `dropped_frames_since_last` broji frejmove kamere koji nisu poslati.
- **Nikad ne blokira prikaz:** mrežni rad je u posebnoj niti sa malim redom (čuva najnovije,
  najstarije odbacuje); zastareli frejmovi (> 1 s) se ne šalju, a pri backpressure-u ide samo
  najnoviji. Ako backend nije dostupan, aplikacija radi dalje, HUD pokazuje
  `coach: offline: …`, a veza se ponovo uspostavlja (0,5–10 s).

## 6. Dijagnostika i održavanje

```bash
bash vision/run.sh --doctor     # OS, arhitektura, Python, verzije, MPS, OpenCV GUI/AVFoundation, model (bez kamere)
bash vision/run.sh --selftest   # model, inference CPU i MPS na test slikama, JSONL, simulirana kamera
bash vision/setup.sh --model s  # unapred preuzmi i proveri yolo26s-pose.pt
bash vision/setup.sh --upgrade  # nove dozvoljene verzije; lock fajl se menja samo ako provere prođu
```

`setup.sh` se može pokretati više puta: ponovo koristi `vision/.venv`, instalira verzije iz
`requirements.lock.txt`, proverava da instalirane verzije zaista odgovaraju lock fajlu i ne
preuzima ponovo model koji već postoji. Iz Rosetta (x86_64) terminala pokreće Python sa
`arch -arm64`, pa ispravno okruženje ne briše.

**Integritet modela:** veličina i SHA-256 za `yolo26n-pose.pt` i `yolo26s-pose.pt` su fiksirani
u `pose_engine.py` (`MODEL_PINS`, vrednosti koje GitHub objavljuje za Ultralytics release
`v8.4.0`), a preuzima se samo sa tog release-a. Fajl se proverava posle preuzimanja i pre
svakog učitavanja; `--doctor` poredi heš sa fiksiranim. Samo fajl koji ne prođe proveru
(drugi heš, skraćen ili nečitljiv zip) sklanja se u `*.bad` i preuzima ponovo. Ako proveren
fajl ne može da se učita (npr. nekompatibilan torch), fajl ostaje na mestu i ispisuje se jasna
greška. Drugi interpreter za novo
okruženje: `PYTHON=/putanja/do/python3.12 bash vision/setup.sh`, ali tek kada ukloniš postojeći
`vision/.venv`, jer se ispravno okruženje ne pravi iznova.

## 7. Rešavanje problema

**Kamera radi u FaceTime-u, ali ne kroz OpenCV**

1. Zatvori FaceTime i sve što može da koristi kameru (Zoom, Teams, Photo Booth, tabovi
   u browser-u).
2. Pokreni `bash vision/run.sh --list-cameras` i pročitaj poruku:
   - „camera access has been denied” znači da treba dati dozvolu (korak 2);
   - „has just asked for camera permission” znači klikni Allow i ponovi;
   - „OpenCV sees N camera device(s)”: ako je broj isti kao bez telefona, OpenCV ne vidi iPhone.
3. Uporedi listu iz `bash vision/run.sh --doctor` (šta vidi macOS) sa
   `--list-cameras` (šta vidi OpenCV). Probaj i `--max-index 8`.
4. Poveži telefon kablom, ponovo potvrdi Trust i zaključaj telefon. U podešavanjima
   iPhone-a isključi pa uključi Continuity Camera.
5. Pokreni iz Terminal.app umesto iz IDE-a (ili obrnuto), jer su dozvole vezane za aplikaciju.
6. OpenCV 4.x na macOS-u nabraja kamere starijim AVFoundation pozivom
   (`devicesWithMediaType`). FaceTime koristi novije API-je, a novije verzije macOS-a
   Continuity Camera tretiraju kao poseban tip uređaja koji aplikacija može da deklariše u
   svom `Info.plist`. Python iz terminala nema svoj `Info.plist`. Ovaj projekat namerno ne
   menja sistemske `Info.plist` fajlove niti bezbednosna podešavanja. Ako iPhone ni posle
   koraka 1–5 nije među indeksima, radi se o ograničenju kombinacije OpenCV/macOS. Rezervne
   opcije su aplikacija koja telefon izlaže kao običnu kameru (npr. Camo) ili, kasnije,
   nativni AVFoundation čitač u ovom modulu.

**„No frames from camera …”**: telefon je otključan ili udaljen, primio je poziv, kabl je
izvučen ili je druga aplikacija preuzela kameru. Ponovo poveži telefon i pokreni program.

**MPS problem**: `bash vision/run.sh --doctor`, zatim `--device cpu`.

**Nizak FPS**: uporedi `FPS` sa `camera in` i `model ms`. Probaj `--model n` ili
`--imgsz 480`. Na macOS-u svaki `cv2.waitKey` traje najmanje ~10 ms, pa model radi u posebnoj
niti, a glavna nit samo prikazuje sliku.

## 8. Struktura

| Fajl | Uloga |
|---|---|
| `app.py` | CLI, kamera → model → prikaz, nit za inference, HUD |
| `camera_input.py` | AVFoundation kamera, nit sa poslednjim frejmom, timeout-i, `--list-cameras` |
| `pose_engine.py` | putanje, preuzimanje i validacija modela, izbor i provera uređaja, izdvajanje tačaka |
| `session_log.py` | `session.json` + `frames.jsonl` |
| `coach_link.py` | `--coach`: uparivanje, `/v1/ingest`, COCO → `PoseFramePayload`, nit za slanje |
| `doctor.py`, `selftest.py` | dijagnostika i provere bez kamere |
| `setup.sh`, `run.sh` | setup i pokretanje iz bilo kog direktorijuma, i kada putanja sadrži razmake |
| `requirements.txt` / `requirements.lock.txt` | direktne zavisnosti / tačno provereno okruženje |
| `models/`, `sessions/`, `.venv/`, `.ultralytics/` | lokalno, van Git-a |

Putanje do modela i sesija računaju se u odnosu na `vision/`, nezavisno od radnog direktorijuma.

## 9. Provereno okruženje

macOS 26.7.2, Apple M1 Pro, Python 3.13.18 (arm64, uv-managed; Python 3.12 nije bio
instaliran), torch 2.14.1, torchvision 0.29.2, ultralytics 8.4.205, opencv-python 4.14.0.94,
numpy 2.5.4. Tačan spisak je u `requirements.lock.txt`.

- torch je ograničen na 2.14.x jer je torchvision 0.29 par za tu verziju.
- OpenCV ostaje na 4.x liniji: 5.0 je nova glavna verzija, a ima isti kod za AVFoundation kamere.

Provereno je bez kamere:

- model se preuzima i učitava;
- inference na Ultralytics slikama `bus.jpg` i `zidane.jpg` radi na CPU-u i na MPS-u;
- MPS izlaz se poklapa sa CPU-om (najveća razlika je ~0,0002 px);
- slika bez osoba daje `people: []`;
- JSONL je ispravan, a upis posle zatvaranja (zaglavljena nit) se bezbedno odbacuje;
- SHA-256 provera modela i pravila za `*.bad` i ponovno preuzimanje (privremene kopije);
- `--coach` od kraja do kraja sa pravim `services/coach` backendom na privremenom portu 8797 i
  sintetičkim tačkama: događaji su prihvaćeni kao `pose.frame`, a `body.metrics` daje
  `tracking_state: tracking`;
- kamera se oslobađa pri grešci, Ctrl+C i SIGTERM, što je provereno sa **simuliranom** kamerom.

Stvarna iPhone kamera i macOS dozvola za kameru nisu testirane i proveravaju se ručno.
