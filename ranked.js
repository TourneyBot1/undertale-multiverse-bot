// ranked.js — UMT Bot ranked PvP logic (pure functions, no I/O)
// Ladder: 28 divisions, index 0 (Bronze 1) .. 27 (True Determination)

// Build the ladder as an ordered list of division labels.
const LADDER = [];
(() => {
  const fourDiv = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Emerald'];
  for (const rank of fourDiv) {
    for (let d = 1; d <= 4; d++) LADDER.push(`${rank} ${d}`);
  }
  for (let d = 1; d <= 3; d++) LADDER.push(`Amethyst ${d}`); // Amethyst 1-3
  LADDER.push('True Determination'); // top rank, no divisions
})();

const MAX_INDEX = LADDER.length - 1; // 27

// --- SEASON 2: flat Shadow Crystal value per rank group. ---
// Your own current rank decides the swing; the opponent's rank is irrelevant.
// Win = +value, Loss = -value. Lower ranks climb faster, TD moves slowest.
const RANK_SC = {
  Bronze: 50,
  Silver: 40,
  Gold: 35,
  Platinum: 25,
  Diamond: 20,
  Emerald: 16,
  Amethyst: 12,
  'True Determination': 10,
};

// Placement outcome -> starting division index (per Mazin's spec).
const PLACEMENT_TARGETS = { 0: 0, 1: 3, 2: 4, 3: 7, 4: 9, 5: 11 };
// 0 wins -> Bronze 1 (0), 1 -> Bronze 4 (3), 2 -> Silver 1 (4),
// 3 -> Silver 4 (7), 4 -> Gold 2 (9), 5 -> Gold 4 (11)

function labelFor(index) {
  const i = Math.max(0, Math.min(MAX_INDEX, index | 0));
  return LADDER[i];
}

// Base rank name for a division index (drops the division number).
function rankGroupFor(index) {
  const i = Math.max(0, Math.min(MAX_INDEX, index | 0));
  return LADDER[i].replace(/ \d+$/, '');
}

// Embed side-strip colors per rank ("line" color).
const RANK_COLORS = {
  Unranked: 0xFFFFFF,             // white
  Bronze: 0x8B5A2B,              // brown
  Silver: 0xAAAAAA,             // gray
  Gold: 0xFFD700,               // yellow
  Platinum: 0x00FFFF,           // cyan
  Diamond: 0x3498DB,            // blue
  Emerald: 0x2ECC71,            // green
  Amethyst: 0xB980E0,           // light purple
  'True Determination': 0xFF0000, // red (DT soul)
};

// Color for a player's current standing. Unplaced players get the white line.
function colorFor(index, placed) {
  if (!placed) return RANK_COLORS.Unranked;
  return RANK_COLORS[rankGroupFor(index)] ?? RANK_COLORS.Unranked;
}

function placementStartIndex(wins) {
  return PLACEMENT_TARGETS[Math.max(0, Math.min(5, wins | 0))] ?? 0;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// SEASON 2: Shadow Crystals a player gains/loses per match, from their OWN rank.
function scPerMatch(index) {
  return RANK_SC[rankGroupFor(index)] ?? RANK_SC.Bronze;
}

// SEASON 2: crystal delta for a match. Opponent standing is NOT a factor —
// a Gold player gains 35 on any win and loses 35 on any loss, including
// against an unplaced opponent. The rate is read from the player's rank at
// the moment the match resolves, so a loss at 0 SC is still charged at the
// current rank's rate before demotion is applied.
function computeDelta(myIndex, didWin) {
  const v = scPerMatch(myIndex);
  return didWin ? v : -v;
}

// Apply a crystal delta to a {index, crystals} state, handling promotion/demotion.
// - Each division holds crystals 0..99; hitting >=100 promotes and carries the remainder.
// - Dropping below 0 demotes to the previous division at (100 + leftover).
// - Bronze 1 (index 0) floors at 0 crystals (no demotion below).
// - True Determination (MAX_INDEX) has no ceiling: crystals stack past 100 (no promotion).
function applyDelta(state, delta) {
  let index = state.index | 0;
  let crystals = (state.crystals | 0) + delta;
  let promoted = false, demoted = false;
  // resolve rollovers (loop is safety; a single +/-90 crosses at most one boundary)
  let guard = 0;
  while (guard++ < 64) {
    if (index < MAX_INDEX && crystals >= 100) {
      crystals -= 100; index += 1; promoted = true; continue;
    }
    if (crystals < 0) {
      if (index > 0) { index -= 1; crystals += 100; demoted = true; continue; }
      crystals = 0; // Bronze 1 floor
    }
    break;
  }
  return { index, crystals, promoted, demoted };
}

module.exports = {
  LADDER, MAX_INDEX, RANK_SC, PLACEMENT_TARGETS, RANK_COLORS,
  labelFor, rankGroupFor, colorFor, placementStartIndex, scPerMatch, computeDelta, applyDelta,
};
