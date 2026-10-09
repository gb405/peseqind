/*
 * Pesëqind/500 – geteilter Regelkern.
 * Laeuft unveraendert in Node (require) und im Browser (<script src="rules.js">).
 * Enthaelt NUR reine Funktionen ohne Netzwerk-/UI-Bezug, damit Server und
 * Client garantiert exakt dieselben Regeln anwenden.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod; // Node
  } else {
    root.PeshqinRules = mod; // Browser (globaler Namespace)
  }
})(typeof self !== 'undefined' ? self : this, function () {

  const SUITS = ['♥', '♦', '♣', '♠'];
  const REAL_RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const RANK_INDEX = {};
  REAL_RANKS.forEach((r, i) => (RANK_INDEX[r] = i));

  /* ===================== KARTENMODELL =====================
   * 1) Jede Karte gibt es genau EINMAL (ein Deck: 3..A in vier Farben + vier Zweien).
   * 2) Die Zweien sind Joker. Eine 2 ist nur dann eine ECHTE 2, wenn sie in einer Strasse ihrer
   *    eigenen Farbe auf dem Platz der 2 liegt (A-2-3-4 …). Sonst ist sie Joker.
   * 3) Jeder Joker auf dem Tisch steht fuer genau eine bestimmte Karte (Rang + Farbe). In einer
   *    Strasse steht sie mit dem Auslegen fest; in einem Satz ist nur die Farbe offen ("?").
   * 4) Keine Karte darf doppelt vorkommen: weder echt + Joker noch Joker + Joker noch offen
   *    (Rest/Ablage) + Joker. Das prueft tableJokerProblems fuer den GANZEN Tisch.
   * 5) Die Art einer Gruppe (Satz / Strasse / Jokergruppe) steht mit dem Auslegen fest.
   *
   * Strassen-Leiter (Index): A(tief)=-2, 2=-1, 3=0 … K=10, A(hoch)=11.
   * Ass tief und 2 zaehlen je 5 Punkte; Ass hoch 25. Keine Ueberlappung K-A-2.
   */
  const MIN_IDX = -2, MAX_IDX = REAL_RANKS.length - 1;
  function rankAt(idx) { return idx === -2 ? 'A' : idx === -1 ? '2' : REAL_RANKS[idx]; }
  function pointsAt(idx) { return idx < 0 ? 5 : pointsForRank(REAL_RANKS[idx]); }
  /* Platz in einer Strasse, den ein Joker haelt (eine echte 2 auf ihrem Platz ist KEIN Joker). */
  function isJokerSlot(sl) { return !!(sl && sl.card.isJoker && !sl.natural); }

  function pointsForRank(rank) {
    if (rank === 'A') return 25;
    if (['10', 'J', 'Q', 'K'].includes(rank)) return 10;
    return 5;
  }

  function cardKey(c) {
    return c.value + '_' + c.suit;
  }

  function buildDeck(newId) {
    const d = [];
    for (const s of SUITS) {
      for (const r of REAL_RANKS) d.push({ id: newId(), suit: s, value: r, isJoker: false });
      d.push({ id: newId(), suit: s, value: '2', isJoker: true });
    }
    return d;
  }

  function shuffle(arr, rng) {
    const rand = rng || Math.random;
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  /* Liefert ALLE gueltigen Zuordnungen einer Strasse (Joker-Platzierungen). Mehrere Treffer heissen:
   * ein Joker am Rand koennte oben ODER unten stehen – seine Identitaet ist noch offen. */
  function allRunAssignments(cards) {
    const out = [];
    if (cards.length < 4) return out;
    const twos = cards.filter(c => c.isJoker);
    const real = cards.filter(c => !c.isJoker);
    if (real.length === 0) return out;
    const suit = real[0].suit;
    if (!real.every(c => c.suit === suit)) return out;
    const span = cards.length;
    for (let start = MIN_IDX; start + span - 1 <= MAX_IDX; start++) {
      const end = start + span - 1;
      const byIdx = {};
      let ok = true;
      for (const c of real) {
        let ix = RANK_INDEX[c.value];
        if (c.value === 'A') ix = end >= MAX_IDX ? MAX_IDX : (start <= -2 ? -2 : null);
        if (ix === null || ix === undefined || ix < start || ix > end || byIdx[ix]) { ok = false; break; }
        byIdx[ix] = { card: c };
      }
      if (!ok) continue;
      const pool = twos.slice();
      // Echte 2: eine 2 der Strassenfarbe auf dem Platz der 2
      if (start <= -1 && end >= -1 && !byIdx[-1]) {
        const ni = pool.findIndex(c => c.suit === suit);
        if (ni >= 0) byIdx[-1] = { card: pool.splice(ni, 1)[0], natural: true };
      }
      const slots = [];
      for (let r = start; r <= end; r++) {
        if (byIdx[r]) slots.push({ rankIdx: r, card: byIdx[r].card, natural: !!byIdx[r].natural });
        else if (pool.length) slots.push({ rankIdx: r, card: pool.shift(), natural: false });
        else { ok = false; break; }
      }
      if (ok && pool.length === 0) out.push({ suit, startIdx: start, slots });
    }
    return out;
  }

  function assignmentPoints(a) {
    return a.slots.reduce((sum, sl) => sum + pointsAt(sl.rankIdx), 0);
  }

  /* Eine Strasse mit Joker am Rand ist mehrdeutig (z. B. 10-J-Q + Joker: 9 oder K?).
   * Regel: Es zaehlt die WERTVOLLSTE Zuordnung, die keine offen liegende Karte (Rest/Ablage)
   * darstellt (isOpen). Ist zum Legen/Anlegen schon eine Lage festgelegt (runStart),
   * bleibt sie bestehen, solange sie noch gueltig ist. */
  function computeRunAssignment(cards, runStart, isOpen) {
    const all = allRunAssignments(cards);
    if (!all.length) return null;
    if (runStart !== undefined && runStart !== null) {
      const fixed = all.find(a => a.startIdx === runStart);
      if (fixed) return fixed;
    }
    let pool = all;
    if (isOpen) {
      const free = all.filter(a => !a.slots.some(sl => isJokerSlot(sl) && isOpen(rankAt(sl.rankIdx), a.suit)));
      if (free.length) pool = free;
    }
    return pool.slice().sort((x, y) => assignmentPoints(y) - assignmentPoints(x) || y.startIdx - x.startIdx)[0];
  }

  /* Startlage, die beim Legen/Anlegen festgeschrieben wird (null bei Saetzen/Jokergruppen). */
  function pickRunStart(cards, isOpen) {
    const info = classifyGroup(cards, undefined, isOpen);
    return info && info.type === 'run' ? info.startIdx : null;
  }

  function makeIsOpen(reserveCard, discardPile) {
    const pile = discardPile || [];
    return (value, suit) => {
      if (reserveCard && !reserveCard.isJoker && reserveCard.value === value && reserveCard.suit === suit) return true;
      return pile.some(c => !c.isJoker && c.value === value && c.suit === suit);
    };
  }

  function classifyGroup(cards, runStart, isOpen) {
    if (cards.length < 3) return null;
    const jokers = cards.filter(c => c.isJoker);
    const real = cards.filter(c => !c.isJoker);
    if (real.length === 0) {
      if (cards.length === 3 || cards.length === 4) return { type: 'jokers', count: cards.length };
      return null;
    }
    const rank = real[0].value;
    if (real.every(c => c.value === rank) && cards.length <= 4) return { type: 'set', rank, cards };
    const run = computeRunAssignment(cards, runStart, isOpen);
    if (run) return { type: 'run', ...run, cards };
    return null;
  }

  /* ANLEGEN an eine Strasse: Die Lage der Strasse und damit die Rolle jedes Jokers sind
   * festgeschrieben. Eine neue Karte darf deshalb nur UNTEN oder OBEN anschliessen – sie darf
   * keinen Platz einnehmen, den ein Joker haelt (dafuer gibt es den TAUSCH, bei dem der Joker
   * auf die Hand wandert). Sonst wuerden Joker still umspringen ("alles schiebt sich").
   * Rueckgabe: neue Startlage (startIdx) oder null, wenn Anlegen nicht erlaubt ist.
   * Ein angelegter Joker waehlt oben/unten: die wertvollere Karte, die nicht offen liegt. */
  function runAttachStart(cards, runStart, card, isOpen) {
    const info = classifyGroup(cards, runStart, isOpen);
    if (!info || info.type !== 'run') return null;
    const start = info.startIdx, end = start + cards.length - 1;
    const last = REAL_RANKS.length - 1;
    if (!card.isJoker) {
      if (card.suit !== info.suit) return null;
      const cand = card.value === 'A' ? [MAX_IDX, -2] : [RANK_INDEX[card.value]];
      if (cand.includes(start - 1) && start - 1 >= MIN_IDX) return start - 1;
      if (cand.includes(end + 1) && end + 1 <= last) return start;
      return null;
    }
    const opts = [];
    if (end + 1 <= last) opts.push({ start, rank: end + 1 });
    if (start - 1 >= MIN_IDX) opts.push({ start: start - 1, rank: start - 1 });
    const free = isOpen ? opts.filter(o => !isOpen(rankAt(o.rank), info.suit)) : opts;
    if (!free.length) return null;
    free.sort((a, b) => pointsAt(b.rank) - pointsAt(a.rank) || b.rank - a.rank);
    return free[0].start;
  }

  /* AUSWAHL-MENUE fuer Joker in Strassen. Gibt alle zulaessigen Lagen zurueck, geordnet nach
   * Punkten (beste zuerst). Zulaessig = kein Joker stellt eine offen liegende Karte (isOpen) oder
   * eine echte Karte dar, die schon auf dem Tisch liegt (tableKeys: Set aus "wert_farbe"). */
  function jokerFree(rankIdx, suit, isOpen, tableKeys) {
    const v = rankAt(rankIdx);
    if (isOpen && isOpen(v, suit)) return false;
    if (tableKeys && tableKeys.has(v + '_' + suit)) return false;
    return true;
  }
  function runChoices(cards, isOpen, tableKeys) {
    const out = [];
    allRunAssignments(cards).forEach(a => {
      const jk = a.slots.filter(isJokerSlot);
      if (jk.some(sl => !jokerFree(sl.rankIdx, a.suit, isOpen, tableKeys))) return;
      out.push({ startIdx: a.startIdx, suit: a.suit, points: assignmentPoints(a),
        jokers: jk.map(sl => rankAt(sl.rankIdx)), natural: a.slots.some(sl => sl.natural) });
    });
    out.sort((x, y) => y.points - x.points || y.startIdx - x.startIdx);
    return out;
  }
  /* Joker an eine bestehende Strasse anlegen: unten oder oben (je nach Rand und freier Karte). */
  function attachJokerChoices(cards, runStart, isOpen, tableKeys, card) {
    const info = classifyGroup(cards, runStart, isOpen);
    if (!info || info.type !== 'run') return [];
    const start = info.startIdx, end = start + cards.length - 1;
    const last = REAL_RANKS.length - 1;
    const opts = [];
    if (end + 1 <= last && jokerFree(end + 1, info.suit, isOpen, tableKeys)) opts.push({ startIdx: start, suit: info.suit, jokers: [rankAt(end + 1)], rankIdx: end + 1 });
    if (start - 1 >= MIN_IDX && jokerFree(start - 1, info.suit, isOpen, tableKeys)) opts.push({ startIdx: start - 1, suit: info.suit, jokers: [rankAt(start - 1)], rankIdx: start - 1 });
    opts.forEach(o => {
      o.points = pointsAt(o.rankIdx);
      if (card && o.rankIdx === -1 && card.suit === info.suit) { o.natural = true; o.jokers = []; }
    });
    opts.sort((a, b) => b.points - a.points || b.rankIdx - a.rankIdx);
    return opts;
  }

  /* Darf `card` an diese Gruppe angelegt werden? Die ART einer Gruppe (Satz / Strasse / reine
   * Jokergruppe) steht mit dem Auslegen fest und aendert sich durch Anlegen NIE – sonst wuerde
   * z. B. eine 150-Punkte-Jokergruppe durch eine angelegte echte 10 zum 40-Punkte-Satz.
   * Rueckgabe: { ok, start (nur Strassen), why: 'run' | 'jokers' | 'type' | 'invalid' }. */
  function attachCheck(cards, runStart, card, isOpen) {
    const cur = classifyGroup(cards, runStart);
    if (!cur) return { ok: false, why: 'invalid' };
    if (cur.type === 'run') {
      const st = runAttachStart(cards, runStart, card, isOpen);
      return st === null ? { ok: false, why: 'run' } : { ok: true, start: st };
    }
    const now = classifyGroup(cards.concat([card]));
    if (!now || now.type !== cur.type) return { ok: false, why: cur.type === 'jokers' ? 'jokers' : 'type' };
    if (cur.type === 'set' && now.rank !== cur.rank) return { ok: false, why: 'type' };
    return { ok: true, start: null };
  }

  function isValidGroup(cards) {
    return classifyGroup(cards) !== null;
  }

  function pointsForCards(cards, runStart, isOpen) {
    const info = classifyGroup(cards, runStart, isOpen);
    if (!info) return null;
    if (info.type === 'jokers') return info.count === 3 ? 150 : 200;
    if (info.type === 'set') return cards.length * pointsForRank(info.rank);
    if (info.type === 'run') {
      let total = 0;
      info.slots.forEach(s => (total += pointsAt(s.rankIdx)));
      return total;
    }
    return null;
  }

  function pointsForMeld(meld) {
    return pointsForCards(meld.cards.map(mc => mc.card), meld.runStart) || 0;
  }

  function meldPointSplit(meld) {
    const cards = meld.cards.map(mc => mc.card);
    const info = classifyGroup(cards, meld.runStart);
    const split = [0, 0];
    if (!info) return split;
    if (info.type === 'jokers') {
      split[meld.ownerId] += info.count === 3 ? 150 : 200;
      return split;
    }
    if (info.type === 'set') {
      const per = pointsForRank(info.rank);
      meld.cards.forEach(mc => (split[mc.addedBy] += per));
      return split;
    }
    if (info.type === 'run') {
      const byId = {};
      meld.cards.forEach(mc => (byId[mc.card.id] = mc));
      info.slots.forEach(slot => {
        const mc = byId[slot.card.id];
        if (mc) split[mc.addedBy] += pointsAt(slot.rankIdx);
      });
      return split;
    }
    return split;
  }

  function meldIsLocked(meld) {
    return new Set(meld.cards.map(mc => mc.addedBy)).size > 1;
  }

  /*
   * Hausregel: Ein Joker darf niemals eine Karte darstellen, die gerade
   * offen sichtbar ist (Restkarte oder irgendwo im aktuellen Ablagestapel).
   * Diese Karte ist "im Spiel" (fest an ihrem sichtbaren Platz) und kann
   * daher nicht gleichzeitig als Joker-Ersatz gelten.
   *
   * Gibt eine Liste der konkreten (value, suit)-Karten zurueck, die ein
   * Joker in dieser Gruppe darstellen wuerde, aber gerade offen liegt.
   * Leeres Array = keine Kollision, die Gruppe darf gelegt werden.
   */
  function jokerVisibilityConflicts(cards, reserveCard, discardPile) {
    const info = classifyGroup(cards);
    if (!info) return [];
    const isOpenlyVisible = makeIsOpen(reserveCard, discardPile);
    const conflicts = [];
    if (info.type === 'run') {
      // Mehrere moegliche Lagen: erlaubt, sobald EINE davon keine offene Karte darstellt.
      let best = null;
      allRunAssignments(cards).forEach(a => {
        const conf = [];
        a.slots.forEach(slot => {
          if (isJokerSlot(slot)) {
            const value = rankAt(slot.rankIdx);
            if (isOpenlyVisible(value, a.suit)) conf.push({ value, suit: a.suit });
          }
        });
        if (best === null || conf.length < best.length) best = conf;
      });
      (best || []).forEach(c => conflicts.push(c));
    } else if (info.type === 'set') {
      const jokerCount = cards.filter(c => c.isJoker).length;
      if (jokerCount > 0) {
        const usedSuits = new Set(cards.filter(c => !c.isJoker).map(c => c.suit));
        const missingSuits = SUITS.filter(suit => !usedSuits.has(suit));
        const visibleMissing = missingSuits.filter(suit => isOpenlyVisible(info.rank, suit));
        const hiddenMissing = missingSuits.filter(suit => !isOpenlyVisible(info.rank, suit));
        // Ein Joker in einem Drilling/Vierling muss nicht "erklaeren", welche Farbe er
        // darstellt – er darf jede der fehlenden Farben sein. Blockiert ist die Gruppe
        // also nur, wenn nicht genug NICHT sichtbare fehlende Farben fuer alle Joker
        // uebrig bleiben (jeder Joker braucht seine eigene, verdeckte Alternative).
        if (hiddenMissing.length < jokerCount) {
          visibleMissing.forEach(suit => conflicts.push({ value: info.rank, suit }));
        }
      }
    }
    return conflicts;
  }

  /* TISCHPRUEFUNG: Es gibt jede Karte nur EINMAL (ein Deck). Ein Joker darf deshalb keine Karte
   * darstellen, die schon als echte Karte auf dem Tisch liegt (in irgendeiner Gruppe), offen in
   * Rest/Ablage liegt oder von einem anderen Joker schon dargestellt wird.
   * melds: [{ cards: [Karte,...], runStart }]. Rueckgabe: Liste von Fehlertexten (leer = alles ok). */
  function tableJokerProblems(melds, reserveCard, discardPile) {
    const isOpen = makeIsOpen(reserveCard, discardPile);
    const claimed = new Set();
    melds.forEach(m => m.cards.forEach(c => { if (!c.isJoker) claimed.add(c.value + '_' + c.suit); }));
    const problems = [];
    const infos = melds.map(m => classifyGroup(m.cards, m.runStart, isOpen));
    infos.forEach(info => { if (info && info.type === 'run') info.slots.forEach(sl => { if (sl.natural) claimed.add('2_' + info.suit); }); });
    // 1) Strassen: jeder Joker steht fuer genau eine bestimmte Karte
    infos.forEach(info => {
      if (!info || info.type !== 'run') return;
      info.slots.forEach(sl => {
        if (!isJokerSlot(sl)) return;
        const value = rankAt(sl.rankIdx);
        const key = value + '_' + info.suit;
        if (claimed.has(key) || isOpen(value, info.suit)) problems.push(`${value}${info.suit} gibt es schon (Tisch, Rest oder Ablage)`);
        else claimed.add(key);
      });
    });
    // 2) Saetze: Joker stehen fuer fehlende Farben dieses Rangs – davon muss genug uebrig sein
    const jokersByRank = {};
    infos.forEach(info => {
      if (!info || info.type !== 'set') return;
      const j = info.cards.filter(c => c.isJoker).length;
      if (j > 0) jokersByRank[info.rank] = (jokersByRank[info.rank] || 0) + j;
    });
    Object.keys(jokersByRank).forEach(rank => {
      const free = SUITS.filter(su => !claimed.has(rank + '_' + su) && !isOpen(rank, su)).length;
      if (jokersByRank[rank] > free) {
        problems.push(`von der ${rank} gibt es nur ${free} freie Karte(n), aber ${jokersByRank[rank]} Joker sollen eine ${rank} darstellen`);
      }
    });
    return problems;
  }

  return {
    runChoices, attachJokerChoices, tableJokerProblems, rankAt, pointsAt, isJokerSlot, MIN_IDX, MAX_IDX,
    SUITS, REAL_RANKS, RANK_INDEX,
    pointsForRank, cardKey, buildDeck, shuffle,
    classifyGroup, computeRunAssignment, allRunAssignments, pickRunStart, runAttachStart, attachCheck, makeIsOpen, isValidGroup, pointsForCards,
    meldPointSplit, meldIsLocked, pointsForMeld,
    jokerVisibilityConflicts
  };
});
