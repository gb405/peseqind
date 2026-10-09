/*
 * Speicher-Schicht fuer Raeume (damit ein Server-Neustart laufende Spiele nicht killt).
 *
 * Drei Betriebsarten – automatisch nach Umgebungsvariablen gewaehlt:
 *   1) Redis ueber REST (z. B. Upstash, hat einen KOSTENLOSEN Tarif):
 *        UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN   (auch REDIS_REST_URL / REDIS_REST_TOKEN)
 *      -> uebersteht Neustarts UND neue Deploys auch auf Renders kostenlosem Tarif.
 *   2) Datei:   DATA_DIR=/pfad   (z. B. Render "Persistent Disk" gemountet auf /var/data, oder lokal ./data)
 *      -> uebersteht Neustarts, wenn der Ordner dauerhaft ist. Auf Renders kostenlosem Tarif ist die
 *         Festplatte NICHT dauerhaft – dort bringt nur Variante 1 etwas.
 *   3) Nichts gesetzt: reiner Arbeitsspeicher (wie bisher).
 *
 * Schnittstelle (alles Promise-basiert):
 *   store.kind                     'redis' | 'file' | 'none'
 *   store.loadAll()                -> { rooms: [serialisierte Raeume], meta: {key: value} }
 *   store.saveRoom(code, data)     speichert (oder ersetzt) einen Raum
 *   store.deleteRoom(code)
 *   store.setMeta(key, value) / store.getMeta(key)
 */
const fs = require('fs');
const path = require('path');

const KEY_ROOM = 'peseqind:room:';
const KEY_INDEX = 'peseqind:rooms';
const KEY_META = 'peseqind:meta:';

function createNoneStore() {
  return {
    kind: 'none',
    async loadAll() { return { rooms: [], meta: {} }; },
    async saveRoom() {}, async deleteRoom() {}, async setMeta() {}, async getMeta() { return null; }
  };
}

/* ---------- Datei: ein JSON-Dokument, atomar (tmp + rename) geschrieben ---------- */
function createFileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'peseqind-state.json');
  let db = { rooms: {}, meta: {} };
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); db.rooms = db.rooms || {}; db.meta = db.meta || {}; } catch (e) { /* neu */ }
  let writing = Promise.resolve();
  function flush() {
    const json = JSON.stringify(db);
    writing = writing.then(() => new Promise(resolve => {
      const tmp = file + '.tmp';
      fs.writeFile(tmp, json, err => {
        if (err) { console.error('[persist] Schreiben fehlgeschlagen:', err.message); return resolve(); }
        fs.rename(tmp, file, e2 => { if (e2) console.error('[persist] Umbenennen fehlgeschlagen:', e2.message); resolve(); });
      });
    }));
    return writing;
  }
  return {
    kind: 'file',
    async loadAll() { return { rooms: Object.values(db.rooms), meta: { ...db.meta } }; },
    async saveRoom(code, data) { db.rooms[code] = data; return flush(); },
    async deleteRoom(code) { delete db.rooms[code]; return flush(); },
    async setMeta(k, v) { db.meta[k] = v; return flush(); },
    async getMeta(k) { return db.meta[k] === undefined ? null : db.meta[k]; }
  };
}

/* ---------- Redis ueber REST (Upstash-kompatibel): POST [BEFEHL, args ...] ---------- */
function createRedisRestStore(url, token, fetchImpl) {
  const f = fetchImpl || fetch;
  const base = url.replace(/\/+$/, '');
  async function cmd(...args) {
    const res = await f(base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    });
    if (!res.ok) throw new Error(`Redis-REST ${args[0]} -> HTTP ${res.status}`);
    const body = await res.json();
    if (body && body.error) throw new Error(`Redis-REST ${args[0]}: ${body.error}`);
    return body.result;
  }
  const TTL_SECONDS = 7 * 24 * 3600; // Sicherheitsnetz: vergessene Raeume verschwinden spaetestens nach 7 Tagen
  return {
    kind: 'redis',
    async loadAll() {
      const codes = (await cmd('SMEMBERS', KEY_INDEX)) || [];
      const rooms = [];
      if (codes.length) {
        const vals = (await cmd('MGET', ...codes.map(c => KEY_ROOM + c))) || [];
        vals.forEach((v, i) => {
          if (v) { try { rooms.push(JSON.parse(v)); } catch (e) { /* kaputter Eintrag */ } }
          else cmd('SREM', KEY_INDEX, codes[i]).catch(() => {}); // abgelaufen -> Index putzen
        });
      }
      return { rooms, meta: {} };
    },
    async saveRoom(code, data) {
      await cmd('SET', KEY_ROOM + code, JSON.stringify(data), 'EX', String(TTL_SECONDS));
      await cmd('SADD', KEY_INDEX, code);
    },
    async deleteRoom(code) {
      await cmd('DEL', KEY_ROOM + code);
      await cmd('SREM', KEY_INDEX, code);
    },
    async setMeta(k, v) { await cmd('SET', KEY_META + k, JSON.stringify(v)); },
    async getMeta(k) {
      const v = await cmd('GET', KEY_META + k);
      if (v === null || v === undefined) return null;
      try { return JSON.parse(v); } catch (e) { return null; }
    }
  };
}

function createStore(env = process.env, fetchImpl) {
  const url = env.UPSTASH_REDIS_REST_URL || env.REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.REDIS_REST_TOKEN;
  if (url && token) return createRedisRestStore(url, token, fetchImpl);
  if (env.DATA_DIR) return createFileStore(env.DATA_DIR);
  return createNoneStore();
}

/* ---------- (De-)Serialisierung des Spielstands: Set <-> Array ---------- */
const SET_FIELDS = ['frozenCardIds', 'preHandIds', 'seenCards'];

function serializeState(state) {
  const out = {};
  for (const [k, v] of Object.entries(state)) {
    if (k === 'undoStack') continue; // Zug-zurueck gilt nur im laufenden Zug und nur im Speicher
    out[k] = SET_FIELDS.includes(k) ? [...v] : v;
  }
  return out;
}

function deserializeState(data) {
  const state = { ...data };
  SET_FIELDS.forEach(k => { state[k] = new Set(Array.isArray(data[k]) ? data[k] : []); });
  state.undoStack = [];
  return state;
}

module.exports = { createStore, createRedisRestStore, createFileStore, createNoneStore, serializeState, deserializeState };
