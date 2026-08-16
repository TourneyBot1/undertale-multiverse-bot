// ============================================
// GAME DATA - Update 4
// ============================================

const ADMINS = ['1290690841857495122', '830021320732966912', '1148245471878447136', '1246135773393195022', '856555712280657921', '1415686861372002316', '1008263106830536764'];
// Ranked PvP is locked to this server only (prevents alt-farming in private servers).
const PVP_GUILD_ID = '1488189373592764446';
// When true, ranked uses a GLOBAL cross-server matchmaking queue (ignores PVP_GUILD_ID).
const PVP_GLOBAL = true;
const MOD_ROLE = '1491371398088884344';

const TYPES = {
  Bone: { emoji: '🦴', weakness: 'Weapon', resistance: 'Magic' },
  Magic: { emoji: '✨', weakness: 'Bone', resistance: 'Food' },
  Food: { emoji: '🌭', weakness: 'Magic', resistance: 'Unique' },
  Weapon: { emoji: '🗡️', weakness: 'Unique', resistance: 'Bone' },
  Unique: { emoji: '⭐', weakness: 'Food', resistance: 'Weapon' },
  Melee: { emoji: '👊', weakness: 'Magic', resistance: 'Bone' },
  Fire: { emoji: '🔥', weakness: 'Food', resistance: 'Bone' },
  Shock: { emoji: '⚡', weakness: 'Bone', resistance: 'Melee' },
  Frost: { emoji: '❄️', weakness: 'Melee', resistance: 'Shock' },
  Galactic: { emoji: '🌌', weakness: 'Unique', resistance: 'Magic' },
  Cosmic: { emoji: '🌠', weakness: 'Galactic', resistance: 'Unique' },
  Crystal: { emoji: '💎', weakness: 'Fire', resistance: 'Bone' },
};

function getTypeMultiplier(attackType, defenderType) {
  if (!attackType) return 1;
  const defTypes = defenderType.split('/').map(t => t.trim());
  let totalMult = 0;
  for (const dt of defTypes) {
    if (!TYPES[dt]) { totalMult += 1; continue; }
    // Frost <-> Fire bidirectional super effective
    if (attackType === 'Frost' && dt === 'Fire') { totalMult += 2; continue; }
    if (attackType === 'Fire' && dt === 'Frost') { totalMult += 2; continue; }
    if (TYPES[dt].weakness === attackType) totalMult += 2;
    else if (TYPES[dt].resistance === attackType) totalMult += 0.5;
    else totalMult += 1;
  }
  return totalMult / defTypes.length;
}

function getTypeEmoji(type) {
  if (!type) return '';
  return type.split('/').map(t => TYPES[t.trim()]?.emoji || '').join('');
}

// --- LEVEL SYSTEM ---
const LEVEL_THRESHOLDS = [0, 20, 50, 120, 250];
const LEVEL_UNLOCKS = {
  1: { moves: 2, passive: false },
  2: { moves: 3, passive: false },
  3: { moves: 3, passive: false },
  4: { moves: 4, passive: true },
  5: { moves: 4, passive: true },
};
function getLevelFromExp(exp) {
  for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
    if (exp >= LEVEL_THRESHOLDS[i]) return i + 1;
  }
  return 1;
}
function getExpForNextLevel(level) {
  if (level >= 5) return null;
  return LEVEL_THRESHOLDS[level];
}
function getAvailableMoveCount(level, characterId) {
  // --- UPDATE 22: per-character move unlock overrides (Fallen Priest has 5 moves) ---
  if (characterId && CHARACTERS[characterId]?.moveUnlocks) {
    return CHARACTERS[characterId].moveUnlocks[level] || 2;
  }
  return LEVEL_UNLOCKS[level]?.moves || 2;
}
function hasPassiveUnlocked(level) { return LEVEL_UNLOCKS[level]?.passive || false; }

// --- SHINY SYSTEM ---
const SHINY_CHANCE = 1 / 25;
const SHINY_BONUS = { atk: 2, def: 2 };

// --- CHARACTERS ---
const CHARACTERS = {
  sans: {
    id: 'sans', name: 'Sans',
    description: 'The same, old, classic bonehead. Normal starter.',
    hp: 100, atk: 7, def: 8, type: 'Bone',
    passive: { name: 'Swift Joker', description: '15% chance to dodge incoming damage.', type: 'dodge', chance: 0.15 },
    abilities: [
      { name: 'Bone Throw', description: 'Your usual, normal bone throw.', type: 'Bone', damageMin: 15, damageMax: 25, maxUses: 25, special: null },
      { name: 'Duo Blasters', description: '20% chance to Poison the enemy.', type: 'Magic', damageMin: 20, damageMax: 30, maxUses: 15, special: { type: 'poison', chance: 0.2 } },
      { name: 'Ketchup Chugger', description: 'Recovers 35 HP.', type: 'Food', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'heal', amount: 35 } },
      { name: 'Teleport', description: 'Dodge attack this turn, +25% crit next turn.', type: 'Magic', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'teleport', dodgeThisTurn: true, critBoost: 0.25, priority: true } },
    ],
  },
  underfell_sans: {
    id: 'underfell_sans', name: 'Underfell Sans',
    description: 'The rough, dark, aggressive counterpart of Sans.',
    hp: 90, atk: 10, def: 8, type: 'Magic',
    passive: { name: 'Low Patience', description: 'Gain +1 ATK each turn.', type: 'atkBoost', amount: 1 },
    abilities: [
      { name: 'Spike Bones', description: 'Sharp n quick, yet effective.', type: 'Bone', damageMin: 20, damageMax: 25, maxUses: 20, special: null },
      { name: 'Big Blaster', description: '25% chance to inflict Poison.', type: 'Magic', damageMin: 20, damageMax: 30, maxUses: 15, special: { type: 'poison', chance: 0.25 } },
      { name: 'Chain Wrap', description: 'Lower enemy ATK by 3. 2 turn cooldown (3 if 3+ Underfells on the team).', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'debuff', stat: 'atk', amount: -3, target: 'enemy', cooldown: 2 } },
      { name: 'Bone Spear', description: '75% miss chance. Inflicts Bleed if it hits.', type: 'Bone', damageMin: 30, damageMax: 35, maxUses: 10, special: { type: 'risky', missChance: 0.75, statusOnHit: 'bleed' } },
    ],
  },
  outertale_sans: {
    id: 'outertale_sans', name: 'Outertale Sans',
    description: 'A sans who lived in space for so long, it grew him stronger.',
    hp: 105, atk: 9, def: 13, type: 'Unique',
    passive: { name: 'Blinding Starlight', description: 'When enemy uses Magic, they get -2 ATK and -1 DEF.', type: 'counterMagic', atkReduction: 2, defReduction: 1 },
    abilities: [
      { name: 'Triple Blasters', description: 'Transparent but powerful.', type: 'Magic', damageMin: 15, damageMax: 30, maxUses: 10, special: null },
      { name: 'Bone Cascade', description: 'Distracting pattern of bones.', type: 'Bone', damageMin: 10, damageMax: 15, maxUses: 30, special: null },
      { name: 'Meteor Strike', description: 'Charges 1 turn, massive damage. -2 ATK, -3 DEF on use.', type: 'Unique', damageMin: 40, damageMax: 50, maxUses: 5, special: { type: 'charge', chargeMessage: 'is charging up Meteor Strike...', selfDebuff: { atk: -2, def: -3 } } },
      { name: 'Gravity Manipulation', description: 'You -2 DEF, enemy -4 DEF. 2 turn cooldown (3 if 3+ Outertales on the team).', type: 'Unique', damageMin: 0, damageMax: 5, maxUses: 5, special: { type: 'gravityManip', selfDef: -2, enemyDef: -4, cooldown: 2 } },
    ],
  },
  underswap_sans: {
    id: 'underswap_sans', name: 'Underswap Sans',
    description: 'A bright, cheerful, short skeleton! He likes to say "Mweh heh heh."',
    hp: 140, atk: 8, def: 14, type: 'Bone/Food',
    passive: { name: 'Battle Body', description: 'At 50% HP, gain +5 DEF for 3 turns.', type: 'battleBody', defBoost: 5, duration: 3 },
    abilities: [
      { name: 'Bone Drop', description: '20% chance to Flinch. Priority move.', type: 'Bone', damageMin: 15, damageMax: 20, maxUses: 15, special: { type: 'priority', flinchChance: 0.2 } },
      { name: 'Bone Field', description: 'Enemy takes 5-10 dmg when using abilities for 5 turns.', type: 'Bone', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'boneField', damageMin: 5, damageMax: 10, duration: 5 } },
      { name: 'Bone Strike', description: '25% chance to Blue Soul the enemy.', type: 'Weapon', damageMin: 15, damageMax: 20, maxUses: 15, special: { type: 'blueSoul', chance: 0.25 } },
      { name: 'Raining Tacos', description: '0 ATK for 3 turns, heal 20 HP for 4 turns.', type: 'Food', damageMin: 0, damageMax: 0, maxUses: 7, special: { type: 'rainingTacos', atkLockTurns: 3, healPerTurn: 20, healDuration: 4 } },
    ],
  },
  killer_sans: {
    id: 'killer_sans', name: 'Killer Sans',
    description: 'A sans who THRIVES for bloodshed, simply for the thrill.',
    hp: 90, atk: 13, def: 9, type: 'Weapon/Unique',
    passive: { name: 'Last Stand', description: 'Survive fatal hit at 1 HP, +4 ATK, lose all DEF. Once only.', type: 'lastStand', atkBoost: 4 },
    abilities: [
      { name: 'Cutting Edge', description: 'A quick, lethal cut.', type: 'Weapon', damageMin: 15, damageMax: 20, maxUses: 25, special: null },
      { name: 'Reaping Rain', description: 'Sharp bones rain down.', type: 'Bone', damageMin: 10, damageMax: 20, maxUses: 15, special: null },
      { name: 'Goop Blaster', description: 'Huge damage, -2 DEF/-2 ATK to enemy, skip next turn.', type: 'Magic', damageMin: 20, damageMax: 25, maxUses: 5, special: { type: 'goopBlaster', enemyDef: -2, enemyAtk: -2, skipNextTurn: true } },
      { name: 'Timeline Star', description: 'Save stats, restore after 4 turns.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'timelineStar', restoreAfter: 4 } },
    ],
  },
  female_killer_sans: {
    id: 'female_killer_sans', name: 'Female Killer Sans',
    description: 'A deadly variant of Killer Sans. Exclusive reward character.',
    hp: 90, atk: 17, def: 13, type: 'Weapon/Unique',
    passive: { name: 'Last Stand', description: 'Survive fatal hit at 1 HP, +4 ATK, lose all DEF. Once only.', type: 'lastStand', atkBoost: 4 },
    abilities: [
      { name: 'Cutting Edge', description: 'A quick, lethal cut.', type: 'Weapon', damageMin: 15, damageMax: 20, maxUses: 25, special: null },
      { name: 'Reaping Rain', description: 'Sharp bones rain down.', type: 'Bone', damageMin: 10, damageMax: 20, maxUses: 15, special: null },
      { name: 'Goop Blaster', description: 'Huge damage, -2 DEF/-2 ATK to enemy, skip next turn.', type: 'Magic', damageMin: 25, damageMax: 30, maxUses: 5, special: { type: 'goopBlaster', enemyDef: -2, enemyAtk: -2, skipNextTurn: true } },
      { name: 'Timeline Star', description: 'Save stats, restore after 4 turns.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'timelineStar', restoreAfter: 4 } },
    ],
  },
  swapswap_sans: {
    id: 'swapswap_sans', name: 'Swapswap Sans',
    description: 'Is he lazy? Is he active? No one knows. What we do know, is that he has a badass sword.',
    hp: 125, atk: 10, def: 10, type: 'Bone/Weapon',
    passive: { name: 'Sharpness V', description: 'Attacks have 2x crit chance (30%).', type: 'doubleCrit' },
    abilities: [
      { name: 'Cross Bones', description: 'Four bones in a perfect cross angle.', type: 'Bone', damageMin: 15, damageMax: 25, maxUses: 20, special: null },
      { name: 'Double Blaster', description: 'Hits twice. 20% Poison each hit.', type: 'Magic', damageMin: 10, damageMax: 20, maxUses: 15, special: { type: 'doubleHit', poisonChance: 0.2 } },
      { name: 'Super Parry', description: 'Priority. Reflect enemy damage as Weapon type. Can\'t use next turn.', type: 'Weapon', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'parry', priority: true, cooldown: 1 } },
      { name: 'Epic Taunt', description: '+1 DEF for you. Enemy +2 ATK but can\'t switch out.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'taunt', selfDef: 1, enemyAtk: 2 } },
    ],
  },
  oceantale_sans: {
    id: 'oceantale_sans', name: 'Oceantale Sans',
    description: 'AHOY MATEYS!',
    hp: 110, atk: 12, def: 12, type: 'Magic/Unique',
    passive: { name: 'There Be Treasure!', description: 'At Lv4+: increases all drop chances by 1.5x. Does not stack with other Oceantale Sans.', type: 'thereBeTreasure' },
    abilities: [
      { name: 'Cannonballs', description: 'Fires cannonballs. Applies Burn for 2 turns. 15% chance to stun. While My Crew! is active, 30% chance a crewmate fires their own cannonball (hits twice).', type: 'Unique', damageMin: 12, damageMax: 17, maxUses: 15, special: { type: 'oceanCannonballs', burnDuration: 2, stunChance: 0.15, crewExtraChance: 0.30 } },
      { name: 'Cutlass Slashes', description: '3 slashes. 30% chance to apply Bleed.', type: 'Melee', damageMin: 7, damageMax: 13, maxUses: 25, special: { type: 'multiHit', minHits: 3, maxHits: 3, bleedChance: 0.3 } },
      { name: 'My Crew!', description: 'Summons a crew member dealing 10 dmg/turn for 2 turns. 3 turn cooldown.', type: 'Unique', damageMin: 5, damageMax: 10, maxUses: 5, special: { type: 'myCrew', damagePerTurn: 10, duration: 2, cooldown: 3 } },
      { name: 'TSUNAMI', description: 'Massive wave. -2 DEF to both you and enemy. 2 turn cooldown.', type: 'Magic', damageMin: 15, damageMax: 20, maxUses: 5, special: { type: 'tsunami', selfDef: -2, enemyDef: -2, cooldown: 2 } },
    ],
  },
  fresh_sans: {
    id: 'fresh_sans', name: 'Fresh Sans',
    description: 'THE FRESHIEST BROSKIIII',
    hp: 120, atk: 13, def: 9, type: 'Magic/Melee',
    passive: { name: 'Party Lights', description: 'At Lv4+: explosion-related attacks have a 33% chance to stun the enemy for 1 turn.', type: 'partyLights', stunChance: 0.33 },
    abilities: [
      { name: 'Fresh Bat', description: 'Takes out his trusty bat and bonks the enemy.', type: 'Melee', damageMin: 10, damageMax: 17, maxUses: 25, special: null },
      { name: 'Explosive Furbees', description: 'Spawns 3 exploding furbees. Applies Burn for 2 turns.', type: 'Magic', damageMin: 15, damageMax: 17, maxUses: 15, special: { type: 'burn', duration: 2, burnChance: 1.0 } },
      { name: 'Fresh Smog', description: 'Throws a disco ball that explodes. 20% chance to Stun for 1 turn.', type: 'Magic', damageMin: 16, damageMax: 21, maxUses: 15, special: { type: 'stun', chance: 0.2 } },
      { name: 'Chilling Reveal', description: 'Reveals the parasite. Enemy -2 ATK, -1 DEF. 1 turn cooldown.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'multiDebuffPlayer', enemyAtk: -2, enemyDef: -1, cooldown: 1 } },
    ],
  },
  m87: {
    id: 'm87', isEventChar: true, name: 'M87',
    description: '"Try not to fall into the void. Heh."',
    hp: 234, atk: 20, def: 20, type: 'Galactic/Magic',
    passive: { name: 'Just a Little Help', description: 'Every 4 turns, a meteor has a 2% chance to appear and deal 59 fixed damage to the enemy.', type: 'justALittleHelpChar', interval: 4, chance: 0.02, damage: 59 },
    abilities: [
      { name: 'Blaster Fusion', description: 'Two blasters fuse into one massive beam.', type: 'Magic', damageMin: 10, damageMax: 29, maxUses: 10, special: null },
      { name: 'M B Z', description: 'Manipulates space and gravity around the enemy.', type: 'Unique', damageMin: 14, damageMax: 45, maxUses: 5, special: { type: 'gravityEffect' } },
      { name: 'Time Space Cut', description: 'A cut through time and space.', type: 'Magic', damageMin: 13, damageMax: 25, maxUses: 15, special: { type: 'gravityEffect' } },
      { name: 'BLACKHOLE: COLLISION.', description: 'Devastating cosmic collision. Usable only after 35 turns. 6666 turn cooldown.', type: 'Unique', damageMin: 250, damageMax: 250, maxUses: 5, special: { type: 'blackholeCollision', minTurn: 35, cooldown: 6666 } },
    ],
  },
  toriel_char: {
    id: 'toriel_char', name: 'Toriel',
    description: 'The Caretaker of the Ruins and the former Queen of the Monsters.',
    hp: 120, atk: 6, def: 10, type: 'Unique/Magic',
    passive: { name: 'HADOUKEN!', description: 'First 3 attacks apply Burn.', type: 'hadouken', attacksLeft: 3 },
    abilities: [
      { name: 'Fireball', description: 'Applies Burn for 2 turns.', type: 'Magic', damageMin: 12, damageMax: 18, maxUses: 25, special: { type: 'burn', duration: 2 } },
      { name: 'Fireball Waves', description: 'A sweeping wave. Applies Burn 2 turns.', type: 'Magic', damageMin: 15, damageMax: 22, maxUses: 15, special: { type: 'burn', duration: 2 } },
      { name: 'Fireball Helix', description: 'Concentrated spiral. Burn 3 turns. Cooldown 1.', type: 'Magic', damageMin: 25, damageMax: 30, maxUses: 5, special: { type: 'burn', duration: 3, cooldown: 1 } },
      { name: 'Faltering Attack', description: 'Reduces enemy DEF by 2.', type: 'Unique', damageMin: 5, damageMax: 5, maxUses: 10, special: { type: 'debuff', stat: 'def', amount: -2, target: 'enemy' } },
    ],
  },
  ruins_dust_sans: {
    id: 'ruins_dust_sans', name: 'Ruins Dust Sans',
    description: 'The Beginning of the Journey to stop the Human.',
    hp: 120, atk: 7, def: 11, type: 'Magic/Weapon',
    passive: { name: 'Soul Embers', description: 'Burn damage dealt by this character heals 10 HP per turn.', type: 'soulEmbers', healAmount: 10 },
    abilities: [
      { name: 'Toy Knife Slash', description: 'High critical hit chance.', type: 'Weapon', damageMin: 15, damageMax: 20, maxUses: 20, special: { type: 'highCrit', critBonus: 0.2 } },
      { name: 'Stolen Fire', description: 'Applies Burn for 3 turns.', type: 'Magic', damageMin: 10, damageMax: 15, maxUses: 15, special: { type: 'burn', duration: 3 } },
      { name: 'Gaster Blaster', description: 'Fixed 30 damage.', type: 'Magic', damageMin: 30, damageMax: 30, maxUses: 10, special: null },
      { name: 'Knife Barrage', description: 'Hits 2-5 times. 25% crit per hit.', type: 'Weapon', damageMin: 6, damageMax: 12, maxUses: 5, special: { type: 'multiHit', minHits: 2, maxHits: 5, critBonus: 0.25 } },
    ],
  },
  snowdin_dust_sans: {
    id: 'snowdin_dust_sans', name: 'Snowdin Dust Sans',
    description: '"It will be better to be KILLED by ME... instead... right Papyrus?"',
    hp: 200, atk: 10, def: 12, type: 'Bone/Magic',
    passive: { name: 'Phantom Brother', description: 'Every 3rd turn, deals 15 True Damage automatically.', type: 'phantomBrother', interval: 3, damage: 15 },
    abilities: [
      { name: 'Bone Barrage', description: 'A barrage of bones.', type: 'Bone', damageMin: 10, damageMax: 26, maxUses: 25, special: null },
      { name: 'Bone Zone', description: 'Deals 10 dmg/turn for 3 turns. Not stackable.', type: 'Bone', damageMin: 10, damageMax: 10, maxUses: 10, special: { type: 'applyStatus', status: 'boneZone' } },
      { name: 'Triple Blaster', description: 'Massive damage. Cooldown 1.', type: 'Magic', damageMin: 15, damageMax: 30, maxUses: 5, special: { type: 'normal', cooldown: 1 } },
      { name: 'Fiery Hell', description: 'Applies Burn for 2 turns.', type: 'Magic', damageMin: 10, damageMax: 20, maxUses: 8, special: { type: 'burn', duration: 2 } },
    ],
  },
  papyrus_char: {
    id: 'papyrus_char', name: 'Papyrus',
    description: '"I shall capture u human, and then they will finally let me to become a Royal Guard!!"',
    hp: 250, atk: 9, def: 10, type: 'Bone/Unique',
    passive: null,
    abilities: [
      { name: 'Bone Barrage', description: 'A barrage of bones.', type: 'Bone', damageMin: 18, damageMax: 24, maxUses: 20, special: null },
      { name: 'Blue Bones', description: 'Trap: deals damage if enemy attacks.', type: 'Bone', damageMin: 10, damageMax: 40, maxUses: 15, special: { type: 'blueBones' } },
      { name: 'Blue Soul', description: 'DEF -3 and 50% Stun 1 turn.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'blueSoulBoss', defReduce: 3, stunChance: 0.5 } },
      { name: 'Special Attack', description: '20% fail. If fail +2 DEF. Cooldown 3.', type: 'Bone', damageMin: 25, damageMax: 35, maxUses: 5, special: { type: 'specialAttack', failChance: 0.2, defBoostOnFail: 2, cooldown: 3 } },
    ],
  },
  geno_sans: {
    id: 'geno_sans', name: 'Geno Sans',
    description: '"I\'m going to find a way to stop you, Frisk. Even if it means I have to reset everything myself."',
    hp: 150, atk: 16, def: 17, type: 'Bone/Unique',
    passive: { name: 'Still Determined', description: 'When HP hits 0, stays alive for 1 more turn (cannot be healed). 10% chance for 2 turns.', type: 'stillDetermined' },
    abilities: [
      { name: 'Glitchy Bones', description: 'Chance to make enemy miss their next attack.', type: 'Bone', damageMin: 10, damageMax: 15, maxUses: 20, special: { type: 'glitchyBones', missChance: 0.3 } },
      { name: 'Blaster Circle', description: 'Applies Poison for 2 turns.', type: 'Magic', damageMin: 14, damageMax: 21, maxUses: 15, special: { type: 'burn', duration: 2, statusOverride: 'poison' } },
      { name: 'Save Point Anchor', description: 'Reduce damage taken by 20% for 2 turns. 1 turn cooldown.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 4, special: { type: 'savePointAnchor', reduction: 0.2, duration: 2, cooldown: 1 } },
      { name: 'Save Screen Slash', description: 'Small chance to inflict Glitched — heals deal damage instead.', type: 'Unique', damageMin: 19, damageMax: 27, maxUses: 5, special: { type: 'saveScreenSlash', glitchedChance: 0.25 } },
    ],
  },
  hardtale_sans: {
    id: 'hardtale_sans', name: 'Hardtale Sans',
    description: 'A sans with IGNITION and FIRE. Hard for a reason.',
    hp: 160, atk: 7, def: 14, type: 'Magic/Fire',
    passive: { name: 'IGNITION', description: 'Attacks have 20% burn chance (+20% per level). At Lv5: name changes and all attacks inflict HELLFIRE (stronger burn, 3 turns).', type: 'ignition', baseChance: 0.2 },
    abilities: [
      { name: 'Ignition Blasters', description: 'Burn chance based on level. HELLFIRE at Lv5.', type: 'Magic', damageMin: 8, damageMax: 15, maxUses: 25, special: { type: 'ignitionAttack' } },
      { name: 'FALCON, PUNCH!', description: 'Burn chance based on level. HELLFIRE at Lv5.', type: 'Melee', damageMin: 15, damageMax: 15, maxUses: 20, special: { type: 'ignitionAttack' } },
      { name: 'Oh? Ur approaching me?', description: 'Burn chance based on level. HELLFIRE at Lv5. 15% chance to increase DEF by 2.', type: 'Weapon', damageMin: 9, damageMax: 12, maxUses: 15, special: { type: 'ignitionAttack', defBoostChance: 0.15, defBoostAmount: 2 } },
      { name: 'ZA WARUDO!', description: 'Skips enemy next turn. Cancels any charging moves. 2 turn cooldown.', type: 'Magic', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'zaWarudo', cooldown: 2 } },
    ],
  },
  ink_sans: {
    id: 'ink_sans', name: 'Ink Sans',
    description: '"the protector of Aus"',
    hp: 220, atk: 18, def: 17, type: 'Weapon/Magic',
    passive: { name: 'Spawn Normal Sans', description: 'Once: spawns a Sans that attacks for 8 turns (bone or blaster). Costs -4 DEF. Dies if Ink Sans dies.', type: 'spawnSans' },
    abilities: [
      { name: 'Ink Slash', description: 'Applies Ink effect (6 dmg/turn for 2 turns).', type: 'Weapon', damageMin: 15, damageMax: 25, maxUses: 20, special: { type: 'inkEffect' } },
      { name: 'Ink Bones', description: 'Throws 3-5 bones, 12-15 damage each.', type: 'Bone', damageMin: 12, damageMax: 15, maxUses: 20, special: { type: 'multiHit', minHits: 3, maxHits: 5 } },
      { name: 'Ink Blaster', description: 'Fixed 35 damage. Applies Ink effect. 1 turn cooldown.', type: 'Magic', damageMin: 35, damageMax: 35, maxUses: 20, special: { type: 'inkEffect', cooldown: 1 } },
      { name: 'Vials', description: 'Heals 40 HP. 2 turn cooldown.', type: 'Food', damageMin: 0, damageMax: 0, maxUses: 6, special: { type: 'heal', amount: 40, cooldown: 2 } },
    ],
  },
  ainavol: {
    id: 'ainavol', name: 'Ainavol',
    description: 'A timeline traveller of sorts.',
    hp: 150, atk: 15, def: 15, type: 'Magic/Unique',
    passive: { name: 'Aura Manipulation', description: '1/5 chance each attack deals 50% more damage.', type: 'auraManipulation', chance: 0.2, multiplier: 1.5 },
    abilities: [
      { name: 'Duo Blasters', description: '35% karma if hits twice.', type: 'Magic', damageMin: 16, damageMax: 22, maxUses: 20, special: { type: 'duoBlasters', karmaChance: 0.35 } },
      { name: 'Portal Pillar', description: '35% karma + 50% stun.', type: 'Unique', damageMin: 16, damageMax: 22, maxUses: 15, special: { type: 'portalPillar', karmaChance: 0.35, stunChance: 0.5 } },
      { name: 'retnuoC', description: '35% karma + 50% stun.', type: 'Unique', damageMin: 16, damageMax: 22, maxUses: 15, special: { type: 'portalPillar', karmaChance: 0.35, stunChance: 0.5 } },
      { name: 'Levitation', description: 'Dodge the next attack.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'teleport', dodgeThisTurn: true, critBoost: 0 } },
    ],
  },
  agem: {
    id: 'agem', name: 'agem',
    description: 'The other side of the coin.',
    hp: 150, atk: 15, def: 15, type: 'Bone/Magic',
    passive: { name: 'Get Used To It', description: 'Each time agem takes damage from the same move type, damage decreases by 5%.', type: 'getUsedToIt' },
    abilities: [
      { name: 'Flaming Bone Barrage', description: '30% chance to apply Burn.', type: 'Bone', damageMin: 16, damageMax: 22, maxUses: 20, special: { type: 'burn', duration: 2, burnChance: 0.3 } },
      { name: 'Flaming Blasters', description: '10% chance to apply Burn or Stun.', type: 'Magic', damageMin: 18, damageMax: 25, maxUses: 15, special: { type: 'flameBlaster', statusChance: 0.1 } },
      { name: 'Soul Trait', description: 'Randomly: Bravery (+35% dmg next turn), Integrity (enemy 10% miss), Patience (stun enemy), or Perseverance (block next hit).', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'soulTrait' } },
      { name: 'NUH UH!!!!!!', description: '25 dmg. If enemy attacks same turn: Blue Soul 1-2 turns + 20 bonus dmg, disables passive. 1 turn cooldown.', type: 'Unique', damageMin: 25, damageMax: 25, maxUses: 5, special: { type: 'nuhUh', cooldown: 1 } },
    ],
  },
  ainavolagem: {
    id: 'ainavolagem', name: 'Ainavolagem',
    description: 'Two timelines, one soul.',
    hp: 177, atk: 17, def: 17, type: 'Bone/Fire',
    passive: { name: 'Burning Desire', description: 'All attacks have 25% chance to apply Burn.', type: 'burningDesire', chance: 0.25 },
    abilities: [
      { name: 'Spear Impale', description: 'Chance to inflict Bleed or Flinch.', type: 'Melee', damageMin: 13, damageMax: 22, maxUses: 20, special: { type: 'spearImpale' } },
      { name: 'Karmatic Bone Strike', description: '40% chance to inflict Bleed.', type: 'Bone', damageMin: 15, damageMax: 25, maxUses: 15, special: { type: 'burn', duration: 2, statusOverride: 'bleed', burnChance: 0.4 } },
      { name: 'Blaster Barrage', description: '4-7 hits. Chance to inflict Burn, Electrified, or Karma each hit.', type: 'Magic', damageMin: 7, damageMax: 10, maxUses: 10, special: { type: 'ainavolBB', minHits: 4, maxHits: 7 } },
      { name: 'No More Mercy', description: 'Only usable at 20% HP. Guaranteed 2 status effects. 666 turn cooldown.', type: 'Unique', damageMin: 20, damageMax: 32, maxUses: 5, special: { type: 'noMoreMercy', hpThreshold: 0.2, cooldown: 666 } },
    ],
  },
  time_paradox: {
    id: 'time_paradox', name: 'Time Paradox',
    description: 'Two timelines colliding into one impossible existence.',
    hp: 140, atk: 12, def: 17, type: 'Bone/Magic',
    passive: { name: 'Time Split', description: 'Every 2 turns switches between Ainavol (ATK 12, DEF 17) and Agem (ATK 17, DEF 12) stats and moveset.', type: 'timeSplit' },
    abilities: [
      { name: 'Trio Blasters', description: '35% karma if hits 3 times.', type: 'Magic', damageMin: 16, damageMax: 22, maxUses: 15, special: { type: 'trioBlasters', karmaChance: 0.35 } },
      { name: 'Portal Pillar', description: '35% karma + 50% stun.', type: 'Unique', damageMin: 16, damageMax: 22, maxUses: 15, special: { type: 'portalPillar', karmaChance: 0.35, stunChance: 0.5 } },
      { name: 'Bone Whack', description: '35% stun.', type: 'Bone', damageMin: 21, damageMax: 28, maxUses: 15, special: { type: 'stun', chance: 0.35 } },
      { name: 'Otherworldly Block', description: 'Block the next attack with bones from another timeline.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 7, special: { type: 'teleport', dodgeThisTurn: true, critBoost: 0 } },
    ],
    phase2Abilities: [
      { name: 'Bone Spasm', description: 'Small chance to apply Burn or Electrified.', type: 'Bone', damageMin: 13, damageMax: 18, maxUses: 20, special: { type: 'boneSpasm' } },
      { name: 'Fried Snow Throw', description: 'Chance to inflict Blindness (enemy 20% miss for 2-3 turns).', type: 'Food', damageMin: 12, damageMax: 16, maxUses: 15, special: { type: 'blindness', chance: 0.35 } },
      { name: 'Rushdown', description: '4-7 hits. Chance to burn or flinch enemy.', type: 'Melee', damageMin: 7, damageMax: 10, maxUses: 10, special: { type: 'rushdown', minHits: 4, maxHits: 7 } },
      { name: 'Arm Blaster', description: 'Chance to inflict Karma. 1 turn cooldown.', type: 'Magic', damageMin: 23, damageMax: 36, maxUses: 5, special: { type: 'armBlaster', karmaChance: 0.35, cooldown: 1 } },
    ],
  },
  murder_sans: {
    id: 'murder_sans', name: 'Murder!Sans',
    description: '"this fella is not a bum."',
    hp: 155, atk: 15, def: 15, type: 'Bone/Magic',
    passive: { name: 'Yo im cool now', description: 'Taking damage increases ATK by 4 (max +25). Each attack used decreases ATK by 5.', type: 'murderPassive', maxBonus: 25, gainPerHit: 4, lossPerAttack: 5 },
    abilities: [
      { name: 'Bone Volley', description: 'Bones latch on for 3 turns, each exploding for damage.', type: 'Bone', damageMin: 15, damageMax: 35, maxUses: 10, special: { type: 'boneVolley', duration: 3 } },
      { name: 'Blasters go brr.', description: 'Applies Scary KR for 5 turns.', type: 'Magic', damageMin: 21, damageMax: 21, maxUses: 8, special: { type: 'scaryKR', duration: 5 } },
      { name: 'Knock-Out!', description: '35% stun for 1 turn.', type: 'Melee', damageMin: 25, damageMax: 30, maxUses: 3, special: { type: 'stun', chance: 0.35 } },
      { name: 'im gonna stab you with this BONE*', description: 'Applies Bleed. Hits multiple times.', type: 'Bone', damageMin: 11, damageMax: 25, maxUses: 5, special: { type: 'multiHit', minHits: 2, maxHits: 4, statusOnHit: 'bleed' } },
    ],
  },
  underswap_papyrus: {
    id: 'underswap_papyrus', name: 'Underswap Papyrus',
    description: '"even after all of that...you\'re nothing more than dead meat, waiting to be thrashed. you hear me? DEAD MEAT."',
    hp: 160, atk: 15, def: 16, type: 'Magic/Bone',
    passive: { name: 'Orange Logic', description: 'Enemies affected by Orange Soul take 10% more damage.', type: 'orangeLogic' },
    abilities: [
      { name: 'Bone Toss', description: '10% chance to apply Orange Soul for 2 turns.', type: 'Bone', damageMin: 15, damageMax: 20, maxUses: 20, special: { type: 'orangeSoul', chance: 0.1, duration: 2 } },
      { name: 'Off Guard Blast', description: '10% Orange Soul next turn + 20% Poison 2 turns.', type: 'Magic', damageMin: 18, damageMax: 24, maxUses: 15, special: { type: 'offGuardBlast' } },
      { name: 'Gravity Shift', description: '40% chance enemy\'s next move fails.', type: 'Magic', damageMin: 18, damageMax: 22, maxUses: 8, special: { type: 'gravityShift', failChance: 0.4 } },
      { name: 'Get Dunked Kid', description: 'Only triggers if enemy attacks this turn. Cancels damage and counters.', type: 'Unique', damageMin: 25, damageMax: 35, maxUses: 5, special: { type: 'getDunkedKid', cooldown: 1 } },
    ],
  },
  revenge_papyrus: {
    id: 'revenge_papyrus', name: 'Revenge Papyrus',
    description: '"i gave you every chance. i offered you my hand, and you gave me the dust of my brother and everyone else who i cared about. The \'great\' papyrus is gone. now... there is only justice."',
    hp: 200, atk: 16, def: 14, type: 'Bone/Magic',
    passive: { name: "Gaster's Help", description: 'At the start of every turn: 50% chance to Shield (next hit halved) or Assist (+10 DMG next attack).', type: 'gastersHelp' },
    abilities: [
      { name: 'Bonewave', description: 'High crit chance — the bone wave can bounce back after landing.', type: 'Bone', damageMin: 18, damageMax: 22, maxUses: 20, special: { type: 'highCrit', critBonus: 0.2 } },
      { name: 'Falling Bombs', description: '25% chance to inflict Burn for 2 turns.', type: 'Magic', damageMin: 20, damageMax: 27, maxUses: 15, special: { type: 'burn', duration: 2, burnChance: 0.25 } },
      { name: 'Spin', description: 'Papyrus spins with his bone out. 40% chance to stun enemy next turn.', type: 'Melee', damageMin: 22, damageMax: 30, maxUses: 10, special: { type: 'stun', chance: 0.4 } },
      { name: 'The Unseen Sentence', description: 'Only usable below 15% HP. Guaranteed Stun + permanently lowers enemy ATK by 2.', type: 'Unique', damageMin: 35, damageMax: 45, maxUses: 1, special: { type: 'unseenSentence', hpThreshold: 0.15 } },
    ],
  },
  error_sans: {
    id: 'error_sans', name: 'Error Sans',
    description: '"These anomalies, they infect and seep within every pore, every core of this massive world. But still, no matter how hard they try, I WILL EXTERMINATE THEM ALL!!!"',
    hp: 177, atk: 15, def: 15, type: 'Unique',
    passive: { name: '"YOU 4LL 4RE JUST L1TTL3 GL1TCH3S 1N MY W4Y"', description: 'Every 2 turns, enemy receives a random debuff for 1 round.', type: 'errorPassive', interval: 2 },
    abilities: [
      { name: 'String Slam', description: '15% stun. 5% chance enemy\'s next move deals 25% less damage.', type: 'Unique', damageMin: 12, damageMax: 16, maxUses: 20, special: { type: 'stringSlam', stunChance: 0.15, weakenChance: 0.05 } },
      { name: 'Capture Bone', description: '20% chance: forces enemy to use Melee next turn or take extra damage.', type: 'Bone', damageMin: 10, damageMax: 14, maxUses: 10, special: { type: 'captureBone', pullChance: 0.2 } },
      { name: 'Glitched Blasters', description: '40% chance enemy\'s next attack damages themselves instead.', type: 'Magic', damageMin: 18, damageMax: 25, maxUses: 5, special: { type: 'glitchedBlasters', reflectChance: 0.4 } },
      { name: '"YOU REALLY THOUGHT YOU COULD WEAKEN ME?"', description: 'Usable after turn 5. Resets DEF+ATK to default and clears all debuffs.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 2, special: { type: 'errorReset', minTurn: 5 } },
    ],
  },
  forced_grin: {
    id: 'forced_grin', name: 'a forced grin.',
    description: '"im doing this for you shad."',
    hp: 155, atk: 15, def: 15, type: 'Bone/Shock',
    passive: { name: 'A Rosy Pink Tint', description: '1/5 chance each attack is guaranteed to hit and gains +15% crit chance.', type: 'rosyPinkTint', chance: 0.2 },
    abilities: [
      { name: 'Bone Boomerang', description: 'Hits twice.', type: 'Bone', damageMin: 10, damageMax: 16, maxUses: 20, special: { type: 'doubleHit' } },
      { name: 'Dual Blasters', description: 'Hits twice. 30% chance to inflict Karma.', type: 'Magic', damageMin: 13, damageMax: 17, maxUses: 15, special: { type: 'duoBlasters', karmaChance: 0.30 } },
      { name: 'Charged Blaster', description: '30% Electrified. 10% backfire chance (damages self instead).', type: 'Shock', damageMin: 17, damageMax: 26, maxUses: 10, special: { type: 'chargedBlaster', electrifiedChance: 0.3, backfireChance: 0.1 } },
      { name: 'Car Battery!', description: 'Guaranteed Electrified + 50% Stun. 1 turn cooldown.', type: 'Shock', damageMin: 24, damageMax: 32, maxUses: 5, special: { type: 'carBattery', stunChance: 0.5, cooldown: 1 } },
    ],
  },
  admin_char: {
    id: 'admin_char', name: 'Admin',
    description: 'For testing purposes only.',
    hp: 9999, atk: 9999, def: 9999, type: 'Unique',
    passive: null,
    abilities: [
      { name: 'Test Attack', description: 'Deals massive damage.', type: 'Unique', damageMin: 9999, damageMax: 9999, maxUses: 99, special: null },
      { name: 'Test Attack 2', description: 'Deals massive damage.', type: 'Magic', damageMin: 9999, damageMax: 9999, maxUses: 99, special: null },
      { name: 'Test Heal', description: 'Heals massively.', type: 'Food', damageMin: 0, damageMax: 0, maxUses: 99, special: { type: 'heal', amount: 9999 } },
      { name: 'Test Status', description: 'Applies all statuses.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 99, special: { type: 'handsOfFate' } },
    ],
  },
  negativetale_sans: {
    id: 'negativetale_sans', name: 'Negativetale Sans',
    description: 'The shopkeeper of the underground. Don\'t let the friendly demeanor fool you.',
    hp: 180, atk: 14, def: 12, type: 'Unique/Magic',
    passive: { name: 'Black Soul', description: '1.2x damage to enemies with any status effect.', type: 'blackSoul', multiplier: 1.2 },
    abilities: [
      { name: 'Fracture Strike', description: 'Reduces enemy ATK by 3 for 2 turns. Not stackable.', type: 'Bone', damageMin: 14, damageMax: 20, maxUses: 20, special: { type: 'tempDebuff', stat: 'atk', amount: -3, target: 'enemy', duration: 2 } },
      { name: 'Tracking Blaster', description: 'Guaranteed hit. Cannot be parried or blocked. 20% stun.', type: 'Magic', damageMin: 17, damageMax: 23, maxUses: 10, special: { type: 'trackingBlaster', guaranteed: true, stunChance: 0.2 } },
      { name: 'Steal Weapon', description: 'Use a random move from any character. 1 turn cooldown.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'stealWeapon', cooldown: 1 } },
      { name: 'Coinflip', description: '50% chance: apply status to enemy OR deal +20 dmg + status to self for 2 turns.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'coinflip' } },
    ],
  },
  horror_sans: {
    id: 'horror_sans', name: 'Horror Sans',
    description: 'Starving and unhinged. He stitched an axe to his skull. Yep.',
    hp: 175, atk: 15, def: 10, type: 'Bone/Melee',
    passive: { name: "One Head Dog Comin' up!!!", description: 'Restores 30 HP when a party member is KO\'d.', type: 'headDog', healAmount: 30 },
    abilities: [
      { name: 'Rusty Cleaver', description: 'High crit chance. Applies Poison for 2 turns.', type: 'Melee', damageMin: 15, damageMax: 25, maxUses: 20, special: { type: 'highCrit', critBonus: 0.25, statusOnHit: 'poison', poisonDuration: 2 } },
      { name: 'Bone Skewer', description: '50% Stun chance. 2 turn cooldown.', type: 'Bone', damageMin: 20, damageMax: 25, maxUses: 15, special: { type: 'stun', chance: 0.5, cooldown: 2 } },
      { name: 'Axe Throw', description: 'High crit. 15% miss chance — if miss: 10 dmg to self + Poison. 2 turn cooldown.', type: 'Melee', damageMin: 15, damageMax: 30, maxUses: 10, special: { type: 'axeThrow', missChance: 0.15, selfDamage: 10, cooldown: 2 } },
      { name: 'Sharp Bone Zone', description: 'Enemy takes 15 dmg at start of their turn for 3 turns. Does not stack.', type: 'Bone', damageMin: 0, damageMax: 0, maxUses: 3, special: { type: 'sharpBoneZone', damagePerTurn: 15, duration: 3 } },
    ],
  },
  waterfall_dust_sans: {
    id: 'waterfall_dust_sans', name: 'Dust Sans (Waterfall)',
    description: 'Further down the journey. He\'s gotten stronger, quicker, sharper.',
    hp: 140, atk: 16, def: 12, type: 'Magic/Melee',
    passive: { name: 'Reflexes', description: 'DEF stat % chance to nullify incoming damage entirely.', type: 'reflexes' },
    abilities: [
      { name: 'Piercing Blow', description: 'A quick melee strike.', type: 'Melee', damageMin: 5, damageMax: 15, maxUses: 25, special: null },
      { name: 'Flame Blaster', description: '35% chance to apply Burn or Poison (random).', type: 'Magic', damageMin: 5, damageMax: 25, maxUses: 10, special: { type: 'flameBlaster', statusChance: 0.35 } },
      { name: 'Bone Wave', description: '+5% crit chance this attack.', type: 'Bone', damageMin: 10, damageMax: 15, maxUses: 15, special: { type: 'highCrit', critBonus: 0.05 } },
      { name: 'Defense Curl', description: 'Priority. -1 ATK. If hit >10 dmg, cancel all dmg and gain +2 DEF.', type: 'Melee', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'defenseCurl', priority: true, selfAtk: -1, blockThreshold: 10, defGain: 2 } },
    ],
  },
  idutshane: {
    id: 'idutshane', name: 'IDUTSHANE',
    description: 'A sans who seems to be out of his mind... With his silence attitude, he can be quite lethal, even with a... Shovel?',
    hp: 245, atk: 18, def: 18, type: 'Magic/Bone',
    passive: { name: 'Proper Burial', description: 'PvP only: killing an enemy skips your next turn, but heals 50 HP and grants +1 ATK and +2 DEF.', type: 'properBurial' },
    abilities: [
      { name: 'Flash Blast', description: 'A flash of his silhouette before a blaster catches you off guard. 35% chance to apply Poison or Blue Soul.', type: 'Magic', damageMin: 25, damageMax: 35, maxUses: 20, special: { type: 'flashBlast', chance: 0.35 } },
      { name: 'Bones of Desperation', description: 'Bones fly from every direction. Gains +3 damage each use.', type: 'Bone', damageMin: 10, damageMax: 25, maxUses: 15, special: { type: 'bonesOfDesperation' } },
      { name: 'Bone Carrousel', description: 'A twister of bones. Enemy takes 10 damage at turn start for 1-3 turns. Does not stack.', type: 'Bone', damageMin: 10, damageMax: 20, maxUses: 5, special: { type: 'boneCarrousel' } },
      { name: 'Aggravation', description: 'Doubles crit chance for 3 turns and gives +4 ATK. 4 turn cooldown. Only usable on turn 5+.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'aggravation', duration: 3, cooldown: 4, minTurn: 5, atkBoost: 4 } },
    ],
  },
  wd_gaster: {
    id: 'wd_gaster', name: 'W.D. Gaster',
    description: '"Beware of the man who speaks in hands."',
    hp: 200, atk: 16, def: 16, type: 'Magic/Unique',
    passive: { name: 'Duality', description: 'Alternates between Red (offense, +4 ATK) and Blue (defense, +4 DEF) each turn.', type: 'duality' },
    abilities: [
      { name: 'Hands of Fate', description: 'Randomly applies one status effect (Burn, Poison, or Stun).', type: 'Magic', damageMin: 15, damageMax: 30, maxUses: 20, special: { type: 'handsOfFate' } },
      { name: 'Monotone Beam', description: 'Requires a 2-turn charge. During charge, DEF is reduced by 8.', type: 'Magic', damageMin: 40, damageMax: 50, maxUses: 5, special: { type: 'charge', chargeMessage: 'is charging **Monotone Beam**... DEF reduced by 8!', selfDebuff: { atk: 0, def: -8 } } },
      { name: '᲼᲼᲼᲼', description: '20% chance to double hit for the same damage range.', type: 'Unique', damageMin: 20, damageMax: 30, maxUses: 10, special: { type: 'gasterSymbol' } },
      { name: 'Giant Gaster Blasters', description: 'Applies Poison for 3 turns. Not stackable. 2 turn cooldown.', type: 'Magic', damageMin: 25, damageMax: 35, maxUses: 5, special: { type: 'burn', duration: 3, cooldown: 2, statusOverride: 'poison' } },
    ],
  },
  star_sans: {
    id: 'star_sans', name: 'Sans encounter',
    description: 'A strange encounter. Something feels off about this one.',
    hp: 99, atk: 12, def: 14, type: 'Magic',
    passive: { name: 'Echo Protection', description: 'Below 50% HP: +2 DEF. Flower Echo is disabled.', type: 'echoProtection' },
    abilities: [
      { name: 'Gaster Blaster', description: '+3 dmg if crit.', type: 'Magic', damageMin: 25, damageMax: 40, maxUses: 30, special: null },
      { name: 'Bones', description: '+2 dmg if crit.', type: 'Bone', damageMin: 10, damageMax: 30, maxUses: 39, special: null },
      { name: 'Bone Zone', description: '+2 dmg if crit.', type: 'Bone', damageMin: 25, damageMax: 50, maxUses: 20, special: { type: 'applyStatus', status: 'boneZone' } },
      { name: 'Flower Echo', description: 'Heals 3-5 HP. Disabled below 50% HP.', type: 'Magic', damageMin: 0, damageMax: 0, maxUses: 20, special: { type: 'heal', amount: 4 } },
    ],
  },
  insanity_sans: {
    id: 'insanity_sans', name: 'Insanity Sans',
    description: '"heh heh... look at them run, papy... they\'re just like us, right? running from the fear..."',
    hp: 190, atk: 16, def: 10, type: 'Bone/Magic',
    passive: { name: 'Fractured Mind', description: 'Every time Sans loses 10% of his max HP, gain +2 ATK and +2 DEF.', type: 'fracturedMind' },
    abilities: [
      { name: 'Insanity Punch', description: 'Guaranteed hit. High crit. 5% chance to stun the enemy for 1 turn.', type: 'Melee', damageMin: 16, damageMax: 21, maxUses: 20, special: { type: 'trackingBlaster', guaranteed: true, stunChance: 0.05, critBonus: 0.2 } },
      { name: 'Sharp Bone Barrage', description: '2-5 hits. Applies Bleed or Poison for 2 turns if it hits 5+ times.', type: 'Bone', damageMin: 7, damageMax: 14, maxUses: 15, special: { type: 'sharpBoneBarrage', minHits: 2, maxHits: 5 } },
      { name: 'Gaster Blaster Frenzy', description: 'Clears all self debuffs. 20% chance: -10 HP to self. Poisons enemy 2 turns and -1 DEF.', type: 'Magic', damageMin: 25, damageMax: 32, maxUses: 10, special: { type: 'gasterBlasterFrenzy' } },
      { name: 'Insanity Teleport', description: 'Dodge next attack. Applies Bone Zone to enemy for 2 turns.', type: 'Unique', damageMin: 15, damageMax: 28, maxUses: 5, special: { type: 'insanityTeleport', cooldown: 2 } },
    ],
  },
  last_breath_sans: {
    id: 'last_breath_sans', name: 'Last Breath Sans',
    description: '"he\'s DEAD serious now,"',
    hp: 100, atk: 10, def: 16, type: 'Bone/Unique',
    passive: null,
    abilities: [
      { name: 'Bone Swing', description: '1/10 bleed chance, increases with use, resets after applied.', type: 'Bone', damageMin: 33, damageMax: 50, maxUses: 25, special: { type: 'boneSwing', baseBleedChance: 0.1 } },
      { name: 'Blaster Barrage', description: '100% Poison for 1-5 random turns.', type: 'Magic', damageMin: 1, damageMax: 45, maxUses: 12, special: { type: 'blasterBarrage' } },
      { name: 'Color Barrage', description: '50/50 lower enemy ATK or DEF next turn. 1 turn cooldown.', type: 'Unique', damageMin: 10, damageMax: 50, maxUses: 10, special: { type: 'colorBarrage', cooldown: 1 } },
      { name: 'BLOCKED', description: 'Triples DEF for 2 turns. Disables Bone Swing while active. 3 turn cooldown.', type: 'Bone', damageMin: 0, damageMax: 0, maxUses: 8, special: { type: 'blocked', defMultiplier: 3, duration: 2, cooldown: 3 } },
    ],
  },

  // --- UPDATE 11 CHARACTERS ---
  ft_sans: {
    id: 'ft_sans', name: 'FT!Sans',
    description: 'MY MEMORIES!',
    hp: 175, atk: 16, def: 14, type: 'Bone/Magic',
    passive: { name: 'Foresight', description: '20% chance to dodge the next attacking move.', type: 'foresight', chance: 0.2 },
    abilities: [
      { name: 'Bones.', description: '3-9 hits. 35% chance to inflict Karma for 2 turns.', type: 'Bone', damageMin: 7, damageMax: 9, maxUses: 20, special: { type: 'multiHit', minHits: 3, maxHits: 9, karmaChance: 0.35, karmaDuration: 2 } },
      { name: 'Gaster Blasters.', description: '3-5 hits. 35% chance to inflict Karma for 2 turns.', type: 'Magic', damageMin: 8, damageMax: 11, maxUses: 15, special: { type: 'multiHit', minHits: 3, maxHits: 5, karmaChance: 0.35, karmaDuration: 2 } },
      { name: 'Memories.', description: 'Summons a random Undertale boss to attack. Each summon has its own 10 uses. 1 turn cooldown.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 12, special: { type: 'memories', cooldown: 1 } },
      { name: 'Rewind.', description: 'Heals the damage you took most recently. Only usable below 100% HP. 1 turn cooldown.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 4, special: { type: 'rewind', cooldown: 1 } },
    ],
  },
  true_fresh_sans: {
    id: 'true_fresh_sans', name: 'True Fresh!Sans',
    description: 'What you running for broski..? THE PARTY HAS ONLY NOW STARTED!',
    hp: 210, atk: 17, def: 16, type: 'Unique/Melee',
    passive: { name: 'Parasitic Desires', description: 'Every time True Fresh kills anyone, regen 50 HP and gain +1 DEF.', type: 'parasiticDesires' },
    abilities: [
      { name: 'Tentacle Storm', description: 'Summons a barrage of tentacles (2-3 hits). 35% chance to apply Poison.', type: 'Melee', damageMin: 5, damageMax: 10, maxUses: 20, special: { type: 'multiHit', minHits: 2, maxHits: 3, poisonChance: 0.35 } },
      { name: 'Tentacle Chokehold', description: 'True Fresh grabs and chokes the enemy. 50% chance to Stun 1 turn. 1 turn cooldown.', type: 'Melee', damageMin: 21, damageMax: 24, maxUses: 15, special: { type: 'stun', chance: 0.5, cooldown: 1 } },
      { name: 'Terrifying Party', description: 'Summons a discoball that fires light beams (4-7 hits). 2 turn cooldown.', type: 'Unique', damageMin: 7, damageMax: 10, maxUses: 10, special: { type: 'multiHit', minHits: 4, maxHits: 7, cooldown: 2 } },
      { name: 'NEW HOST', description: 'PvP: if enemy ≤10% HP, True Fresh dies but kills and steals their character (50% HP, -5 ATK/-5 DEF). PvE: if boss ≤10% HP, instant kill. 1000 turn cooldown.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'newHost', hpThreshold: 0.10, cooldown: 1000 } },
    ],
  },
  shanghaivania_ink_sans: {
    id: 'shanghaivania_ink_sans', name: 'Shanghaivania Ink Sans',
    description: '"You killed me that quickly? I see... you\'re just like Error. Fine. If you want a monster, I\'ll show you what I\'m capable of. Let\'s get serious."',
    hp: 200, atk: 20, def: 18, type: 'Magic/Unique',
    passive: { name: 'The Living Canvas', description: 'Magic attacks have 10% chance to leave Ink Trail (3 turns): enemy +20% miss. Using Melee while trail is active consumes it to auto-dodge next attack.', type: 'livingCanvas', inkTrailChance: 0.1 },
    abilities: [
      { name: 'Painted Strike', description: '20% chance to apply Blindness for 2 turns.', type: 'Melee', damageMin: 10, damageMax: 14, maxUses: 20, special: { type: 'blindness', chance: 0.2, duration: 2 } },
      { name: 'Summoning Assistance', description: 'Summons Classic Sans or Fell Sans, each with 3 possible attacks.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 15, special: { type: 'summoningAssistance' } },
      { name: 'Vial Volley', description: 'Channels a random soul trait (Patience/Bravery/Integrity/Kindness/Perseverance/Justice/Determination).', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'vialVolley', cooldown: 1 } },
      { name: 'Last Resort', description: 'Magic blast that applies Poison, Bleed, Blindness, or Stun. Only usable after Summoning Assistance summoned Classic Sans AND after turn 5.', type: 'Magic', damageMin: 25, damageMax: 30, maxUses: 5, special: { type: 'lastResort', cooldown: 1 } },
    ],
  },
  uv_swap_sans: {
    id: 'uv_swap_sans', name: 'UV Swap Sans',
    description: 'People like you confuse me... you cannot change, you just want us to suffer for your entertainment... I\'ll make sure to get that cocky smile off your face.',
    hp: 200, atk: 20, def: 21, type: 'Melee/Bone',
    passive: { name: 'Locked tf in', description: '20% chance to parry an attack: takes 70% damage and reflects 30% back.', type: 'uvParry', chance: 0.20 },
    teamAbility: { name: 'FOR THEM!', description: 'If Underswap Papyrus is on the team, sacrifice them to heal UV Swap 75 HP and gain +5 ATK, -2 DEF.', type: 'forThem', requiresCharacter: 'underswap_papyrus', healAmount: 75, atkBoost: 5, defCost: 2 },
    abilities: [
      { name: 'Blue Bone Strikes', description: 'Attacks with 2 blue bones. 40% chance to Stun 1 turn.', type: 'Melee', damageMin: 15, damageMax: 20, maxUses: 25, special: { type: 'multiHit', minHits: 2, maxHits: 2, stunChance: 0.4 } },
      { name: 'Giant Gaster Blaster', description: 'Applies Poison for 2 turns and has a 30% chance to reduce enemy DEF by 1.', type: 'Magic', damageMin: 19, damageMax: 24, maxUses: 20, special: { type: 'giantGasterBlaster', poisonDuration: 2, defDownChance: 0.30, defDown: 1 } },
      { name: 'Blue Bone Combo', description: 'Applies Bleed for 2 turns. 30% chance to Stun. If stunned: enemy cannot switch out or escape for 2 turns (3 turn cooldown). If not stunned: applies Blue Soul for 1 turn.', type: 'Melee', damageMin: 16, damageMax: 25, maxUses: 15, special: { type: 'uvBlueBoneCombo', bleedDuration: 2, stunChance: 0.30, trapDuration: 2, blueSoulDuration: 1, stunCooldown: 3 } },
      { name: 'Bone Tower Barrage', description: '60% chance to inflict Bleed. If the enemy is Stunned or Poisoned, deals 1.2x damage. Any status damage the enemy takes is increased by +10 fixed. 1 turn cooldown.', type: 'Unique', damageMin: 20, damageMax: 25, maxUses: 5, special: { type: 'uvBoneTowerBarrage', bleedChance: 0.6, statusBonusMult: 1.2, statusDamageBonus: 10, cooldown: 1 } },
    ],
  },
  sansfield: {
    id: 'sansfield', name: 'Sansfield',
    description: 'I hate Mondays.',
    hp: 200, atk: 20, def: 22, type: 'Magic/Bone',
    passive: { name: 'Laziness', description: 'Every attack has a 20% chance to apply Blindness (20% miss chance) to the enemy.', type: 'laziness', chance: 0.2 },
    isGachaExclusive: true,
    abilities: [
      { name: 'Field Blasters', description: '20% chance to Poison.', type: 'Magic', damageMin: 20, damageMax: 20, maxUses: 20, special: { type: 'poison', chance: 0.2 } },
      { name: 'Odie Kick', description: '20% chance to Stun.', type: 'Melee', damageMin: 25, damageMax: 25, maxUses: 15, special: { type: 'stun', chance: 0.2 } },
      { name: 'Counting Sheep', description: 'Throws two sheep at the enemy.', type: 'Magic', damageMin: 10, damageMax: 20, maxUses: 10, special: { type: 'multiHit', minHits: 2, maxHits: 2 } },
      { name: 'Bite', description: '30% chance to apply Bleed.', type: 'Weapon', damageMin: 30, damageMax: 30, maxUses: 5, special: { type: 'bleed', chance: 0.3, cooldown: 1 } },
    ],
  },
  dustrust_sans: {
    id: 'dustrust_sans', name: 'Dustrust Sans',
    description: 'I\'ll make sure to be the ONLY one to finish the job!',
    hp: 220, atk: 14, def: 22, type: 'Weapon/Magic',
    passive: { name: 'Manic Fixation', description: 'Every kill grants +2 ATK permanently.', type: 'manicFixation', atkPerKill: 2 },
    isGachaExclusive: true,
    abilities: [
      { name: 'Dusty n\' Trusty Blasters', description: 'Applies Poison for 3 turns.', type: 'Magic', damageMin: 15, damageMax: 21, maxUses: 25, special: { type: 'poison', chance: 1.0, duration: 3 } },
      { name: 'Bone Jumps', description: '6 bone jumps at the enemy.', type: 'Bone', damageMin: 5, damageMax: 12, maxUses: 20, special: { type: 'multiHit', minHits: 6, maxHits: 6 } },
      { name: 'Pillar Throw', description: '40% chance to Stun. 60% chance to apply Bleed. 1 turn cooldown.', type: 'Weapon', damageMin: 26, damageMax: 33, maxUses: 10, special: { type: 'bleedAndStun', stunChance: 0.4, bleedChance: 0.6, cooldown: 1 } },
      { name: 'Blaster Circle', description: 'Applies Poison for 3 turns. 2 turn cooldown.', type: 'Magic', damageMin: 21, damageMax: 24, maxUses: 5, special: { type: 'poison', chance: 1.0, duration: 3, cooldown: 2 } },
    ],
  },
  // --- UPDATE 12 CHARACTERS ---
  c_insanity_weak: {
    id: 'c_insanity_weak', name: 'C!Insanity (Weak)',
    description: '"As the slash shall suit me... so will the snow suit the inner #### ######## #### STOP CENSORING ME GOD DAMN IT!"',
    hp: 140, atk: 11, def: 12, type: 'Magic/Weapon',
    passive: { name: "Rose's Assistant", description: 'Restores 10 HP at the start of each turn.', type: 'rosesAssistant', healAmount: 10 },
    isGachaExclusive: true,
    abilities: [
      { name: 'Faded Blaster', description: '30% chance: enemy next move deals 20% less damage.', type: 'Magic', damageMin: 10, damageMax: 20, maxUses: 30, special: { type: 'fadedBlaster', chance: 0.30, reduction: 0.20 } },
      { name: 'Shattered BoneWall', description: '30% chance: deal +20 bonus damage if enemy uses a damaging move next turn. Applies Bleed for 2 turns.', type: 'Bone', damageMin: 10, damageMax: 15, maxUses: 25, special: { type: 'shatteredBoneWall', counterChance: 0.30, counterDamage: 20, bleedDuration: 2 } },
      { name: 'Fractured Cleave', description: 'Guaranteed Bleed. 10% chance to lower enemy DEF by 2 permanently.', type: 'Melee', damageMin: 13, damageMax: 22, maxUses: 15, special: { type: 'fracturedCleave', defReduceChance: 0.10, defReduceAmount: 2 } },
      { name: 'Weakened Chung', description: 'Skip turn. Next turn deal damage with Karma. PvP kill: +10 HP. 1 turn cooldown.', type: 'Magic', damageMin: 20, damageMax: 30, maxUses: 5, special: { type: 'weakenedChung', cooldown: 1 } },
    ],
  },
  c_insanity: {
    id: 'c_insanity', name: 'C!Insanity',
    description: '"You touch Rose, and I\'ll split your head in two, human!"',
    hp: 175, atk: 17, def: 13, type: 'Magic/Weapon',
    passive: { name: "Rose's Support", description: 'Restores 25 HP at start of each turn. 20% chance to gain +1 DEF.', type: 'rosesSupport', healAmount: 25, defChance: 0.20 },
    abilities: [
      { name: 'Thousand Axe Slashes', description: 'Hits 3-7 times. Each hit 10% chance Bleed. All 7 hits: enemy -2 DEF permanently.', type: 'Weapon', damageMin: 7, damageMax: 10, maxUses: 20, special: { type: 'thousandAxeSlashes', minHits: 3, maxHits: 7, bleedChance: 0.10, allHitsDefReduction: 2 } },
      { name: 'Bone Calamity', description: 'Bone shards cover the field for 3 turns. Enemy using Melee/Weapon takes +6 recoil damage.', type: 'Bone', damageMin: 18, damageMax: 25, maxUses: 15, special: { type: 'boneCalamity', shardsDuration: 3, recoilDamage: 6 } },
      { name: 'Blaster Volley', description: 'On hit: enemy Electrified (-20% accuracy for 2 moves).', type: 'Magic', damageMin: 15, damageMax: 25, maxUses: 10, special: { type: 'blasterVolley' } },
      { name: 'C.H.U.N.G', description: 'Skip turn. Next turn blast ignores 30% DEF and applies Poison or Blindness for 2 turns. PvP kill: permanent +2 ATK. 1 turn cooldown.', type: 'Magic', damageMin: 25, damageMax: 35, maxUses: 3, special: { type: 'chungBlast', cooldown: 1, defIgnore: 0.30 } },
    ],
  },
  final_insanity: {
    id: 'final_insanity', name: 'Final Insanity',
    description: '"NO! ROSE! WHAT HAVE YOU DONE?! I... I... ... W I L L T U R N Y O U R S O U L I N T O L I Q U I D"',
    hp: 240, atk: 18, def: 20, type: 'Weapon/Unique',
    passive: { name: 'Losing His Mind', description: '50% chance on hit to apply 1 [INSANITY] stack. Each 3 stacks: enemy -2 ATK/-2 DEF. 6 stacks: 30% move fail. 10 stacks: stun next turn. Resets above 11 or on switch. When hitting an enemy, heal 2x the amount of stacks they have.', type: 'losingHisMind', applyChance: 0.50 },
    abilities: [
      { name: 'Bone Massacre', description: 'Hits all enemies. 25% chance to inflict Bleed for 2 turns.', type: 'Bone', damageMin: 18, damageMax: 24, maxUses: 20, special: { type: 'boneMassacre', bleedChance: 0.25, bleedDuration: 2 } },
      { name: 'Insanity Slash', description: '30% crit chance. On crit: applies 2 [INSANITY] stacks instead of 1.', type: 'Weapon', damageMin: 20, damageMax: 25, maxUses: 15, special: { type: 'insanitySlash', critChance: 0.30 } },
      { name: 'Devastating Roar', description: 'Prevents enemy boost/defense/healing next turn. 20% chance enemy flinches.', type: 'Unique', damageMin: 14, damageMax: 20, maxUses: 10, special: { type: 'devastatingRoar', flinchChance: 0.20 } },
      { name: 'Final C.H.U.N.G', description: 'Consumes all [INSANITY] stacks. +7 DMG per stack. At 7+ stacks: stuns enemy 2 turns. PvP kill: permanent +2 ATK. 3 turn cooldown.', type: 'Unique', damageMin: 35, damageMax: 45, maxUses: 5, special: { type: 'finalChung', cooldown: 3, perStackDamage: 7, stunThreshold: 7, stunDuration: 2 } },
    ],
  },
  weak_avenge_sans: {
    id: 'weak_avenge_sans', name: 'Weak Avenge Sans',
    description: '"You kill the innocent for no reason... you are a coward and I will not let you continue destroying worlds you insane freak!"',
    hp: 150, atk: 13, def: 14, type: 'Melee/Weapon',
    passive: { name: 'The Will to Avenge', description: 'For every 10% HP lost: +5% crit. On taking damage: +1 Spite stack (cap 10). Each stack = +1 ATK on next Melee, all consumed on Melee hit.', type: 'willToAvenge' },
    isGachaExclusive: true,
    abilities: [
      { name: 'Weak Omniversal Cleave', description: 'On hit: next Magic move deals 1.2x damage.', type: 'Melee', damageMin: 15, damageMax: 19, maxUses: 30, special: { type: 'weakOmniCleave', magicBoost: 1.2 } },
      { name: 'Weak Avenge Bones', description: 'On hit: 30% chance to lower enemy ATK by 2 for 1 turn.', type: 'Bone', damageMin: 10, damageMax: 14, maxUses: 25, special: { type: 'weakAvengeBones', atkReduceChance: 0.30, atkReduceAmount: 2, atkReduceTurns: 1 } },
      { name: 'Weak Avenge Blasters', description: 'Inflicts Karma. If HP below 30%, +10 damage.', type: 'Magic', damageMin: 18, damageMax: 22, maxUses: 15, special: { type: 'weakAvengeBlasters', lowHpBonus: 10, lowHpThreshold: 0.30 } },
      { name: 'Omni Deflect', description: 'Counter Stance: parry damage, strike back for 15 + 100% of negated damage. If the parry lands, restore 2 Spite stacks. If no Melee used: +1 DEF instead. 2 turn cooldown.', type: 'Weapon', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'omniDeflect', cooldown: 2, counterBase: 15, defGain: 1, spiteRestoreOnLand: 2 } },
    ],
  },
  avenge_sans: {
    id: 'avenge_sans', name: 'Avenge Sans',
    description: '"Awwww what\'s the matter now? What, you gonna cry? You gonna cry now??? Should have thought about that before killing so many innocent lives."',
    hp: 245, atk: 19, def: 22, type: 'Weapon/Unique',
    passive: { name: 'Omniversal Prodigy', description: '25% to auto-parry incoming attacks and deal back 30% damage with a 30% chance to stun. Accuracy cannot be lowered above 25% HP. Each Melee/Weapon hit: +7.5% Magic damage (caps 30%).', type: 'omniversalProdigy', parryChance: 0.25, counterPercent: 0.30, counterStunChance: 0.30, magicBoostPerHit: 0.075, magicBoostCap: 0.30, accuracyImmuneThreshold: 0.25 },
    abilities: [
      { name: 'Omni Sword Dance', description: 'High crit chance. 20% chance to gain +2 ATK.', type: 'Weapon', damageMin: 14, damageMax: 20, maxUses: 20, special: { type: 'omniSwordDance', critChance: 0.30, atkBoostChance: 0.20, atkBoostAmount: 2 } },
      { name: 'Avenge Blasters', description: 'Hits 4 times. Inflicts Karma. 10% chance Dazed for 2 turns (blocks counters).', type: 'Magic', damageMin: 8, damageMax: 8, maxUses: 15, special: { type: 'avengeBlasters', hits: 4, dazedChance: 0.10, dazedDuration: 2 } },
      { name: 'Universal Cut', description: 'On hit: enemy cannot switch or use Dodge/TP for 2 turns.', type: 'Weapon', damageMin: 21, damageMax: 27, maxUses: 10, special: { type: 'universalCut', restrictDuration: 2 } },
      { name: 'Avenge Sword Beam', description: 'On hit: disables 1 random enemy move for 2 turns. If enemy uses Magic next turn: 10 recoil. 2 turn cooldown.', type: 'Unique', damageMin: 25, damageMax: 35, maxUses: 5, special: { type: 'avengeSwordBeam', cooldown: 2, disableDuration: 2, magicRecoil: 10 } },
    ],
  },
  storyshift_sans: {
    id: 'storyshift_sans', name: 'StoryShift! Sans',
    description: '"I\'m breaking every bone in your body."',
    hp: 285, atk: 17, def: 12, type: 'Magic/Weapon',
    passive: { name: 'The King Will.', description: '15% chance each turn to reduce enemy ATK by 1.', type: 'theKingWill', chance: 0.15 },
    abilities: [
      { name: 'Burn. in. H. E. L. L.', description: '12% chance to inflict Karma for 3 turns.', type: 'Unique', damageMin: 12, damageMax: 28, maxUses: 5, special: { type: 'karma', chance: 0.12, duration: 3 } },
      { name: 'Blasters Hells', description: 'A powerful blast.', type: 'Magic', damageMin: 20, damageMax: 31, maxUses: 15, special: null },
      { name: 'Dropkick', description: '30% chance to Stun for 1 turn.', type: 'Melee', damageMin: 21, damageMax: 26, maxUses: 10, special: { type: 'stun', chance: 0.3 } },
      { name: 'Trident Assault', description: '10% chance to apply Bleed for 2 turns.', type: 'Weapon', damageMin: 11, damageMax: 29, maxUses: 15, special: { type: 'bleed', chance: 0.1 } },
    ],
  },
  // --- UPDATE 13 CHARACTERS ---
  mafiatale_sans: {
    id: 'mafiatale_sans', name: 'Mafiatale Sans',
    description: '"Capisce? Don\'t make me whack you, kid."',
    hp: 180, atk: 18, def: 17, type: 'Weapon/Unique',
    passive: { name: 'Bodyguards', description: 'First 3 turns: 15% DMG reduction shield. Magic hits get blocked: 20% less damage + 10 fixed retaliation.', type: 'bodyguards' },
    abilities: [
      { name: 'Bone Grenade', description: '30% chance to ignore 10% DEF, 25% chance to flinch.', type: 'Bone', damageMin: 12, damageMax: 15, maxUses: 20, special: { type: 'boneGrenade', defIgnoreChance: 0.3, defIgnoreAmount: 0.1, flinchChance: 0.25 } },
      { name: 'Tommy Gun Burst', description: '2-6 hits. Each hit 5% Bleed. 4+ hits = -10% enemy damage next turn.', type: 'Weapon', damageMin: 5, damageMax: 10, maxUses: 15, special: { type: 'tommyGunBurst', minHits: 2, maxHits: 6, bleedPerHit: 0.05, weakenThreshold: 4 } },
      { name: 'Bribery', description: '50% chance: -30% enemy accuracy 2 turns. If used after turn 3 vs Boss: 20% heal 10% HP instead.', type: 'Unique', damageMin: 17, damageMax: 21, maxUses: 10, special: { type: 'bribery', accuracyDebuff: 0.30, debuffDuration: 2, healChance: 0.2, healPercent: 0.1, cooldown: 1 } },
      { name: 'The Contract', description: 'For next 2 turns, every time enemy attacks, they take 15% recoil damage.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'theContract', duration: 2, recoilPercent: 0.15, cooldown: 3, minTurn: 3 } },
    ],
  },
  outerdust_sans: {
    id: 'outerdust_sans', name: 'Outerdust Sans',
    description: '"Who would have thought the answer was looking past the dust instead of the STARS."',
    hp: 220, atk: 17, def: 23, type: 'Magic/Unique',
    passive: { name: 'Sirius', description: 'All Outerdust attacks have a 20% chance to inflict Burn AND deal 1.5x damage.', type: 'sirius', chance: 0.2, multiplier: 1.5 },
    abilities: [
      { name: 'Star Devastation', description: '40% chance star explodes into smaller stars dealing 50% extra damage. 10% chance to inflict Star Shards for 2 turns.', type: 'Unique', damageMin: 14, damageMax: 17, maxUses: 20, special: { type: 'starDevastation', splitChance: 0.4, splitMultiplier: 0.5, starShardsChance: 0.10, starShardsDuration: 2 } },
      { name: 'Meteor Cataclysm', description: 'Applies Burn for 2 turns. If the target is already burned: the enemy flinches next turn and the move pierces 10% DEF (2 turn cooldown when the flinch triggers).', type: 'Magic', damageMin: 15, damageMax: 20, maxUses: 15, special: { type: 'meteorCataclysm', burnDuration: 2, defPierce: 0.10, flinchCooldown: 2 } },
      { name: 'Here Comes the Sun', description: 'Applies Burn 2 turns. 33% chance burn becomes Hellfire (8 dmg/turn). If Hellfire lands, destroys 2 DEF from the enemy and Outerdust gains 1 DEF.', type: 'Magic', damageMin: 17, damageMax: 25, maxUses: 10, special: { type: 'sunBurn', burnDuration: 2, hellfireChance: 0.33, hellfireDefDestroy: 2, selfDefGain: 1, cooldown: 1 } },
      { name: 'SINGULARITY', description: 'Both users get SINGULARITY. After 2 turns, both take 70% of damage stored.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'singularity', duration: 2, releaseMultiplier: 0.7, cooldown: 6 } },
    ],
  },
  judgement_hall_dust_sans: {
    id: 'judgement_hall_dust_sans', name: 'Judgement Hall Dust Sans',
    description: '"Do you think... that even the worst person can change? Heh, little late for that."',
    hp: 175, atk: 20, def: 17, type: 'Magic/Unique',
    passive: { name: 'Phantom Brother', description: 'Every turn, a spectral Papyrus deals an additional 10 True Damage automatically.', type: 'phantomBrother', amount: 10 },
    abilities: [
      { name: 'Vengeful Rend', description: '1/3 Burn, 1/3 Stun 1 turn, 1/3 boosted damage only.', type: 'Unique', damageMin: 18, damageMax: 24, maxUses: 20, special: { type: 'vengefulRend' } },
      { name: 'Octo Blasters', description: '20% Poison 2 turns. 10% Bound 2 turns (no switch, next attack 100% accuracy).', type: 'Magic', damageMin: 22, damageMax: 28, maxUses: 15, special: { type: 'octoBlasters', poisonChance: 0.2, poisonDuration: 2, boundChance: 0.1, boundDuration: 2 } },
      { name: 'Stolen Magic', description: 'Randomly steals attack effect from Toriel/Papyrus/Undyne/Mettaton/Asgore.', type: 'Unique', damageMin: 27, damageMax: 33, maxUses: 8, special: { type: 'stolenMagic', cooldown: 1 } },
      { name: '"My Strongest Attack"', description: 'Only usable below 5% HP. Poisons + Hellfire end of every turn, Stunned 1 turn, -2 DEF permanent.', type: 'Unique', damageMin: 40, damageMax: 50, maxUses: 1, special: { type: 'myStrongestAttack', hpThreshold: 0.05, defReducePermanent: 2 } },
    ],
  },
  hotlands_dust_sans: {
    id: 'hotlands_dust_sans', name: 'Hotlands Dust Sans',
    description: '"The air is thick with smoke and the smell of ozone. Sans has taken the mechanical power of the Underground to ensure the Human never reaches the Core."',
    hp: 165, atk: 18, def: 14, type: 'Bone/Magic',
    passive: { name: 'Falling Mini MTTs', description: 'End of every turn, 30% chance Mini MTT crashes on enemy for 8 DMG and -2 DEF.', type: 'fallingMiniMTTs', chance: 0.3, damage: 8, defReduce: 2 },
    abilities: [
      { name: 'Bone Shifter', description: 'If enemy uses Melee/Unique that turn, they trip for +10 auto damage.', type: 'Bone', damageMin: 15, damageMax: 22, maxUses: 20, special: { type: 'boneShifter', tripDamage: 10 } },
      { name: 'Exploding Bones', description: 'Applies Burn 2 turns. Non-stackable.', type: 'Bone', damageMin: 10, damageMax: 17, maxUses: 15, special: { type: 'burn', chance: 1.0, duration: 2, nonStackable: true } },
      { name: 'Shockwave Canon Bomb', description: '20% chance to disable a random enemy attack for 2 turns.', type: 'Magic', damageMin: 16, damageMax: 25, maxUses: 10, special: { type: 'shockwaveCanon', disableChance: 0.2, disableDuration: 2 } },
      { name: 'Stolen NEO Tech', description: 'Chance to fail and deal 25 self damage instead.', type: 'Unique', damageMin: 23, damageMax: 30, maxUses: 5, special: { type: 'stolenNeoTech', failChance: 0.25, selfDamage: 25, cooldown: 1 } },
    ],
  },
  core_dust_sans: {
    id: 'core_dust_sans', name: 'Core Dust Sans',
    description: '"You keep chasing a better ending... but all you\'re doing is digging a deeper one for yourself."',
    hp: 170, atk: 18, def: 17, type: 'Magic/Unique',
    passive: { name: 'Core Overload', description: 'Each Magic attack builds 1 Core Charge. After 3 charges, next attack deals 1.5x dmg + 100% accuracy. Surge resets DEF to 10 for 1 turn.', type: 'coreOverload' },
    abilities: [
      { name: 'Gun Beam', description: 'This attack pierces 20% of the enemy DEF.', type: 'Magic', damageMin: 15, damageMax: 20, maxUses: 15, special: { type: 'gunBeam', pierceAmount: 0.20 } },
      { name: 'Gravity Well', description: '25% chance Blue Soul (passive inactive, +10% miss chance for 1 turn).', type: 'Unique', damageMin: 10, damageMax: 15, maxUses: 15, special: { type: 'gravityWell', blueSoulChance: 0.25, missAmount: 0.1, duration: 1 } },
      { name: 'Spotlight Gaster Blaster', description: 'Next 2 turns: 100% accuracy + enemy can\'t dodge. 30% chance stun 1 turn.', type: 'Magic', damageMin: 18, damageMax: 25, maxUses: 10, special: { type: 'spotlightGB', accuracyTurns: 2, stunChance: 0.3 } },
      { name: 'Meltdown Flash', description: '40% chance Burn 3 turns. Disables Core Overload passive for 2 turns.', type: 'Fire', damageMin: 20, damageMax: 28, maxUses: 5, special: { type: 'meltdownFlash', burnChance: 0.4, burnDuration: 3, disableTurns: 2, cooldown: 1 } },
    ],
  },
  storyshift_chara: {
    id: 'storyshift_chara', name: 'Storyshift Chara',
    description: '"please stop oversexualizing us..."',
    hp: 170, atk: 15, def: 15, type: 'Melee/Unique',
    passive: { name: 'Shifted Judgement', description: 'Each turn enemy doesn\'t hit Chara: +10% crit chance (max 50%). On crit: enemy\'s next move deals 20% less damage.', type: 'shiftedJudgement' },
    abilities: [
      { name: 'Knife Barrage', description: '2-5 hits. If all 5 hits land, final hit doubles + applies Bleed.', type: 'Melee', damageMin: 4, damageMax: 6, maxUses: 20, special: { type: 'knifeBarrage', minHits: 2, maxHits: 5, allHitsThreshold: 5 } },
      { name: 'Chaos Busters', description: '2 hits. 15% Poison, 10% flinch.', type: 'Unique', damageMin: 12, damageMax: 14, maxUses: 15, special: { type: 'chaosBusters', hits: 2, poisonChance: 0.15, flinchChance: 0.10 } },
      { name: 'Pellet Circle', description: 'If enemy blocks, still hits for half damage.', type: 'Unique', damageMin: 16, damageMax: 20, maxUses: 10, special: { type: 'pelletCircle', blockBypass: true, blockBypassMult: 0.5 } },
      { name: 'Judgement Cut', description: '1.5x damage if enemy at full HP OR below 20% HP.', type: 'Melee', damageMin: 20, damageMax: 30, maxUses: 5, special: { type: 'judgementCut', conditionalMultiplier: 1.5, cooldown: 2 } },
    ],
  },
  storyfell_chara: {
    id: 'storyfell_chara', name: 'Storyfell Chara',
    description: '"please stop oversexualizing us..."',
    hp: 185, atk: 18, def: 15, type: 'Magic/Unique',
    passive: { name: 'Ruthless Judgement', description: 'If enemy has any status effect: 1.2x damage. Cannot be stunned while above 50% HP.', type: 'ruthlessJudgement', multiplier: 1.2 },
    abilities: [
      { name: 'Knife Rushdown', description: '2-6 hits. Every hit beyond 3rd: +3 bonus damage on final hit.', type: 'Melee', damageMin: 3, damageMax: 7, maxUses: 20, special: { type: 'knifeRushdown', minHits: 2, maxHits: 6, bonusThreshold: 3, bonusPerHit: 3 } },
      { name: 'Fiery Chaos Busters', description: '50% chance Burn 2 turns.', type: 'Fire', damageMin: 14, damageMax: 18, maxUses: 15, special: { type: 'burn', chance: 0.5, duration: 2 } },
      { name: 'Vine Overgrowth', description: '20% stun 2 turns, 30% Bleed 2 turns.', type: 'Unique', damageMin: 16, damageMax: 20, maxUses: 10, special: { type: 'vineOvergrowth', stunChance: 0.2, stunDuration: 2, bleedChance: 0.3, bleedDuration: 2 } },
      { name: 'Hellfire Finale', description: 'On KO: restore 20 HP. If survives: guaranteed Burn 2 turns.', type: 'Fire', damageMin: 23, damageMax: 32, maxUses: 5, special: { type: 'hellfireFinale', healOnKill: 20, guaranteedBurnDuration: 2, cooldown: 2 } },
    ],
  },
  call_of_the_void_sans: {
    id: 'call_of_the_void_sans', name: 'Call of the Void Sans',
    description: '"i\'m not letting you go any further. no matter what it takes."',
    hp: 190, atk: 18, def: 16, type: 'Magic/Unique',
    passive: { name: 'Everything it takes to end you.', description: 'After turn 3: -5% enemy max HP/turn (max 40%). Hits >25% Sans HP: damage negated, +30 HP (3 triggers max). Above 50% HP: +15% accuracy.', type: 'voidExtractor' },
    abilities: [
      { name: 'Bone Surge', description: 'If enemy uses damaging move, +10 fixed damage from blue bones.', type: 'Bone', damageMin: 14, damageMax: 19, maxUses: 20, special: { type: 'boneSurge', bonusVsAttack: 10 } },
      { name: 'Inverse Gravity Blast', description: '25% chance: -20% enemy crit chance and accuracy next turn.', type: 'Magic', damageMin: 17, damageMax: 22, maxUses: 15, special: { type: 'inverseGravity', critDebuff: 0.2, accDebuff: 0.2, debuffChance: 0.25 } },
      { name: 'System Sabotage', description: '50% chance opponent locked from damaging/healing moves next turn.', type: 'Unique', damageMin: 25, damageMax: 25, maxUses: 5, special: { type: 'systemSabotage', lockChance: 0.5, cooldown: 1 } },
      { name: 'Maximum Extraction', description: 'Sans channels magic into the DT Extractor. Deals +2 dmg per turn elapsed (max +10). On kill: restores all uses for other abilities. Cooldown 2.', type: 'Unique', damageMin: 27, damageMax: 32, maxUses: 5, special: { type: 'maximumExtraction', bonusPerTurn: 2, maxBonus: 10, cooldown: 2 } },
    ],
  },
  swapfell_papyrus: {
    id: 'swapfell_papyrus', name: 'Swapfell Papyrus',
    description: '"Human. Don\'t you know how to treat your new pal? Just hand over your filthy wad of money, that\'s all it takes!"',
    hp: 165, atk: 16, def: 16, type: 'Bone/Unique',
    passive: { name: 'Smoke Screen', description: 'Each attack 50% chance to apply 1 Hazy stack (-10% accuracy/stack, max 5). 1-turn cooldown after applying. Permanent unless cleared, or 2 turns after hitting cap.', type: 'smokeScreen' },
    abilities: [
      { name: 'Boné Wave', description: 'If enemy already Hazy: 25% chance Bleed 2 turns.', type: 'Bone', damageMin: 18, damageMax: 24, maxUses: 20, special: { type: 'boneWave', hazyBleedChance: 0.25, bleedDuration: 2 } },
      { name: 'Bone Storm', description: '5-10 hits. Each hit 5% chance Blindness 1 turn.', type: 'Bone', damageMin: 3, damageMax: 5, maxUses: 15, special: { type: 'boneStorm', minHits: 5, maxHits: 10, blindPerHit: 0.05, blindDuration: 1 } },
      { name: 'Soul Slam', description: '20% flinch. If passive at 5 stacks (50%): forces enemy switch.', type: 'Unique', damageMin: 22, damageMax: 28, maxUses: 10, special: { type: 'soulSlam', flinchChance: 0.20, capStacks: 5, forceSwitchOnCap: true } },
      { name: 'Smoky Counter', description: 'Next turn: dodge any attack and counter for 30 fixed dmg, +1 Hazy stack (ignores cooldown).', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'smokyCounter', counterDamage: 30, cooldown: 1 } },
    ],
  },
  hardmode_sans: {
    id: 'hardmode_sans', name: 'Hardmode Sans',
    description: '"I have finally lost my patience in you turning good. Stay right there.... Let\'s see how much \'fun\' you have this time.... You deserve no mercy"',
    hp: 180, atk: 17, def: 15, type: 'Bone/Magic',
    passive: { name: 'Weight of Guilt', description: 'Healing items used by the opponent only heal 50% of their usual value while Hardmode Sans is active.', type: 'weightOfGuilt' },
    abilities: [
      { name: 'Bone Sweep', description: 'If hits, opponent\'s next attack deals 5 less damage.', type: 'Bone', damageMin: 12, damageMax: 16, maxUses: 20, special: { type: 'boneSweep', damageReduce: 5 } },
      { name: 'Blaster Circle', description: '2-6 hits. 4+ hits = -1 enemy DEF. 50% chance Poison 2 turns.', type: 'Unique', damageMin: 5, damageMax: 7, maxUses: 15, special: { type: 'blasterCircle', minHits: 2, maxHits: 6, defReduceThreshold: 4, defReduceAmount: 1, poisonChance: 0.5, poisonDuration: 2 } },
      { name: 'Blue Soul Control', description: '50% chance next turn opponent restricted to first 2 moves only.', type: 'Unique', damageMin: 18, damageMax: 22, maxUses: 10, special: { type: 'blueSoulControl', restrictChance: 0.5 } },
      { name: 'Final Gambit', description: 'If reduces enemy below 25% HP, enemy must skip attack/use status next turn.', type: 'Unique', damageMin: 25, damageMax: 30, maxUses: 5, special: { type: 'finalGambit', hpThreshold: 0.25, cooldown: 1 } },
    ],
  },
  dustfell_sans: {
    id: 'dustfell_sans', name: 'Dustfell Sans',
    description: '"Smells like ashes doesn\'t it kid? not in the mood to talk? me neither... (im out of wine.).. lets finish this."',
    hp: 165, atk: 15, def: 20, type: 'Bone/Magic',
    passive: { name: 'Sadistic Persistence', description: 'Each damage = 1 Madness stack. Every 2 stacks: ATK+2/DEF-1 (caps at 10). Above 5 stacks: interrupt enemy heals for 20 dmg, consume 3 stacks.', type: 'sadisticPersistence' },
    abilities: [
      { name: 'Chain Strangle', description: '15% chance -2 enemy DEF, 25% stun.', type: 'Melee', damageMin: 14, damageMax: 18, maxUses: 20, special: { type: 'chainStrangle', defDebuffChance: 0.15, defDebuffAmount: 2, stunChance: 0.25 } },
      { name: 'Cruel Blasters', description: '25% chance -2 enemy ATK. If enemy <50% HP: gain 2 Madness instead of 1, -1 enemy DEF.', type: 'Unique', damageMin: 16, damageMax: 21, maxUses: 20, special: { type: 'cruelBlasters', atkDebuffChance: 0.25, atkDebuffAmount: 2, lowHpThreshold: 0.5 } },
      { name: 'Dusty Bonk', description: '25% flinch next turn. If Chain Strangle used last turn: +10 dmg + Bleed 2 turns.', type: 'Melee', damageMin: 18, damageMax: 24, maxUses: 10, special: { type: 'dustyBonk', flinchChance: 0.25, comboBonus: 10, comboBleedDuration: 2 } },
      { name: 'Final Execution', description: 'Requires 7+ Madness stacks. Below 35% HP: 2x dmg. On kill: heal 50% max HP. Consumes ALL stacks, resets stats.', type: 'Unique', damageMin: 26, damageMax: 32, maxUses: 5, special: { type: 'finalExecution', requiredStacks: 7, lowHpThreshold: 0.35, lowHpMultiplier: 2.0, healOnKillPercent: 0.5 } },
    ],
  },
  // --- UPDATE 14 CHARACTERS ---
  catastrophe_fell: {
    id: 'catastrophe_fell', name: 'CATASTROPHE!FELL',
    description: '"If I\'m dying here... YOU ARE COMING WITH ME!"',
    hp: 300, atk: 27, def: 18, type: 'Fire/Magic',
    passive: { name: 'Dying Will', description: 'Active from Lv1. Fell slowly burns himself to death, losing 3 ATK and 2 DEF every 2 turns (stat loss stops at 0).', type: 'dyingWill', alwaysActive: true, atkLoss: 3, defLoss: 2, interval: 2 },
    abilities: [
      { name: 'HELL BLASTER', description: 'A blast of pure hellfire. Applies Burn and Poison.', type: 'Fire', damageMin: 14, damageMax: 27, maxUses: 15, special: { type: 'hellBlaster' } },
      { name: 'Chained Blaster', description: 'Fell chains a blaster and slams it into the ground, hitting twice. Applies Poison and 15% chance to Stun.', type: 'Magic', damageMin: 12, damageMax: 25, maxUses: 15, special: { type: 'chainedBlaster', stunChance: 0.15 } },
      { name: 'Chained Bones', description: 'Fell chains up bones and throws them at the enemy. Hits 3-6 times. Applies Bleed.', type: 'Bone', damageMin: 7, damageMax: 13, maxUses: 20, special: { type: 'chainedBones', minHits: 3, maxHits: 6 } },
      { name: 'H E L L N U K E', description: 'Fell becomes enraged and explodes himself alongside the enemy. Deals 125 damage to both. Applies Burn. 100 turn cooldown.', type: 'Fire', damageMin: 125, damageMax: 125, maxUses: 5, special: { type: 'firenuke', selfDamage: 125, cooldown: 100 } },
    ],
  },
  // --- UPDATE 15 CHARACTERS ---
  tears_in_the_rain_sans: {
    id: 'tears_in_the_rain_sans', name: 'Tears in the Rain Sans',
    description: '"i got no words for you."',
    hp: 160, atk: 15, def: 17, type: 'Bone/Magic',
    passive: { name: 'Heavy Rain', description: 'Every 2 turns, enemy accuracy is lowered by 35% for 1 turn and they cannot crit.', type: 'heavyRain', interval: 2, accReduction: 0.35 },
    abilities: [
      { name: 'Rainfall Bones', description: 'Bones pour from the sky like raindrops. If Sans is attacked next turn, attacker is inflicted with Karma for 1 turn.', type: 'Bone', damageMin: 18, damageMax: 25, maxUses: 20, special: { type: 'rainfallBones' } },
      { name: 'Sorrow Tears', description: 'Lowers enemy accuracy by 25% for 2 turns and grants Sans +2 DEF for 2 turns.', type: 'Magic', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'sorrowTears', accReduction: 0.25, defBoost: 2, duration: 2, cooldown: 3 } },
      { name: 'Echoing Blasters', description: 'Two blasters lock onto the enemy. If Heavy Rain is active, deals an extra fixed 15 damage echo.', type: 'Magic', damageMin: 25, damageMax: 39, maxUses: 15, special: { type: 'echoingBlasters', echoDamage: 15 } },
      { name: 'Rain Overflow', description: 'For every 8 turns elapsed in this battle, +16 fixed damage (max +96). Inflicts 2 Stun status effects on the enemy.', type: 'Magic', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'rainOverflow', perInterval: 8, perBonus: 16, maxBonus: 96, cooldown: 5 } },
    ],
  },
  flame_eye: {
    id: 'flame_eye', name: 'Flame Eye',
    description: '"The limit is broken... I have made it past where no one has ever dared to go to... are you proud, paps..?"',
    hp: 210, atk: 24, def: 21, type: 'Magic',
    passive: { name: 'ABSOLUTE LIMIT BREAKER', description: 'Every 3 turns, heals 30 HP and gains +15 max HP (cap +45 max HP).', type: 'absoluteLimitBreaker', interval: 3, healAmount: 30, hpGain: 15, maxBonus: 45 },
    abilities: [
      { name: 'HELL BLASTERS', description: 'Summons blasters bursting in flames. Inflicts Burn for 2 turns, 35% chance for Hellfire instead.', type: 'Magic', damageMin: 20, damageMax: 27, maxUses: 20, special: { type: 'flameEyeBurn', hellfireChance: 0.35 } },
      { name: 'BONES OF HELL', description: 'Summons blasters bursting in flames. Hits 2 times and inflicts Burn for 2 turns, 35% chance for Hellfire instead.', type: 'Bone', damageMin: 11, damageMax: 19, maxUses: 15, special: { type: 'flameEyeBurn', hellfireChance: 0.35, hits: 2 } },
      { name: 'PERFECT SAVE', description: 'Saves current ATK/DEF. Can be reused to reset stats and heal 45 HP. 2 turn cooldown.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'perfectSave', healAmount: 45, cooldown: 2 } },
      { name: 'ROAR', description: 'Charges 1 turn (-4 DEF while charging), then releases a devastating roar. Bypasses 15% DEF and inflicts Blindness for 4 turns. 6 turn cooldown.', type: 'Magic', damageMin: 65, damageMax: 65, maxUses: 5, special: { type: 'flameEyeRoar', chargeMessage: 'is charging up a devastating **ROAR**... DEF -4!', selfDebuff: { atk: 0, def: -4 }, blindnessDuration: 4, defBypass: 0.15, cooldown: 6 } },
    ],
  },
  galaxy_sans: {
    id: 'galaxy_sans', isEventChar: true, name: 'Galaxy Sans',
    description: '"You know pal. People say the space is beautiful. Yet they don\'t know how dangerous things are behind that. Its like... A wolf in sheep\'s clothing. If you know what i mean."',
    hp: 310, atk: 21, def: 17, type: 'Galactic/Magic',
    passive: { name: 'Galactic Protection', description: '50% chance to reflect 30% of damage taken back at the attacker.', type: 'galacticProtection', chance: 0.5, reflectPercent: 0.3 },
    abilities: [
      { name: 'Cosmic Destruction', description: 'Summons a small blackhole that sucks the enemy in and explodes. 30% chance to stun.', type: 'Magic', damageMin: 12, damageMax: 16, maxUses: 20, special: { type: 'stun', chance: 0.3 } },
      { name: 'Comet Shower', description: 'Galaxy involves his fists in comets and beats the enemy. 40% chance to apply Bleed.', type: 'Melee', damageMin: 13, damageMax: 15, maxUses: 15, special: { type: 'bleed', chance: 0.4 } },
      { name: 'Otherworldly Blasters', description: 'Summons 3 blasters that throw stars at the enemy. Inflicts Bleed for 2 turns.', type: 'Magic', damageMin: 15, damageMax: 18, maxUses: 10, special: { type: 'bleed', chance: 1.0, duration: 2 } },
      { name: 'SIRIUS', description: 'Galaxy makes an oversized star and EXPLODES it on the enemy. Inflicts Blindness for 3 turns. 3 turn cooldown.', type: 'Unique', damageMin: 50, damageMax: 50, maxUses: 5, special: { type: 'blindness', chance: 1.0, duration: 3, cooldown: 3 } },
    ],
  },
  dustswap_papyrus: {
    id: 'dustswap_papyrus', name: 'Dustswap Papyrus',
    description: 'The whimsical alternate timeline of Swap and Storyshift.',
    hp: 220, atk: 17, def: 20, type: 'Bone/Magic',
    passive: { name: 'All Just a Game', description: 'Immune to Karma and Blindness — he knows how they work.', type: 'allJustAGame' },
    abilities: [
      { name: 'Broken Trust', description: 'Fires two blasters. 30% chance to apply Karma.', type: 'Magic', damageMin: 15, damageMax: 20, maxUses: 20, special: { type: 'karma', chance: 0.3 } },
      { name: "The Hero's Magic", description: 'Applies Electrified for 2 rounds.', type: 'Magic', damageMin: 25, damageMax: 25, maxUses: 15, special: { type: 'electrified', chance: 1.0, duration: 2 } },
      { name: "The King's Magic", description: 'Applies Burn and has a 15% chance to stun.', type: 'Fire', damageMin: 10, damageMax: 15, maxUses: 15, special: { type: 'burn', chance: 1.0, stunChance: 0.15 } },
      { name: 'Sneak Attack', description: 'Applies Karma for 2 rounds. 3 turn cooldown.', type: 'Bone', damageMin: 20, damageMax: 20, maxUses: 15, special: { type: 'karma', chance: 1.0, duration: 2, cooldown: 3 } },
    ],
  },
  dustshift: {
    id: 'dustshift', name: 'Dustshift',
    description: 'Born from the worst of Dustswap and Storyshift.',
    hp: 200, atk: 22, def: 19, type: 'Weapon/Magic',
    passive: { name: 'HATE', description: 'Every 3 rounds, Dustshift gains +3 ATK in exchange for -2 DEF that turn only. Resets after the round ends.', type: 'hate', interval: 3, atkBoost: 3, defLoss: 2 },
    abilities: [
      { name: 'Knife Throw', description: 'A precise knife throw. Applies Bleed.', type: 'Weapon', damageMin: 15, damageMax: 20, maxUses: 20, special: { type: 'bleed', chance: 1.0 } },
      { name: 'Get Over Here', description: '25% chance to stun.', type: 'Melee', damageMin: 25, damageMax: 25, maxUses: 15, special: { type: 'stun', chance: 0.25 } },
      { name: "Mother's Teaching", description: 'Applies Burn.', type: 'Fire', damageMin: 30, damageMax: 30, maxUses: 10, special: { type: 'burn', chance: 1.0 } },
      { name: 'Item', description: 'Heals 35 HP. 3 turn cooldown.', type: 'Food', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'heal', amount: 35, cooldown: 3 } },
    ],
  },
  rk_swap_papyrus: {
    id: 'rk_swap_papyrus', name: 'RK!Swap Papyrus',
    description: 'Recalled Knowledge. He remembers everything.',
    hp: 200, atk: 19, def: 18, type: 'Magic/Bone',
    passive: { name: 'Face Me Head On', description: 'In a PvP battle the opponent cannot switch their character.', type: 'faceMeHeadOn' },
    abilities: [
      { name: 'Welp That was A Blast', description: 'Applies Orange Soul for 2 rounds.', type: 'Magic', damageMin: 30, damageMax: 35, maxUses: 20, special: { type: 'orangeSoul', chance: 1.0, duration: 2 } },
      { name: 'Bone Zone', description: 'Applies Orange Soul for 1 round and a chance to apply Karma.', type: 'Bone', damageMin: 25, damageMax: 30, maxUses: 25, special: { type: 'rkBoneZone', orangeChance: 1.0, orangeDuration: 1, karmaChance: 0.35 } },
      { name: 'Watch Your Head', description: 'Throws two bone shards at the enemy. Applies Orange Soul.', type: 'Bone', damageMin: 20, damageMax: 25, maxUses: 15, special: { type: 'orangeSoul', chance: 1.0, duration: 2 } },
      { name: 'Real Honey', description: 'Heals 25 HP. 3 turn cooldown.', type: 'Food', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'heal', amount: 25, cooldown: 3 } },
    ],
  },
  rk_storyshift_chara: {
    id: 'rk_storyshift_chara', name: 'RK!Storyshift Chara',
    description: 'Recalled Knowledge. They remember every cut.',
    hp: 150, atk: 23, def: 17, type: 'Unique/Weapon',
    passive: { name: 'Face Me Head On', description: 'In a PvP battle the opponent cannot switch their character.', type: 'faceMeHeadOn' },
    abilities: [
      { name: 'Knife Slash', description: 'Applies Bleed for 1 round.', type: 'Weapon', damageMin: 20, damageMax: 20, maxUses: 20, special: { type: 'bleed', chance: 1.0, duration: 1 } },
      { name: 'Vines', description: 'Applies Bleed for 1 round and 30% chance to stun.', type: 'Magic', damageMin: 20, damageMax: 25, maxUses: 25, special: { type: 'bleedAndStun', bleedChance: 1.0, bleedDuration: 1, stunChance: 0.3 } },
      { name: 'Memories', description: 'Throws three fireballs. Applies Burn for 2 rounds.', type: 'Fire', damageMin: 10, damageMax: 15, maxUses: 20, special: { type: 'multiHit', minHits: 3, maxHits: 3, burnChance: 1.0, burnDuration: 2 } },
      { name: 'Shield', description: 'If the enemy hits you while this is active, they get stunned.', type: 'Weapon', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'rkShield' } },
    ],
  },
  ts_sans: {
    id: 'ts_sans', name: 'TS!Underswap Sans (Crossbones)',
    description: '"you\'re the bad guy. cause, believe it or not, your existence is a crime"',
    hp: 145, atk: 16, def: 15, type: 'Bone/Food',
    passive: { name: 'Justice Served', description: 'Every time Sans successfully lands a Food attack, his ATK increases by +1 (Stacks up to 10).', type: 'justiceServed', maxStacks: 10 },
    abilities: [
      { name: 'Ketchup Blaster', description: '10% chance to "Blind" the opponent (unable to attack the next turn).', type: 'Food', damageMin: 10, damageMax: 15, maxUses: 20, special: { type: 'ketchupBlaster', blindChance: 0.10 } },
      { name: 'Bone Chasers', description: '25% chance to inflict Blue Soul (disables enemy passive for 2 turns). Cannot stack and cannot be applied right after it ends.', type: 'Bone', damageMin: 12, damageMax: 18, maxUses: 15, special: { type: 'tsBlueSoul', chance: 0.25, duration: 2 } },
      { name: 'Spicy Mustard Splash', description: 'Douses the opponent in extra-spicy mustard. Applies Poison for 2 turns (not stackable). 1 turn cooldown.', type: 'Food', damageMin: 16, damageMax: 22, maxUses: 12, special: { type: 'poison', chance: 1.0, duration: 2, cooldown: 1 } },
      { name: 'POW', description: '25% chance to stun the enemy. 1 turn cooldown.', type: 'Melee', damageMin: 20, damageMax: 24, maxUses: 5, special: { type: 'stun', chance: 0.25, cooldown: 1 } },
    ],
  },
  ts_papyrus: {
    id: 'ts_papyrus', name: 'TS!Papyrus',
    description: 'A new Papyrus born from a Team Switch.',
    hp: 200, atk: 20, def: 18, type: 'Magic/Bone',
    passive: { name: 'Thermal Immunity', description: 'Temperature-based effects (Burn, Hellfire, fire-related Stun) don\'t affect TS!Papyrus.', type: 'thermalImmunity' },
    abilities: [
      { name: 'The Annoying Dog', description: 'Applies Bleed for 2 rounds and has a 20% chance to stun.', type: 'Weapon', damageMin: 20, damageMax: 25, maxUses: 25, special: { type: 'bleedAndStun', bleedChance: 1.0, bleedDuration: 2, stunChance: 0.2 } },
      { name: 'Gaster Blaster', description: 'Applies Karma for 2 rounds.', type: 'Magic', damageMin: 20, damageMax: 30, maxUses: 20, special: { type: 'karma', chance: 1.0, duration: 2 } },
      { name: 'Random Bones', description: 'Fires three bones — White (damage), Blue (-1 DEF), Orange (-1 ATK).', type: 'Bone', damageMin: 15, damageMax: 20, maxUses: 15, special: { type: 'randomBones' } },
      { name: 'Bone Zone', description: 'Applies Karma for 2 rounds.', type: 'Bone', damageMin: 10, damageMax: 15, maxUses: 30, special: { type: 'karma', chance: 1.0, duration: 2 } },
    ],
  },
  fallen_stars_char: {
    id: 'fallen_stars_char', isEventChar: true, name: 'Fallen Stars',
    description: '"I am beyond the stars. The cosmic dust was waiting. BlackHoles collide, ah."',
    hp: 300, atk: 27, def: 23, type: 'Galactic/Unique',
    passive: { name: 'StarDust', description: 'Immune to status effects and debuffs. If a multi-hit is attempted, the attacker is NOT disabled — but StarDust still blocks the extra hits.', type: 'starDust' },
    abilities: [
      { name: 'Gravity Slam', description: 'Punch + slam combo. Chance to apply high gravity (better stun).', type: 'Unique', damageMin: 11, damageMax: 24, maxUses: 15, special: { type: 'highGravity', chance: 0.4 } },
      { name: 'Celestial Bones', description: 'Bones explode on impact. Applies Blindness for 2 turns.', type: 'Bone', damageMin: 13, damageMax: 27, maxUses: 10, special: { type: 'blindness', chance: 1.0, duration: 2 } },
      { name: 'Cosmic Blasters', description: 'Blasters with cosmic energy. Chance for KR effect.', type: 'Magic', damageMin: 11, damageMax: 21, maxUses: 25, special: { type: 'krChance', chance: 0.35 } },
      { name: 'Star Rain', description: 'A rain of stars. Can only be used ONCE after 20 turns.', type: 'Unique', damageMin: 125, damageMax: 125, maxUses: 5, special: { type: 'starRain', minTurn: 20 } },
    ],
  },
  the_outering_one: {
    id: 'the_outering_one', isEventChar: true, name: 'The Outering One',
    description: '"i alone... am the outering one."',
    hp: 350, atk: 26, def: 12, type: 'Galactic/Unique',
    passive: { name: 'Cosmic Healing', description: 'Heals 10 HP at the start of each turn.', type: 'cosmicHealing', healAmount: 10 },
    abilities: [
      { name: 'Space Control: BlackHole', description: 'A blackhole tears at the enemy.', type: 'Magic', damageMin: 21, damageMax: 27, maxUses: 25, special: null },
      { name: 'Space Technique: Gamma ray', description: 'A piercing gamma ray.', type: 'Magic', damageMin: 11, damageMax: 22, maxUses: 25, special: null },
      { name: 'Domain Expansion. COSMIC.', description: 'Stuns the enemy for 3 turns. When it ends, you get stunned for 3 turns.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'domainExpansion', stunDuration: 3, selfStunDuration: 3 } },
      { name: 'OUTER TECHNIQUE. NOVA.', description: 'Devastating cosmic blast — but has a big chance to miss.', type: 'Unique', damageMin: 100, damageMax: 100, maxUses: 5, special: { type: 'outerNova', missChance: 0.6 } },
    ],
  },

  // --- UPDATE 15 CHARACTERS ---
  frisk: {
    id: 'frisk', name: 'Frisk',
    description: 'The fallen human. Fights with determination — and mercy.',
    hp: 115, atk: 10, def: 8, type: 'Melee/Unique',
    passive: { name: 'Determination', description: 'Once per battle, survive a fatal hit at 1 HP.', type: 'determination', used: false },
    abilities: [
      { name: 'FIGHT', description: 'A basic attack. 25% chance to apply Bleed for 1 turn.', type: 'Melee', damageMin: 12, damageMax: 18, maxUses: 25, special: { type: 'bleed', chance: 0.25, duration: 1 } },
      { name: 'ACT', description: 'Random: 20% chance to spare enemy, +6 DEF next turn, or heavy hit +5.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'friskAct' } },
      { name: 'ITEM', description: 'Use a food item from Frisk\'s supply. Opens a food picker.', type: 'Food', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'friskItem', requiresPicker: 'friskItem' } },
      { name: 'MERCY', description: 'Attempt to spare the enemy. If enemy HP < 100, 100% spare chance. Adds 20% to mercy meter.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'friskMercy' } },
    ],
  },
  chara: {
    id: 'chara', name: 'Chara',
    description: '"hee hee hee i am chara the evils"',
    hp: 144, atk: 14, def: 14, type: 'Melee/Unique',
    passive: { name: 'The Demon', description: 'At 25% HP: +2 ATK and +2 DEF.', type: 'charaPassive', triggered: false },
    abilities: [
      { name: 'Knife Stab', description: 'A quick stab. 25% chance to apply Bleed for 2 turns.', type: 'Melee', damageMin: 14, damageMax: 20, maxUses: 20, special: { type: 'bleed', chance: 0.25, duration: 2 } },
      { name: 'Slash Barrage', description: '2-5 hits. If all 5 hit: guaranteed crit + Bleed.', type: 'Melee', damageMin: 6, damageMax: 10, maxUses: 15, special: { type: 'slashBarrage', minHits: 2, maxHits: 5 } },
      { name: 'Chocolate', description: 'Heals 30 HP.', type: 'Food', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'heal', amount: 30 } },
      { name: 'ERASE', description: '17-28 damage. Shows 9999... flavor text. Kill = cooldown -1. No kill = Bleed.', type: 'Unique', damageMin: 17, damageMax: 28, maxUses: 5, special: { type: 'charaErase', cooldown: 1 }, displayDamage: '9999...' },
    ],
  },
  no_more_deals_chara: {
    id: 'no_more_deals_chara', name: 'No More Deals Chara',
    description: 'The deal is done.',
    hp: 166, atk: 16, def: 16, type: 'Melee/Unique',
    passive: { name: 'Lethal Grudge', description: 'vs Killer Sans: +2 ATK, +3 DEF, +34 max HP.', type: 'lethalGrudge' },
    abilities: [
      { name: 'Knife Slash', description: '40% chance to apply Bleed.', type: 'Melee', damageMin: 15, damageMax: 22, maxUses: 20, special: { type: 'bleed', chance: 0.4 } },
      { name: 'Knife Surround', description: '2-6 hits. 20%/hit extends Bleed.', type: 'Melee', damageMin: 5, damageMax: 9, maxUses: 15, special: { type: 'knifeRushdown', minHits: 2, maxHits: 6, bonusThreshold: 3, bonusPerHit: 0 } },
      { name: 'Golden Flower Pellets', description: '35% chance to Poison for 2 turns.', type: 'Unique', damageMin: 14, damageMax: 20, maxUses: 10, special: { type: 'poison', chance: 0.35, duration: 2 } },
      { name: 'A Lethal Deal', description: '1.25x damage if enemy below 40% HP. KO = +2 ATK (max 2 stacks).', type: 'Unique', damageMin: 18, damageMax: 26, maxUses: 5, special: { type: 'lethalDeal', hpThreshold: 0.4, multiplier: 1.25, cooldown: 1 } },
    ],
  },
  core_frisk: {
    id: 'core_frisk', name: 'Core Frisk',
    description: 'Lost in the CORE.',
    hp: 222, atk: 22, def: 22, type: 'Unique',
    hideStats: true,
    passive: { name: 'Emptiness', description: '15% chance on each attack to apply Voided to enemy (5 dmg/turn, 25% absorb incoming attacks).', type: 'emptiness', chance: 0.15 },
    abilities: [
      { name: 'Void Stick', description: '30% chance to apply Bleed for 1 turn.', type: 'Unique', damageMin: 15, damageMax: 22, maxUses: 20, special: { type: 'bleed', chance: 0.3, duration: 1 } },
      { name: 'Void Eyes', description: '2-4 hits. 15% lifesteal (25% of damage).', type: 'Unique', damageMin: 8, damageMax: 13, maxUses: 15, special: { type: 'multiHit', minHits: 2, maxHits: 4, lifesteal: 0.25 } },
      { name: 'Omnipresence', description: 'Deal damage and vanish for 1 turn (negate all damage). 2 turn cooldown.', type: 'Unique', damageMin: 18, damageMax: 25, maxUses: 8, special: { type: 'teleport', dodgeThisTurn: true, critBoost: 0, cooldown: 2 } },
      { name: 'All Anti Seeing Flash', description: 'Applies Blindness for 2 turns.', type: 'Unique', damageMin: 14, damageMax: 20, maxUses: 5, special: { type: 'blindness', chance: 1.0, duration: 2 } },
    ],
  },
  kris: {
    id: 'kris', name: 'Kris',
    description: '"Don\'t forget. You\'re the one with the controller."',
    hp: 170, atk: 18, def: 17, type: 'Melee/Unique',
    isChild: true,
    passive: { name: 'insert', description: 'Each Unique move used: +10% crit on next Melee (max 30%).', type: 'krisPassive' },
    abilities: [
      { name: 'Slash', description: '12-15 dmg. +5 if HP > 50%.', type: 'Melee', damageMin: 12, damageMax: 15, maxUses: 20, special: { type: 'krisSlash', hpBonus: 5, hpThreshold: 0.5 } },
      { name: 'X-Slash', description: '2 hits. 20% Bleed, 10% DEF -1.', type: 'Melee', damageMin: 8, damageMax: 12, maxUses: 15, special: { type: 'multiHit', minHits: 2, maxHits: 2, bleedChance: 0.2, defDebuffChance: 0.1, defDebuffAmount: 1 } },
      { name: 'Courage', description: '+2 DEF for 2 turns. 3 turn cooldown.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'debuff', stat: 'def', amount: 2, target: 'self', cooldown: 3 } },
      { name: 'Spare', description: 'Enemy ATK -1. 20% chance -2 instead. 1 turn cooldown.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 8, special: { type: 'krisSpare', cooldown: 1 } },
    ],
  },
  susie: {
    id: 'susie', name: 'Susie',
    description: '"I\'ll take the lead."',
    hp: 190, atk: 18, def: 15, type: 'Melee/Weapon',
    isChild: true,
    passive: { name: 'I\'ll take the lead', description: '15% chance to ignore 10% DEF. If first in team: allies +1 ATK on Melee/Weapon.', type: 'susiePassive' },
    abilities: [
      { name: 'Axe Slash', description: '5% chance DEF -1.', type: 'Melee', damageMin: 15, damageMax: 22, maxUses: 20, special: { type: 'debuff', stat: 'def', amount: -1, target: 'enemy', chance: 0.05 } },
      { name: 'Crunch', description: '25% chance to disable enemy last move. Crit = heal 10 HP.', type: 'Melee', damageMin: 16, damageMax: 23, maxUses: 15, special: { type: 'suzieCrunch', disableChance: 0.25 } },
      { name: 'Ultimate Heal', description: 'Heals 20 HP.', type: 'Food', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'heal', amount: 20 } },
      { name: 'Rude Buster', description: '20-25 dmg. 10% bonus from pool. 1 turn cooldown.', type: 'Unique', damageMin: 20, damageMax: 25, maxUses: 5, special: { type: 'rudeBuster', cooldown: 1 } },
    ],
  },
  ralsei: {
    id: 'ralsei', name: 'Ralsei',
    description: 'Fluffy boy.',
    hp: 180, atk: 19, def: 15, type: 'Fire/Unique',
    isChild: true,
    passive: { name: 'Tension', description: 'Start of battle: +3 DEF turn 1. Unique move = +1 Tension stack. At 3 stacks: next move auto-heals 15 HP.', type: 'ralseiTension' },
    abilities: [
      { name: 'Scarf Smack', description: '20% chance enemy ATK -1 next turn.', type: 'Melee', damageMin: 12, damageMax: 18, maxUses: 20, special: { type: 'tempDebuff', stat: 'atk', amount: -1, target: 'enemy', duration: 1, chance: 0.2 } },
      { name: 'Burn Out', description: 'Guaranteed Burn 2 turns. 10% chance Hellfire instead. Uses 1 Tension.', type: 'Fire', damageMin: 14, damageMax: 20, maxUses: 15, special: { type: 'ralseiburn' } },
      { name: 'Heal Prayer', description: 'Heal self (15 HP) or ally (20 HP). Below 25% HP: +10 bonus. Opens target picker. 1 turn cooldown.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 8, special: { type: 'healPrayer', requiresPicker: 'healPrayer', cooldown: 1 } },
      { name: 'Comically Large Blunt', description: '30 fixed dmg. Relaxed for 2 turns. Costs 2 Tension. 4 turn cooldown.', type: 'Unique', damageMin: 30, damageMax: 30, maxUses: 3, special: { type: 'comicallyLargeBlunt', cooldown: 4 } },
    ],
  },
  rose: {
    id: 'rose', name: 'Rose',
    description: 'wgat.',
    hp: 185, atk: 20, def: 20, type: 'Unique',
    passive: { name: 'Kindness Guardian', description: '15% chance to block any attack and counter for 12 fixed damage.', type: 'kindnessGuardian', chance: 0.15, counterDamage: 12 },
    abilities: [
      { name: 'Kindness Blade', description: '40% chance Bleed for 2 turns.', type: 'Unique', damageMin: 16, damageMax: 22, maxUses: 20, special: { type: 'bleed', chance: 0.4, duration: 2 } },
      { name: 'Sincerity', description: '2-6 hits. 25%/hit extends Bleed.', type: 'Unique', damageMin: 5, damageMax: 9, maxUses: 15, special: { type: 'multiHit', minHits: 2, maxHits: 6 } },
      { name: 'Aura Blast', description: '50% chance Bleed for 2 turns. 1 turn cooldown.', type: 'Unique', damageMin: 18, damageMax: 25, maxUses: 10, special: { type: 'bleed', chance: 0.5, duration: 2, cooldown: 1 } },
      { name: 'Assistance', description: 'Uses a random move from the highest C!Insanity form on your team. 1 turn cooldown.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 8, special: { type: 'roseAssistance', cooldown: 1 } },
    ],
  },
  clover: {
    id: 'clover', name: 'Clover',
    description: 'A justice-themed cowboy.',
    hp: 160, atk: 15, def: 13, type: 'Melee/Unique',
    isChild: true,
    passive: { name: 'Reload', description: '6 ammo. Out of ammo: moves 2/3 locked, reload 2 turns, move 1 +5 dmg.', type: 'cloverAmmo', ammo: 6 },
    abilities: [
      { name: 'Gun Swing', description: '5% stun. +5 if reloading.', type: 'Melee', damageMin: 12, damageMax: 17, maxUses: 25, special: { type: 'stun', chance: 0.05 } },
      { name: 'Pew Pew', description: '2-4 hits. 1 ammo. High crit.', type: 'Unique', damageMin: 7, damageMax: 12, maxUses: 20, special: { type: 'pewPew', minHits: 2, maxHits: 4, critBonus: 0.2 } },
      { name: 'Charged Shot', description: '18 fixed. 2 ammo. Charges 1 turn. 25% +1 ATK or DEF.', type: 'Unique', damageMin: 18, damageMax: 18, maxUses: 10, special: { type: 'charge', chargeMessage: 'is charging **Charged Shot**...', cooldown: 0 } },
      { name: 'Gun Final Flash', description: '23-29 dmg. 40% pierce DEF. 2 turn cooldown.', type: 'Unique', damageMin: 23, damageMax: 29, maxUses: 5, special: { type: 'gunFinalFlash', pierceChance: 0.4, cooldown: 2 } },
    ],
  },
  noelle: {
    id: 'noelle', name: 'Noelle',
    description: 'A timid deer with frost-touched antlers.',
    hp: 160, atk: 15, def: 17, type: 'Unique/Frost',
    isChild: true,
    passive: { name: 'Friendly Support', description: 'Start with 25 HP shield. 50 HP if Kris is in party.', type: 'noelleShield' },
    abilities: [
      { name: 'Frantic Punches', description: '10% chance DEF -1.', type: 'Melee', damageMin: 11, damageMax: 16, maxUses: 20, special: { type: 'debuff', stat: 'def', amount: -1, target: 'enemy', chance: 0.1 } },
      { name: 'Ice Shock', description: 'Prevents flee. Ignores 5% DEF.', type: 'Frost', damageMin: 14, damageMax: 20, maxUses: 15, special: { type: 'iceShock', defIgnore: 0.05 } },
      { name: 'Sleep Mist', description: '-20% accuracy 1 turn. After 5 uses: Sleep 2 turns. 1 turn cooldown.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'sleepMist', cooldown: 1 } },
      { name: 'Heal Prayer', description: 'Heal self (30 HP) or ally. Below 25% HP: 40 HP. 1 turn cooldown.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 6, special: { type: 'noelleHealPrayer', requiresPicker: 'noelleHealPrayer', cooldown: 1 } },
    ],
  },
  noelle_snowgrave: {
    id: 'noelle_snowgrave', name: 'Noelle (Snowgrave)',
    description: '"That\'s not... the... TornRing, is it...?"',
    hp: 222, atk: 22, def: 22, type: 'Frost/Unique',
    isChild: true,
    passive: { name: 'It\'s so cold', description: 'Every Frost hit: +1 ATK, +1 DEF, heal 15 HP.', type: 'snowgravePassive' },
    abilities: [
      { name: 'Thorned Punch', description: '50% Bleed for 1 turn.', type: 'Melee', damageMin: 15, damageMax: 21, maxUses: 20, special: { type: 'bleed', chance: 0.5, duration: 1 } },
      { name: 'Thorn Throw', description: '50% Bleed. Every 2 uses weakens Thorn Ring moves by 2.', type: 'Melee', damageMin: 12, damageMax: 18, maxUses: 15, special: { type: 'bleed', chance: 0.5 } },
      { name: 'Enhanced Ice Shock', description: '18-27 Frost. 50% Frozen 2 turns. 10 uses.', type: 'Frost', damageMin: 18, damageMax: 27, maxUses: 10, special: { type: 'frozen', chance: 0.5, duration: 2 } },
      { name: 'SNOWGRAVE', description: '23-32 Frost. 1 turn windup. Disables enemy heals. 75% Frozen 2 turns. 2 turn cooldown.', type: 'Frost', damageMin: 23, damageMax: 32, maxUses: 5, special: { type: 'charge', chargeMessage: 'is charging **SNOWGRAVE**...', cooldown: 2 } },
    ],
  },
  asgore_dreemurr: {
    id: 'asgore_dreemurr', name: 'Asgore Dreemurr',
    description: '"THE KING HAS HAD A FEW TOO MANY."',
    hp: 220, atk: 20, def: 20, type: 'Fire/Melee',
    passive: { name: 'DRIVING IN MY CAR', description: 'Each turn 15% chance run-over: 20 dmg + stun. 2x dmg to isChild characters.', type: 'drivingInMyCar', chance: 0.15, runoverDamage: 20 },
    abilities: [
      { name: 'Fireballs', description: '4-8 x3 hits. Burn 2 turns.', type: 'Fire', damageMin: 4, damageMax: 8, maxUses: 20, special: { type: 'multiHit', minHits: 3, maxHits: 3, burnChance: 1.0, burnDuration: 2 } },
      { name: 'Fire Circle', description: '20 fixed. Burn 2 turns.', type: 'Fire', damageMin: 20, damageMax: 20, maxUses: 15, special: { type: 'burn', chance: 1.0, duration: 2 } },
      { name: 'Trident Slash', description: '18-23 dmg. 21% Bleed. 30% follow-up fireball +10+Burn. 1 turn cooldown.', type: 'Melee', damageMin: 18, damageMax: 23, maxUses: 10, special: { type: 'tridentSlashDreemurr', bleedChance: 0.21, fireballChance: 0.3, cooldown: 1 } },
      { name: 'Human Beer', description: 'Heals 30 HP. 2 turn cooldown. 6 uses.', type: 'Food', damageMin: 0, damageMax: 0, maxUses: 6, special: { type: 'heal', amount: 30, cooldown: 2 } },
    ],
  },
  togore_dreemurr: {
    id: 'togore_dreemurr', name: 'Torgore Dreemurr',
    description: 'Togoretastic!',
    hp: 200, atk: 20, def: 20, type: 'Unique',
    passive: { name: 'Togoretastic!', description: 'Below 25% HP: +2 ATK, +2 DEF.', type: 'togoreLowHp', triggered: false },
    abilities: [
      { name: 'Punch', description: 'A normal punch.', type: 'Melee', damageMin: 16, damageMax: 21, maxUses: 20, special: null },
      { name: 'Etymology', description: '15-23 dmg. 50% Poison 2 turns.', type: 'Unique', damageMin: 15, damageMax: 23, maxUses: 15, special: { type: 'poison', chance: 0.5, duration: 2 } },
      { name: 'Mortifying Gaze', description: 'DEF -2. 1 turn cooldown.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 8, special: { type: 'debuff', stat: 'def', amount: -2, target: 'enemy', cooldown: 1 } },
      { name: 'Togoretastic Abilities', description: '16-27 dmg. 50% Concussion 2 turns. 1 turn cooldown.', type: 'Unique', damageMin: 16, damageMax: 27, maxUses: 5, special: { type: 'concussion', chance: 0.5, duration: 2, cooldown: 1 } },
    ],
  },
  sans_question: {
    id: 'sans_question', name: 'Sans?',
    description: 'Something\'s off about this Sans...',
    hp: 166, atk: 16, def: 16, type: 'Bone/Unique',
    passive: { name: 'Anomalous?', description: 'Each turn 20% chance to copy enemy\'s last move as Bone type.', type: 'anomalousQ', chance: 0.2 },
    abilities: [
      { name: 'Bone Throw?', description: '15-25 dmg.', type: 'Bone', damageMin: 15, damageMax: 25, maxUses: 20, special: null },
      { name: 'Gaster Blasters?', description: '2 hits. 20% Poison 2 turns.', type: 'Unique', damageMin: 10, damageMax: 16, maxUses: 15, special: { type: 'multiHit', minHits: 2, maxHits: 2, poisonChance: 0.2, poisonDuration: 2 } },
      { name: 'Anomalous Healing', description: 'Heals 35 HP.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'heal', amount: 35 } },
      { name: 'Attack Reflection', description: 'Reflect enemy\'s last damage dealt. 1 turn cooldown.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'attackReflection', cooldown: 1 } },
    ],
  },
  your_fault: {
    id: 'your_fault', name: 'YOUR FAULT',
    description: 'Something corrupts...',
    hp: 200, atk: 20, def: 20, type: 'Bone/Melee',
    passive: { name: 'YOUR FAULT', description: '15% chance to negate incoming attack and reflect full damage.', type: 'yourFaultPassive', chance: 0.15 },
    abilities: [
      { name: 'Exploited Bones', description: '12-20 dmg.', type: 'Bone', damageMin: 12, damageMax: 20, maxUses: 20, special: null },
      { name: 'Blaster Slam', description: '13-22 dmg. 25% Concussion.', type: 'Bone', damageMin: 13, damageMax: 22, maxUses: 15, special: { type: 'concussion', chance: 0.25, duration: 2 } },
      { name: 'YOUR FAULT', description: '16-27 dmg. 50% Blindness 1 turn. 2 turn cooldown.', type: 'Unique', damageMin: 16, damageMax: 27, maxUses: 8, special: { type: 'blindness', chance: 0.5, duration: 1, cooldown: 2 } },
      { name: 'Stolen Slash Barrage', description: '2-7 hits. 15%/hit extends Bleed. 2 turn cooldown.', type: 'Melee', damageMin: 5, damageMax: 10, maxUses: 5, special: { type: 'multiHit', minHits: 2, maxHits: 7, cooldown: 2 } },
    ],
  },
  your_inner_torment: {
    id: 'your_inner_torment', name: 'YOUR INNER TORMENT',
    description: 'STOP HIDING BEHIND THAT VESSEL.',
    hp: 266, atk: 26, def: 26, type: 'Bone/Unique',
    passive: { name: 'STOP HIDING BEHIND THAT VESSEL', description: 'Every 2 hits: +30 HP, -2 ATK, -1 DEF.', type: 'innerTormentPassive', hpGain: 30, atkLoss: 2, defLoss: 1 },
    abilities: [
      { name: 'Double Hand Crush', description: '10-15 x2 hits.', type: 'Bone', damageMin: 10, damageMax: 15, maxUses: 20, special: { type: 'multiHit', minHits: 2, maxHits: 2 } },
      { name: 'Punch Barrage', description: '1-3 sets of 2-7 hits.', type: 'Melee', damageMin: 4, damageMax: 8, maxUses: 15, special: { type: 'multiHit', minHits: 2, maxHits: 7 } },
      { name: 'Sansational Features', description: '2-5 hits. 50/50 Bone or Unique type.', type: 'Unique', damageMin: 6, damageMax: 11, maxUses: 10, special: { type: 'multiHit', minHits: 2, maxHits: 5 } },
      { name: 'Flashbacks', description: '50% Attack Reflection / 35% Slash Barrage buffed / 15% Double Hand Crush+5. 1 turn cooldown.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 8, special: { type: 'flashbacks', cooldown: 1 } },
    ],
  },
  // --- UPDATE 17 CHARACTERS ---
  afterdust_sans: {
    id: 'afterdust_sans', name: 'AfterDust!Sans',
    description: '"Heh...Ended up here where Geno was...but I\'m far stronger now...I shall watch over these useless timelines."',
    hp: 195, atk: 21, def: 23, type: 'Bone/Unique',
    passive: { name: 'Dusty Save', description: 'AfterDust saves his stats at the start of the round. Every 10 turns reverts HP to 35%. Every 5 turns while above 35% HP, gains +30 HP and a 2-turn +2 DEF buff.', type: 'dustySave' },
    abilities: [
      { name: 'Glitched and Dusted Bones', description: 'A barrage of 2-5 bones. 5% chance to summon a Bone Zone dealing 10 Glitched DMG (slows enemy attack for 1 turn). Applies KR for 2 turns.', type: 'Bone', damageMin: 4, damageMax: 8, maxUses: 20, special: { type: 'glitchedDustedBones', minHits: 2, maxHits: 5, boneZoneChance: 0.05, glitchedDmg: 10, krDuration: 2 } },
      { name: 'Blaster Finale', description: 'Blasts the enemy from every direction. 10% chance to summon blaster circles around the enemy for 1 second. Applies KR and Glitched for 1 turn.', type: 'Magic', damageMin: 7, damageMax: 12, maxUses: 15, special: { type: 'blasterFinale', circleChance: 0.10, krDuration: 1, glitchedDuration: 1 } },
      { name: 'Truly a Dusted Being', description: 'AfterDust swings a glitched bone, sending the enemy into a stunned state for 1 turn. 20% chance to swing 2 bones, stunning the enemy for 2 turns instead and dealing 10 DMG. Applies Glitched for 1 turn. 2 turn CD.', type: 'Weapon', damageMin: 10, damageMax: 13, maxUses: 10, special: { type: 'trulyDustedBeing', doubleSwingChance: 0.20, normalStunDuration: 1, doubleSwingStunDuration: 2, doubleSwingBonusDmg: 10, glitchedDuration: 1, cooldown: 2 } },
      { name: 'DUSTY DETERMINATION.', description: '50/50 chance for either 1.3x dmg boost for 3 turns or 2-4 dodge. 5 turn CD.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'dustyDetermination', damageBoost: 1.3, boostDuration: 3, dodgeMin: 2, dodgeMax: 4, cooldown: 5 } },
    ],
  },
  dream_sans: {
    id: 'dream_sans', name: 'Dream Sans',
    description: '"The guardian of positive."',
    hp: 250, atk: 18, def: 18, type: 'Unique/Magic',
    passive: { name: 'Positive', description: 'Dream Sans has two lives — but in the second life he has reduced stats (HP 150, ATK 13, DEF 13).', type: 'positive', secondLifeHp: 150, secondLifeAtk: 13, secondLifeDef: 13 },
    abilities: [
      { name: 'Positive Arrow', description: 'A precise positive arrow.', type: 'Weapon', damageMin: 35, damageMax: 40, maxUses: 25, special: null },
      { name: 'Arrow Barrage', description: 'Shoots out 4-5 arrows, each doing 5-10 damage.', type: 'Weapon', damageMin: 5, damageMax: 10, maxUses: 15, special: { type: 'multiHit', minHits: 4, maxHits: 5 } },
      { name: 'Call for Help', description: 'Calls for help from Ink Sans, Swap Sans, Sans, Fell Sans, or Outer Sans for one of their attacks.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'callForHelp' } },
      { name: 'Positive Apple', description: 'Heals 60 HP over time by giving 15 HP each turn for 4 turns. 4 turn CD.', type: 'Food', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'positiveApple', healPerTurn: 15, duration: 4, cooldown: 4 } },
    ],
    teamAbility: { name: 'Brotherly Love', description: 'With Nightmare Sans on the team — deals 50-100 damage and grants 35 shield points. 6 turn cooldown.', type: 'brotherlyLove', requiresCharacter: 'nightmare_sans', dmgMin: 50, dmgMax: 100, shield: 35, cooldown: 6 },
  },
  nightmare_sans: {
    id: 'nightmare_sans', name: 'Nightmare Sans',
    description: '"The guardian of negative."',
    hp: 250, atk: 18, def: 18, type: 'Weapon/Unique',
    passive: { name: 'ENRAGED/help', description: 'Under 50% HP, becomes ENRAGED — gains +2 ATK but loses 2 DEF. Every 3 turns calls Killer Sans, Horror Sans, or JHall Dust Sans to use one of their attacks. Shiny Star refused — "the shiny star didn\'t work on nightmare sans THE DARKNESS OVERRULES IT".', type: 'enragedHelp', hpThreshold: 0.5, atkBoost: 2, defLoss: 2, callInterval: 4 },
    refuseShiny: true,
    abilities: [
      { name: 'Tentacle Slam', description: 'Does 30-40 damage (55-60 when ENRAGED).', type: 'Melee', damageMin: 30, damageMax: 40, maxUses: 20, special: { type: 'nightmareSlam', enragedMin: 55, enragedMax: 60 } },
      { name: 'Tentacle Barrage', description: '4-5 hits, each doing 5-10 damage. When ENRAGED, 5 hits each doing 10 damage. Disabled while shield is up.', type: 'Melee', damageMin: 5, damageMax: 10, maxUses: 15, special: { type: 'nightmareBarrage', normalMinHits: 4, normalMaxHits: 5, enragedHits: 5, enragedHitDmg: 10 } },
      { name: 'Tentacle Shield', description: 'Gives 90 Shield HP, but disables Tentacle Barrage until shield breaks. 3 turn cooldown.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'tentacleShield', shieldAmount: 90, cooldown: 3 } },
      { name: 'Negative Apple', description: 'Heals Nightmare 50 HP and damages the enemy for 25.', type: 'Food', damageMin: 25, damageMax: 25, maxUses: 5, special: { type: 'negativeApple', healAmount: 50 } },
    ],
    teamAbility: { name: 'Brotherly Love', description: 'With Dream Sans on the team — deals 50-100 damage and grants 35 shield points. 6 turn cooldown.', type: 'brotherlyLove', requiresCharacter: 'dream_sans', dmgMin: 50, dmgMax: 100, shield: 35, cooldown: 6 },
  },
  influenced_killer_sans: {
    id: 'influenced_killer_sans', name: 'Influenced Killer Sans',
    description: 'An upgraded version of Killer Sans — corrupted by No More Deals Chara.',
    hp: 220, atk: 17, def: 17, type: 'Weapon/Melee',
    passive: { name: 'Determination', description: 'Heals 25 HP every 2 turns. Survives a fatal hit at 1 HP (once per battle).', type: 'influencedDetermination', healPerTwoTurns: 25 },
    abilities: [
      { name: 'Knife Combo', description: '2-4 hits each doing 10-15 damage. If 4 hits, applies Bleed for 2 turns.', type: 'Melee', damageMin: 10, damageMax: 15, maxUses: 25, special: { type: 'knifeComboInf', minHits: 2, maxHits: 4, bleedThreshold: 4, bleedDuration: 2 } },
      { name: 'Goo Blaster', description: 'An exploding blaster that deals 35-45 damage.', type: 'Magic', damageMin: 35, damageMax: 45, maxUses: 20, special: null },
      { name: 'PERRY', description: 'Reflects the attack back at the enemy. If the attack does more than 150 damage, Killer needs to recover for a turn.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 15, special: { type: 'perry', recoverThreshold: 150 } },
      { name: 'Charge', description: 'Skips a turn and gives the CHARGED effect — changes Knife Combo and Goo Blaster. CHARGED Goo Blaster: 60 damage, recover 1 turn, unusable 2 turns. CHARGED Knife Combo: 4-5 hits each 15 damage, Bleed for 3 turns.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'chargeInf', chargedGooDmg: 60, chargedKnifeHits: { min: 4, max: 5 }, chargedKnifeDmg: 15, chargedBleedDuration: 3 } },
    ],
    teamAbility: { name: 'WELCOME TO OUR SPECIAL HELL', description: 'With No More Deals Chara on the team — deals 150 damage and applies Burn for 3 turns. 6 turn cooldown.', type: 'welcomeSpecialHell', requiresCharacter: 'no_more_deals_chara', damage: 150, burnDuration: 3, cooldown: 6 },
  },
  // --- UPDATE 18: NEW CHARACTERS ---
  possession_sans: {
    id: 'possession_sans', name: 'Possession Sans',
    description: '"Sans is having a bad time right now, and Flowey doesnt seem to understand how unreliable brute force is."',
    hp: 200, atk: 1, def: 24, type: 'Bone/Magic/Unique',
    passive: { name: 'Vine Restriction', description: 'Remove 1 DEF from enemy every turn. 20% chance to remove 1 DEF and 1 ATK instead.', type: 'vineRestriction', defReduction: 1, atkChance: 0.20 },
    abilities: [
      { name: 'Strangulation', description: 'Hits 5 times, 10% per hit to remove 1 DEF and 1 ATK. Each success applies "Choked" (temp -1 DEF, lasts x turns = Choked value).', type: 'Unique', damageMin: 2, damageMax: 5, maxUses: 15, special: { type: 'strangulation', hits: 5, debuffChance: 0.10 } },
      { name: 'Friendlinessless Bone Throw', description: 'Hits 10 times, 5% per hit: debuff 1 ATK or DEF. Each success applies "ATK/DEF Retribution" (temp debuff multiplied by stack).', type: 'Bone', damageMin: 5, damageMax: 10, maxUses: 10, special: { type: 'friendlinesslessBoneThrow', hits: 10, debuffChance: 0.05 } },
      { name: "Flowey's Blaster", description: 'Hits 5 times, 5% to hit, removes 2 ATK and 2 DEF on each hit. Each success applies "ATK/DEF Retribution".', type: 'Magic', damageMin: 1, damageMax: 10, maxUses: 5, special: { type: 'floweyBlaster', hits: 5, hitChance: 0.05, atkDefReduction: 2 } },
      { name: 'The One in Control', description: 'Hits 100 times, each hit 1% to land. Each success applies "ATK/DEF Retribution" + KR (each KR = 1 dmg × KR count, disappears next turn).', type: 'Unique', damageMin: 1, damageMax: 5, maxUses: 5, special: { type: 'theOneInControl', hits: 100, hitChance: 0.01 } },
    ],
  },
  sudden_changes: {
    id: 'sudden_changes', name: 'Sudden Changes',
    description: '"The cylinder is loaded. Are you ready?"',
    hp: 200, atk: 23, def: 20, type: 'Weapon/Unique',
    passive: { name: 'The Final Chamber', description: "Sans's revolver has 6 shots. Each weapon attack uses 1. 6th shot stuns 1 turn + guaranteed crit. After 6th, spends 1 turn Reloading (can only use Coffee Chug). DEF -5 during reload.", type: 'theFinalChamber', maxShots: 6 },
    abilities: [
      { name: 'Rapid Shot', description: 'On crit: fires second shot at 50% dmg + Bleed 2 turns.', type: 'Weapon', damageMin: 15, damageMax: 20, maxUses: 20, special: { type: 'rapidShot', critFollowUpPct: 0.50 } },
      { name: 'Coffee Chug', description: 'Heals 20 HP. 15% chance to gain a dodge. 1 turn cooldown.', type: 'Weapon', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'coffeeChug', healAmount: 20, dodgeChance: 0.15, cooldown: 1 } },
      { name: 'Blaster Sentry', description: 'Summons mini gaster blaster for 2-4 turns, fires at end of turn. 30% chance each hit bypasses 15% DEF. 2 turn cooldown after blasts end.', type: 'Unique', damageMin: 15, damageMax: 20, maxUses: 10, special: { type: 'blasterSentry', minDuration: 2, maxDuration: 4, defBypassChance: 0.30, defBypassAmt: 0.15, cooldown: 2 } },
      { name: 'Bullet Hell', description: 'Needs 3+ bullets. +5 dmg per extra bullet. Consumes all bullets. Only after turn 4. After use, reload takes twice as long, -5 DEF during reload.', type: 'Weapon', damageMin: 30, damageMax: 40, maxUses: 5, special: { type: 'bulletHell', minBullets: 3, bonusPerBullet: 5, minTurn: 4 } },
    ],
  },
  one_left: {
    id: 'one_left', name: 'one left.',
    description: '"heh heh heh..you\'re gonna have ONE HELL of a bad time, kiddo."',
    hp: 190, atk: 20, def: 18, type: 'Bone/Magic',
    passive: { name: "It's only one left!", description: 'At the start of the round, uses the SAVE STAR to randomly buff one ability by +3 ATK.', type: 'itsOnlyOneLeft', atkBoost: 3 },
    abilities: [
      { name: 'Blaster Hell', description: '3 big blasters, 15% DEF reduce on enemy. 33.3% passive buff. 15% Determination buff: 1 blaster does 1.3x dmg. Inflicts Karma and Poison 2 turns.', type: 'Magic', damageMin: 4, damageMax: 8, maxUses: 15, special: { type: 'blasterHell', defReduceChance: 0.15 } },
      { name: 'Bone Piercing', description: '4 bone throws with 1 sharp bone. 33.3% passive buff. Inflicts Bleed 2 turns.', type: 'Bone', damageMin: 4, damageMax: 7, maxUses: 15, special: { type: 'bonePiercing' } },
      { name: "Void's Hell", description: 'Sans yells out for Gaster, who slams the enemy down. 33.3% passive buff. 30% chance Gaster slams twice. Inflicts Blindness 2 turns.', type: 'Unique', damageMin: 12, damageMax: 12, maxUses: 10, special: { type: 'voidsHell', doubleChance: 0.30 } },
      { name: 'ONE LEFT.', description: 'Heals 30 HP using DETERMINATION, but loses 5 max HP after each use.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'oneLefHeal', healAmount: 30, maxHpLoss: 5 } },
    ],
  },
  lethal_deal_char: {
    id: 'lethal_deal_char', name: 'Lethal Deal',
    description: '"The deal has been done, and I\'ll make sure that you won\'t stop that."',
    hp: 200, atk: 19, def: 17, type: 'Melee/Magic',
    passive: { name: 'The Lethal Exchange', description: 'Melee attack → next Magic deals 1.2x dmg. Magic attack → "Sharpness" buff (+20% crit chance on next Melee, caps 40%).', type: 'lethalExchange', magicBoost: 1.2, critBoostPerMagic: 0.20, critBoostCap: 0.40 },
    abilities: [
      { name: 'Knife Throw', description: 'Has a chance to apply Bleed.', type: 'Magic', damageMin: 12, damageMax: 17, maxUses: 20, special: { type: 'bleed', chance: 0.35 } },
      { name: 'Knife Barrage', description: '3-7 hits. 20% crit chance. If 5+ hits: 20% chance to stun.', type: 'Melee', damageMin: 5, damageMax: 7, maxUses: 15, special: { type: 'knifeBarrage', minHits: 3, maxHits: 7, critChance: 0.20, stunThreshold: 5, stunChance: 0.20 } },
      { name: 'Lethal Goop Blasters', description: '1 turn windup, -2 DEF during windup. Can apply Karma. +5 dmg if below 50% HP.', type: 'Magic', damageMin: 20, damageMax: 25, maxUses: 10, special: { type: 'lethalGoopBlasters', selfDebuff: { def: -2 }, karmaChance: 0.40, lowHpBonus: 5, lowHpThreshold: 0.50 } },
      { name: 'The Final Bargain', description: '2 turn CD. 20 self dmg. If kills: no CD, only 10 self dmg, +2 ATK. Only usable after turn 4.', type: 'Melee', damageMin: 29, damageMax: 36, maxUses: 5, special: { type: 'theFinalBargain', cooldown: 2, selfDmg: 20, killSelfDmg: 10, killAtkBoost: 2, minTurn: 4 } },
    ],
  },

  // --- UPDATE 19: NEW CHARACTERS ---
  reaper_sans: {
    id: 'reaper_sans', name: 'Reaper Sans',
    description: '"All it takes is one touch, then you\'re dead."',
    hp: 230, atk: 23, def: 20, type: 'Weapon/Unique',
    passive: { name: 'The Fear of DEATH', description: 'Every hit applies a "Death\'s Touch" stack (max 5). Each stack = -1% max HP/turn at end of enemy turn. At 5 stacks: enemy is Marked — next attack deals 1.5x damage and consumes all stacks. 1 turn cooldown after consuming.', type: 'fearOfDeath', maxStacks: 5, hpPercentPerStack: 0.01 },
    abilities: [
      { name: 'Scythe Sweep', description: 'Hits 1-3 times. Each hit applies a Death\'s Touch stack. 1 hit = 1 stack, 2 hits = 2 stacks, 3 hits = 3 stacks.', type: 'Weapon', damageMin: 7, damageMax: 12, maxUses: 20, special: { type: 'scytheSweep', minHits: 1, maxHits: 3 } },
      { name: 'Soul Reaper', description: 'If enemy has Death\'s Touch stacks, heals 5 HP per stack. Does not consume stacks or trigger the Marked 1.5x.', type: 'Weapon', damageMin: 14, damageMax: 17, maxUses: 15, special: { type: 'soulReaper', healPerStack: 5 } },
      { name: 'Death Blaster', description: 'If enemy has 3+ Death\'s Touch stacks: stuns for 1 turn (cannot be used twice in a row) and applies Poison for 2 turns.', type: 'Unique', damageMin: 15, damageMax: 19, maxUses: 10, special: { type: 'deathBlaster', stackThreshold: 3, stunChance: 1.0, poisonDuration: 2, cooldown: 2 } },
      { name: 'The Grand Harvest', description: 'Only usable when enemy is Marked (5 stacks). Pierces 50% of enemy DEF and lifesteals 15% of damage dealt. On kill: heal 10% HP. On no kill: lose 20% current HP from recoil.', type: 'Unique', damageMin: 30, damageMax: 30, maxUses: 5, special: { type: 'grandHarvest', requiresMarked: true, defPiercePercent: 0.50, lifestealPercent: 0.15, healOnKillPercent: 0.10, recoilOnNoKillPercent: 0.20 } },
    ],
  },
  green_sans: {
    id: 'green_sans', name: 'Green Sans',
    description: 'oh hello freddy fazbear',
    hp: 200, atk: 22, def: 20, type: 'Magic/Weapon',
    passive: { name: 'Im about to aura farm this kid', description: 'Every 3 turns, Green Sans deals 1.5x damage that turn. Resets after the buffed turn.', type: 'auraFarm', interval: 3, multiplier: 1.5 },
    abilities: [
      { name: 'Lock On and Fire', description: 'Fires 5 times. 35% chance per hit to apply Bleed for 2 turns.', type: 'Weapon', damageMin: 6, damageMax: 9, maxUses: 20, special: { type: 'multiHit', minHits: 5, maxHits: 5, bleedChance: 0.35, bleedDuration: 2 } },
      { name: 'Lightsaber Slash', description: '25% chance to apply Bleed for 2 turns and Burn for 2 turns.', type: 'Weapon', damageMin: 25, damageMax: 30, maxUses: 15, special: { type: 'lightSaberSlash', bleedChance: 0.25, bleedDuration: 2, burnChance: 0.25, burnDuration: 2 } },
      { name: 'WHATSAPP POWAAA', description: 'There is fire, ice, water, electricity, earth... And green. 40% chance to apply Karma for 2 turns.', type: 'Bone', damageMin: 25, damageMax: 25, maxUses: 20, special: { type: 'karma', chance: 0.40, duration: 2 } },
      { name: 'I will break your spine column', description: 'Fixed 60 damage. Applies Bleed for 2 turns. 2 turn cooldown.', type: 'Melee', damageMin: 60, damageMax: 60, maxUses: 5, special: { type: 'spineColumn', bleedDuration: 2, cooldown: 2 } },
    ],
  },
  seraphim: {
    id: 'seraphim', name: 'Seraphim',
    description: '"A vessel that fused with the souls."',
    hp: 220, atk: 24, def: 23, type: 'Unique/Bone',
    passive: { name: 'Souls Help', description: 'Each turn, a random soul lends its power. Determination: all effects at 50%. Kindness: heal 30 HP. Justice: +dmg this turn, 50% chance to pierce 30% DEF. Bravery: +30% damage next turn. Integrity: 20% dodge this turn. Patience: stun enemy 1 turn. Perseverance: enemy\'s next attack deals 50% less damage.', type: 'soulsHelp' },
    abilities: [
      { name: 'Toy Knife Strike', description: 'Applies Bleed for 2 turns.', type: 'Weapon', damageMin: 25, damageMax: 25, maxUses: 30, special: { type: 'bleed', chance: 1.0, duration: 2 } },
      { name: 'Bravery Barrage', description: 'The bravery soul manifests fists that beat the enemy. 4 hits. 25% chance to stun.', type: 'Melee', damageMin: 6, damageMax: 8, maxUses: 15, special: { type: 'multiHit', minHits: 4, maxHits: 4, stunChance: 0.25 } },
      { name: 'Justice will Remain', description: 'Shoots 2 justice beams. 45% chance per hit to apply Bleed for 2 turns and Karma for 2 turns.', type: 'Weapon', damageMin: 15, damageMax: 20, maxUses: 15, special: { type: 'justiceWillRemain', hits: 2, bleedChance: 0.45, bleedDuration: 2, karmaChance: 0.45, karmaDuration: 2 } },
      { name: 'Soul Infused Blast', description: 'A massive blast channeling all soul energy. 120 fixed damage. Can only be used ONCE per enemy — after use it resets when facing a new enemy.', type: 'Magic', damageMin: 120, damageMax: 120, maxUses: 5, special: { type: 'soulInfusedBlast', oncePerEnemy: true } },
    ],
  },
  roaring_knight: {
    id: 'roaring_knight', name: 'The Roaring Knight',
    description: '"The Black Knife still shone, even in the dark."',
    hp: 285, atk: 21, def: 19, type: 'Weapon',
    passive: { name: 'Strife by Strife', description: 'Every 3 turns, one of your moves becomes MARKED. Using it grants +2 ATK and +2 DEF for 1 turn and deals +12 bonus damage. Not using it removes the mark. Knife Thrust: 35% chance to Blind enemy for 2 turns. After Sword Throw: if Knife Thrust is used next, it deals +15 bonus damage.', type: 'rkCharPassive', interval: 3 },
    abilities: [
      { name: 'Sword Throw', description: '40% chance to inflict Bleed for 2 turns. If Knife Thrust is used next turn, it deals +15 more damage.', type: 'Weapon', damageMin: 20, damageMax: 35, maxUses: 20, special: { type: 'rkSwordThrow', bleedChance: 0.40, bleedDuration: 2 } },
      { name: 'Star Storm', description: 'Applies 2 stacks of Star Shards to the enemy. 50% chance when enemy uses a move, they take 15 recoil damage per stack.', type: 'Unique', damageMin: 15, damageMax: 30, maxUses: 15, special: { type: 'rkStarStorm', starShardsStacks: 2 } },
      { name: 'Knife Thrust', description: '35% chance to Blind enemy for 2 turns. 10% chance to force-switch enemy to next character in slot.', type: 'Weapon', damageMin: 20, damageMax: 40, maxUses: 15, special: { type: 'rkKnifeThrust', blindChance: 0.35, blindDuration: 2, forceSwitchChance: 0.10 } },
      { name: 'Reality Cut', description: 'Tears a piece of reality, draining -3 uses from one of the enemy\'s active moves.', type: 'Unique', damageMin: 27, damageMax: 39, maxUses: 10, special: { type: 'rkRealityCut', usesDrain: 3 } },
    ],
  },
  // --- UPDATE 20 CHARACTERS ---
  pesti_sans: {
    id: 'pesti_sans', name: 'Pesti Sans',
    description: '"We all rust someday."',
    hp: 230, atk: 20, def: 18, type: 'Weapon/Unique',
    passive: { name: 'We all rust someday', description: 'All attacks apply Blindness for 2 turns.', type: 'weAllRustSomeday', blindnessDuration: 2 },
    abilities: [
      { name: 'INFECTED GASTER BLASTERS', description: '25% chance to apply Rust for 2 turns. Also has a 50% chance to miss.', type: 'Magic', damageMin: 20, damageMax: 25, maxUses: 18, special: { type: 'infectedGasterBlasters', rustChance: 0.25, rustDuration: 2, missChance: 0.5 } },
      { name: 'OSTEOKINESIS', description: '70% chance to apply Rust.', type: 'Bone', damageMin: 15, damageMax: 20, maxUses: 20, special: { type: 'applyRust', chance: 0.7 } },
      { name: 'PIPE BASH', description: 'Applies Bleed for 3 turns.', type: 'Weapon', damageMin: 22, damageMax: 25, maxUses: 25, special: { type: 'bleed', chance: 1.0, duration: 3 } },
      { name: 'CONCENTRATED PIPE BLAST', description: 'Massive blast — deals 150 fixed damage and applies Rust for 1-2 turns. Deals 230 damage to self, reduced by 15 for every duplicate Pesti on the team. 5 turn cooldown.', type: 'Magic', damageMin: 150, damageMax: 150, maxUses: 5, special: { type: 'concentratedPipeBlast', selfDamage: 230, rustDurationMin: 1, rustDurationMax: 2, duplicateReduction: 15, cooldown: 5 } },
    ],
  },
  pesto_sans: {
    id: 'pesto_sans', name: 'Pesto Sans',
    description: 'Hmm this Pesto taste good.',
    hp: 235, atk: 24, def: 22, type: 'Food/Weapon',
    passive: { name: 'Food', description: 'If the opponent uses a food type move, Pesto gets +1 ATK.', type: 'pestoFood', atkBoost: 1 },
    abilities: [
      { name: 'Pesto Bones', description: 'Applies Bleed for 2 turns. Fires 4 times.', type: 'Bone', damageMin: 5, damageMax: 8, maxUses: 15, special: { type: 'multiHit', minHits: 4, maxHits: 4, bleedChance: 1.0, bleedDuration: 2 } },
      { name: 'Pesto Blaster', description: 'Applies Poison for 3 turns.', type: 'Magic', damageMin: 23, damageMax: 25, maxUses: 20, special: { type: 'poison', chance: 1.0, duration: 3 } },
      { name: 'Pesto Pipe Bash', description: 'Applies Bleed for 1 turn. 25% chance to Stun.', type: 'Weapon', damageMin: 25, damageMax: 27, maxUses: 10, special: { type: 'bleedAndStun', bleedChance: 1.0, bleedDuration: 1, stunChance: 0.25 } },
      { name: 'Pesto', description: 'Heals 50 HP. 3 turn cooldown.', type: 'Food', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'heal', amount: 50, cooldown: 3 } },
    ],
  },
  negatale_sans: {
    id: 'negatale_sans', name: 'Negatale Sans',
    description: '"Love for humans."',
    hp: 100, atk: 14, def: 13, type: 'Bone',
    passive: { name: 'Love for humans', description: 'If the opponent is a character that killed their human (Killer Sans, Female Killer Sans, Murder!Sans, JHall Dust Sans), Negatale gets +3 ATK and +3 DEF.', type: 'loveForHumans', atkBoost: 3, defBoost: 3, targetIds: ['killer_sans', 'female_killer_sans', 'murder_sans', 'judgement_hall_dust_sans'] },
    abilities: [
      { name: 'Sad Blaster', description: 'Applies Poison for 3 turns.', type: 'Magic', damageMin: 15, damageMax: 25, maxUses: 25, special: { type: 'poison', chance: 1.0, duration: 3 } },
      { name: 'Depressed Bones', description: 'Applies Karma for 2 turns. Fires 3 bones.', type: 'Bone', damageMin: 8, damageMax: 10, maxUses: 15, special: { type: 'multiHit', minHits: 3, maxHits: 3, karmaChance: 1.0, karmaDuration: 2 } },
      { name: 'Bone Zone', description: 'Applies Bone Zone for 2 turns.', type: 'Bone', damageMin: 13, damageMax: 15, maxUses: 15, special: { type: 'applyStatus', status: 'boneZone' } },
      { name: 'Papyrus\'s Cooking', description: 'Heals 45 HP. 1 turn cooldown.', type: 'Food', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'heal', amount: 45, cooldown: 1 } },
    ],
  },
  finale_for_the_bonely_one: {
    id: 'finale_for_the_bonely_one', name: 'Finale For The Bonely One',
    description: '"this will be my finale for the- wait, IM NOT MY V3 HELP WHY DO I HAVE MORE THAN 2 EYES AAAAAAAAA-"',
    hp: 250, atk: 23, def: 23, type: 'Magic/Unique',
    passive: { name: 'this has been my finale since day one.', description: 'FFTBO gains a stackable damage boost every 5 turns by +3, while having a 30% chance to heal up 20 HP each turn.', type: 'fftboPassive', interval: 5, dmgBoost: 3, healChance: 0.3, healAmount: 20 },
    abilities: [
      { name: 'Bonely Blaster', description: 'FFTBO shoots out a giant blaster. Applies Scary KR for 3 turns.', type: 'Magic', damageMin: 9, damageMax: 18, maxUses: 20, special: { type: 'scaryKR', duration: 3 } },
      { name: 'Their Sins', description: 'FFTBO slams the enemy into the ground. 20% chance to slam twice and then summon a blue bone zone to stun for 1 turn. Applies Bleeding for 2 turns.', type: 'Unique', damageMin: 12, damageMax: 17, maxUses: 15, special: { type: 'fftboTheirSins', slamTwiceChance: 0.2, stunDuration: 1, bleedDuration: 2 } },
      { name: '"human, you\'re cooked."', description: 'FFTBO stabs the enemy 5 times (multi-hit). Applies KR and Bleeding for 2 turns. 1 turn cooldown.', type: 'Bone', damageMin: 8, damageMax: 12, maxUses: 10, special: { type: 'fftboCooked', hits: 5, krDuration: 2, bleedDuration: 2, cooldown: 1 } },
      { name: 'BONELIEST.', description: 'FFTBO turns into his V3 form (Boneliest), jumpscaring the enemy. Applies Blindness and Bleeding for 2 turns. 3 turn cooldown.', type: 'Unique', damageMin: 30, damageMax: 30, maxUses: 5, special: { type: 'fftboBoneliest', blindDuration: 2, bleedDuration: 2, cooldown: 3 } },
    ],
  },
  dustbeef_but_in_snows: {
    id: 'dustbeef_but_in_snows', name: 'DUSTBEEF BUT IN SNOWS',
    description: '"he seems shocked by something."',
    hp: 55, atk: 10, def: 30, type: 'Bone/Melee',
    passive: { name: 'block block', description: '1/6 chance to block an attack entirely.', type: 'blockBlock', chance: 1/6 },
    abilities: [
      { name: '...oh.', description: 'Multiple sharp bones. If hit, applies Bleed.', type: 'Bone', damageMin: 12, damageMax: 24, maxUses: 15, special: { type: 'bleed', chance: 1.0 } },
      { name: 'bone zones', description: 'Two bones zone hits.', type: 'Bone', damageMin: 15, damageMax: 38, maxUses: 15, special: { type: 'multiHit', minHits: 2, maxHits: 2 } },
      { name: 'John Blaster', description: 'Multi-hit blaster.', type: 'Bone', damageMin: 12, damageMax: 35, maxUses: 5, special: { type: 'multiHit', minHits: 2, maxHits: 3 } },
      { name: 'Slashes.', description: 'Stabby stabby — applies Bleed.', type: 'Weapon', damageMin: 5, damageMax: 37, maxUses: 15, special: { type: 'bleed', chance: 1.0 } },
    ],
  },
  // --- UPDATE 20: FALSE SAVIORS EVENT CHARACTERS ---
  evans_dust: {
    id: 'evans_dust', isEventChar: true, name: 'Dust!Tale: [Evan\'s]',
    description: '"i forgor."',
    hp: 78, atk: 25, def: 32, type: 'Bone/Magic',
    passive: { name: 'MEMORIES!', description: 'Attacks from bosses can appear every 3 rounds with a 15% chance of doing so.', type: 'evansMemories', interval: 3, chance: 0.15 },
    abilities: [
      { name: 'MY MEMORIES!', description: 'Applies Burn for 2 turns.', type: 'Bone', damageMin: 5, damageMax: 47, maxUses: 25, special: { type: 'burn', chance: 1.0, duration: 2 } },
      { name: 'MEMORIES! blaster', description: 'A blasty blast.', type: 'Magic', damageMin: 4, damageMax: 38, maxUses: 20, special: null },
      { name: 'MEMORIES! bone shower', description: 'Applies Bleed for 4 turns.', type: 'Bone', damageMin: 10, damageMax: 47, maxUses: 15, special: { type: 'bleed', chance: 1.0, duration: 4 } },
      { name: 'MEMORIES! Dodge', description: 'Disables your attacks for one round.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'memoriesDodge' } },
    ],
  },
  fake_hyperdust: {
    id: 'fake_hyperdust', isEventChar: true, name: 'Fake!HyperDust',
    description: '"faaaaake."',
    hp: 99, atk: 27, def: 21, type: 'Bone/Unique',
    passive: { name: 'Fake passive', description: 'A super cool healing passive that only heals after 2 rounds (heals 15 HP every 2 turns).', type: 'fakePassive', interval: 2, healAmount: 15 },
    abilities: [
      { name: 'Copied Blasters', description: 'Copyyyyy. Applies Poison for 5 turns.', type: 'Magic', damageMin: 14, damageMax: 35, maxUses: 15, special: { type: 'poison', chance: 1.0, duration: 5 } },
      { name: 'Painted Red BoneWalls', description: 'Walls of bones.', type: 'Bone', damageMin: 25, damageMax: 30, maxUses: 25, special: null },
      { name: 'SuperFake Bones', description: 'False bones. Applies Poison for 4 turns.', type: 'Bone', damageMin: 7, damageMax: 36, maxUses: 25, special: { type: 'poison', chance: 1.0, duration: 4 } },
      { name: 'Gaster Blaster circle.', description: 'FAKE multi-hit blaster circle. 2 turn cooldown.', type: 'Magic', damageMin: 12, damageMax: 26, maxUses: 5, special: { type: 'multiHit', minHits: 2, maxHits: 4, cooldown: 2 } },
    ],
  },
  fake_dustdust: {
    id: 'fake_dustdust', isEventChar: true, name: 'Fake!DustDust',
    description: '"what."',
    hp: 199, atk: 22, def: 13, type: 'Bone/Magic',
    passive: { name: 'HATRED.', description: 'Auto Bone Zone (multi-hit) activates every 6 turns.', type: 'hatredPassive', interval: 6 },
    abilities: [
      { name: 'Trident Slashes', description: 'Slash. Applies Bleed for 1 turn and multi-hits.', type: 'Weapon', damageMin: 12, damageMax: 25, maxUses: 25, special: { type: 'multiHit', minHits: 2, maxHits: 3, bleedChance: 1.0, bleedDuration: 1 } },
      { name: 'Fake!Hatred Blasters', description: 'Wave. Applies Karma for 2 turns.', type: 'Magic', damageMin: 9, damageMax: 27, maxUses: 10, special: { type: 'karma', chance: 1.0, duration: 2 } },
      { name: '"Divine" Hatred Bones', description: 'Walls and Throw. Applies Karma for 3 turns.', type: 'Bone', damageMin: 16, damageMax: 29, maxUses: 25, special: { type: 'karma', chance: 1.0, duration: 3 } },
      { name: 'Yo Bones Go.', description: 'Throw. Applies Karma for 3 turns.', type: 'Bone', damageMin: 15, damageMax: 28, maxUses: 15, special: { type: 'karma', chance: 1.0, duration: 3 } },
    ],
  },
  // --- UPDATE 22: FALLEN PRIEST ---
  fallen_priest: {
    id: 'fallen_priest', name: 'Fallen Priest',
    description: '"Their sins shall be forgiven.. But yours shall not. Lets not have their sacrifice go to waste."',
    hp: 373, atk: 7, def: 37, type: 'Bone/Magic',
    canBeShiny: false, refuseShiny: true,
    moveUnlocks: { 1: 2, 2: 3, 3: 3, 4: 4, 5: 5 },
    passive: { name: 'A Priests Repent for the Dead', description: 'The Fallen Priest gains +3 ATK for every power of 10 integer of boss kills for each of the base 5 Undertale bosses (1 = +0 | 10 = +3 | 100 = +6 | 1000 = +9). Unlocks at Lv5.', type: 'priestsRepent', unlockLevel: 5 },
    abilities: [
      { name: "A Sinner's Rain", description: 'The tears dont stop, going down your lifeless face they leave their mark and fade away.. Hits 3-5 times, 10% chance to apply Regret for 2 turns each hit.', type: 'Bone', damageMin: 8, damageMax: 11, maxUses: 15, special: { type: 'sinnersRain', minHits: 3, maxHits: 5, regretChance: 0.10, regretDuration: 2 } },
      { name: 'Blaster Cross', description: 'Maybe this will be enough to excuse your doings. Deals 2x damage if the enemy is above 70% HP. 30% crit chance, applies Regret for 3 turns on crit. Can\'t do over 50% of the enemy\'s HP.', type: 'Magic', damageMin: 22, damageMax: 26, maxUses: 10, special: { type: 'blasterCross', hpThreshold: 0.70, critChance: 0.30, regretDuration: 3, hpCap: 0.50 } },
      { name: 'The Cross', description: 'Seems like the heavens are deciding to help me afterall. Gives The Fallen Priest Blessing for 2 turns. 7 turn cooldown.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 3, special: { type: 'theCross', blessingDuration: 2, cooldown: 7 } },
      { name: "God's Necromaniac", description: 'Uses the next boss ability. Boss abilities gain +1 multihit for every power of 10 integer of the respective boss kills. 5 uses (1 each).', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'godsNecromaniac' } },
      { name: 'Sacrifices must be made..', description: 'It\'s not wrong if they agreed to it, right..? Instantly kills the boss awarding no drops and 2 boss kills instead of 1. Only usable on Toriel, Papyrus, Undyne, Mettaton and Asgore with at least 100 kills on the boss. At 500 kills awards 3, at 1000 awards 6, +2 per 500 past 1000.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'sacrificesMustBeMade' } },
    ],
  },
  oceantale_papyrus: {
    id: 'oceantale_papyrus', name: 'Oceantale Papyrus',
    description: '"NYEH HEH HEH! WELCOME ABOARD, HUMAN! PREPARE TO BE UTTERLY WASHED AWAY BY THE GREAT CAPTAIN PAPYRUS!"',
    hp: 170, atk: 12, def: 14, type: 'Weapon/Bone',
    passive: { name: 'Aquatic Reflexes', description: 'When attacked, 25% chance to block with his cutlass (negate the damage, +1 DEF). If a block triggers, 35% of the time it is instead a swordfish counter: negate the damage, reflect 50% of it, and gain +2 ATK.', type: 'aquaticReflexes', blockChance: 0.25, counterChance: 0.35 },
    abilities: [
      { name: 'Hand Cannon', description: 'Has a 25% chance to push the enemy back, causing them to flinch next turn and lowering their accuracy by 10% for 2 turns.', type: 'Weapon', damageMin: 12, damageMax: 19, maxUses: 20, special: { type: 'handCannon', pushChance: 0.25, accDownDuration: 2 } },
      { name: 'Harpoon Gun', description: 'Papyrus shoots a heavy sea harpoon. If it hits, 30% chance it chains the opponent — stunned for 1 turn, cannot dodge or switch for the next 2 turns.', type: 'Weapon', damageMin: 14, damageMax: 22, maxUses: 15, special: { type: 'harpoonGun', chainChance: 0.30, trapDuration: 2 } },
      { name: 'Bone Anchor', description: '50% chance to inflict Blue Soul for 2 turns. While affected, any Melee-type moves used against them deal 1.2x extra damage.', type: 'Bone', damageMin: 16, damageMax: 25, maxUses: 10, special: { type: 'boneAnchor', blueSoulChance: 0.50, blueSoulDuration: 2, cooldown: 1 } },
      { name: 'Boat Cruise', description: 'Summons a pirate ship to ram the opponent. If Papyrus has triggered at least one Swordfish Counter this match, deals 1.3x damage (bypasses blocks/counters).', type: 'Unique', damageMin: 18, damageMax: 27, maxUses: 5, special: { type: 'boatCruise', bonusMult: 1.3, cooldown: 3 } },
    ],
  },
  psychopathtale_sans: {
    id: 'psychopathtale_sans', name: 'Psychopathtale Sans',
    description: '"I found this guy in a random lab (don\'t tell inner! I took green guy with me)"',
    hp: 200, atk: 18, def: 23, type: 'Weapon/Unique',
    passive: { name: 'Psychotic Episodes', description: 'Every 5 turns Sans suffers a psychotic episode: +7 ATK / -7 DEF for 3 turns (Psycho Mode), then reverts to normal.', type: 'psychoticEpisodes', atkSwing: 7, defSwing: 7, cycle: 5, duration: 3 },
    abilities: [
      { name: 'Neon Slash', description: 'Normal: 20-25, applies Karma 2t + 10% chance to lower DEF by 2 for 3t. Psycho: 15-20, applies Schizo 2t + 25% chance to lower ATK by 3 for 4t.', type: 'Weapon', damageMin: 20, damageMax: 25, maxUses: 15, special: { type: 'neonSlash', psychoMin: 15, psychoMax: 20, karmaDuration: 2, schizoDuration: 2, normalDefDownChance: 0.10, normalDefDown: 2, normalDefDownDur: 3, psychoAtkDownChance: 0.25, psychoAtkDown: 3, psychoAtkDownDur: 4 } },
      { name: 'Psychotic Blaster', description: 'Normal: 20-27, applies Karma 2t + 10% chance to negate 10% of damage. Psycho: 15-22, applies Schizo 2t + 25% chance to deal 15% more damage.', type: 'Magic', damageMin: 20, damageMax: 27, maxUses: 10, special: { type: 'psychoticBlaster', psychoMin: 15, psychoMax: 22, karmaDuration: 2, schizoDuration: 2, normalNegateChance: 0.10, psychoBonusChance: 0.25, psychoBonusMult: 1.15 } },
      { name: 'Bone Ravage', description: 'Normal: 5-10 fires 6 times + Karma 2t. Psycho: 4-7 fires 5 times + Schizo 3t.', type: 'Bone', damageMin: 5, damageMax: 10, maxUses: 15, special: { type: 'boneRavage', psychoMin: 4, psychoMax: 7, normalHits: 6, psychoHits: 5, karmaDuration: 2, schizoDuration: 3, cooldown: 2 } },
      { name: 'Large Schizo Blaster', description: 'Charges 1 turn. Normal: 25-28, Karma 3t + 15% chance to negate 25% of attack. Psycho: 20-23, Schizo 3t + 20% chance to deal 25% more damage.', type: 'Magic', damageMin: 25, damageMax: 28, maxUses: 5, special: { type: 'largeSchizoBlaster', psychoMin: 20, psychoMax: 23, charge: true, karmaDuration: 3, schizoDuration: 3, normalNegateChance: 0.15, psychoBonusChance: 0.20, psychoBonusMult: 1.25 } },
    ],
  },
  dusttale_endgoal: {
    id: 'dusttale_endgoal', name: 'Dusttale Endgoal: A Flawless Genocide',
    description: '"Two monsters, only one will win... He wants to fight one last time, for old times sake."',
    hp: 230, atk: 17, def: 26, type: 'Weapon/Food',
    passive: { name: "The Murderer's Determination", description: 'Above 40% HP: wears The Locket, reducing all incoming multi-hit and fixed damage by 30%. On first dropping below 40% HP: eats all food (heal 90 HP, drains Inventory Feast uses), DEF -5, permanently equips the Real Knife (+8 ATK).', type: 'murderersDetermination', hpThreshold: 0.40, locketReduction: 0.30, healAmount: 90, defLoss: 5, atkGain: 8 },
    abilities: [
      { name: 'Telekinetic Slam', description: '50% Blue Soul 2t, 20% Stun 1t. Below 40% HP: Stun 35% + Bone Zone 2t if stunned.', type: 'Magic', damageMin: 16, damageMax: 20, maxUses: 20, special: { type: 'telekineticSlam', blueSoulChance: 0.50, blueSoulDuration: 2, stunChance: 0.20, lowStunChance: 0.35 } },
      { name: 'True Genocide', description: '+5 damage for every 25 HP Sans has lost (max +20). Below 40% HP: permanent +20% crit chance.', type: 'Weapon', damageMin: 18, damageMax: 23, maxUses: 15, special: { type: 'trueGenocide', perHpLost: 25, bonusPer: 5, maxBonus: 20, lowCritBonus: 0.20 } },
      { name: 'Flawless Bone Wall', description: 'Grants a temporary shield equal to 15% of max HP for 2 turns.', type: 'Bone', damageMin: 14, damageMax: 18, maxUses: 10, special: { type: 'flawlessBoneWall', shieldPct: 0.15, shieldDuration: 2, cooldown: 3 } },
      { name: 'Inventory Feast', description: 'Heals Sans for 35 HP and clears all damage-over-time statuses (Bleed, Burn, Poison).', type: 'Food', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'inventoryFeast', healAmount: 35, cooldown: 1 } },
    ],
  },
  reaper_chara: {
    id: 'reaper_chara', name: 'Reaper Chara',
    description: '"Hi there! ...since we are here... THE RULES DON\'T REALLY APPLY ANYMORE."',
    hp: 170, atk: 24, def: 19, type: 'Weapon/Unique',
    passive: { name: 'Divine Hatred', description: 'Below 50% HP: permanent +5 ATK and attacks ignore 20% of enemy DEF. Once per battle, a fatal hit leaves Chara at 1 HP with a shield that blocks the next 2 incoming attacks.', type: 'divineHatred', hpThreshold: 0.50, atkGain: 5, defIgnore: 0.20, shieldBlocks: 2 },
    abilities: [
      { name: 'Hell Rush', description: '2-3 hits. Each hit 15% chance to lower enemy DEF by 1. If all hits land, next move +10% crit. 30% chance to Bleed 2t.', type: 'Weapon', damageMin: 6, damageMax: 9, maxUses: 20, special: { type: 'hellRush', minHits: 2, maxHits: 3, defDownChance: 0.15, bleedChance: 0.30, bleedDuration: 2 } },
      { name: 'Devastating Hate', description: '30% chance to inflict Blindness 3t OR Hate 2t (positive buffs disabled; 20 fixed dmg + lifesteal to Chara when they heal/guard).', type: 'Unique', damageMin: 18, damageMax: 22, maxUses: 15, special: { type: 'devastatingHate', procChance: 0.30, blindnessDuration: 3, hateDuration: 2 } },
      { name: 'Darkness Sanctuary', description: '3 turns: +3 DEF, immune to status effects, and Chara\'s Melee moves deal 1.1x.', type: 'Unique', damageMin: 20, damageMax: 24, maxUses: 10, special: { type: 'darknessSanctuary', defBuff: 3, duration: 3, cooldown: 2 } },
      { name: 'Death Tornado', description: '2-4 hits (damage split). If Divine Hatred is active (below 50% HP), Stun 1t. Inflicts Hemorrhage (8 dmg/turn until they heal or switch).', type: 'Weapon', damageMin: 15, damageMax: 22, maxUses: 5, special: { type: 'deathTornado', minHits: 2, maxHits: 4, cooldown: 3 } },
    ],
  },
  fedora_sans: {
    id: 'fedora_sans', name: 'Fedora Sans',
    description: '"Hey if it aint the chump that FSE paps was too lazy to track do- wait where am i- wheres the chump?- this isn\'t TNARSOG-"',
    hp: 300, atk: 26, def: 28, type: 'Crystal',
    moveUnlocks: { 1: 2, 2: 2, 3: 3, 4: 4, 5: 4 },
    passive: { name: 'Crystal-Infused Bones', description: 'Whenever Fedora gains a negative effect, the effect is deflected back onto the attacker and both lose 1 DEF for 3 turns. This can stack.', type: 'crystalInfusedBones', defLoss: 1, defLossDuration: 3 },
    typeSwap: { cycle: 2 },
    abilities: [
      { name: 'Gemstone Switchup', description: '33% chance to reduce enemy DEF by 2.', type: 'Crystal', damageMin: 17, damageMax: 22, maxUses: 35, special: { type: 'gemstoneSwitchup', defDownChance: 0.33, defDown: 2 } },
      { name: 'Crystal Shaped Bomb', description: 'Throws a crystal ball. If the enemy attacks next turn it explodes for 45 damage (+15 to a random enemy party member).', type: 'Unique', damageMin: 5, damageMax: 5, maxUses: 20, special: { type: 'crystalShapedBomb', explodeDamage: 45, splashDamage: 15, cooldown: 1 } },
      { name: 'Crystal Impale', description: '3-4 hits. Each hit has a 50% chance to apply Crystallize for 2 turns.', type: 'Crystal', damageMin: 6, damageMax: 8, maxUses: 10, special: { type: 'crystalImpale', minHits: 3, maxHits: 4, crystallizeChance: 0.50, crystallizeDuration: 2 } },
      { name: 'Hat Trick', description: 'One of four random effects: 20 self-damage; 50 damage + Stun 1t; nothing; or 7 crystals (5 dmg each, 75% Crystallize 2t).', type: 'Magic', damageMin: 0, damageMax: 0, maxUses: 15, special: { type: 'hatTrick', cooldown: 1, crystallizeDuration: 2 } },
    ],
  },
  // --- UPDATE 30: NEW CHARACTERS ---
  storyspin_sans: {
    id: 'storyspin_sans', name: 'Storyspin Sans',
    description: '"Now I\'m the one in control."',
    hp: 190, atk: 21, def: 20, type: 'Weapon/Bone',
    passive: { name: 'Think youve got no consequences?', description: "Storyspin's ATK and DEF increase by 1 for every teammate that has died.", type: 'storyspinConsequences', statPerDead: 1 },
    abilities: [
      { name: 'Bat Whack', description: '40% chance to stun the enemy and a 20% chance to lower their DEF by 2.', type: 'Weapon', damageMin: 14, damageMax: 18, maxUses: 20, special: { type: 'batWhack', stunChance: 0.40, defDownChance: 0.20, defDown: 2 } },
      { name: 'Twisted Barrage', description: 'Hits 3-5 times. Each hit has a 20% chance to pierce 10% of the enemy DEF. Also applies Poison for 2 turns.', type: 'Bone', damageMin: 4, damageMax: 12, maxUses: 15, special: { type: 'twistedBarrage', minHits: 3, maxHits: 5, pierceChance: 0.20, piercePercent: 0.10, poisonDuration: 2 } },
      { name: 'Vision Manipulation', description: 'Gives the enemy Blindness for 3-5 turns. 2 turn cooldown after the effect is over.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'visionManipulation', blindMin: 3, blindMax: 5, cooldown: 2 } },
      { name: 'Malfunctioning Blaster', description: '25% chance to malfunction, dealing half the damage to both the enemy and Storyspin, but gaining a 30% crit rate boost for the next 2 turns. 2 turn cooldown.', type: 'Magic', damageMin: 20, damageMax: 35, maxUses: 5, special: { type: 'malfunctioningBlaster', malfunctionChance: 0.25, critBoost: 0.30, critBoostTurns: 2, cooldown: 2 } },
    ],
  },
  underterror_sans: {
    id: 'underterror_sans', name: 'Underterror Sans',
    description: '"How\'d all this junk get lost anyways?"',
    hp: 310, atk: 17, def: 35, type: 'Unique/Food',
    passive: { name: 'Overstocked Shelves', description: 'Every time Toxin switches out he heals 15 HP and gains 2 uses on Lost\'N\'Found.', type: 'overstockedShelves', healOnSwitch: 15, lostNFoundRestore: 2 },
    abilities: [
      { name: 'Bone-Twister', description: 'Deals its damage each turn for 3 turns.', type: 'Bone', damageMin: 7, damageMax: 11, maxUses: 15, special: { type: 'boneTwister', dotTurns: 3 } },
      { name: "Lost'N'Found", description: 'Toxin uses a random weapon from his shop: Outerdust\'s Trident (enemy -4 ATK), Fell\'s Brass Knuckle (2x dmg, 70% crit, sets a 2 turn cd), Sudden\'s Revolver (3-7 hits at 25% dmg, all hit = Overheat), Horror\'s Thigh-Bone (30% crit, Hemorrhage + Bleed), Reaper\'s Scythe (2 stacks Death\'s Touch), or Distrust\'s Bone Butter Knife (hits 2 extra times at 25% dmg, 2x if enemy has Bone-Twister).', type: 'Unique', damageMin: 19, damageMax: 21, maxUses: 4, special: { type: 'lostNFound' } },
      { name: 'DT Injection', description: 'Switch Toxin out with a random character, giving them a permanent +3 ATK / +1 DEF. After 3 turns, switch back to Toxin. 6 turn cooldown.', type: 'Food', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'dtInjection', atkBoost: 3, defBoost: 1, returnAfter: 3, cooldown: 6 } },
      { name: 'Spare Reservations', description: 'Switch Toxin out with a random character, healing them 45 HP. After 4 turns, switch back to Toxin. 6 turn cooldown.', type: 'Food', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'spareReservations', heal: 45, returnAfter: 4, cooldown: 6 } },
    ],
  },
  papyrus_belief: {
    id: 'papyrus_belief', name: 'Papyrus Belief',
    description: '"Well... I cant say i expected that to happen... No Matter!! It seems that i will have to settle this feud... through Different Means! Wish me good luck!!"',
    hp: 280, atk: 24, def: 19, type: 'Bone/Magic',
    passive: { name: 'Shattered Expectations', description: 'Every time Papyrus shifts between a Bone attack and a Magic attack, his next move gains +15% accuracy and a 10% chance to overwhelm the target (increasing the duration of any active status effect on them by 1, and granting Papyrus an additional turn). When HP drops below 40%, he gains a permanent +4 DEF and becomes immune to Flinching/Stuns. When an enemy is affected by Blue Soul, Bone type moves used against them deal 1.3x extra damage.', type: 'shatteredExpectations', accBonus: 0.15, overwhelmChance: 0.10, lowHpThreshold: 0.40, lowHpDefBoost: 4, blueSoulBoneMult: 1.3 },
    abilities: [
      { name: 'Bone Pummel', description: '25% chance to lower the enemy DEF by 2.', type: 'Bone', damageMin: 16, damageMax: 21, maxUses: 25, special: { type: 'bonePummel', defDownChance: 0.25, defDown: 2 } },
      { name: 'Bonely Retribution', description: '25% chance to Stun the enemy for 1 turn. If the stun fails, the enemy\'s attacks deal 20% less damage on their next turn.', type: 'Bone', damageMin: 20, damageMax: 26, maxUses: 15, special: { type: 'bonelyRetribution', stunChance: 0.25, weakenPercent: 0.20 } },
      { name: 'Gravitational Despair', description: 'Inflicts Blue Soul for 3 turns. 3 turn cooldown.', type: 'Magic', damageMin: 20, damageMax: 26, maxUses: 10, special: { type: 'gravitationalDespair', blueSoulDuration: 3, cooldown: 3 } },
      { name: 'ISNT HE A BLAST?', description: 'Applies Blindness for 3 turns. Additionally, makes their next attack cost double the usual uses. 3 turn cooldown.', type: 'Magic', damageMin: 30, damageMax: 37, maxUses: 5, special: { type: 'isntHeABlast', blindDuration: 3, cooldown: 3 } },
    ],
  },
  lowtierfell_sans: {
    id: 'lowtierfell_sans', name: 'LowTierFell!Sans',
    description: '"your life, IS NOTHING! you serve ZERO PURPOSE! YOU SHOULD ---, NOW!!!"',
    hp: 180, atk: 18, def: 20, type: 'Unique/Bone',
    passive: { name: 'THUNDER STRIKE!', description: 'Every 5 turns, LowTierFell summons lightning on the enemy, shocking them (stun) for 1 turn while dealing 30 true damage.', type: 'thunderStrike', interval: 5, trueDamage: 30 },
    abilities: [
      { name: 'LowTier Blasters', description: 'Blasts 3 blasters (multi-hit). If below 10% HP, summons lightning for an additional 15 true damage. Applies Scary KR and Poison for 1 turn.', type: 'Magic', damageMin: 6, damageMax: 8, maxUses: 20, special: { type: 'lowtierBlasters', hits: 3, lowHpThreshold: 0.10, lowHpTrueDamage: 15, scaryKRDuration: 1, poisonDuration: 1 } },
      { name: 'LowTier Bones', description: 'Throws bones at the enemy. Applies Scary KR and Bleed for 1 turn.', type: 'Bone', damageMin: 15, damageMax: 18, maxUses: 20, special: { type: 'lowtierBones', scaryKRDuration: 1, bleedDuration: 1 } },
      { name: 'Chained Slam', description: 'Slams a chained blaster (30% chance to miss). If below 15% HP, punches for an additional 10 true damage. 40% chance to apply Scary KR, Bleed, Poison and Karma for 2 turns. 2 turn cooldown.', type: 'Unique', damageMin: 35, damageMax: 35, maxUses: 10, special: { type: 'chainedSlam', missChance: 0.30, lowHpThreshold: 0.15, lowHpTrueDamage: 10, statusChance: 0.40, statusDuration: 2, cooldown: 2 } },
      { name: '"IVE HAD ENOUGH OF YOU, BRAT!"', description: 'Grabs the enemy and breaks their spine. Applies Bleed for 2 turns and Stuns for 1 turn. 3 turn cooldown.', type: 'Unique', damageMin: 50, damageMax: 50, maxUses: 5, special: { type: 'lowtierEnough', bleedDuration: 2, stunDuration: 1, cooldown: 3 } },
    ],
  },
};

// --- UPDATE 20: ENLIGHTENED QUESTLINE CHARACTERS ---
// Exact clones of their normal counterparts (same stats + abilities), renamed, and CANNOT be shiny.
const ENLIGHTENED_CLONES = {
  enlightened_sans: { base: 'sans', name: 'Enlightened Sans' },
  enlightened_ruins_dust_sans: { base: 'ruins_dust_sans', name: 'Enlightened Ruins Dust Sans' },
  enlightened_snowdin_dust_sans: { base: 'snowdin_dust_sans', name: 'Enlightened Snowdin Dust Sans' },
  enlightened_waterfall_dust_sans: { base: 'waterfall_dust_sans', name: 'Enlightened Waterfall Dust Sans' },
  enlightened_hotlands_dust_sans: { base: 'hotlands_dust_sans', name: 'Enlightened Hotlands Dust Sans' },
  enlightened_core_dust_sans: { base: 'core_dust_sans', name: 'Enlightened Core Dust Sans' },
  enlightened_judgement_hall_dust_sans: { base: 'judgement_hall_dust_sans', name: 'Enlightened Judgement Hall Dust Sans' },
};
for (const [id, info] of Object.entries(ENLIGHTENED_CLONES)) {
  const base = CHARACTERS[info.base];
  if (!base) continue;
  const clone = JSON.parse(JSON.stringify(base)); // deep clone stats + abilities
  clone.id = id;
  clone.name = info.name;
  clone.canBeShiny = false; // enlightened characters cannot be shiny — they're already enlightened
  CHARACTERS[id] = clone;
}

// --- AI ENEMIES ---
const ENEMIES = {
  snowman: {
    id: 'snowman', name: 'Snowman',
    description: 'A sentient armless snowman.',
    hp: 120, atk: 7, def: 8, type: 'Magic',
    passive: null, weight: 60, tier: 'medium',
    abilities: [
      { name: 'Head Strike', description: 'Rough head attack.', type: 'Weapon', damageMin: 10, damageMax: 15, maxUses: 15, special: null },
      { name: 'Intimidate', description: 'Lower your DEF by 2.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'debuff', stat: 'def', amount: -2, target: 'enemy' } },
    ],
    rewards: { soulEssence: { min: 10, max: 25, chance: 0.1 }, dtVial: { min: 1, max: 1, chance: 0.5 }, starPiece: { min: 1, max: 1, chance: 0.2 }, exp: { min: 5, max: 10 } },
  },
  big_snowman: {
    id: 'big_snowman', name: 'Big Snowman',
    description: 'The same snowman, only bigger.',
    hp: 150, atk: 10, def: 12, type: 'Magic',
    passive: null, weight: 25, tier: 'medium',
    abilities: [
      { name: 'Head Impact', description: 'Bigger head, bigger power.', type: 'Weapon', damageMin: 15, damageMax: 25, maxUses: 15, special: null },
      { name: 'Gaze of Despair', description: '-3 DEF and -1 ATK to you.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'multiDebuff', enemyDef: -3, enemyAtk: -1 } },
    ],
    rewards: { soulEssence: { min: 25, max: 35, chance: 0.15 }, dtVial: { min: 1, max: 2, chance: 0.7 }, starPiece: { min: 1, max: 1, chance: 0.35 }, exp: { min: 10, max: 20 } },
  },
  snowman_sans_costume: {
    id: 'snowman_sans_costume', name: 'Snowman (Sans Costume)',
    hp: 170, atk: 11, def: 14, type: 'Magic/Bone',
    passive: { name: "Sans' Laziness", description: 'Heal +5 HP each turn.', type: 'regenHP', amount: 5 },
    weight: 15, tier: 'medium', isMiniBoss: true,
    abilities: [
      { name: 'Fake Bones', description: 'Colored and shaped like a real bone!', type: 'Bone', damageMin: 15, damageMax: 20, maxUses: 25, special: null },
      { name: 'Snow Blaster', description: '20% Poison chance.', type: 'Magic', damageMin: 20, damageMax: 30, maxUses: 15, special: { type: 'poison', chance: 0.2 } },
    ],
    rewards: { soulEssence: { min: 35, max: 40, chance: 0.35 }, dtVial: { min: 1, max: 3, chance: 0.6 }, starPiece: { min: 1, max: 1, chance: 0.1 }, exp: { min: 15, max: 30 } },
  },
  // --- UPDATE 18: EASY (Ruins) ---
  froggit: {
    id: 'froggit', name: 'Froggit',
    description: 'A small frog-like monster.',
    hp: 90, atk: 2, def: 4, type: 'Melee',
    passive: null, weight: 50, tier: 'easy',
    abilities: [
      { name: 'Frog jump', description: 'Froggit jumps at the player.', type: 'Melee', damageMin: 1, damageMax: 4, maxUses: 20, special: null },
      { name: 'Fly attack', description: 'Froggit throws a fly at the player.', type: 'Melee', damageMin: 1, damageMax: 3, maxUses: 20, special: null },
    ],
    rewards: { exp: { min: 3, max: 5 } },
  },
  whimsum: {
    id: 'whimsum', name: 'Whimsum',
    description: 'A timid moth-like monster.',
    hp: 80, atk: 4, def: 2, type: 'Magic',
    passive: null, weight: 50, tier: 'easy',
    abilities: [
      { name: 'Moth circle', description: 'Whimsum does a circle of moths around the player.', type: 'Magic', damageMin: 2, damageMax: 5, maxUses: 20, special: null },
      { name: 'Moth barrage', description: 'Whimsum throws 3-5 moths doing 1 dmg each.', type: 'Magic', damageMin: 3, damageMax: 5, maxUses: 15, special: { type: 'multiHit', minHits: 3, maxHits: 5 } },
    ],
    rewards: { exp: { min: 3, max: 5 } },
  },
  flowey_mini: {
    id: 'flowey_mini', name: 'Flowey',
    description: 'A sentient flower with a creepy grin.',
    hp: 110, atk: 6, def: 8, type: 'Magic/Unique',
    passive: null, weight: 5, tier: 'easy', isMiniBoss: true,
    abilities: [
      { name: 'Pellet circle', description: 'Flowey does a pellet circle around the player.', type: 'Magic', damageMin: 8, damageMax: 12, maxUses: 20, special: null },
      { name: 'Friendliness pellets', description: 'Flowey shoots a barrage of bullets at the player.', type: 'Magic', damageMin: 9, damageMax: 13, maxUses: 15, special: null },
      { name: 'Wink', description: 'Flowey winks at the player reducing the DEF by 2.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'debuff', stat: 'def', amount: -2, target: 'enemy' } },
    ],
    rewards: { dtVial: { min: 1, max: 1, chance: 0.5 }, exp: { min: 11, max: 15 } },
  },
  // --- UPDATE 18: HARD (Hotlands) ---
  vulkin: {
    id: 'vulkin', name: 'Vulkin',
    description: 'A small volcano monster.',
    hp: 160, atk: 12, def: 10, type: 'Fire/Shock',
    passive: null, weight: 50, tier: 'hard',
    abilities: [
      { name: 'Thunder cloud', description: 'Vulkin summons a thunder cloud on top of the player.', type: 'Shock', damageMin: 12, damageMax: 14, maxUses: 15, special: { type: 'stun', chance: 0.20 } },
      { name: 'Fire pillar', description: 'Vulkin summons a fire pillar on the player.', type: 'Fire', damageMin: 10, damageMax: 12, maxUses: 15, special: { type: 'burn', burnChance: 0.30, duration: 2 } },
    ],
    rewards: { soulEssence: { min: 20, max: 25, chance: 1.0 }, dtVial: { min: 20, max: 25, chance: 0.6 }, starPiece: { min: 1, max: 1, chance: 0.5 }, exp: { min: 19, max: 24 } },
  },
  pyrope: {
    id: 'pyrope', name: 'Pyrope',
    description: 'A fiery monster with a colorful flame.',
    hp: 150, atk: 11, def: 11, type: 'Fire',
    passive: null, weight: 50, tier: 'hard',
    abilities: [
      { name: 'Fire bomb', description: 'Pyrope summons a fire bomb that explodes on the player.', type: 'Fire', damageMin: 14, damageMax: 16, maxUses: 15, special: { type: 'burn', burnChance: 0.35, duration: 2 } },
      { name: 'Fire lazer', description: 'Pyrope summons a colorful fire lazer being 50-50 if its blue or orange.', type: 'Fire', damageMin: 11, damageMax: 14, maxUses: 15, special: { type: 'fireLazer' } },
    ],
    rewards: { soulEssence: { min: 20, max: 25, chance: 1.0 }, dtVial: { min: 20, max: 25, chance: 0.6 }, starPiece: { min: 1, max: 1, chance: 0.5 }, exp: { min: 19, max: 24 } },
  },
  tsunderplane: {
    id: 'tsunderplane', name: 'Tsunderplane',
    description: 'A plane-shaped monster with mood swings.',
    hp: 210, atk: 20, def: 18, type: 'Magic/Unique',
    passive: null, weight: 5, tier: 'hard', isMiniBoss: true,
    abilities: [
      { name: 'Plane bombardment', description: 'A plane appears in the sky and bombs the player.', type: 'Fire', damageMin: 23, damageMax: 26, maxUses: 15, special: { type: 'burn', burnChance: 1.0, duration: 2 } },
      { name: 'Plane crashes', description: 'A plane quite literally crashes onto the player.', type: 'Melee', damageMin: 25, damageMax: 27, maxUses: 10, special: { type: 'stun', chance: 0.35 } },
      { name: 'Plane flinch', description: 'Tsunderplane pretends to ram the player and makes them flinch, making them lose 3 DEF and ATK.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'multiDebuff', enemyDef: -3, enemyAtk: -3 } },
    ],
    rewards: { soulEssence: { min: 30, max: 36, chance: 1.0 }, dtVial: { min: 30, max: 36, chance: 1.0 }, starPiece: { min: 1, max: 1, chance: 1.0 }, extraDrops: [{ item: 'burning_essence', name: 'Burning Essence', emoji: '🔥', chance: 0.25 }], exp: { min: 34, max: 38 } },
  },
  // --- UPDATE 18: VERY HARD (Core) ---
  astigmatism: {
    id: 'astigmatism', name: 'ASTIGMATISM',
    description: 'A monster who scolds you.',
    hp: 200, atk: 18, def: 17, type: 'Magic/Unique',
    passive: null, weight: 50, tier: 'veryHard',
    abilities: [
      { name: 'ORBS', description: 'ASTIGMATISM summons orbs all around the player.', type: 'Magic', damageMin: 22, damageMax: 25, maxUses: 15, special: null },
      { name: 'ALIVE ORBS', description: 'These creatures look like orbs... its eerie.', type: 'Unique', damageMin: 19, damageMax: 28, maxUses: 10, special: null },
    ],
    rewards: { soulEssence: { min: 39, max: 43, chance: 1.0 }, dtVial: { min: 39, max: 43, chance: 1.0 }, starPiece: { min: 1, max: 1, chance: 1.0 }, extraDrops: [{ item: 'dt_injector', name: 'DT Injector', emoji: '💉', chance: 0.15 }], exp: { min: 40, max: 43 } },
  },
  final_froggit: {
    id: 'final_froggit', name: 'FINAL FROGGIT',
    description: 'The ultimate evolution of Froggit.',
    hp: 205, atk: 19, def: 16, type: 'Melee/Magic',
    passive: null, weight: 50, tier: 'veryHard',
    abilities: [
      { name: 'Final frog jump', description: 'F R O G.', type: 'Melee', damageMin: 25, damageMax: 25, maxUses: 15, special: { type: 'stun', chance: 0.40 } },
      { name: 'Fly massacre', description: 'F L I E S. 4 dmg per fly, 3-7 flies.', type: 'Magic', damageMin: 4, damageMax: 4, maxUses: 10, special: { type: 'multiHit', minHits: 3, maxHits: 7 } },
    ],
    rewards: { soulEssence: { min: 39, max: 43, chance: 1.0 }, dtVial: { min: 39, max: 43, chance: 1.0 }, starPiece: { min: 1, max: 1, chance: 1.0 }, extraDrops: [{ item: 'dt_injector', name: 'DT Injector', emoji: '💉', chance: 0.15 }], exp: { min: 40, max: 43 } },
  },
  amalgamate: {
    id: 'amalgamate', name: 'AMALGAMATE',
    description: 'They are suffering... can you also hear their cries?',
    hp: 270, atk: 24, def: 22, type: 'Unique',
    passive: null, weight: 5, tier: 'veryHard', isMiniBoss: true,
    abilities: [
      { name: 'MELTING', description: 'They are suffering... can you also hear their cries..?', type: 'Unique', damageMin: 32, damageMax: 34, maxUses: 15, special: null },
      { name: 'CRIES', description: 'You can see them melt... its so terrible...', type: 'Unique', damageMin: 34, damageMax: 34, maxUses: 10, special: null },
      { name: 'SCARE', description: 'They assume an even more terrifying form...', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'multiDebuff', enemyDef: -4, enemyAtk: -4 } },
    ],
    rewards: { soulEssence: { min: 47, max: 53, chance: 1.0 }, dtVial: { min: 47, max: 53, chance: 1.0 }, extraDrops: [{ item: 'soul_essence', name: 'Soul Essence', emoji: '💜', chance: 0.05, min: 50, max: 100 }], exp: { min: 60, max: 65 } },
  },
  // --- UPDATE 18: BAD TIME (Surface) ---
  justice_human: {
    id: 'justice_human', name: 'JUSTICE',
    description: 'The yellow human SOUL.',
    hp: 260, atk: 22, def: 18, type: 'Weapon/Magic',
    passive: null, weight: 25, tier: 'badTime',
    abilities: [
      { name: 'Justice beam', description: 'Justice charges a powerful beam.', type: 'Magic', damageMin: 40, damageMax: 46, maxUses: 15, special: null },
      { name: 'Justice barrage', description: 'Justice fires 3-5 mini beams at the player doing 13 dmg each.', type: 'Magic', damageMin: 13, damageMax: 13, maxUses: 10, special: { type: 'multiHit', minHits: 3, maxHits: 5 } },
    ],
    rewards: { soulEssence: { min: 75, max: 77, chance: 1.0 }, dtVial: { min: 75, max: 77, chance: 1.0 }, extraDrops: [{ item: 'justice_human_soul', name: 'Justice Human Soul', emoji: '💛', chance: 1.0 }, { item: 'loaded_gun', name: 'Loaded Gun', emoji: '🔫', chance: 0.10 }], exp: { min: 75, max: 77 } },
  },
  integrity_human: {
    id: 'integrity_human', name: 'INTEGRITY',
    description: 'The dark blue human SOUL.',
    hp: 240, atk: 20, def: 17, type: 'Weapon/Melee',
    passive: null, weight: 25, tier: 'badTime',
    abilities: [
      { name: 'I think I SAW a SAW', description: 'Integrity literally summons a saw and launches it at the player.', type: 'Weapon', damageMin: 35, damageMax: 38, maxUses: 15, special: null },
      { name: 'Kick to the face', description: 'Integrity sprints at the player and kicks them.', type: 'Melee', damageMin: 40, damageMax: 40, maxUses: 10, special: { type: 'stun', chance: 0.35 } },
    ],
    rewards: { soulEssence: { min: 75, max: 77, chance: 1.0 }, dtVial: { min: 75, max: 77, chance: 1.0 }, extraDrops: [{ item: 'integrity_human_soul', name: 'Integrity Human Soul', emoji: '💙', chance: 1.0 }], exp: { min: 75, max: 77 } },
  },
  bravery_human: {
    id: 'bravery_human', name: 'BRAVERY',
    description: 'The orange human SOUL.',
    hp: 220, atk: 26, def: 15, type: 'Melee',
    passive: null, weight: 25, tier: 'badTime',
    abilities: [
      { name: 'Punch barrage', description: 'Does what its supposed to.', type: 'Melee', damageMin: 4, damageMax: 4, maxUses: 15, special: { type: 'multiHit', minHits: 9, maxHits: 12 } },
      { name: 'NOT gonna sugar coat it', description: 'A counter — if a player hits Bravery while the counter is active, they get hit with 40 true dmg.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'braveryCounter', trueDmg: 40 } },
    ],
    rewards: { soulEssence: { min: 75, max: 77, chance: 1.0 }, dtVial: { min: 75, max: 77, chance: 1.0 }, extraDrops: [{ item: 'bravery_human_soul', name: 'Bravery Human Soul', emoji: '🧡', chance: 1.0 }], exp: { min: 75, max: 77 } },
  },
  patience_human: {
    id: 'patience_human', name: 'PATIENCE',
    description: 'The light blue human SOUL.',
    hp: 200, atk: 22, def: 22, type: 'Weapon/Melee',
    passive: null, weight: 25, tier: 'badTime',
    abilities: [
      { name: 'Toy rush', description: 'Hurts surprisingly more than u think for a toy knife.', type: 'Weapon', damageMin: 30, damageMax: 40, maxUses: 15, special: null },
      { name: 'Patience grab', description: 'Patience just grabs u and slams u onto the ground.', type: 'Melee', damageMin: 35, damageMax: 35, maxUses: 10, special: { type: 'stun', chance: 0.35 } },
    ],
    rewards: { soulEssence: { min: 75, max: 77, chance: 1.0 }, dtVial: { min: 75, max: 77, chance: 1.0 }, extraDrops: [{ item: 'patience_human_soul', name: 'Patience Human Soul', emoji: '💙', chance: 1.0 }], exp: { min: 75, max: 77 } },
  },
  preserverence_human: {
    id: 'preserverence_human', name: 'PRESERVERENCE',
    description: 'The purple human SOUL.',
    hp: 300, atk: 16, def: 25, type: 'Magic/Unique',
    passive: null, weight: 25, tier: 'badTime',
    abilities: [
      { name: 'Full analysis', description: 'Preserverence checks all the player stats and rewrites them.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'multiDebuff', enemyDef: -5, enemyAtk: -5 } },
      { name: 'Book trap', description: 'Stuns the player for 1 turn.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'stun', chance: 1.0 } },
      { name: 'I cast fireball!', description: 'Preserverence just learns magic and casts a fireball.', type: 'Fire', damageMin: 27, damageMax: 27, maxUses: 15, special: { type: 'burn', burnChance: 1.0, duration: 2 } },
    ],
    rewards: { soulEssence: { min: 75, max: 77, chance: 1.0 }, dtVial: { min: 75, max: 77, chance: 1.0 }, extraDrops: [{ item: 'perseverance_human_soul', name: 'Perseverance Human Soul', emoji: '💜', chance: 1.0 }], exp: { min: 75, max: 77 } },
  },
  determination_human: {
    id: 'determination_human', name: 'DETERMINATION',
    description: 'The red human SOUL. The final challenge.',
    hp: 450, atk: 28, def: 30, type: 'Unique/Magic',
    passive: null, weight: 5, tier: 'badTime', isMiniBoss: true,
    abilities: [
      { name: 'Weapon conjuration', description: 'Determination summons the real knife from their Determination and cuts the player.', type: 'Weapon', damageMin: 45, damageMax: 45, maxUses: 15, special: null },
      { name: 'WELCOME TO MY SPECIAL HELL', description: 'Determination summons a SPECIAL HELL.', type: 'Magic', damageMin: 55, damageMax: 55, maxUses: 10, special: null },
      { name: 'ERASE', description: 'This move can only be used once. Deals true 99 damage.', type: 'Unique', damageMin: 99, damageMax: 99, maxUses: 1, special: { type: 'trueDamage', amount: 99 } },
    ],
    rewards: { soulEssence: { min: 78, max: 86, chance: 1.0 }, dtVial: { min: 78, max: 86, chance: 1.0 }, extraDrops: [{ item: 'dt_soul', name: 'DT Soul', emoji: '💗', chance: 1.0, min: 2, max: 4 }, { item: 'determination_soul', name: 'Determination Soul', emoji: '❤️', chance: 0.40 }], exp: { min: 78, max: 86 } },
  },
};

// --- BOSSES (separate from regular encounters) ---
const BOSSES = {
  // --- SCAMPTON [[THE GREAT]] (event boss; ChromaKey Pieces + Event Boss Ticket) ---
  scamton_the_great: {
    id: 'scamton_the_great', name: 'SCAMPTON [[THE GREAT]]',
    description: '"[[LIGHTBRINGERS]] YOU ARE HERE! I\'M SO EXCITED, I COULD [[Die.]]"',
    hp: 800, atk: 12, def: 12, type: 'None',
    passive: { name: 'THE TRUE POWER OF [[NEO]]!!!', description: 'At 300 HP or less, your UI is erased and replaced with a button sequence. Clear 3 sequences to return to normal. Failing damages your whole party.', type: 'neoPower', threshold: 300, rounds: 3 },
    isBoss: true, isEvent: true,
    fixedParty: ['asriel_rewritten', 'noelle_rewritten', 'charkis'],
    abilities: [
      { name: 'PIPIS POPPER', description: '[[Prepare]] FOR MY [[PATENTED]] PIPIS POPPER! Hits 1-3 times and can strike any party member, even off the field.', type: 'Unique', damageMin: 10, damageMax: 20, maxUses: 20, special: { type: 'pipisPopper', minHits: 1, maxHits: 3, canHitBench: true } },
      { name: '[[HEART]] ATTACK!', description: 'I BRING MY [[HEART]] OUT TO YOU [[SCAMPS]]! +5% crit. Below 2000 HP: 75% chance to hit again. Below 1000 HP: 50% chance to hit again.', type: 'Melee', damageMin: 20, damageMax: 25, maxUses: 15, special: { type: 'heartAttack', critBonus: 0.05, threshold1: 2000, chance1: 0.75, threshold2: 1000, chance2: 0.50 } },
      { name: 'CARDS OF [[FATE]]', description: '[PICK A [[Card]], ANY [[KAARD]]!] Four cards appear. Pick one within 10 seconds or fate picks for you.', type: 'Magic', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'cardsOfFate', timerSeconds: 10, healMin: 20, healMax: 30, damageMin: 30, damageMax: 40 } },
      { name: 'BIGSHOT EXPRESS', description: 'ALL ABOARD THE BIGSHOT EXPRESS!!! +4 DEF for 4 turns, locked in for 3 turns. Can strike any party member, even off the field.', type: 'None', damageMin: 10, damageMax: 20, maxUses: 5, special: { type: 'bigshotExpress', defBoost: 4, defTurns: 4, lockTurns: 3, canHitBench: true } },
    ],
    rewards: { soulEssence: { min: 5000, max: 5000, chance: 1.0 }, determination: { min: 20010, max: 20010 }, exp: { min: 100, max: 150 } },
  },
  // --- JEVIL, THE LOUSY DEVIL (normal /boss) ---
  jevil: {
    id: 'jevil', name: 'JEVIL, THE LOUSY DEVIL!',
    description: '"DON\'T RUN! IT RUINS THE FUN! AND MOST IMPORTANTLY, WE\'VE ONLY JUST BEGUN."',
    hp: 666, atk: 24, def: 19, type: 'None',
    passive: { name: 'THE WORLD REVOLVING!', description: 'After each turn, you are forced to switch to another character. When Jevil runs out of attacks, the fight ends.', type: 'theWorldRevolving' },
    isBoss: true,
    abilities: [
      { name: 'DIAMOND WAVES!', description: 'CHAOS! CHAOS! CATCH ME IF YOU CAN!', type: 'None', damageMin: 15, damageMax: 25, maxUses: 25, special: { type: 'jevilDiamondWaves', dodgeChance: 0.5, dodgeGain: 0.05, dodgeCap: 0.30 } },
      { name: 'CHAOS BOX!', description: 'HEHEHAHAHAHAH! I NEVER HAD SUCH FUN!', type: 'None', damageMin: 15, damageMax: 20, maxUses: 20, special: { type: 'jevilChaosBox', stunDuration: 3 } },
      { name: "DEVIL'S KNIFE.", description: 'HAHA! LETS MAKE THE DEVIL\'S KNIFE.', type: 'None', damageMin: 10, damageMax: 35, maxUses: 15, special: { type: 'jevilDevilsKnife', critBonus: 0.30, weaknessBonus: 10 } },
      { name: 'CAROUSEL OF CALAMITY!', description: 'PIIP PIIP, LETS RIDE THE CAROUSEL GAME!', type: 'None', damageMin: 20, damageMax: 20, maxUses: 15, special: { type: 'jevilCarousel', base: 20, step: 15, lockTurns: 2 } },
    ],
    rewards: { soulEssence: { min: 100, max: 180, chance: 1.0 }, dtVial: { min: 1, max: 2, chance: 0.30 }, determination: { min: 50, max: 80 }, exp: { min: 60, max: 100 } },
  },
  toriel: {
    id: 'toriel', name: 'Toriel',
    description: 'The Caretaker of the Ruins. She is willing to do anything in her power to make you stay.',
    hp: 250, atk: 6, def: 10, type: 'Unique/Magic',
    passive: { name: 'HADOUKEN!', description: 'First 3 attacks apply Burn.', type: 'hadouken', attacksLeft: 3 },
    isBoss: true,
    abilities: [
      { name: 'Fireball', description: 'Applies Burn 2 turns.', type: 'Magic', damageMin: 12, damageMax: 18, maxUses: 25, special: { type: 'burn', duration: 2 } },
      { name: 'Fireball Waves', description: 'Sweeping wave. Burn 2 turns.', type: 'Magic', damageMin: 15, damageMax: 22, maxUses: 15, special: { type: 'burn', duration: 2 } },
      { name: 'Fireball Helix', description: 'Concentrated spiral. Burn 3 turns.', type: 'Magic', damageMin: 25, damageMax: 30, maxUses: 5, special: { type: 'burn', duration: 3, cooldown: 1 } },
      { name: 'Faltering Attack', description: 'Reduces your DEF by 2.', type: 'Unique', damageMin: 5, damageMax: 5, maxUses: 10, special: { type: 'debuff', stat: 'def', amount: -2, target: 'enemy' } },
    ],
    rewards: { stolenFlames: { amount: 1, chance: 0.33 }, soulEssence: { min: 50, max: 80, chance: 1.0 }, dtVial: { min: 5, max: 10, chance: 1.0 }, determination: { min: 15, max: 25 }, exp: { min: 30, max: 50 } },
  },
  papyrus: {
    id: 'papyrus', name: 'Papyrus',
    description: '"I shall capture u human, and then they will finally let me to become a Royal Guard!!"',
    hp: 300, atk: 9, def: 10, type: 'Bone/Unique',
    passive: null, isBoss: true,
    abilities: [
      { name: 'Bone Barrage', description: 'A barrage of bones.', type: 'Bone', damageMin: 18, damageMax: 24, maxUses: 20, special: null },
      { name: 'Blue Bones', description: 'Deals damage if you attack. A trap.', type: 'Bone', damageMin: 10, damageMax: 40, maxUses: 15, special: { type: 'blueBones' } },
      { name: 'Blue Soul', description: 'DEF -3 and 50% Stun for 1 turn.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'blueSoulBoss', defReduce: 3, stunChance: 0.5 } },
      { name: 'Special Attack', description: '20% fail chance. If fail, +2 DEF. Cooldown 3.', type: 'Bone', damageMin: 25, damageMax: 35, maxUses: 5, special: { type: 'specialAttack', failChance: 0.2, defBoostOnFail: 2, cooldown: 3 } },
    ],
    rewards: { papyrusScarf: { amount: 1, chance: 1/15 }, headDog: { amount: 1, chance: 1/45 }, papyrusSkull: { amount: 1, chance: 1/40 }, echoFlowers: { amount: 1, chance: 0.05 }, orangeJacket: { amount: 1, chance: 1/30 }, theFlower: { amount: 1, chance: 1/60 }, ketchup_gun: { amount: 1, chance: 0.10 }, pesto_sauce: { amount: 1, chance: 0.10 }, soulEssence: { min: 40, max: 60, chance: 1.0 }, dtVial: { min: 5, max: 10, chance: 1.0 }, determination: { min: 15, max: 25 }, exp: { min: 25, max: 40 } },
  },
  idutshane_boss: {
    id: 'idutshane_boss', name: 'IDUTSHANE',
    description: '"A husk of what once was."',
    hp: 500, atk: 4, def: 27, type: 'Bone',
    passive: { name: 'A Dead Man Walking', description: 'Immune to stat debuffs. Every 100 damage dealt loses 1 DEF.', type: 'deadManWalking' },
    isBoss: true,
    abilities: [
      { name: 'Bone Throw', description: 'A basic bone throw.', type: 'Bone', damageMin: 25, damageMax: 25, maxUses: 99, special: null },
      { name: 'Broken Gaster Blaster', description: 'A broken but powerful blaster.', type: 'Magic', damageMin: 30, damageMax: 30, maxUses: 99, special: null },
      { name: 'Shovel', description: 'Causes 3 turns of Bleed.', type: 'Weapon', damageMin: 32, damageMax: 32, maxUses: 99, special: { type: 'applyStatus', status: 'bleed' } },
      { name: 'Bone Zone', description: 'Hits ALL characters in party.', type: 'Bone', damageMin: 33, damageMax: 33, maxUses: 99, special: { type: 'aoeAttack' } },
    ],
    specialAbility: { name: 'Burial', charges: 3, description: 'One-shots a character and locks them for 3 encounters.' },
    rewards: { brokenDtVial: { amount: 1, chance: 0.2 }, shovelItem: { amount: 1, chance: 1.0 }, dtVial: { min: 15, max: 25, chance: 1.0 }, determination: { min: 30, max: 50 }, exp: { min: 40, max: 60 } },
  },
  undyne: {
    id: 'undyne', name: 'Undyne',
    description: 'The head of the Royal Guard. She fights with everything she has — and then some.',
    hp: 300, atk: 15, def: 10, type: 'Melee/Magic',
    passive: { name: 'DETERMINATION', description: 'Below 50% HP: transforms into Undyne the Undying (+10 ATK, heals 5–10 HP/turn, new moveset).', type: 'undynePhase2' },
    isBoss: true,
    abilities: [
      { name: 'Spear Throw', description: 'A precise spear.', type: 'Melee', damageMin: 10, damageMax: 15, maxUses: 20, special: null },
      { name: 'Spear Volley', description: 'Multi-hit, high crit chance.', type: 'Melee', damageMin: 5, damageMax: 12, maxUses: 20, special: { type: 'multiHit', minHits: 2, maxHits: 4, critBonus: 0.2 } },
      { name: 'Ground Skewer', description: '10% stun chance.', type: 'Melee', damageMin: 17, damageMax: 22, maxUses: 10, special: { type: 'stun', chance: 0.1 } },
      { name: 'Spear Circle', description: 'Multi-hit spear ring.', type: 'Magic', damageMin: 15, damageMax: 20, maxUses: 5, special: { type: 'multiHit', minHits: 2, maxHits: 3 } },
    ],
    phase2Abilities: [
      { name: 'Suplex', description: 'Raw melee slam.', type: 'Melee', damageMin: 10, damageMax: 15, maxUses: 20, special: null },
      { name: 'Spear Storm', description: '5 hits. 50% poison chance per hit.', type: 'Magic', damageMin: 5, damageMax: 10, maxUses: 15, special: { type: 'multiHit', minHits: 5, maxHits: 5, poisonChance: 0.5 } },
      { name: 'Arrows of Justice', description: 'Bypasses 10% of enemy DEF.', type: 'Melee', damageMin: 15, damageMax: 25, maxUses: 5, special: { type: 'arrowsOfJustice', defBypass: 0.1 } },
      { name: 'Final Determination', description: 'Only usable below 10% HP. 30-40 dmg. Sets own HP to 1 after. 1 use only.', type: 'Unique', damageMin: 30, damageMax: 40, maxUses: 1, special: { type: 'finalDetermination', hpThreshold: 0.1, selfHpAfter: 1 } },
    ],
    rewards: { soulEssence: { min: 80, max: 120, chance: 1.0 }, dtVial: { min: 15, max: 25, chance: 1.0 }, determination: { min: 30, max: 50 }, spear: { amount: 1, chance: 1/15 }, exp: { min: 50, max: 80 } },
  },
  wd_gaster: {
    id: 'wd_gaster', name: 'W.D. Gaster',
    description: '"Beware of the man who speaks in hands."',
    hp: 666, atk: 26, def: 16, type: 'Magic/Unique',
    passive: { name: 'Duality', description: 'Alternates Red (+4 ATK) and Blue (+4 DEF) each turn.', type: 'duality' },
    isBoss: true,
    abilities: [
      { name: 'Hands of Fate', description: 'Randomly applies Burn, Poison, or Stun.', type: 'Magic', damageMin: 15, damageMax: 30, maxUses: 25, special: { type: 'handsOfFate' } },
      { name: 'Monotone Beam', description: 'Charges 1 turn, massive damage. DEF reduced to 0 during charge.', type: 'Magic', damageMin: 30, damageMax: 40, maxUses: 10, special: { type: 'charge', chargeMessage: 'is charging **Monotone Beam**... DEF reduced to 0!', selfDebuff: { atk: 0, def: -999 } } },
      { name: '᲼᲼᲼᲼', description: '10% chance to double hit.', type: 'Unique', damageMin: 20, damageMax: 30, maxUses: 10, special: { type: 'gasterSymbol' } },
      { name: 'Giant Gaster Blasters', description: 'Applies Poison for 3 turns. Not stackable. 2 turn cooldown.', type: 'Magic', damageMin: 25, damageMax: 35, maxUses: 5, special: { type: 'applyStatus', status: 'poison', cooldown: 2 } },
    ],
    rewards: { soulEssence: { min: 150, max: 300, chance: 0.5 }, dtVial: { min: 10, max: 15, chance: 1.0 }, tier1MonsterSoul: { min: 5, max: 8, chance: 1.0 }, tier2MonsterSoul: { min: 3, max: 6, chance: 0.5 }, gastersHands: { amount: 1, chance: 1/5 }, hisGuidance: { amount: 1, chance: 1/15 }, dtInjector: { amount: 1, chance: 1/5 }, inkBrush: { amount: 1, chance: 1/20 }, cosmicDust: { amount: 1, chance: 0.06 }, extraDrops: [{ item: 'chromakey_piece_b', chance: 0.30, name: 'ChromaKey Piece B', emoji: '\u{1F7E9}' }], determination: { min: 30, max: 50 }, exp: { min: 60, max: 100 } },
  },
  time_paradox_boss: {
    id: 'time_paradox_boss', name: 'Time Paradox',
    description: 'Two timelines colliding. ainavol? and agem? at once.',
    hp: 400, atk: 17, def: 17, type: 'Bone/Magic',
    passive: { name: 'Time Split', description: 'Every 2 turns switches between Ainavol (ATK 12, DEF 17) and Agem (ATK 17, DEF 12) stats.', type: 'timeSplit' },
    isBoss: true,
    abilities: [
      { name: 'Trio Blasters', description: '35% karma if hits 3 times.', type: 'Magic', damageMin: 16, damageMax: 22, maxUses: 15, special: { type: 'trioBlasters', karmaChance: 0.35 } },
      { name: 'Portal Pillar', description: '35% karma + 50% stun.', type: 'Unique', damageMin: 16, damageMax: 22, maxUses: 15, special: { type: 'portalPillar', karmaChance: 0.35, stunChance: 0.5 } },
      { name: 'Bone Spasm', description: 'Small chance burn or electrified.', type: 'Bone', damageMin: 13, damageMax: 18, maxUses: 20, special: { type: 'boneSpasm' } },
      { name: 'Arm Blaster', description: 'Chance to inflict Karma.', type: 'Magic', damageMin: 23, damageMax: 36, maxUses: 5, special: { type: 'armBlaster', karmaChance: 0.35, cooldown: 1 } },
    ],
    rewards: { brokenClock: { amount: 1, chance: 1.0 }, timeOrb: { amount: 1, chance: 0.05 }, soulEssence: { min: 100, max: 150, chance: 1.0 }, dtVial: { min: 10, max: 20, chance: 1.0 }, determination: { min: 30, max: 50 }, exp: { min: 60, max: 90 } },
  },
  asgore: {
    id: 'asgore', name: 'Asgore',
    description: '"Human... It was nice to meet you. Goodbye."',
    hp: 700, atk: 22, def: 24, type: 'Melee/Fire',
    passive: { name: "King's Hesitation", description: 'First 2 turns: -10% accuracy. After turn 5, becomes "Determined": +4 ATK and +4 DEF permanently.', type: 'kingsHesitation' },
    isBoss: true,
    abilities: [
      { name: 'Trident Slashes', description: 'Multiple slashes. 20% chance to lower enemy DEF by 2.', type: 'Melee', damageMin: 18, damageMax: 22, maxUses: 25, special: { type: 'tridentSlashes', defReduceChance: 0.2, defReduceAmount: 2 } },
      { name: 'Blazing Spirals', description: 'Rings of fire close in. Applies Burn for 2 turns.', type: 'Fire', damageMin: 14, damageMax: 18, maxUses: 20, special: { type: 'burn', duration: 2 } },
      { name: 'Judgment Flash', description: 'Guaranteed hit even through Blindness. Deals 1.2x damage if enemy healed last turn.', type: 'Melee', damageMin: 20, damageMax: 24, maxUses: 15, special: { type: 'judgmentFlash' } },
      { name: 'Fire Walls', description: 'Charge-up: skips this turn. Next turn releases an unblockable 45-50 fire blast.', type: 'Fire', damageMin: 45, damageMax: 50, maxUses: 5, special: { type: 'chargeUp', chargeMessage: 'Asgore is gathering fire... **Fire Walls** incoming!', unblockable: true } },
    ],
    rewards: { agoresTrident: { amount: 1, chance: 1/5 }, crownOfTheKing: { amount: 1, chance: 1/50 }, tier3MonsterSoul: { min: 2, max: 3, chance: 0.20 }, soulEssence: { min: 150, max: 200, chance: 1.0 }, determination: { min: 70, max: 120, chance: 1.0 }, exp: { min: 70, max: 100 } },
  },
  // --- UPDATE 13 BOSSES ---
  mafia_sans_boss: {
    id: 'mafia_sans_boss', name: 'Mafia Sans',
    description: '"Capisce? Don\'t make me whack you, kid."',
    hp: 180, atk: 18, def: 17, type: 'Weapon/Unique',
    passive: { name: 'Bodyguards', description: 'First 3 turns: 15% DMG reduction. Magic hits get blocked: 20% less damage + 10 fixed retaliation.', type: 'bodyguards' },
    isBoss: true,
    abilities: [
      { name: 'Bone Grenade', description: '30% chance to ignore 10% DEF, 25% chance to flinch.', type: 'Bone', damageMin: 12, damageMax: 15, maxUses: 20, special: { type: 'boneGrenade', defIgnoreChance: 0.3, defIgnoreAmount: 0.1, flinchChance: 0.25 } },
      { name: 'Tommy Gun Burst', description: '2-6 hits. Each hit 5% Bleed. 4+ hits = -10% enemy damage next turn.', type: 'Weapon', damageMin: 5, damageMax: 10, maxUses: 15, special: { type: 'tommyGunBurst', minHits: 2, maxHits: 6, bleedPerHit: 0.05, weakenThreshold: 4 } },
      { name: 'Bribery', description: '50% chance: -30% enemy accuracy 2 turns. If used after turn 3 vs Boss: 20% heal 10% HP instead.', type: 'Unique', damageMin: 17, damageMax: 21, maxUses: 10, special: { type: 'bribery', accuracyDebuff: 0.30, debuffDuration: 2, healChance: 0.2, healPercent: 0.1, cooldown: 1 } },
      { name: 'The Contract', description: 'For next 2 turns, every time enemy attacks, they take 15% recoil damage.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'theContract', duration: 2, recoilPercent: 0.15, cooldown: 3 } },
    ],
    rewards: { mafiaHat: { amount: 1, chance: 1.0 }, soulEssence: { min: 80, max: 130, chance: 1.0 }, dtVial: { min: 5, max: 10, chance: 1.0 }, determination: { min: 30, max: 60 }, exp: { min: 50, max: 80 } },
  },
  mettaton_neo: {
    id: 'mettaton_neo', name: 'Mettaton NEO',
    description: '"The premiere human-eradication robot, finally deployed with its offensive systems fully operational. Dr. Alphys\' greatest, and last masterpiece."',
    hp: 400, atk: 17, def: 15, type: 'Magic/Unique',
    passive: { name: 'Showtime!', description: 'Every time Mettaton NEO deals damage, his ATK and DEF increase by +1 (Stacks up to 5).', type: 'showtime' },
    isBoss: true,
    abilities: [
      { name: 'Arm Cannon', description: 'Bypasses 15% of enemy DEF.', type: 'Magic', damageMin: 10, damageMax: 20, maxUses: 20, special: { type: 'armCannonNeo', defPiercePercent: 0.15 } },
      { name: 'Mini-Mettatons', description: '1-4 hits. Each hit 3% chance to stun (~12% total).', type: 'Unique', damageMin: 8, damageMax: 15, maxUses: 15, special: { type: 'miniMettatons', minHits: 1, maxHits: 4, stunPerHit: 0.03 } },
      { name: 'Bomb Square', description: 'Big square AOE blast.', type: 'Unique', damageMin: 20, damageMax: 25, maxUses: 10, special: { type: 'bombSquare', cooldown: 2 } },
      { name: 'Rocket Kick', description: 'If KOs target, Mettaton restores 20 HP.', type: 'Melee', damageMin: 20, damageMax: 30, maxUses: 5, special: { type: 'rocketKick', healOnKill: 20, cooldown: 3 } },
    ],
    rewards: { neoCannon: { amount: 1, chance: 1/3 }, alphysTech: { amount: 1, chance: 1/5 }, emptyGun: { amount: 1, chance: 1/5 }, tier1MonsterSoul: { min: 2, max: 5, chance: 0.5 }, soulEssence: { min: 100, max: 200, chance: 1.0 }, dtVial: { min: 5, max: 12, chance: 1.0 }, determination: { min: 50, max: 75 }, exp: { min: 70, max: 100 } },
  },
  omega_flowey: {
    id: 'omega_flowey', name: 'Omega Flowey',
    description: '"Sparing me won\'t change anything. Killing me is the only way to end this. After all... it\'s a \'kill or be killed\' world."',
    hp: 850, atk: 23, def: 22, type: 'Magic/Unique',
    passive: { name: 'Glitchy Save', description: 'Every 2 turns Flowey tries to SAVE. Attacking him on save turn drops his DEF by 2 that turn. Not attacking heals him 100 HP.', type: 'glitchySave' },
    isBoss: true,
    abilities: [
      { name: 'Pellet Barrage', description: 'Every use, +5% Accuracy or Crit Chance (stacks up to 25%).', type: 'Magic', damageMin: 15, damageMax: 20, maxUses: 20, special: { type: 'pelletBarrage', stackPerUse: 0.05, maxStack: 0.25 } },
      { name: 'Vine Strikes', description: '25% chance enemy skips next turn (stuck in vines).', type: 'Magic', damageMin: 18, damageMax: 25, maxUses: 15, special: { type: 'vineStrikes', skipChance: 0.25 } },
      { name: 'X-Bombs', description: 'Chance to apply Burn 2 turns.', type: 'Unique', damageMin: 20, damageMax: 30, maxUses: 10, special: { type: 'xBombs', burnChance: 0.4, burnDuration: 2 } },
      { name: 'Mouth Beam', description: 'Opponent\'s next attack has 20% miss chance from "vibrations".', type: 'Unique', damageMin: 25, damageMax: 35, maxUses: 5, special: { type: 'mouthBeam', missDebuff: 0.2 } },
    ],
    rewards: { humanSoulRandom: { amount: 1, chance: 1.0 }, vines: { amount: 1, chance: 0.1 }, soulEssence: { min: 400, max: 400, chance: 1.0 }, dtVial: { min: 15, max: 25, chance: 1.0 }, determination: { min: 100, max: 150 }, exp: { min: 100, max: 150 } },
  },
  // --- UPDATE 15 BOSSES ---
  bad_time_sans: {
    id: 'bad_time_sans', name: 'Bad Time Sans',
    description: '"you\'re gonna have a bad time."',
    hp: 500, atk: 30, def: 17, type: 'Bone/Magic',
    passive: { name: 'Perfect Evasion', description: 'Guaranteed dodge for first 5 attacks. After that, dodge drops to 40%. All attacks apply KR. Below 5% HP, KR drains over 3 turns and player is locked. On turn 4, Sans falls asleep — dodge becomes 0%.', type: 'perfectEvasion' },
    isBoss: true,
    abilities: [
      { name: 'Bone Hell', description: 'Hits 10-30 times. ATK does not affect damage. Doubles damage if player used a Defensive move last turn.', type: 'Bone', damageMin: 1, damageMax: 1, maxUses: 20, special: { type: 'boneHell', minHits: 10, maxHits: 30 } },
      { name: 'Gaster Blaster Circle', description: 'Massive blaster circle. 40% chance to disable enemy Dodge/Block for next turn.', type: 'Magic', damageMin: 13, damageMax: 22, maxUses: 15, special: { type: 'gbCircleBT', dodgeBlockDisableChance: 0.4 } },
      { name: 'Gravity Manipulation', description: '75% chance to reduce enemy ATK by 3 for 2 turns. 50% chance to stun.', type: 'Magic', damageMin: 15, damageMax: 15, maxUses: 10, special: { type: 'gravityManipBT', atkDebuffChance: 0.75, atkAmount: 3, atkTurns: 2, stunChance: 0.5 } },
      { name: 'Final Stand', description: 'If enemy below 20% HP, instant kill + Sans gets 2 guaranteed dodges next 2 turns.', type: 'Unique', damageMin: 20, damageMax: 30, maxUses: 5, special: { type: 'finalStandBT', hpThreshold: 0.2 } },
    ],
    rewards: { umbrella: { amount: 1, chance: 0.05 }, sans_magic_eye: { amount: 1, chance: 0.05 }, ketchup_bottle: { amount: 1, chance: 0.10 }, baseball_bat: { amount: 1, chance: 0.20 }, sans_jacket: { amount: 1, chance: 0.05 }, soulEssence: { min: 150, max: 230, chance: 1.0 }, determination: { min: 80, max: 120 }, exp: { min: 60, max: 110 } },
  },
  cosmic_dust_boss: {
    id: 'cosmic_dust_boss', name: 'Cosmic Dust',
    description: 'A swirling cloud of dust from beyond the stars.',
    hp: 140, atk: 20, def: 17, type: 'Galactic/Unique',
    passive: { name: 'Cosmic Dust', description: 'Applies Blindness to the enemy every 5 turns for 2 turns.', type: 'cosmicDustPassive', interval: 5, blindnessDuration: 2 },
    isBoss: true, isEvent: true,
    abilities: [
      { name: 'WormHole', description: 'Sucks the enemy through a wormhole.', type: 'Unique', damageMin: 50, damageMax: 50, maxUses: 10, special: null },
      { name: 'Bone stabs', description: 'Sharp bones jab from below. Bleed for 1 turn.', type: 'Bone', damageMin: 23, damageMax: 25, maxUses: 15, special: { type: 'bleed', chance: 1.0, duration: 1 } },
      { name: 'Scepter Smash', description: 'KR effect for 1 turn.', type: 'Melee', damageMin: 12, damageMax: 23, maxUses: 15, special: { type: 'karma', chance: 1.0, duration: 1 } },
      { name: 'Blasters', description: 'Cosmic blasters.', type: 'Magic', damageMin: 12, damageMax: 34, maxUses: 25, special: null },
    ],
    rewards: { soulEssence: { min: 100, max: 200, chance: 1.0 }, determination: { min: 50, max: 100 }, exp: { min: 50, max: 80 } },
  },
  // --- GALACTIC EVENT: M87 (returning event boss) ---
  m87_boss: {
    id: 'm87_boss', name: 'M87',
    description: '"Try not to fall into the void. Heh."',
    hp: 1240, atk: 26, def: 25, type: 'Galactic/Magic',
    passive: { name: 'Just a Little Help', description: 'Every 4 turns, a meteor has a 2% chance to fall and deal 150 damage.', type: 'justALittleHelp', chance: 0.02, damage: 150, everyTurns: 4 },
    isBoss: true, isEvent: true, isGalacticEvent: true,
    abilities: [
      { name: 'Blaster Fusion', description: 'Twin blasters merge into a single beam.', type: 'Magic', damageMin: 10, damageMax: 29, maxUses: 10, special: null },
      { name: 'M B Z', description: 'Space folds inward.', type: 'Unique', damageMin: 14, damageMax: 45, maxUses: 5, special: { type: 'gravityEffect' } },
      { name: 'Time Space Cut', description: 'A clean cut through spacetime.', type: 'Magic', damageMin: 13, damageMax: 25, maxUses: 15, special: { type: 'gravityEffect' } },
      { name: 'BLACKHOLE: COLLISION.', description: 'Devastating cosmic collision. Usable only after 35 turns. 6666 turn cooldown.', type: 'Unique', damageMin: 250, damageMax: 250, maxUses: 5, special: { type: 'blackholeCollision', minTurn: 35, cooldown: 6666 } },
    ],
    rewards: {
      blackhole: { amount: 1, chance: 0.06 },
      phoenix_a: { amount: 1, chance: 0.05 },
      stardust_item: { amount: 1, chance: 0.15 },
      supernova: { amount: 1, chance: 0.10 },
      exp: { min: 60, max: 100 },
    },
  },
  // --- GALACTIC EVENT: Fallen Stars (returning event boss) ---
  fallen_stars_boss: {
    id: 'fallen_stars_boss', name: 'Fallen Stars',
    description: '"I am beyond the stars. The cosmic dust was waiting. BlackHoles collide, ah. Such beautiful things won\'t you agree?"',
    hp: 950, atk: 27, def: 23, type: 'Galactic/Unique',
    passive: { name: 'StarDust', description: 'Immune to status effects, debuffs and multi-hits. Disables any character that tries for one turn.', type: 'starDust' },
    isBoss: true, isEvent: true, isGalacticEvent: true,
    abilities: [
      { name: 'Gravity Slam', description: 'Punch + Slam + ouch.', type: 'Unique', damageMin: 11, damageMax: 24, maxUses: 15, special: { type: 'highGravity', chance: 0.4 } },
      { name: 'Celestial Bones', description: 'KABOOOM.', type: 'Bone', damageMin: 13, damageMax: 27, maxUses: 10, special: { type: 'blindness', chance: 1, duration: 2 } },
      { name: 'Cosmic Blasters', description: 'what.', type: 'Magic', damageMin: 11, damageMax: 21, maxUses: 25, special: { type: 'krChance', chance: 0.35 } },
      { name: 'Star Rain', description: 'Can only be used ONCE after 15 turns.', type: 'Unique', damageMin: 125, damageMax: 125, maxUses: 5, special: { type: 'starRain', minTurn: 15 } },
    ],
    rewards: {
      sirius: { amount: 1, chance: 0.12 },
      star_shard: { amount: 1, chance: 0.30 },
      soulEssence: { min: 600, max: 600, chance: 1 },
      determination: { min: 250, max: 250, chance: 0.15 },
      exp: { min: 60, max: 100 },
    },
  },
  the_outering_one_boss: {
    id: 'the_outering_one_boss', name: 'The Outering One',
    description: '"i alone... am the outering one."',
    hp: 350, atk: 26, def: 12, type: 'Galactic/Unique',
    passive: { name: 'Cosmic Healing', description: 'Heals 10 HP at the start of each turn.', type: 'cosmicHealing', healAmount: 10 },
    isBoss: true, isEvent: true,
    abilities: [
      { name: 'Space Control: BlackHole', description: 'A blackhole tears at the enemy.', type: 'Magic', damageMin: 21, damageMax: 27, maxUses: 25, special: null },
      { name: 'Space Technique: Gamma ray', description: 'A piercing gamma ray.', type: 'Magic', damageMin: 11, damageMax: 22, maxUses: 25, special: null },
      { name: 'Domain Expansion. COSMIC.', description: 'Stuns the enemy for 5 turns. When it ends, you get stunned for 5 turns.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'domainExpansion', stunDuration: 5, selfStunDuration: 5 } },
      { name: 'OUTER TECHNIQUE. NOVA.', description: 'Devastating cosmic blast — but has a big chance to miss.', type: 'Unique', damageMin: 100, damageMax: 100, maxUses: 5, special: { type: 'outerNova', missChance: 0.6 } },
    ],
    rewards: { exp: { min: 30, max: 50 } },
  },
  training_dummy: {
    id: 'training_dummy', name: 'Training Dummy',
    description: 'Made for testing moves and damage. Pick its type with `/train`.',
    hp: 999999, atk: 0, def: 0, type: 'Unique',
    passive: null,
    isBoss: true,
    abilities: [
      { name: 'Stand Still', description: 'The dummy does nothing.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 9999, special: null },
    ],
    rewards: {},
  },
  // --- UPDATE 15 BOSS ---
  sans_question: {
    id: 'sans_question', name: 'Sans?',
    description: 'HP: 666. Something is very wrong.',
    hp: 666, atk: 26, def: 26, type: 'Bone/Unique',
    passive: { name: 'Anomalous Interference', description: 'Every 3 turns copies one of player\'s moves.', type: 'anomalousInterference', interval: 3 },
    isBoss: true,
    abilities: [
      { name: 'Bone Throw?', description: 'A familiar bone throw.', type: 'Bone', damageMin: 18, damageMax: 26, maxUses: 20, special: null },
      { name: 'Gaster Blasters?', description: '2 hits. 20% Poison 2 turns.', type: 'Unique', damageMin: 14, damageMax: 20, maxUses: 15, special: { type: 'gasterBlastersQ', hits: 2, poisonChance: 0.2 } },
      { name: 'Anomalous Burst', description: '25% chance to Stun for 1 turn.', type: 'Bone', damageMin: 22, damageMax: 30, maxUses: 10, special: { type: 'stun', chance: 0.25 } },
      { name: 'Attack Reflection', description: 'If player used a damaging move last turn, 30% chance to reflect.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'attackReflectionBoss', chance: 0.3, cooldown: 1 } },
    ],
    rewards: { vhsTape: { amount: 1, chance: 1.0 }, stolenSlash: { amount: 1, chance: 0.25 }, administratorPermissions: { amount: 1, chance: 0.0666 }, dtSoul: { min: 2, max: 4, chance: 1.0 }, soulEssence: { min: 80, max: 120, chance: 1.0 }, dtVial: { min: 8, max: 15, chance: 1.0 }, determination: { min: 40, max: 70 }, exp: { min: 60, max: 90 } },
  },
  // --- UPDATE 17 BOSSES ---
  nightmare_sans_boss: {
    id: 'nightmare_sans_boss', name: 'Nightmare Sans',
    description: '"sleep tight."',
    hp: 750, atk: 19, def: 19, type: 'Weapon/Unique',
    passive: { name: 'ENRAGED/help', description: 'Under 50% HP, becomes ENRAGED: +4 DEF, +4 ATK, status immune. Calls Horror Sans / Killer Sans / Dust Sans (JHall) every 3 turns to use one of their attacks.', type: 'enragedHelpBoss', hpThreshold: 0.5, atkBoost: 4, defBoost: 4, callInterval: 3 },
    isBoss: true,
    abilities: [
      { name: 'Tentacle Slam', description: 'A massive tentacle slam. 50 damage.', type: 'Melee', damageMin: 50, damageMax: 50, maxUses: 20, special: null },
      { name: 'Tentacle Barrage', description: '4-5 hits each doing 10-15 damage. Disabled while Tentacle Shield is up.', type: 'Melee', damageMin: 10, damageMax: 15, maxUses: 15, special: { type: 'multiHit', minHits: 4, maxHits: 5 } },
      { name: 'Negative Apple', description: 'Heals Nightmare 50 HP and damages the enemy for 25.', type: 'Food', damageMin: 25, damageMax: 25, maxUses: 5, special: { type: 'negativeApple', healAmount: 50 } },
      { name: 'Tentacle Shield', description: 'Gives Nightmare 90 Shield HP. Disables Tentacle Barrage until shield breaks.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'tentacleShield', shieldAmount: 90 } },
    ],
    rewards: { corruptApple: { amount: 1, chance: 1/50 }, negativeEssence: { amount: 1, chance: 1/5 }, killersSoul: { amount: 1, chance: 1/25 }, corruption: { amount: 1, chance: 0.05 }, soulEssence: { min: 100, max: 175, chance: 1.0 }, dtVial: { min: 10, max: 20, chance: 1.0 }, determination: { min: 50, max: 90 }, exp: { min: 60, max: 100 } },
  },
  fatalerror_sans_boss: {
    id: 'fatalerror_sans_boss', name: 'FatalError!Sans',
    description: '"THEY\'RE ALL DEAD. I KILLED THEM ALL. AND YOU\'RE NEXT."',
    hp: 800, atk: 22, def: 22, type: 'Bone/Magic/Unique',
    passive: { name: 'UNKNOWN ERROR.', description: 'Fatal\'s stats change every turn like Gaster, and he heals +1 HP after every turn.', type: 'unknownErrorBoss', healPerTurn: 1 },
    isBoss: true,
    abilities: [
      { name: 'B0N3S.', description: 'Applies Karma and Glitched effect for 2 turns.', type: 'Bone', damageMin: 13, damageMax: 17, maxUses: 15, special: { type: 'fatalBones', karmaDuration: 2, glitchedDuration: 2 } },
      { name: 'STR1NGS.', description: '20% chance to cause Stun for 2 turns. Inflicts Glitched for 1 turn.', type: 'Weapon', damageMin: 10, damageMax: 20, maxUses: 15, special: { type: 'fatalStrings', stunChance: 0.2, stunDuration: 2, glitchedDuration: 1 } },
      { name: 'ERROR CODE: 404', description: 'Fatal\'s ATK buffs by 3 for 1 turn. 50% chance to Blind the enemy for 3 turns.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'errorCode404', atkBoost: 3, blindDuration: 3, blindChance: 0.5, cooldown: 5 } },
      { name: 'BL4STERS.', description: 'Shoots 2 rotating blasters. 5% chance to heal 3% HP. Applies Scary KR, Karma and Glitched for 2 turns.', type: 'Magic', damageMin: 13, damageMax: 17, maxUses: 10, special: { type: 'fatalBlasters', healChance: 0.05, healPercent: 0.03, scaryKRDuration: 2, karmaDuration: 2, glitchedDuration: 2, cooldown: 3 } },
    ],
    rewards: { fatalsBone: { amount: 1, chance: 0.03 }, glitchedStar: { amount: 1, chance: 0.05 }, soulEssence: { min: 100, max: 175, chance: 1.0 }, dtVial: { min: 10, max: 20, chance: 1.0 }, determination: { min: 50, max: 90 }, exp: { min: 60, max: 100 } },
  },
  // --- UPDATE 19 BOSS ---
  roaring_knight_boss: {
    id: 'roaring_knight_boss', name: 'The Roaring Knight',
    description: '"THE KNIGHT WHICH MAKES WITH BLACKENED KNIFE SHALL DUEL WITH SKELETONS STRIFE BY STRIFE"',
    hp: 1350, atk: 22, def: 20, type: 'Weapon',
    passive: { name: 'Strife by Strife', description: 'Every 3 turns, one of the player\'s 4 moves is MARKED. If used: player is SWOON\'d (instant kill) and damage heals the boss. If not used: move is purified back to normal.', type: 'strifeByStrife', interval: 3 },
    isBoss: true,
    abilities: [
      { name: 'Sword Throw', description: 'Swords spin and fly forward. 40% chance to inflict Bleed for 2 turns. If Knife Thrust was used last turn, deals +5 bonus damage.', type: 'Weapon', damageMin: 20, damageMax: 35, maxUses: 20, special: { type: 'rkBossSwordThrow', bleedChance: 0.40, bleedDuration: 2, knifeBonus: 5 } },
      { name: 'Star Storm', description: 'Stars form and explode. Inflicts 2 Star Shards status effects on the active character.', type: 'Unique', damageMin: 15, damageMax: 30, maxUses: 15, special: { type: 'rkBossStarStorm', starShardsStacks: 2 } },
      { name: 'Knife Thrust', description: 'A swift knife thrust. 10% chance to force-switch the active character to the next slot.', type: 'Weapon', damageMin: 20, damageMax: 40, maxUses: 15, special: { type: 'rkBossKnifeThrust', forceSwitchChance: 0.10 } },
      { name: 'Reality Cut', description: 'The tear of reality drains -3 uses from one of the active character\'s moves.', type: 'Unique', damageMin: 27, damageMax: 39, maxUses: 10, special: { type: 'rkBossRealityCut', usesDrain: 3 } },
    ],
    rewards: { determination: { min: 200, max: 300 }, soulEssence: { min: 550, max: 700, chance: 1.0 }, expAllTeam: { amount: 100 }, blackShard: { amount: 1, chance: 1.0 }, shadowCrystal: { amount: 1, chance: 0.10 }, exp: { min: 80, max: 100 } },
  },
  // --- UPDATE 20 BOSSES ---
  pesti_sans_boss: {
    id: 'pesti_sans_boss', name: 'Pesti Sans',
    description: '"We all rust someday."',
    hp: 1019, atk: 27, def: 25, type: 'Weapon/Unique',
    passive: { name: 'We all rust someday', description: 'All attacks apply Rust for 3 turns.', type: 'weAllRustSomeday', rustDuration: 3, isBossVersion: true },
    isBoss: true,
    abilities: [
      { name: 'INFECTED GASTER BLASTERS', description: '25% chance to apply Rust for 2 turns. Also has a 50% chance to miss.', type: 'Magic', damageMin: 20, damageMax: 25, maxUses: 18, special: { type: 'infectedGasterBlasters', rustChance: 0.25, rustDuration: 2, missChance: 0.5 } },
      { name: 'OSTEOKINESIS', description: '70% chance to apply Rust.', type: 'Bone', damageMin: 15, damageMax: 20, maxUses: 20, special: { type: 'applyRust', chance: 0.7 } },
      { name: 'PIPE BASH', description: 'Applies Bleed for 3 turns.', type: 'Weapon', damageMin: 22, damageMax: 25, maxUses: 25, special: { type: 'bleed', chance: 1.0, duration: 3 } },
      { name: 'CONCENTRATED PIPE BLAST', description: 'Massive blast — deals 200 fixed damage and applies Rust for 3 turns. Deals 100 damage to self. 5 turn cooldown.', type: 'Magic', damageMin: 200, damageMax: 200, maxUses: 5, special: { type: 'concentratedPipeBlast', selfDamage: 100, rustDuration: 3, cooldown: 5 } },
    ],
    rewards: { rusted_metal_pipe: { amount: 1, chance: 0.25 }, soulEssence: { min: 200, max: 350, chance: 1.0 }, dtVial: { min: 20, max: 30, chance: 1.0 }, determination: { min: 80, max: 130 }, exp: { min: 80, max: 120 } },
  },
  him_boss: {
    id: 'him_boss', name: 'HIM',
    description: '"The void beckons as HE arrives... you should have took its hint seriously, now u stand before the man who speaks in hands... prepare for your imminent DOOM."',
    hp: 1222, atk: 28, def: 26, type: 'Cosmic/Unique',
    passive: { name: 'Full admin access', description: 'HIM has complete control over the console of the game. His stats are randomized, and every 3 turns one of these happens: player character switched with another at random, player loses 7 ATK and DEF, player stunned, or player gets every debuff excluding Stun.', type: 'fullAdminAccess', interval: 3 },
    isBoss: true,
    isSuperboss: true,
    abilities: [
      { name: 'VOID BLASTER', description: 'A giant dark blaster is summoned by HIM. 30% chance to inflict Blindness.', type: 'Cosmic', damageMin: 30, damageMax: 35, maxUses: 25, special: { type: 'blindness', chance: 0.30 } },
      { name: 'HANDHELD DESTRUCTION', description: 'HE slams his hands onto the ground, rocks fly around. Hits 2-3 times. For every 30% HP HE loses, +15 damage but -5 uses. At 50% HP or below, 20% chance to inflict Blindness.', type: 'Melee', damageMin: 10, damageMax: 10, maxUses: 20, special: { type: 'handheldDestruction' } },
      { name: 'THE HANDS', description: 'Giant hands fire 2 devastating dark beams (multi-hit). Inflicts Blindness and Karma.', type: 'Magic', damageMin: 16, damageMax: 18, maxUses: 15, special: { type: 'theHands', hits: 2 } },
      { name: 'PLATFORM DISRUPTION', description: 'Grabs the platform and makes it spin. Inflicts Blindness. 40% chance to Stun.', type: 'Unique', damageMin: 30, damageMax: 32, maxUses: 10, special: { type: 'platformDisruption', stunChance: 0.40 } },
    ],
    rewards: { gasters_hands: { min: 2, max: 5, chance: 1.0 }, his_guidance: { min: 2, max: 5, chance: 1.0 }, cosmic_dust: { min: 1, max: 3, chance: 0.60 }, dt_injector: { min: 3, max: 6, chance: 0.80 }, void_catalyst: { amount: 1, chance: 0.40 }, soulEssence: { min: 500, max: 800, chance: 1.0 }, determination: { min: 200, max: 400 }, exp: { min: 100, max: 150 } },
  },
};

// Weighted random enemy selection
function pickRandomEnemy(tier = 'medium') {
  const enemies = Object.values(ENEMIES).filter(e => e.tier === tier && !e.isMiniBoss);
  const miniBosses = Object.values(ENEMIES).filter(e => e.tier === tier && e.isMiniBoss);
  // 15% chance for a mini boss to spawn (if any exist for this tier)
  if (miniBosses.length > 0 && Math.random() < 0.15) {
    return miniBosses[Math.floor(Math.random() * miniBosses.length)];
  }
  if (enemies.length === 0) return Object.values(ENEMIES)[0];
  const totalWeight = enemies.reduce((sum, e) => sum + (e.weight || 1), 0);
  let roll = Math.random() * totalWeight;
  for (const enemy of enemies) {
    roll -= (enemy.weight || 1);
    if (roll <= 0) return enemy;
  }
  return enemies[0];
}

// --- CRAFTING RECIPES ---
const RECIPES = {
  monster_soul: {
    id: 'monster_soul', name: 'Monster Soul',
    description: 'Use it to get a Sans, or save it for crafting.',
    ingredients: { dt_vial: 5 },
    result: { type: 'item', itemId: 'monster_soul' },
  },
  tier1_monster_soul: {
    id: 'tier1_monster_soul', name: 'Tier 1 Monster Soul',
    description: 'Use on Sans for Fell/Outer (50/50), or on nothing for Swap Sans.',
    ingredients: { monster_soul: 2, dt_vial: 5 },
    result: { type: 'item', itemId: 'tier1_monster_soul' },
  },
  save_star: {
    id: 'save_star', name: 'Save Star',
    description: 'Use on a Level 3+ Sans to get Killer Sans.',
    ingredients: { tier1_monster_soul: 2, soul_essence: 50, dt_vial: 7, star_piece: 5 },
    result: { type: 'item', itemId: 'save_star' },
  },
  tier2_monster_soul: {
    id: 'tier2_monster_soul', name: 'Tier 2 Monster Soul',
    description: 'Use on Underswap Sans (+120 Soul Essence) to get Swapswap Sans.',
    ingredients: { tier1_monster_soul: 2, monster_soul: 1, soul_essence: 75, dt_vial: 4 },
    result: { type: 'item', itemId: 'tier2_monster_soul' },
  },
  // --- UPDATE 13 RECIPES ---
  tommy_gun: {
    id: 'tommy_gun', name: 'Tommy Gun',
    description: 'A loaded weapon for Mafiatale Sans. Crafted from 10x A Gun...?',
    ingredients: { a_gun: 10 },
    result: { type: 'item', itemId: 'tommy_gun' },
  },
  stolen_monster_magic: {
    id: 'stolen_monster_magic', name: 'Stolen Monster Magic',
    description: 'Magical residue from all defeated bosses. Used for Outerdust Sans and JHall Dust.',
    ingredients: { stolen_flames: 1, papyrus_scarf: 1, spear: 1, a_gun: 1, asgores_trident: 1 },
    result: { type: 'item', itemId: 'stolen_monster_magic' },
  },
  void_tablet: {
    id: 'void_tablet', name: 'Void Tablet',
    description: 'A tablet from beyond the void. Used in /fuse for Call of the Void Sans.',
    ingredients: { his_guidance: 20, alphys_tech: 5, tier1_monster_soul: 250, determination: 15000 },
    result: { type: 'item', itemId: 'void_tablet' },
  },
  green_coat: {
    id: 'green_coat', name: 'Green Coat',
    description: 'A green coat for Storyshift Chara. Crafted from Orange Jacket + Tier 3 Monster Soul.',
    ingredients: { orange_jacket: 1, tier3_monster_soul: 1 },
    result: { type: 'item', itemId: 'green_coat' },
  },
  purple_jacket: {
    id: 'purple_jacket', name: 'Purple Jacket',
    description: 'A smoky jacket for Swapfell Papyrus. Crafted from Orange Jacket + Cigarette Pack.',
    ingredients: { orange_jacket: 1, cigarette_pack: 1 },
    result: { type: 'item', itemId: 'purple_jacket' },
  },
  crimson_coat: {
    id: 'crimson_coat', name: 'Crimson Coat',
    description: 'A blood-stained coat for Storyfell Chara. Requires Vines, Green Coat, and 3 Real Knives.',
    ingredients: { vines: 1, green_coat: 1, real_knife: 3, soul_essence: 6000 },
    result: { type: 'item', itemId: 'crimson_coat' },
  },
  // --- UPDATE 15 RECIPES ---
  inevitability: {
    id: 'inevitability', name: 'Inevitability',
    description: 'A grim symbol of the inevitable. Used on Lv5 Sans for Tears in the Rain Sans.',
    ingredients: { umbrella: 1, patience_human_soul: 15, justice_human_soul: 15, papyrus_scarf: 25 },
    result: { type: 'item', itemId: 'inevitability' },
  },
};

// --- ITEMS ---
const ITEMS = {
  dt_vial: { id: 'dt_vial', name: 'DT Vial', emoji: '🧪', description: 'Used for crafting.', stackable: true },
  soul_essence: { id: 'soul_essence', name: 'Soul Essence', emoji: '💜', description: 'Side currency.', stackable: true },
  star_piece: { id: 'star_piece', name: 'Star Piece', emoji: '🌟', description: 'A shimmering star fragment.', stackable: true },
  monster_soul: { id: 'monster_soul', name: 'Monster Soul', emoji: '💀', description: 'Use to get Sans, or save for crafting.', stackable: true },
  tier1_monster_soul: { id: 'tier1_monster_soul', name: 'Tier 1 Monster Soul', emoji: '🔥', description: 'Use on Sans or on nothing.', stackable: true },
  tier2_monster_soul: { id: 'tier2_monster_soul', name: 'Tier 2 Monster Soul', emoji: '💎', description: 'Use on Underswap Sans.', stackable: true },
  save_star: { id: 'save_star', name: 'Save Star', emoji: '💫', description: 'Use on Level 3+ Sans for Killer Sans.', stackable: true },
  stolen_flames: { id: 'stolen_flames', name: 'Stolen Flames', emoji: '🔥', description: 'Dropped by Toriel. Use on Sans for Ruins Dust Sans.', stackable: true },
  blackhole: { id: 'blackhole', name: 'Blackhole', emoji: '🕳️', description: 'Dropped by M87 Boss. Use on Outer Sans for M87.', stackable: true },
  papyrus_scarf: { id: 'papyrus_scarf', name: "Papyrus' Scarf", emoji: '🧣', description: 'Use on Ruins Dust Sans for Snowdin Dust Sans.', stackable: true },

  broken_dt_vial: { id: 'broken_dt_vial', name: 'Broken DT Vial', emoji: '🧪', description: 'A cracked vial. Used for Hyperdust characters.', stackable: true },
  head_dog: { id: 'head_dog', name: 'Head Dog', emoji: '🐶', description: 'A cursed head. Use on a Level 5 Sans (+150 Soul Essence) for Horror Sans.', stackable: true },
  tier3_monster_soul: { id: 'tier3_monster_soul', name: 'Tier 3 Monster Soul', emoji: '💎', description: 'Purchasable from the shop. Use for advanced characters.', stackable: true },
  shiny_star: { id: 'shiny_star', name: 'Shiny Star', emoji: '🌠', description: 'Makes any character shiny. Purchase from shop.', stackable: true },
  event_boss_ticket: { id: 'event_boss_ticket', name: 'Event Boss Ticket', emoji: '🎟️', description: 'Required to fight event bosses.', stackable: true },
  galactic_ticket: { id: 'galactic_ticket', name: 'Galactic Ticket', emoji: '🌌', description: 'Required to fight the Galactic Event bosses (M87, Fallen Stars). Buy from /shop.', stackable: true },
  spear: { id: 'spear', name: 'Spear', emoji: '🔱', description: 'Dropped by Undyne. Use on Snowdin Dust Sans to get Waterfall Dust Sans.', stackable: true },
  gasters_hands: { id: 'gasters_hands', name: "Gaster's Hands", emoji: '🖐️', description: 'Dropped by W.D. Gaster. Use to get W.D. Gaster character.', stackable: true },
  his_guidance: { id: 'his_guidance', name: 'His Guidance', emoji: '👁️', description: 'Dropped by W.D. Gaster. Use on a Level 5 Sans to get Last Breath Sans.', stackable: true },
  dt_injector: { id: 'dt_injector', name: 'DT Injector', emoji: '💉', description: 'Dropped by W.D. Gaster. Used with Papyrus\' Skull on Sans to get Insanity Sans.', stackable: true },
  echo_flowers: { id: 'echo_flowers', name: 'Echo Flowers', emoji: '🌸', description: 'Dropped by Papyrus. Requires Sans on team to use. Gives [ * sans encounter].', stackable: true },
  papyrus_skull: { id: 'papyrus_skull', name: "Papyrus' Skull", emoji: '💀', description: 'Dropped by Papyrus. Use alone for Papyrus character, or combine with DT Injector on Sans for Insanity Sans.', stackable: true },
  orange_jacket: { id: 'orange_jacket', name: 'Orange Jacket', emoji: '🧡', description: '1/30 drop from Papyrus boss. Use on Underswap Sans + 500 SE (with Underswap Sans on team) for Underswap Papyrus.', stackable: true },
  glitched_strings: { id: 'glitched_strings', name: 'Glitched Strings', emoji: '🧵', description: 'Obtainable from /scavenge. Used to obtain Error Sans.', stackable: true },
  save_star_menu: { id: 'save_star_menu', name: 'Save Star Menu', emoji: '💾', description: 'Obtainable from /scavenge. Use on Lv5 Sans + 400 SE for Geno Sans.', stackable: true },
  lethal_deal: { id: 'lethal_deal', name: 'Lethal Deal', emoji: '🃏', description: 'Obtainable from /scavenge.', stackable: true },
  a_gun: { id: 'a_gun', name: 'A Gun...?', emoji: '🔫', description: 'Obtainable from /scavenge.', stackable: true },
  paint_vials: { id: 'paint_vials', name: 'Paint Vials', emoji: '🎨', description: 'Obtainable from /scavenge. Used for Ink Sans.', stackable: true },
  hatred: { id: 'hatred', name: 'Hatred.', emoji: '💢', description: 'Obtainable from /scavenge.', stackable: true },
  juice_eyes: { id: 'juice_eyes', name: 'Juice that gives you eyes', emoji: '👁️', description: 'Obtainable from /scavenge.', stackable: true },
  ink_brush: { id: 'ink_brush', name: 'Ink Brush', emoji: '🖌️', description: '1/20 drop from W.D. Gaster boss. Used with 6 Tier 3 Monster Souls + Lv5 Sans for Ink Sans.', stackable: true },
  broken_clock: { id: 'broken_clock', name: 'Broken Clock', emoji: '🕰️', description: 'Dropped by Time Paradox boss. Can substitute Waterfall Dust in /fuse for Time Paradox.', stackable: true },
  the_flower: { id: 'the_flower', name: 'The Flower', emoji: '🌼', description: '1/60 drop from Papyrus boss. Use Echo Flowers on Papyrus char with this in inventory + 500 SE for Revenge Papyrus.', stackable: true },
  car_battery: { id: 'car_battery', name: 'Car Battery', emoji: '🔋', description: '8% drop from "a forced grin." event boss. Used to obtain the playable character.', stackable: true },
  // --- UPDATE 11 ITEMS ---
  time_orb: { id: 'time_orb', name: 'Time Orb', emoji: '🔵', description: '5% drop from Time Paradox boss. Use on Sans with 10,000 Soul Essence + 2,500 Determination for FT!Sans, or sell for 500 Determination.', stackable: true },
  parasite: { id: 'parasite', name: 'Parasite', emoji: '🦠', description: '3% drop from /scavenge. Use on Fresh Sans to obtain True Fresh!Sans.', stackable: true },
  crown_of_the_king: { id: 'crown_of_the_king', name: 'Crown of the King', emoji: '👑', description: '2% drop from Asgore boss. Use on Sans to obtain StoryShift! Sans.', stackable: true },
  asgores_trident: { id: 'asgores_trident', name: "Asgore's Trident", emoji: '🔱', description: '1/5 drop from Asgore boss. Used for crafting.', stackable: true },
  cat_food: { id: 'cat_food', name: 'Cat Food', emoji: '🐱', description: 'Rare drop from the Gacha (Legendary). Use to obtain Sansfield.', stackable: true },
  blue_bone: { id: 'blue_bone', name: 'Blue Bone', emoji: '🦴', description: 'Rare drop from the Gacha (Legendary). Required to obtain UV Swap Sans via /fuse.', stackable: true },
  // --- UPDATE 12 ITEMS ---
  axe_thousand_souls: { id: 'axe_thousand_souls', name: 'Axe of a Thousand Souls', emoji: '🪓', description: 'Rare drop from the Gacha (Legendary, 5%). Used to fuse Weak C!Insanity into C!Insanity.', stackable: true },
  axe_hundred_thousand_souls: { id: 'axe_hundred_thousand_souls', name: 'Axe of a Hundred Thousand Souls', emoji: '🪓', description: 'Ultra rare drop from the Gacha (Legendary, 1%). Used to fuse C!Insanity into Final Insanity.', stackable: true },
  blade_omniverse: { id: 'blade_omniverse', name: 'Blade of the Omniverse', emoji: '⚔️', description: 'Rare drop from the Gacha (Legendary, 2%). Used to fuse Weak Avenge Sans into Avenge Sans.', stackable: true },
  shattered_kindness_soul: { id: 'shattered_kindness_soul', name: 'Shattered Kindness Soul', emoji: '💚', description: '5% drop from /scavenge. Required to fuse Final Insanity.', stackable: true },
  integrity_soul: { id: 'integrity_soul', name: 'Integrity Soul', emoji: '💙', description: '10% drop from /scavenge. Required to fuse Avenge Sans.', stackable: true },
  // --- UPDATE 13 ITEMS ---
  // Mafiatale Sans set
  tommy_gun: { id: 'tommy_gun', name: 'Tommy Gun', emoji: '🔫', description: 'Crafted from 10x A Gun...?. Used for Mafiatale Sans.', stackable: true },
  mafia_hat: { id: 'mafia_hat', name: 'Mafia Hat', emoji: '🎩', description: 'Dropped by Mafia Sans boss. Used for Mafiatale Sans.', stackable: true },
  cigarette_pack: { id: 'cigarette_pack', name: 'Cigarette Pack', emoji: '🚬', description: '15% drop from Epic Gacha tier. Used for Mafiatale Sans and Purple Jacket crafting.', stackable: true },
  // Outerdust set
  cosmic_dust: { id: 'cosmic_dust', name: 'Cosmic Dust', emoji: '🌌', description: '6% drop from W.D. Gaster. Used for Outerdust Sans.', stackable: true },
  stolen_monster_magic: { id: 'stolen_monster_magic', name: 'Stolen Monster Magic', emoji: '🪄', description: 'Crafted from Stolen Flames + Papyrus\' Skull + Spear. Used for Outerdust Sans.', stackable: true },
  // Mettaton NEO drops
  neo_cannon: { id: 'neo_cannon', name: 'Neo Cannon', emoji: '💥', description: '1/3 drop from Mettaton NEO boss. Use on Waterfall Dust Sans for Hotlands Dust Sans.', stackable: true },
  alphys_tech: { id: 'alphys_tech', name: 'Alphys\' Tech', emoji: '🔧', description: '1/5 drop from Mettaton NEO boss. Used for crafting Void Tablet.', stackable: true },
  empty_gun: { id: 'empty_gun', name: 'Empty Gun', emoji: '🔫', description: '1/5 drop from Mettaton NEO boss. Use on Hotlands Dust Sans for Core Dust Sans.', stackable: true },
  // Storyshift/Storyfell Chara
  green_coat: { id: 'green_coat', name: 'Green Coat', emoji: '🧥', description: 'Crafted from Orange Jacket + Tier 3 Monster Soul. Used for Storyshift Chara.', stackable: true },
  crimson_coat: { id: 'crimson_coat', name: 'Crimson Coat', emoji: '🧥', description: 'Crafted from Vines + 1 Green Coat + 3 Real Knives + 6,000 SE. Used for Storyfell Chara.', stackable: true },
  real_knife: { id: 'real_knife', name: 'Real Knife', emoji: '🔪', description: '1/99 drop from ANY boss/encounter. Used for Storyshift/Storyfell Chara.', stackable: true },
  // Call of the Void
  void_tablet: { id: 'void_tablet', name: 'Void Tablet', emoji: '📜', description: 'Crafted from 20x His Guidance + 5x Alphys\' Tech + 250x Tier 1 Monster Souls + 15,000 Determination. Used in /fuse for Call of the Void Sans.', stackable: true },
  // Swapfell Papyrus
  purple_jacket: { id: 'purple_jacket', name: 'Purple Jacket', emoji: '💜', description: 'Crafted from Orange Jacket + Cigarette Pack. Used for Swapfell Papyrus.', stackable: true },
  // Hardmode Sans
  hardmode_essence: { id: 'hardmode_essence', name: 'Hardmode Essence', emoji: '🩵', description: 'Bought from Negativetale\'s Shop for 25,000 Determination. Use on Lv5 Sans (+10,000 SE) for Hardmode Sans.', stackable: true },
  // Dustfell Sans
  dusty_fur_hood: { id: 'dusty_fur_hood', name: 'Dusty Fur Hood', emoji: '🧥', description: '5% drop from Rare Gacha tier. Used for Dustfell Sans.', stackable: true },
  chains: { id: 'chains', name: 'Chains', emoji: '⛓️', description: '10% drop from /scavenge. Used for Dustfell Sans.', stackable: true },
  baseball_bat: { id: 'baseball_bat', name: 'Baseball Bat', emoji: '🏏', description: '20% drop from Bad Time Sans boss. Used to fuse Storyspin Sans (Sans + Chara + Baseball Bat).', stackable: true },
  sans_jacket: { id: 'sans_jacket', name: "Sans' Jacket", emoji: '🧥', description: '5% (1/20) drop from Bad Time Sans boss. Used with 100 Papyrus Scarfs + 20 Papyrus Skulls on Papyrus for Papyrus Belief.', stackable: true },
  // Omega Flowey drops
  vines: { id: 'vines', name: 'Vines', emoji: '🌿', description: '1/10 drop from Omega Flowey boss. Used for crafting Crimson Coat.', stackable: true },
  // Six Human Souls (1/6 each from Omega Flowey, 1 guaranteed)
  patience_human_soul: { id: 'patience_human_soul', name: 'Patience Human Soul', emoji: '💙', description: '1/6 chance drop from Omega Flowey. Used for future content.', stackable: true },
  bravery_human_soul: { id: 'bravery_human_soul', name: 'Bravery Human Soul', emoji: '🧡', description: '1/6 chance drop from Omega Flowey. Used for Delta Sans (and future content).', stackable: true },
  integrity_human_soul: { id: 'integrity_human_soul', name: 'Integrity Human Soul', emoji: '💙', description: '1/6 chance drop from Omega Flowey. Used for future content.', stackable: true },
  perseverance_human_soul: { id: 'perseverance_human_soul', name: 'Perseverance Human Soul', emoji: '💜', description: '1/6 chance drop from Omega Flowey. Used for future content.', stackable: true },
  kindness_human_soul: { id: 'kindness_human_soul', name: 'Kindness Human Soul', emoji: '💚', description: '1/6 chance drop from Omega Flowey. Used for future content.', stackable: true },
  justice_human_soul: { id: 'justice_human_soul', name: 'Justice Human Soul', emoji: '💛', description: '1/6 chance drop from Omega Flowey. Used for future content.', stackable: true },
};

const STATUS_EFFECTS = {
  poison: { name: 'Poison', emoji: '🟢', damagePerTurn: 3, duration: 3, description: '3 dmg/turn for 3 turns.' },
  bleed: { name: 'Bleed', emoji: '🔴', damagePerTurn: 5, duration: 3, description: '5 dmg/turn for 3 turns.' },
  burn: { name: 'Burn', emoji: '🟠', damagePerTurn: 4, duration: 2, description: '4 dmg/turn for 2 turns.' },
  burn3: { name: 'Burn', emoji: '🟠', damagePerTurn: 4, duration: 3, description: '4 dmg/turn for 3 turns.' },
  flinch: { name: 'Flinch', emoji: '😵', duration: 1, description: 'Cannot attack this turn.' },
  blueSoul: { name: 'Blue Soul', emoji: '💙', duration: 2, description: 'DEF reduced by 5 for 2 turns.', defReduction: 5 },
  boneField: { name: 'Bone Field', emoji: '🦴', duration: 5, description: 'Takes 5-10 dmg when using ability.' },
  boneZone: { name: 'Bone Zone', emoji: '🦴', damagePerTurn: 10, duration: 3, description: '10 dmg/turn for 3 turns.' },
  stun: { name: 'Stun', emoji: '💫', duration: 1, description: 'Cannot attack for 1 turn.' },
  karma: { name: 'Karma', emoji: '☯️', damageOnAttack: 5, duration: 3, description: 'Takes 5 damage whenever they attack for 3 turns.' },
  scaryKR: { name: 'Scary KR', emoji: '☯️', damageOnAttack: 10, duration: 5, description: 'Takes 10 damage whenever they attack for 5 turns.' },
  electrified: { name: 'Electrified', emoji: '⚡', damageOnAttack: 6, duration: 2, description: 'Takes 6 damage when using an attacking move for 2 turns.' },
  blindness: { name: 'Blindness', emoji: '👁️', missChance: 0.2, duration: 2, description: '20% miss chance for 2 turns.' },
  glitched: { name: 'Glitched', emoji: '🔀', duration: 3, description: 'Heals deal damage instead for 3 turns.' },
  orangeSoul: { name: 'Orange Soul', emoji: '🧡', duration: 2, description: 'Takes 10% more damage from Underswap Papyrus.' },
  ink: { name: 'Ink', emoji: '🖌️', damagePerTurn: 6, duration: 2, description: '6 dmg/turn for 2 turns.' },
  silence: { name: 'Silence', emoji: '🔇', duration: 2, description: 'Cannot use Unique moves for 2 turns.' },
  inkTrail: { name: 'Ink Trail', emoji: '🎨', duration: 3, description: 'Enemy has +20% miss chance. Consumed by Ink Sans Melee to auto-dodge next attack.' },
  shieldHp: { name: 'Shield HP', emoji: '🛡️', duration: 999, description: 'Temporary HP that can exceed max HP.' },
  // --- UPDATE 13 STATUS EFFECTS ---
  hazy: { name: 'Hazy', emoji: '😵', duration: 999, description: 'Each stack reduces accuracy by 10% (max 5 stacks). Permanent unless cleared, or 2 turns after hitting cap.' },
  madness: { name: 'Madness', emoji: '🔱', duration: 999, description: 'Dustfell ATK/DEF modifier. Every 2 stacks: ATK+2, DEF-1 (caps at 10).' },
  bound: { name: 'Bound', emoji: '⛓️', duration: 2, description: 'Cannot switch out. The user\'s next attack has 100% accuracy.' },
  blueSoulCotV: { name: 'Blue Soul (Heavy)', emoji: '💙', duration: 1, description: 'Passive disabled, +10% miss chance for 1 turn.' },
  hellfire: { name: 'Hellfire', emoji: '🔥', damagePerTurn: 8, duration: 2, description: '8 dmg/turn for 2 turns (worse than Burn).' },
  coreCharge: { name: 'Core Charge', emoji: '⚛️', duration: 999, description: 'Core Dust\'s charge counter. Surge after 3 stacks.' },
  showtime: { name: 'Showtime!', emoji: '🎭', duration: 999, description: 'Mettaton NEO ATK/DEF buff (+1 each per stack, max 5).' },
  phantomBrother: { name: 'Phantom Brother', emoji: '👻', duration: 999, description: 'Spectral Papyrus deals +10 True Damage at end of each turn.' },
  bonesOfDespair: { name: 'Bones of Despair', emoji: '🦴', duration: 999, description: 'Defensive bones blocking enemy attack on next turn.' },
  contractRecoil: { name: 'Contract Recoil', emoji: '📜', duration: 2, description: 'Takes 15% recoil damage when attacking the user.' },
  weightOfGuilt: { name: 'Weight of Guilt', emoji: '⚖️', duration: 999, description: 'Healing items only restore 50% while Hardmode Sans is active.' },
  blueRestrict: { name: 'Blue Restriction', emoji: '🔵', duration: 1, description: 'Restricted to first 2 moves only (next turn).' },
  finalGambit: { name: 'Final Gambit', emoji: '⚠️', duration: 1, description: 'Forced to skip next attack/use status only.' },
};

// --- UPDATE 15 ITEMS ---
ITEMS.umbrella = { id: 'umbrella', name: 'Umbrella', emoji: '☂️', description: 'A purple umbrella. Obtainable from /scavenge (3%) or Bad Time Sans boss (5%). Used to craft Inevitability.', stackable: true };
ITEMS.inevitability = { id: 'inevitability', name: 'Inevitability', emoji: '❗', description: 'Craftable. Use on a Lv5 Sans (with 8750 DT and 11890 SE on team) to get Tears in the Rain Sans. SE is wasted.', stackable: true };
ITEMS.phoenix_a = { id: 'phoenix_a', name: 'Phoenix A', emoji: '🔥', description: 'Dropped by M87 event boss. Use on Outer Sans to get The Outering One.', stackable: true };
ITEMS.sirius = { id: 'sirius', name: 'Sirius', emoji: '⭐', description: 'Dropped by Fallen Stars event boss. Use on Outer Sans to get Galaxy Sans.', stackable: true };
ITEMS.stardust_item = { id: 'stardust_item', name: 'Stardust', emoji: '✨', description: 'Cosmic dust dropped by M87.', stackable: true };
ITEMS.supernova = { id: 'supernova', name: 'Supernova', emoji: '💥', description: 'Dropped by M87 event boss.', stackable: true };
ITEMS.star_shard = { id: 'star_shard', name: 'Star Shard', emoji: '🌟', description: 'Dropped by Fallen Stars event boss.', stackable: true };
ITEMS.broken_star_shard = { id: 'broken_star_shard', name: 'Broken Star Shard', emoji: '💫', description: 'A cracked Star Shard. Use on Outer Sans to get Fallen Stars character.', stackable: true };
ITEMS.ketchup_gun = { id: 'ketchup_gun', name: 'Ketchup Gun', emoji: '🔫', description: '1/10 drop from Papyrus boss. Used in TS!Sans/Crossbones fusion.', stackable: true };
ITEMS.flame_eye_item = { id: 'flame_eye_item', name: 'Flame Eye', emoji: '👁️‍🗨️', description: 'Granted by the BROKEN LIMITS achievement. Used in Flame Eye fusion.', stackable: true };
ITEMS.sans_magic_eye = { id: 'sans_magic_eye', name: "Sans' Magic Eye", emoji: '👁️', description: 'Dropped by Bad Time Sans.', stackable: true };
ITEMS.ketchup_bottle = { id: 'ketchup_bottle', name: 'Ketchup Bottle', emoji: '🍅', description: 'Dropped by Bad Time Sans.', stackable: true };

// --- UPDATE 15 ITEMS ---
ITEMS.dt_soul = { id: 'dt_soul', name: 'DT Soul', emoji: '💗', description: 'New crafting currency. Drops from all enemies and bosses. Craft 7 for a Determination Soul.', stackable: true };
ITEMS.determination_soul = { id: 'determination_soul', name: 'Determination Soul', emoji: '❤️', description: 'Crafted from 7 DT Souls. Use on yourself for a guaranteed Frisk.', stackable: true };
ITEMS.portable_core = { id: 'portable_core', name: 'Portable CORE', emoji: '🔷', description: 'Crafted from 3 Time Orbs + 3 Gaster\'s Hands + 3 DT Injectors + 3 His Guidance + 3 Echo Flowers. Use on Frisk for Core Frisk.', stackable: true };
ITEMS.kris_sword = { id: 'kris_sword', name: 'Kris\' Sword', emoji: '⚔️', description: 'Epic Gacha 7% drop. Use on yourself to get Kris.', stackable: true };
ITEMS.susies_axe = { id: 'susies_axe', name: 'Susie\'s Axe', emoji: '🪓', description: 'Epic Gacha 7% drop. Use on yourself to get Susie.', stackable: true };
ITEMS.comically_long_blunt = { id: 'comically_long_blunt', name: 'Comically Long Blunt', emoji: '🚬', description: 'Epic Gacha 7% drop. Use on yourself to get Ralsei.', stackable: true };
ITEMS.empowered_kindness_soul = { id: 'empowered_kindness_soul', name: 'Empowered Kindness Soul', emoji: '💚', description: 'Crafted (requires C!Insanity in team). Use on yourself for Rose.', stackable: true };
ITEMS.cowboy_hat = { id: 'cowboy_hat', name: 'Cowboy Hat', emoji: '🤠', description: 'Rare Gacha 10% drop. Use Empty Gun + Cowboy Hat for Clover.', stackable: true };
ITEMS.frosty_antlers = { id: 'frosty_antlers', name: 'Frosty Antlers', emoji: '🦌', description: 'Epic Gacha 7% drop. Use on yourself to get Noelle.', stackable: true };
ITEMS.thorn_ring = { id: 'thorn_ring', name: 'Thorn Ring', emoji: '💍', description: 'Crafted from 25 Thorns. Use on Lv2 Noelle (with Lv2 Kris in party) for Noelle (Snowgrave).', stackable: true };
ITEMS.thorns = { id: 'thorns', name: 'Thorns', emoji: '🌹', description: '100% drop from Omega Flowey (1-3 per kill). Used to craft Thorn Ring.', stackable: true };
ITEMS.six_human_beers = { id: 'six_human_beers', name: 'The Six Human Beers', emoji: '🍻', description: 'Fused from 6 Juice that gives you eyes + one of every human soul. Use on Asgore at 77.77% chance for Asgore Dreemurr.', stackable: true };
ITEMS.eye_item = { id: 'eye_item', name: '👀', emoji: '👀', description: 'Legendary Gacha 10% drop. Use on yourself for Torgore Dreemurr.', stackable: true };
ITEMS.vhs_tape = { id: 'vhs_tape', name: 'VHS Tape', emoji: '📼', description: 'Guaranteed drop from Sans? boss. Use on Sans to convert to Sans?.', stackable: true };
ITEMS.stolen_slash = { id: 'stolen_slash', name: 'Stolen Slash', emoji: '🗡️', description: '25% drop from Sans? boss. Use on Sans? for 25% chance to get YOUR FAULT.', stackable: true };
ITEMS.administrator_permissions = { id: 'administrator_permissions', name: 'Administrator Permissions', emoji: '🔑', description: '6.66% drop from Sans? boss. Use on YOUR FAULT for 66.66% chance to get YOUR INNER TORMENT.', stackable: true };

// --- UPDATE 19: New items ---
ITEMS.lightsaber = { id: 'lightsaber', name: 'Lightsaber', emoji: '⚔️', description: '7% drop from /scavenge. Used to obtain Green Sans.', stackable: true };
ITEMS.whatsapp_logo = { id: 'whatsapp_logo', name: 'Whatsapp Logo', emoji: '📱', description: '25% Epic Gacha drop. Used to obtain Green Sans.', stackable: true };
ITEMS.happy_meal = { id: 'happy_meal', name: 'Happy Meal', emoji: '🍔', description: 'Crafted from all food items. Used to obtain Green Sans.', stackable: true };
ITEMS.scythe = { id: 'scythe', name: 'Scythe', emoji: '🪓', description: '20% Epic Gacha drop. Used to craft Reaper\'s Scythe.', stackable: true };
ITEMS.reapers_scythe = { id: 'reapers_scythe', name: "Reaper's Scythe", emoji: '💀', description: 'Crafted from 5 Scythes + 30 Papyrus\' Skulls + 15 Integrity Souls + 25,000 SE. Use on Sans with Avenge Sans in party + 50 Bad Time Sans kills.', stackable: true };
ITEMS.loaded_gun = { id: 'loaded_gun', name: 'Loaded Gun', emoji: '🔫', description: '10% drop from JUSTICE encounter. Used to craft Seraphim Soul.', stackable: true };
ITEMS.seraphim_soul = { id: 'seraphim_soul', name: 'Seraphim Soul', emoji: '✨', description: 'Crafted from 5 human soul weapons + Loaded Gun. Use on yourself to get Seraphim.', stackable: true };
ITEMS.black_shard = { id: 'black_shard', name: 'Black Shard', emoji: '🖤', description: 'Guaranteed drop from The Roaring Knight boss. Used to craft the Black Knife.', stackable: true };
ITEMS.shadow_crystal = { id: 'shadow_crystal', name: 'Shadow Crystal', emoji: '🔮', description: '10% drop from The Roaring Knight boss. Used to craft the Black Knife.', stackable: true };
ITEMS.black_knife = { id: 'black_knife', name: 'Black Knife', emoji: '🗡️', description: 'Crafted from 10 Black Shards + 3 Shadow Crystals + 1 Real Knife. Use on Nothing with 6500 DT + 12500 SE to get The Roaring Knight.', stackable: true };

// --- UPDATE 19 ITEMS cont'd ---
ITEMS.monster_candy = { id: 'monster_candy', name: 'Monster Candy', emoji: '🍬', description: 'A common candy from the Underground. Used in crafting Happy Meal.', stackable: true };
ITEMS.spider_donut = { id: 'spider_donut', name: 'Spider Donut', emoji: '🍩', description: 'Made by the spiders of Muffet\'s Parlor. Used in crafting Happy Meal.', stackable: true };
ITEMS.butterscotch_pie = { id: 'butterscotch_pie', name: 'Butterscotch Pie', emoji: '🥧', description: 'A pie baked by Toriel. Used in crafting Happy Meal.', stackable: true };
ITEMS.crab_apple = { id: 'crab_apple', name: 'Crab Apple', emoji: '🍎', description: 'A crabby apple. Used in crafting Happy Meal.', stackable: true };

// --- UPDATE 18: New character obtainment items ---
ITEMS.strange_flower = { id: 'strange_flower', name: 'Strange Flower', emoji: '🌸', description: 'Crafted from 25 Vines, 15 Thorns, 10 Hatred, 5 The Flower, 1 Save Star. Use on a Lv5 Sans to get Possession Sans.', stackable: true };
ITEMS.coffee_mug = { id: 'coffee_mug', name: 'Coffee Mug', emoji: '☕', description: '20% chance from /scavenge. Used to obtain Sudden Changes.', stackable: true };

// --- UPDATE 17 ITEMS ---
ITEMS.fatals_bone = { id: 'fatals_bone', name: 'FATALS BONE', emoji: '🦴', description: '3% drop from FatalError!Sans boss.', stackable: true };
ITEMS.glitched_star = { id: 'glitched_star', name: 'Glitched Star', emoji: '💫', description: '5% drop from FatalError!Sans boss, or 3% drop from /scavenge. Required for AfterDust!Sans fusion.', stackable: true };
ITEMS.negative_essence = { id: 'negative_essence', name: 'Negative Essence', emoji: '🟣', description: '1/5 drop from Nightmare Sans boss. Used to craft TRUE Negative Essence.', stackable: true };
ITEMS.killers_soul = { id: 'killers_soul', name: "Killer's Soul", emoji: '🔪', description: '1/25 drop from Nightmare Sans boss. Used in fusions.', stackable: true };
// --- UPDATE 24 ITEMS ---
ITEMS.neon_sword = { id: 'neon_sword', name: 'Neon Sword', emoji: '🗡️', description: 'Crafted item. Used to obtain Psychopathtale Sans.', stackable: true };
ITEMS.heart_locket = { id: 'heart_locket', name: 'Heart Locket', emoji: '💝', description: '1/99 drop on any fight (same as Real Knife). Used to obtain Dusttale Endgoal.', stackable: true };
ITEMS.stolen_inventory_bag = { id: 'stolen_inventory_bag', name: 'Stolen Inventory Bag', emoji: '🎒', description: 'Crafted from scavenge food items. Used to obtain Dusttale Endgoal.', stackable: true };
ITEMS.hate_scythe = { id: 'hate_scythe', name: 'Hate Scythe', emoji: '🌑', description: 'Crafted from 10 Scythe + 15 Hatred + 5 Real Knives. Use on Chara (with Reaper Sans on team) for Reaper Chara.', stackable: true };
ITEMS.corrupt_apple = { id: 'corrupt_apple', name: 'Corrupt Apple', emoji: '🍎', description: '1/50 drop from Nightmare Sans boss. Used to craft Positive Apple and TRUE Negative Essence.', stackable: true };
ITEMS.corruption = { id: 'corruption', name: 'Corruption', emoji: '🌑', description: '5% drop from Nightmare Sans boss.', stackable: true };
ITEMS.positive_essence = { id: 'positive_essence', name: 'Positive Essence', emoji: '⭐', description: '1/150 drop from anything. Used to craft Positive Apple.', stackable: true };
ITEMS.positive_staff = { id: 'positive_staff', name: 'Positive Staff', emoji: '🪄', description: '1/20 drop from /scavenge. Used with Positive Apple to obtain Dream Sans.', stackable: true };
ITEMS.positive_apple = { id: 'positive_apple', name: 'Positive Apple', emoji: '🍏', description: 'Crafted from 1 Corrupt Apple + 1 Positive Essence + 20k DT. Use with Positive Staff on Lv5 Sans + 25k SE for Dream Sans.', stackable: true };
ITEMS.true_negative_essence = { id: 'true_negative_essence', name: 'TRUE Negative Essence', emoji: '🟪', description: 'Crafted from 6 Negative Essence + 2 Killer\'s Soul + 1 Corrupt Apple + 35k DT. Use on Sans (with Killer/Horror/JHall Dust on team) for Nightmare Sans.', stackable: true };

// --- UPDATE 20 ITEMS ---
ITEMS.rusted_metal_pipe = { id: 'rusted_metal_pipe', name: 'Rusted Metal Pipe', emoji: '🪈', description: '25% drop from Pesti Sans boss. Use on Sans to get Pesti Sans.', stackable: true };
ITEMS.pesto_sauce = { id: 'pesto_sauce', name: 'Pesto Sauce', emoji: '🌿', description: '10% drop from Papyrus boss. Use on Pesti Sans to get Pesto Sans.', stackable: true };
ITEMS.void_catalyst = { id: 'void_catalyst', name: 'Void Catalyst', emoji: '🕳️', description: '40% drop from HIM superboss. A placeholder relic — its use is yet unknown.', stackable: true };
// --- ?????? (Jevil) questline ---
ITEMS.key_piece_1 = { id: 'key_piece_1', name: 'Key Piece 1', emoji: '🗝️', description: 'A strange key piece. A relic of a gate that no longer opens.', stackable: true };
ITEMS.key_piece_2 = { id: 'key_piece_2', name: 'Key Piece 2', emoji: '🗝️', description: 'A strange key piece. A relic of a gate that no longer opens.', stackable: true };
ITEMS.key_piece_3 = { id: 'key_piece_3', name: 'Key Piece 3', emoji: '🗝️', description: 'A strange key piece. A relic of a gate that no longer opens.', stackable: true };
ITEMS.mystery_key = { id: 'mystery_key', name: 'Mystery Key', emoji: '🔑', description: 'The strange key, whole at last. The gate it opened is gone.', stackable: true };
ITEMS.jevils_scythe = { id: 'jevils_scythe', name: "Jevil's Scythe", emoji: '🪓', description: "Relic. Equip to a character with /use. Each time the holder skips their turn, they gain +2 ATK.", stackable: true };
ITEMS.jevils_tail = { id: 'jevils_tail', name: "Jevil's Tail", emoji: '🌀', description: "Relic. Equip to a character with /use. The chance for effects on the holder's attacks is doubled.", stackable: true };
ITEMS.my_memories_item = { id: 'my_memories_item', name: 'my memories!!', emoji: '💭', description: 'A fragment of forgotten memories. Use on a Lv5 JHall Dust Sans to get Evan\'s Dust. (False Saviors Event)', stackable: true };
ITEMS.hypers_soul = { id: 'hypers_soul', name: "Hyper's Soul", emoji: '👻', description: '0.1% drop from killing any boss. Use on a Lv5 Evan\'s Dust to get Fake!HyperDust. (False Saviors Event)', stackable: true };
ITEMS.broken_soul_shard = { id: 'broken_soul_shard', name: 'Broken Soul Shard', emoji: '💔', description: 'Obtainable item from sacrificing Evan\'s Dust via /sacrifice. (False Saviors Event)', stackable: true };

// --- SCAMPTON EVENT ITEMS ---
ITEMS.chromakey_piece_a = { id: 'chromakey_piece_a', name: 'ChromaKey Piece A', emoji: '\u{1F7E5}', description: 'One of three ChromaKey Pieces. Bought from /shop for 19,970 Determination. Permanent \u2014 never consumed. (Scampton Event)', stackable: true };
ITEMS.chromakey_piece_b = { id: 'chromakey_piece_b', name: 'ChromaKey Piece B', emoji: '\u{1F7E9}', description: 'One of three ChromaKey Pieces. 30% drop from W.D. Gaster. Permanent \u2014 never consumed. (Scampton Event)', stackable: true };
ITEMS.chromakey_piece_c = { id: 'chromakey_piece_c', name: 'ChromaKey Piece C', emoji: '\u{1F7E6}', description: 'One of three ChromaKey Pieces. Granted for completing at least 10 Achievements. Permanent \u2014 never consumed. (Scampton Event)', stackable: true };
ITEMS.rewritten_ticket = { id: 'rewritten_ticket', name: 'Rewritten Ticket', emoji: '\u{1F3AB}', description: 'Use it to claim one of: Asriel (Rewritten), Noelle (Rewritten), or Charkis. (Scampton Event)', stackable: true };
ITEMS.big_shot_bow_tie = { id: 'big_shot_bow_tie', name: 'Big Shot Bow Tie', emoji: '\u{1F380}', description: 'Relic. Equip to a character with /use. 1.5x Determination and Soul Essence rewards from enemies while held. (Scampton Event)', stackable: true };

// --- UPDATE 22 ITEMS ---
ITEMS.a_cross = { id: 'a_cross', name: 'A Cross', emoji: '✝️', description: '1% drop from the Legendary Gacha. Used to craft The Dark Cross.', stackable: true };
ITEMS.their_dying_wishes = { id: 'their_dying_wishes', name: 'Their Dying Wishes', emoji: '🕯️', description: 'Reward from the "Guess they can do something on their own afterall." achievement. Used to craft The Dark Cross.', stackable: true };
ITEMS.the_dark_cross = { id: 'the_dark_cross', name: 'The Dark Cross', emoji: '🖤', description: 'Crafted from A Cross + Their Dying Wishes + 5 Stolen Monster Magic + 7,000 DT Vials + 260,000 Determination. Use on Sans to get the Fallen Priest.', stackable: true };
ITEMS.compensation_token = { id: 'compensation_token', name: 'Compensation Token', emoji: '🎫', description: 'Granted by /claim. Use /redeem to exchange it for any one character of your choice.', stackable: true };

// --- UPDATE 15 RECIPES ---
RECIPES.determination_soul = { id: 'determination_soul', name: 'Determination Soul', description: 'Craft 7 DT Souls into a Determination Soul.', ingredients: { dt_soul: 7 }, result: { type: 'item', itemId: 'determination_soul' } };
// --- UPDATE 24 RECIPES ---
RECIPES.hate_scythe = { id: 'hate_scythe', name: 'Hate Scythe', description: 'Use on Chara (with Reaper Sans on your team) for Reaper Chara.', ingredients: { scythe: 10, hatred: 15, real_knife: 5 }, result: { type: 'item', itemId: 'hate_scythe' } };
RECIPES.psychopathtale_sans = { id: 'psychopathtale_sans', name: 'Neon Sword (Psychopathtale Sans)', description: 'Forge the Neon Sword — 75% success. On failure the Patience Human Souls are returned; the rest is lost.', ingredients: { determination_soul: 50, patience_human_soul: 50, lightsaber: 5 }, result: { type: 'character', charId: 'psychopathtale_sans' }, successChance: 0.75, refundOnFail: { patience_human_soul: 50 } };
RECIPES.portable_core = { id: 'portable_core', name: 'Portable CORE', description: 'Requires 3 of each: Time Orb, Gaster\'s Hands, DT Injector, His Guidance, Echo Flowers.', ingredients: { time_orb: 3, gasters_hands: 3, dt_injector: 3, his_guidance: 3, echo_flowers: 3 }, result: { type: 'item', itemId: 'portable_core' } };
RECIPES.empowered_kindness_soul = { id: 'empowered_kindness_soul', name: 'Empowered Kindness Soul', description: 'Requires C!Insanity in team. 1 Shattered Kindness + 1 Integrity Soul + 10 Kindness Human Souls + 100 DT Vials.', ingredients: { shattered_kindness_soul: 1, integrity_soul: 1, kindness_human_soul: 10, dt_vial: 100 }, result: { type: 'item', itemId: 'empowered_kindness_soul' } };
RECIPES.thorn_ring = { id: 'thorn_ring', name: 'Thorn Ring', description: 'Craft 25 Thorns into a Thorn Ring.', ingredients: { thorns: 25 }, result: { type: 'item', itemId: 'thorn_ring' } };
RECIPES.strange_flower = { id: 'strange_flower', name: 'Strange Flower', description: 'Craft 25 Vines, 15 Thorns, 10 Hatred., 5 The Flower, 1 Save Star into a Strange Flower. Use on Lv5 Sans for Possession Sans.', ingredients: { vines: 25, thorns: 15, hatred: 10, the_flower: 5, save_star: 1 }, result: { type: 'item', itemId: 'strange_flower' } };

// --- UPDATE 17 RECIPES ---
RECIPES.positive_apple = { id: 'positive_apple', name: 'Positive Apple', description: 'Craft from 1 Corrupt Apple + 1 Positive Essence + 20,000 Determination.', ingredients: { corrupt_apple: 1, positive_essence: 1, determination: 20000 }, result: { type: 'item', itemId: 'positive_apple' } };
RECIPES.true_negative_essence = { id: 'true_negative_essence', name: 'TRUE Negative Essence', description: 'Craft from 6 Negative Essence + 2 Killer\'s Soul + 1 Corrupt Apple + 35,000 Determination.', ingredients: { negative_essence: 6, killers_soul: 2, corrupt_apple: 1, determination: 35000 }, result: { type: 'item', itemId: 'true_negative_essence' } };

// --- UPDATE 19 RECIPES ---
RECIPES.happy_meal = { id: 'happy_meal', name: 'Happy Meal', description: 'Craft from 1x Ketchup Bottle + 1x Monster Candy + 1x Spider Donut + 1x Butterscotch Pie + 1x Crab Apple. Used for Green Sans.', ingredients: { ketchup_bottle: 1, monster_candy: 1, spider_donut: 1, butterscotch_pie: 1, crab_apple: 1 }, result: { type: 'item', itemId: 'happy_meal' } };
RECIPES.reapers_scythe = { id: 'reapers_scythe', name: "Reaper's Scythe", description: 'Craft from 5 Scythes + 30 Papyrus\' Skulls + 15 Integrity Souls + 25,000 Soul Essence.', ingredients: { scythe: 5, papyrus_skull: 30, integrity_soul: 15, soul_essence: 25000 }, result: { type: 'item', itemId: 'reapers_scythe' } };
RECIPES.seraphim_soul = { id: 'seraphim_soul', name: 'Seraphim Soul', description: 'Craft from 50x each: Justice Human Soul, Integrity Human Soul, Bravery Human Soul, Patience Human Soul, Perseverance Human Soul + 1x Loaded Gun.', ingredients: { justice_human_soul: 50, integrity_human_soul: 50, bravery_human_soul: 50, patience_human_soul: 50, perseverance_human_soul: 50, loaded_gun: 1 }, result: { type: 'item', itemId: 'seraphim_soul' } };
RECIPES.black_knife = { id: 'black_knife', name: 'Black Knife', description: 'Craft from 10 Black Shards + 3 Shadow Crystals + 1 Real Knife.', ingredients: { black_shard: 10, shadow_crystal: 3, real_knife: 1 }, result: { type: 'item', itemId: 'black_knife' } };

// --- UPDATE 22 RECIPES ---
RECIPES.the_dark_cross = { id: 'the_dark_cross', name: 'The Dark Cross', description: 'Craft from 1x A Cross + 1x Their Dying Wishes + 5x Stolen Monster Magic + 7,000 DT Vials + 260,000 Determination. Use on Sans for the Fallen Priest.', ingredients: { a_cross: 1, their_dying_wishes: 1, stolen_monster_magic: 5, dt_vial: 7000, determination: 260000 }, result: { type: 'item', itemId: 'the_dark_cross' } };

// --- UPDATE 15 STATUS EFFECTS ---
STATUS_EFFECTS.voided = { name: 'Voided', emoji: '🟣', damagePerTurn: 5, duration: 3, description: '5 dmg/turn for 3 turns. 25% chance per enemy attack to absorb (50% less dmg + Core Frisk +1 ATK).' };
STATUS_EFFECTS.frozen = { name: 'Frozen', emoji: '🧊', duration: 2, description: 'Stunned for the duration of this status (2 turns).' };
STATUS_EFFECTS.sleep = { name: 'Sleep', emoji: '😴', duration: 2, description: 'Takes +2 flat bonus damage from all attacks.' };
STATUS_EFFECTS.concussion = { name: 'Concussion', emoji: '🤕', missChance: 0.25, duration: 2, description: '25% miss chance for 2 turns. Stacks with Blindness.' };
STATUS_EFFECTS.relaxed = { name: 'Relaxed', emoji: '😌', duration: 2, description: 'Immune to Flinch and stat drops. Next attack +10 true damage.' };
// --- UPDATE 19 STATUS EFFECTS ---
STATUS_EFFECTS.starShards = { name: 'Star Shards', emoji: '🌟', duration: 999, description: '50% chance when using a move to take 15 recoil damage.' };
STATUS_EFFECTS.deathTouch = { name: "Death's Touch", emoji: '💀', duration: 999, description: 'Lose 1% of max HP at end of each turn. At 5 stacks: marked for a 1.5x hit.' };
// --- UPDATE 20 STATUS EFFECTS ---
STATUS_EFFECTS.rust = { name: 'Rust', emoji: '🟫', duration: 3, description: '-1 DEF every turn (not permanent). When the status ends, DEF returns to the original amount.' };
STATUS_EFFECTS.memoriesDodge = { name: 'Memories Dodge', emoji: '💭', duration: 1, description: 'Your attacks are disabled for 1 round.' };
// --- UPDATE 24 STATUS EFFECTS ---
STATUS_EFFECTS.soaked = { name: 'Soaked', emoji: '💦', missChance: 0.10, duration: 2, description: '10% miss chance for 2 turns.' };
STATUS_EFFECTS.schizo = { name: 'Schizo', emoji: '🌀', duration: 2, description: 'Attacks against this target have a 25% chance to deal 10% more damage.' };
STATUS_EFFECTS.hate = { name: 'Hate', emoji: '🖤', duration: 2, description: 'Positive stat buffs disabled. Takes 20 fixed damage (healed to caster) when using a defensive or healing move.' };
STATUS_EFFECTS.hemorrhage = { name: 'Hemorrhage', emoji: '🩸', damagePerTurn: 8, duration: 99, description: '8 dmg/turn until the target uses a healing move or switches.' };
STATUS_EFFECTS.crystallize = { name: 'Crystallize', emoji: '💎', damagePerTurn: 0, duration: 2, description: 'Each turn deals 40% of the damage dealt last turn. Stacks.' };
// --- UPDATE 22 STATUS EFFECTS ---
STATUS_EFFECTS.regret = { name: 'Regret', emoji: '😔', duration: 2, description: '25% chance to not attack. -1 ATK for every time you don\'t attack due to Regret.' };
STATUS_EFFECTS.blessing = { name: 'Blessing', emoji: '🙏', duration: 2, description: 'Negate 30% of damage taken and heal for the amount negated.' };

const COMBAT = { CRIT_CHANCE: 0.15, CRIT_MULTIPLIER: 1.5, MIN_DAMAGE: 1, MAX_TEAM_SIZE: 6 };


// --- SHOP DATA ---
const SHOP_DIALOGS = [
  'yo, howzit going.',
  "yo yo, what's cooking good lookin?",
  'got any cash on ya?',
];
const SHOP_ITEMS = [
  { id: 'monster_soul', name: 'Monster Soul', emoji: '💀', price: 200, description: 'Use to get Sans, or save for crafting.' },
  { id: 'tier1_monster_soul', name: 'Tier 1 Monster Soul', emoji: '🔥', price: 350, description: 'Use on Sans or on nothing.' },
  { id: 'tier2_monster_soul', name: 'Tier 2 Monster Soul', emoji: '💎', price: 600, description: 'Use on Underswap Sans.' },
  { id: 'tier3_monster_soul', name: 'Tier 3 Monster Soul', emoji: '💎', price: 1000, description: 'Advanced soul for powerful characters.' },
  { id: 'star_piece', name: 'Star Piece', emoji: '🌟', price: 1200, description: 'A shimmering star fragment.' },
  { id: 'event_boss_ticket', name: 'Event Boss Ticket', emoji: '🎟️', price: 2000, description: 'Required to fight event bosses.' },
  { id: 'galactic_ticket', name: 'Galactic Ticket', emoji: '🌌', price: 5000, priceSE: 500, description: 'Required to fight the Galactic Event bosses.' },
  { id: 'negativetale_sans', name: 'Negativetale Sans', emoji: '🖤', price: 10000, description: 'The shopkeeper himself. Unlock as a character.', isCharacter: true },
  { id: 'hardmode_essence', name: 'Hardmode Essence', emoji: '🩵', price: 25000, description: 'Use on Lv5 Sans (+10,000 SE) for Hardmode Sans.' },
  { id: 'chromakey_piece_a', name: 'ChromaKey Piece A', emoji: '\u{1F7E5}', price: 19970, description: 'One of three ChromaKey Pieces. Opens the way to Scampton.' },
];
const SHOP_REQUIRED_BOSS_CLEARS = 1; // need at least 1 boss win to access shop

// --- ACHIEVEMENTS ---
const ACHIEVEMENTS = {
  hello_world: {
    id: 'hello_world', name: 'Hello World.',
    description: 'Complete Volume 0 of Story Mode — your first steps into the Doodlesphere.',
    reward: { dtVial: 500, soulEssence: 1000 },
  },
  just_the_beginning: {
    id: 'just_the_beginning', name: 'Just the Beginning',
    description: 'Use a bot command for the first time.',
    reward: { dtVial: 3 },
  },
  big_hunter: {
    id: 'big_hunter', name: 'Big Hunter',
    description: 'Kill a Big Snowman.',
    reward: { dtVial: 2 },
  },
  limit_reached: {
    id: 'limit_reached', name: 'Limit Reached',
    description: 'Reach Level 5 on any character.',
    reward: { soulEssence: 25 },
  },
  the_realest: {
    id: 'the_realest', name: 'The Realest One Of All',
    description: 'Defeat the Snowman (Sans Costume).',
    reward: { monster_soul: 1 },
  },
  confronting_yourself: {
    id: 'confronting_yourself', name: 'Confronting Yourself',
    description: 'Defeat Snowman (Sans Costume) with only 1 Sans on your team.',
    reward: { monster_soul: 2, star_piece: 2 },
  },
  snowman_massacre: {
    id: 'snowman_massacre', name: 'Snowman Massacre',
    description: 'Kill 100 Snowmen.',
    reward: { dtVial: 10 },
  },
  ooo_shiny: {
    id: 'ooo_shiny', name: 'Oooo, Shiny!',
    description: 'Obtain a Shiny character.',
    reward: { soulEssence: 40 },
  },
  you_cannot_beat_us: {
    id: 'you_cannot_beat_us', name: 'You Cannot Beat Us.',
    description: 'Obtain a full team of 6 characters.',
    reward: { monster_soul: 1, soulEssence: 35 },
  },
  // --- UPDATE 13 ACHIEVEMENTS ---
  story_of_undertale: {
    id: 'story_of_undertale', name: 'Story of Undertale',
    description: 'Defeat all Undertale bosses in order: Toriel → Papyrus → Undyne → Mettaton NEO → Asgore.',
    reward: { dtVial: 15 },
  },
  how_do_i_keep_missing: {
    id: 'how_do_i_keep_missing', name: 'HOW DO I KEEP MISSING',
    description: 'Have 3 or more of your attacks miss consecutively.',
    reward: { dtVial: 0 }, // intentional prank — congrats, you get nothing
  },
  this_truly_was_our_dusttale: {
    id: 'this_truly_was_our_dusttale', name: 'This Truly was our Dusttale',
    description: 'Own every dust evolution from Ruins Dust to Judgement Hall Dust Sans.',
    reward: { dtVial: 20 },
  },
  rejuvenation: {
    id: 'rejuvenation', name: 'Rejuvenation',
    description: 'Beat Undyne (or any boss above) with only Sans and Papyrus on your team.',
    reward: { dtVial: 10, soulEssence: 100 },
  },
  dads_assistance: {
    id: 'dads_assistance', name: "Dad's Assistance",
    description: 'Naturally obtain shiny Last Breath Sans AND shiny Revenge Papyrus (without using Shiny Stars).',
    reward: { dtVial: 30 },
  },
  remember_son: {
    id: 'remember_son', name: 'Remember son, Dying is gay',
    description: 'Survive a fight with active Last Breath Sans at 5% HP or less.',
    reward: { dtVial: 1 },
  },
  truly_insane: {
    id: 'truly_insane', name: 'Truly Insane',
    description: 'Have a full team of Insanity / C!Insanity variants.',
    reward: { dtVial: 666 },
  },
  crazed_vengance: {
    id: 'crazed_vengance', name: 'Crazed Vengance',
    description: 'Obtain both Final Insanity and Avenge Sans.',
    reward: { dtVial: 20 },
  },
  lets_go_gambling: {
    id: 'lets_go_gambling', name: 'LETS GO GAMBLING!1!1!1',
    description: 'Use the /gacha command 100 times.',
    reward: { dtVialChance: { amount: 30, chance: 0.5 } }, // 50/50: 30 DT or nothing
  },
  broken_limits: {
    id: 'broken_limits', name: 'BROKEN LIMITS',
    description: 'Earn 5000 EXP across all your JHall Dust Sans. Rewards Flame Eye item (used to fuse Flame Eye character).',
    reward: { flame_eye_item: 1 },
  },
  // --- UPDATE 19 ---
  were_stronger_together: {
    id: 'were_stronger_together', name: "We're Stronger Together!",
    description: 'Beat The Roaring Knight boss whilst having Kris, Susie and Ralsei all alive.',
    reward: { determination: 250, soulEssence: 750 },
  },
  // --- UPDATE 22 ---
  guess_they_can: {
    id: 'guess_they_can', name: 'Guess they can do something on their own afterall.',
    description: 'Defeat the 5 Base Undertale bosses in order whilst having only 1 character left alive.',
    reward: { their_dying_wishes: 1, dtVial: 500 },
  },
};

// --- GACHA TABLE ---
const GACHA_TABLE = {
  cost: 4000, // Determination
  tiers: [
    {
      name: 'Common', emoji: '⚪', chance: 0.65,
      rewards: [
        { type: 'item', id: 'monster_soul', amount: 3 },
        { type: 'determination', amount: 25 },
        { type: 'item', id: 'tier1_monster_soul', amount: 1 },
        { type: 'dtVial', amount: 10 },
      ],
    },
    {
      name: 'Rare', emoji: '🔵', chance: 0.20,
      rewards: [
        { type: 'item', id: 'tier1_monster_soul', amount: 3 },
        { type: 'determination', amount: 75 },
        { type: 'item', id: 'tier2_monster_soul', amount: 1 },
        { type: 'dtVial', amount: 20 },
        { type: 'item', id: 'star_piece', amount: 1 },
        // --- UPDATE 13 ---
        { type: 'item', id: 'dusty_fur_hood', amount: 1, exclusiveChance: 0.05 },
      ],
    },
    {
      name: 'Epic', emoji: '🟣', chance: 0.10,
      rewards: [
        { type: 'determination', amount: 200 },
        { type: 'item', id: 'tier3_monster_soul', amount: 4 },
        { type: 'dtVial', amount: 75 },
        { type: 'item', id: 'head_dog', amount: 1 },
        { type: 'item', id: 'save_star', amount: 1 },
        { type: 'item', id: 'papyrus_scarf', amount: 1 },
        { type: 'item', id: 'event_boss_ticket', amount: 3 },
        // --- UPDATE 13 ---
        { type: 'item', id: 'cigarette_pack', amount: 1, exclusiveChance: 0.15 },
        // --- UPDATE 19 ---
        { type: 'item', id: 'scythe', amount: 1, exclusiveChance: 0.20 },
        { type: 'item', id: 'whatsapp_logo', amount: 1, exclusiveChance: 0.25 },
      ],
    },
    {
      name: 'Legendary', emoji: '🌟', chance: 0.05,
      rewards: [
        { type: 'determination', amount: 2500 },
        { type: 'item', id: 'shiny_star', amount: 3 },
        { type: 'item', id: 'paint_vials', amount: 1 },
        { type: 'item', id: 'glitched_strings', amount: 1 },
        { type: 'item', id: 'save_star_menu', amount: 1 },
        { type: 'item', id: 'dt_injector', amount: 1 },
        { type: 'item', id: 'gasters_hands', amount: 1 },
        { type: 'item', id: 'his_guidance', amount: 1 },
        // Exclusive drops (each rolled independently at 3%)
        { type: 'item', id: 'cat_food', amount: 1, exclusiveChance: 0.06 },
        { type: 'item', id: 'blue_bone', amount: 1, exclusiveChance: 0.06 },
        // Dustrust Sans direct legendary drop
        { type: 'character', id: 'dustrust_sans', exclusiveChance: 0.04 },
        // --- UPDATE 12 EXCLUSIVES ---
        { type: 'item', id: 'axe_thousand_souls', amount: 1, exclusiveChance: 0.05 },
        { type: 'item', id: 'axe_hundred_thousand_souls', amount: 1, exclusiveChance: 0.01 },
        { type: 'item', id: 'blade_omniverse', amount: 1, exclusiveChance: 0.05 },
        { type: 'character', id: 'c_insanity_weak', exclusiveChance: 0.10 },
        { type: 'character', id: 'weak_avenge_sans', exclusiveChance: 0.10 },
        // --- UPDATE 22: A Cross (1%; owning A Cross/The Dark Cross/Fallen Priest grants 500 DT Vials instead) ---
        { type: 'item', id: 'a_cross', amount: 1, exclusiveChance: 0.01, dupeProtected: true },
      ],
    },
  ],
};

// --- UPDATE 24: OBTAINMENTS (shown in /charinfo so other servers can see how to get each character) ---
// Sourced from the actual /fuse, /craft, item-use and drop logic.
const OBTAINMENTS = {
  // --- Souls / base AUs ---
  sans: 'Use a **Monster Soul** or **Tier 1 Monster Soul** on yourself (your first character).',
  underswap_sans: 'Use a **Tier 1 Monster Soul** on nothing (use it with no target).',
  underfell_sans: 'Use a **Tier 1 Monster Soul** on **Sans** (50/50 with Outertale Sans).',
  outertale_sans: 'Use a **Tier 1 Monster Soul** on **Sans** (50/50 with Underfell Sans).',
  oceantale_sans: 'Use a **Tier 2 Monster Soul** on **Sans** (1/3 with Fresh / Hardtale Sans).',
  fresh_sans: 'Use a **Tier 2 Monster Soul** on **Sans** (1/3 with Oceantale / Hardtale Sans).',
  hardtale_sans: 'Use a **Tier 2 Monster Soul** on **Sans** (1/3 with Oceantale / Fresh Sans).',
  swapswap_sans: 'Use a **Tier 2 Monster Soul** on an **Underswap Sans**.',
  ainavol: 'Use a **Tier 3 Monster Soul** on **Sans** (+500 DT, +1,000 SE; 50/50 with agem).',
  agem: 'Use a **Tier 3 Monster Soul** on **Sans** (+500 DT, +1,000 SE; 50/50 with Ainavol).',
  murder_sans: 'Use a **Tier 3 Monster Soul** on **Sans**.',
  // --- Sans line ---
  killer_sans: 'Use a **Save Star** on a **Level 3+ Sans**.',
  geno_sans: 'Use the **Save Star Menu** (from /scavenge) on a **Lv5 Sans** (+400 Soul Essence).',
  ink_sans: 'Use an **Ink Brush** (1/20 from W.D. Gaster) with **6 Tier 3 Monster Souls** on a **Lv5 Sans**.',
  error_sans: 'Use **Glitched Strings** (from /scavenge) on a **Geno Sans**.',
  insanity_sans: 'Use a **DT Injector** with a **Papyrus\' Skull** on **Sans** (both from W.D. Gaster / Papyrus).',
  star_sans: 'Use **Echo Flowers** (from Papyrus) with **Sans** on your team.',
  last_breath_sans: 'Use **His Guidance** (from W.D. Gaster) on a **Lv5 Sans**.',
  horror_sans: 'Use **Head Dog** (Epic Gacha) on a **Lv5 Sans** (+150 Soul Essence).',
  fallen_priest: 'Craft **The Dark Cross** (A Cross + Their Dying Wishes + 5 Stolen Monster Magic + 7,000 DT Vials + 260,000 Determination), then use it on **Sans**.',
  // --- Papyrus / Underswap ---
  papyrus_char: 'Use a **Papyrus\' Skull** (from the Papyrus boss) on yourself.',
  underswap_papyrus: 'Use an **Orange Jacket** (1/30 from Papyrus) on **Underswap Sans** (+500 SE, with Underswap Sans on team).',
  revenge_papyrus: 'Use **Echo Flowers** on a **Papyrus** with **The Flower** in your inventory (+500 SE).',
  // --- W.D. Gaster ---
  wd_gaster: 'Use **Gaster\'s Hands** (from the W.D. Gaster boss).',
  // --- Bosses / event drops ---
  the_outering_one: 'Use **Phoenix A** (5% from the M87 event boss) on a **Lv5 Outertale Sans**.',
  m87: 'Use a **Blackhole** (6% from the M87 event boss) on a **Lv5 Outertale Sans**.',
  fallen_stars_char: 'Use a **Star Shard** (30% from the Fallen Stars event boss) on a **Lv5 Outertale Sans**.',
  galaxy_sans: 'Use a **Sirius** (12% from the Fallen Stars event boss) on a **Lv5 Outertale Sans**.',
  forced_grin: 'Use the **Car Battery** (8% drop from the "a forced grin." event boss).',
  // --- Dust questline ---
  ruins_dust_sans: 'Use **Stolen Flames** (from Toriel) on **Sans**.',
  snowdin_dust_sans: 'Use **Papyrus\' Scarf** on a **Ruins Dust Sans**.',
  waterfall_dust_sans: 'Use a **Spear** (from Undyne) on a **Snowdin Dust Sans**.',
  hotlands_dust_sans: 'Use a **Neo Cannon** (1/3 from Mettaton NEO) on a **Waterfall Dust Sans**.',
  core_dust_sans: 'Use an **Empty Gun** (1/5 from Mettaton NEO) on a **Hotlands Dust Sans**.',
  judgement_hall_dust_sans: 'Use **Stolen Monster Magic** (crafted) on a **Lv5 Core Dust Sans**.',
  outerdust_sans: 'Fuse using **Cosmic Dust** (W.D. Gaster) + **Stolen Monster Magic**.',
  dustswap_papyrus: 'Use **Stolen Monster Magic** with a **Lv5 Judgement Hall Dust Sans** on your team.',
  dustshift: 'Fuse a **Lv5 Dustswap Papyrus** with a **Lv5 Judgement Hall Dust Sans** on your team.',
  flame_eye: 'Use the **Flame Eye** (from the BROKEN LIMITS achievement) on a **Lv5 Judgement Hall Dust Sans** (+20,000 DT, +10,000 SE).',
  // --- Fusions ---
  oceantale_papyrus: 'Fuse **Oceantale Sans** + **Papyrus** + **10 Tier 3 Monster Souls** via `/fuse`.',
  dusttale_endgoal: 'Fuse **Judgement Hall Dust Sans** + **10 Real Knife** + **10 Heart Locket** + **1 Stolen Inventory Bag** via `/fuse`.',
  time_paradox: 'Fuse **Ainavol** + **agem** + a **Broken Clock** (or substitute Waterfall Dust Sans) via `/fuse`.',
  ainavolagem: 'Fuse **Waterfall Dust Sans** + **Ainavol** + **agem** via `/fuse`.',
  catastrophe_fell: 'Fuse **Underfell Sans** + **Ainavol** + **agem** + **Ainavolagem** via `/fuse`.',
  finale_for_the_bonely_one: 'Fuse **Ainavol** + **agem** + **10 Juice that gives you eyes** via `/fuse`.',
  uv_swap_sans: 'Fuse **3 Underswap Sans** + **1 Underswap Papyrus** + a **Blue Bone** (Legendary Gacha) via `/fuse`.',
  c_insanity: 'Fuse **Weak C!Insanity** + **Axe of a Thousand Souls** (+2,500 DT, +5,000 SE, +1,000 DT Vials) via `/fuse`.',
  final_insanity: 'Fuse **C!Insanity** + **Axe of a Hundred Thousand Souls** + **Shattered Kindness Soul** (+10,000 DT, +20,000 SE, +5,000 DT Vials, Avenge Sans on team) via `/fuse`.',
  avenge_sans: 'Fuse **Weak Avenge Sans** + **Blade of the Omniverse** + **3 Integrity Souls** (+6,000 DT, +12,000 SE, any C!Insanity on team) via `/fuse`.',
  call_of_the_void_sans: 'Fuse **Lv5 Sans** + **Lv5 Papyrus** + **Lv5 W.D. Gaster** + a **Void Tablet** via `/fuse`.',
  rk_swap_papyrus: 'Fuse **Last Breath Sans** + **Underswap Papyrus** + **Underswap Sans** + **W.D. Gaster** via `/fuse`.',
  rk_storyshift_chara: 'Fuse **Storyshift Chara** + **Last Breath Sans** + **W.D. Gaster** via `/fuse`.',
  ts_sans: 'Fuse **Underswap Sans** + **Underswap Papyrus** + a **Ketchup Gun** via `/fuse`.',
  ts_papyrus: 'Fuse **TS!Sans** + **Underswap Papyrus** + a **Cigarette Pack** via `/fuse`.',
  shanghaivania_ink_sans: 'Fuse with **Error Sans** + a **Lv5 Sans** + a **Lv5 Underfell Sans** on your team.',
  influenced_killer_sans: 'Fuse using **2 Killer\'s Souls** (from the Nightmare Sans boss) via `/fuse`.',
  afterdust_sans: 'Fuse using a **Glitched Star** (FatalError!Sans boss / scavenge) via `/fuse`.',
  // --- AU coats / Chara line ---
  storyshift_sans: 'Use the **Crown of the King** (2% from Asgore) on **Sans**.',
  mafiatale_sans: 'Fuse using a **Tommy Gun** + **Mafia Hat** + **Cigarette Pack** via `/fuse`.',
  swapfell_papyrus: 'Use a **Purple Jacket** (crafted from Orange Jacket + Cigarette Pack) with Underswap Sans + Underswap Papyrus on team.',
  storyshift_chara: 'Use a **Green Coat** (crafted) on **Sans** with a **Real Knife** (+2,500 SE).',
  storyfell_chara: 'Use a **Crimson Coat** (crafted) on a **Lv5 Underfell Sans**.',
  hardmode_sans: 'Buy **Hardmode Essence** from Negativetale\'s Shop (25,000 Determination), then use it on a **Lv5 Sans** (+10,000 SE).',
  dustfell_sans: 'Use a **Dusty Fur Hood** (Rare Gacha) + **Chains** (with Underfell Sans kills).',
  tears_in_the_rain_sans: 'Craft **Inevitability**, then use it on a **Lv5 Sans** (8,750 DT + 11,890 SE on team).',
  possession_sans: 'Craft a **Strange Flower** (25 Vines + 15 Thorns + 10 Hatred + 5 The Flower + 1 Save Star), then use it on a **Lv5 Sans**.',
  // --- Deltarune ---
  frisk: 'Use a **Determination Soul** (crafted from 7 DT Souls) on yourself.',
  chara: 'Use a **Real Knife** (1/99 from any boss) on a **Frisk**.',
  no_more_deals_chara: 'Use a **Lethal Deal** (from /scavenge) on a **Chara** (16.66% chance).',
  core_frisk: 'Use a **Portable CORE** (crafted) on a **Frisk**.',
  kris: 'Use **Kris\' Sword** (7% Epic Gacha) on yourself.',
  susie: 'Use **Susie\'s Axe** (7% Epic Gacha) on yourself.',
  ralsei: 'Use a **Comically Long Blunt** (7% Epic Gacha) on yourself.',
  rose: 'Use an **Empowered Kindness Soul** (crafted, requires a C!Insanity form on team) on yourself.',
  clover: 'Use an **Empty Gun** + a **Cowboy Hat** (Rare Gacha) on yourself.',
  noelle: 'Use **Frosty Antlers** (7% Epic Gacha) on yourself.',
  noelle_snowgrave: 'Use a **Thorn Ring** (crafted from 25 Thorns) on a **Lv2 Noelle** (with a Lv2 Kris in party).',
  // --- Royalty ---
  asgore_dreemurr: 'Use **Six Human Beers** (fused) on **Asgore** (77.77% chance).',
  togore_dreemurr: 'Use the **👀 Eye** item (10% Legendary Gacha) on yourself.',
  // --- Sans? line ---
  sans_question: 'Use a **VHS Tape** (from the Sans? boss) on **Sans**.',
  your_fault: 'Use a **Stolen Slash** (25% from Sans? boss) on a **Sans?** (25% chance).',
  your_inner_torment: 'Use **Administrator Permissions** (6.66% from Sans? boss) on a **YOUR FAULT** (66.66% chance).',
  // --- Nightmare / Dream ---
  dream_sans: 'Use a **Positive Apple** (crafted) with a **Positive Staff** on a **Lv5 Sans** (+25,000 SE).',
  nightmare_sans: 'Use **TRUE Negative Essence** (crafted) on **Sans** (with Killer / Horror / JHall Dust Sans on team).',
  // --- Misc ---
  sansfield: 'Use **Cat Food** (rare Legendary Gacha drop) on yourself.',
  sudden_changes: 'Use a **Coffee Mug** (20% from /scavenge).',
  one_left: 'Use **3 Determination Souls**.',
  lethal_deal_char: 'Use a **Lethal Deal** (from /scavenge).',
  reaper_sans: 'Use a **Reaper\'s Scythe** (crafted) on **Sans** (with Avenge Sans in party + 50 Bad Time Sans kills).',
  storyspin_sans: 'Fuse **Sans** + **Chara** + a **Baseball Bat** via /fuse. 20% success chance — on failure ALL materials are destroyed.',
  underterror_sans: 'Obtainment TBD.',
  papyrus_belief: 'Fuse **100 Papyrus Scarfs + 20 Papyrus Skulls + 5 Sans Jackets** onto a **Papyrus** (as the base) via /fuse.',
  lowtierfell_sans: 'Fuse **3x Lv5 Underfell Sans** + **3 Chains** + **1 Save Star** via /fuse (no base).',
  reaper_chara: 'Craft the **Hate Scythe** (10 Scythe + 15 Hatred + 5 Real Knife) via `/craft`, then use it on **Chara** with **Reaper Sans** on your team.',
  psychopathtale_sans: 'Forge the **Neon Sword** via `/craft` (50 Determination Soul + 50 Patience Human Soul + 5 Lightsaber) — **75% success**; on failure the Patience Human Souls are refunded.',
  green_sans: 'Use a **Lightsaber** + **WhatsApp Logo** + a **Happy Meal** (crafted from all food items).',
  seraphim: 'Use a **Seraphim Soul** (crafted from all 5 human soul weapons + Loaded Gun) on yourself.',
  roaring_knight: 'Use a **Black Knife** (crafted) on Nothing (6,500 DT + 12,500 SE).',
  pesti_sans: 'Use a **Rusted Metal Pipe** (25% from the Pesti Sans boss) on **Sans**.',
  pesto_sans: 'Use **Pesto Sauce** (10% from Papyrus) on a **Pesti Sans**.',
  // --- Gacha-exclusive characters ---
  dustrust_sans: 'Direct **Legendary Gacha** pull (~4%).',
  c_insanity_weak: 'Direct **Legendary Gacha** pull (~10%).',
  weak_avenge_sans: 'Direct **Legendary Gacha** pull (~10%).',
  // --- Enlightened questline ---
  enlightened_sans: 'Start of the Enlightened questline — from a **Judgement Hall Dust Sans**.',
  enlightened_ruins_dust_sans: 'Use **Stolen Flames** on an **Enlightened Sans**.',
  enlightened_snowdin_dust_sans: 'Use **Papyrus\' Scarf** on an **Enlightened Ruins Dust Sans**.',
  enlightened_waterfall_dust_sans: 'Use a **Spear** on an **Enlightened Snowdin Dust Sans**.',
  enlightened_hotlands_dust_sans: 'Use a **Neo Cannon** on an **Enlightened Waterfall Dust Sans**.',
  enlightened_core_dust_sans: 'Use an **Empty Gun** on an **Enlightened Hotlands Dust Sans**.',
  enlightened_judgement_hall_dust_sans: 'From a **Lv5 Enlightened Core Dust Sans** (final Enlightened step).',
  // --- Scampton event ---
  asriel_rewritten: 'Fixed party member for the **Scampton [[THE GREAT]]** fight, or use a **Rewritten Ticket**. *(Scampton event)*',
  noelle_rewritten: 'Fixed party member for the **Scampton [[THE GREAT]]** fight, or use a **Rewritten Ticket**. *(Scampton event)*',
  charkis: 'Fixed party member for the **Scampton [[THE GREAT]]** fight, or use a **Rewritten Ticket**. *(Scampton event)*',
  // --- False Saviors event ---
  evans_dust: 'Use **My Memories** on a **Lv5 Judgement Hall Dust Sans**. *(False Saviors event)*',
  fake_hyperdust: 'Use a **Hyper\'s Soul** (0.1% from any boss) on a **Lv5 Evan\'s Dust**. *(False Saviors event)*',
  // --- Special / not normally obtainable ---
  ft_sans: 'Use a **Time Orb** (5% from the Time Paradox boss) on **Sans** (10,000 SE + 2,500 DT).',
  true_fresh_sans: 'Use a **Parasite** (3% from /scavenge) on a **Fresh Sans**.',
  negatale_sans: 'Use a **Tier 3 Monster Soul** (from the shop) on **Sans**.',
  dustbeef_but_in_snows: 'Special obtainment — requires a **Lv5 Papyrus** on your team + **1,100 Determination**.',
  fake_dustdust: 'Use **Hatred.** on a **Fake!HyperDust**. *(False Saviors event)*',
  admin_char: 'Admin-only character — not obtainable.',
  female_killer_sans: 'Special character — not obtainable through normal play (cannot be redeemed).',
  fedora_sans: 'Not currently obtainable through normal play (special / admin grant).',
};
for (const [id, o] of Object.entries(OBTAINMENTS)) { if (CHARACTERS[id]) CHARACTERS[id].obtainment = o; }
// Late-defined characters (assigned via CHARACTERS.x = ... below) need a second pass.
function applyLateObtainments() { for (const [id, o] of Object.entries(OBTAINMENTS)) { if (CHARACTERS[id] && !CHARACTERS[id].obtainment) CHARACTERS[id].obtainment = o; } }

// ===================== UPDATE 31 =====================

// --- UPDATE 31: Goop status (stacking, unpurgable) ---
STATUS_EFFECTS.goop = { name: 'Goop', emoji: '🫠', damagePerTurn: 1, duration: 999, unpurgable: true, stacks: 1, description: 'Stacking. Deals 1 damage per stack each turn. Unpurgable — only removed when the Melting one dies or switches out.' };

// --- UPDATE 31: Items ---
ITEMS.karma_vial = { id: 'karma_vial', name: 'Karma Vial', emoji: '☯️', description: 'Crafted from 10 DT Injectors. Use 5 on a Lv5 Last Breath Sans for Karma!Sans.', stackable: true };
ITEMS.rebar = { id: 'rebar', name: 'Rebar', emoji: '🔩', description: 'A bloodied length of steel rebar. 10% drop from HIM (superboss). Use 5 on a C!Insanity for REBAR!Insanity.', stackable: true };
ITEMS.amalgamate_essence = { id: 'amalgamate_essence', name: 'Amalgamate Essence', emoji: '🧫', description: 'Dripping remains of something that should not be. 10% drop from AMALGAMATE. Used for Papyrus/?.', stackable: true };

// --- UPDATE 31: Recipe ---
RECIPES.karma_vial = { id: 'karma_vial', name: 'Karma Vial', description: 'Craft 10 DT Injectors into 1 Karma Vial. Use 5 on a Lv5 Last Breath Sans for Karma!Sans.', ingredients: { dt_injector: 10 }, result: { type: 'item', itemId: 'karma_vial' } };

// --- UPDATE 31: Drops ---
if (BOSSES.him_boss && BOSSES.him_boss.rewards) {
  if (!Array.isArray(BOSSES.him_boss.rewards.extraDrops)) BOSSES.him_boss.rewards.extraDrops = [];
  BOSSES.him_boss.rewards.extraDrops.push({ item: 'rebar', name: 'Rebar', emoji: '🔩', chance: 0.10, min: 1, max: 1 });
}
if (ENEMIES.amalgamate && ENEMIES.amalgamate.rewards) {
  if (!Array.isArray(ENEMIES.amalgamate.rewards.extraDrops)) ENEMIES.amalgamate.rewards.extraDrops = [];
  ENEMIES.amalgamate.rewards.extraDrops.push({ item: 'amalgamate_essence', name: 'Amalgamate Essence', emoji: '🧫', chance: 0.10, min: 1, max: 1 });
}

// --- UPDATE 31: C!Insanity passive rework (heal moves to the Rose synergy) ---
CHARACTERS.c_insanity.passive = { name: 'Axe Momentum', description: 'Each damaging move landed grants +1 ATK (max +6). At 6 stacks attacks also apply Bleed for 2 turns.', type: 'axeMomentum', maxStacks: 6, bleedDuration: 2 };
CHARACTERS.c_insanity_weak.passive = { name: 'Fractured Focus', description: 'Each attack has a 25% chance to lower the enemy\'s DEF by 1 for the rest of the battle (max 5).', type: 'fracturedFocus', chance: 0.25, maxStacks: 5 };

// --- UPDATE 31: Karma!Sans ---
// --- SCAMPTON EVENT: THE REWRITTEN ---
// Fixed party for the Scampton [[THE GREAT]] fight; also obtainable from a Rewritten Ticket.
CHARACTERS.asriel_rewritten = {
  id: 'asriel_rewritten', isEventChar: true, name: 'Asriel (Rewritten)',
  description: 'Fixed party member for the Scampton fight. Obtainable from a Rewritten Ticket.',
  hp: 180, atk: 14, def: 19, type: 'Melee',
  passive: { name: 'Power Points', description: 'A counter tracks how many PP you have (max 100). Doing damage of any kind (excluding effects) gives PP equal to 10% of the damage dealt.', type: 'powerPoints', maxPP: 100, ratio: 0.10 },
  abilities: [
    { name: 'Saber Slash', description: 'Increased chance for Critical Hits.', type: 'Melee', damageMin: 20, damageMax: 25, maxUses: 35, special: { type: 'highCrit', critBonus: 0.20 } },
    { name: 'Light Ignition', description: 'Requires 10 PP. Asriel becomes a Fire/Melee type for the rest of the battle, and Saber Slash can inflict Burn for 3 turns one time.', type: 'Fire', damageMin: 0, damageMax: 0, maxUses: 15, special: { type: 'lightIgnition', ppCost: 10, burnDuration: 3 } },
    { name: 'Dice Time', description: 'Requires 30 PP. Picks a random number 1-6. 1=Take 10 Self Damage. 2=Nothing happens. 3=Cleanse all current effects. 4=Heal +25 HP. 5=+2 ATK and +2 DEF for 3 turns. 6=Halves the enemy\'s DEF.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'diceTime', ppCost: 30 } },
    { name: 'Patience Parry', description: 'This move always goes first. If Asriel gets hit by a Magic or Unique attack, tank 80% of the damage and convert 50% of it to PP.', type: 'Melee', damageMin: 0, damageMax: 0, maxUses: 40, special: { type: 'patienceParry', blockPercent: 0.80, ppConvert: 0.50 } },
  ],
};
CHARACTERS.noelle_rewritten = {
  id: 'noelle_rewritten', isEventChar: true, name: 'Noelle (Rewritten)',
  description: 'Fixed party member for the Scampton fight. Obtainable from a Rewritten Ticket.',
  hp: 110, atk: 26, def: 10, type: 'Magic',
  passive: { name: 'Power Points', description: 'A counter tracks how many PP you have (max 100). Doing damage of any kind (excluding effects) gives PP equal to 10% of the damage dealt.', type: 'powerPoints', maxPP: 100, ratio: 0.10 },
  abilities: [
    { name: 'Icy Wind', description: 'Increased chance for Critical Hits.', type: 'Magic', damageMin: 25, damageMax: 35, maxUses: 20, special: { type: 'highCrit', critBonus: 0.20 } },
    { name: 'IceShock', description: 'Requires 30 PP. Guaranteed Critical Hit.', type: 'Magic', damageMin: 50, damageMax: 50, maxUses: 10, special: { type: 'noelleIceShock', ppCost: 30 } },
    { name: 'Heal Hail', description: 'Requires 50 PP. Heals your whole party by +20 HP.', type: 'Magic', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'healHail', ppCost: 50, healAmount: 20 } },
    { name: 'Glacier Defense', description: 'This move always goes first. Tank 50% of any form of upcoming damage and gain +20 PP.', type: 'Melee', damageMin: 0, damageMax: 0, maxUses: 30, special: { type: 'glacierDefense', blockPercent: 0.50, ppGain: 20 } },
  ],
};
CHARACTERS.charkis = {
  id: 'charkis', isEventChar: true, name: 'Charkis',
  description: 'Fixed party member for the Scampton fight. Obtainable from a Rewritten Ticket.',
  hp: 140, atk: 15, def: 15, type: 'Unique',
  passive: { name: 'Power Points', description: 'A counter tracks how many PP you have (max 100). Doing damage of any kind (excluding effects) gives PP equal to 10% of the damage dealt.', type: 'powerPoints', maxPP: 100, ratio: 0.10 },
  abilities: [
    { name: 'Sickle Slice', description: 'Increased chance for Critical Hits.', type: 'Melee', damageMin: 10, damageMax: 20, maxUses: 40, special: { type: 'highCrit', critBonus: 0.20 } },
    { name: 'Motivate Up', description: 'Requires 20 PP. A member in your party of your choice gets +2 ATK and +2 DEF for 5 turns.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 15, special: { type: 'motivateUp', ppCost: 20, atk: 2, def: 2, turns: 5 } },
    { name: 'Immunity Shield', description: 'Requires 35 PP. A member in your party of your choice is able to tank one hit fully, and is cleansed of all debuffs and effects.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'immunityShield', ppCost: 35 } },
    { name: 'Hat Stance', description: 'This move always goes first. Block 50% of damage and gain 15 PP. Cleanses all current effects.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 30, special: { type: 'hatStance', blockPercent: 0.50, ppGain: 15 } },
  ],
};

CHARACTERS.karma_sans = {
  id: 'karma_sans', name: 'Karma!Sans',
  description: '"good karma heals me, while bad karma cooks your fucking hp up, kiddo."',
  hp: 199, atk: 19, def: 20, type: 'Bone/Unique',
  passive: { name: 'Karmic Debt', description: 'Striking back with every regret, karma reigns to collect its debt. Every 3 turns Scary KR deals double damage (10 → 20) for 1 turn, and Karma!Sans gains +4 DEF for that turn.', type: 'karmicDebt', interval: 3, krDamage: 20, defBoost: 4 },
  abilities: [
    { name: 'Karmic Bones', description: 'Throws 3-6 bones. 20% Determination Rush (1.3x dmg). Applies Scary KR for 2 turns, 40% chance Bleed for 2 turns.', type: 'Bone', damageMin: 3, damageMax: 5, maxUses: 20, special: { type: 'karmicBones', minHits: 3, maxHits: 6, rushChance: 0.20, rushMult: 1.3, krDuration: 2, bleedChance: 0.40, bleedDuration: 2 } },
    { name: 'Desperation Blasters', description: 'Fires 4 blasters in a circle. 20% Determination Rush (1.4x dmg). Applies Scary KR for 3 turns, 30% chance Karma + Poison for 2 turns.', type: 'Magic', damageMin: 7, damageMax: 15, maxUses: 20, special: { type: 'desperationBlasters', rushChance: 0.20, rushMult: 1.4, krDuration: 3, statusChance: 0.30, statusDuration: 2 } },
    { name: 'GOOD karma', description: 'Heals 10-35 HP. Below 20% HP: 50% chance to apply Scary KR to the enemy for 4 turns.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'goodKarma', healMin: 10, healMax: 35, lowHpThreshold: 0.20, krChance: 0.50, krDuration: 4 } },
    { name: 'Absolute Retribution', description: 'Fires a gaster blaster circle. Applies Scary KR, Karma and Poison for 3 turns. 5 turn cooldown.', type: 'Unique', damageMin: 50, damageMax: 50, maxUses: 5, special: { type: 'absoluteRetribution', duration: 3, cooldown: 5 } },
  ],
  obtainment: 'Craft 10 **DT Injectors** into a **Karma Vial**, then use **5 Karma Vials** on a **Lv5 Last Breath Sans**.',
};

// --- UPDATE 31: REBAR!Insanity (base moveset / Impale moveset) ---
CHARACTERS.rebar_insanity = {
  id: 'rebar_insanity', name: 'REBAR!Insanity',
  description: 'Steel in hand, steel in bone.',
  hp: 188, atk: 22, def: 27, type: 'Weapon/Melee',
  passive: { name: 'Steel Bones', description: 'Takes 20% reduced damage from all sources. While the Rebar is in hand, 10% chance to block attacks.', type: 'steelBones', reduction: 0.20, blockChance: 0.10, blockRequiresHeld: true },
  abilities: [
    { name: 'Top Strike', description: 'Heavy overhead swing — guaranteed crit. Double block chance if the enemy uses their first or second move.', type: 'Weapon', damageMin: 18, damageMax: 24, maxUses: 20, special: { type: 'rebarTopStrike' } },
    { name: 'Sweep', description: 'Wide swing with the rebar. 25% chance to stun.', type: 'Weapon', damageMin: 15, damageMax: 22, maxUses: 20, special: { type: 'rebarSweep', stunChance: 0.25 } },
    { name: 'Stance Change', description: 'Defensive stance for 5 turns: +3 DEF and double block chance, but -6 ATK.', type: 'Melee', damageMin: 0, damageMax: 0, maxUses: 40, special: { type: 'rebarStance', cooldown: 7, duration: 5, defUp: 3, atkDown: 6 } },
    { name: 'Impale', description: 'Charge 1 turn, then throw the rebar — pierces and applies Bleed for 6 turns. Switches to the Impale moveset.', type: 'Weapon', damageMin: 40, damageMax: 60, maxUses: 5, special: { type: 'rebarImpale', bleedDuration: 6 } },
  ],
  impaleAbilities: [
    { name: 'Top Strike', description: 'Leap forward and dropkick the enemy. 20% chance to stun for 1 turn.', type: 'Weapon', damageMin: 18, damageMax: 24, maxUses: 20, special: { type: 'rebarTopStrikeImpale', stunChance: 0.20 } },
    { name: 'Sweep', description: 'Slide in and sweep their legs, then knee them. Each hit has a 20% chance to stun.', type: 'Weapon', damageMin: 15, damageMax: 22, maxUses: 20, special: { type: 'rebarSweepImpale', hits: 2, stunChance: 0.20 } },
    { name: 'Stance Change', description: 'Faster stance for 5 turns: -10 ATK and -10 DEF, but all attacks hit twice as many times.', type: 'Melee', damageMin: 0, damageMax: 0, maxUses: 40, special: { type: 'rebarStanceImpale', cooldown: 7, duration: 5, atkDown: 10, defDown: 10 } },
    { name: 'Impale', description: 'Charge 1 turn to retrieve the rebar — 60% block chance while charging. Returns to the base moveset.', type: 'Weapon', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'rebarRetrieve', chargeBlockChance: 0.60 } },
  ],
  obtainment: 'Use **5 Rebars** on a **C!Insanity**.',
};

// --- UPDATE 31: !REBAR! (synergy form — base moveset / Grab moveset) ---
CHARACTERS.rebar_synergy = {
  id: 'rebar_synergy', name: '!REBAR!',
  description: 'THE BEST DEFENSE IS OFFENSE.',
  hp: 188, atk: 25, def: 25, type: 'Weapon/Melee',
  passive: { name: 'Steel Bones', description: 'Takes 20% reduced damage from all sources. While not holding a Grab, 15% chance to block attacks.', type: 'steelBones', reduction: 0.20, blockChance: 0.15, blockRequiresNoGrab: true },
  isSynergyForm: true,
  abilities: [
    { name: 'Steel Bash', description: 'Large diagonal swing — guaranteed crit and Bleed for 2 turns. Double block chance next turn if the enemy uses their first or second move.', type: 'Weapon', damageMin: 22, damageMax: 26, maxUses: 20, special: { type: 'steelBash', bleedDuration: 2 } },
    { name: 'Gruesome Combat', description: 'Stab your arm into the ground and spin — unavoidable critical hit (guaranteed crit + true damage).', type: 'Melee', damageMin: 15, damageMax: 22, maxUses: 20, special: { type: 'gruesomeCombat' } },
    { name: 'BLOODTHIRST', description: '"THE BEST DEFENSE IS OFFENSE" — lose all block chance and damage reduction and -15 DEF, but +15 ATK until the opponent dies or switches out. On end: heal 75 HP and gain a permanent +3 ATK.', type: 'Melee', damageMin: 0, damageMax: 0, maxUses: 40, special: { type: 'bloodthirst', cooldown: 7, atkUp: 15, defDown: 15, endHeal: 75, endAtk: 3 } },
    { name: 'GRAB', description: 'Stab and grab the enemy. During grab: enemy deals 20% less damage and takes 5 dmg/turn, and must hit you 6 times to break free (5 turn CD on break). Switches to the Grab moveset.', type: 'Weapon', damageMin: 20, damageMax: 20, maxUses: 5, special: { type: 'rebarGrab', hitsToBreak: 6, dmgReduction: 0.20, dotDamage: 5, breakCooldown: 5 } },
  ],
  grabAbilities: [
    { name: 'Steel Bash', description: 'Hit them with a left hook. 30% chance to increase the hits required to break the grab by 1.', type: 'Weapon', damageMin: 22, damageMax: 26, maxUses: 20, special: { type: 'steelBashGrab', chance: 0.30 } },
    { name: 'Gruesome Combat', description: 'Drag the enemy across the floor over 3 hits — but the grab is released.', type: 'Melee', damageMin: 15, damageMax: 22, maxUses: 20, special: { type: 'gruesomeCombatGrab', hits: 3 } },
    { name: 'BLOODTHIRST', description: 'Bite your opponent and consume their blood — heal 35 HP and deal 35 fixed damage.', type: 'Melee', damageMin: 0, damageMax: 0, maxUses: 40, special: { type: 'bloodthirstGrab', cooldown: 7, heal: 35, fixedDamage: 35 } },
    { name: 'GRAB', description: 'Pull the enemy off your rebar arm and throw them into the floor — applies Hemorrhage and stuns for 1 turn.', type: 'Weapon', damageMin: 20, damageMax: 20, maxUses: 5, special: { type: 'rebarGrabThrow' } },
  ],
  obtainment: 'Not directly obtainable — **REBAR!Insanity** becomes **!REBAR!** while **Unnamed Kindness** is on your team (synergy).',
};

// --- UPDATE 31: Unnamed Kindness ---
CHARACTERS.unnamed_kindness = {
  id: 'unnamed_kindness', name: 'Unnamed Kindness',
  description: 'A kindness that never gave its name.',
  hp: 220, atk: 16, def: 23, type: 'Magic/Weapon',
  passive: { name: 'Unnamed Kindness', description: 'Heals 5 HP every time you take damage.', type: 'unnamedKindness', healOnHit: 5 },
  abilities: [
    { name: 'Rusty Pan', description: '20% chance to stun.', type: 'Weapon', damageMin: 21, damageMax: 26, maxUses: 25, special: { type: 'rustyPan', stunChance: 0.20 } },
    { name: 'Ember Toss', description: 'Applies Burn for 3 turns — 40% chance to apply Hellfire instead.', type: 'Magic', damageMin: 17, damageMax: 22, maxUses: 10, special: { type: 'emberToss', burnDuration: 3, hellfireChance: 0.40 } },
    { name: 'Block', description: 'Blocks 80% of the next damage taken. 50% chance to reflect half of it back and stun the enemy for 1 turn.', type: 'Weapon', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'kindnessBlock', cooldown: 2, blockPercent: 0.80, reflectChance: 0.50 } },
    { name: 'Retensive Healing', description: 'Only usable after turn 20. Permanently heals 5 HP per turn to whichever team member is active that turn. Once per battle.', type: 'Magic', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'retensiveHealing', minTurn: 20, healPerTurn: 5 } },
  ],
  obtainment: 'Use a **Rebar** and **2 Empowered Kindness Souls** on **Rose**.',
};

// --- UPDATE 31: Papyrus/? ---
CHARACTERS.papyrus_q = {
  id: 'papyrus_q', name: 'Papyrus/?',
  description: 'h̷ ̶h̷e̶l̷p̸ ̶m̵e̷/̸s̴a̵n̷s̶',
  hp: 166, atk: 6, def: 6, type: 'Bone/Unique',
  passive: { name: 'h̷ ̶h̷e̶l̷p̸ ̶m̵e̷/̸s̴a̵n̷s̶', description: 'Takes 16 damage every turn.', type: 'itHurtsPap', selfDamage: 16 },
  abilities: [
    { name: 'Bone Barrage', description: 'Applies a Goop stack.', type: 'Bone', damageMin: 6, damageMax: 16, maxUses: 20, special: { type: 'papQBoneBarrage', goop: 1 } },
    { name: 'Blue Bones', description: 'Applies Goop if the enemy attacks. 2 turn cooldown.', type: 'Bone', damageMin: 6, damageMax: 66, maxUses: 15, special: { type: 'papQBlueBones', cooldown: 2, goop: 1 } },
    { name: 'Blue Soul', description: 'Charge 1 turn. Lowers enemy DEF by 2 and has a 55% chance to apply 3 Goop stacks.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'papQBlueSoul', defDown: 2, goopChance: 0.55, goop: 3 } },
    { name: 'Special Attack', description: '45% chance to fail (Papyrus/? gets -2 DEF). Otherwise hits 2 times and applies 2 Goop stacks per hit. 2 turn cooldown.', type: 'Bone', damageMin: 6, damageMax: 66, maxUses: 5, special: { type: 'papQSpecialAttack', cooldown: 2, failChance: 0.45, selfDefDown: 2, hits: 2, goopPerHit: 2 } },
  ],
  obtainment: 'Use a **DT Injector** on **Papyrus** while holding 66,666 Determination, 66,666 Soul Essence and an **Amalgamate Essence** — 10% chance to work. On failure you lose the Papyrus.',
};

// --- UPDATE 31: SIXBONES ---
CHARACTERS.sixbones = {
  id: 'sixbones', name: 'S̷I̸X̶B̷O̶N̵E̸S̷',
  description: 'six of them. all of them hurt.',
  hp: 6666, atk: 6, def: 6, type: 'Bone',
  passive: { name: 'I̷T̸ ̶H̷U̵R̸T̷S̶', description: 'Each attack lowers your own DEF by 3 for 3 turns (stacks). Each hit taken grants +1 DEF next turn per hit. Skipping a turn lowers the enemy\'s Goop stacks by 1.', type: 'itHurts', defLossPerAttack: 3, defLossDuration: 3, defGainPerHit: 1 },
  abilities: [
    { name: 'B̷O̶N̵E̸ ̷T̶H̸R̷O̶W̵?̸', description: 'Hits once for each Goop stack on the enemy. For every 6 hits, lowers enemy DEF by 1 until SIXBONES dies.', type: 'Bone', damageMin: 6, damageMax: 6, maxUses: 40, special: { type: 'sixBoneThrow', hitsPer: 6, defDown: 1 } },
    { name: 'B̷L̸A̶S̷T̵E̸R̷', description: '46% Hit / 48% Fail / 6% ???. Hit: 2-3 hits, 1 Goop per hit. Fail: SIXBONES stunned 1 turn. ???: 6 hits with Goop each and both fighters stunned 1 turn.', type: 'Bone', damageMin: 6, damageMax: 66, maxUses: 40, special: { type: 'sixBlaster', hitChance: 0.46, failChance: 0.48, wildChance: 0.06 } },
    { name: 'H̷E̶L̵P̸ ̷U̶S̵', description: 'Charge 2 turns. Hits the enemy 2 times for each point of DEF SIXBONES has and applies 1 Goop per point of DEF. Each hit has a 5% chance to stun.', type: 'Bone', damageMin: 6, damageMax: 6, maxUses: 40, special: { type: 'sixHelpUs', chargeTurns: 2, stunChance: 0.05 } },
    { name: 'N̷O̸ ̶E̷F̵F̸E̷C̶T̵', description: 'Charge 1 turn. Requires 20+ Goop stacks on the enemy. Consumes all Goop and sets DEF to 66 for 1 turn per 6 stacks consumed. 6% chance to fail — take 666 damage and be stunned for 2 turns.', type: 'Bone', damageMin: 0, damageMax: 0, maxUses: 5, special: { type: 'sixNoEffect', requiredGoop: 20, failChance: 0.06, failDamage: 666, failStun: 2 } },
  ],
  obtainment: 'Fuse **Papyrus/?** with **Sans** after defeating **Bad Time Sans** using **Papyrus/?**.',
};

// --- UPDATE 31: Hardmode Insanity ---
CHARACTERS.hardmode_insanity = {
  id: 'hardmode_insanity', name: 'Hardmode Insanity',
  description: '"Heh... heh... heh... did you see that, Papyrus? It never ends... it never stops... so why should I? Just give up. I already did."',
  hp: 180, atk: 17, def: 20, type: 'Unique/Magic',
  passive: { name: 'Terminal Delirium', description: 'Every time Sans loses 10% of his health his ATK increases by +1 (max 6), and he has a 10% chance to immediately counter-attack with his two melee bones for 25 damage.', type: 'terminalDelirium', maxAtk: 6, counterChance: 0.10, counterDamage: 25 },
  abilities: [
    { name: '"QUIET!"', description: '10% chance to disable the opponent\'s last used move for 2 turns.', type: 'Melee', damageMin: 14, damageMax: 23, maxUses: 20, special: { type: 'quietSlam', disableChance: 0.10, disableDuration: 2 } },
    { name: 'Marrow Grinder', description: 'Hits 2-6 times. If it hits 6 times, applies Hemorrhage (8 dmg/turn until they heal or switch).', type: 'Bone', damageMin: 7, damageMax: 12, maxUses: 15, special: { type: 'marrowGrinder', minHits: 2, maxHits: 6, hemorrhageThreshold: 6 } },
    { name: 'Melting Point', description: '25% chance to ignore 50% of the opponent\'s DEF, but forces Sans to skip his next turn.', type: 'Magic', damageMin: 17, damageMax: 25, maxUses: 10, special: { type: 'meltingPoint', ignoreChance: 0.25, defIgnore: 0.50 } },
    { name: '"Just Stay Dead!"', description: 'Blue soul slam — stuns the enemy for the next turn and has a chance to apply Bleed or Blue Soul for 2 turns. 1 turn cooldown.', type: 'Unique', damageMin: 20, damageMax: 30, maxUses: 5, special: { type: 'justStayDead', cooldown: 1, statusChance: 0.50, duration: 2 } },
  ],
  obtainment: 'Use **Hardmode Essence** (Negativetale\'s Shop, 25,000 DT) with **10 DT Injectors** and **15,000 Soul Essence**, with a **Judgement Hall Dust Sans** on your team.',
};

// --- UPDATE 31: Last Breath P3 (synergy form) ---
CHARACTERS.last_breath_p3 = {
  id: 'last_breath_p3', name: 'Last Breath Sans (P3)',
  description: '"he\'s not holding back anymore."',
  hp: 240, atk: 24, def: 22, type: 'Bone/Unique',
  passive: { name: '1000 Fold', description: 'Heals 8 HP at the start of each turn. The first time he drops below 40% HP he gains a permanent +6 ATK.', type: 'lastBreathP3', healPerTurn: 8, threshold: 0.40, atkBoost: 6 },
  isSynergyForm: true,
  abilities: [
    { name: 'Bone Fold', description: '35% chance to apply Bleed for 2 turns.', type: 'Bone', damageMin: 20, damageMax: 28, maxUses: 20, special: { type: 'boneFold', bleedChance: 0.35, bleedDuration: 2 } },
    { name: 'Blaster Overture', description: 'Hits 2-3 times.', type: 'Magic', damageMin: 16, damageMax: 22, maxUses: 15, special: { type: 'blasterOverture', minHits: 2, maxHits: 3 } },
    { name: 'Color Overload', description: 'Applies a random effect: Blue Soul, Karma, or Electrified. 1 turn cooldown.', type: 'Unique', damageMin: 24, damageMax: 32, maxUses: 10, special: { type: 'colorOverload', cooldown: 1 } },
    { name: 'LAST BREATH', description: 'Charge 1 turn, then strike for a guaranteed crit and apply Scary KR for 3 turns. 3 turn cooldown.', type: 'Unique', damageMin: 45, damageMax: 60, maxUses: 5, special: { type: 'lastBreathStrike', cooldown: 3, krDuration: 3 } },
  ],
  obtainment: 'Not directly obtainable — **Last Breath Sans** becomes **P3** while **W.D. Gaster** is on your team (synergy).',
};

// --- UPDATE 31: Character Synergies ---
// Only ONE synergy may be active per team. If a team qualifies for more than one,
// the first entry in this object (in declaration order) wins.
// For duplicate source characters, only the LOWEST team slot is transformed.
const SYNERGIES = {
  last_breath_p3: {
    id: 'last_breath_p3', name: 'Last Breath: Phase 3', emoji: '💀',
    mode: 'replace', sourceId: 'last_breath_sans', requires: 'wd_gaster', becomes: 'last_breath_p3',
    description: 'Turns your Last Breath Sans into **Last Breath Sans (P3)** — completely new stats, passive and moves.',
  },
  roses_devotion: {
    id: 'roses_devotion', name: "Rose's Devotion", emoji: '🌹',
    mode: 'passiveSwap', sourceIds: ['c_insanity', 'c_insanity_weak'], requires: 'rose',
    sourcePassive: { name: "Rose's Support", description: 'Restores 25 HP at the start of each turn. 20% chance to gain +1 DEF.', type: 'rosesSupport', healAmount: 25, defChance: 0.2 },
    weakPassive: { name: "Rose's Assistant", description: 'Restores 10 HP at the start of each turn.', type: 'rosesAssistant', healAmount: 10 },
    partnerPassive: { name: "C!Insanity's Assist", description: 'Every 2 turns, the highest C!Insanity form on your team automatically attacks with one of its moves.', type: 'cInsanityAssist', interval: 2 },
    description: 'Gives your C!Insanity its passive healing back, and gives **Rose** a C!Insanity assist that deals damage every 2 turns.',
  },
  rebar_ascendant: {
    id: 'rebar_ascendant', name: '!REBAR!', emoji: '🔩',
    mode: 'replace', sourceId: 'rebar_insanity', requires: 'unnamed_kindness', becomes: 'rebar_synergy',
    description: 'Replaces **REBAR!Insanity** with **!REBAR!** — new stats, passive, and the GRAB moveset.',
  },
};

// Resolve the single active synergy for a team of character-data objects.
// Returns { synergy, sourceIndex, partnerIndex } or null.
function resolveSynergy(team) {
  if (!Array.isArray(team) || team.length === 0) return null;
  for (const syn of Object.values(SYNERGIES)) {
    const partnerIndex = team.findIndex(c => c && c.id === syn.requires);
    if (partnerIndex === -1) continue;
    const ids = syn.sourceIds || [syn.sourceId];
    let sourceIndex = -1;
    for (let i = 0; i < team.length; i++) {
      if (team[i] && ids.includes(team[i].id) && i !== partnerIndex) { sourceIndex = i; break; }
    }
    if (sourceIndex === -1) continue;
    return { synergy: syn, sourceIndex, partnerIndex };
  }
  return null;
}

// ===================== UPDATE 32: SEASON 1 EXCLUSIVE =====================
// --- Mad Mew Mew — Ranked Season top-3 exclusive reward ---
CHARACTERS.mad_mew_mew = {
  id: 'mad_mew_mew', name: 'Mad Mew Mew',
  description: '"A ghost inside a doll... Yet, the two can\'t cooperate."',
  hp: 195, atk: 25, def: 30, type: 'Magic/Crystal',
  passive: { name: 'Doki Meter', description: 'The first time you are hurt by a super effective attack, negate that damage fully and gain +2 Doki. Skipping your turn gives +1 Doki. You cannot dodge at all. At 5 Doki you attack twice in one turn, then your Doki resets to 0.', type: 'dokiMeter', negateDoki: 2, skipDoki: 1, threshold: 5 },
  abilities: [
    { name: 'Purple Purr-fection', description: 'This move is always used last. Reduces the Uses of the ability the enemy used by -3. Fails if the enemy skips.', type: 'Food', damageMin: 0, damageMax: 0, maxUses: 10, special: { type: 'purplePurrfection', useReduction: 3 } },
    { name: 'Cat-nado', description: '20% chance to heal the enemy by 5-15 HP, but gain +1 Doki.', type: 'Magic', damageMin: 20, damageMax: 35, maxUses: 20, special: { type: 'catNado', healChance: 0.20, healMin: 5, healMax: 15, dokiGain: 1 } },
    { name: 'Pocket Bombs', description: 'Repeats 1-3 times. If it repeats 3 times, 50% chance to deal 30 extra Fixed Damage.', type: 'Fire', damageMin: 5, damageMax: 10, maxUses: 10, special: { type: 'pocketBombs', minHits: 1, maxHits: 3, bonusChance: 0.50, bonusDamage: 30 } },
    { name: 'Superb Karaoke', description: 'For 3 turns: disables the enemy\'s passive, +1 ATK and +1 DEF, and any health the enemy heals is absorbed by you instead. Requires at least 3 Doki. 5 turn cooldown.', type: 'Magic', damageMin: 15, damageMax: 15, maxUses: 5, special: { type: 'superbKaraoke', cooldown: 5, dokiRequired: 3, duration: 3, atkGain: 1, defGain: 1 } },
  ],
  obtainment: 'Ranked Season exclusive — awarded to the **top 3 players** at the end of a ranked season. Not obtainable through normal play.',
};

applyLateObtainments();

module.exports = {
  ADMINS, MOD_ROLE, PVP_GUILD_ID, PVP_GLOBAL, TYPES, getTypeMultiplier, getTypeEmoji, CHARACTERS, ENEMIES, BOSSES, pickRandomEnemy,
  RECIPES, ITEMS, STATUS_EFFECTS, COMBAT, LEVEL_THRESHOLDS, LEVEL_UNLOCKS,
  getLevelFromExp, getExpForNextLevel, getAvailableMoveCount, hasPassiveUnlocked,
  SHINY_CHANCE, SHINY_BONUS, SHOP_ITEMS, SHOP_DIALOGS, SHOP_REQUIRED_BOSS_CLEARS, ACHIEVEMENTS, GACHA_TABLE,
  SYNERGIES, resolveSynergy,
};