# Pesëqind online

Pesëqind/500 als Online-Kartenspiel fuer 2 Spieler auf getrennten Geraeten.
Ein kleiner Node.js-Server haelt den echten Spielstand und schickt jedem
Spieler nur, was er sehen darf (eigene Hand komplett, Gegner nur die Anzahl
Karten). So kann niemand per Browser-Devtools in die Hand des anderen
schauen oder unerlaubte Zuege erzwingen – die Regeln aus `shared/rules.js`
laufen identisch auf Server und Client.

## Lokal testen

```bash
npm install
npm start
```

Dann `http://localhost:3000` in zwei Browserfenstern (oder auf zwei
Geraeten im selben WLAN ueber die lokale IP) oeffnen. Ein Fenster erstellt
ein Spiel ("Neues Spiel erstellen"), bekommt einen 4-stelligen Code, das
zweite Fenster tritt mit dem Code bei ("Raum beitreten").

## Live schalten (Render, kostenlos)

1. Dieses Projekt in ein eigenes GitHub-Repo pushen (privat ist ok).
2. Auf [render.com](https://render.com) einloggen, "New +" -> "Blueprint",
   das Repo auswaehlen. Render liest `render.yaml` automatisch und
   richtet den Web-Service ein (Node, `npm install`, `npm start`).
   Alternativ manuell: "New +" -> "Web Service", Repo waehlen,
   Build Command `npm install`, Start Command `npm start`.
3. Nach dem ersten Deploy bekommt der Dienst eine URL wie
   `https://peshqin-online.onrender.com` – die kannst du direkt an Freunde
   schicken.
4. Kostenloser Tarif: der Dienst schlaeft nach ein paar Minuten Inaktivitaet
   ein und braucht beim naechsten Aufruf ~30–50 Sekunden zum Aufwachen.
   Fuer gelegentliches Spielen mit Freunden voellig ok; falls das nervt,
   reicht spaeter der kleinste bezahlte Tarif (kein Einschlafen mehr).

## Wie ein Spiel ablaeuft

- Spieler A oeffnet die Seite, traegt oben einen Namen ein, klickt "Neues
  Spiel erstellen", bekommt einen Code (z. B. `GDJQ`) und den fertigen Link
  mit "Link kopieren".
- Spieler A schickt den Link an einen Freund (WhatsApp, iMessage, egal) –
  oder der Freund sieht den Raum direkt in der Liste "Offene Räume" in der
  Lobby und klickt ihn an, ganz ohne Link/Code.
- Spieler B oeffnet den Link, der Code ist schon eingetragen, "Raum
  beitreten" klicken – das Spiel startet automatisch.
- Reisst die Verbindung WAEHREND eines laufenden Spiels ab (Handynetz,
  App-Wechsel, Bildschirm aus), verbindet der Client automatisch neu – ohne
  Obergrenze, mit hoechstens 5 s Wartezeit zwischen den Versuchen, und sofort,
  sobald man in die App/den Tab zurueckkehrt. Ein Heartbeat erkennt "scheinbar
  offene" tote Verbindungen. Faellt ein Spieler aus, bleibt fuer den anderen das
  Spielfeld sichtbar; oben erscheint nur eine kleine Leiste.
- Laedt man die Seite im SELBEN Raum neu (F5, Link), springt man automatisch
  wieder auf den eigenen Platz. Existiert der Raum nicht mehr (Server wurde neu
  gestartet / neu deployt), kommt man sauber in die Lobby zurueck. Ohne Token
  (anderes Geraet) uebernimmt man einen getrennten Platz, indem man mit
  exakt demselben Namen beitritt.
- WICHTIG: Ohne eingerichteten Speicher (Abschnitt "Spiele ueberleben Neustarts")
  liegen Spielstaende nur im Arbeitsspeicher. Dann beendet jeder neue Deploy
  (Push auf GitHub) und jedes Aufwachen aus dem Render-Schlaf laufende Spiele.
  In der Lobby und im Menue steht "Server-Version … · Speicher: …" – so sieht man,
  ob der neueste Stand laeuft und ob der Speicher aktiv ist.

## Spielregeln im Spiel (Kurzfassung der Online-Umsetzung)

- Der Startspieler bekommt IMMER 7 Karten, der andere 6; der Startspieler zieht
  im ersten Zug nicht. Naechster Starter = Gegner dessen, der die Runde beendet.
- Gruppen liegen auf der Seite ihres Besitzers. Karten, die man an eine
  FREMDE Gruppe anlegt, liegen auf der EIGENEN Seite ("↗ an Gruppe 2 …"); in der
  fremden Gruppe bleibt ein blasser Platzhalter. Punkte zaehlen je Karte fuer
  die Seite, auf der sie liegt. Strassen werden nach Rang sortiert angezeigt.
- Sobald beide Spieler zu einer Gruppe beigetragen haben, ist sie dauerhaft
  FIXIERT: nichts wird zurueckgenommen oder aufgeloest, nur noch angelegt
  (bzw. ein Joker getauscht).
- Verlauf: nennt konkrete Karten bei Auslegen/Anlegen/Tausch/Abwerfen/Aufnehmen
  (die selbst gezogene Karte sieht nur der Ziehende). Optionen: Kartennamen im
  Verlauf ausblenden, eigene Hand verdecken (Sichtschutz beim lokalen Spielen).
- Ein Joker, dessen Karte noch nicht feststeht (Farbe im Set bzw. Rang am Rand
  einer Strasse), zeigt ein "?" statt einer erfundenen Karte – sobald nur noch
  eine Moeglichkeit uebrig ist (z. B. Vierling, oder die anderen Farben liegen
  offen), wird er aufgedeckt.
- Joker am Rand einer Strasse (z. B. 10-J-Q + Joker: 9 oder K?): Er zaehlt als die
  WERTVOLLSTE erlaubte Karte (hier K = 40 Punkte), ausser diese Karte liegt gerade
  offen (Rest/Ablage) – dann zaehlt die andere Lage. Die Lage wird beim Auslegen
  bzw. Anlegen festgeschrieben: danach zeigt der Joker die konkrete Karte (z. B. Kreuz-Ass)
  und kann nur noch gegen genau diese Karte getauscht werden. In der Vorschau vor dem
  Auslegen steht dagegen noch ein "?" mit dem Hinweis "Joker zählt als …".
- "↩ Zug zurück" nimmt die letzte Aktion deines Zuges zurueck (Auslegen, Anlegen,
  Tausch, Umbauen, Ablage aufnehmen); "⟲ Alles zurücksetzen" setzt den ganzen Zug auf
  den Stand nach dem Ziehen zurueck. Das Ziehen vom Nachziehstapel selbst ist nicht
  rueckholbar (die Karte ist dann bekannt), und nach dem Abwerfen ist der Zug vorbei.
  Der Verlauf behaelt alles und vermerkt die Ruecknahme.
- Anlegen an eine Strasse geht nur UNTEN oder OBEN am Ende. Gehoert der Platz einer Karte einem
  Joker (z. B. echte 9♠ bei 8♠-Joker-Joker-J♠), muss der Joker getauscht werden – er wandert dann
  auf die Hand. Die Joker einer Strasse springen also nie still um.
- Klick auf den Ablagestapel zeigt immer eine Vorschau aller Karten; wer mit
  Aufnehmen dran ist, waehlt darin die Aufnahme-Karte.
- Am Rundenende zeigt ein Bild alle Gruppen, Anbauten und die uebrigen
  Handkarten beider Spieler samt Minuspunkten.

## Spiele ueberleben Neustarts (Persistenz)

Der Server sichert jeden Raum kurz nach jedem Zug und laedt beim Start alle Raeume
wieder. Beide Spieler kommen danach ganz normal zurueck (gleicher Link / „Weiterspielen“,
der Platz ist ueber das gespeicherte Token reserviert). Gesichert werden Haende, Tisch,
Stapel, Fixierungen, Punkte, Verlauf und Push-Abos; nicht gesichert wird nur das
„Zug zurueck“ des gerade laufenden Zuges.

Welcher Speicher benutzt wird, entscheidet der Server automatisch nach Umgebungsvariablen:

| Variablen | Speicher | Ueberlebt auf Renders Gratis-Tarif? |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Redis (REST) | **Ja** – Neustart, Deploy, Schlaf |
| `DATA_DIR=/var/data` | Datei auf dauerhafter Festplatte | Nur mit bezahlter Render-„Persistent Disk“ |
| nichts gesetzt | nur Arbeitsspeicher | Nein (wie frueher) |

**Empfohlen (kostenlos): Upstash Redis**

1. Auf [upstash.com](https://upstash.com) kostenlos registrieren, „Create Database“ (Redis), eine
   Region in Europa waehlen (z. B. Frankfurt/Irland).
2. Auf der Datenbankseite im Reiter „REST API“ die Werte `UPSTASH_REDIS_REST_URL` und
   `UPSTASH_REDIS_REST_TOKEN` kopieren.
3. In Render beim Web-Service: **Environment → Add Environment Variable** – beide Werte eintragen,
   speichern (Render startet neu).
4. In der Lobby muss jetzt „Speicher: Redis (dauerhaft)“ stehen. Der Gratis-Tarif von Upstash reicht
   fuer dieses Spiel locker (pro Zug ein paar Befehle).

Raeume ohne Aktivitaet werden nach 24 h (mit Speicher) bzw. 6 h (ohne) aufgeraeumt.

## Benachrichtigungen „du bist dran“

Stufe 1 – funktioniert sofort, solange die Seite offen ist (auch im Hintergrund-Tab / App im
Hintergrund): Ton, Vibration, Tab-Titel „● Du bist dran“ und – falls erlaubt – eine System-
Benachrichtigung. Im Menue unter **🔔 Ton & Vibration** umschaltbar: nur im Hintergrund (Standard),
immer, aus. (iPhones vibrieren im Browser nicht – das ist eine Apple-Einschraenkung.)

Stufe 2 – **Web-Push** (kommt auch bei geschlossener App / gesperrtem Handy): im Menue
**📲 Push bei geschlossener App** einschalten und die Browser-Abfrage erlauben. Der Server schickt
nur dann einen Push, wenn die App bei dir gerade nicht sichtbar oder getrennt ist (hoechstens
alle 15 s). Der Push nennt Gegner und letzte Aktion, nie Handkarten.

- Android / Desktop (Chrome, Edge, Firefox): geht direkt im Browser.
- **iPhone/iPad**: Apple erlaubt Push nur fuer Web-Apps auf dem Home-Bildschirm: in Safari
  „Teilen → Zum Home-Bildschirm“, die App von dort oeffnen, dann den Push-Schalter nutzen
  (iOS 16.4 oder neuer).
- Die Schluessel (VAPID) erzeugt der Server selbst und legt sie im Speicher ab. Ohne Speicher werden
  sie bei jedem Neustart neu erzeugt – dann muss man Push danach einmal neu einschalten. Auf Render
  deshalb Upstash einrichten (s. o.) – oder eigene Schluessel in `VAPID_PUBLIC_KEY` /
  `VAPID_PRIVATE_KEY` hinterlegen (erzeugen: `npx web-push generate-vapid-keys`). Optional
  `VAPID_SUBJECT` (`mailto:…` oder `https://…`) als Kontaktangabe.

## Zuschauer-Link

Im Spiel oben im Raum-Badge auf **👁 Zuschauer-Link** tippen und weitergeben (Link
`…/?watch=CODE`). Alternativ in der Lobby den Code eingeben und **👁 Nur zuschauen** waehlen.
Zuschauer sehen Tisch, Ablage, Punkte, Verlauf und die Anzahl der Handkarten – **keine**
Handkarten (die liegen erst am Rundenende fuer alle offen). Sie koennen nichts anklicken oder
spielen, belegen keinen Platz und verbinden sich bei Abbruechen automatisch neu. Die Spieler
sehen oben „👁 n“. Maximal 20 Zuschauer pro Raum.

## Eigene Domain statt `onrender.com`

1. **Domain waehlen**: entweder eine Subdomain deiner bestehenden
   `gbfinanzmakler.de` (z. B. `pesequind.gbfinanzmakler.de`, kostet nichts
   extra) oder eine eigene, dedizierte Domain bei einem Registrar
   (IONOS, Namecheap, INWX, ...) registrieren.
2. Im Render-Dashboard: dein Web-Service -> **Settings** -> Abschnitt
   **Custom Domains** -> **Add Custom Domain** -> gewuenschten Namen
   eingeben.
3. **Bei einer Subdomain**: Render zeigt einen CNAME-Zielwert. Beim
   DNS-Verwalter der Hauptdomain einen CNAME-Eintrag anlegen (Name z. B.
   `pesequind`, Ziel = der von Render gezeigte Wert).
   **Bei einer eigenen/Apex-Domain** (ohne Subdomain davor): Render zeigt
   eine IP (A-Record) oder empfiehlt einen ALIAS/ANAME-Eintrag, falls der
   DNS-Anbieter das unterstuetzt (z. B. Cloudflare). Zusaetzlich lohnt sich
   meist ein `www`-CNAME auf denselben Render-Wert.
4. DNS-Aenderungen brauchen ein paar Minuten bis zu 24 Stunden. Render
   zeigt den Status (`Verifying` -> `Active`) und stellt automatisch ein
   kostenloses SSL-Zertifikat aus, sobald die Domain korrekt zeigt.
5. Die alte `onrender.com`-URL funktioniert danach trotzdem weiter – man
   muss also nichts umbiegen, was schon irgendwo verschickt wurde.

## Architektur in Kuerze

- `shared/rules.js` – reine Spielregeln (Kartenwerte, Set-/Strassen-
  Erkennung, Punkte). Wird von Server UND Client eingebunden, damit beide
  garantiert dieselbe Logik anwenden.
- `server.js` – haelt pro Raum den einzigen "echten" Zustand, validiert
  jede eingehende Aktion serverseitig und sendet danach an jeden Spieler
  eine auf ihn zugeschnittene Sicht (WebSocket, Pfad `/ws`). Raeume leben
  komplett im Arbeitsspeicher – bei einem Server-Neustart sind laufende
  Spiele weg (fuer den Hobby-Rahmen okay; siehe "Naechste Ausbaustufen").
- `persist.js` – Speicher-Schicht (Redis-REST / Datei / nichts), siehe oben.
- `push.js` – Web-Push-Versand und VAPID-Schluessel; `public/sw.js` ist der zugehoerige
  Service Worker, `public/manifest.webmanifest` macht die Seite als App installierbar.
- `public/` – der Client: Lobby (Raum erstellen/beitreten), das
  Spielbrett (praktisch identisch zur Vorlage aus dem Claude-Artefakt),
  reine Anzeige- und Eingabelogik, keine eigene Spielwahrheit.

## Naechste Ausbaustufen (falls gewuenscht)

- Raum-Liste laufender Spiele zum Zuschauen (bewusst nicht oeffentlich – bisher nur per Link/Code).
- Eigene Domain + Spielerkonten, falls es oeffentlich werden soll.
