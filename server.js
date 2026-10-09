/*
 * Pesëqind/500 – Online-Server (Schiedsrichter-Modell).
 *
 * Haelt pro Raum den EINEN echten Spielstand. Clients senden nur Absichten
 * ("ziehen", "Set X auslegen"), der Server validiert sie gegen die Regeln
 * aus shared/rules.js und schickt danach jedem Spieler eine auf ihn
 * zugeschnittene Sicht zurueck (eigene Hand komplett, Gegner nur die Anzahl).
 * So kann niemand per Devtools in die Hand des anderen schauen oder Zuege
 * erzwingen, die die Regeln nicht hergeben.
 */
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const R = require('./shared/rules.js');
const { createStore, serializeState, deserializeState } = require('./persist.js');
const { createPush, sanitizeSubscription } = require('./push.js');
const BOT = require('./bot.js');

const VERSION = '2026-10-09.15';
const PORT = process.env.PORT || 3000;
const store = createStore();                 // Redis (REST) / Datei / nur Arbeitsspeicher – siehe persist.js
let push = null;                             // Web-Push (wird beim Start initialisiert)
const ROOM_TTL_MS = (store.kind === 'none' ? 6 : 24) * 60 * 60 * 1000; // Raeume ohne Aktivitaet aufraeumen
const MAX_SPECTATORS = 20;
const PUSH_MIN_GAP_MS = 15 * 1000;           // nie oefter als alle 15 s pro Spieler pushen
const RECONNECT_GRACE_MS = 3 * 60 * 1000; // 3 Min. Zeit zum Wiederverbinden bei Verbindungsabbruch

const app = express();
// Immer beim Server nachfragen (ETag) – sonst zeigen Handys nach einem Update oft noch den alten Stand.
const staticOpts = { setHeaders: res => res.setHeader('Cache-Control', 'no-cache') };
app.use(express.static(path.join(__dirname, 'public'), staticOpts));
app.use('/shared', express.static(path.join(__dirname, 'shared'), staticOpts));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const newId = () => crypto.randomUUID();

/* ============================= RAUM-VERWALTUNG ============================= */
const rooms = new Map(); // code -> room
const lobbyWatchers = new Set(); // ws-Verbindungen, die noch in keinem Raum sitzen (fuer die Raumliste)

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne verwechselbare Zeichen
  let code;
  do {
    code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const code = makeRoomCode();
  const room = {
    code,
    seats: [null, null], // { token, ws, name, connected, disconnectedAt, push?, hidden? }
    spectators: new Set(), // read-only Zuschauer (ws), werden nicht gespeichert
    state: null,
    createdAt: Date.now(),
    lastActivity: Date.now()
  };
  rooms.set(code, room);
  return room;
}

function freshRoundState(startPlayerIndex) {
  const deck = R.buildDeck(newId);
  R.shuffle(deck);
  const reserve = deck.pop();
  const players = [{ hand: [] }, { hand: [] }];
  const otherIndex = opponentOf(startPlayerIndex);
  // Der Startspieler bekommt die "extra" 7. Karte, weil er im ersten Zug der Runde
  // nicht zieht (skipDrawThisTurn) – ohne das haette er sonst nur 6 Karten fuer den
  // Starthand-Zug. Das gilt fuer JEDEN Startspieler, nicht nur fuer Sitzplatz 0.
  for (let i = 0; i < 7; i++) players[startPlayerIndex].hand.push(deck.pop());
  for (let i = 0; i < 6; i++) players[otherIndex].hand.push(deck.pop());
  const discardPile = []; // leer – die erste Karte legt der Startspieler selbst ab
  const seen = new Set([R.cardKey(reserve)]);
  return {
    drawPile: deck,
    discardPile,
    reserveCard: reserve,
    players,
    tableMelds: [],
    currentPlayerIndex: startPlayerIndex,
    needsDraw: true,
    skipDrawThisTurn: true,
    pickedUpThisTurn: false,
    frozenCardIds: new Set(),
    preHandIds: new Set(),
    seenCards: seen,
    meldSeq: 0, // laufende Nummer der Gruppen dieser Runde ("Gruppe 3")
    pendingWinner: null
  };
}

/* ---------- Raum-Einstellungen: Bedenkzeit (mit Fischer-Bonus) und Vorgabe in Punkten ----------
 * clock: null = ohne Zeit, sonst { baseMs, incMs } – jeder Spieler hat ein eigenes Zeitkonto fuer das
 *        GANZE Spiel (wie beim Schach). Nach jedem eigenen Zug gibt es incMs dazu (Fischer).
 *        Wer bei 0 ankommt, hat das Spiel verloren.
 * handicap: Startpunkte [Sitz 0 (Ersteller), Sitz 1]. */
const SETTINGS_DEFAULT = { clock: null, handicap: [0, 0] };
function sanitizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  let clock = null;
  const min = Number(r.minutes), inc = Number(r.increment);
  if (Number.isFinite(min) && min > 0) {
    clock = {
      baseMs: Math.round(Math.min(180, Math.max(0.5, min)) * 60000),
      incMs: Math.round(Math.min(120, Math.max(0, Number.isFinite(inc) ? inc : 0)) * 1000)
    };
  }
  const h = Array.isArray(r.handicap) ? r.handicap : [0, 0];
  const hc = [0, 1].map(i => Math.max(-400, Math.min(450, Math.round(Number(h[i]) || 0))));
  return { clock, handicap: hc };
}
function newGameState(settings) {
  const st = settings || SETTINGS_DEFAULT;
  const clock = st.clock
    ? { baseMs: st.clock.baseMs, incMs: st.clock.incMs, remaining: [st.clock.baseMs, st.clock.baseMs], turnStartedAt: null, runningFor: null }
    : null;
  return { round: 1, scores: [st.handicap[0], st.handicap[1]], log: [], roundHistory: [], clock, ...freshRoundState(0) };
}

/* ---------- Verlauf (Log) ----------
 * Eintraege sind Objekte { round, pid, kind, text, own? }:
 *  - pid  = handelnder Spieler (null = System). Der Client setzt "Du" bzw. den Namen davor.
 *  - own  = optionale Variante NUR fuer den Handelnden (z. B. welche Karte er gezogen hat –
 *           der Gegner darf das nicht erfahren).
 *  - Karten stehen als «7♠»-Token im Text; der Client macht daraus farbige Karten-Chips.
 */
const MAX_LOG = 400;
function addLog(state, entry) {
  const e = typeof entry === 'string' ? { pid: null, kind: 'sys', text: entry } : entry;
  state.log.unshift({
    round: state.round,
    pid: e.pid == null ? null : e.pid,
    kind: e.kind || 'sys',
    text: e.text,
    own: e.own
  });
  if (state.log.length > MAX_LOG) state.log.pop();
}

const tok = c => (c.isJoker ? `«Joker 2${c.suit}»` : `«${c.value}${c.suit}»`);

/* Karten einer Gruppe als Token-Liste in Anzeigereihenfolge. Ein Joker wird mit
 * der Karte beschriftet, die er in dieser Gruppe darstellt ("Joker=9♥"). */
function groupTokenList(cards, runStart) {
  const info = R.classifyGroup(cards, runStart);
  if (!info || info.type === 'jokers') return cards.map(c => ({ id: c.id, tok: tok(c) }));
  if (info.type === 'run') {
    const alts = R.allRunAssignments(cards);
    const fixed = runStart !== undefined && runStart !== null; // Lage festgeschrieben -> konkrete Karte
    return info.slots.map(sl => {
      if (sl.natural) return { id: sl.card.id, tok: `«2${sl.card.suit}»` };
      if (!sl.card.isJoker) return { id: sl.card.id, tok: tok(sl.card) };
      if (fixed) return { id: sl.card.id, tok: `«Joker=${R.rankAt(sl.rankIdx)}${info.suit}»` };
      // Ohne festgeschriebene Lage kann der Joker am Rand oben ODER unten stehen -> beide nennen
      const ranks = [...new Set(alts.map(a => {
        const x = a.slots.find(q => q.card.id === sl.card.id);
        return x ? R.rankAt(x.rankIdx) : null;
      }).filter(Boolean))];
      return { id: sl.card.id, tok: `«Joker=${ranks.length > 1 ? ranks.join('/') : R.rankAt(sl.rankIdx)}${info.suit}»` };
    });
  }
  const used = new Set(cards.filter(c => !c.isJoker).map(c => c.suit));
  const free = R.SUITS.filter(su => !used.has(su)).join('/');
  return cards.map(c => ({ id: c.id, tok: c.isJoker ? `«Joker=${info.rank}${free}»` : tok(c) }));
}
const groupTokens = (cards, runStart) => groupTokenList(cards, runStart).map(x => x.tok);
function groupDesc(cards, runStart) {
  const info = R.classifyGroup(cards, runStart);
  if (!info) return 'Gruppe';
  if (info.type === 'set') return `Set ${info.rank}`;
  if (info.type === 'run') return `Straße ${info.suit}`;
  return 'Jokergruppe';
}

function cleanName(raw, fallback) {
  const n = String(raw == null ? '' : raw).replace(/[<>&"'`«»]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return n || fallback;
}

function opponentOf(pid) {
  return pid === 0 ? 1 : 0;
}

/* ============================= SPEICHERN / WIEDERHERSTELLEN ============================= */
function serializeRoom(room) {
  return {
    code: room.code,
    createdAt: room.createdAt,
    lastActivity: room.lastActivity,
    settings: room.settings || SETTINGS_DEFAULT,
    seats: room.seats.map(sd => sd && { token: sd.token, name: sd.name, push: sd.push || null, bot: sd.bot || null }),
    state: serializeState(room.state)
  };
}
const saveTimers = new Map();
function saveSoon(room) {
  if (store.kind === 'none' || saveTimers.has(room.code)) return;
  saveTimers.set(room.code, setTimeout(() => {
    saveTimers.delete(room.code);
    if (!rooms.has(room.code)) return;
    store.saveRoom(room.code, serializeRoom(room)).catch(e => console.error('[persist] speichern:', e.message));
  }, 1200));
}
async function flushAllRooms() {
  if (store.kind === 'none') return;
  for (const t of saveTimers.values()) clearTimeout(t);
  saveTimers.clear();
  await Promise.all([...rooms.values()].map(r =>
    store.saveRoom(r.code, serializeRoom(r)).catch(e => console.error('[persist] speichern:', e.message))));
}
function dropRoom(code) {
  rooms.delete(code);
  const t = saveTimers.get(code);
  if (t) { clearTimeout(t); saveTimers.delete(code); }
  store.deleteRoom(code).catch(e => console.error('[persist] loeschen:', e.message));
}
async function restoreRooms() {
  if (store.kind === 'none') return 0;
  const { rooms: list } = await store.loadAll();
  let n = 0;
  for (const d of list) {
    if (!d || !d.code || !d.state) continue;
    if (Date.now() - (d.lastActivity || 0) > ROOM_TTL_MS) { store.deleteRoom(d.code).catch(() => {}); continue; }
    rooms.set(d.code, {
      code: d.code,
      // Alle Sitze starten "getrennt"; wer mit seinem Token zurueckkommt, sitzt wieder auf seinem Platz.
      seats: (d.seats || [null, null]).map(sd => sd && {
        token: sd.token, name: sd.name, ws: null, connected: !!sd.bot, disconnectedAt: sd.bot ? null : Date.now(),
        push: sd.push || null, bot: sd.bot || null
      }),
      spectators: new Set(),
      state: (() => { const st = deserializeState(d.state); if (st.clock) { st.clock.turnStartedAt = null; st.clock.runningFor = null; } return st; })(),
      settings: d.settings || SETTINGS_DEFAULT,
      createdAt: d.createdAt || Date.now(),
      lastActivity: d.lastActivity || Date.now()
    });
    n++;
  }
  return n;
}

/* ============================= PUSH ("du bist dran") ============================= */
function publicLogText(room) {
  const s = room.state;
  const e = s.log[0]; // Verlauf ist neueste-zuerst gespeichert
  if (!e || typeof e === 'string') return '';
  const who = e.pid === 0 || e.pid === 1 ? label(room, e.pid) : '';
  return `${who ? who + ' ' : ''}${String(e.text || '').replace(/[«»]/g, '')}`.slice(0, 160);
}
/* Pusht nur, wenn der Spieler die App gerade NICHT offen hat (getrennt oder Tab im Hintergrund). */
function notifyPlayer(room, idx, title, body) {
  const seat = room.seats[idx];
  if (!push || !seat || !seat.push) return;
  if (seat.connected && !seat.hidden) return;
  const now = Date.now();
  if (seat.lastPushAt && now - seat.lastPushAt < PUSH_MIN_GAP_MS) return;
  seat.lastPushAt = now;
  push.send(seat.push, { title, body, tag: 'peseqind-' + room.code, url: '/?room=' + room.code })
    .then(r => { if (r === 'gone') { seat.push = null; saveSoon(room); } });
}
function notifyAfterAction(room, actorPid) {
  const s = room.state;
  if (s.roundOver) {
    notifyPlayer(room, opponentOf(actorPid), 'Pesëqind – Runde beendet', 'Die Runde ist vorbei – Ergebnis ansehen.');
  } else if (s.currentPlayerIndex !== actorPid) {
    notifyPlayer(room, s.currentPlayerIndex, 'Pesëqind – du bist dran', publicLogText(room) || 'Du bist am Zug.');
  }
}

/* ============================= RAUMLISTE (LOBBY) ============================= */
function roomListPayload() {
  const list = [];
  for (const [code, room] of rooms) {
    const filled = room.seats.filter(Boolean).length;
    if (filled >= 2) continue; // voll besetzt (auch falls kurz getrennt) -> nicht ueber die Liste beitretbar
    list.push({
      code,
      count: filled,
      players: room.seats.map(s => (s ? s.name : null))
    });
  }
  list.sort((a, b) => a.code.localeCompare(b.code));
  return list;
}

function broadcastRoomList() {
  const payload = JSON.stringify({ type: 'roomList', rooms: roomListPayload() });
  for (const watcher of lobbyWatchers) {
    if (watcher.readyState === 1) {
      try { watcher.send(payload); } catch (e) { /* Verbindung schon weg */ }
    }
  }
}

/* ============================= AKTIONEN (server-autoritativ) =============================
 * Jede Funktion bekommt (room, pid, payload) und wirft einen String (Fehlermeldung),
 * wenn die Aktion ungueltig ist – die wird dem anfragenden Spieler als Hinweis
 * zurueckgeschickt, ohne dass sich sonst etwas am Zustand aendert.
 */
const actions = {
  draw(room, pid) {
    const s = room.state;
    if (s.skipDrawThisTurn) throw 'In diesem Zug (Starthand) ziehst du nicht – direkt auslegen oder abwerfen.';
    if (!s.needsDraw) throw 'Du hast diesen Zug schon gezogen / aufgenommen.';
    if (s.drawPile.length === 0) throw 'Der Nachziehstapel ist leer.';
    const card = s.drawPile.pop();
    s.players[pid].hand.push(card);
    s.needsDraw = false;
    s.skipDrawThisTurn = false;
    addLog(s, { pid, kind: 'draw', text: 'zieht eine Karte.', own: `zieht ${tok(card)}.` });
  },

  pickup(room, pid, { index }) {
    const s = room.state;
    if (s.skipDrawThisTurn) throw 'In diesem Zug (Starthand) nimmst du nicht auf – direkt auslegen oder abwerfen.';
    if (!s.needsDraw) throw 'Du hast diesen Zug schon gezogen / aufgenommen.';
    const pile = s.discardPile;
    if (typeof index !== 'number' || index < 0 || index >= pile.length) throw 'Ungueltige Auswahl.';
    const takeCount = pile.length - index;
    if (takeCount < 2) throw 'Mindestens 2 Karten noetig.';
    const taken = pile.splice(index);
    s.preHandIds = new Set(s.players[pid].hand.map(c => c.id));
    taken.forEach(c => {
      s.players[pid].hand.push(c);
      s.frozenCardIds.add(c.id);
    });
    s.pickedUpThisTurn = true;
    s.needsDraw = false;
    s.skipDrawThisTurn = false;
    addLog(s, { pid, kind: 'pickup', text: `nimmt ${taken.length} Karten vom Ablagestapel auf: ${taken.map(tok).join(' ')}` });
  },

  lay(room, pid, { cardIds, runStart: wantedStart }) {
    const s = room.state;
    if (s.needsDraw && !s.skipDrawThisTurn) throw 'Du musst zuerst ziehen oder aufnehmen.';
    if (!Array.isArray(cardIds) || cardIds.length < 3) throw 'Mindestens 3 Karten noetig.';
    const hand = s.players[pid].hand;
    const cards = cardIds.map(id => hand.find(c => c.id === id)).filter(Boolean);
    if (cards.length !== cardIds.length) throw 'Karte nicht in deiner Hand gefunden.';
    if (!R.isValidGroup(cards)) throw 'Kein gueltiges Set oder keine gueltige Strasse.';
    assertNoJokerConflict(s, cards);
    const isOpenNow = R.makeIsOpen(s.reserveCard, s.discardPile);
    let chosenStart = R.pickRunStart(cards, isOpenNow);
    if (chosenStart !== null) {
      // Auswahl-Menue: der Spieler darf waehlen, welche Karte der Joker ist (nur zulaessige Lagen).
      const choices = R.runChoices(cards, isOpenNow, tableKeysOf(s));
      if (wantedStart !== undefined && wantedStart !== null) {
        if (!choices.some(c => c.startIdx === wantedStart)) throw 'Diese Joker-Auswahl ist nicht erlaubt.';
        chosenStart = wantedStart;
      } else if (choices.length) {
        chosenStart = choices[0].startIdx;
      }
    }
    assertTableOk(s, { cards, runStart: chosenStart });
    const meldCards = cards.map(c => ({ card: c, addedBy: pid }));
    cards.forEach(c => {
      const idx = hand.findIndex(h => h.id === c.id);
      if (idx >= 0) hand.splice(idx, 1);
      s.seenCards.add(R.cardKey(c));
    });
    // Lage einer Strasse festschreiben: Joker am Rand zaehlt als wertvollste Karte, die nicht offen liegt.
    const runStart = chosenStart;
    const layInfo = R.classifyGroup(cards, runStart);
    const meld = { id: newId(), no: ++s.meldSeq, ownerId: pid, cards: meldCards, locked: false, runStart, kind: layInfo ? layInfo.type : null };
    s.tableMelds.push(meld);
    addLog(s, {
      pid, kind: 'lay',
      text: `legt Gruppe ${meld.no} aus (${groupDesc(cards, runStart)}): ${groupTokens(cards, runStart).join(' ')} · +${R.pointsForCards(cards, runStart)} P`
    });
    checkUnlockPickup(room, s, pid);
  },

  attach(room, pid, { cardId, meldId, runStart: wantedStart }) {
    const s = room.state;
    if (s.needsDraw && !s.skipDrawThisTurn) throw 'Du musst zuerst ziehen oder aufnehmen.';
    const hand = s.players[pid].hand;
    const card = hand.find(c => c.id === cardId);
    if (!card) throw 'Karte nicht in deiner Hand gefunden.';
    const meld = s.tableMelds.find(m => m.id === meldId);
    if (!meld) throw 'Set nicht gefunden.';
    const combined = [...meld.cards.map(mc => mc.card), card];
    const curInfo = R.classifyGroup(meld.cards.map(mc => mc.card), meld.runStart);
    const isOpen = R.makeIsOpen(s.reserveCard, s.discardPile);
    let newStart = null;
    if (curInfo && curInfo.type === 'run') {
      // Strasse: Joker behalten ihre festgeschriebene Rolle. Die Karte muss UNTEN/OBEN anschliessen;
      // gehoert ihr Platz einem Joker, muss sie getauscht werden.
      newStart = R.runAttachStart(meld.cards.map(mc => mc.card), meld.runStart, card, isOpen);
      if (card.isJoker && newStart !== null) {
        // Auswahl-Menue: Joker unten oder oben anlegen (nur freie Karten).
        const ch = R.attachJokerChoices(meld.cards.map(mc => mc.card), meld.runStart, isOpen, tableKeysOf(s));
        if (wantedStart !== undefined && wantedStart !== null) {
          if (!ch.some(c => c.startIdx === wantedStart)) throw 'Diese Joker-Auswahl ist nicht erlaubt.';
          newStart = wantedStart;
        } else if (ch.length) newStart = ch[0].startIdx;
      }
      if (newStart === null) {
        const holds = !card.isJoker && curInfo.suit === card.suit &&
          curInfo.slots.some(sl => R.isJokerSlot(sl) && R.rankAt(sl.rankIdx) === card.value);
        throw holds
          ? 'Diese Karte gehört auf den Platz eines Jokers – bitte den Joker tauschen statt anlegen.'
          : (card.isJoker ? 'Blockiert: Der Joker würde eine offen liegende Karte darstellen.' : 'Diese Karte passt hier nicht an.');
      }
    } else {
      const chk = R.attachCheck(meld.cards.map(mc => mc.card), meld.runStart, card, isOpen);
      if (!chk.ok) {
        throw chk.why === 'jokers'
          ? 'Eine reine Joker-Gruppe nimmt nur weitere Joker auf (keine echten Karten).'
          : 'Diese Karte passt hier nicht an.';
      }
      assertNoJokerConflict(s, combined);
    }
    assertTableOk(s, { cards: combined, runStart: curInfo && curInfo.type === 'run' ? newStart : null }, meld.id);
    const before = R.meldPointSplit(meld)[pid];
    hand.splice(hand.findIndex(c => c.id === cardId), 1);
    meld.cards.push({ card, addedBy: pid });
    meld.runStart = curInfo && curInfo.type === 'run' ? newStart : null;
    if (pid !== meld.ownerId) meld.locked = true; // fixiert bleibt fixiert
    s.seenCards.add(R.cardKey(card));
    const gain = R.meldPointSplit(meld)[pid] - before;
    const shown = groupTokenList(combined, meld.runStart).find(x => x.id === card.id);
    const whose = meld.ownerId === pid ? 'eigene' : `${label(room, meld.ownerId)}s`;
    addLog(s, {
      pid, kind: 'attach',
      text: `legt ${shown ? shown.tok : tok(card)} an Gruppe ${meld.no} an (${whose} ${groupDesc(combined, meld.runStart)}) · +${gain} P`
    });
    checkUnlockPickup(room, s, pid);
  },

  swap(room, pid, { cardId, meldId }) {
    const s = room.state;
    if (s.needsDraw && !s.skipDrawThisTurn) throw 'Du musst zuerst ziehen oder aufnehmen.';
    const hand = s.players[pid].hand;
    const handCard = hand.find(c => c.id === cardId);
    if (!handCard) throw 'Karte nicht in deiner Hand gefunden.';
    if (handCard.isJoker) throw 'Du kannst keinen Joker gegen einen Joker tauschen.';
    const meld = s.tableMelds.find(m => m.id === meldId);
    if (!meld) throw 'Set nicht gefunden.';
    const info = R.classifyGroup(meld.cards.map(mc => mc.card), meld.runStart);
    if (!info) throw 'Ungueltiges Set.';
    let jIdx = -1;
    let swapRunStart = null;
    if (info.type === 'set') {
      const usedSuits = meld.cards.filter(mc => !mc.card.isJoker).map(mc => mc.card.suit);
      if (handCard.value !== info.rank || usedSuits.includes(handCard.suit)) throw 'Diese Karte passt hier nicht.';
      if (meld.cards.length === 3 && !s.seenCards.has(R.cardKey(handCard))) {
        throw 'Bei einem Drilling darf der Joker nur getauscht werden, wenn die Karte bereits sichtbar war.';
      }
      jIdx = meld.cards.findIndex(mc => mc.card.isJoker);
    } else if (info.type === 'run') {
      // Die Lage der Strasse ist beim Auslegen festgeschrieben (runStart): getauscht werden darf
      // nur gegen genau die Karte, die der Joker dort darstellt (z. B. Kreuz-Ass, nicht Kreuz-7).
      const sl = info.suit === handCard.suit && info.slots.find(q => R.isJokerSlot(q) && R.rankAt(q.rankIdx) === handCard.value);
      if (!sl) throw 'Diese Karte passt hier nicht – der Joker steht für eine andere Karte.';
      jIdx = meld.cards.findIndex(mc => mc.card.id === sl.card.id);
      swapRunStart = info.startIdx;
    } else {
      throw 'Reine Joker-Sets koennen nicht getauscht werden.';
    }
    if (jIdx < 0) throw 'Kein Joker zum Tauschen gefunden.';
    {
      const after = meld.cards.map((mc, i) => i === jIdx ? handCard : mc.card);
      assertTableOk(s, { cards: after, runStart: swapRunStart !== null ? swapRunStart : meld.runStart }, meld.id);
    }
    hand.splice(hand.findIndex(c => c.id === handCard.id), 1);
    const jokerEntry = meld.cards[jIdx];
    // Die echte Karte uebernimmt den Platz des Jokers – mit allem, was dazugehoert: Die Punkte zaehlen
    // weiter fuer den, der den Joker gelegt hat, und die Gruppe wird durch einen Tausch NICHT fixiert.
    meld.cards[jIdx] = { card: handCard, addedBy: jokerEntry.addedBy };
    if (swapRunStart !== null) meld.runStart = swapRunStart;
    hand.push(jokerEntry.card);
    s.seenCards.add(R.cardKey(handCard));
    addLog(s, {
      pid, kind: 'swap',
      text: `tauscht ${tok(handCard)} gegen ${tok(jokerEntry.card)} in Gruppe ${meld.no} (${groupDesc(meld.cards.map(mc => mc.card), meld.runStart)}) – der Joker liegt jetzt auf seiner Hand`
    });
  },

  dissolve(room, pid, { meldId }) {
    const s = room.state;
    const meld = s.tableMelds.find(m => m.id === meldId);
    if (!meld) throw 'Set nicht gefunden.';
    if (meld.ownerId !== pid) throw 'Nur der Besitzer darf dieses Set umbauen.';
    if (meld.locked || R.meldIsLocked(meld)) throw 'Diese Gruppe ist fixiert – es darf nur noch angelegt (oder ein Joker getauscht) werden.';
    s.players[pid].hand.push(...meld.cards.map(mc => mc.card));
    s.tableMelds = s.tableMelds.filter(m => m.id !== meldId);
    addLog(s, {
      pid, kind: 'dissolve',
      text: `löst Gruppe ${meld.no} zum Umbauen auf: ${groupTokens(meld.cards.map(mc => mc.card), meld.runStart).join(' ')}`
    });
  },

  discard(room, pid, { cardId }) {
    const s = room.state;
    if (s.needsDraw && !s.skipDrawThisTurn) throw 'Du musst zuerst ziehen oder aufnehmen.';
    if (s.frozenCardIds.has(cardId)) throw 'Frisch aufgenommen – darf diesen Zug nicht direkt wieder abgeworfen werden.';
    const hand = s.players[pid].hand;
    const idx = hand.findIndex(c => c.id === cardId);
    if (idx < 0) throw 'Karte nicht in deiner Hand gefunden.';
    if (hand.length === 1) throw 'Bei genau 1 Handkarte verdeckt ablegen statt abwerfen.';
    const [card] = hand.splice(idx, 1);
    s.frozenCardIds.delete(card.id);
    s.discardPile.push(card);
    s.seenCards.add(R.cardKey(card));
    addLog(s, { pid, kind: 'discard', text: `wirft ${tok(card)} ab.` });
    if (hand.length === 0) {
      evaluateRound(room);
    } else {
      advanceTurn(room);
      // Nachziehstapel leer und zu wenig zum Aufnehmen: niemand kann mehr ziehen -> Runde endet.
      if (s.drawPile.length === 0 && s.discardPile.length < 2) {
        addLog(s, 'Der Nachziehstapel ist leer – die Runde endet.');
        evaluateRound(room);
      }
    }
  },

  endRoundFacedown(room, pid) {
    const s = room.state;
    if (s.needsDraw && !s.skipDrawThisTurn) throw 'Du musst zuerst ziehen oder aufnehmen.';
    const hand = s.players[pid].hand;
    if (hand.length !== 1) throw 'Das geht nur bei genau 1 Handkarte.';
    const card = hand.pop();
    s.discardPile.push({ ...card, faceDown: true });
    addLog(s, { pid, kind: 'discard', text: `legt die letzte Karte verdeckt ab (${tok(card)}) – Runde beendet!` });
    evaluateRound(room);
  },

  /* Zug zurueck: nimmt die letzte Aktion DIESES Zuges zurueck (Auslegen, Anlegen, Tausch,
   * Umbauen, Aufnehmen). Ziehen vom Nachziehstapel ist NICHT zuruecknehmbar (die Karte ist
   * dem Spieler dann bekannt) – ab dort setzt "alles zuruecksetzen" auf den Stand nach dem Ziehen. */
  undo(room, pid) {
    const s = room.state;
    const st = s.undoStack || [];
    if (s.roundOver) throw 'Die Runde ist beendet.';
    if (!st.length) throw 'Es gibt nichts zurückzunehmen.';
    const snap = st.pop();
    restoreSnapshot(s, snap);
    s.undoStack = st;
    addLog(s, { pid, kind: 'undo', text: `nimmt zurück: ${snap.__label || 'letzte Aktion'}` });
  },

  undoAll(room, pid) {
    const s = room.state;
    const st = s.undoStack || [];
    if (s.roundOver) throw 'Die Runde ist beendet.';
    if (!st.length) throw 'Es gibt nichts zurückzusetzen.';
    const n = st.length;
    restoreSnapshot(s, st[0]);
    s.undoStack = [];
    addLog(s, { pid, kind: 'undo', text: `setzt ${n === 1 ? 'die Aktion' : `alle ${n} Aktionen`} dieses Zuges zurück.` });
  },

  /* Aufgeben: das Spiel endet sofort, der Gegner gewinnt. Geht jederzeit (auch wenn man nicht dran ist). */
  resign(room, pid) {
    const s = room.state;
    if (s.roundOver && s.pendingWinner !== null) throw 'Das Spiel ist schon entschieden.';
    s.resigned = pid;
    s.pendingWinner = opponentOf(pid);
    if (!s.roundOver) {
      s.roundHistory.push({ round: s.round, plus: [0, 0], minus: [0, 0], total: [0, 0], cumulative: [s.scores[0], s.scores[1]] });
    }
    s.roundOver = true;
    s.nextStarter = 0;
    addLog(s, { pid, kind: 'sys', text: 'gibt auf – das Spiel ist beendet.' });
  },

  nextRound(room) {
    const s = room.state;
    if (!s.roundOver) throw 'Runde laeuft noch.';
    if (s.pendingWinner !== null) {
      room.state = newGameState(room.settings);
      addLog(room.state, 'Neues Spiel gestartet.');
      return;
    }
    const carried = { scores: s.scores, log: s.log, roundHistory: s.roundHistory, round: s.round + 1, clock: s.clock || null };
    room.state = { ...carried, ...freshRoundState(s.nextStarter) };
    addLog(room.state, `Runde ${room.state.round} beginnt.`);
  },

  newGame(room) {
    room.state = newGameState(room.settings);
    addLog(room.state, 'Neues Spiel gestartet.');
  }
};

/* ---------- Zug zurueck ----------
 * Vor jeder rueckholbaren Aktion wird eine Kopie des Spielstands (ohne Verlauf) abgelegt.
 * Der Verlauf bleibt vollstaendig erhalten – das Zuruecknehmen wird dort zusaetzlich vermerkt. */
const UNDOABLE = new Set(['pickup', 'lay', 'attach', 'swap', 'dissolve']);
const UNDO_ACTIONS = new Set(['undo', 'undoAll']);
function takeSnapshot(s) {
  const { log, undoStack, ...rest } = s;
  return structuredClone(rest);
}
function restoreSnapshot(s, snap) {
  const { __label, ...fields } = snap;
  Object.assign(s, fields);
}

/* ===== KARTENMODELL-WAECHTER =====
 * Nach JEDER Tisch-Aktion (Auslegen, Anlegen, Tauschen) wird der ganze Tisch geprueft:
 *  - jede Gruppe ist gueltig und hat noch ihre Art (Satz/Strasse/Jokergruppe),
 *  - in Strassen stehen die Joker noch fuer dieselbe Karte wie vorher,
 *  - keine Karte kommt doppelt vor (echt, Joker, Rest, Ablage).
 * Bringt die Aktion einen NEUEN Verstoss, wird sie komplett zurueckgedreht und abgelehnt. */
const TABLE_ACTIONS = new Set(['lay', 'attach', 'swap']);
const KIND_NAME = { set: 'Satz', run: 'Straße', jokers: 'Jokergruppe' };
function tableProblems(s) {
  const out = [];
  s.tableMelds.forEach(m => {
    const cards = m.cards.map(mc => mc.card);
    const info = R.classifyGroup(cards, m.runStart);
    if (!info) { out.push(`Gruppe ${m.no} wäre ungültig`); return; }
    if (m.kind && m.kind !== info.type) out.push(`Gruppe ${m.no} würde von ${KIND_NAME[m.kind]} zu ${KIND_NAME[info.type]}`);
    if (info.type === 'run' && m.runStart !== null && m.runStart !== undefined && info.startIdx !== m.runStart) {
      out.push(`Joker in Gruppe ${m.no} würden ihre Karte wechseln`);
    }
  });
  const melds = s.tableMelds.map(m => ({ cards: m.cards.map(mc => mc.card), runStart: m.runStart }));
  R.tableJokerProblems(melds, s.reserveCard, s.discardPile).forEach(p => out.push(p));
  return out;
}

function assertNoJokerConflict(s, cards) {
  const conflicts = R.jokerVisibilityConflicts(cards, s.reserveCard, s.discardPile);
  if (conflicts.length) {
    const list = conflicts.map(c => `${c.value}${c.suit}`).join(', ');
    throw `Blockiert: ${list} liegt bereits offen (Rest/Ablage) – ein Joker darf diese Karte nicht ersetzen.`;
  }
}

function tableKeysOf(s) {
  const keys = new Set();
  s.tableMelds.forEach(m => m.cards.forEach(mc => { if (!mc.card.isJoker) keys.add(mc.card.value + '_' + mc.card.suit); }));
  return keys;
}

/* Tischpruefung (jede Karte gibt es nur einmal): `change` = { replaceId, melds } ersetzt/ergaenzt Gruppen. */
function assertTableOk(s, extra, replaceMeldId) {
  const melds = s.tableMelds
    .filter(m => m.id !== replaceMeldId)
    .map(m => ({ cards: m.cards.map(mc => mc.card), runStart: m.runStart }));
  if (extra) melds.push(extra);
  // Nur NEUE Verstoesse zaehlen: wird z. B. spaeter die echte Karte zu einem Satz-Joker abgeworfen,
  // darf das nicht jedes weitere (unbeteiligte) Auslegen blockieren.
  const before = R.tableJokerProblems(s.tableMelds.map(m => ({ cards: m.cards.map(mc => mc.card), runStart: m.runStart })), s.reserveCard, s.discardPile);
  const problems = R.tableJokerProblems(melds, s.reserveCard, s.discardPile).filter(p => !before.includes(p));
  if (problems.length) {
    throw 'Blockiert: ' + problems[0] + ' – ein Joker kann keine Karte darstellen, die es schon echt gibt.';
  }
}

/* Fuehrt eine Aktion mit allen Pruefungen aus (Mensch und Computer gleichermassen).
 * Rueckgabe: null bei Erfolg, sonst die Fehlermeldung. Der Zustand bleibt bei Fehlern unveraendert. */
function performAction(room, pid, action, payload) {
  const s = room.state;
  const fn = actions[action];
  if (!fn) return 'Unbekannte Aktion.';
  try {
    const snap = UNDOABLE.has(action) ? takeSnapshot(s) : null;
    const logLen = s.log.length;
    const guard = TABLE_ACTIONS.has(action) && snap;
    const problemsBefore = guard ? tableProblems(s) : null;
    const prevCur = s.currentPlayerIndex, prevOver = !!s.roundOver;
    fn(room, pid, payload || {});
    // Fischer: Zug beendet (anderer Spieler dran oder Runde vorbei) -> Zeit verbuchen + Bonus
    if (room.state === s && s.clock && !prevOver && (s.currentPlayerIndex !== prevCur || s.roundOver)) {
      clockBank(room);
      if (action !== 'resign') s.clock.remaining[prevCur] += s.clock.incMs;
    }
    if (guard) {
      const fresh = tableProblems(s).filter(p => !problemsBefore.includes(p));
      if (fresh.length) {
        s.log.splice(0, s.log.length - logLen); // Verlaufseintraege dieser Aktion entfernen
        restoreSnapshot(s, snap);
        throw `Nicht erlaubt: ${fresh[0]}. (Jede Karte gibt es nur einmal, Joker behalten ihre Karte, Gruppen ihre Art.)`;
      }
    }
    if (snap) {
      // neue Eintraege stehen vorn (neueste zuerst); die eigentliche Aktion ist der AELTESTE davon
      const added = s.log.length - logLen;
      const first = added > 0 ? s.log[Math.min(added, s.log.length) - 1] : null;
      snap.__label = first ? first.text : '';
      (s.undoStack = s.undoStack || []).push(snap);
    } else if (!UNDO_ACTIONS.has(action) && room.state) {
      room.state.undoStack = []; // Ziehen, Abwerfen, neue Runde ... = Zug nicht mehr rueckholbar
    }
    return null;
  } catch (errMsg) {
    if (typeof errMsg !== 'string') console.error('[aktion]', action, errMsg);
    return typeof errMsg === 'string' ? errMsg : 'Ungueltiger Zug.';
  }
}

/* ============================= COMPUTER-GEGNER =============================
 * Ist ein Computer am Zug, macht er Schritt fuer Schritt je eine Aktion (mit kleiner Pause,
 * damit man zusehen kann). Abgelehnte Aktionen merkt er sich fuer diesen Zug. */
const BOT_STEP_MS = Number(process.env.BOT_STEP_MS || 900);
function scheduleBot(room) {
  const s = room.state;
  if (!s || s.roundOver || room.botTimer || !rooms.has(room.code)) return;
  const seat = room.seats[s.currentPlayerIndex];
  if (!seat || !seat.bot) return;
  room.botTimer = setTimeout(() => { room.botTimer = null; botStep(room); }, BOT_STEP_MS);
}
function botStep(room) {
  const s = room.state;
  if (!s || s.roundOver || !rooms.has(room.code)) return;
  const pid = s.currentPlayerIndex;
  const seat = room.seats[pid];
  if (!seat || !seat.bot) return;
  const turn = room.botTurnNo || 0;
  if (!room.botMemo || room.botMemo.turn !== turn || room.botMemo.state !== s) {
    room.botMemo = { turn, state: s, failed: new Set(), steps: 0 };
  }
  const memo = room.botMemo;
  let a = null;
  try { a = BOT.nextAction(s, pid, seat.bot, memo); } catch (e) { console.error('[bot] Entscheidung:', e); }
  if (++memo.steps > 60) a = null;
  let err = a ? performAction(room, pid, a.action, a.payload) : 'keine Aktion';
  if (err && a) {
    memo.failed.add(JSON.stringify(a));
    for (let tries = 0; tries < 15 && err; tries++) {
      try { a = BOT.nextAction(s, pid, seat.bot, memo); } catch (e) { a = null; }
      if (!a) break;
      err = performAction(room, pid, a.action, a.payload);
      if (err) memo.failed.add(JSON.stringify(a));
    }
  }
  if (err) {
    // Notfall: Zug irgendwie regelkonform beenden
    const hand = s.players[pid].hand;
    if (s.needsDraw && !s.skipDrawThisTurn) err = performAction(room, pid, 'draw', {});
    if (err && hand.length === 1) err = performAction(room, pid, 'endRoundFacedown', {});
    for (const c of hand.slice()) { if (!err) break; err = performAction(room, pid, 'discard', { cardId: c.id }); }
    if (err) console.error('[bot] festgefahren in Raum', room.code, err);
  }
  if (room.state !== s || s.currentPlayerIndex !== pid || s.roundOver) room.botTurnNo = turn + 1;
  broadcast(room);
  notifyAfterAction(room, pid);
}

/* ============================= BEDENKZEIT =============================
 * Die Uhr des Spielers am Zug laeuft nur, wenn beide Plaetze besetzt sind und die Runde laeuft
 * (zwischen den Runden ist Pause). broadcast() ruft clockSync() auf – damit ist sie immer im Takt. */
function clockLeft(c, i) {
  let r = c.remaining[i];
  if (c.turnStartedAt != null && c.runningFor === i) r -= Date.now() - c.turnStartedAt;
  return r;
}
function clockBank(room) {
  const c = room.state && room.state.clock;
  if (!c || c.turnStartedAt == null) return;
  c.remaining[c.runningFor] -= Date.now() - c.turnStartedAt;
  c.turnStartedAt = null;
  c.runningFor = null;
}
function clearClockTimer(room) { if (room.clockTimer) { clearTimeout(room.clockTimer); room.clockTimer = null; } }
function clockSync(room) {
  const s = room.state, c = s && s.clock;
  if (!c) { clearClockTimer(room); return; }
  const running = !s.roundOver && room.seats[0] && room.seats[1] && rooms.has(room.code);
  if (!running) { clockBank(room); clearClockTimer(room); return; }
  if (c.turnStartedAt != null && c.runningFor !== s.currentPlayerIndex) clockBank(room);
  if (c.turnStartedAt == null) { c.turnStartedAt = Date.now(); c.runningFor = s.currentPlayerIndex; }
  clearClockTimer(room);
  room.clockTimer = setTimeout(() => { room.clockTimer = null; clockCheck(room); }, Math.max(0, clockLeft(c, c.runningFor)) + 60);
}
function clockCheck(room) {
  const s = room.state, c = s && s.clock;
  if (!c || c.turnStartedAt == null || s.roundOver) return;
  const i = c.runningFor;
  if (clockLeft(c, i) > 0) { clockSync(room); return; }
  clockBank(room);
  c.remaining[i] = 0;
  s.timedOut = i;
  s.pendingWinner = opponentOf(i);
  s.roundHistory.push({ round: s.round, plus: [0, 0], minus: [0, 0], total: [0, 0], cumulative: [s.scores[0], s.scores[1]] });
  s.roundOver = true;
  s.nextStarter = 0;
  addLog(s, { pid: i, kind: 'sys', text: 'hat keine Zeit mehr – das Spiel ist verloren.' });
  broadcast(room);
  notifyPlayer(room, i, 'Pesëqind – Zeit abgelaufen', 'Deine Bedenkzeit ist abgelaufen.');
}
function clockView(s) {
  const c = s.clock;
  if (!c) return null;
  return {
    baseMs: c.baseMs, incMs: c.incMs,
    remaining: [Math.max(0, clockLeft(c, 0)), Math.max(0, clockLeft(c, 1))],
    running: c.turnStartedAt != null ? c.runningFor : null
  };
}

function label(room, pid) {
  const seat = room.seats[pid];
  return (seat && seat.name) ? seat.name : (pid === 0 ? 'Spieler 1' : 'Spieler 2');
}

function checkUnlockPickup(room, s, pid) {
  if (!s.pickedUpThisTurn || s.frozenCardIds.size === 0) return;
  const hand = s.players[pid].hand;
  const stillHasPreHand = hand.some(c => s.preHandIds.has(c.id));
  if (!stillHasPreHand && s.preHandIds.size > 0) {
    s.frozenCardIds.clear();
    addLog(s, { pid, kind: 'sys', text: 'hat die komplette Vorhand verbaut – aufgenommene Karten sind freigegeben.' });
  }
}

function advanceTurn(room) {
  const s = room.state;
  s.currentPlayerIndex = opponentOf(s.currentPlayerIndex);
  s.needsDraw = true;
  s.skipDrawThisTurn = false;
  s.pickedUpThisTurn = false;
  s.frozenCardIds = new Set();
  s.preHandIds = new Set();
}

function evaluateRound(room) {
  const s = room.state;
  const enderIndex = s.currentPlayerIndex;
  const plus = [0, 0];
  s.tableMelds.forEach(m => {
    const sp = R.meldPointSplit(m);
    plus[0] += sp[0];
    plus[1] += sp[1];
  });
  const minus = [0, 0];
  s.players.forEach((p, idx) => {
    p.hand.forEach(c => (minus[idx] += c.isJoker ? 50 : R.pointsForRank(c.value)));
  });
  const roundTotal = [plus[0] - minus[0], plus[1] - minus[1]];
  s.scores[0] += roundTotal[0];
  s.scores[1] += roundTotal[1];
  s.roundHistory.push({
    round: s.round,
    plus, minus, total: roundTotal,
    cumulative: [s.scores[0], s.scores[1]]
  });
  addLog(s, `Runde ${s.round} ausgewertet: ${label(room, 0)} ${roundTotal[0] >= 0 ? '+' : ''}${roundTotal[0]}, ${label(room, 1)} ${roundTotal[1] >= 0 ? '+' : ''}${roundTotal[1]}.`);
  const winner = s.scores[0] >= 500 ? 0 : s.scores[1] >= 500 ? 1 : null;
  s.pendingWinner = winner;
  s.roundOver = true;
  s.nextStarter = opponentOf(enderIndex);
}

/* ============================= SANITIZED VIEW PRO SPIELER ============================= */
function viewFor(room, pid) {
  const s = room.state;
  const opp = opponentOf(pid);
  const oppSeat = room.seats[opp];
  const mySeat = room.seats[pid];
  return {
    room: room.code,
    myIndex: pid,
    myName: (mySeat && mySeat.name) || (pid === 0 ? 'Spieler 1' : 'Spieler 2'),
    oppName: (oppSeat && oppSeat.name) || (opp === 0 ? 'Spieler 1' : 'Spieler 2'),
    opponentConnected: !!(oppSeat && oppSeat.connected),
    oppIsBot: !!(oppSeat && oppSeat.bot),
    resigned: s.resigned === undefined ? null : s.resigned,
    timedOut: s.timedOut === undefined ? null : s.timedOut,
    clock: clockView(s),
    settings: room.settings || SETTINGS_DEFAULT,
    round: s.round,
    scores: s.scores,
    currentPlayerIndex: s.currentPlayerIndex,
    isMyTurn: s.currentPlayerIndex === pid,
    needsDraw: s.needsDraw,
    skipDrawThisTurn: s.skipDrawThisTurn,
    pickedUpThisTurn: s.pickedUpThisTurn,
    frozenCardIds: [...s.frozenCardIds],
    tableMelds: s.tableMelds,
    discardPile: s.discardPile,
    reserveCard: s.reserveCard,
    drawCount: s.drawPile.length,
    myHand: s.players[pid].hand,
    oppHandCount: s.players[opp].hand.length,
    seenCards: [...s.seenCards],
    pendingWinner: s.pendingWinner,
    roundOver: !!s.roundOver,
    undoCount: (s.currentPlayerIndex === pid && !s.roundOver) ? (s.undoStack || []).length : 0,
    spectatorCount: room.spectators ? room.spectators.size : 0,
    roundHistory: s.roundHistory,
    // Am Rundenende liegen alle Karten offen – dann bekommt jeder auch die Restkarten des Gegners.
    oppHand: s.roundOver ? s.players[opp].hand : null,
    // Eintraege mit `own` zeigen dem Handelnden mehr Details (z. B. die gezogene Karte).
    log: s.log.map(e => ({ r: e.round, p: e.pid, k: e.kind, t: (e.pid === pid && e.own) ? e.own : e.text }))
  };
}

/* Zuschauer sehen den Tisch aus Sicht von Sitz 0 – aber KEINE Handkarten (nur Anzahl).
 * Erst am Rundenende liegen alle Karten offen, dann sehen auch sie die Haende. */
function viewForSpectator(room) {
  const s = room.state;
  const a = room.seats[0], b = room.seats[1];
  return {
    spectator: true,
    resigned: s.resigned === undefined ? null : s.resigned,
    timedOut: s.timedOut === undefined ? null : s.timedOut,
    clock: clockView(s),
    settings: room.settings || SETTINGS_DEFAULT,
    room: room.code,
    myIndex: 0,
    myName: (a && a.name) || 'Spieler 1',
    oppName: (b && b.name) || 'Spieler 2',
    opponentConnected: !!(b && b.connected),
    p0Connected: !!(a && a.connected),
    round: s.round,
    scores: s.scores,
    currentPlayerIndex: s.currentPlayerIndex,
    isMyTurn: false,
    needsDraw: s.needsDraw,
    skipDrawThisTurn: s.skipDrawThisTurn,
    pickedUpThisTurn: s.pickedUpThisTurn,
    frozenCardIds: [],
    tableMelds: s.tableMelds,
    discardPile: s.discardPile,
    reserveCard: s.reserveCard,
    drawCount: s.drawPile.length,
    myHand: s.roundOver ? s.players[0].hand : [],
    myHandCount: s.players[0].hand.length,
    oppHandCount: s.players[1].hand.length,
    seenCards: [...s.seenCards],
    pendingWinner: s.pendingWinner,
    roundOver: !!s.roundOver,
    undoCount: 0,
    spectatorCount: room.spectators ? room.spectators.size : 0,
    roundHistory: s.roundHistory,
    oppHand: s.roundOver ? s.players[1].hand : null,
    log: s.log.map(e => ({ r: e.round, p: e.pid, k: e.kind, t: e.text }))
  };
}

function broadcast(room) {
  room.lastActivity = Date.now();
  clockSync(room);
  room.seats.forEach((seat, pid) => {
    if (seat && seat.ws && seat.ws.readyState === 1) {
      send(seat.ws, { type: 'state', view: viewFor(room, pid) });
    }
  });
  if (room.spectators && room.spectators.size) {
    const sv = viewForSpectator(room);
    room.spectators.forEach(w => { if (w.readyState === 1) send(w, { type: 'state', view: sv }); });
  }
  saveSoon(room);
  scheduleBot(room);
}

function send(ws, msg) {
  try { ws.send(JSON.stringify(msg)); } catch (e) { /* Verbindung schon weg */ }
}

/* ============================= WEBSOCKET-PROTOKOLL =============================
 * Client -> Server:
 *   { type:'create', name }
 *   { type:'join', room, name, token? }
 *   { type:'action', action:'draw'|'pickup'|'lay'|..., payload:{...} }
 *   { type:'ping' }  (Client-Heartbeat, Antwort: { type:'pong' })
 * Server -> Client:
 *   { type:'joined', room, seat, token }
 *   { type:'state', view }
 *   { type:'error', message, code? }   code: ROOM_NOT_FOUND | ROOM_FULL | NOT_IN_ROOM
 *   { type:'roomList', rooms:[{code,count,players}] }
 *   { type:'opponentLeft' } / { type:'opponentJoined' }
 */
/* Verbindet einen Websocket mit einem Sitz. Ein evtl. noch offener ALTER Socket dieses
 * Sitzes (z. B. halbtote Verbindung nach App-Wechsel) wird beendet – sein spaeteres
 * "close"-Ereignis darf den Sitz NICHT mehr auf "getrennt" setzen (siehe close-Handler). */
function seatConnect(room, idx, ws) {
  const seat = room.seats[idx];
  const old = seat.ws;
  seat.ws = ws;
  seat.connected = true;
  seat.disconnectedAt = null;
  if (old && old !== ws) { try { old.terminate(); } catch (e) { /* schon weg */ } }
}

wss.on('connection', ws => {
  let room = null;
  let pid = null;
  let watching = null; // Raum, den diese Verbindung nur beobachtet (Zuschauer)

  // Heartbeat: haelt die Verbindung durch Proxys/Mobilfunk-NATs am Leben (die sonst
  // eine "stille" Verbindung nach kurzer Zeit von sich aus kappen – daher die
  // gemeldeten Timeout-Probleme beim kurzen App-Wechsel) und erkennt echte Leichen.
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Solange noch kein Raum betreten wurde, gilt diese Verbindung als "Lobby-Beobachter"
  // und bekommt die aktuelle Liste offener Raeume automatisch aktualisiert.
  lobbyWatchers.add(ws);
  send(ws, { type: 'roomList', rooms: roomListPayload(), version: VERSION, persist: store.kind, vapidPublicKey: push ? push.publicKey : null });

  // Wechselt dieselbe Verbindung in einen anderen Raum, wird der alte Sitz freigegeben.
  function leaveCurrentSeat() {
    if (watching) { watching.spectators.delete(ws); const w = watching; watching = null; broadcast(w); }
    if (room && pid !== null) {
      const seat = room.seats[pid];
      if (seat && seat.ws === ws) {
        seat.connected = false;
        seat.disconnectedAt = Date.now();
        broadcast(room);
      }
    }
    room = null; pid = null;
  }

  ws.on('message', raw => {
    ws.isAlive = true; // jede Nachricht beweist: der Client lebt
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'ping') {
      send(ws, { type: 'pong' });
      return;
    }

    if (msg.type === 'listRooms') {
      send(ws, { type: 'roomList', rooms: roomListPayload() });
      return;
    }

    if (msg.type === 'visibility') {
      if (room && pid !== null && room.seats[pid] && room.seats[pid].ws === ws) room.seats[pid].hidden = !!msg.hidden;
      return;
    }

    if (msg.type === 'pushSubscribe') {
      if (!room || pid === null || !room.seats[pid]) return;
      const sub = sanitizeSubscription(msg.subscription);
      if (!sub) { send(ws, { type: 'pushStatus', ok: false, message: 'Ungültiges Push-Abo.' }); return; }
      room.seats[pid].push = sub;
      saveSoon(room);
      send(ws, { type: 'pushStatus', ok: true, enabled: !!push });
      return;
    }

    if (msg.type === 'pushUnsubscribe') {
      if (room && pid !== null && room.seats[pid]) { room.seats[pid].push = null; saveSoon(room); }
      send(ws, { type: 'pushStatus', ok: true, enabled: false });
      return;
    }

    if (msg.type === 'watch') {
      const code = String(msg.room || '').toUpperCase();
      const target = rooms.get(code);
      if (!target) { send(ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'Raum nicht gefunden.' }); return; }
      if (!target.spectators.has(ws) && target.spectators.size >= MAX_SPECTATORS) {
        send(ws, { type: 'error', code: 'WATCH_FULL', message: 'Zu viele Zuschauer in diesem Raum.' }); return;
      }
      leaveCurrentSeat();
      lobbyWatchers.delete(ws);
      watching = target;
      target.spectators.add(ws);
      send(ws, { type: 'watching', room: target.code });
      broadcast(target); // Zuschauer bekommen ihre Sicht, die Spieler den neuen Zuschauerzaehler
      return;
    }

    if (msg.type === 'create') {
      leaveCurrentSeat();
      lobbyWatchers.delete(ws);
      room = createRoom();
      room.settings = sanitizeSettings(msg.settings);
      room.state = newGameState(room.settings);
      pid = 0;
      const token = crypto.randomUUID();
      room.seats[0] = { token, ws, name: cleanName(msg.name, 'Spieler 1'), connected: true };
      if (msg.bot && BOT.LEVELS[msg.bot]) {
        room.seats[1] = { token: crypto.randomUUID(), ws: null, name: `CPU (${BOT.LEVELS[msg.bot].name})`, connected: true, bot: msg.bot };
      }
      send(ws, { type: 'joined', room: room.code, seat: 0, token, vapidPublicKey: push ? push.publicKey : null });
      broadcast(room);
      broadcastRoomList();
      return;
    }

    if (msg.type === 'join') {
      const code = String(msg.room || '').toUpperCase();
      const target = rooms.get(code);
      if (!target) { send(ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'Raum nicht gefunden.' }); return; }

      // 1) Wiedereintritt mit bestehendem Token (Normalfall nach Verbindungsabbruch/Reload)
      if (msg.token) {
        const seatIdx = target.seats.findIndex(s => s && s.token === msg.token);
        if (seatIdx >= 0) {
          leaveCurrentSeat();
          lobbyWatchers.delete(ws);
          room = target; pid = seatIdx;
          seatConnect(room, pid, ws);
          send(ws, { type: 'joined', room: room.code, seat: pid, token: msg.token, vapidPublicKey: push ? push.publicKey : null });
          broadcast(room);
          broadcastRoomList();
          return;
        }
      }

      // 2) Freier Sitz -> normal beitreten
      const freeIdx = target.seats.findIndex(s => s === null);
      if (freeIdx >= 0) {
        leaveCurrentSeat();
        lobbyWatchers.delete(ws);
        room = target; pid = freeIdx;
        const token = crypto.randomUUID();
        room.seats[pid] = { token, ws, name: cleanName(msg.name, `Spieler ${pid + 1}`), connected: true };
        send(ws, { type: 'joined', room: room.code, seat: pid, token, vapidPublicKey: push ? push.publicKey : null });
        broadcast(room);
        broadcastRoomList();
        return;
      }

      // 3) Raum voll, aber Token ging verloren (anderer Browser/Handy, Speicher geleert):
      //    ein gerade GETRENNTER Sitz mit demselben Namen darf uebernommen werden.
      const wantName = cleanName(msg.name, '').toLowerCase();
      const takeIdx = wantName
        ? target.seats.findIndex(s => s && !s.connected && s.name.toLowerCase() === wantName)
        : -1;
      if (takeIdx >= 0) {
        leaveCurrentSeat();
        lobbyWatchers.delete(ws);
        room = target; pid = takeIdx;
        const token = crypto.randomUUID();
        room.seats[pid].token = token;
        seatConnect(room, pid, ws);
        send(ws, { type: 'joined', room: room.code, seat: pid, token, vapidPublicKey: push ? push.publicKey : null });
        broadcast(room);
        broadcastRoomList();
        return;
      }

      const anyOffline = target.seats.some(s => s && !s.connected);
      send(ws, {
        type: 'error', code: 'ROOM_FULL',
        message: anyOffline
          ? 'Raum ist voll – ein Platz ist gerade getrennt. Tritt mit exakt dem Namen von vorher bei, um dort weiterzuspielen.'
          : 'Raum ist bereits voll.'
      });
      return;
    }

    if (msg.type === 'action') {
      if (!room || pid === null) { send(ws, { type: 'error', code: 'NOT_IN_ROOM', message: 'Nicht in einem Raum.' }); return; }
      if (!room.seats[opponentOf(pid)]) { send(ws, { type: 'error', message: 'Warte auf den zweiten Spieler.' }); return; }
      const s = room.state;
      const readsOnly = ['nextRound', 'newGame', 'resign'];
      if (!readsOnly.includes(msg.action) && s.currentPlayerIndex !== pid) {
        send(ws, { type: 'error', message: 'Nicht dein Zug.' });
        return;
      }
      if (room.seats[pid] && room.seats[pid].bot) { send(ws, { type: 'error', message: 'Das ist der Platz des Computers.' }); return; }
      const err = performAction(room, pid, msg.action, msg.payload || {});
      if (err) { send(ws, { type: 'error', message: err }); return; }
      broadcast(room);
      notifyAfterAction(room, pid);
      return;
    }
  });

  ws.on('close', () => {
    lobbyWatchers.delete(ws);
    if (watching) { watching.spectators.delete(ws); const w = watching; watching = null; broadcast(w); return; }
    if (!room || pid === null) return;
    const seat = room.seats[pid];
    // WICHTIG: nur wenn DIESER Socket noch der aktuelle des Sitzes ist. Sonst wuerde ein
    // spaet eintreffendes "close" einer alten Verbindung den bereits wieder verbundenen
    // Spieler faelschlich als offline markieren (Ursache fuer das staendige "Rausfliegen").
    if (seat && seat.ws === ws) {
      seat.connected = false;
      seat.disconnectedAt = Date.now();
      broadcast(room);
      broadcastRoomList();
    }
  });
});

/* Heartbeat alle 25s: schickt Ping-Frames an alle Verbindungen (haelt sie ueber
 * Reverse-Proxys/Mobilfunk hinweg "warm" und verhindert so verfruehte Idle-
 * Timeouts) und beendet Verbindungen, die zwei Zyklen in Folge nicht antworten
 * (also wirklich tot sind – ein kurzer App-Wechsel auf dem Handy uebersteht das). */
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { return ws.terminate(); }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* Verbindung schon weg */ }
  });
}, 25 * 1000);

/* Aufraeumen: alte/leere Raeume und lange getrennte Sitze */
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [code, room] of rooms) {
    room.seats.forEach(seat => {
      if (seat && !seat.connected && now - (seat.disconnectedAt || 0) > RECONNECT_GRACE_MS) {
        // Sitz bleibt reserviert (Token), aber Verbindung ist endgueltig weg – kein Sonderfall noetig,
        // ein neuer Join mit demselben Token wuerde ohnehin nur bei aktivem ws greifen.
      }
    });
    if (now - room.lastActivity > ROOM_TTL_MS) { dropRoom(code); changed = true; }
  }
  if (changed) broadcastRoomList();
}, 5 * 60 * 1000);

async function start() {
  try {
    const n = await restoreRooms();
    console.log(`[persist] Speicher: ${store.kind}${store.kind === 'none' ? ' (nur Arbeitsspeicher)' : ` – ${n} Raum/Räume wiederhergestellt`}`);
  } catch (e) {
    console.error('[persist] Wiederherstellen fehlgeschlagen:', e.message);
  }
  try { push = await createPush({ store }); } catch (e) { console.error('[push] nicht verfuegbar:', e.message); }
  for (const r of rooms.values()) scheduleBot(r);
  server.listen(PORT, () => console.log(`Pesëqind-Server laeuft auf Port ${PORT}`));
}
async function shutdown() {
  try { await flushAllRooms(); } catch (e) { /* egal */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
start();
