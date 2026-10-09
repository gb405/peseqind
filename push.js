/*
 * Web-Push ("du bist dran" auch bei geschlossener App).
 *
 * Der Server braucht ein VAPID-Schluesselpaar. Reihenfolge:
 *   1) Umgebungsvariablen VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (empfohlen auf Render)
 *   2) sonst im Speicher (persist.js, Meta-Eintrag "vapid") – wird beim ersten Start erzeugt
 *   3) sonst frisch erzeugt (gilt nur bis zum Neustart – Abos gehen dann verloren)
 * VAPID_SUBJECT (mailto:… oder https://…) ist die Kontaktangabe fuer die Push-Dienste.
 */
const webpush = require('web-push');

async function createPush({ store, env = process.env, log = console.log }) {
  let keys = null;
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  } else {
    try { keys = await store.getMeta('vapid'); } catch (e) { keys = null; }
    if (!keys || !keys.publicKey || !keys.privateKey) {
      keys = webpush.generateVAPIDKeys();
      try { await store.setMeta('vapid', keys); } catch (e) { /* ohne Speicher: nur bis zum Neustart */ }
      log(store.kind === 'none'
        ? '[push] VAPID-Schluessel erzeugt (nur im Speicher – nach Neustart muessen Abos erneuert werden; fuer Dauerbetrieb VAPID_* setzen oder Speicher aktivieren).'
        : '[push] VAPID-Schluessel erzeugt und gespeichert.');
    }
  }
  const subject = env.VAPID_SUBJECT || 'https://peshqin-online.onrender.com';
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);

  return {
    publicKey: keys.publicKey,
    /* Rueckgabe: 'ok' | 'gone' (Abo ungueltig/abgelaufen -> entfernen) | 'error' */
    async send(subscription, payload) {
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 3600, urgency: 'high' });
        return 'ok';
      } catch (e) {
        if (e && (e.statusCode === 404 || e.statusCode === 410)) return 'gone';
        log('[push] Senden fehlgeschlagen:', e && (e.statusCode || e.message));
        return 'error';
      }
    }
  };
}

/* Nimmt nur gut geformte Abos an (kein Fremdmaterial in den Speicher). */
function sanitizeSubscription(sub) {
  if (!sub || typeof sub !== 'object') return null;
  const endpoint = typeof sub.endpoint === 'string' ? sub.endpoint : '';
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000) return null;
  const k = sub.keys || {};
  if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string' || k.p256dh.length > 200 || k.auth.length > 100) return null;
  return { endpoint, keys: { p256dh: k.p256dh, auth: k.auth } };
}

module.exports = { createPush, sanitizeSubscription };
