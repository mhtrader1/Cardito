// bots.js
// Bot logic for 4-player classic Hokm (Persian Hearts)
// Wrapper functions matching server's expected signatures:
// initMemory(): no args
// getBestMoveForPlay(hand, leadSuit, gs, memory)

// Suit and rank orders matching server's mapCardToEnum
const SUIT_ORDER = { '♥': 0, '♠': 1, '♦': 2, '♣': 3 };
const SUITS = [0,1,2,3]; // numeric suits
const RANK_ORDER = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };

/** Initialize bot memory (no arguments) */
function initMemory() {
  const memory = { seenCards: new Set(), partnerLacks: {}, remainCount: {} };
  SUITS.forEach(s => {
    memory.partnerLacks[s] = false;
    memory.remainCount[s] = 13;
  });
  return memory;
}

/** Update memory based on current trick entries */
function updateMemory(memory, entries, partnerIdx, gs) {
  // New trick: reset partner void info
  if (entries.length === 0) {
    SUITS.forEach(s => memory.partnerLacks[s] = false);
  }
  const leadSuit = gs.leadSuit; // numeric
  entries.forEach(({ player, card }) => {
    const suitNum = SUIT_ORDER[card.suit];
    const key = `${card.value}-${suitNum}`;
    if (!memory.seenCards.has(key)) {
      memory.seenCards.add(key);
      memory.remainCount[suitNum]--;
    }
    if (player.username === gs.players[partnerIdx].username && suitNum !== leadSuit) {
      memory.partnerLacks[leadSuit] = true;
    }
  });
}

/** Filter playable cards according to lead suit */
function filterPlayable(cards, leadSuit) {
  if (leadSuit === null || leadSuit === undefined) return cards.slice();
  const same = cards.filter(c => SUIT_ORDER[c.suit] === leadSuit);
  return same.length ? same : cards.slice();
}

/** Does card a beat card b under Hokm rules? */
function beats(a, b, leadSuit, trump) {
  if (!b) return true;
  const suitA = SUIT_ORDER[a.suit], suitB = SUIT_ORDER[b.suit];
  const valA = RANK_ORDER[a.value], valB = RANK_ORDER[b.value];
  if (suitA === suitB) return valA > valB;
  if (suitA === trump && suitB !== trump) return true;
  if (suitB === trump && suitA !== trump) return false;
  return suitA === leadSuit;
}

/** Get the current winning entry from table entries */
function getCurrentWinnerEntry(entries, leadSuit, trump) {
  return entries.reduce((best, e) => (
    beats(e.card, best.card, leadSuit, trump) ? e : best
  ));
}

/** Pick lowest card by rank from list */
function lowestCard(cards) {
  return cards.reduce((min, c) => (
    RANK_ORDER[c.value] < RANK_ORDER[min.value] ? c : min
  ), cards[0]);
}

/** Fallback discard strategy: lowest non-trump then lowest trump */
function customFallback(playable, trump) {
  const nonTrump = playable.filter(c => SUIT_ORDER[c.suit] !== trump);
  if (nonTrump.length) return lowestCard(nonTrump);
  return lowestCard(playable);
}

/** Critical situation: first to 7 tricks wins */
function isCriticalSituation(gs) {
  const teamKey = 'team' + gs.players[gs.turn].team;
  const us = gs.teamPoints[teamKey] || 0;
  const oppKey = teamKey === 'team1' ? 'team2' : 'team1';
  const opp = gs.teamPoints[oppKey] || 0;
  return us >= 6 || opp >= 6;
}

/** Lead strategy: lowest card from largest non-trump suit */
function highestOpening(playable, trump) {
  // count per suit
  const counts = {}; SUITS.forEach(s => counts[s] = 0);
  playable.forEach(c => counts[SUIT_ORDER[c.suit]]++);
  // find non-trump suit with max
  const nonTrump = SUITS.filter(s => s !== trump)
    .sort((a,b) => counts[b] - counts[a]);
  const suit = nonTrump.find(s => counts[s] > 0) || trump;
  const group = playable.filter(c => SUIT_ORDER[c.suit] === suit);
  return lowestCard(group);
}

/** Main entry matching server signature */
function getBestMoveForPlay(hand, leadSuit, gs, memory) {
  const trump = gs.trumpSuit; // numeric
  // 1. playable cards
  const playable = filterPlayable(hand, leadSuit);
  // 2. update memory
  const partnerIdx = (gs.turn + 2) % gs.players.length;
  updateMemory(memory, gs.table, partnerIdx, gs);
  // 3. critical
  if (isCriticalSituation(gs)) {
    return playable[Math.floor(Math.random() * playable.length)];
  }
  // 4. lead
  if (leadSuit === null || leadSuit === undefined) {
    return highestOpening(playable, trump);
  }
  // 5. follow
  const winnerEntry = getCurrentWinnerEntry(gs.table, leadSuit, trump);
  const currentWinner = winnerEntry.card;
  const pos = gs.table.length;
  // last player
  if (pos === gs.players.length - 1) {
    // partner winning?
    if (winnerEntry.player.username === gs.players[partnerIdx].username) {
      return lowestCard(playable);
    }
    const winCards = playable.filter(c => beats(c, currentWinner, leadSuit, trump));
    if (winCards.length) return lowestCard(winCards);
    return customFallback(playable, trump);
  }
  // mid play
  const winPlay = playable.filter(c => beats(c, currentWinner, leadSuit, trump));
  if (winPlay.length) return lowestCard(winPlay);
  // can cut
  if (playable.length === hand.length) {
    const cuts = playable.filter(c => SUIT_ORDER[c.suit] === trump);
    if (cuts.length) return lowestCard(cuts);
  }
  return customFallback(playable, trump);
}

module.exports = { initMemory, getBestMoveForPlay };
