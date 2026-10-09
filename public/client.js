/* Pesëqind online – Client. Haelt KEINE Spielwahrheit selbst; zeigt nur die
 * zuletzt vom Server empfangene Sicht (`view`) an und schickt Absichten
 * ("Karte X abwerfen") als Aktionen zurueck. Lokale Kartenauswahl ist rein
 * fuers Auge und wird bei jeder Aktion an den Server mitgeschickt.
 */
const R = window.PeshqinRules;
let ws = null;
let view = null;
let selected = new Set();
let everSawOpponent = false;
let bigCardsOn = false;
const CLIENT_BUILD = '2026-10-09.15'; // bei jeder Auslieferung mit server.js VERSION mitziehen
let serverBuild = null;
let watching = null;       // Raumcode, den wir nur beobachten (Zuschauer-Modus), sonst null
let serverVapidKey = null; // oeffentlicher VAPID-Schluessel des Servers (fuer Web-Push)
/* Zuschauer sehen "Du" nicht – dort stehen die echten Namen. */
const meName = () => (view && view.spectator ? view.myName : 'Du');
const meDat = () => (view && view.spectator ? view.myName : 'dir');
const meAkk = () => (view && view.spectator ? view.myName : 'dich');

/* ============================= EINSTELLUNGEN (nur lokal im Browser) ============================= */
function loadFlag(key, def) {
  try { const v = localStorage.getItem(key); return v === null ? def : v === '1'; } catch (e) { return def; }
}
function saveFlag(key, val) {
  try { localStorage.setItem(key, val ? '1' : '0'); } catch (e) { /* Speicher gesperrt – egal */ }
}
let handHidden = loadFlag('peseqind_hide_hand', false); // eigene Hand verdeckt (z. B. wenn man nebeneinander sitzt)
let showTrack = loadFlag('peseqind_show_track', true);  // Kartennamen im Verlauf anzeigen
let logFilter = 'all';                                  // 'all' | 'table'

/* ============================= VERBINDUNG ============================= */
function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

let lastMsgAt = Date.now();     // Zeitpunkt der letzten Nachricht vom Server (inkl. Pong)
let rejoining = false;          // true, solange ein Wiedereintritt in einen bekannten Raum laeuft
let connMsg = null;             // Text fuer die Verbindungsleiste (eigene Verbindungsprobleme)
let hbTimer = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let lobbyRetryTimer = null;
let lobbyRetries = 0;

/* Jeder Socket wird bei Ereignissen mit dem aktuellen `ws` verglichen: Nachrichten und
 * close-Ereignisse ALTER, schon abgeloester Sockets werden ignoriert. Sonst startet ein
 * spaetes "close" einer toten Verbindung faelschlich einen weiteren Reconnect. */
function connect(onOpen) {
  const sock = new WebSocket(wsUrl());
  ws = sock;
  sock.addEventListener('open', () => {
    if (sock !== ws) return;
    lastMsgAt = Date.now();
    startHeartbeat();
    onOpen && onOpen();
  });
  sock.addEventListener('message', ev => {
    if (sock !== ws) return;
    lastMsgAt = Date.now();
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    handleMessage(msg);
  });
  sock.addEventListener('close', () => lose(sock));
  sock.addEventListener('error', () => { /* close folgt von selbst */ });
  // Verbindungsaufbau haengt (z. B. Server wacht gerade erst auf)? Abbrechen und neu versuchen.
  setTimeout(() => {
    if (sock === ws && sock.readyState === 0) { try { sock.close(); } catch (e) { /* egal */ } lose(sock); }
  }, 12000);
}

function lose(sock) {
  if (sock !== ws) return; // veralteter Socket
  ws = null;
  stopHeartbeat();
  if (view || rejoining) scheduleReconnect();
  else scheduleLobbyRetry();
}

function dropSocket() {
  const s = ws;
  if (!s) return;
  try { s.close(); } catch (e) { /* egal */ }
  lose(s);
}

function scheduleReconnect(immediate) {
  const savedRoom = localStorage.getItem('peseqind_room');
  const savedToken = localStorage.getItem('peseqind_token');
  if (!watching && (!savedRoom || !savedToken)) { rejoining = false; return; }
  if (reconnectTimer) {
    if (!immediate) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (immediate) reconnectAttempts = 0;
  const delay = immediate ? 0 : Math.min(800 * Math.pow(1.6, reconnectAttempts), 5000);
  reconnectAttempts++;
  const text = `Verbindung unterbrochen – verbinde neu … (Versuch ${reconnectAttempts})`;
  if (view) { connMsg = text; updateStrip(); } else { setLobbyStatus(text); }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    rejoining = true;
    ensureConnected(() => send(watching
      ? { type: 'watch', room: watching }
      : { type: 'join', room: savedRoom, token: savedToken, name: currentName() }));
  }, delay);
}

function scheduleLobbyRetry() {
  if (lobbyRetryTimer || lobbyRetries >= 20) return;
  setLobbyStatus('Verbindung getrennt – versuche es erneut …', true);
  lobbyRetries++;
  lobbyRetryTimer = setTimeout(() => {
    lobbyRetryTimer = null;
    if (!ws && !view) connect();
  }, 3000);
}

function ensureConnected(cb) {
  if (ws && ws.readyState === 1) {
    cb();
  } else if (ws && ws.readyState === 0) {
    // Verbindung baut sich gerade auf (z. B. direkt nach dem Laden der Seite) – warten statt eine zweite zu oeffnen.
    const sock = ws;
    sock.addEventListener('open', () => { if (sock === ws) cb(); }, { once: true });
  } else {
    connect(cb);
  }
}

function send(msg) {
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(msg)); return true; }
  return false;
}

function sendAction(action, payload) {
  if (view && view.spectator) return; // Zuschauer duerfen nichts tun
  const ok = send({ type: 'action', action, payload: payload || {} });
  if (!ok) {
    flashBanner('Keine Verbindung – verbinde neu …');
    if (view) scheduleReconnect(true);
  }
}

/* Heartbeat auf Anwendungsebene: Handy-Browser liefern nach einem App-Wechsel oft eine
 * "scheinbar offene" Verbindung, die in Wahrheit tot ist. Ohne Antwort binnen 45 s (oder
 * 3,5 s nach der Rueckkehr in die App) wird sie verworfen und sofort neu aufgebaut. */
function startHeartbeat() {
  stopHeartbeat();
  hbTimer = setInterval(() => {
    if (!ws || ws.readyState !== 1) return;
    if (Date.now() - lastMsgAt > 45000) { dropSocket(); return; }
    send({ type: 'ping' });
  }, 15000);
}
function stopHeartbeat() {
  if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
}
function probeConnection() {
  if (ws && ws.readyState === 0) return; // baut sich gerade auf
  if (!ws || ws.readyState !== 1) {
    if (view || rejoining) scheduleReconnect(true);
    else if (!lobbyRetryTimer) { lobbyRetries = 0; connect(); }
    return;
  }
  const t0 = Date.now();
  send({ type: 'ping' });
  setTimeout(() => { if (ws && lastMsgAt < t0) dropSocket(); }, 3500);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') probeConnection(); });
window.addEventListener('online', probeConnection);
window.addEventListener('pageshow', probeConnection);
window.addEventListener('focus', probeConnection);

function handleMessage(msg) {
  if (msg.type === 'joined') {
    reconnectAttempts = 0;
    rejoining = false;
    connMsg = null;
    localStorage.setItem('peseqind_room', msg.room);
    localStorage.setItem('peseqind_token', msg.token);
    if (msg.vapidPublicKey !== undefined) serverVapidKey = msg.vapidPublicKey;
    showBoard(msg.room);
    updateStrip();
    reportVisibility();
    refreshPushSubscription();
  } else if (msg.type === 'watching') {
    reconnectAttempts = 0;
    rejoining = false;
    connMsg = null;
    watching = msg.room;
    document.body.classList.add('spectator');
    showBoard(msg.room, true);
    updateStrip();
  } else if (msg.type === 'state') {
    connMsg = null;
    const prev = view;
    view = msg.view;
    everSawOpponent = everSawOpponent || view.opponentConnected;
    if (!watching) document.getElementById('btnCopyLink').style.display = view.oppIsBot ? 'none' : ''; // gegen den Computer gibt es nichts zu teilen
    clockRecv = view.clock ? { remaining: view.clock.remaining.slice(), running: view.clock.running, at: performance.now() } : null;
    renderClocks();
    render();
    onViewChange(prev, view);
  } else if (msg.type === 'roomList') {
    if (msg.version) showVersion(msg.version, msg.persist);
    if (msg.vapidPublicKey !== undefined) serverVapidKey = msg.vapidPublicKey;
    renderRoomList(msg.rooms);
  } else if (msg.type === 'pushStatus') {
    if (!msg.ok) flashBanner(msg.message || 'Push konnte nicht aktiviert werden.');
  } else if (msg.type === 'error') {
    if (watching && msg.code === 'ROOM_NOT_FOUND') {
      watching = null;
      document.body.classList.remove('spectator');
      backToLobby('Dieser Raum existiert nicht mehr (der Server wurde zwischenzeitlich neu gestartet).');
      return;
    }
    if (rejoining && (msg.code === 'ROOM_NOT_FOUND' || msg.code === 'ROOM_FULL')) {
      // Der Raum, in den wir zurueck wollten, gibt es nicht mehr (z. B. Server wurde neu
      // gestartet) oder der Platz ist weg: sauber zurueck in die Lobby statt haengen bleiben.
      rejoining = false;
      forgetRoom();
      backToLobby(msg.code === 'ROOM_NOT_FOUND'
        ? 'Dieser Raum existiert nicht mehr (der Server wurde zwischenzeitlich neu gestartet). Erstelle einen neuen Raum.'
        : msg.message);
      return;
    }
    if (view) flashBanner(msg.message);
    else setLobbyStatus(msg.message, true);
  }
}

/* ============================= LOBBY ============================= */
function showVersion(v, persist) {
  const mem = persist === 'redis' ? ' · Speicher: Redis (dauerhaft)'
            : persist === 'file' ? ' · Speicher: Datei'
            : persist === 'none' ? ' · Speicher: nur Arbeitsspeicher' : '';
  document.querySelectorAll('.ver-label').forEach(el => (el.textContent = 'Server-Version ' + v + mem));
  serverBuild = v;
  updateVerTag();
}
/* Winzige, dauerhaft sichtbare Versionsangabe (unten rechts) – damit man auf jedem Screenshot sieht,
 * welcher Stand wirklich laeuft. Weichen Seite und Server ab, ist die Seite veraltet (neu laden). */
function updateVerTag() {
  const el = document.getElementById('verTag');
  if (!el) return;
  const same = !serverBuild || serverBuild === CLIENT_BUILD;
  el.textContent = same ? `v${CLIENT_BUILD}` : `Seite v${CLIENT_BUILD} ≠ Server v${serverBuild}`;
  el.classList.toggle('mismatch', !same);
}
function setLobbyStatus(text, isErr) {
  const el = document.getElementById('lobbyStatus');
  el.textContent = text || '';
  el.classList.toggle('err', !!isErr);
}

function showBoard(roomCode, spectator) {
  document.getElementById('lobby').classList.add('hidden');
  const badge = document.getElementById('roomBadge');
  badge.style.display = 'flex';
  document.getElementById('roomCodeLabel').textContent = roomCode;
  document.getElementById('specLabel').style.display = spectator ? '' : 'none';
  history.replaceState(null, '', (spectator ? '?watch=' : '?room=') + roomCode);
}

function forgetRoom() {
  localStorage.removeItem('peseqind_room');
  localStorage.removeItem('peseqind_token');
  document.getElementById('resumeBox').style.display = 'none';
}

function backToLobby(message) {
  watching = null;
  document.body.classList.remove('spectator');
  view = null;
  everSawOpponent = false;
  selected = new Set();
  connMsg = null;
  updateStrip();
  ['roundOverlay', 'waitOverlay', 'discardPickerOverlay'].forEach(id => document.getElementById(id).classList.remove('visible'));
  document.getElementById('lobby').classList.remove('hidden');
  document.getElementById('roomBadge').style.display = 'none';
  history.replaceState(null, '', location.pathname);
  setLobbyStatus(message, true);
  send({ type: 'listRooms' });
}

const nameInput = document.getElementById('nameInput');
nameInput.value = localStorage.getItem('peseqind_name') || '';
nameInput.addEventListener('input', () => {
  localStorage.setItem('peseqind_name', nameInput.value.trim());
});
function currentName() {
  return nameInput.value.trim() || 'Spieler';
}

/* Beitritt per Code/Liste/Link. Kennen wir fuer GENAU diesen Raum noch unseren Platz
 * (Token), wird er mitgeschickt – so landet man nach Reload/Absturz wieder auf dem eigenen
 * Platz, statt "Raum ist bereits voll" zu bekommen. */
function joinRoom(code) {
  setLobbyStatus('Verbinde …');
  const token = localStorage.getItem('peseqind_room') === code ? localStorage.getItem('peseqind_token') : null;
  rejoining = !!token;
  ensureConnected(() => send({ type: 'join', room: code, name: currentName(), token: token || undefined }));
}

function watchRoom(code) {
  setLobbyStatus('Verbinde …');
  rejoining = false;
  ensureConnected(() => send({ type: 'watch', room: code }));
}
document.getElementById('btnWatch').addEventListener('click', () => {
  const code = document.getElementById('joinCodeInput').value.trim().toUpperCase();
  if (code.length !== 4) { setLobbyStatus('Bitte den 4-stelligen Code eingeben.', true); return; }
  watchRoom(code);
});

document.getElementById('btnCreate').addEventListener('click', () => {
  setLobbyStatus('Erstelle Raum …');
  rejoining = false;
  ensureConnected(() => send({ type: 'create', name: currentName(), settings: lobbySettings() }));
});

/* ---------- Lobby-Einstellungen: Bedenkzeit (Fischer) und Vorgabe ---------- */
function lobbySettings() {
  const sel = document.getElementById('optClock').value;
  let minutes = 0, increment = 0;
  if (sel === 'custom') {
    minutes = Number(document.getElementById('optMin').value) || 0;
    increment = Number(document.getElementById('optInc').value) || 0;
  } else if (sel) {
    const [m, i] = sel.split('+').map(Number);
    minutes = m; increment = i;
  }
  const hc = id => Math.round(Number(document.getElementById(id).value) || 0);
  const out = { minutes, increment, handicap: [hc('optHcMe'), hc('optHcOpp')] };
  try { localStorage.setItem('peseqind_settings', JSON.stringify({ sel, min: document.getElementById('optMin').value, inc: document.getElementById('optInc').value, h: out.handicap })); } catch (e) { /* egal */ }
  return out;
}
(function restoreLobbySettings() {
  try {
    const st = JSON.parse(localStorage.getItem('peseqind_settings') || 'null');
    if (st) {
      document.getElementById('optClock').value = st.sel || '';
      if (st.min) document.getElementById('optMin').value = st.min;
      if (st.inc !== undefined) document.getElementById('optInc').value = st.inc;
      if (st.h) { document.getElementById('optHcMe').value = st.h[0] || 0; document.getElementById('optHcOpp').value = st.h[1] || 0; }
    }
  } catch (e) { /* egal */ }
  const upd = () => { document.getElementById('optCustom').style.display = document.getElementById('optClock').value === 'custom' ? '' : 'none'; };
  document.getElementById('optClock').addEventListener('change', upd);
  upd();
})();

/* ---------- Uhr-Anzeige: zaehlt lokal zwischen den Server-Updates herunter ---------- */
let clockRecv = null; // { remaining:[ms,ms], running, at }
function fmtClock(ms) {
  ms = Math.max(0, ms);
  const tot = Math.ceil(ms / 1000);
  if (ms < 10000) return (ms / 1000).toFixed(1).replace('.', ',') + ' s';
  return Math.floor(tot / 60) + ':' + String(tot % 60).padStart(2, '0');
}
function renderClocks() {
  const me = document.getElementById('meClock'), op = document.getElementById('oppClock');
  if (!view || !view.clock || !clockRecv) { me.style.display = 'none'; op.style.display = 'none'; return; }
  const myIdx = view.myIndex, oppIdx = myIdx === 0 ? 1 : 0;
  const left = i => clockRecv.remaining[i] - (clockRecv.running === i ? performance.now() - clockRecv.at : 0);
  [[me, myIdx], [op, oppIdx]].forEach(([el, i]) => {
    const ms = left(i);
    el.style.display = '';
    el.textContent = '⏱ ' + fmtClock(ms);
    el.classList.toggle('running', clockRecv.running === i);
    el.classList.toggle('low', ms < 30000);
  });
}
setInterval(renderClocks, 200);

function settingsSummary(st) {
  if (!st) return '';
  const parts = [];
  if (st.clock) parts.push(`⏱ ${st.clock.baseMs / 60000} Min + ${st.clock.incMs / 1000} s`);
  const [a, b] = st.handicap || [0, 0];
  if (a || b) parts.push(`Vorgabe ${a >= 0 ? '+' : ''}${a} / ${b >= 0 ? '+' : ''}${b}`);
  return parts.join(' · ');
}

document.getElementById('btnResign').addEventListener('click', () => {
  if (!view || view.spectator) return;
  if (view.roundOver && view.pendingWinner !== null) return;
  if (!confirm('Wirklich aufgeben? Das Spiel endet sofort und ' + (view.oppName || 'dein Gegner') + ' gewinnt.')) return;
  document.getElementById('dropMenu').classList.remove('open');
  sendAction('resign');
});

document.querySelectorAll('[data-bot]').forEach(btn => btn.addEventListener('click', () => {
  setLobbyStatus('Starte Spiel gegen den Computer …');
  rejoining = false;
  ensureConnected(() => send({ type: 'create', name: currentName(), bot: btn.dataset.bot, settings: lobbySettings() }));
}));

document.getElementById('btnJoin').addEventListener('click', () => {
  const code = document.getElementById('joinCodeInput').value.trim().toUpperCase();
  if (code.length !== 4) { setLobbyStatus('Bitte den 4-stelligen Code eingeben.', true); return; }
  joinRoom(code);
});

document.getElementById('btnCopyLink').addEventListener('click', () => {
  navigator.clipboard.writeText(location.href).then(() => {
    const btn = document.getElementById('btnCopyLink');
    const old = btn.textContent;
    btn.textContent = 'Kopiert!';
    setTimeout(() => (btn.textContent = old), 1400);
  });
});

document.getElementById('btnCopyWatch').addEventListener('click', () => {
  const code = document.getElementById('roomCodeLabel').textContent;
  navigator.clipboard.writeText(`${location.origin}${location.pathname}?watch=${code}`).then(() => {
    const btn = document.getElementById('btnCopyWatch');
    const old = btn.textContent;
    btn.textContent = 'Kopiert!';
    setTimeout(() => (btn.textContent = old), 1400);
  });
});

document.getElementById('btnLeaveGame').addEventListener('click', () => {
  if (watching) { location.href = location.pathname; return; }
  if (!confirm('Spiel wirklich verlassen? Der Raum-Link funktioniert danach nicht mehr fuer dich.')) return;
  forgetRoom();
  location.href = location.pathname;
});

/* ============================= RAUMLISTE ============================= */
function renderRoomList(rooms) {
  const box = document.getElementById('roomListItems');
  if (!box) return;
  box.innerHTML = '';
  if (!rooms || rooms.length === 0) {
    box.innerHTML = '<div class="room-list-empty">Gerade keine offenen Räume – erstell doch eins!</div>';
    return;
  }
  rooms.forEach(r => {
    const btn = document.createElement('button');
    btn.className = 'room-list-item';
    const names = r.players.filter(Boolean).map(escapeHtml).join(', ') || 'noch niemand da';
    btn.innerHTML = `<span class="rl-code">${r.code}</span><span class="rl-info">${r.count}/2 · ${names}</span>`;
    btn.addEventListener('click', () => joinRoom(r.code));
    box.appendChild(btn);
  });
}

/* ============================= START / RECONNECT ============================= */
(function initialLoad() {
  const params = new URLSearchParams(location.search);
  const urlRoom = (params.get('room') || '').toUpperCase();
  const urlWatch = (params.get('watch') || '').toUpperCase();
  if (urlRoom || urlWatch) document.getElementById('joinCodeInput').value = urlRoom || urlWatch;

  const savedRoom = localStorage.getItem('peseqind_room');
  const savedToken = localStorage.getItem('peseqind_token');
  if (savedRoom && savedToken) {
    document.getElementById('resumeRoomLabel').textContent = savedRoom;
    document.getElementById('resumeBox').style.display = 'flex';
  }

  if (urlWatch.length === 4) {
    // Zuschauer-Link: nur beobachten, niemals einen Platz belegen.
    setLobbyStatus(`Verbinde als Zuschauer mit Raum ${urlWatch} …`);
    connect(() => send({ type: 'watch', room: urlWatch }));
  } else if (urlRoom && savedRoom === urlRoom && savedToken) {
    // Seite im SELBEN Raum neu geladen (F5 / App-Neustart / Link): direkt wieder auf den
    // eigenen Platz springen. Existiert der Raum nicht mehr, faengt handleMessage das ab.
    rejoining = true;
    setLobbyStatus(`Verbinde mit Raum ${urlRoom} …`);
    connect(() => send({ type: 'join', room: urlRoom, token: savedToken, name: currentName() }));
  } else {
    // Sonst NUR verbinden, um die Raumliste zu bekommen – niemals still einem Raum beitreten.
    connect();
  }
})();

document.getElementById('btnResume').addEventListener('click', () => {
  const savedRoom = localStorage.getItem('peseqind_room');
  const savedToken = localStorage.getItem('peseqind_token');
  if (!savedRoom || !savedToken) return;
  setLobbyStatus('Verbinde erneut …');
  rejoining = true;
  ensureConnected(() => send({ type: 'join', room: savedRoom, token: savedToken, name: currentName() }));
});

document.getElementById('btnForgetRoom').addEventListener('click', () => {
  rejoining = false;
  forgetRoom();
});

/* ============================= UI HELFER ============================= */
let flashTimer = null;
function flashBanner(msg) {
  const b = document.getElementById('turnBanner');
  b.textContent = msg;
  b.classList.add('flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { b.classList.remove('flash'); render(); }, 2800);
}

function updateStrip() {
  const el = document.getElementById('connStrip');
  if (!el) return;
  let text = connMsg || '';
  if (!text && view && view.spectator) {
    if (view.p0Connected === false) text = `${view.myName} ist gerade offline – das Spiel wartet …`;
    else if (everSawOpponent && !view.opponentConnected) text = `${view.oppName} ist gerade offline – das Spiel wartet …`;
  } else if (!text && view && everSawOpponent && !view.opponentConnected) {
    text = `${view.oppName} ist gerade offline – das Spiel wartet …`;
  }
  el.textContent = text;
  el.classList.toggle('visible', !!text);
}

function toggleSelect(cardId) {
  if (selected.has(cardId)) selected.delete(cardId); else selected.add(cardId);
  render();
}
function clearSelection() { selected = new Set(); render(); }
function selectedCards() {
  if (!view) return [];
  return view.myHand.filter(c => selected.has(c.id));
}

function toggleDrop(id) {
  const el = document.getElementById(id);
  const wasOpen = el.classList.contains('open');
  closeDrops();
  if (!wasOpen) el.classList.add('open');
}
function closeDrops() {
  document.querySelectorAll('.drop').forEach(d => d.classList.remove('open'));
}
document.addEventListener('click', e => { if (!e.target.closest('.score-box')) closeDrops(); }, true);

document.querySelectorAll('.drop').forEach(d => {
  const x = document.createElement('button');
  x.className = 'drop-close';
  x.textContent = '✕';
  x.setAttribute('aria-label', 'Schließen');
  x.addEventListener('click', e => { e.stopPropagation(); closeDrops(); });
  d.insertBefore(x, d.firstChild);
});
document.getElementById('btnDropHistory').addEventListener('click', () => toggleDrop('dropHistory'));
document.getElementById('btnDropLog').addEventListener('click', () => toggleDrop('dropLog'));
document.getElementById('btnDropMenu').addEventListener('click', () => toggleDrop('dropMenu'));
document.getElementById('bigCardsBtn').addEventListener('click', () => {
  bigCardsOn = !bigCardsOn;
  document.body.classList.toggle('big-cards', bigCardsOn);
  document.getElementById('bigCardsBtn').textContent = bigCardsOn ? '🔍 Kleinere Karten' : '🔍 Größere Karten';
});

/* --- Schalter: eigene Hand verdecken / Kartennamen im Verlauf --- */
function updateToggleLabels() {
  const eye = document.getElementById('btnHandEye');
  eye.textContent = handHidden ? '🙈 verdeckt' : '👁 Karten';
  eye.classList.toggle('active', handHidden);
  document.getElementById('btnToggleHand').textContent = handHidden ? '🙈 Meine Karten: verdeckt' : '👁 Meine Karten: sichtbar';
  document.getElementById('btnToggleTrack').textContent = showTrack ? '📜 Kartennamen im Verlauf: an' : '📜 Kartennamen im Verlauf: aus';
}
function setHandHidden(v) {
  handHidden = v;
  saveFlag('peseqind_hide_hand', v);
  if (v) selected = new Set();
  updateToggleLabels();
  render();
}
function setShowTrack(v) {
  showTrack = v;
  saveFlag('peseqind_show_track', v);
  updateToggleLabels();
  if (view) renderLog();
}
document.getElementById('btnHandEye').addEventListener('click', () => setHandHidden(!handHidden));
document.getElementById('btnToggleHand').addEventListener('click', () => setHandHidden(!handHidden));
document.getElementById('btnToggleTrack').addEventListener('click', () => setShowTrack(!showTrack));
document.querySelectorAll('#logTools [data-f]').forEach(btn => {
  btn.addEventListener('click', () => { logFilter = btn.dataset.f; if (view) renderLog(); });
});
updateToggleLabels();

/* ============================= AKTIONEN AUS BUTTONS ============================= */
document.getElementById('btnClearSel').addEventListener('click', clearSelection);
/* ---- Auswahl-Menue: Welche Karte ist der Joker? (nur wenn mehrere Lagen zulaessig sind) ---- */
function tableKeysClient() {
  const keys = new Set();
  ((view && view.tableMelds) || []).forEach(m => m.cards.forEach(mc => { if (!mc.card.isJoker) keys.add(mc.card.value + '_' + mc.card.suit); }));
  return keys;
}
function showJokerChoice(title, choices, onPick) {
  closeJokerChoice();
  const ov = document.createElement('div');
  ov.id = 'jokerChoice';
  ov.innerHTML = '<div class="jc-box"><h3></h3><div class="jc-hint">Tippe, welche Karte der Joker darstellen soll. Die Wahl ist danach fest.</div><div class="jc-list"></div><button class="action jc-cancel">Abbrechen</button></div>';
  ov.querySelector('h3').textContent = title;
  const list = ov.querySelector('.jc-list');
  choices.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'action' + (i === 0 ? ' primary' : '');
    b.innerHTML = '';
    const t = document.createElement('span');
    t.textContent = c.jokers.length
      ? 'Joker = ' + c.jokers.map(v => v + c.suit).join(' und ') + (c.natural ? ` · 2${c.suit} echt` : '')
      : `2${c.suit} als echte 2 (Ass-2-3-4 …)`;
    const p = document.createElement('small');
    p.textContent = c.points + ' P' + (i === 0 ? ' · meiste Punkte' : '');
    b.appendChild(t); b.appendChild(p);
    b.onclick = () => { closeJokerChoice(); onPick(c); };
    list.appendChild(b);
  });
  ov.querySelector('.jc-cancel').onclick = closeJokerChoice;
  document.getElementById('appRoot').appendChild(ov);
}
function closeJokerChoice() {
  const el = document.getElementById('jokerChoice');
  if (el) el.remove();
}
document.getElementById('btnLaySelection').addEventListener('click', () => {
  const cards = selectedCards();
  const ids = cards.map(c => c.id);
  const open = isOpenClient();
  const info = R.classifyGroup(cards, undefined, open);
  if (info && info.type === 'run' && cards.some(c => c.isJoker)) {
    const ch = R.runChoices(cards, open, tableKeysClient());
    if (ch.length > 1) {
      showJokerChoice('Welche Karte ist dein Joker?', ch, c => {
        sendAction('lay', { cardIds: ids, runStart: c.startIdx });
        clearSelection();
      });
      return;
    }
  }
  sendAction('lay', { cardIds: ids });
  clearSelection();
});
document.getElementById('btnDrawBig').addEventListener('click', () => sendAction('draw'));
document.getElementById('btnUndo').addEventListener('click', () => { selected.clear(); sendAction('undo'); });
document.getElementById('btnUndoAll').addEventListener('click', () => {
  if (view && view.undoCount > 1 && !confirm(`Alle ${view.undoCount} Aktionen dieses Zuges zurücksetzen?`)) return;
  selected.clear();
  sendAction('undoAll');
});
document.getElementById('btnPickupBig').addEventListener('click', () => {
  if (!view || view.discardPile.length < 2) { flashBanner('Mindestens 2 Karten im Ablagestapel noetig.'); return; }
  openDiscardPicker();
});
document.getElementById('btnDiscardSelected').addEventListener('click', () => {
  const cards = selectedCards();
  if (cards.length !== 1) { flashBanner('Waehle genau eine Karte zum Abwerfen.'); return; }
  sendAction('discard', { cardId: cards[0].id });
  clearSelection();
});
document.getElementById('btnEndRoundFacedown').addEventListener('click', () => {
  sendAction('endRoundFacedown');
});
document.getElementById('roundContinueBtn').addEventListener('click', () => {
  sendAction('nextRound');
  document.getElementById('roundOverlay').classList.remove('visible');
});
document.getElementById('btnCancelPicker').addEventListener('click', closeDiscardPicker);
/* Klick auf den Ablagestapel: IMMER eine Vorschau aller Karten (von alt nach neu). Ist man mit
 * Ziehen/Aufnehmen dran und liegen mind. 2 Karten, dient dieselbe Ansicht zum Aufnehmen. */
document.getElementById('discardFan').addEventListener('click', () => {
  if (!view) return;
  if (view.discardPile.length === 0) { flashBanner('Der Ablagestapel ist noch leer.'); return; }
  openDiscardPicker();
});
document.getElementById('deckBack').addEventListener('click', () => sendAction('draw'));

function canPickupNow() {
  return !!view && view.isMyTurn && view.needsDraw && !view.skipDrawThisTurn && view.discardPile.length >= 2;
}
function openDiscardPicker() {
  renderDiscardPicker();
  document.getElementById('discardPickerOverlay').classList.add('visible');
}
function closeDiscardPicker() {
  document.getElementById('discardPickerOverlay').classList.remove('visible');
}
function renderDiscardPicker() {
  const row = document.getElementById('pickerRow');
  row.innerHTML = '';
  const pile = view.discardPile;
  const pickMode = canPickupNow();
  document.getElementById('pickerTitle').textContent = pickMode
    ? 'Wie viele Karten aufnehmen?'
    : `Ablagestapel · ${pile.length} Karte${pile.length === 1 ? '' : 'n'}`;
  document.getElementById('pickerHint').textContent = pickMode
    ? 'Tippe die Karte, ab der aufgenommen wird – diese plus alles rechts davon wandert auf deine Hand. Mindestens 2 Karten.'
    : 'Vorschau – links die älteste, rechts die zuletzt abgeworfene Karte.';
  document.getElementById('btnCancelPicker').textContent = pickMode ? 'Abbrechen' : 'Schließen';
  pile.forEach((card, idx) => {
    const takeCount = pile.length - idx;
    const el = buildCardEl(card);
    if (pickMode) {
      const pickable = takeCount >= 2;
      el.classList.add(pickable ? 'pickable' : 'unpickable');
      el.title = pickable ? `${takeCount} Karten aufnehmen` : 'Mindestens 2 Karten noetig';
      if (pickable) el.onclick = () => { sendAction('pickup', { index: idx }); closeDiscardPicker(); };
    } else {
      el.style.cursor = 'default';
    }
    row.appendChild(el);
  });
}

function attachSelectedToMeld(meldId) {
  const cards = selectedCards();
  if (cards.length !== 1) return;
  const card = cards[0];
  const meld = view && view.tableMelds.find(m => m.id === meldId);
  if (card.isJoker && meld) {
    const ch = R.attachJokerChoices(meld.cards.map(mc => mc.card), meld.runStart, isOpenClient(), tableKeysClient(), card);
    if (ch.length > 1) {
      showJokerChoice('Joker anlegen – welche Karte?', ch.map(c => ({ ...c, jokers: c.jokers })), c => {
        sendAction('attach', { cardId: card.id, meldId, runStart: c.startIdx });
        clearSelection();
      });
      return;
    }
  }
  sendAction('attach', { cardId: card.id, meldId });
  clearSelection();
}
function swapSelectedForJoker(meldId) {
  const cards = selectedCards();
  if (cards.length !== 1) return;
  sendAction('swap', { cardId: cards[0].id, meldId });
  clearSelection();
}
function dissolveMeld(meldId) { sendAction('dissolve', { meldId }); }

/* ============================= RENDER ============================= */
/* Verhindert das "Glitchen": ohne dies wuerde JEDE Karte bei JEDEM Render
 * (also z.B. bei jedem Klick zum Auswaehlen) die Eintritts-Animation neu
 * abspielen, weil der DOM komplett neu aufgebaut wird. Stattdessen merken
 * wir uns pro Kontext (Hand/Tisch/Ablage/Rest), welche Karten-IDs schon mal
 * gezeigt wurden, und animieren nur wirklich neue Karten.
 */
let seenCardKeys = new Set();
let seenRound = null;
function noteRoundForSeen(round) {
  if (seenRound !== round) {
    seenCardKeys = new Set();
    seenRound = round;
  }
}
function enterFlag(context, id) {
  const key = context + '_' + id;
  const isNew = !seenCardKeys.has(key);
  seenCardKeys.add(key);
  return isNew;
}

function suitColor(suit) {
  if (suit === '♥') return 'heart';
  if (suit === '♦') return 'diamond';
  if (suit === '♣') return 'club';
  return 'spade';
}
/* Ein Joker in einer bereits gebildeten Gruppe (Set/Strasse) stellt IMMER eine
 * konkrete Karte dar. Statt ihn generisch als "JK ★" zu zeigen (verwirrend,
 * v.a. weil die physische Karte ja eigentlich eine 2 ist), zeigen wir bei
 * Karten auf dem Tisch den Rang/die Farbe, die er gerade vertritt – der
 * goldene Kartenhintergrund plus ein kleines ★-Badge markieren weiterhin,
 * dass es sich um einen Joker handelt. In der Hand (noch keiner Gruppe
 * zugeordnet) bleibt die generische Anzeige, weil dort keine Identitaet
 * feststeht.
 */
function jokerDisplayMap(cardsInOrder, runStart) {
  const map = {};
  if (!cardsInOrder || cardsInOrder.length < 3) return map;
  const info = R.classifyGroup(cardsInOrder, runStart);
  if (!info) return map;
  if (info.type === 'run') {
    // Sitzt ein Joker am Rand der Strasse, kann er oben ODER unten stehen -> Rang offen ("?").
    // Sobald die Lage festgeschrieben ist (runStart, gesetzt beim Auslegen/Anlegen/Tauschen),
    // steht die Karte fest und wird konkret gezeigt (z. B. Kreuz-Ass).
    const fixed = runStart !== undefined && runStart !== null;
    const alts = R.allRunAssignments(cardsInOrder);
    info.slots.forEach(slot => {
      if (slot.natural) { map[slot.card.id] = { value: '2', suit: info.suit, natural: true }; return; }
      if (!slot.card.isJoker) return;
      const ranks = new Set(alts.map(a => {
        const sl = a.slots.find(x => x.card.id === slot.card.id);
        return sl ? R.rankAt(sl.rankIdx) : null;
      }));
      map[slot.card.id] = { value: (ranks.size > 1 && !fixed) ? '?' : R.rankAt(slot.rankIdx), suit: info.suit };
    });
  } else if (info.type === 'set') {
    // Welche Farbe ein Joker im Set darstellt, steht erst fest, wenn nur noch genau so viele
    // Farben moeglich sind wie Joker da sind. Moeglich = fehlende Farben, deren echte Karte
    // NICHT offen liegt (Tisch, Rest, Ablage). Bis dahin: "?" – eine Schroedinger-Karte.
    const jokers = cardsInOrder.filter(c => c.isJoker);
    const usedSuits = new Set(cardsInOrder.filter(c => !c.isJoker).map(c => c.suit));
    const free = R.SUITS.filter(su => !usedSuits.has(su));
    const open = new Set();
    if (view) {
      view.tableMelds.forEach(m => m.cards.forEach(mc => { if (!mc.card.isJoker) open.add(R.cardKey(mc.card)); }));
      if (view.reserveCard && !view.reserveCard.isJoker) open.add(R.cardKey(view.reserveCard));
      view.discardPile.forEach(c => { if (!c.isJoker) open.add(R.cardKey(c)); });
    }
    const candidates = free.filter(su => !open.has(info.rank + '_' + su));
    const settled = candidates.length <= jokers.length && candidates.length > 0;
    let fi = 0;
    cardsInOrder.forEach(c => {
      if (!c.isJoker) return;
      map[c.id] = { value: info.rank, suit: settled ? (candidates[fi] || '?') : '?' };
      fi++;
    });
  }
  return map;
}
function buildCardEl(card, opts = {}) {
  const el = document.createElement('div');
  const table = opts.table || opts.mini;
  const disp = opts.displayAs; // {value, suit} – welche Karte ein Joker hier gerade darstellt ('?' = noch offen)
  const natural = !!(disp && disp.natural); // echte 2 in Ass-2-3-4 …: wie eine normale Karte zeigen
  const isGenericJoker = card.isJoker && !disp;
  const unsure = !!disp && (disp.suit === '?' || disp.value === '?');
  const colorCls = unsure && disp.suit === '?' ? 'unsure' : suitColor(disp ? disp.suit : card.suit);
  el.className = 'card ' + colorCls + (card.isJoker && !natural ? ' joker' : '') + (isGenericJoker ? ' generic' : '') + (unsure ? ' unsure' : '') + (table ? ' tc' : '') + (card.faceDown ? ' facedown' : '') + (opts.ghost ? ' ghost' : '') + (opts.enter ? ' card-enter' : '');
  el.dataset.cardId = card.id;
  if (card.faceDown) {
    el.innerHTML = '';
  } else if (isGenericJoker) {
    el.innerHTML = `<span class="corner"><span class="r">JK</span><span class="s">${card.suit}</span></span><span class="mid">★</span>`;
  } else if (natural) {
    el.title = 'Echte 2 (Straße Ass-2-3-4 …)';
    el.innerHTML = `<span class="corner"><span class="r">2</span><span class="s">${card.suit}</span></span><span class="mid">${card.suit}</span>`;
  } else if (card.isJoker) {
    el.title = unsure ? 'Joker – welche Karte er darstellt, steht noch nicht fest' : '';
    el.innerHTML = `<span class="corner"><span class="r">${disp.value}</span><span class="s">${disp.suit}</span></span><span class="mid">${disp.suit}</span><span class="joker-badge">★</span>`;
  } else {
    el.innerHTML = `<span class="corner"><span class="r">${card.value}</span><span class="s">${card.suit}</span></span><span class="mid">${card.suit}</span>`;
  }
  return el;
}
function setHandBadge(id, count) {
  const el = document.getElementById(id);
  el.innerHTML = `🂠 <b>${count}</b>`;
  el.classList.toggle('low', count === 1);
}
function isOpenClient() {
  return view ? R.makeIsOpen(view.reserveCard, view.discardPile) : null;
}
/* Steht ein Joker am Rand einer Strasse (oben/unten moeglich), zaehlt die wertvollste erlaubte
 * Karte. Dieser Hinweis sagt, als was er gerade gewertet wird. */
function jokerScoreNote(cards, runStart, always) {
  const info = R.classifyGroup(cards, runStart);
  if (!info || info.type !== 'run') return '';
  const alts = R.allRunAssignments(cards);
  if (alts.length < 2 && !always) return '';
  const notes = info.slots.filter(R.isJokerSlot).map(sl => R.rankAt(sl.rankIdx));
  return notes.length ? ` · Joker zählt als ${notes.join(', ')}` : '';
}
function jokerConflicts(cards) {
  if (!view) return [];
  return R.jokerVisibilityConflicts(cards, view.reserveCard, view.discardPile);
}
function tablePoints() {
  const plus = [0, 0];
  view.tableMelds.forEach(m => { const s = R.meldPointSplit(m); plus[0] += s[0]; plus[1] += s[1]; });
  return plus;
}
function renderScoreRows(plus) {
  const me = view.myIndex, opp = me === 0 ? 1 : 0;
  document.querySelector('.srow.opp').innerHTML =
    `<span>${escapeHtml(view.oppName)}</span><span style="opacity:.65; font-size:9.5px;">Tisch +${plus[opp]}</span><b>${view.scores[opp]}</b>`;
  document.querySelector('.srow.me').innerHTML =
    `<span>${escapeHtml(meName())}</span><span style="opacity:.75; font-size:9.5px; font-weight:600;">Tisch +${plus[me]}</span><b>${view.scores[me]}</b>`;
}
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}
function renderDiscardFan() {
  const fan = document.getElementById('discardFan');
  fan.innerHTML = '';
  const pile = view.discardPile;
  if (pile.length === 0) { fan.innerHTML = '<div class="fan-empty">leer</div>'; return; }
  const n = pile.length;
  const step = n <= 2 ? .74 : n <= 4 ? .56 : n <= 7 ? .42 : n <= 11 ? .32 : n <= 16 ? .24 : .18;
  fan.style.setProperty('--step', step);
  pile.forEach((c, i) => {
    const el = buildCardEl(c, { table: true, enter: enterFlag('discard', c.id) });
    el.style.zIndex = i + 1;
    fan.appendChild(el);
  });
  fan.scrollLeft = fan.scrollWidth;
}
function makeStem() {
  const stem = document.createElement('div');
  stem.className = 'link-stem';
  stem.innerHTML = '<span class="lock">🔒 verbunden</span>';
  stem.title = 'Diese Gruppe gehört beiden Seiten und bleibt fixiert – es darf nur noch angelegt werden.';
  return stem;
}

/* ---------- Gruppen ----------
 * Jede Gruppe liegt auf der Seite ihres BESITZERS (der sie ausgelegt hat). Karten, die der
 * ANDERE Spieler daran angelegt hat, liegen auf SEINER eigenen Seite in einem eigenen
 * "Anbau" ("↗ an Gruppe 2 …"). Im Besitzer-Set bleibt dafür nur ein blasser Platzhalter
 * (gestrichelt), damit Reihenfolge/Straße lesbar bleiben. Die Punkte folgen immer der Seite,
 * auf der die Karte liegt. */
function meldDesc(meld) {
  const info = R.classifyGroup(meld.cards.map(mc => mc.card), meld.runStart);
  if (!info) return 'Gruppe';
  if (info.type === 'set') return `Set ${info.rank}`;
  if (info.type === 'run') return `Straße ${info.suit}`;
  return 'Jokergruppe';
}
/* Strassen in Rang-Reihenfolge zeigen (nicht in der Reihenfolge, in der gelegt wurde). */
function orderedEntries(meld) {
  const info = R.classifyGroup(meld.cards.map(mc => mc.card), meld.runStart);
  if (info && info.type === 'run') {
    const byId = {};
    meld.cards.forEach(mc => (byId[mc.card.id] = mc));
    return info.slots.map(sl => byId[sl.card.id]).filter(Boolean);
  }
  if (info && info.type === 'set') { const cmp = compareCards('suit'); return meld.cards.slice().sort((x, y) => cmp(x.card, y.card)); } // Farben ordentlich, Joker zuletzt
  return meld.cards;
}

/* ============================= HAND SORTIEREN ============================= */
const SUIT_ORDER = { '♠': 0, '♥': 1, '♣': 2, '♦': 3 }; // abwechselnd schwarz/rot
function compareCards(mode) {
  const rank = c => (c.isJoker ? 99 : R.RANK_INDEX[c.value]);
  const suit = c => (c.isJoker ? 9 : SUIT_ORDER[c.suit]);
  return mode === 'rank'
    ? (a, b) => rank(a) - rank(b) || suit(a) - suit(b) || a.id.toString().localeCompare(b.id.toString())
    : (a, b) => suit(a) - suit(b) || rank(a) - rank(b) || a.id.toString().localeCompare(b.id.toString());
}
let handSort = 'suit'; // 'suit' | 'rank' | 'none' (wie gezogen)
try { handSort = localStorage.getItem('peseqind_sort') || 'suit'; } catch (e) { /* egal */ }
function sortedHand(hand) { return handSort === 'none' ? hand : hand.slice().sort(compareCards(handSort)); }
function updateSortLabel() {
  const b = document.getElementById('btnSort');
  if (b) b.textContent = handSort === 'suit' ? '↕ Farbe' : handSort === 'rank' ? '↕ Rang' : '↕ frei';
}
document.getElementById('btnSort').addEventListener('click', () => {
  handSort = handSort === 'suit' ? 'rank' : handSort === 'rank' ? 'none' : 'suit';
  try { localStorage.setItem('peseqind_sort', handSort); } catch (e) { /* egal */ }
  updateSortLabel();
  if (view) render();
});
updateSortLabel();

function buildMeldBlock(meld, sel, isMine, canAct, o = {}) {
  const st = !!o.static;
  const me = view.myIndex, opp = me === 0 ? 1 : 0;
  const block = document.createElement('div');
  block.className = 'meld-block';
  const locked = !!meld.locked || R.meldIsLocked(meld); // fixiert bleibt fixiert (Server merkt es sich)
  if (locked && isMine && !st) block.appendChild(makeStem());

  const g = document.createElement('div');
  g.className = 'meld ' + (locked ? 'linked' : 'unlocked');
  const jokerMap = jokerDisplayMap(meld.cards.map(mc => mc.card), meld.runStart);
  orderedEntries(meld).forEach(mc => {
    const foreign = mc.addedBy !== meld.ownerId;
    const el = buildCardEl(mc.card, {
      table: true, ghost: foreign, displayAs: jokerMap[mc.card.id],
      enter: !st && enterFlag(foreign ? 'ghost' : 'meld', mc.card.id)
    });
    if (foreign) {
      const mark = document.createElement('div');
      mark.className = 'added-mark';
      mark.textContent = view.spectator ? (mc.addedBy === me ? view.myName : view.oppName).slice(0, 3) : (mc.addedBy === me ? 'Du' : 'Geg.');
      el.appendChild(mark);
      el.title = `Angelegt von ${mc.addedBy === me ? meDat() : view.oppName} – diese Karte liegt auf dessen Seite`;
    }
    g.appendChild(el);
  });
  block.appendChild(g);

  const total = R.pointsForMeld(meld);
  const split = R.meldPointSplit(meld);
  const cap = document.createElement('div');
  if (locked) {
    cap.className = 'meld-cap locked-cap';
    cap.textContent = `#${meld.no} · ${total} P · ${meName()} ${split[me]} / ${escapeHtmlText(view.oppName)} ${split[opp]} · fixiert${jokerScoreNote(meld.cards.map(mc => mc.card), meld.runStart)}`;
  } else {
    cap.className = 'meld-cap';
    cap.textContent = `#${meld.no} · ${total} Punkte${isMine && !st && !view.spectator ? ' · umbaubar' : ''}${jokerScoreNote(meld.cards.map(mc => mc.card), meld.runStart)}`;
  }
  block.appendChild(cap);
  if (st) return block;

  const actions = document.createElement('div');
  actions.className = 'meld-actions';

  if (sel.length === 1 && canAct) {
    const card = sel[0];
    const combined = [...meld.cards.map(mc => mc.card), card];
    const meldCardsNow = meld.cards.map(mc => mc.card);
    const curInfo = R.classifyGroup(meldCardsNow, meld.runStart);
    // Strasse: nur unten/oben anschliessen (Joker behalten ihre Rolle). Sets: wie bisher.
    const attachStart = curInfo && curInfo.type === 'run' ? R.runAttachStart(meldCardsNow, meld.runStart, card, isOpenClient()) : undefined;
    const canAttach = curInfo && curInfo.type === 'run'
      ? attachStart !== null
      : (R.attachCheck(meldCardsNow, meld.runStart, card, isOpenClient()).ok && jokerConflicts(combined).length === 0);
    if (canAttach) {
      const pts = R.pointsForCards(combined, attachStart === undefined ? undefined : attachStart, isOpenClient()) - total;
      const b = document.createElement('button');
      b.textContent = `Anlegen (+${pts})`;
      b.onclick = () => attachSelectedToMeld(meld.id);
      actions.appendChild(b);
    } else {
      const info = R.classifyGroup(meld.cards.map(mc => mc.card), meld.runStart);
      let swappable = false;
      if (info && !card.isJoker) {
        if (info.type === 'set') {
          const usedSuits = meld.cards.filter(mc => !mc.card.isJoker).map(mc => mc.card.suit);
          const hasJoker = meld.cards.some(mc => mc.card.isJoker);
          if (hasJoker && card.value === info.rank && !usedSuits.includes(card.suit)) {
            swappable = !(meld.cards.length === 3 && !view.seenCards.includes(R.cardKey(card)));
          }
        } else if (info.type === 'run') {
          // Die Lage ist beim Auslegen festgeschrieben: nur genau die Karte, die der Joker darstellt.
          swappable = info.suit === card.suit &&
            info.slots.some(s => R.isJokerSlot(s) && R.rankAt(s.rankIdx) === card.value);
        }
      }
      if (swappable) {
        const b = document.createElement('button');
        b.className = 'swap';
        b.textContent = `Joker ↔ ${card.value}${card.suit}`;
        b.onclick = () => swapSelectedForJoker(meld.id);
        actions.appendChild(b);
      }
    }
  }

  if (isMine && !view.spectator && meld.ownerId === me && !locked) {
    const b = document.createElement('button'); b.className = 'mini-ghost';
    b.textContent = 'Umbauen'; b.onclick = () => dissolveMeld(meld.id);
    actions.appendChild(b);
  }
  if (actions.children.length) block.appendChild(actions);
  if (locked && !isMine) block.appendChild(makeStem());
  return block;
}
function escapeHtmlText(s) { return s == null ? '' : String(s); } // textContent escaped schon selbst

/* Karten, die `sideIdx` an eine FREMDE Gruppe angelegt hat – liegen auf seiner eigenen Seite. */
function buildAttachBlock(meld, sideIdx, o = {}) {
  const st = !!o.static;
  const me = view.myIndex;
  const block = document.createElement('div');
  block.className = 'meld-block attach-block';
  const head = document.createElement('div');
  head.className = 'attach-head';
  head.textContent = `↗ an Gruppe ${meld.no} (${meldDesc(meld)}) von ${meld.ownerId === me ? meDat() : view.oppName}`;
  block.appendChild(head);

  const g = document.createElement('div');
  g.className = 'meld attach';
  const jokerMap = jokerDisplayMap(meld.cards.map(mc => mc.card), meld.runStart);
  orderedEntries(meld).filter(mc => mc.addedBy === sideIdx).forEach(mc => {
    const el = buildCardEl(mc.card, {
      table: true, displayAs: jokerMap[mc.card.id],
      enter: !st && enterFlag('attach', mc.card.id)
    });
    g.appendChild(el);
  });
  block.appendChild(g);

  const pts = R.meldPointSplit(meld)[sideIdx];
  const cap = document.createElement('div');
  cap.className = 'meld-cap';
  cap.textContent = `+${pts} P für ${sideIdx === me ? meAkk() : view.oppName}`;
  block.appendChild(cap);
  return block;
}

function renderSide(container, sideIdx, sel, isMine, canAct, o = {}) {
  const st = !!o.static;
  container.innerHTML = '';
  const owned = view.tableMelds.filter(m => m.ownerId === sideIdx);
  const attached = view.tableMelds.filter(m => m.ownerId !== sideIdx && m.cards.some(mc => mc.addedBy === sideIdx));
  if (isMine && !st && sel.length >= 2) {
    const previewBlock = document.createElement('div');
    previewBlock.className = 'meld-block';
    const pg = document.createElement('div');
    pg.className = 'meld preview';
    const ptag = document.createElement('div');
    ptag.className = 'meld-owner-tag';
    ptag.textContent = 'Auswahl';
    pg.appendChild(ptag);
    const previewStart = R.pickRunStart(sel, isOpenClient());
    const previewJokerMap = jokerDisplayMap(sel); // Vorschau: Lage noch nicht festgeschrieben -> "?"
    // Strassen nach Rang sortiert zeigen (nicht in Handreihenfolge) – wie auf dem Tisch.
    const pinfo = R.classifyGroup(sel, previewStart);
    const previewOrder = pinfo && pinfo.type === 'run' ? pinfo.slots.map(sl => sl.card)
      : pinfo && pinfo.type === 'set' ? sel.slice().sort(compareCards('suit')) : sel;
    previewOrder.forEach(c => pg.appendChild(buildCardEl(c, { table: true, displayAs: previewJokerMap[c.id] })));
    previewBlock.appendChild(pg);
    const pts = R.pointsForCards(sel, previewStart);
    const conflicts = sel.length >= 3 && pts !== null ? jokerConflicts(sel) : [];
    const capt = document.createElement('div');
    capt.className = 'meld-cap' + (conflicts.length ? ' locked-cap' : '');
    capt.textContent = sel.length < 3 ? 'noch nicht genug Karten'
                      : pts === null ? 'ungültige Kombination'
                      : conflicts.length ? `blockiert: ${conflicts.map(c => c.value + c.suit).join(', ')} liegt schon offen (Rest/Ablage)`
                      : `wäre +${pts} Punkte${jokerScoreNote(sel, previewStart, true)}`;
    previewBlock.appendChild(capt);
    container.appendChild(previewBlock);
  }
  if (owned.length === 0 && attached.length === 0 && container.children.length === 0) {
    const e = document.createElement('div');
    e.className = 'melds-empty';
    e.textContent = st ? 'nichts ausgelegt'
                  : isMine ? (view.spectator ? `${view.myName} hat noch nichts ausgelegt.` : 'Deine Sets erscheinen hier.') : `${view.oppName} hat noch nichts ausgelegt.`;
    container.appendChild(e);
    return;
  }
  owned.forEach(m => container.appendChild(buildMeldBlock(m, sel, isMine, canAct, o)));
  attached.forEach(m => container.appendChild(buildAttachBlock(m, sideIdx, o)));
}

/* ---------- Verlauf ---------- */
const TABLE_KINDS = new Set(['lay', 'attach', 'swap', 'dissolve', 'undo']);
function fmtLogText(text) {
  const safe = escapeHtml(text);
  return safe.replace(/«([^»]*)»/g, (_, inner) => {
    if (!showTrack) return '<span class="lc hid">Karte</span>';
    const suits = inner.match(/[♥♦♣♠]/g);
    const cls = suits ? suitColor(suits[suits.length - 1]) : '';
    return `<span class="lc ${cls}">${inner}</span>`;
  });
}
function renderLog() {
  const box = document.getElementById('logLines');
  const scroller = document.getElementById('dropLog');
  const prevTop = scroller.scrollTop;
  document.querySelectorAll('#logTools [data-f]').forEach(b => b.classList.toggle('active', b.dataset.f === logFilter));
  const me = view.myIndex;
  const items = view.log.filter(e => logFilter === 'all' || TABLE_KINDS.has(e.k));
  if (!items.length) {
    box.innerHTML = '<div class="log-line" style="opacity:.5;font-style:italic">' +
      (logFilter === 'all' ? 'Noch nichts passiert.' : 'Noch nichts ausgelegt, angelegt oder getauscht.') + '</div>';
  } else {
    let html = '';
    let lastRound = null;
    items.forEach(e => {
      if (e.r !== lastRound) { html += `<div class="log-round">Runde ${e.r}</div>`; lastRound = e.r; }
      const who = e.p === null ? '' : `<b class="who ${e.p === me ? 'me' : 'opp'}">${e.p === me ? escapeHtml(meName()) : escapeHtml(view.oppName)}</b> `;
      html += `<div class="log-line k-${e.k}">${who}${fmtLogText(e.t)}</div>`;
    });
    box.innerHTML = html;
  }
  scroller.scrollTop = prevTop;
}

function renderHistory() {
  let rows = '';
  view.roundHistory.forEach(r => {
    rows += `<tr><td>Rd. ${r.round}</td><td>${r.total[view.myIndex] >= 0 ? '+' : ''}${r.total[view.myIndex]}</td><td>${r.total[view.myIndex === 0 ? 1 : 0] >= 0 ? '+' : ''}${r.total[view.myIndex === 0 ? 1 : 0]}</td></tr>`;
  });
  if (view.roundHistory.length === 0) {
    rows = `<tr><td colspan="3" style="opacity:.6; font-style:italic;">Noch keine Runde beendet.</td></tr>`;
  } else {
    rows += `<tr><td>Gesamt</td><td>${view.scores[view.myIndex]}</td><td>${view.scores[view.myIndex === 0 ? 1 : 0]}</td></tr>`;
  }
  document.getElementById('historyTable').innerHTML = `<tr><th>Runde</th><th>${escapeHtml(meName())}</th><th>${escapeHtml(view.oppName)}</th></tr>${rows}`;
  const sum = settingsSummary(view.settings);
  document.getElementById('dropHistoryTitle').textContent = `Punkteverlauf · Runde ${view.round} · Ziel 500${sum ? ' · ' + sum : ''}`;
  renderTableNow();
}

/* Aufschluesselung der Tischpunkte pro Gruppe – damit nachvollziehbar ist, woher z. B. "45" kommt. */
function renderTableNow() {
  const el = document.getElementById('tableNow');
  const me = view.myIndex, opp = me === 0 ? 1 : 0;
  if (!view.tableMelds.length) {
    el.innerHTML = '<h4 style="margin-top:10px">Tisch jetzt</h4><div class="log-line" style="opacity:.55;font-style:italic">Noch nichts ausgelegt.</div>';
    return;
  }
  const sum = [0, 0];
  let rows = '';
  view.tableMelds.forEach(m => {
    const sp = R.meldPointSplit(m);
    sum[0] += sp[0]; sum[1] += sp[1];
    rows += `<tr><td>#${m.no} ${escapeHtml(meldDesc(m))}</td><td>${sp[me]}</td><td>${sp[opp]}</td></tr>`;
  });
  rows += `<tr><td>Tisch gesamt</td><td>${sum[me]}</td><td>${sum[opp]}</td></tr>`;
  el.innerHTML = `<h4 style="margin-top:10px">Tisch jetzt</h4><table class="history-table"><tr><th>Gruppe</th><th>${escapeHtml(meName())}</th><th>${escapeHtml(view.oppName)}</th></tr>${rows}</table>`;
}

/* ---------- Rundenende: Zahlen + Bild aller Karten ---------- */
function renderRoundOverlay() {
  const overlay = document.getElementById('roundOverlay');
  if (!view.roundOver) { overlay.classList.remove('visible'); return; }
  const prevTop = overlay.scrollTop;
  const last = view.roundHistory[view.roundHistory.length - 1];
  const me = view.myIndex, opp = me === 0 ? 1 : 0;
  const sign = n => (n >= 0 ? '+' + n : '−' + Math.abs(n));
  const col = idx => `
    <div class="bd-col">
      <div class="p">${idx === me ? escapeHtml(meName()) : escapeHtml(view.oppName)}</div>
      Tisch: +${last.plus[idx]}<br>
      Hand: −${last.minus[idx]}<br>
      Runde: <strong>${sign(last.total[idx])}</strong><br>
      Gesamt: <strong style="color:var(--gold)">${view.scores[idx]}</strong>
    </div>`;
  document.getElementById('roundBreakdown').innerHTML = col(me) + col(opp);

  // Das "Bild": beide Seiten wie am Tisch (Gegner oben, du unten) mit allen Gruppen/Anbauten
  // und den uebrig gebliebenen Handkarten samt Minuspunkten.
  const board = document.getElementById('roundBoard');
  board.innerHTML = '';
  [opp, me].forEach(idx => {
    const sec = document.createElement('div');
    sec.className = 'rb-side ' + (idx === me ? 'me' : 'opp');
    const head = document.createElement('div');
    head.className = 'rb-head';
    head.innerHTML = `<b>${idx === me ? escapeHtml(meName()) : escapeHtml(view.oppName)}</b>` +
      `<span>Tisch +${last.plus[idx]}</span><span>Hand −${last.minus[idx]}</span><span class="rb-tot">= ${sign(last.total[idx])}</span>`;
    sec.appendChild(head);
    const melds = document.createElement('div');
    melds.className = 'melds rb-melds';
    renderSide(melds, idx, [], idx === me, false, { static: true });
    sec.appendChild(melds);
    const handBox = document.createElement('div');
    handBox.className = 'rb-hand';
    const hand = idx === me ? view.myHand : (view.oppHand || []);
    const lbl = document.createElement('div');
    lbl.className = 'rb-hand-label';
    lbl.textContent = hand.length ? `Übrige Handkarten (−${last.minus[idx]} P)` : 'Keine Handkarten übrig';
    handBox.appendChild(lbl);
    const row = document.createElement('div');
    row.className = 'rb-hand-row';
    hand.forEach(c => {
      const wrap = document.createElement('div');
      wrap.className = 'hc';
      wrap.appendChild(buildCardEl(c, { table: true }));
      const pt = document.createElement('span');
      pt.className = 'pt';
      pt.textContent = '−' + (c.isJoker ? 50 : R.pointsForRank(c.value));
      wrap.appendChild(pt);
      row.appendChild(wrap);
    });
    handBox.appendChild(row);
    sec.appendChild(handBox);
    board.appendChild(sec);
  });

  const winner = view.pendingWinner;
  const resigned = view.resigned;
  const timedOut = view.timedOut;
  const who = i => (i === me ? (view.spectator ? view.myName : 'Du') : view.oppName);
  document.getElementById('roundTitle').textContent =
    timedOut !== null && timedOut !== undefined ? `Zeit abgelaufen – ${who(timedOut)} ${timedOut === me && !view.spectator ? 'hast' : 'hat'} verloren`
    : resigned !== null && resigned !== undefined ? (resigned === me && !view.spectator ? 'Du hast aufgegeben' : `${resigned === me ? view.myName : view.oppName} hat aufgegeben`)
    : 'Runde beendet';
  document.getElementById('roundContinueBtn').textContent =
    winner !== null ? `${winner === me && !view.spectator ? 'Du gewinnst' : (winner === me ? view.myName : view.oppName) + ' gewinnt'}${(resigned === null || resigned === undefined) && (timedOut === null || timedOut === undefined) ? ` mit ${view.scores[winner]} Punkten` : ''} – Neues Spiel` : 'Nächste Runde';
  document.getElementById('roundContinueBtn').style.display = view.spectator ? 'none' : '';
  overlay.classList.add('visible');
  overlay.scrollTop = prevTop;
}

function renderWaitOverlay() {
  const overlay = document.getElementById('waitOverlay');
  // Blockierend nur, solange der zweite Spieler noch nie da war. Faellt ein Spieler spaeter
  // kurz aus, bleibt das Spielfeld sichtbar – dann zeigt nur die Leiste oben den Status an.
  if (!view.opponentConnected && !everSawOpponent) {
    document.getElementById('waitText').textContent = 'Warte auf Mitspieler …';
    document.getElementById('waitSub').textContent = view.spectator
      ? 'Das Spiel hat noch nicht begonnen – du siehst es, sobald beide Spieler da sind.'
      : 'Teile den Link oben, damit dein Freund beitreten kann.' + (settingsSummary(view.settings) ? ' Einstellungen: ' + settingsSummary(view.settings) + ' (Vorgabe: du / Gegner). Die Uhr startet, sobald er da ist.' : '');
    overlay.classList.add('visible');
  } else {
    overlay.classList.remove('visible');
  }
}

function render() {
  if (!view) return;
  noteRoundForSeen(view.round);
  const plus = tablePoints();
  renderScoreRows(plus);
  setHandBadge('meHandBadge', view.myHandCount !== undefined ? view.myHandCount : view.myHand.length);
  document.querySelector('.seat-tag.me').textContent = meName();
  const sc = document.getElementById('specCount');
  sc.textContent = view.spectator ? '' : (view.spectatorCount ? `👁 ${view.spectatorCount}` : '');
  sc.title = view.spectatorCount ? `${view.spectatorCount} Zuschauer` : '';
  setHandBadge('oppHandBadge', view.oppHandCount);
  document.querySelector('.seat-tag.opp').textContent = view.oppName;

  const rs = document.getElementById('reserveSlot');
  rs.innerHTML = '';
  rs.appendChild(buildCardEl(view.reserveCard, { table: true, enter: enterFlag('reserve', view.reserveCard.id) }));
  document.getElementById('drawCount').textContent = view.drawCount;
  document.getElementById('discardCount').textContent = view.discardPile.length;
  renderDiscardFan();

  if (handHidden) selected = new Set();
  const sel = selectedCards();
  const canAct = view.isMyTurn && !(view.needsDraw && !view.skipDrawThisTurn);
  const me = view.myIndex, opp = me === 0 ? 1 : 0;

  const oppMeldCount = view.tableMelds.filter(m => m.ownerId === opp).length;
  document.getElementById('oppNote').textContent =
    oppMeldCount ? `${oppMeldCount} Gruppe${oppMeldCount === 1 ? '' : 'n'} ausgelegt` : '';

  renderSide(document.getElementById('oppMelds'), opp, sel, false, canAct);
  renderSide(document.getElementById('myMelds'), me, sel, true, canAct);

  const hand = sortedHand(view.myHand);
  const hz = document.getElementById('handZone');
  hz.innerHTML = '';
  const hn = hand.length;
  // Kartenueberlappung: bevorzugt so eng, dass die ganze Hand in EINER Reihe bleibt (wichtig bei
  // grossen Karten auf schmalen Handys – sonst bricht sie um und schiebt die Bedienleiste aus dem Bild).
  let hstep = hn <= 6 ? .82 : hn <= 9 ? .72 : hn <= 13 ? .62 : .52;
  const cwPx = parseFloat(getComputedStyle(document.body).getPropertyValue('--cw')) || 52;
  const availPx = (hz.clientWidth || document.body.clientWidth) - 8;
  if (hn > 1 && availPx > cwPx) {
    const fit = (availPx - cwPx) / ((hn - 1) * cwPx);
    if (fit < hstep && fit >= .34) hstep = fit; // enger zusammenruecken statt umbrechen
  }
  hz.style.setProperty('--hstep', hstep);
  hand.forEach(c => {
    // Verdeckt-Modus (z. B. wenn man nebeneinander sitzt): nur die Rueckseiten zeigen.
    const el = buildCardEl(handHidden ? { ...c, faceDown: true } : c, { enter: enterFlag('hand', c.id) });
    if (!handHidden && selected.has(c.id)) el.classList.add('selected');
    if (view.frozenCardIds.includes(c.id)) el.classList.add('frozen');
    el.onclick = handHidden
      ? () => flashBanner('Deine Karten sind verdeckt – oben auf „🙈 verdeckt“ tippen, um sie aufzudecken.')
      : () => toggleSelect(c.id);
    hz.appendChild(el);
  });

  const singleFrozen = sel.length === 1 && view.frozenCardIds.includes(sel[0].id);
  const selValid = sel.length >= 3 && R.isValidGroup(sel) && jokerConflicts(sel).length === 0;
  document.getElementById('btnLaySelection').disabled = !selValid || !canAct;
  document.getElementById('btnClearSel').disabled = sel.length === 0;

  const isLastCard = hand.length === 1;
  document.getElementById('btnDiscardSelected').style.display = isLastCard ? 'none' : '';
  document.getElementById('btnDiscardSelected').disabled = sel.length !== 1 || singleFrozen || !canAct;
  document.getElementById('btnEndRoundFacedown').style.display = isLastCard ? '' : 'none';
  document.getElementById('btnEndRoundFacedown').disabled = !isLastCard || !canAct;

  const needsChoice = view.isMyTurn && view.needsDraw && !view.skipDrawThisTurn;
  document.getElementById('drawActionRow').style.display = needsChoice ? 'flex' : 'none';
  document.getElementById('btnDrawBig').disabled = !needsChoice || view.drawCount === 0;
  document.getElementById('btnPickupBig').disabled = !needsChoice || view.discardPile.length < 2;
  document.getElementById('selectionActionRow').style.display = needsChoice ? 'none' : 'flex';
  const undoN = view.isMyTurn && !view.roundOver ? (view.undoCount || 0) : 0;
  document.getElementById('undoRow').style.display = view.isMyTurn && !view.roundOver ? 'flex' : 'none';
  document.getElementById('btnUndo').disabled = undoN === 0;
  document.getElementById('btnUndoAll').disabled = undoN === 0;
  document.getElementById('btnUndo').textContent = undoN ? `↩ Zug zurück (${undoN})` : '↩ Zug zurück';

  const banner = document.getElementById('turnBanner');
  if (!banner.classList.contains('flash')) {
    let text;
    if (view.spectator) {
      const cur = view.currentPlayerIndex === 0 ? view.myName : view.oppName;
      text = view.roundOver ? '👁 Zuschauer – Runde beendet.' : `👁 Zuschauer – ${cur} ist am Zug.`;
    } else if (!view.isMyTurn) {
      text = `${view.oppName} ist am Zug …`;
    } else if (needsChoice) {
      text = 'Ziehe eine Karte oder nimm mind. 2 Karten vom Ablagestapel auf.';
    } else if (handHidden) {
      text = 'Deine Karten sind verdeckt – zum Spielen aufdecken (🙈 oben).';
    } else if (singleFrozen || (view.pickedUpThisTurn && view.frozenCardIds.length > 0)) {
      text = 'Rot umrandet = frisch aufgenommen: verbaubar, aber diesen Zug nicht abwerfbar.';
    } else if (sel.length === 1) {
      text = '1 Karte: anlegen, tauschen oder abwerfen.';
    } else if (sel.length >= 2) {
      text = `${sel.length} Karten ausgewählt (ab 3 auslegbar).`;
    } else {
      text = 'Karten wählen, Sets auslegen/anlegen oder abwerfen.';
    }
    banner.textContent = text;
  }

  if (document.getElementById('discardPickerOverlay').classList.contains('visible')) renderDiscardPicker();
  renderLog();
  renderHistory();
  renderRoundOverlay();
  renderWaitOverlay();
  updateStrip();
}

/* ============================= BENACHRICHTIGUNGEN ("du bist dran") ============================= */
/* Stufe 1 – laeuft im Browser, solange die Seite offen ist (auch im Hintergrund-Tab):
 *   Ton, Vibration, Tab-Titel "● Du bist dran" und – mit Erlaubnis – eine System-Benachrichtigung.
 * Stufe 2 – Web-Push ueber Service Worker: kommt auch an, wenn die App geschlossen oder das Handy
 *   gesperrt ist. Der Server schickt den Push nur, wenn die App gerade NICHT sichtbar ist. */
let notifyMode = 'hidden'; // 'hidden' = nur im Hintergrund | 'always' | 'off'
try { notifyMode = localStorage.getItem('peseqind_notify') || 'hidden'; } catch (e) { /* egal */ }
const BASE_TITLE = document.title;
let audioCtx = null;

function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) { /* kein Audio – egal */ }
}
['pointerdown', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, unlockAudio, { passive: true }));

function beep() {
  try {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    [[880, 0], [1318, 0.15]].forEach(([freq, d]) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.25, t + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.22);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t + d); o.stop(t + d + 0.24);
    });
  } catch (e) { /* egal */ }
}
function vibrate() { try { if (navigator.vibrate) navigator.vibrate([140, 70, 140]); } catch (e) { /* egal */ } }
function setTitleAlert(on) { document.title = on ? '● Du bist dran – Pesëqind' : BASE_TITLE; }

function pushFlag() { return loadFlag('peseqind_push', false); }
function notifPermission() { return ('Notification' in window) ? Notification.permission : 'unsupported'; }

function showLocalNotification(title, body) {
  try {
    if (notifPermission() !== 'granted') return;
    const opts = { body, tag: 'peseqind-turn', renotify: true, icon: '/icon-192.png', badge: '/icon-192.png' };
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration().then(reg => {
        if (reg) reg.showNotification(title, opts); else new Notification(title, opts);
      }).catch(() => { try { new Notification(title, opts); } catch (e) { /* egal */ } });
    } else {
      new Notification(title, opts);
    }
  } catch (e) { /* egal */ }
}

function publicLastLogText() {
  const e = view && view.log && view.log[0];
  return e ? (e.p === null ? '' : (e.p === view.myIndex ? 'Du ' : view.oppName + ' ')) + String(e.t).replace(/[«»]/g, '') : '';
}

/* Wird nach jedem neuen Spielstand aufgerufen. `prev` ist die Sicht davor (null beim ersten Mal). */
function onViewChange(prev, cur) {
  if (!prev || cur.spectator || prev.spectator) return;
  const myTurnNow = cur.isMyTurn && !cur.roundOver && (!prev.isMyTurn || prev.roundOver || cur.round !== prev.round);
  const roundEnded = cur.roundOver && !prev.roundOver;
  if (!myTurnNow && !roundEnded) return;
  const hidden = document.hidden;
  if (hidden) setTitleAlert(true);
  if (notifyMode === 'off') return;
  if (hidden || notifyMode === 'always') { beep(); vibrate(); }
  // System-Benachrichtigung nur, wenn KEIN Web-Push aktiv ist (sonst kaeme sie doppelt vom Server).
  if (hidden && !pushFlag()) {
    showLocalNotification(myTurnNow ? 'Pesëqind – du bist dran' : 'Pesëqind – Runde beendet',
      myTurnNow ? (publicLastLogText() || 'Du bist am Zug.') : 'Die Runde ist vorbei – Ergebnis ansehen.');
  }
}

function reportVisibility() {
  if (view && view.spectator) return;
  send({ type: 'visibility', hidden: document.hidden });
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) setTitleAlert(false);
  reportVisibility();
});
window.addEventListener('focus', () => setTitleAlert(false));

/* ---------- Web-Push ---------- */
function b64ToUint8(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
function sameKey(buf, b64) {
  if (!buf) return false;
  const a = new Uint8Array(buf), b = b64ToUint8(b64);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }

async function subscribeToPush() {
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options && sub.options.applicationServerKey, serverVapidKey)) {
    await sub.unsubscribe(); sub = null; // Schluessel des Servers hat sich geaendert -> neu abonnieren
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(serverVapidKey) });
  send({ type: 'pushSubscribe', subscription: sub.toJSON() });
  return sub;
}

async function enablePush() {
  if (!view || view.spectator) { flashBanner('Push gibt es nur während du selbst mitspielst.'); return; }
  if (!pushSupported()) {
    flashBanner('Push geht hier nicht. iPhone: erst „Teilen → Zum Home-Bildschirm“, dann von dort öffnen.');
    return;
  }
  if (!serverVapidKey) { flashBanner('Der Server hat Push gerade nicht aktiv.'); return; }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { flashBanner('Benachrichtigungen sind im Browser blockiert – bitte in den Seiteneinstellungen erlauben.'); updateNotifyLabels(); return; }
  try {
    await subscribeToPush();
    saveFlag('peseqind_push', true);
    flashBanner('Push ist an – du wirst auch bei geschlossener App benachrichtigt.');
  } catch (e) {
    flashBanner('Push konnte nicht aktiviert werden: ' + (e && e.message ? e.message : e));
  }
  updateNotifyLabels();
}

async function disablePush() {
  saveFlag('peseqind_push', false);
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch (e) { /* egal */ }
  send({ type: 'pushUnsubscribe' });
  updateNotifyLabels();
}

/* Nach (Wieder-)Beitritt: Abo beim Server auffrischen (neuer Server, neuer Sitz, neuer Schluessel). */
async function refreshPushSubscription() {
  if (!pushFlag() || !pushSupported() || notifPermission() !== 'granted' || !serverVapidKey) return;
  if (view && view.spectator) return;
  try { await subscribeToPush(); } catch (e) { /* beim naechsten Beitritt erneut */ }
}

/* ---------- Menue-Schalter ---------- */
function updateNotifyLabels() {
  const modes = { hidden: '🔔 Ton & Vibration: nur im Hintergrund', always: '🔔 Ton & Vibration: immer', off: '🔕 Ton & Vibration: aus' };
  document.getElementById('btnToggleNotify').textContent = modes[notifyMode] || modes.hidden;
  const pb = document.getElementById('btnPush');
  pb.textContent = pushFlag() && notifPermission() === 'granted'
    ? '📲 Push bei geschlossener App: an' : '📲 Push bei geschlossener App: aus';
}
document.getElementById('btnToggleNotify').addEventListener('click', () => {
  notifyMode = notifyMode === 'hidden' ? 'always' : notifyMode === 'always' ? 'off' : 'hidden';
  try { localStorage.setItem('peseqind_notify', notifyMode); } catch (e) { /* egal */ }
  updateNotifyLabels();
  unlockAudio();
  if (notifyMode !== 'off') { beep(); vibrate(); } // Probe, damit man hoert/spuert, was kommt
});
document.getElementById('btnPush').addEventListener('click', () => {
  if (pushFlag() && notifPermission() === 'granted') disablePush(); else enablePush();
});
updateNotifyLabels();

if ('serviceWorker' in navigator) {
  // Service Worker immer anmelden: noetig fuer Push und fuer Antippen einer Benachrichtigung.
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
