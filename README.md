# Pesëqind online

**Pesëqind (500) – das Balkan-Rommé als Online-Kartenspiel für 2 Spieler.**
Raum erstellen, Link schicken, auf zwei Handys oder PCs gegeneinander spielen.

Ein kleiner Node.js-Server hält den einzigen echten Spielstand und schickt jedem Spieler nur, was
er sehen darf: die eigene Hand komplett, vom Gegner nur die Anzahl der Karten. Niemand kann per
Browser-Devtools in fremde Karten schauen oder unerlaubte Züge erzwingen. Die Regeln in
`shared/rules.js` laufen identisch auf Server und Client.

---

## Funktionen

- **Räume per Code oder Link**, Liste offener Räume in der Lobby, Spielernamen
- **Gegen den Computer** in drei Stufen (Leicht / Normal / Schwer) – direkt aus der Lobby
- **Aufgeben** jederzeit über das Menü ⋯
- **Bedenkzeit mit Fischer-Bonus** (z. B. 5 Min + 3 s pro Zug) und **Vorgabe** in Punkten
- **Automatisches Wiederverbinden** bei Netzabbruch, App-Wechsel oder F5 – der Platz bleibt reserviert
- **Kartenmodell mit Server-Prüfung** – jede Karte gibt es genau einmal, Joker stehen für eine feste Karte, Gruppen behalten ihre Art
- **Auswahl-Menü für Joker** – kann ein Joker mehrere Karten sein, wählt der Spieler (beste Wahl steht oben)
- **Straße Ass-2-3-4** mit echter 2 (Ass und 2 zählen dort je 5 Punkte)
- **Zug zurück / Alles zurücksetzen** innerhalb des eigenen Zuges
- **Verlauf** mit konkreten Karten, Filter „Nur Tisch“, Rundenende-Bild mit Minuspunkten
- **Hand sortieren** (Farbe / Rang / wie gezogen), große Karten fürs Handy, Sichtschutz für die eigene Hand
- **„Du bist dran“** per Ton, Vibration und Web-Push (auch bei geschlossener App)
- **Zuschauer-Link** (read-only, ohne Handkarten)
- **Speicher (optional)**: laufende Spiele überleben Neustarts und Deploys (Upstash Redis, kostenlos)
- **Versions-Anzeige** klein unten rechts – so sieht man sofort, ob der neueste Stand läuft

---

## Neu einrichten (GitHub + Render) – Schritt für Schritt

### 1. GitHub-Repo anlegen
1. Auf github.com: **New repository**, Name z. B. `peseqind-online`, privat oder öffentlich.
   **Kein** README, keine .gitignore, keine Lizenz anhaken (die liegen schon im Projekt).
2. Das Zip **entpacken**. Den entpackten Ordner öffnen – darin liegen direkt
   `server.js`, `package.json`, `persist.js`, `push.js`, `render.yaml`, `README.md`
   und die Ordner `public/` und `shared/`.
3. Im neuen Repo: **uploading an existing file** (bzw. *Add file → Upload files*) und den
   **Inhalt** dieses Ordners hineinziehen – **nicht** das Zip, **nicht** den Ordner selbst.
   Unten **Commit changes**.
4. **Kontrolle:** Auf der Startseite des Repos muss `server.js` direkt in der Liste stehen.
   Steht dort nur ein Ordner, liegen die Dateien eine Ebene zu tief – dann findet Render sie nicht.

### 2. Render-Dienst anlegen
1. Auf [render.com](https://render.com): alten Dienst löschen (Settings → ganz unten *Delete Web Service*),
   damit nichts verwechselt wird.
2. **New + → Blueprint**, das neue Repo wählen. Render liest `render.yaml` und richtet alles ein
   (Node, `npm install`, `npm start`).
   Alternativ: **New + → Web Service**, Repo wählen, Build Command `npm install`, Start Command `npm start`.
3. Warten, bis der Deploy grün ist, dann die URL öffnen (z. B. `https://peseqind-online.onrender.com`).
4. **Kontrolle:** unten rechts steht klein die Version (z. B. `v2026-10-09.13`).
   Fehlt sie oder ist sie älter, läuft nicht der aktuelle Stand.

### 3. Updates später
Neue Dateien genauso über *Add file → Upload files* in den **Hauptordner** des Repos ziehen
(vorhandene werden überschrieben) und committen – Render baut automatisch neu.
Klemmt es: in Render **Manual Deploy → Clear build cache & deploy**.
Ohne eingerichteten Speicher (siehe unten) beendet jeder Deploy laufende Spiele.

### Lokal testen (optional)
```bash
npm install
npm start
```
Dann `http://localhost:3000` in zwei Browserfenstern öffnen.

---

## Spielregeln der Online-Version (Kurzfassung)

Das vollständige Regelbuch liegt als `Regelbuch.pdf` im Repo. Die wichtigsten Punkte:

**Material und Verteilung**
- Ein Blatt mit 3 bis Ass in vier Farben plus vier Zweien. **Die Zweien sind Joker.**
- Der Startspieler bekommt 7 Karten und zieht im ersten Zug nicht, der andere bekommt 6.
  Nächster Starter ist der Gegner dessen, der die Runde beendet hat.

**Gruppen**
- **Satz**: 3 oder 4 Karten gleichen Rangs in verschiedenen Farben.
- **Straße**: mindestens 4 aufeinanderfolgende Karten einer Farbe.
  Das Ass steht unten (**Ass-2-3-4 …**) oder oben (… Dame-König-Ass), kein Rundlauf (König-Ass-2).
- **Echte 2**: Eine 2 in einer Straße ihrer eigenen Farbe auf dem Platz der 2 ist eine echte 2, kein Joker.
- **Jokergruppe**: 3 oder 4 Joker ohne echte Karte (150 bzw. 200 Punkte).

**Das Kartenmodell – gilt für alles**
1. **Jede Karte gibt es genau einmal.** Nichts darf doppelt vorkommen: weder echte Karte und Joker,
   noch zwei Joker für dieselbe Karte, noch Joker und offene Karte (Rest oder Ablage).
2. **Jeder Joker steht für genau eine Karte.** In einer Straße steht sie mit dem Auslegen fest
   (Rang und Farbe). In einem Satz ist nur die Farbe offen („?“) – dafür muss aber eine freie Farbe da sein.
3. **Eine Gruppe behält ihre Art.** Satz bleibt Satz, Straße bleibt Straße, Jokergruppe bleibt
   Jokergruppe – auch durch Anlegen.
4. Der Server prüft nach **jedem** Auslegen, Anlegen und Tauschen den ganzen Tisch. Bricht ein Zug
   das Kartenmodell, wird er komplett zurückgedreht und abgelehnt.

**Joker**
- Kann ein Joker beim Auslegen oder Anlegen an eine Straße mehrere Karten sein, erscheint ein
  **Auswahl-Menü**. Angeboten wird nur, was das Kartenmodell erlaubt.
- Anlegen an eine Straße geht nur unten oder oben. Gehört der Platz einer Karte einem Joker, wird
  **getauscht** – der Joker wandert auf die Hand.
- Bei einem Drilling darf der Joker nur gegen eine Karte getauscht werden, die schon sichtbar war.

**Punkte**
- Ass 25 (unten in Ass-2-3-4: 5), echte 2: 5, 10 bis König: 10, 3 bis 9: 5.
- Joker im Spiel zählt wie die dargestellte Karte, Joker auf der Hand am Rundenende: 50 Minuspunkte.
- Angelegte Karten zählen für den, der sie angelegt hat, und liegen auf seiner Seite.
- **Joker-Tausch:** Die echte Karte übernimmt den Platz des Jokers samt Punkten – sie zählt weiter für den,
  der den Joker gelegt hat. Ein Tausch fixiert die Gruppe nicht.
- Hat jeder Spieler etwas an eine Gruppe **angelegt**, ist sie **fixiert**: nur noch anlegen oder tauschen.
- Ist der Nachziehstapel leer und liegen weniger als 2 Karten auf der Ablage, endet die Runde.
- Gespielt wird bis 500 Punkte.

---

## Spiele überleben Neustarts (Speicher)

Der Server sichert jeden Raum kurz nach jedem Zug und lädt beim Start alle Räume wieder.
Beide Spieler kommen über denselben Link zurück. Welcher Speicher benutzt wird, bestimmen
Umgebungsvariablen:

| Variablen | Speicher | Übersteht Deploys auf Renders Gratis-Tarif? |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Redis | **Ja** |
| `DATA_DIR=/var/data` | Datei | nur mit bezahlter Persistent Disk |
| nichts | Arbeitsspeicher | Nein |

**Empfohlen (kostenlos): Upstash Redis**
1. Auf [upstash.com](https://upstash.com) registrieren, *Create Database* (Redis), Region Europa.
2. Im Reiter *REST API* `UPSTASH_REDIS_REST_URL` und `UPSTASH_REDIS_REST_TOKEN` kopieren.
3. In Render beim Dienst: *Environment → Add Environment Variable*, beide eintragen, speichern.
4. In der Lobby steht danach „Speicher: Redis (dauerhaft)“.

---

## Benachrichtigungen

- **Ton und Vibration** bei „du bist dran“, solange die Seite offen ist (Menü ⋯ → 🔔).
- **Web-Push** auch bei geschlossener App: Menü ⋯ → 📲 einschalten und erlauben.
  Auf dem **iPhone** nur als Web-App vom Home-Bildschirm (Safari → Teilen → *Zum Home-Bildschirm*, iOS 16.4+).
- Damit Push-Abos Deploys überleben, Upstash einrichten oder eigene Schlüssel setzen:
  `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (erzeugen mit `npx web-push generate-vapid-keys`),
  optional `VAPID_SUBJECT`.

## Bedenkzeit und Vorgabe

In der Lobby unter **⚙ Bedenkzeit & Vorgabe** (gilt für „Neues Spiel erstellen“ und für Spiele gegen den Computer):

- **Bedenkzeit**: ohne, 3+2, 5+3, 10+5, 15+10, 30+0 oder eigene Werte (Minuten + Bonus-Sekunden pro Zug).
  Jeder hat ein Zeitkonto für das ganze Spiel; die Uhr läuft nur, wenn man am Zug ist und beide Spieler
  im Raum sind, zwischen den Runden ist Pause. Nach jedem eigenen Zug kommt der Fischer-Bonus dazu.
  Wer bei 0:00 ankommt, verliert das Spiel.
- **Vorgabe**: Startpunkte für dich und für den Gegner (−400 bis +450), z. B. +100 für den Schwächeren.

## Gegen den Computer

In der Lobby unter **🤖 Gegen den Computer** eine Stufe wählen – das Spiel startet sofort.
Der Computer spielt auf dem Server, sieht nur, was ein Mensch an seinem Platz sehen würde (eigene Hand,
Tisch, Ablage, Rest), und hält sich an exakt dieselben Regeln.

| Stufe | Spielweise |
|---|---|
| Leicht | legt nur einfache Gruppen ohne Joker, nimmt nie auf, wirft eher zufällig ab |
| Normal | sucht die beste Kombination mit Jokern, legt an, tauscht Joker, nimmt auf, wenn es sich lohnt |
| Schwer | wie Normal, nimmt mutiger auf und wirft so ab, dass man selbst wenig anlegen kann |

Die Bedenkzeit pro Schritt lässt sich mit der Umgebungsvariable `BOT_STEP_MS` (Standard 900 ms) ändern.

## Zuschauer-Link

Im Spiel oben **👁 Zuschauer-Link** kopieren (`…/?watch=CODE`) oder in der Lobby
**👁 Nur zuschauen** mit Code. Zuschauer sehen Tisch, Ablage, Punkte und Verlauf – keine Handkarten.

## Eigene Domain

Render → Dienst → *Settings → Custom Domains → Add*. Bei einer Subdomain
(z. B. `pesequind.gbfinanzmakler.de`) beim DNS-Anbieter einen CNAME auf den von Render
gezeigten Wert setzen. SSL kommt automatisch, die `onrender.com`-Adresse bleibt gültig.

---

## Aufbau

| Datei | Aufgabe |
|---|---|
| `shared/rules.js` | Reine Spielregeln und Kartenmodell – läuft auf Server **und** Client |
| `server.js` | Räume, Spielstand, Prüfung jeder Aktion, Sicht pro Spieler (WebSocket `/ws`) |
| `persist.js` | Speicher-Schicht (Redis / Datei / keiner) |
| `push.js` | Web-Push und VAPID-Schlüssel |
| `bot.js` | Computer-Gegner (Entscheidungen, nutzt dieselben Regeln) |
| `public/` | Client: Lobby, Spielbrett, Service Worker, App-Manifest |
| `render.yaml` | Blueprint für Render |
