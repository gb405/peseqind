/*
 * CPU-Gegner fuer Pesëqind.
 *
 * Der Bot sieht nur, was ein Mensch an seinem Platz auch sieht: die eigene Hand, den Tisch,
 * Ablage, Rest und die Liste schon gesehener Karten. Er kennt weder die Hand des Gegners noch
 * den Nachziehstapel. Jede Entscheidung liefert genau EINE Aktion; der Server fuehrt sie mit
 * denselben Regeln und Pruefungen aus wie bei einem Menschen und fragt danach erneut.
 *
 * Stufen:
 *   leicht – legt nur Saetze/Strassen ohne Joker, nimmt nie auf, wirft eher zufaellig ab
 *   normal – sucht die beste Kombination (mit Joker), legt an, tauscht Joker, nimmt auf, wenn es lohnt
 *   schwer – wie normal, nimmt mutiger auf und wirft so ab, dass der Gegner moeglichst wenig anlegen kann
 */
const R = require('./shared/rules.js');

const LEVELS = {
  leicht: { name: 'Leicht', jokersInMelds: false, attachForeign: false, swap: false, pickupMin: Infinity, maxPickup: 0, jokerCost: 0, danger: 0, noise: 30 },
  normal: { name: 'Normal', jokersInMelds: true, attachForeign: true, swap: true, pickupMin: 18, maxPickup: 8, jokerCost: 12, danger: 5, noise: 3 },
  schwer: { name: 'Schwer', jokersInMelds: true, attachForeign: true, swap: true, pickupMin: 10, maxPickup: 12, jokerCost: 10, danger: 12, noise: 0 }
};
function level(key) { return LEVELS[key] || LEVELS.normal; }

const minusOf = c => (c.isJoker ? 50 : R.pointsForRank(c.value));

/* ---------- Kontext: alles Oeffentliche, das die Regeln brauchen ---------- */
function makeCtx(s) {
  const tableList = s.tableMelds.map(m => ({ cards: m.cards.map(mc => mc.card), runStart: m.runStart }));
  const tableKeys = new Set();
  tableList.forEach(m => m.cards.forEach(c => { if (!c.isJoker) tableKeys.add(c.value + '_' + c.suit); }));
  const ctx = {
    s, tableList, tableKeys,
    reserve: s.reserveCard, discard: s.discardPile,
    isOpen: R.makeIsOpen(s.reserveCard, s.discardPile),
    late: s.drawPile.length <= 8
  };
  ctx.baseProblems = R.tableJokerProblems(tableList, ctx.reserve, ctx.discard).length;
  return ctx;
}

/* Darf diese Gruppe so neu ausgelegt werden? Liefert { cards, runStart, type, points } oder null. */
function checkNew(cards, ctx) {
  const info = R.classifyGroup(cards, undefined, ctx.isOpen);
  if (!info) return null;
  if (R.jokerVisibilityConflicts(cards, ctx.reserve, ctx.discard).length) return null;
  let runStart = null;
  if (info.type === 'run') {
    const ch = R.runChoices(cards, ctx.isOpen, ctx.tableKeys);
    if (!ch.length) return null;
    runStart = ch[0].startIdx;
  }
  const probs = R.tableJokerProblems(ctx.tableList.concat([{ cards, runStart }]), ctx.reserve, ctx.discard);
  if (probs.length > ctx.baseProblems) return null;
  return { cards, runStart, type: info.type, points: R.pointsForCards(cards, runStart) };
}

function jokerSlotsUsed(m) {
  if (m.type !== 'run') return m.cards.filter(c => c.isJoker).length;
  const info = R.classifyGroup(m.cards, m.runStart);
  return info ? info.slots.filter(R.isJokerSlot).length : 0;
}

/* Wert einer Gruppe fuer den Bot: Punkte + Entlastung der Hand (Minuspunkte am Rundenende)
 * minus "Joker-Kosten" (ein Joker ist auf der Hand fuer spaetere, bessere Gruppen wertvoll). */
function meldValue(m, lv, ctx) {
  const relief = m.cards.reduce((a, c) => a + minusOf(c), 0) * 0.3;
  const jc = ctx.late ? 0 : lv.jokerCost;
  return m.points + relief - jc * jokerSlotsUsed(m);
}

/* ---------- Alle moeglichen neuen Gruppen aus einer Hand ---------- */
function combos(arr, k) {
  const out = [];
  (function rec(start, acc) {
    if (acc.length === k) { out.push(acc.slice()); return; }
    for (let i = start; i < arr.length; i++) { acc.push(arr[i]); rec(i + 1, acc); acc.pop(); }
  })(0, []);
  return out;
}

function meldCandidates(hand, ctx, lv) {
  const reals = hand.filter(c => !c.isJoker);
  const jokers = hand.filter(c => c.isJoker);
  const useJ = lv.jokersInMelds ? jokers.length : 0;
  const out = [];
  const seen = new Set();
  const add = cards => {
    const key = cards.map(c => c.id).sort().join(',');
    if (seen.has(key)) return;
    seen.add(key);
    const m = checkNew(cards, ctx);
    if (m) out.push(m);
  };

  // Saetze
  const byRank = {};
  reals.forEach(c => (byRank[c.value] = byRank[c.value] || []).push(c));
  Object.values(byRank).forEach(rs => {
    for (let m = 1; m <= Math.min(4, rs.length); m++) {
      for (let j = 0; j <= useJ; j++) {
        const size = m + j;
        if (size < 3 || size > 4) continue;
        if (j > 0 && m < 2 && !['A', 'K', 'Q', 'J', '10'].includes(rs[0].value)) continue; // 1 echte + 2 Joker nur bei hohen Karten
        combos(rs, m).forEach(sub => add(sub.concat(jokers.slice(0, j))));
      }
    }
  });

  // Reine Jokergruppe
  if (useJ >= 3) { add(jokers.slice(0, 3)); if (useJ >= 4) add(jokers.slice(0, 4)); }

  // Strassen (inkl. Ass-2-3-4 mit echter 2)
  R.SUITS.forEach(suit => {
    const sr = reals.filter(c => c.suit === suit);
    if (sr.length < 2) return;
    const at = {};
    sr.forEach(c => {
      if (c.value === 'A') { at[R.MAX_IDX] = c; at[-2] = c; } else at[R.RANK_INDEX[c.value]] = c;
    });
    const nat2 = jokers.find(c => c.suit === suit);
    for (let start = R.MIN_IDX; start <= R.MAX_IDX - 3; start++) {
      for (let end = start + 3; end <= R.MAX_IDX; end++) {
        if (start === -2 && end === R.MAX_IDX) continue; // Ass doppelt
        const cards = [];
        let need = 0, realCount = 0, natUsed = false;
        for (let r = start; r <= end; r++) {
          if (r === -1 && nat2) { cards.push(nat2); natUsed = true; realCount++; }
          else if (at[r]) { cards.push(at[r]); realCount++; }
          else need++;
        }
        if (realCount < 2) continue;
        const pool = jokers.filter(c => !(natUsed && c.id === nat2.id));
        const avail = lv.jokersInMelds ? pool.length : 0;
        if (need > avail) continue;
        add(cards.concat(pool.slice(0, need)));
      }
    }
  });
  return out;
}

/* Beste Kombination sich nicht ueberschneidender Gruppen. Es bleibt immer mindestens
 * `keep` Karte(n) auf der Hand (zum Abwerfen bzw. verdeckt Ablegen). */
function bestPlan(hand, ctx, lv, keep = 1) {
  const cands = meldCandidates(hand, ctx, lv)
    .map(m => ({ ...m, value: meldValue(m, lv, ctx), ids: new Set(m.cards.map(c => c.id)) }))
    .filter(m => m.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 60);
  const maxCards = hand.length - keep;
  let best = { value: 0, plan: [] };
  let nodes = 0;
  const suffix = [];
  for (let i = cands.length - 1, acc = 0; i >= 0; i--) { acc += cands[i].value; suffix[i] = acc; }
  (function dfs(i, used, count, value, plan) {
    if (++nodes > 20000) return;
    if (value > best.value) best = { value, plan: plan.slice() };
    if (i >= cands.length || value + suffix[i] <= best.value) return;
    const c = cands[i];
    let clash = count + c.cards.length > maxCards;
    if (!clash) for (const id of c.ids) if (used.has(id)) { clash = true; break; }
    if (!clash) {
      c.ids.forEach(id => used.add(id));
      plan.push(c);
      dfs(i + 1, used, count + c.cards.length, value + c.value, plan);
      plan.pop();
      c.ids.forEach(id => used.delete(id));
    }
    dfs(i + 1, used, count, value, plan);
  })(0, new Set(), 0, 0, []);
  return best;
}

/* ---------- Anlegen / Tauschen ---------- */
function attachOptions(hand, pid, ctx, lv) {
  const out = [];
  const allowJokers = lv.jokersInMelds && (hand.length <= 3 || ctx.late);
  hand.forEach(card => {
    if (card.isJoker && !allowJokers) return;
    ctx.s.tableMelds.forEach(meld => {
      if (!lv.attachForeign && meld.ownerId !== pid) return;
      const cards = meld.cards.map(mc => mc.card);
      const chk = R.attachCheck(cards, meld.runStart, card, ctx.isOpen);
      if (!chk.ok) return;
      let runStart = null;
      const info = R.classifyGroup(cards, meld.runStart);
      if (info && info.type === 'run') {
        if (card.isJoker) {
          const ch = R.attachJokerChoices(cards, meld.runStart, ctx.isOpen, ctx.tableKeys, card);
          if (!ch.length) return;
          runStart = ch[0].startIdx;
        } else runStart = chk.start;
      }
      const combined = cards.concat([card]);
      const others = ctx.tableList.filter((_, i) => ctx.s.tableMelds[i].id !== meld.id);
      if (R.tableJokerProblems(others.concat([{ cards: combined, runStart }]), ctx.reserve, ctx.discard).length > ctx.baseProblems) return;
      if (R.jokerVisibilityConflicts(combined, ctx.reserve, ctx.discard).length) return;
      const gain = (R.pointsForCards(combined, runStart) || 0) - (R.pointsForCards(cards, meld.runStart) || 0);
      out.push({ card, meld, runStart, gain: gain + minusOf(card) * 0.3 - (card.isJoker && !ctx.late ? lv.jokerCost : 0) });
    });
  });
  return out.sort((a, b) => b.gain - a.gain);
}

function swapOption(hand, ctx) {
  for (const card of hand) {
    if (card.isJoker) continue;
    for (const meld of ctx.s.tableMelds) {
      const cards = meld.cards.map(mc => mc.card);
      const info = R.classifyGroup(cards, meld.runStart);
      if (!info) continue;
      if (info.type === 'run') {
        if (info.suit === card.suit && info.slots.some(sl => R.isJokerSlot(sl) && R.rankAt(sl.rankIdx) === card.value)) return { card, meld };
      } else if (info.type === 'set' && card.value === info.rank && cards.some(c => c.isJoker)) {
        if (cards.some(c => !c.isJoker && c.suit === card.suit)) continue;
        if (cards.length === 3 && !ctx.s.seenCards.has(R.cardKey(card))) continue;
        return { card, meld };
      }
    }
  }
  return null;
}

/* ---------- Abwerfen ---------- */
function rankPositions(c) { return c.value === 'A' ? [-2, R.MAX_IDX] : [R.RANK_INDEX[c.value]]; }

function keepScore(card, hand) {
  if (card.isJoker) return 1000;
  let k = 0;
  hand.forEach(o => {
    if (o === card || o.isJoker) return;
    if (o.value === card.value) k += 12;
    if (o.suit === card.suit) {
      let d = 99;
      rankPositions(card).forEach(a => rankPositions(o).forEach(b => { d = Math.min(d, Math.abs(a - b)); }));
      if (d === 1) k += 8; else if (d === 2) k += 4;
    }
  });
  return k - minusOf(card) * 0.35; // hohe Einzelkarten lieber loswerden
}

/* Wie sehr hilft die Karte dem Gegner (anlegbar an eine Gruppe auf dem Tisch)? */
function dangerScore(card, ctx) {
  if (card.isJoker) return 0;
  let d = 0;
  ctx.s.tableMelds.forEach(meld => {
    const cards = meld.cards.map(mc => mc.card);
    if (R.attachCheck(cards, meld.runStart, card, ctx.isOpen).ok) d += 1;
  });
  return d;
}

function chooseDiscard(hand, s, ctx, lv, rnd) {
  let pool = hand.filter(c => !s.frozenCardIds.has(c.id));
  if (!pool.length) pool = hand.slice();
  const nonJ = pool.filter(c => !c.isJoker);
  if (nonJ.length) pool = nonJ;
  let best = null;
  pool.forEach(c => {
    const score = keepScore(c, hand) + dangerScore(c, ctx) * lv.danger + rnd() * lv.noise;
    if (!best || score < best.score) best = { c, score };
  });
  return best.c;
}

/* ---------- Ziehen oder aufnehmen ---------- */
function drawDecision(s, pid, ctx, lv) {
  const hand = s.players[pid].hand;
  const pile = s.discardPile;
  let best = null;
  if (lv.maxPickup > 0 && pile.length >= 2) {
    const base = bestPlan(hand, ctx, lv).value;
    for (let i = Math.max(0, pile.length - lv.maxPickup); i <= pile.length - 2; i++) {
      const taken = pile.slice(i);
      // Ohne die aufgenommenen Karten im Ablagestapel sieht der Tisch anders aus
      const ctx2 = makeCtx({ ...s, discardPile: pile.slice(0, i) });
      const v = bestPlan(hand.concat(taken), ctx2, lv).value;
      const gain = v - base - taken.reduce((a, c) => a + minusOf(c), 0) * 0.15;
      if (gain >= lv.pickupMin && (!best || gain > best.gain)) best = { index: i, gain };
    }
  }
  if (best) return { action: 'pickup', payload: { index: best.index } };
  if (s.drawPile.length > 0) return { action: 'draw' };
  if (pile.length >= 2) return { action: 'pickup', payload: { index: pile.length - 2 } };
  return null;
}

/* ---------- Haupteinstieg: naechste Aktion ----------
 * memo.failed: Set mit Aktionen, die der Server in diesem Zug schon abgelehnt hat. */
function nextAction(s, pid, levelKey, memo, rnd = Math.random) {
  if (!s || s.roundOver || s.currentPlayerIndex !== pid) return null;
  const lv = level(levelKey);
  const hand = s.players[pid].hand;
  const ctx = makeCtx(s);
  const failed = memo.failed;
  const ok = a => !failed.has(JSON.stringify(a));

  if (s.needsDraw && !s.skipDrawThisTurn) {
    const d = drawDecision(s, pid, ctx, lv);
    if (d && ok(d)) return d;
    if (s.drawPile.length) return { action: 'draw' };
    return null;
  }

  if (hand.length >= 2 && lv.swap) {
    const sw = swapOption(hand, ctx);
    if (sw) {
      const a = { action: 'swap', payload: { cardId: sw.card.id, meldId: sw.meld.id } };
      if (ok(a)) return a;
    }
  }

  if (hand.length >= 4) {
    const plan = bestPlan(hand, ctx, lv).plan;
    for (const m of plan) {
      const a = { action: 'lay', payload: { cardIds: m.cards.map(c => c.id), runStart: m.runStart } };
      if (ok(a)) return a;
    }
  }

  if (hand.length >= 2) {
    for (const o of attachOptions(hand, pid, ctx, lv)) {
      if (o.gain <= 0) continue;
      const a = { action: 'attach', payload: { cardId: o.card.id, meldId: o.meld.id, runStart: o.runStart } };
      if (ok(a)) return a;
    }
  }

  if (hand.length === 1) return { action: 'endRoundFacedown' };
  const c = chooseDiscard(hand, s, ctx, lv, rnd);
  const a = { action: 'discard', payload: { cardId: c.id } };
  if (ok(a)) return a;
  // Notfall: irgendeine andere Karte
  const alt = hand.find(x => ok({ action: 'discard', payload: { cardId: x.id } }));
  return alt ? { action: 'discard', payload: { cardId: alt.id } } : null;
}

module.exports = { nextAction, LEVELS, level, bestPlan, makeCtx, meldCandidates };
