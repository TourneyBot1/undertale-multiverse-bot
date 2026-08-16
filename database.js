const fs = require('fs');
const path = require('path');
const DB_PATH = path.join(__dirname, 'data', 'players.json');
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
let db = { players: {}, meta: {} };
if (fs.existsSync(DB_PATH)) {
  try { db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch (e) { db = { players: {}, meta: {} }; }
}
// --- UPDATE 32: season state lives on db.meta (survives restarts) ---
if (!db.players) db.players = {};
if (!db.meta) db.meta = {};
if (db.meta.seasonActive === undefined) db.meta.seasonActive = true;
if (db.meta.seasonNumber === undefined) db.meta.seasonNumber = 1;
// --- UPDATE 12 MIGRATION: rename c_insaity → c_insanity ---
let migrated = false;
for (const userId of Object.keys(db.players || {})) {
  for (const char of (db.players[userId].characters || [])) {
    if (char.character_id === 'c_insaity') { char.character_id = 'c_insanity'; migrated = true; }
  }
}
if (migrated) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); console.log('[Migration] Renamed c_insaity → c_insanity in database.'); }
// -----------------------------------------------------------
function save() { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
function createDefaultPlayer() {
  return { determination: 0, soul_essence: 0, inventory: {}, characters: [{ id: 1, character_id: 'sans', exp: 0, shiny: false }], team: [1], nextCharId: 2, bossClears: 0, achievements: {}, killCounts: {}, ranked: { placed: false, placementGames: 0, placementWins: 0, index: 0, crystals: 0 } };
}
const playerDB = {
  ensurePlayer(userId) {
    if (!db.players[userId]) { db.players[userId] = createDefaultPlayer(); save(); }
    const p = db.players[userId];
    for (const c of p.characters) {
      if (c.exp === undefined) c.exp = 0;
      if (c.shiny === undefined) c.shiny = false;
    }
    if (!p.ranked) p.ranked = { placed: false, placementGames: 0, placementWins: 0, index: 0, crystals: 0 };
    return p;
  },
  getPlayer(userId) { return db.players[userId] || null; },
  addDetermination(userId, amount) { const p = this.ensurePlayer(userId); p.determination += amount; save(); },
  addSoulEssence(userId, amount) { const p = this.ensurePlayer(userId); p.soul_essence += amount; save(); },
  getInventory(userId) {
    const p = this.ensurePlayer(userId);
    return Object.entries(p.inventory).map(([item_id, amount]) => ({ item_id, amount }));
  },
  getItem(userId, itemId) {
    const p = this.ensurePlayer(userId);
    return { item_id: itemId, amount: p.inventory[itemId] || 0 };
  },
  addItem(userId, itemId, amount = 1) {
    const p = this.ensurePlayer(userId);
    p.inventory[itemId] = (p.inventory[itemId] || 0) + amount; save();
  },
  removeItem(userId, itemId, amount = 1) {
    const p = this.ensurePlayer(userId);
    if (!p.inventory[itemId] || p.inventory[itemId] < amount) return false;
    p.inventory[itemId] -= amount;
    if (p.inventory[itemId] <= 0) delete p.inventory[itemId];
    save(); return true;
  },
  hasItem(userId, itemId, amount = 1) {
    const p = this.ensurePlayer(userId);
    return (p.inventory[itemId] || 0) >= amount;
  },
  getCharacters(userId) { return this.ensurePlayer(userId).characters; },
  addCharacter(userId, characterId, exp = 0, shiny = false) {
    const p = this.ensurePlayer(userId);
    const c = { id: p.nextCharId, character_id: characterId, exp, shiny, naturalShiny: shiny };
    p.characters.push(c); p.nextCharId++; save(); return c;
  },
  removeCharacter(userId, charId) {
    const p = this.ensurePlayer(userId);
    const i = p.characters.findIndex(c => c.id === charId);
    if (i === -1) return false;
    p.characters.splice(i, 1);
    p.team = p.team.filter(id => id !== charId);
    save(); return true;
  },
  getCharacterById(charId, userId) {
    const p = this.ensurePlayer(userId);
    return p.characters.find(c => c.id === charId) || null;
  },
  setCharacterLocked(userId, charId, locked) {
    const p = this.ensurePlayer(userId);
    const c = p.characters.find(ch => ch.id === charId);
    if (!c) return false;
    c.locked = locked; save(); return true;
  },
  addMurderSin(userId) {
    const p = this.ensurePlayer(userId);
    if (!p.murderSins) p.murderSins = 0;
    p.murderSins++; save(); return p.murderSins;
  },
  setMurderReady(userId, val) {
    const p = this.ensurePlayer(userId);
    p.murderReady = val; save();
  },
  resetPlayer(userId) {
    db.players[userId] = createDefaultPlayer(); save();
  },
  addExp(userId, charId, amount) {
    const p = this.ensurePlayer(userId);
    const c = p.characters.find(ch => ch.id === charId);
    if (!c) return null;
    c.exp = (c.exp || 0) + amount;
    save(); return c;
  },
  getTeam(userId) {
    const p = this.ensurePlayer(userId);
    return p.team.map((charId, index) => {
      const char = p.characters.find(c => c.id === charId);
      if (!char) return null;
      return { slot: index + 1, character_row_id: charId, character_id: char.character_id, exp: char.exp || 0, shiny: char.shiny || false };
    }).filter(Boolean);
  },
  setTeamSlot(userId, slot, charId) {
    const p = this.ensurePlayer(userId);
    while (p.team.length < slot) p.team.push(null);
    // --- UPDATE 15: slot swap QoL ---
    // Find the previous slot of the incoming char (if any)
    const prevIdx = p.team.findIndex(id => id === charId);
    const occupant = p.team[slot - 1]; // who currently sits in target slot
    // Place incoming char in target slot
    p.team[slot - 1] = charId;
    if (prevIdx !== -1 && prevIdx !== slot - 1) {
      // Incoming char was on team — swap occupant into its previous slot
      p.team[prevIdx] = occupant; // could be null if target was empty
    } else if (prevIdx === -1 && occupant !== null && occupant !== undefined) {
      // Incoming char was NOT on team — push displaced occupant to next empty slot or slot 6
      const emptyIdx = p.team.findIndex((id, i) => i !== slot - 1 && (id === null || id === undefined));
      if (emptyIdx !== -1) {
        p.team[emptyIdx] = occupant;
      } else if (p.team.length < 6) {
        p.team.push(occupant);
      }
      // else: team is full and no empty slot — displaced occupant is simply removed from team
    }
    // Trim trailing nulls
    while (p.team.length > 0 && (p.team[p.team.length - 1] === null || p.team[p.team.length - 1] === undefined)) p.team.pop();
    save();
  },

  getBossClears(userId) { return this.ensurePlayer(userId).bossClears || 0; },
  addBossClear(userId) { const p = this.ensurePlayer(userId); p.bossClears = (p.bossClears || 0) + 1; save(); },
  getAchievements(userId) { return this.ensurePlayer(userId).achievements || {}; },
  hasAchievement(userId, id) { return !!(this.ensurePlayer(userId).achievements || {})[id]; },
  grantAchievement(userId, id) {
    const p = this.ensurePlayer(userId);
    if (!p.achievements) p.achievements = {};
    p.achievements[id] = true; save();
  },
  getKillCount(userId, enemyId) { return (this.ensurePlayer(userId).killCounts || {})[enemyId] || 0; },
  addKill(userId, enemyId) {
    const p = this.ensurePlayer(userId);
    if (!p.killCounts) p.killCounts = {};
    p.killCounts[enemyId] = (p.killCounts[enemyId] || 0) + 1; save();
  },
  // --- UPDATE 13: New tracking helpers ---
  // Track gacha pull count
  incGachaPulls(userId) {
    const p = this.ensurePlayer(userId);
    if (!p.gachaPulls) p.gachaPulls = 0;
    p.gachaPulls++; save(); return p.gachaPulls;
  },
  getGachaPulls(userId) { return this.ensurePlayer(userId).gachaPulls || 0; },
  // Track ordered boss kills for Story of Undertale achievement
  recordBossKillOrdered(userId, bossId) {
    const p = this.ensurePlayer(userId);
    if (!p.bossKillOrder) p.bossKillOrder = [];
    p.bossKillOrder.push(bossId); save();
  },
  getBossKillOrder(userId) { return this.ensurePlayer(userId).bossKillOrder || []; },
  // --- UPDATE 20: Track which character dealt the final blow to which boss (for the Enlightened questline) ---
  recordBossKillByChar(userId, bossId, characterId) {
    const p = this.ensurePlayer(userId);
    if (!p.bossKillsByChar) p.bossKillsByChar = {};
    p.bossKillsByChar[bossId] = characterId;
    save();
  },
  // Returns the character_id that last killed this boss, or null
  getBossKillByChar(userId, bossId) {
    const p = this.ensurePlayer(userId);
    return (p.bossKillsByChar || {})[bossId] || null;
  },
  // Clear a recorded boss kill (so the requirement must be re-met for the next evolution)
  clearBossKillByChar(userId, bossId) {
    const p = this.ensurePlayer(userId);
    if (p.bossKillsByChar && p.bossKillsByChar[bossId]) { delete p.bossKillsByChar[bossId]; save(); }
  },
  // Add a character with full options (supports naturalShiny flag)
  addCharacterFull(userId, characterId, exp = 0, shiny = false, naturalShiny = false) {
    const p = this.ensurePlayer(userId);
    const c = { id: p.nextCharId, character_id: characterId, exp, shiny, naturalShiny };
    p.characters.push(c); p.nextCharId++; save(); return c;
  },
  // Mark a character's shiny as natural (for natural-only achievements)
  setNaturalShiny(userId, charId, val) {
    const p = this.ensurePlayer(userId);
    const c = p.characters.find(ch => ch.id === charId);
    if (!c) return false;
    c.naturalShiny = val; save(); return true;
  },
  addDtVials(userId, amount) { this.addItem(userId, 'dt_vial', amount); },
  convertDtToDetermination(userId, dtVials) {
    const p = this.ensurePlayer(userId);
    const dtCount = p.inventory['dt_vial'] || 0;
    if (dtCount < dtVials) return { success: false, reason: 'Not enough DT Vials.' };
    if (dtVials < 1) return { success: false, reason: 'Need at least 1 DT Vial to convert.' };
    const used = dtVials;
    const det = dtVials * 25;
    p.inventory['dt_vial'] -= used;
    if (p.inventory['dt_vial'] <= 0) delete p.inventory['dt_vial'];
    p.determination = (p.determination || 0) + det;
    save();
    return { success: true, det, used };
  },  clearTeam(userId) { const p = this.ensurePlayer(userId); p.team = []; save(); },
  getTeamSize(userId) { const p = this.ensurePlayer(userId); return p.team.filter(id => id !== null).length; },

  // Leaderboard stats
  addDamageDealt(userId, amount) {
    const p = this.ensurePlayer(userId);
    if (!p.stats) p.stats = {};
    p.stats.totalDamage = (p.stats.totalDamage || 0) + amount;
    save();
  },
  addPvPWin(userId) {
    const p = this.ensurePlayer(userId);
    if (!p.stats) p.stats = {};
    p.stats.pvpWins = (p.stats.pvpWins || 0) + 1;
    save();
  },
  addPvPLoss(userId) {
    const p = this.ensurePlayer(userId);
    if (!p.stats) p.stats = {};
    p.stats.pvpLosses = (p.stats.pvpLosses || 0) + 1;
    save();
  },
  // --- RANKED PvP ---
  getRanked(userId) { return this.ensurePlayer(userId).ranked; },
  setRanked(userId, ranked) { const p = this.ensurePlayer(userId); p.ranked = ranked; save(); },
  resetRank(userId) {
    const p = this.ensurePlayer(userId);
    p.ranked = { placed: false, placementGames: 0, placementWins: 0, index: 0, crystals: 0 };
    save();
  },
  // --- UPDATE 32: season management ---
  getAllUserIds() { return Object.keys(db.players); },
  isSeasonActive() { return db.meta.seasonActive !== false; },
  getSeasonNumber() { return db.meta.seasonNumber || 1; },
  endSeason() {
    db.meta.seasonActive = false;
    db.meta.lastSeasonEndedAt = Date.now();
    save();
    return db.meta.seasonNumber || 1;
  },
  startSeason() {
    db.meta.seasonActive = true;
    db.meta.seasonNumber = (db.meta.seasonNumber || 1) + 1;
    db.meta.lastSeasonStartedAt = Date.now();
    save();
    return db.meta.seasonNumber;
  },
  resetAllRanks() {
    let n = 0;
    for (const p of Object.values(db.players)) {
      p.ranked = { placed: false, placementGames: 0, placementWins: 0, index: 0, crystals: 0 };
      n++;
    }
    save();
    return n;
  },
  addCharacterFlagged(userId, characterId, shiny = false, flags = {}) {
    const p = this.ensurePlayer(userId);
    const c = { id: p.nextCharId, character_id: characterId, exp: 0, shiny, naturalShiny: false, ...flags };
    p.characters.push(c); p.nextCharId++; save(); return c;
  },
  getRankedLeaderboard() {
    const entries = [];
    for (const [userId, p] of Object.entries(db.players)) {
      if (p.ranked && p.ranked.placed) entries.push({ userId, index: p.ranked.index, crystals: p.ranked.crystals });
    }
    entries.sort((a, b) => (b.index - a.index) || (b.crystals - a.crystals));
    return entries;
  },
  getStats(userId) {
    const p = this.ensurePlayer(userId);
    return p.stats || { totalDamage: 0, pvpWins: 0 };
  },
  // --- UPDATE 18: Booster character claim ---
  addBoosterCharacter(userId, characterId) {
    const p = this.ensurePlayer(userId);
    const c = { id: p.nextCharId, character_id: characterId, exp: 0, shiny: false, naturalShiny: false, fromBoost: true };
    p.characters.push(c); p.nextCharId++; save(); return c;
  },
  hasBoosterClaim(userId) {
    const p = this.ensurePlayer(userId);
    return (p.characters || []).some(c => c.fromBoost);
  },
  removeBoosterCharacters(userId) {
    const p = this.ensurePlayer(userId);
    const boostChars = (p.characters || []).filter(c => c.fromBoost);
    if (boostChars.length === 0) return [];
    const removedIds = boostChars.map(c => c.id);
    p.characters = p.characters.filter(c => !c.fromBoost);
    p.team = p.team.filter(id => !removedIds.includes(id));
    while (p.team.length > 0 && (p.team[p.team.length - 1] === null || p.team[p.team.length - 1] === undefined)) p.team.pop();
    save();
    return boostChars.map(c => c.character_id);
  },
  // --- UPDATE 19: Save/Load Team ---
  getSavedTeams(userId) {
    const p = this.ensurePlayer(userId);
    return p.savedTeams || {};
  },
  saveTeam(userId, name) {
    const p = this.ensurePlayer(userId);
    if (!p.savedTeams) p.savedTeams = {};
    const teamIds = [...p.team];
    if (Object.keys(p.savedTeams).length >= 3 && !p.savedTeams[name]) {
      return { success: false, reason: 'You can only have 3 saved teams! Delete one first by saving over it.' };
    }
    p.savedTeams[name] = teamIds;
    save();
    return { success: true };
  },
  loadTeam(userId, name) {
    const p = this.ensurePlayer(userId);
    if (!p.savedTeams || !p.savedTeams[name]) return { success: false, reason: `No saved team named **"${name}"** found.` };
    const savedIds = p.savedTeams[name];
    // Filter to only char IDs that still exist in the player's roster
    const validIds = savedIds.filter(id => p.characters.some(c => c.id === id));
    if (validIds.length === 0) return { success: false, reason: 'None of the characters in that saved team exist anymore!' };
    p.team = validIds;
    save();
    return { success: true, loaded: validIds.length, missing: savedIds.length - validIds.length };
  },
  deleteSavedTeam(userId, name) {
    const p = this.ensurePlayer(userId);
    if (!p.savedTeams || !p.savedTeams[name]) return false;
    delete p.savedTeams[name];
    save();
    return true;
  },
  // -------------------------------------------
  getLeaderboard(type) {
    const entries = [];
    for (const [userId, p] of Object.entries(db.players)) {
      if (type === 'damage') entries.push({ userId, value: p.stats?.totalDamage || 0 });
      else if (type === 'determination') entries.push({ userId, value: p.determination || 0 });
      else if (type === 'pvp') entries.push({ userId, value: p.stats?.pvpWins || 0 });
    }
    return entries.sort((a, b) => b.value - a.value).slice(0, 10);
  },
};
module.exports = playerDB;
