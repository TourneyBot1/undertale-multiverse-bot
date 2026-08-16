const { TYPES, getTypeMultiplier, STATUS_EFFECTS, COMBAT, hasPassiveUnlocked, CHARACTERS, BOSSES, SYNERGIES, resolveSynergy } = require('./gameData');

// --- UPDATE 31: Character Synergies ---
// Transforms a team of character-data objects in place of construction. Only ONE
// synergy is ever active; with duplicate sources only the lowest team slot changes.
// Instance fields (level / shiny / equipped / exp) are always carried over.
function applyTeamSynergy(teamData) {
  const res = resolveSynergy(teamData);
  if (!res) return { team: teamData, synergy: null };
  const { synergy, sourceIndex, partnerIndex } = res;
  const carry = (base, from) => ({
    ...base,
    level: from.level, shiny: from.shiny, equipped: from.equipped,
    exp: from.exp, _slotId: from._slotId, _originalId: from.id,
    _synergyId: synergy.id,
  });
  const team = teamData.slice();
  if (synergy.mode === 'replace') {
    const target = CHARACTERS[synergy.becomes];
    if (!target) return { team: teamData, synergy: null };
    team[sourceIndex] = carry(target, teamData[sourceIndex]);
  } else if (synergy.mode === 'passiveSwap') {
    const src = teamData[sourceIndex];
    const isWeak = src.id === 'c_insanity_weak';
    team[sourceIndex] = { ...src, passive: { ...(isWeak ? synergy.weakPassive : synergy.sourcePassive) }, _synergyId: synergy.id, _originalId: src.id };
    const partner = teamData[partnerIndex];
    team[partnerIndex] = { ...partner, passive: { ...synergy.partnerPassive }, _synergyId: synergy.id, _originalId: partner.id };
  }
  return { team, synergy, sourceIndex, partnerIndex };
}

class Fighter {
  constructor(data, isAI = false) {
    this.id = data.id; this.name = data.name; this.type = data.type;
    this.maxHp = data.hp; this.currentHp = data.hp;
    this.baseAtk = data.atk; this.baseDef = data.def;
    this.atkMod = 0; this.defMod = 0;
    this.passive = data.passive ? { ...data.passive } : null;
    this.level = data.level || 1; this.shiny = data.shiny || false; this.isAI = isAI;
    this.abilities = data.abilities.map(a => ({ ...a, currentUses: a.maxUses, cooldownLeft: 0 }));
    this.equipped = data.equipped || null; // --- Jevil relic slot (jevils_scythe / jevils_tail)
    this._effectChanceMult = (this.equipped === 'jevils_tail') ? 2 : 1; // Jevil's Tail: doubles the holder's status/effect proc chances
    this.statusEffects = []; this.isCharging = false; this.chargedAbility = null;
    this.isReleasing = false; this.dodgeNextAttack = false; this.critBoost = 0;
    this.turnCount = 0; this.skipNextTurn = false; this.lastStandUsed = false;
    this.parrying = false; this.taunted = false;
    // --- SCAMTON EVENT: Power Points (Asriel/Noelle/Charkis "Rewritten") ---
    this._pp = 0;
    this._rewrittenGuard = null; this._rewrittenGuardAbsorbed = 0; this._rewrittenGuardPPGain = 0;
    this._immunityShield = false; this._lightIgnitionBurn = 0;
    // Track accumulated passive ATK bonus separately so it persists across switches
    this.passiveAtkAccumulated = 0;
    // Timeline Star saved state
    this.savedState = null;
    this.savedStateTurnsLeft = 0;
    // timeSplit: store original and phase2 abilities
    if (data.passive?.type === 'timeSplit') {
      this._originalAbilities = this.abilities.map(a => ({ ...a }));
      this._phase2Abilities = data.phase2Abilities ? data.phase2Abilities.map(a => ({ ...a, currentUses: a.maxUses, cooldownLeft: 0 })) : this._originalAbilities;
      this._agemSide = false;
    }
    // --- UPDATE 31: alternate movesets (REBAR!Insanity Impale / !REBAR! Grab) ---
    if (data.impaleAbilities || data.grabAbilities) {
      this._baseAbilities = this.abilities.map(a => ({ ...a }));
      this._altAbilities = (data.impaleAbilities || data.grabAbilities).map(a => ({ ...a, currentUses: a.maxUses, cooldownLeft: 0 }));
      this._altMovesetName = data.impaleAbilities ? 'impale' : 'grab';
      this._onAltMoveset = false;
    }
    // gastersHelp: init shield/assist state
    if (data.passive?.type === 'gastersHelp') {
      this._gastersHelpShield = false;
      this._gastersHelpAssist = 0;
    }
    // --- UPDATE 32: Season Champion shiny — +6/+6 instead of the normal +2/+2 ---
    this.seasonChampion = data.seasonChampion || false;
    if (this.shiny) {
      // +6/+6 ONLY for the Season champion's granted copy. Every other shiny
      // (including Shiny Star ones) keeps the standard +2/+2.
      const _sb = this.seasonChampion ? 6 : 2;
      this.baseAtk += _sb; this.baseDef += _sb;
    }
    // --- UPDATE 32: Mad Mew Mew — Doki Meter state ---
    if (data.passive?.type === 'dokiMeter') {
      this._doki = 0;
      this._dokiNegateUsed = false;
      this._noDodge = true;
    }
    // FT!Sans: per-summon Memories uses tracking
    if (data.id === 'ft_sans') {
      this._memoriesUses = { flowey: 10, mettaton: 10, toriel: 10, asgore: 10, papyrus: 10, sans: 10, undyne: 10 };
      this._memoriesCooldown = 0;
      this._lastDamageTaken = 0;
    }
    // Shanghaivania Ink Sans: Ink Trail + Last Resort tracking
    if (data.id === 'shanghaivania_ink_sans') {
      this._inkTrailActive = false;
      this._inkTrailTurns = 0;
      this._summonedClassicLastResort = false;
      this._justiceReload = false;
    }
    // UV Swap Sans: team ability used flag
    if (data.id === 'uv_swap_sans') { this._forThemUsed = false; }
    // Asgore boss: hesitation + determination phase tracking
    if (data.id === 'asgore') { this._asgorePhase = 'hesitation'; this._asgorePhaseSet = false; this._asgoreCharging = false; this._asgoreChargedDmg = 0; }
    // Dustrust/True Fresh: kill-stack passives
    if (data.passive?.type === 'manicFixation') { this._manicFixationKills = 0; }
    if (data.passive?.type === 'parasiticDesires') { this._parasiticKills = 0; }
    // --- UPDATE 22: Fallen Priest — boss kill counts injected by buildTeamData ---
    if (data.id === 'fallen_priest') {
      this._bossKills = data.bossKills || {};
      this._necroIndex = 0; // God's Necromaniac cycles the 5 base boss abilities
      // A Priests Repent for the Dead — +3 ATK per power of 10 kills per base boss (Lv5 only)
      if (this.level >= (data.passive?.unlockLevel || 5)) {
        let bonus = 0;
        for (const bid of ['toriel', 'papyrus', 'undyne', 'mettaton_neo', 'asgore']) {
          const kills = this._bossKills[bid] || 0;
          if (kills >= 1) bonus += 3 * Math.floor(Math.log10(kills));
        }
        this.passiveAtkAccumulated += bonus;
        this._priestRepentBonus = bonus;
      }
    }
  }
  // --- SCAMTON EVENT: Power Points helpers ---
  get maxPP() { return this.passive?.maxPP || 100; }
  hasPP() { return this.passive?.type === 'powerPoints'; }
  gainPP(amount) {
    if (!this.hasPP()) return 0;
    const before = this._pp || 0;
    this._pp = Math.min(this.maxPP, before + Math.max(0, Math.floor(amount)));
    return this._pp - before;
  }
  spendPP(cost) {
    if (!this.hasPP()) return false;
    if ((this._pp || 0) < cost) return false;
    this._pp -= cost;
    return true;
  }
  get atk() { return Math.max(1, this.baseAtk + this.atkMod + this.passiveAtkAccumulated); }
  get def() { return Math.max(1, this.baseDef + this.defMod); }
  get isAlive() { return this.currentHp > 0; }
  hasStatus(name) { return this.statusEffects.some(s => s.name === name); }
  consumeAttackMiss() {
    if (this._rosyPinkActive) { this._rosyPinkActive = false; return null; } // guaranteed hit
    if (this._missNextAttack) { this._missNextAttack = false; return { source: 'forced' }; }
    const blindness = this.statusEffects.find(s => s.name === 'Blindness');
    if (blindness && Math.random() < (blindness.missChance || 0)) return { source: 'blindness' };
    // --- UPDATE 15: Concussion stacks with Blindness
    const concussion = this.statusEffects.find(s => s.name === 'Concussion');
    if (concussion && Math.random() < (concussion.missChance || 0.25)) return { source: 'concussion' };
    // --- UPDATE 17 BUG FIX: _missChanceBonus from Heavy Rain (Tears in the Rain) and Sorrow Tears
    if (this._missChanceBonus && this._missChanceBonus > 0 && Math.random() < this._missChanceBonus) return { source: 'rain' };
    return null;
  }
  takeDamage(amount) {
    // --- UPDATE 32: Doki Meter — first super effective hit is fully negated, +2 Doki ---
    if (amount > 0 && this.passive?.type === 'dokiMeter' && hasPassiveUnlocked(this.level)
        && !this._dokiNegateUsed && (this._incomingTypeMult || 1) > 1) {
      this._dokiNegateUsed = true;
      this._doki = (this._doki || 0) + (this.passive.negateDoki || 2);
      this._incomingTypeMult = 1;
      return { lastStand: false, damage: 0, dokiNegate: true, doki: this._doki };
    }
    // Forced Smile immunity
    if (this._forcedSmileImmune && amount > 0) return { lastStand: false, damage: 0, forcedSmileBlocked: true };
    // --- SCAMTON EVENT: Immunity Shield (Charkis) — tank one hit fully ---
    if (this._immunityShield && amount > 0) {
      this._immunityShield = false;
      return { lastStand: false, damage: 0, immunityShield: true, blocked: amount };
    }
    // --- SCAMTON EVENT: Rewritten guards (Patience Parry / Glacier Defense / Hat Stance) ---
    if (this._rewrittenGuard && amount > 0) {
      const g = this._rewrittenGuard;
      const applies = !g.types || g.types.includes(this._incomingAbilityType);
      if (applies) {
        const absorbed = Math.floor(amount * g.pct);
        const through = Math.max(0, amount - absorbed);
        this._rewrittenGuardAbsorbed = (this._rewrittenGuardAbsorbed || 0) + absorbed;
        if (g.ppConvert) this._rewrittenGuardPPGain = (this._rewrittenGuardPPGain || 0) + this.gainPP(absorbed * g.ppConvert);
        this.currentHp = Math.max(0, this.currentHp - through);
        return { lastStand: false, damage: through, rewrittenGuard: absorbed, guardLabel: g.label };
      }
    }
    // --- UPDATE 31: Steel Bones (REBAR!Insanity / !REBAR!) — block chance then flat 20% reduction ---
    if (this.passive?.type === 'steelBones' && amount > 0 && hasPassiveUnlocked(this.level)) {
      let bc = this.passive.blockChance || 0;
      if (this.passive.blockRequiresHeld && this._onAltMoveset) bc = 0;          // rebar thrown = not in hand
      if (this.passive.blockRequiresNoGrab && this._onAltMoveset) bc = 0;        // holding a grab
      if (this._rebarChargeBlock > 0) bc = this._rebarChargeBlock;               // Impale retrieve charge
      if (this._rebarBlockDoubleTurns > 0) bc *= 2;                              // Top Strike / Steel Bash
      if (this._rebarStanceBlockDouble > 0) bc *= 2;                             // defensive Stance Change
      if (this._bloodthirstActive) bc = 0;                                       // BLOODTHIRST removes block
      if (bc > 0 && Math.random() < bc) return { lastStand: false, damage: 0, steelBonesBlock: true };
      if (!this._bloodthirstActive) amount = Math.floor(amount * (1 - (this.passive.reduction || 0.20)));
    }
    // --- UPDATE 31: GRAB — every hit taken chips away at the grab ---
    if (this._grabActive && amount > 0) {
      this._grabHitsRemaining = (this._grabHitsRemaining || 0) - 1;
      if (this._grabHitsRemaining <= 0) {
        this._grabActive = false;
        this._grabBroken = true;
        if (this._swapMoveset) this._swapMoveset(false);
        const _g = this.abilities.find(a => a.special?.type === 'rebarGrab' || a.special?.type === 'rebarGrabThrow');
        if (_g) _g.cooldownLeft = (this._grabBreakCooldown || 5) + 1;
      }
    }
    // --- UPDATE 31: Unnamed Kindness — heal 5 HP every time you take damage ---
    if (this.passive?.type === 'unnamedKindness' && amount > 0 && hasPassiveUnlocked(this.level)) {
      this._kindnessPendingHeal = (this.passive.healOnHit || 5);
    }
    // --- UPDATE 31: Unnamed Kindness "Block" move — absorb 80%, optional reflect+stun ---
    if (this._kindnessBlockPct > 0 && amount > 0) {
      const absorbed = Math.floor(amount * this._kindnessBlockPct);
      const through = Math.max(0, amount - absorbed);
      const doReflect = this._kindnessBlockReflect;
      this._kindnessBlockPct = 0; this._kindnessBlockReflect = false;
      this.currentHp = Math.max(0, this.currentHp - through);
      if (this.passive?.type === 'unnamedKindness' && hasPassiveUnlocked(this.level) && through > 0) this.heal(this.passive.healOnHit || 5);
      const _kref = doReflect ? Math.floor(absorbed / 2) : 0;
      this._kindnessReflectPending = _kref > 0 ? { reflect: _kref, stun: doReflect } : null;
      return { lastStand: false, damage: through, kindnessMoveBlock: absorbed, kindnessReflect: _kref, kindnessStun: doReflect };
    }
    // --- UPDATE 17: AfterDust Dusty Determination dodge stack (consumed on incoming damage)
    if (this._dustyDetDodges > 0 && amount > 0) {
      this._dustyDetDodges--;
      return { lastStand: false, damage: 0, dustyDodge: true };
    }
    // --- UPDATE 17: Influenced Killer PERRY — reflects incoming attack
    if (this._perryActive && amount > 0) {
      this._perryActive = false;
      // Trigger recovery if attack exceeds threshold
      if (amount > (this._perryRecoverThreshold || 150)) {
        this._perryRecoverTurns = 1;
        this.skipNextTurn = true;
      }
      return { lastStand: false, damage: 0, perryReflect: amount };
    }
    // --- UPDATE 17: Nightmare Tentacle Shield — absorb damage before HP
    if (this._tentacleShieldHp > 0 && amount > 0) {
      const absorbed = Math.min(this._tentacleShieldHp, amount);
      this._tentacleShieldHp -= absorbed;
      amount -= absorbed;
      if (amount <= 0) {
        return { lastStand: false, damage: 0, tentacleShieldAbsorbed: absorbed };
      }
    }
    // --- UPDATE 20: DUSTBEEF "block block" — 1/6 chance to block an attack entirely
    if (this.passive?.type === 'blockBlock' && amount > 0 && hasPassiveUnlocked(this.level) && Math.random() < (this.passive.chance || 1/6)) {
      return { lastStand: false, damage: 0, blockBlock: true };
    }
    // --- Perfect Evasion (Bad Time Sans boss) ---
    if (this.passive?.type === 'perfectEvasion' && amount > 0) {
      this._perfectEvasionDodges = (this._perfectEvasionDodges || 0);
      const isAsleepTurn = this.turnCount === 4 && !this._perfectEvasionAwoke;
      if (isAsleepTurn) {
        // no dodge while asleep
      } else if (this._perfectEvasionDodges < 5) {
        this._perfectEvasionDodges++;
        return { lastStand: false, damage: 0, perfectEvasion: true };
      } else if (Math.random() < 0.4) {
        return { lastStand: false, damage: 0, perfectEvasion: true };
      }
    }
    if (this._badTimeFinalDodges > 0 && amount > 0) {
      this._badTimeFinalDodges--;
      return { lastStand: false, damage: 0, perfectEvasion: true };
    }
    // Block next hit (Agem Perseverance)
    if (this._blockNextHit && amount > 0) { this._blockNextHit = false; return { lastStand: false, damage: 0, blocked: true }; }
    // Gaster's Help shield: halve next hit
    if (this._gastersHelpShield && amount > 0) { this._gastersHelpShield = false; amount = Math.floor(amount / 2); }
    // NO EFFECT shield: block hits under threshold, shatter on hits over threshold
    if (this._noEffectShield && amount > 0) {
      if (amount >= this._noEffectShieldThreshold) {
        this._noEffectShield = false; this._noEffectShieldTurns = 0;
        amount = 1; // reduced to 1 HP on shatter
        this.currentHp = 1;
        return { lastStand: false, damage: amount, noEffectShatter: true };
      } else {
        return { lastStand: false, damage: 0, noEffectBlocked: true };
      }
    }
    // Save Point Anchor damage reduction
    if (this._damageReduction && this._damageReductionTurns > 0 && amount > 0) {
      amount = Math.floor(amount * (1 - this._damageReduction));
    }
    // --- UPDATE 22: Blessing (Fallen Priest) — negate 30% of damage; the negated amount is healed after damage lands ---
    if (this._blessingTurns > 0 && amount > 0) {
      const negated = Math.floor(amount * 0.30);
      if (negated > 0) {
        amount -= negated;
        this._blessingPendingHeal = negated;
      }
    }
    if (this.passive?.type === 'lastStand' && !this.lastStandUsed && hasPassiveUnlocked(this.level)) {
      if (this.currentHp - amount <= 0) {
        this.lastStandUsed = true; this.currentHp = 1;
        this.passiveAtkAccumulated += this.passive.atkBoost; this.baseDef = 0; this.defMod = 0;
        return { lastStand: true, damage: amount };
      }
    }
    // --- UPDATE 17: Dream Sans "Positive" — two lives, reduced stats on second
    if (this.passive?.type === 'positive' && !this._positiveSecondLife && hasPassiveUnlocked(this.level)) {
      if (this.currentHp - amount <= 0) {
        this._positiveSecondLife = true;
        this.maxHp = this.passive.secondLifeHp || 150;
        this.currentHp = this.maxHp;
        // Adjust stats by overriding base values
        const atkDiff = (this.passive.secondLifeAtk || 13) - this.baseAtk;
        const defDiff = (this.passive.secondLifeDef || 13) - this.baseDef;
        this.baseAtk = this.passive.secondLifeAtk || 13;
        this.baseDef = this.passive.secondLifeDef || 13;
        return { lastStand: false, damage: amount, positiveSecondLife: true };
      }
    }
    // --- UPDATE 17: Influenced Killer Determination — survive fatal hit at 1 HP (once)
    if (this.passive?.type === 'influencedDetermination' && !this._influencedDetUsed && hasPassiveUnlocked(this.level)) {
      if (this.currentHp - amount <= 0) {
        this._influencedDetUsed = true;
        this.currentHp = 1;
        return { lastStand: false, damage: amount, influencedDetermination: true };
      }
    }
    if (this.passive?.type === 'murderPassive' && hasPassiveUnlocked(this.level) && amount > 0) {
      this.passiveAtkAccumulated = Math.min(this.passive.maxBonus, this.passiveAtkAccumulated + this.passive.gainPerHit);
    }
    // UV Swap Sans parry — 20% chance to take 70% dmg and reflect 30%
    if (this.passive?.type === 'uvParry' && amount > 0 && Math.random() < this.passive.chance) {
      const reduced = Math.floor(amount * 0.7);
      const reflect = Math.floor(amount * 0.3);
      this.currentHp = Math.max(0, this.currentHp - reduced);
      return { lastStand: false, damage: reduced, uvParry: true, reflect };
    }
    // Omniversal Prodigy (Avenge Sans) — auto-parry incoming attacks, counter 30%, chance to stun
    if (this.passive?.type === 'omniversalProdigy' && amount > 0 && this._incomingAttackType && Math.random() < this.passive.parryChance) {
      this._incomingAttackType = null;
      const reflect = Math.floor(amount * (this.passive.counterPercent || 0.30));
      const opStun = Math.random() < (this.passive.counterStunChance || 0.30);
      return { lastStand: false, damage: 0, omniProdigyParry: true, reflect, omniProdigyStun: opStun };
    }
    // Oceantale Papyrus — Aquatic Reflexes: 25% block (negate, +1 DEF); of those, 35% become a swordfish counter (negate, reflect 50%, +2 ATK)
    if (this.passive?.type === 'aquaticReflexes' && amount > 0 && hasPassiveUnlocked(this.level) && Math.random() < (this.passive.blockChance || 0.25)) {
      if (Math.random() < (this.passive.counterChance || 0.35)) {
        this.atkMod += 2;
        this._swordfishTriggered = true;
        return { lastStand: false, damage: 0, aquaticCounter: true, reflect: Math.floor(amount * 0.5) };
      }
      this.defMod += 1;
      return { lastStand: false, damage: 0, aquaticBlock: true };
    }
    // Will to Avenge (Weak Avenge Sans) — gain Spite stack on damage
    if (this.passive?.type === 'willToAvenge' && amount > 0) {
      this._spiteStacks = Math.min(10, (this._spiteStacks || 0) + 1);
    }
    // --- UPDATE 13 ---
    // Bodyguards (Mafiatale) — first 3 turns 15% reduction; Magic incoming = bodyguards block (-20%) + 10 retaliation
    if (this.passive?.type === 'bodyguards' && amount > 0 && hasPassiveUnlocked(this.level)) {
      if ((this._mafiaTurnsActive || 0) < 3) {
        amount = Math.floor(amount * 0.85);
      }
      if (this._incomingAttackType === 'Magic') {
        amount = Math.floor(amount * 0.80);
        this._bodyguardsRetaliate = 10;
      }
    }
    // DT Extractor (CotV) — if hit > 25% maxHp and triggers remaining: negate damage, heal 30
    if (this.passive?.type === 'voidExtractor' && amount > 0 && hasPassiveUnlocked(this.level)) {
      if ((this._extractorTriggers || 0) < 3 && amount > Math.floor(this.maxHp * 0.25)) {
        this._extractorTriggers = (this._extractorTriggers || 0) + 1;
        const healed = Math.min(30, this.maxHp - this.currentHp);
        this.currentHp = Math.min(this.maxHp, this.currentHp + 30);
        return { lastStand: false, damage: 0, voidExtractorPulse: true, healed };
      }
    }
    // Smoky Counter (Swapfell Papyrus) — fully dodge and counter
    if (this._smokyCounter && amount > 0) {
      const counter = this._smokyCounter;
      this._smokyCounter = 0;
      this._smokyCounterRetaliate = counter;
      return { lastStand: false, damage: 0, smokyDodge: true };
    }
    // Shield HP: absorb damage from shield before real HP
    if (this._shieldHp && this._shieldHp > 0 && amount > 0) {
      if (amount <= this._shieldHp) { this._shieldHp -= amount; return { lastStand: false, damage: amount, shieldAbsorbed: amount }; }
      amount -= this._shieldHp; this._shieldHp = 0;
    }
    // --- UPDATE 15 PASSIVES ---
    // Frisk DETERMINATION — survive once at 1 HP (similar to lastStand but no stat changes)
    if (this.passive?.type === 'determination' && !this._determinationUsed && hasPassiveUnlocked(this.level)) {
      if (this.currentHp - amount <= 0) {
        this._determinationUsed = true; this.currentHp = 1;
        return { lastStand: false, damage: amount, determinationRevive: true };
      }
    }
    // YOUR FAULT passive — 15% chance to grab attack and reflect full
    if (this.passive?.type === 'yourFault' && amount > 0 && hasPassiveUnlocked(this.level) && Math.random() < (this.passive.chance || 0.15)) {
      this._yourFaultReflect = amount;
      return { lastStand: false, damage: 0, yourFaultParry: true, reflect: amount };
    }
    // Rose KINDNESS GUARDIAN — 15% chance to block and counter for 12
    if (this.passive?.type === 'kindnessGuardian' && amount > 0 && hasPassiveUnlocked(this.level) && Math.random() < (this.passive.chance || 0.15)) {
      this._kindnessGuardianCounter = this.passive.counterDmg || 12;
      return { lastStand: false, damage: 0, kindnessBlock: true, counter: this.passive.counterDmg || 12 };
    }
    // Core Frisk OMNIPRESENCE — vanish negates all damage
    if (this._omnipresenceTurns > 0 && amount > 0) {
      return { lastStand: false, damage: 0, omnipresenceDodge: true };
    }
    // YOUR INNER TORMENT — every 2 hits absorb soul (PvE/PvB)
    if (this.passive?.type === 'stopHiding' && amount > 0 && hasPassiveUnlocked(this.level)) {
      this._yitHitCounter = (this._yitHitCounter || 0) + 1;
      if (this._yitHitCounter >= (this.passive.hitInterval || 2)) {
        this._yitHitCounter = 0;
        this.maxHp += (this.passive.hpGain || 50);
        this.currentHp += (this.passive.hpGain || 50);
        this.atkMod -= (this.passive.atkLoss || 2);
        this.defMod -= (this.passive.defLoss || 1);
        this._yitTriggered = true;
      }
    }
    // SINGULARITY — store damage instead of applying it
    // --- UPDATE 19: Seraphim Integrity dodge ---
    if (this._integrityDodge > 0 && amount > 0 && Math.random() < this._integrityDodge) {
      this._integrityDodge = 0;
      return { lastStand: false, damage: 0, integrityDodge: true };
    }
    if (this._singularityTurns > 0 && amount > 0) {
      this._singularityStored = (this._singularityStored || 0) + amount;
      return { lastStand: false, damage: amount, singularityStored: true };
    }
    // --- UPDATE 24: Divine Hatred shield — block the next attacks after surviving a fatal hit ---
    if (this._divineShieldBlocks > 0 && amount > 0) { this._divineShieldBlocks--; return { lastStand: false, damage: 0, divineShield: true }; }
    // --- UPDATE 24: The Murderer's Determination — The Locket reduces incoming by 30% while above 40% HP ---
    if (this.passive?.type === 'murderersDetermination' && hasPassiveUnlocked(this.level) && !this._bagDestroyed && (this.currentHp / this.maxHp) >= (this.passive.hpThreshold || 0.4)) {
      amount = Math.floor(amount * (1 - (this.passive.locketReduction || 0.30)));
    }
    // --- UPDATE 24: Divine Hatred — survive a fatal hit once per battle at 1 HP + shield ---
    if (this.passive?.type === 'divineHatred' && hasPassiveUnlocked(this.level) && !this._divineHatredUsed && amount > 0 && this.currentHp - amount <= 0) {
      this._divineHatredUsed = true; this.currentHp = 1; this._divineShieldBlocks = this.passive.shieldBlocks || 2;
      return { lastStand: true, damage: 1, divineHatred: true };
    }
    this.currentHp = Math.max(0, this.currentHp - amount);
    // --- UPDATE 24: The Murderer's Determination — transform on first drop below 40% HP ---
    if (this.passive?.type === 'murderersDetermination' && hasPassiveUnlocked(this.level) && !this._bagDestroyed && this.currentHp > 0 && (this.currentHp / this.maxHp) < (this.passive.hpThreshold || 0.4)) {
      this._bagDestroyed = true;
      this.currentHp = Math.min(this.maxHp, this.currentHp + (this.passive.healAmount || 90));
      this.defMod -= (this.passive.defLoss || 5);
      this.passiveAtkAccumulated += (this.passive.atkGain || 8);
      if (this.abilities && this.abilities[3]) this.abilities[3].currentUses = this.abilities[3].maxUses;
      this._endgoalTransformed = true;
    }
    // --- UPDATE 22: Blessing — heal the negated amount now that damage has landed ---
    if (this._blessingPendingHeal > 0 && this.currentHp > 0) {
      this.currentHp = Math.min(this.maxHp, this.currentHp + this._blessingPendingHeal);
      this._blessingPendingHeal = 0;
    }
    // --- UPDATE 31: Unnamed Kindness passive heal (after damage lands) ---
    if (this._kindnessPendingHeal > 0 && this.currentHp > 0) {
      this.currentHp = Math.min(this.maxHp, this.currentHp + this._kindnessPendingHeal);
      this._kindnessPendingHeal = 0;
    }
    // --- UPDATE 31: SIXBONES I̷T̸ ̶H̷U̵R̸T̷S̶ — +1 DEF next turn per hit taken ---
    if (this.passive?.type === 'itHurts' && amount > 0 && hasPassiveUnlocked(this.level)) {
      this._sixDefNextTurn = (this._sixDefNextTurn || 0) + (this.passive.defGainPerHit || 1);
    }
    // --- UPDATE 31: Terminal Delirium (Hardmode Insanity) — +1 ATK per 10% HP lost (max 6), 10% counter ---
    if (this.passive?.type === 'terminalDelirium' && amount > 0 && hasPassiveUnlocked(this.level) && this.currentHp > 0) {
      const lostTiers = Math.floor((this.maxHp - this.currentHp) / (this.maxHp * 0.10));
      const already = this._delirumTiers || 0;
      if (lostTiers > already) {
        const gain = Math.min((this.passive.maxAtk || 6) - already, lostTiers - already);
        if (gain > 0) { this.passiveAtkAccumulated += gain; this._delirumTiers = already + gain; }
      }
      if (Math.random() < (this.passive.counterChance || 0.10)) this._delirumCounter = (this.passive.counterDamage || 25);
    }
    if (!this.isAI) this._lastDamageTaken = amount;
    return { lastStand: false, damage: amount };
  }
  // --- UPDATE 31: Goop helpers (stacking, unpurgable, tied to the applier) ---
  _applyGoop(target, stacks, sourceId) {
    if (!target || stacks <= 0) return 0;
    let g = target.statusEffects.find(s => s.name === 'Goop');
    if (!g) {
      g = { name: 'Goop', emoji: '🫠', damagePerTurn: 0, turnsLeft: 999, stacks: 0, unpurgable: true, _goopSource: sourceId || this.id };
      target.statusEffects.push(g);
    }
    g.stacks += stacks;
    g.damagePerTurn = g.stacks;
    g.turnsLeft = 999;
    g._goopSource = sourceId || this.id;
    return g.stacks;
  }
  _goopStacks(target) {
    const g = target && target.statusEffects.find(s => s.name === 'Goop');
    return g ? (g.stacks || 0) : 0;
  }
  _consumeGoop(target, amount) {
    const g = target && target.statusEffects.find(s => s.name === 'Goop');
    if (!g) return 0;
    const taken = (amount == null) ? g.stacks : Math.min(g.stacks, amount);
    g.stacks -= taken;
    g.damagePerTurn = g.stacks;
    if (g.stacks <= 0) target.statusEffects = target.statusEffects.filter(s => s.name !== 'Goop');
    return taken;
  }
  _clearGoopFrom(target, sourceId) {
    if (!target || !target.statusEffects) return false;
    const before = target.statusEffects.length;
    target.statusEffects = target.statusEffects.filter(s => !(s.name === 'Goop' && (!sourceId || s._goopSource === sourceId)));
    return target.statusEffects.length !== before;
  }
  // --- UPDATE 31: apply a status with a custom duration (spec durations differ from defaults) ---
  _applyStatusFor(target, key, turns) {
    if (!target) return null;
    const r = target.addStatus(key);
    if (r && turns) {
      const t = STATUS_EFFECTS[key];
      const st = target.statusEffects.find(s => s.name === t.name);
      if (st) st.turnsLeft = turns;
    }
    return r;
  }
  // --- UPDATE 31: swap between base and alternate moveset, preserving uses/cooldowns ---
  _swapMoveset(toAlt) {
    if (!this._baseAbilities || !this._altAbilities) return false;
    if (!!toAlt === !!this._onAltMoveset) return false;
    const current = this.abilities.map(a => ({ ...a }));
    if (toAlt) { this._baseAbilities = current; this.abilities = this._altAbilities.map(a => ({ ...a })); }
    else { this._altAbilities = current; this.abilities = this._baseAbilities.map(a => ({ ...a })); }
    this._onAltMoveset = !!toAlt;
    return true;
  }
  heal(amount) {
    // --- UPDATE 32: Superb Karaoke — healing is stolen by the absorber ---
    if (amount > 0 && this._karaokeAbsorbTurns > 0 && this._karaokeAbsorber && this._karaokeAbsorber.isAlive) {
      const _abs = this._karaokeAbsorber;
      const _b = _abs.currentHp;
      _abs.currentHp = Math.min(_abs.maxHp, _abs.currentHp + amount);
      this._karaokeAbsorbedLast = _abs.currentHp - _b;
      return 0;
    }
    const before = this.currentHp;
    this.currentHp = Math.min(this.maxHp, this.currentHp + amount);
    if (!this.isAI) this._healedLastTurn = true;
    return this.currentHp - before;
  }
  // --- JEVIL'S TAIL: temporarily double this attack's effect-proc chances ---
  // Replaces the fighter's own copy of ability.special (never the shared gameData
  // object), so it's always safe. Restored at the holder's next turn.
  _tailDoubleSpecial(ability) {
    if ((this._effectChanceMult || 1) <= 1 || !ability || !ability.special) return;
    const orig = ability.special;
    const doubled = { ...orig };
    let changed = false;
    for (const k of Object.keys(doubled)) {
      if (typeof doubled[k] === 'number' && /chance/i.test(k) && doubled[k] > 0 && doubled[k] < 1) {
        doubled[k] = Math.min(1, doubled[k] * this._effectChanceMult);
        changed = true;
      }
    }
    if (changed) { ability.special = doubled; this._tailRestore = { ability, orig }; }
  }
  _tailRestoreSpecial() {
    if (this._tailRestore) { this._tailRestore.ability.special = this._tailRestore.orig; this._tailRestore = null; }
  }

  addStatus(statusKey) {
    const t = STATUS_EFFECTS[statusKey]; if (!t) return null;
    // --- UPDATE 13: Ruthless Judgement (Storyfell Chara) — immune to stun above 50% HP ---
    if (this.passive?.type === 'ruthlessJudgement' && t.name === 'Stun' && (this.currentHp / this.maxHp) > 0.5) return null;
    // --- UPDATE 15: Relaxed (Ralsei) — immune to Flinch and stat drops ---
    if (this.statusEffects.find(s => s.name === 'Relaxed') && t.name === 'Flinch') return null;
    // UPDATE 30: Papyrus Belief — below 40% HP: immune to Stun/Flinch
    if (this.passive?.type === 'shatteredExpectations' && (this.currentHp / this.maxHp) < (this.passive.lowHpThreshold || 0.40) && (t.name === 'Stun' || t.name === 'Flinch')) return null;
    const existing = this.statusEffects.find(s => s.name === t.name);
    if (existing) { Object.assign(existing, { ...t, turnsLeft: t.duration }); return { refreshed: true, ...t }; }
    const status = { ...t, turnsLeft: t.duration };
    this.statusEffects.push(status);
    if (status.defReduction) this.defMod -= status.defReduction;
    return { refreshed: false, ...t };
  }
  processActionStatusEffects(isAttackingMove) {
    const results = [];
    for (const s of this.statusEffects) {
      let damage = 0;
      if (s.name === 'Bone Field') {
        const min = s.damageMin || 5, max = s.damageMax || 10;
        damage += Math.floor(Math.random() * (max - min + 1)) + min;
      }
      if (isAttackingMove && s.damageOnAttack) damage += s.damageOnAttack;
      if (damage > 0) {
        this.currentHp = Math.max(0, this.currentHp - damage);
        results.push({ name: s.name, emoji: s.emoji, damage, turnsLeft: s.turnsLeft });
      }
    }
    return results;
  }
  processStatusEffects() {
    const results = [];
    this.statusEffects = this.statusEffects.filter(s => {
      if (s.turnsLeft > 0) {
        if (s.damagePerTurn) { const _sdb = (this._statusDamageBonusTurns > 0) ? (this._statusDamageBonus || 0) : 0; const _dmg = s.damagePerTurn + _sdb; this.currentHp = Math.max(0, this.currentHp - _dmg); results.push({ name: s.name, emoji: s.emoji, damage: _dmg, turnsLeft: s.turnsLeft - 1 }); }
        // --- UPDATE 20: Rust ticks -1 DEF each turn while active ---
        if (s.name === 'Rust') {
          this.defMod -= 1;
          s._rustAccumulated = (s._rustAccumulated || 0) + 1;
          results.push({ name: s.name, emoji: s.emoji, damage: 0, turnsLeft: s.turnsLeft - 1, defLoss: 1 });
        }
        s.turnsLeft--;
        if (s.turnsLeft <= 0 && s.defReduction) this.defMod += s.defReduction;
        // --- UPDATE 20: Restore Rust DEF when status ends ---
        if (s.turnsLeft <= 0 && s.name === 'Rust' && s._rustAccumulated) { this.defMod += s._rustAccumulated; }
        return s.turnsLeft > 0;
      }
      if (s.defReduction) this.defMod += s.defReduction;
      if (s.name === 'Rust' && s._rustAccumulated) this.defMod += s._rustAccumulated;
      return false;
    });
    // UPDATE 30: UV Swap Bone Tower Barrage — +fixed status damage debuff ticks down
    if (this._statusDamageBonusTurns > 0) { this._statusDamageBonusTurns--; if (this._statusDamageBonusTurns <= 0) this._statusDamageBonus = 0; }
    // UPDATE 30: UV Swap Blue Bone Combo trap ticks down
    if (this._uvTrapTurns > 0) this._uvTrapTurns--;
    return results;
  }
  tickCooldowns() { for (const a of this.abilities) { if (a.cooldownLeft > 0) a.cooldownLeft--; } }

  // Timeline Star: save current state
  saveState() {
    this.savedState = {
      hp: this.currentHp, atkMod: this.atkMod, defMod: this.defMod,
      passiveAtkAccumulated: this.passiveAtkAccumulated,
    };
    this.savedStateTurnsLeft = 4;
  }
  // Timeline Star: restore saved state
  restoreState() {
    if (!this.savedState) return false;
    this.currentHp = Math.min(this.maxHp, this.savedState.hp);
    this.atkMod = this.savedState.atkMod;
    this.defMod = this.savedState.defMod;
    this.passiveAtkAccumulated = this.savedState.passiveAtkAccumulated;
    this.savedState = null;
    this.savedStateTurnsLeft = 0;
    return true;
  }
  tickTimeline() {
    if (this.savedStateTurnsLeft > 0) {
      this.savedStateTurnsLeft--;
      if (this.savedStateTurnsLeft <= 0) return true; // time to restore
    }
    return false;
  }
}

class Battle {
  constructor(playerTeam, enemy, ownerId) {
    // --- UPDATE 31: resolve and apply the single active team synergy ---
    const _syn = applyTeamSynergy(playerTeam);
    this.activeSynergy = _syn.synergy || null;
    playerTeam = _syn.team;
    this.playerTeam = playerTeam.map(c => new Fighter(c, false));
    this.activePlayerIndex = 0; this.enemy = new Fighter(enemy, true);
    this.turnNumber = 0; this.isOver = false; this.winner = null; this.ownerId = ownerId;
    this.isBoss = false; this.teamAbilityCooldown = 0;
    // forcedSmile: set immune turns on enemy if applicable
    if (this.enemy.passive?.type === 'forcedSmile') {
      this.enemy._forcedSmileImmune = true;
      this.enemy._forcedSmileTurnsLeft = this.enemy.passive.immuneTurns;
    }
    // --- UPDATE 15 BATTLE INIT ---
    const hasKris = this.playerTeam.some(f => f.id === 'kris');
    for (const f of this.playerTeam) {
      // Frisk: reset Mercy meter
      if (f.passive?.type === 'determination') {
        f._mercyMeter = 0;
        f._determinationUsed = false;
      }
      // Noelle Friendly Support — shield
      if (f.passive?.type === 'friendlySupport') {
        f._shieldHp = hasKris ? (f.passive.shieldWithKris || 50) : (f.passive.shieldNormal || 25);
      }
      // Ralsei Tension — +3 DEF turn 1
      if (f.passive?.type === 'tension') {
        f.defMod += (f.passive.startDefBoost || 3);
        f._ralseiStartDefTurns = 1;
      }
      // Clover Reload — start with 6 ammo
      if (f.passive?.type === 'reload') {
        f._ammo = f.passive.startingAmmo || 6;
        f._reloadingTurns = 0;
      }
      // NMD Chara — buff vs Killer Sans
      if (f.passive?.type === 'noMoreDeals' && this.enemy.id === f.passive.targetEnemy) {
        f.atkMod += (f.passive.atkBoost || 2);
        f.defMod += (f.passive.defBoost || 3);
        f.maxHp += (f.passive.hpBoost || 34);
        f.currentHp += (f.passive.hpBoost || 34);
      }
      // --- UPDATE 20: Negatale "Love for humans" — +3 ATK/DEF vs killer-type chars
      if (f.passive?.type === 'loveForHumans' && hasPassiveUnlocked(f.level)) {
        const targets = f.passive.targetIds || ['killer_sans', 'female_killer_sans', 'murder_sans', 'judgement_hall_dust_sans'];
        if (targets.includes(this.enemy.id)) {
          f.atkMod += (f.passive.atkBoost || 3);
          f.defMod += (f.passive.defBoost || 3);
        }
      }
    }
    // --- UPDATE 30: Underfell/Outertale team overload (3+ of a family) ---
    const _ufCount = this.playerTeam.filter(f => f.id === 'underfell_sans').length;
    const _otCount = this.playerTeam.filter(f => f.id === 'outertale_sans').length;
    if (_ufCount >= 3) for (const f of this.playerTeam) { if (f.id === 'underfell_sans') { f.defMod -= 1; f._familyCdOverride = 3; } }
    if (_otCount >= 3) for (const f of this.playerTeam) { if (f.id === 'outertale_sans') { f.defMod -= 2; f._familyCdOverride = 3; } }
  }
  get activePlayer() { return this.playerTeam[this.activePlayerIndex]; }
  get alivePlayerCount() { return this.playerTeam.filter(f => f.isAlive).length; }

  // --- UPDATE 13 HELPERS ---
  // Apply Madness stack to Dustfell, scaling ATK/DEF every 2 stacks (cap 10)
  applyMadnessStack(player, amount = 1) {
    if (player.passive?.type !== 'sadisticPersistence') return;
    if (!hasPassiveUnlocked(player.level)) return;
    const before = player._madnessStacks || 0;
    const after = Math.min(before + amount, 10);
    player._madnessStacks = after;
    // Calc stat changes per 2 stacks
    const beforePairs = Math.floor(before / 2);
    const afterPairs = Math.floor(after / 2);
    const newPairs = afterPairs - beforePairs;
    if (newPairs > 0) {
      player.atkMod = (player.atkMod || 0) + 2 * newPairs;
      player.defMod = (player.defMod || 0) - 1 * newPairs;
    }
  }

  // Smoke Screen passive (Swapfell Papyrus): 50% chance per attack to apply Hazy stack, 1-turn cooldown
  applySmokeScreenPassive(player) {
    if (player.passive?.type !== 'smokeScreen') return;
    if (!hasPassiveUnlocked(player.level)) return;
    if (player._smokeScreenCooldown > 0) return;
    if (Math.random() < 0.5) {
      this.enemy._hazyStacks = Math.min((this.enemy._hazyStacks || 0) + 1, 5);
      player._smokeScreenCooldown = 1;
      // If reached cap, start 2-turn timer for clearing
      if (this.enemy._hazyStacks === 5 && !this.enemy._hazyCapTimer) this.enemy._hazyCapTimer = 2;
    }
  }

  // --- UPDATE 19 HELPERS ---

  // Reaper Sans: apply Death's Touch stack to target
  applyFearOfDeath(attacker, target) {
    if (attacker.passive?.type !== 'fearOfDeath') return null;
    if (!hasPassiveUnlocked(attacker.level)) return null;
    if (attacker._deathTouchCooldown > 0) return null;
    target._deathTouchStacks = Math.min((target._deathTouchStacks || 0) + 1, attacker.passive.maxStacks || 5);
    return target._deathTouchStacks;
  }

  // Reaper Sans: process Death's Touch HP drain at end of enemy turn
  processFearOfDeathTick(target, attacker) {
    if (!target._deathTouchStacks || target._deathTouchStacks <= 0) return null;
    const stacks = target._deathTouchStacks;
    const drain = Math.max(1, Math.floor(target.maxHp * 0.01 * stacks));
    target.currentHp = Math.max(0, target.currentHp - drain);
    return { stacks, drain };
  }

  // Reaper Sans: check if target is Marked (5 stacks)
  isMarkedForDeath(target) {
    return (target._deathTouchStacks || 0) >= 5;
  }

  // Green Sans aura farm: check if this is a buffed turn
  checkAuraFarm(player) {
    if (player.passive?.type !== 'auraFarm') return false;
    if (!hasPassiveUnlocked(player.level)) return false;
    return (player.turnCount % (player.passive.interval || 3)) === 0 && player.turnCount > 0;
  }

  // Seraphim Souls Help: trigger random soul effect at start of turn
  triggerSoulsHelp(player, logLines) {
    if (player.passive?.type !== 'soulsHelp') return;
    if (!hasPassiveUnlocked(player.level)) return;
    const souls = ['determination', 'kindness', 'justice', 'bravery', 'integrity', 'patience', 'perseverance'];
    const picked = souls[Math.floor(Math.random() * souls.length)];
    switch (picked) {
      case 'determination': {
        // All effects at 50% chance
        const r = Math.random();
        if (r < 0.143) { const h = player.heal(15); logLines.push(`✨ **Souls Help (Determination):** Kindness echo — healed **${h} HP**.`); }
        else if (r < 0.286) { player._justiceBoostThisTurn = true; logLines.push(`✨ **Souls Help (Determination):** Justice echo — bonus damage this turn.`); }
        else if (r < 0.429) { player._braveryBoostNext = 1.15; logLines.push(`✨ **Souls Help (Determination):** Bravery echo — +15% damage next turn.`); }
        else if (r < 0.572) { player._integrityDodge = 0.10; logLines.push(`✨ **Souls Help (Determination):** Integrity echo — 10% dodge chance this turn.`); }
        else if (r < 0.715) { this.enemy.addStatus('stun'); logLines.push(`✨ **Souls Help (Determination):** Patience echo — enemy stunned 1 turn!`); }
        else { this.enemy._perseveranceDmgReduce = 0.25; logLines.push(`✨ **Souls Help (Determination):** Perseverance echo — enemy's next attack deals 25% less damage.`); }
        break;
      }
      case 'kindness': { const h = player.heal(30); logLines.push(`💚 **Souls Help (Kindness):** Healed **${h} HP**.`); break; }
      case 'justice': { player._justiceBoostThisTurn = true; player._justicePierceChance = 0.50; logLines.push(`💛 **Souls Help (Justice):** Bonus damage this turn + 50% chance to pierce 30% DEF.`); break; }
      case 'bravery': { player._braveryBoostNext = 1.30; logLines.push(`🧡 **Souls Help (Bravery):** +30% damage next turn.`); break; }
      case 'integrity': { player._integrityDodge = 0.20; logLines.push(`💙 **Souls Help (Integrity):** 20% chance to dodge next hit this turn.`); break; }
      case 'patience': { this.enemy.addStatus('stun'); logLines.push(`💙 **Souls Help (Patience):** Enemy stunned for 1 turn!`); break; }
      case 'perseverance': { this.enemy._perseveranceDmgReduce = 0.50; logLines.push(`💜 **Souls Help (Perseverance):** Enemy's next attack deals 50% less damage.`); break; }
    }
  }

  // Roaring Knight boss: Strife by Strife — mark a random ability every N turns
  processStrifeByStrife(enemy, playerAbilities, turnNumber) {
    if (enemy.passive?.type !== 'strifeByStrife') return null;
    const interval = enemy.passive.interval || 3;
    if (turnNumber % interval !== 0 || turnNumber === 0) return null;
    // Pick a random ability index 0-3
    const idx = Math.floor(Math.random() * 4);
    enemy._markedAbilityIndex = idx;
    return idx;
  }

  // Roaring Knight character: Strife by Strife char — mark every N turns
  processRkCharPassive(player, turnCount) {
    if (player.passive?.type !== 'rkCharPassive') return null;
    const interval = player.passive.interval || 3;
    if (turnCount % interval !== 0 || turnCount === 0) return null;
    const idx = Math.floor(Math.random() * 4);
    player._rkMarkedIndex = idx;
    return idx;
  }

  // Star Shards: check recoil on move use
  checkStarShardsRecoil(target, logLines) {
    if (!target._starShardsStacks || target._starShardsStacks <= 0) return 0;
    let totalRecoil = 0;
    for (let i = 0; i < target._starShardsStacks; i++) {
      if (Math.random() < 0.50) {
        target.currentHp = Math.max(0, target.currentHp - 15);
        totalRecoil += 15;
      }
    }
    if (totalRecoil > 0) logLines.push(`🌟 **Star Shards** triggers — **${target.name}** takes **${totalRecoil}** recoil damage!`);
    return totalRecoil;
  }

  switchCharacter(index) {
    if (index < 0 || index >= this.playerTeam.length) return { success: false, message: 'Invalid team slot.' };
    if (index === this.activePlayerIndex) return { success: false, message: 'Already active!' };
    if (!this.playerTeam[index].isAlive) return { success: false, message: 'That character is defeated!' };
    // Universal Cut blocks switching
    if (this.enemy._universalCutTurns > 0) return { success: false, message: '⚔️ **Universal Cut** prevents switching!' };
    const old = this.activePlayer.name;
    // UPDATE 30: Toxin — Overstocked Shelves: heal + Lost'N'Found uses on switch-out
    const _oldActive = this.activePlayer;
    if (_oldActive.passive?.type === 'overstockedShelves' && hasPassiveUnlocked(_oldActive.level)) {
      _oldActive.heal(_oldActive.passive.healOnSwitch || 15);
      const _lnf = _oldActive.abilities.find(a => a.special?.type === 'lostNFound');
      if (_lnf) _lnf.currentUses = Math.min(_lnf.maxUses, _lnf.currentUses + (_oldActive.passive.lostNFoundRestore || 2));
    }
    // --- UPDATE 31: Goop is removed when the Melting one switches out ---
    if (_oldActive.passive?.type === 'itHurtsPap' || _oldActive.passive?.type === 'itHurts') {
      _oldActive._clearGoopFrom(this.enemy, _oldActive.id);
    }
    this.activePlayer.skipNextTurn = false; // don't carry skip to next char
    // Reset INSANITY stacks (passive: Losing His Mind) when player switches off Final Insanity
    if (this.activePlayer.passive?.type === 'losingHisMind') {
      this.enemy._insanityStacks = 0;
      this.enemy._insanityDebuffApplied = 0;
      this.enemy._insanityMoveFail = 0;
      this.enemy._insanityStunQueued = false;
    }
    this.activePlayerIndex = index;
    return { success: true, message: `Switched from **${old}** to **${this.activePlayer.name}**!` };
  }
  calculateDamage(attacker, ability, defender) {
    const dmg = Math.floor(Math.random() * (ability.damageMax - ability.damageMin + 1)) + ability.damageMin;
    const typeMult = getTypeMultiplier(ability.type, defender.type);
    defender._incomingTypeMult = typeMult; // UPDATE 32: read by Doki Meter in takeDamage
    defender._incomingAbilityType = ability.type; // SCAMTON EVENT: read by Patience Parry in takeDamage
    let critChance = COMBAT.CRIT_CHANCE + (attacker.critBoost || 0);
    if (attacker.passive?.type === 'doubleCrit' && hasPassiveUnlocked(attacker.level)) critChance *= 2;
    if (attacker._aggravationActive) critChance *= 2;
    // --- UPDATE 15: Kris insert — bonus crit on Melee from Unique stacks ---
    if (attacker.passive?.type === 'krisInsert' && hasPassiveUnlocked(attacker.level) && ability.type === 'Melee' && (attacker._krisCritStacks || 0) > 0) {
      critChance += (attacker._krisCritStacks || 0) * (attacker.passive.critPerStack || 0.10);
      attacker._krisCritUsedThisAttack = true;
    }
    // --- UPDATE 13: Glitchy Save (Omega Flowey) — DEF -2 on save turn if attacked
    let savedDefReduction = 0;
    if (defender.passive?.type === 'glitchySave' && defender._floweySaveTurnNext) {
      savedDefReduction = 2;
      defender.defMod -= savedDefReduction;
    }
    // Rosy Pink Tint (a forced grin.) — 1/5 chance guaranteed hit + 15% crit boost
    if (attacker.passive?.type === 'rosyPinkTint' && hasPassiveUnlocked(attacker.level) && Math.random() < attacker.passive.chance) {
      attacker._rosyPinkActive = true;
      critChance += 0.15;
    }
    // --- UPDATE 17 BUG FIX: Heavy Rain — enemy cannot crit while Heavy Rain active
    if (attacker._noCritThisTurn) critChance = 0;
    const isCrit = Math.random() < critChance;
    const critMult = isCrit ? COMBAT.CRIT_MULTIPLIER : 1;
    let total = ((dmg * (attacker.atk * typeMult)) / defender.def) * critMult;
    // Black Soul passive: 1.2x if enemy has any status
    if (attacker.passive?.type === 'blackSoul' && hasPassiveUnlocked(attacker.level) && defender.statusEffects && defender.statusEffects.length > 0) {
      total *= attacker.passive.multiplier || 1.2;
    }
    // Orange Logic (Underswap Papyrus passive)
    if (attacker.passive?.type === 'orangeLogic' && hasPassiveUnlocked(attacker.level) && defender.hasStatus('Orange Soul')) total *= 1.1;
    // UPDATE 30: Papyrus Belief — Bone moves deal 1.3x vs Blue Soul
    if (attacker.passive?.type === 'shatteredExpectations' && hasPassiveUnlocked(attacker.level) && ability.type === 'Bone' && defender.hasStatus('Blue Soul')) total *= (attacker.passive.blueSoulBoneMult || 1.3);
    // Aura Manipulation (Ainavol): 1/5 chance 50% more damage
    if (attacker.passive?.type === 'auraManipulation' && hasPassiveUnlocked(attacker.level) && Math.random() < attacker.passive.chance) {
      total *= attacker.passive.multiplier || 1.5;
    }
    // Gaster's Help Assist: +10 flat damage
    if (attacker._gastersHelpAssist > 0) { total += attacker._gastersHelpAssist; attacker._gastersHelpAssist = 0; }
    // Will to Avenge (Weak Avenge Sans) — Spite stacks: +1 ATK per stack on Melee, all consumed
    if (attacker.passive?.type === 'willToAvenge' && hasPassiveUnlocked(attacker.level) && ability.type === 'Melee' && (attacker._spiteStacks || 0) > 0) {
      const bonus = attacker._spiteStacks * 1;
      total += bonus * typeMult;
      attacker._spiteStacks = 0;
    }
    // Omniversal Prodigy (Avenge Sans) — Magic damage boost from previous Melee/Weapon hits
    if (attacker.passive?.type === 'omniversalProdigy' && hasPassiveUnlocked(attacker.level) && ability.type === 'Magic' && (attacker._magicDmgBoost || 0) > 0) {
      total *= (1 + attacker._magicDmgBoost);
    }
    // Weak Omniversal Cleave next-Magic-move boost (consumed)
    if (attacker._magicBoostNext && ability.type === 'Magic') {
      total *= attacker._magicBoostNext;
      attacker._magicBoostNext = 0;
    }
    // --- UPDATE 17: AfterDust Dusty Determination damage boost
    if (attacker._dustyDetBoost && attacker._dustyDetBoostTurns > 0) {
      total *= attacker._dustyDetBoost;
    }
    // Faded Blaster reduction (set on enemy by C!Insanity Weak's Faded Blaster — enemy's next attack hits weaker)
    if (attacker._fadedBlasterReduction) {
      total *= (1 - attacker._fadedBlasterReduction);
      attacker._fadedBlasterReduction = 0;
    }
    // Bravery boost (Agem Soul Trait)
    if (attacker._damageBoostNext) { total *= attacker._damageBoostNext; attacker._damageBoostNext = 0; }
    // --- UPDATE 13 ---
    // Sirius (Outerdust): 20% chance for 1.5x dmg + burn on attack
    if (attacker.passive?.type === 'sirius' && hasPassiveUnlocked(attacker.level) && Math.random() < (attacker.passive.chance || 0.2)) {
      total *= (attacker.passive.multiplier || 1.5);
      attacker._siriusBurnFlag = true;
    }
    // Ruthless Judgement (Storyfell Chara): 1.2x if enemy has any status
    if (attacker.passive?.type === 'ruthlessJudgement' && hasPassiveUnlocked(attacker.level) && defender.statusEffects && defender.statusEffects.length > 0) {
      total *= (attacker.passive.multiplier || 1.2);
    }
    // Oceantale Papyrus — Bone Anchor rider: Melee moves deal 1.2x vs a target Blue-Soul'd by Bone Anchor
    if (ability.type === 'Melee' && defender._oceanMeleeVuln && defender.statusEffects?.some(s => s.name === 'Blue Soul')) {
      total *= 1.2;
    }
    // Psychopathtale — Schizo: 25% chance to deal 10% more vs a Schizo'd target
    if (defender.statusEffects?.some(s => s.name === 'Schizo') && Math.random() < 0.25) {
      total *= 1.10;
    }
    // Reaper Chara — Divine Hatred: below 50% HP, ignore 20% of enemy DEF (applied as bonus true damage)
    if (attacker.passive?.type === 'divineHatred' && hasPassiveUnlocked(attacker.level) && (attacker.currentHp / attacker.maxHp) < (attacker.passive.hpThreshold || 0.5)) {
      total += Math.floor((defender.def || 0) * (attacker.passive.defIgnore || 0.20));
    }
    // Core Overload (Core Dust): 1.5x next attack after 3 charges
    if (attacker._coreOverloadSurge) {
      total *= 1.5;
      attacker._coreOverloadSurge = false;
      attacker._coreOverloadCooldown = 1; // DEF=10 next turn
    }
    // --- UPDATE 15 PASSIVES ---
    // DRIVING IN MY CAR (Asgore Dreemurr) — 2x damage to children
    if (attacker.passive?.type === 'drivingInMyCar' && hasPassiveUnlocked(attacker.level) && defender.isChild) {
      total *= (attacker.passive.childMult || 2);
    }
    // No More Deals (NMD Chara) — vs Killer Sans, +2/+3/+34 (handled in baseStats), but no dmg multiplier here
    // Susie I'll take the lead — 15% chance to ignore 10% DEF
    if (attacker.passive?.type === 'illTakeTheLead' && hasPassiveUnlocked(attacker.level) && Math.random() < (attacker.passive.defIgnoreChance || 0.15)) {
      total *= (1 + (attacker.passive.defIgnorePercent || 0.10));
      attacker._susieDefIgnored = true;
    }
    // Kris insert — Unique grants stack, next Melee uses bonus crit (handled in critChance via _krisCritStacks)
    // Sleep status — defender takes +2 flat damage
    if (defender.statusEffects && defender.statusEffects.find(s => s.name === 'Sleep')) {
      total += 2;
    }
    // Showtime! (Mettaton NEO): ATK/DEF +1 per damage dealt (handled separately, but reflected in atk via atkMod)
    // Phantom Brother triggers in endTurn
    // Bodyguards (Mafiatale): first 3 turns 15% reduction shield (defender side, handled in takeDamage area)
    // --- UPDATE 19: Green Sans Aura Farm multiplier ---
    if (attacker._auraFarmApplyThisTurn) {
      total *= (attacker.passive?.multiplier || 1.5);
      attacker._auraFarmApplyThisTurn = false;
      attacker._auraFarmActive = false;
    }
    // --- UPDATE 19: Reaper Sans Marked 1.5x (handled in grandHarvest directly) ---
    // --- UPDATE 19: Seraphim Souls Help — Justice boost ---
    if (attacker._justiceBoostThisTurn) {
      total *= 1.2;
      if (attacker._justicePierceChance && Math.random() < attacker._justicePierceChance) {
        total += Math.floor(defender.def * 0.30);
      }
      attacker._justiceBoostThisTurn = false; attacker._justicePierceChance = 0;
    }
    // --- UPDATE 19: Seraphim Souls Help — Bravery boost (applied next turn) ---
    if (attacker._braveryBoostNext) {
      total *= attacker._braveryBoostNext;
      attacker._braveryBoostNext = 0;
    }
    // --- UPDATE 19: Perseverance reduce on defender (Seraphim Souls Help) ---
    if (defender._perseveranceDmgReduce && defender._perseveranceDmgReduce > 0) {
      total *= (1 - defender._perseveranceDmgReduce);
      defender._perseveranceDmgReduce = 0;
    }
    // --- UPDATE 20: FFTBO stackable damage boost ---
    if (attacker._fftboDmgBoost && attacker._fftboDmgBoost > 0) {
      total += attacker._fftboDmgBoost;
    }
    total = Math.max(COMBAT.MIN_DAMAGE, Math.floor(total));
    // Restore Flowey def if Glitchy Save piercing was applied
    if (savedDefReduction > 0) defender.defMod += savedDefReduction;
    return { baseDmg: dmg, typeMult, isCrit, critMult, totalDamage: total };
  }

  _applyCrystallize(target, dmg, duration) {
    const add = Math.max(1, Math.floor(dmg * 0.4));
    const existing = target.statusEffects.find(s => s.name === 'Crystallize');
    if (existing) { existing.damagePerTurn += add; existing.turnsLeft = Math.max(existing.turnsLeft, duration); }
    else { target.statusEffects.push({ name: 'Crystallize', emoji: '💎', damagePerTurn: add, turnsLeft: duration }); }
  }
  executePlayerAbility(abilityIndex, targetIndex = null) {
    const player = this.activePlayer;
    // --- SCAMTON EVENT: a target chosen through the ally picker arrives on the battle ---
    if (targetIndex === null || targetIndex === undefined) {
      if (this._ppTargetIndex !== null && this._ppTargetIndex !== undefined) { targetIndex = this._ppTargetIndex; this._ppTargetIndex = null; }
    }
    const ability = player.abilities[abilityIndex];
    const R = { playerAction: null, enemyAction: null, statusTick: [], enemyStatusTick: [], battleEnd: null };
    player._tailRestoreSpecial(); // Jevil's Tail: undo last turn's doubling before anything reads special
    if (!ability || ability.currentUses <= 0) { R.playerAction = { success: false, message: 'No uses left!' }; return R; }
    if (ability.cooldownLeft > 0) { R.playerAction = { success: false, message: `**${ability.name}** is on cooldown! (${ability.cooldownLeft} turns)` }; return R; }
    // --- SCAMTON EVENT: Power Points cost gate ---
    if (ability.special?.ppCost) {
      const _cur = player._pp || 0;
      if (_cur < ability.special.ppCost) { R.playerAction = { success: false, message: `⚡ **${ability.name}** requires **${ability.special.ppCost} PP** — you have **${_cur}**!` }; return R; }
    }
    // --- UPDATE 18: Final Chamber reload lockout
    if (player._reloading && ability.special?.type !== 'coffeeChug') { R.playerAction = { success: false, message: `🔫 **${player.name}** is **Reloading**! Only **Coffee Chug** is available!` }; return R; }
    // Star Rain — once only per battle
    if (ability.special?.type === 'starRain' && player._starRainUsed) {
      R.playerAction = { success: false, message: `**${ability.name}** can only be used **ONCE per battle!**` };
      return R;
    }
    // Track defensive moves (for Bad Time Sans Bone Hell)
    const _defTypes = ['parry', 'taunt', 'savePointAnchor', 'heal', 'rkShield', 'sorrowTears', 'perfectSave'];
    player._lastUsedDefensive = (ability.damageMax === 0) || _defTypes.includes(ability.special?.type);
    // BLOCKED disables Bone Swing
    if (player._blockedActive > 0 && ability.special?.type === 'boneSwing') { R.playerAction = { success: false, message: '**Bone Swing** is disabled while BLOCKED is active!' }; return R; }
    if (player.skipNextTurn) {
      player.skipNextTurn = false;
      player._jevilSkipped = true;
      // Purify strife mark — player couldn't choose, so don't punish
      if (this.enemy.passive?.type === 'strifeByStrife' && this.enemy._markedAbilityIndex !== null) {
        this.enemy._markedAbilityIndex = null;
      }
      R.playerAction = { success: true, message: `**${player.name}** is recovering and can't attack!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // --- UPDATE 20 BUG FIX: Domain Expansion self-stun backfire ---
    if (player._domainSelfStunBackfire > 0) {
      player._domainSelfStunBackfire--;
      this.turnNumber++; player.turnCount++;
      R.playerAction = { success: true, message: `🌌 **${player.name}** is stunned by the Domain's backfire and can't attack! (${player._domainSelfStunBackfire} turns left)`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // --- JEVIL: CHAOS BOX multi-turn stun ---
    if ((player._chaosStunTurns || 0) > 0) {
      player._chaosStunTurns--;
      this.turnNumber++; player.turnCount++;
      player._jevilSkipped = true;
      R.playerAction = { success: true, message: `💫 **${player.name}** is scattered by **CHAOS BOX** and can't act! (${player._chaosStunTurns} turns left)`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // Check incapacitating statuses
    const incapacitated = player.statusEffects.find(s => s.name === 'Stun' || s.name === 'Flinch' || s.name === 'Frozen');
    if (incapacitated) {
      player._jevilSkipped = true;
      const state = incapacitated.name === 'Stun' ? 'stunned' : (incapacitated.name === 'Flinch' ? 'flinched' : 'frozen');
      // Consume the status immediately (Frozen ticks normally and isn't consumed instantly)
      if (incapacitated.name !== 'Frozen') {
        player.statusEffects = player.statusEffects.filter(s => s !== incapacitated);
      }
      // Purify strife mark — player was incapacitated, not a choice
      if (this.enemy.passive?.type === 'strifeByStrife' && this.enemy._markedAbilityIndex !== null) {
        this.enemy._markedAbilityIndex = null;
      }
      this.turnNumber++; player.turnCount++;
      R.playerAction = { success: true, message: `**${player.name}** is ${state} and can't attack!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // --- JEVIL: THE WORLD REVOLVING dodge (Diamond Waves) — Jevil can spin away from an attack ---
    if (ability.damageMax > 0 && (this.enemy._jevilDodge || 0) > 0 && this.enemy.isAlive && Math.random() < this.enemy._jevilDodge) {
      ability.currentUses--; this.turnNumber++; player.turnCount++;
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}**... but **${this.enemy.name}** spins away! *UEE HEE HEE!* (dodged)`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // --- UPDATE 22: Regret — 25% chance to not attack, -1 ATK each time it procs ---
    if (player.hasStatus('Regret') && Math.random() < 0.25) {
      player.atkMod -= 1;
      this.turnNumber++; player.turnCount++;
      R.playerAction = { success: true, message: `😔 **${player.name}** is consumed by **Regret** and doesn't attack! **-1 ATK!**`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    ability.currentUses--; this.turnNumber++; player.turnCount++;
    player._tailDoubleSpecial(ability); // Jevil's Tail: double this attack's effect-proc chances
    // --- UPDATE 20 BUG FIX: Skip cooldown application on the CHARGE turn — only apply cooldown on the RELEASE turn ---
    // (Flame Eye ROAR, C!Insanity CHUNG, etc. were locked out by their own cooldowns mid-charge)
    const _isChargeStarting = ['flameEyeRoar', 'chungBlast', 'weakenedChung', 'finalChung', 'charge', 'comicallyLargeBlunt', 'rebarImpale', 'rebarRetrieve', 'papQBlueSoul', 'sixHelpUs', 'sixNoEffect', 'lastBreathStrike'].includes(ability.special?.type) && !player.isCharging && !player._flameEyeRoarCharging && !player._chungCharging && !player.isReleasing;
    if (ability.special?.cooldown && !_isChargeStarting) ability.cooldownLeft = (player._familyCdOverride || ability.special.cooldown) + 1;
    player._usedAbilityThisTurn = true; player._attackedThisTurn = ability.damageMax > 0;
    // --- UPDATE 30: Papyrus Belief — Shattered Expectations bone/magic alternation ---
    if (player.passive?.type === 'shatteredExpectations' && hasPassiveUnlocked(player.level) && (ability.type === 'Bone' || ability.type === 'Magic')) {
      const prevType = player._beliefLastType;
      if (prevType && prevType !== ability.type) {
        if (Math.random() < (player.passive.overwhelmChance || 0.10)) {
          const active = this.enemy.statusEffects.filter(st => st.turnsLeft > 0);
          if (active.length) { active[Math.floor(Math.random()*active.length)].turnsLeft += 1; }
          this.enemy.skipNextTurn = true;
          if (!R.update30Procs) R.update30Procs = [];
          R.update30Procs.push('Shattered Expectations: OVERWHELM! Status extended + Papyrus gets an extra turn!');
        }
      }
      player._beliefLastType = ability.type;
    }
    player._lastUsedAbility = ability;
    // --- UPDATE 19: Set Aura Farm active BEFORE ability executes (correct turn timing) ---
    if (player.passive?.type === 'auraFarm' && hasPassiveUnlocked(player.level)) {
      player._auraFarmActive = this.checkAuraFarm(player);
    }
    // --- UPDATE 19: Seraphim Souls Help — trigger at START of turn, effects apply this turn ---
    if (player.passive?.type === 'soulsHelp' && hasPassiveUnlocked(player.level)) {
      if (!R.soulsHelpLog) R.soulsHelpLog = [];
      this.triggerSoulsHelp(player, R.soulsHelpLog);
    }
    // --- UPDATE 19: Reset Death Blaster back-to-back flag ---
    if (ability.special?.type !== 'deathBlaster') player._deathBlasterUsedLastTurn = false;
    // --- UPDATE 19: Tick RK char marked buff (expires after 1 turn) ---
    if (player._rkMarkedBuff > 0) {
      player._rkMarkedBuff--;
      if (player._rkMarkedBuff <= 0) { player.atkMod -= 2; player.defMod -= 2; }
    }
    // --- UPDATE 19: Check if player used a MARKED move (Strife by Strife boss passive) ---
    if (this.enemy.passive?.type === 'strifeByStrife' && this.enemy._markedAbilityIndex === abilityIndex) {
      this.enemy._markedAbilityIndex = null;
      // Heal boss for what would have been damage
      const fakeD = this.calculateDamage(player, ability, this.enemy);
      this.enemy.heal(fakeD.totalDamage);
      // SWOON the active player (instant kill)
      player.currentHp = 0;
      R.playerAction = { success: true, message: `**${player.name}** used the **MARKED** move **${ability.name}**... ☠️ **SWOON!** The Roaring Knight negated the damage and healed **${fakeD.totalDamage} HP**! **${player.name}** is instantly downed!`, damage: 0 };
      R.battleEnd = this.checkBattleEnd();
      return R;
    }
    // --- UPDATE 19: Purify marked move if player didn't use it (handled in endTurn, but track here) ---
    if (this.enemy.passive?.type === 'strifeByStrife' && this.enemy._markedAbilityIndex !== null && this.enemy._markedAbilityIndex !== abilityIndex) {
      this.enemy._markedAbilityIndex = null; // purified
      if (!R.strifePurified) R.strifePurified = `✅ **Strife purified!** The marked move is back to normal.`;
    }
    // --- UPDATE 19: Green Sans Aura Farm — apply multiplier to all damage this turn ---
    if (player._auraFarmActive && ability.damageMax > 0) {
      player._auraFarmApplyThisTurn = true;
    }
    // --- UPDATE 19: Star Shards recoil when player uses a move ---
    if (player._starShardsStacks > 0 && ability.damageMax > 0) {
      const recoilLog = [];
      const recoilTotal = this.checkStarShardsRecoil(player, recoilLog);
      if (recoilTotal > 0) {
        if (!R.starShardsRecoil) R.starShardsRecoil = recoilLog.join('\n');
        if (!player.isAlive) { R.battleEnd = this.checkBattleEnd(); if (R.battleEnd) return R; }
      }
    }
    // Silence: block Unique moves
    if (player.hasStatus('Silence') && ability.type === 'Unique') {
      ability.currentUses++;
      R.playerAction = { success: false, message: `**${player.name}** is **Silenced** and cannot use Unique moves!` }; return R;
    }
    // Bravery trap: enemy used non-attacking move — take 25 damage
    if (!player._attackedThisTurn && this.enemy._braveryTrap) {
      this.enemy._braveryTrap = false;
      player.currentHp = Math.max(0, player.currentHp - 25);
      R.braveryTrap = `🟠 **Bravery Trap** triggered! **${player.name}** takes **25 damage** for using a non-attacking move!`;
    }

    if (player._attackedThisTurn) {
      const miss = player.consumeAttackMiss();
      if (miss) {
        const missMsg = miss.source === 'blindness' ? '**Blindness** caused the attack to miss!' : 'the attack missed!';
        R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**... but ${missMsg}`, damage: 0 };
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
    }

    // TELEPORT
    if (ability.special?.type === 'teleport') {
      player.dodgeNextAttack = true; player.critBoost = ability.special.critBoost;
      R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! Will dodge and gain crit boost!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // HEAL
    if (ability.special?.type === 'heal') {
      if (player.hasStatus('Glitched')) {
        const result = player.takeDamage(ability.special.amount);
        R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**... but **Glitched** turned the heal into **${ability.special.amount}** self-damage!${result.lastStand ? `\n**Last Stand!** ${player.name} survives at 1 HP!` : ''}`, damage: 0 };
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
      const h = player.heal(ability.special.amount * (this.enemy.passive?.type === 'weightOfGuilt' && hasPassiveUnlocked(this.enemy.level || 5) ? 0.5 : 1));
      const weightMsg = (this.enemy.passive?.type === 'weightOfGuilt' && hasPassiveUnlocked(this.enemy.level || 5)) ? ' *(Weight of Guilt: 50%!)*' : '';
      R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! Recovered **${h} HP**!${weightMsg} (${player.currentHp}/${player.maxHp})`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // BONE FIELD
    if (ability.special?.type === 'boneField') {
      const sr = this.enemy.addStatus('boneField');
      if (sr) Object.assign(this.enemy.statusEffects.find(s => s.name === sr.name), { damageMin: ability.special.damageMin, damageMax: ability.special.damageMax });
      R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! Enemy will take **${ability.special.damageMin}-${ability.special.damageMax}** damage when using abilities for ${ability.special.duration} turns!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // CHARGE
    if (ability.special?.type === 'charge' && !player.isReleasing) {
      if (!player.isCharging) {
        player.isCharging = true; player.chargedAbility = abilityIndex;
        if (ability.special.selfDebuff) { player.atkMod += (ability.special.selfDebuff.atk || 0); player.defMod += (ability.special.selfDebuff.def || 0); }
        R.playerAction = { success: true, message: `**${player.name}** ${ability.special.chargeMessage}`, damage: 0, charging: true };
        ability.currentUses++;
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
    }
    // DEBUFF
    if (ability.special?.type === 'debuff') {
      const t = ability.special.target === 'enemy' ? this.enemy : player;
      if (ability.special.stat === 'atk') t.atkMod += ability.special.amount;
      if (ability.special.stat === 'def') t.defMod += ability.special.amount;
      R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! ${t.name}'s ${ability.special.stat.toUpperCase()} ${ability.special.amount}!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // GRAVITY MANIP — FIX: properly show both debuffs
    if (ability.special?.type === 'gravityManip') {
      player.defMod += ability.special.selfDef; this.enemy.defMod += ability.special.enemyDef;
      let d = null;
      if (ability.damageMax > 0) { d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); }
      R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! ${player.name} DEF ${ability.special.selfDef}, ${this.enemy.name} DEF ${ability.special.enemyDef}.${d ? ` Dealt **${d.totalDamage}** damage!` : ''}`, damage: d?.totalDamage || 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // RISKY — FIX: actually use missChance correctly
    if (ability.special?.type === 'risky') {
      const roll = Math.random();
      if (roll < ability.special.missChance) {
        R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**... but it **missed**! (${Math.round(ability.special.missChance * 100)}% miss rate)`, damage: 0 };
      } else {
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
        let statusMsg = '';
        if (ability.special.statusOnHit) { const sr = this.enemy.addStatus(ability.special.statusOnHit); if (sr) statusMsg = ` **${sr.name}** applied!`; }
        R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! **HIT!** **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${statusMsg}`, damage: d.totalDamage };
      }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // GOOP BLASTER
    if (ability.special?.type === 'goopBlaster') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      this.enemy.defMod += ability.special.enemyDef; this.enemy.atkMod += ability.special.enemyAtk;
      player.skipNextTurn = true;
      R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! **${d.totalDamage}** damage! Enemy DEF ${ability.special.enemyDef}, ATK ${ability.special.enemyAtk}. Can't attack next turn!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // DOUBLE HIT
    if (ability.special?.type === 'doubleHit') {
      if (this.enemy.passive?.type === 'starDust') {
        // UPDATE 19 NERF: StarDust blocks extra hits but player still deals 1 hit
        { const d = this.calculateDamage(player, ability, this.enemy); const dr = this.enemy.takeDamage(d.totalDamage);
          this.applyFearOfDeath(player, this.enemy);
          R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! ✨ **StarDust** blocks the extra hits — **${d.totalDamage}** damage (1 hit only)${d.isCrit ? ' (CRIT)' : ''}!`, damage: d.totalDamage }; }
        if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
      let total = 0, msg = `**${player.name}** used **${ability.name}**!`, poisoned = false, bled = false;
      for (let i = 0; i < 2; i++) {
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
        msg += ` Hit ${i+1}: **${d.totalDamage}**${d.isCrit ? ' (CRIT)' : ''}!`;
        if (!poisoned && ability.special.poisonChance && Math.random() < ability.special.poisonChance) { this.enemy.addStatus('poison'); msg += ' **Poisoned!**'; poisoned = true; }
        if (!bled && ability.special.bleedChance && Math.random() < ability.special.bleedChance) { this.enemy.addStatus('bleed'); msg += ' **Bleed!**'; bled = true; }
      }
      // Party Lights passive — bleedChance/poisonChance moves count as explosion for stun
      if (player.passive?.type === 'partyLights' && hasPassiveUnlocked(player.level) && Math.random() < player.passive.stunChance) {
        this.enemy.addStatus('stun'); msg += ' **Party Lights: Stunned!**';
      }
      R.playerAction = { success: true, message: msg, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // PARRY — FIX: parry only lasts for THIS enemy turn, then resets
    // =====================================================================
    // SCAMTON EVENT — THE REWRITTEN (Asriel / Noelle / Charkis)
    // =====================================================================
    // LIGHT IGNITION (Asriel) — 10 PP, become Fire/Melee, arm a one-time Burn
    if (ability.special?.type === 'lightIgnition') {
      const sp = ability.special;
      player.spendPP(sp.ppCost);
      player.type = 'Fire/Melee';
      player._lightIgnitionBurn = sp.burnDuration || 3;
      R.playerAction = { success: true, abilityType: ability.type, message: `🔥 **${player.name}** used **${ability.name}**! They are now **Fire/Melee** for the rest of the battle, and **Saber Slash** will inflict **Burn** for ${player._lightIgnitionBurn} turns once. *(PP: ${player._pp}/${player.maxPP})*`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // DICE TIME (Asriel) — 30 PP, roll 1-6
    if (ability.special?.type === 'diceTime') {
      const sp = ability.special;
      player.spendPP(sp.ppCost);
      const roll = Math.floor(Math.random() * 6) + 1;
      let msg = '';
      if (roll === 1) { const r = player.takeDamage(10); msg = `**1** — takes **10** self damage!${r.lastStand ? ' **Last Stand!**' : ''}`; }
      else if (roll === 2) { msg = '**2** — nothing happens.'; }
      else if (roll === 3) { player.statusEffects = []; msg = '**3** — all current effects **cleansed**!'; }
      else if (roll === 4) { const h = player.heal(25); msg = `**4** — recovered **${h} HP**! (${player.currentHp}/${player.maxHp})`; }
      else if (roll === 5) { player.atkMod += 2; player.defMod += 2; if (!player._tempDebuffs) player._tempDebuffs = []; player._tempDebuffs.push({ stat: 'atk', amount: 2, turnsLeft: 3, source: 'Dice Time' }); player._tempDebuffs.push({ stat: 'def', amount: 2, turnsLeft: 3, source: 'Dice Time' }); msg = '**5** — **+2 ATK** and **+2 DEF** for 3 turns!'; }
      else { const halve = Math.floor(this.enemy.def / 2); this.enemy.defMod -= halve; msg = `**6** — **${this.enemy.name}'s DEF is halved!** (-${halve} DEF)`; }
      R.playerAction = { success: true, abilityType: ability.type, message: `🎲 **${player.name}** used **${ability.name}**! ${msg} *(PP: ${player._pp}/${player.maxPP})*`, damage: 0 };
      if (!player.isAlive) { const be = this.checkBattleEnd(); if (be) { R.battleEnd = be; return R; } }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // PATIENCE PARRY (Asriel) — guard: 80% off Magic/Unique, 50% of it becomes PP
    if (ability.special?.type === 'patienceParry') {
      const sp = ability.special;
      player._rewrittenGuard = { pct: sp.blockPercent, types: ['Magic', 'Unique'], ppConvert: sp.ppConvert, label: ability.name };
      player._rewrittenGuardAbsorbed = 0; player._rewrittenGuardPPGain = 0;
      R.playerAction = { success: true, abilityType: ability.type, message: `🛡️ **${player.name}** used **${ability.name}**! Braced against **Magic** and **Unique** attacks.`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn();
      if (player._rewrittenGuardAbsorbed > 0) R.playerAction.message += ` *(Tanked **${player._rewrittenGuardAbsorbed}** damage, **+${player._rewrittenGuardPPGain} PP** → ${player._pp}/${player.maxPP})*`;
      player._rewrittenGuard = null; player._rewrittenGuardAbsorbed = 0; player._rewrittenGuardPPGain = 0;
      this.endTurn(R, player); return R;
    }
    // ICESHOCK (Noelle) — 30 PP, flat 50, guaranteed crit
    if (ability.special?.type === 'noelleIceShock') {
      const sp = ability.special;
      player.spendPP(sp.ppCost);
      player.critBoost += 1; // guarantees the crit roll
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      player.critBoost = 0;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `❄️ **${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage! **CRIT!** *(PP: ${player._pp}/${player.maxPP})*`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // HEAL HAIL (Noelle) — 50 PP, heal the whole party
    if (ability.special?.type === 'healHail') {
      const sp = ability.special;
      player.spendPP(sp.ppCost);
      const healed = [];
      for (const f of this.playerTeam) {
        if (!f.isAlive) continue;
        const h = f.heal(sp.healAmount || 20);
        if (h > 0) healed.push(`**${f.name}** +${h}`);
      }
      R.playerAction = { success: true, abilityType: ability.type, message: `🌨️ **${player.name}** used **${ability.name}**! ${healed.length ? healed.join(', ') : 'Nobody needed healing'}. *(PP: ${player._pp}/${player.maxPP})*`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // GLACIER DEFENSE (Noelle) — guard: 50% off everything, +20 PP
    if (ability.special?.type === 'glacierDefense') {
      const sp = ability.special;
      const gained = player.gainPP(sp.ppGain || 20);
      player._rewrittenGuard = { pct: sp.blockPercent, types: null, ppConvert: 0, label: ability.name };
      player._rewrittenGuardAbsorbed = 0;
      R.playerAction = { success: true, abilityType: ability.type, message: `🧊 **${player.name}** used **${ability.name}**! Bracing for **50%** less damage. **+${gained} PP** *(${player._pp}/${player.maxPP})*`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn();
      if (player._rewrittenGuardAbsorbed > 0) R.playerAction.message += ` *(Tanked **${player._rewrittenGuardAbsorbed}** damage)*`;
      player._rewrittenGuard = null; player._rewrittenGuardAbsorbed = 0;
      this.endTurn(R, player); return R;
    }
    // MOTIVATE UP (Charkis) — 20 PP, +2 ATK / +2 DEF to a chosen party member for 5 turns
    if (ability.special?.type === 'motivateUp') {
      const sp = ability.special;
      player.spendPP(sp.ppCost);
      const tgt = (targetIndex !== null && targetIndex !== undefined && this.playerTeam[targetIndex]) ? this.playerTeam[targetIndex] : player;
      tgt.atkMod += sp.atk; tgt.defMod += sp.def;
      if (!tgt._tempDebuffs) tgt._tempDebuffs = [];
      tgt._tempDebuffs.push({ stat: 'atk', amount: sp.atk, turnsLeft: sp.turns, source: 'Motivate Up' });
      tgt._tempDebuffs.push({ stat: 'def', amount: sp.def, turnsLeft: sp.turns, source: 'Motivate Up' });
      R.playerAction = { success: true, abilityType: ability.type, message: `📣 **${player.name}** used **${ability.name}** on **${tgt.name}**! **+${sp.atk} ATK** and **+${sp.def} DEF** for ${sp.turns} turns. *(PP: ${player._pp}/${player.maxPP})*`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // IMMUNITY SHIELD (Charkis) — 35 PP, chosen ally tanks one hit fully + full cleanse
    if (ability.special?.type === 'immunityShield') {
      const sp = ability.special;
      player.spendPP(sp.ppCost);
      const tgt = (targetIndex !== null && targetIndex !== undefined && this.playerTeam[targetIndex]) ? this.playerTeam[targetIndex] : player;
      tgt._immunityShield = true;
      tgt.statusEffects = [];
      R.playerAction = { success: true, abilityType: ability.type, message: `✨ **${player.name}** used **${ability.name}** on **${tgt.name}**! They will **fully tank the next hit** and were **cleansed** of all debuffs and effects. *(PP: ${player._pp}/${player.maxPP})*`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // HAT STANCE (Charkis) — guard: 50% off everything, +15 PP, self cleanse
    if (ability.special?.type === 'hatStance') {
      const sp = ability.special;
      const gained = player.gainPP(sp.ppGain || 15);
      player.statusEffects = [];
      player._rewrittenGuard = { pct: sp.blockPercent, types: null, ppConvert: 0, label: ability.name };
      player._rewrittenGuardAbsorbed = 0;
      R.playerAction = { success: true, abilityType: ability.type, message: `🎩 **${player.name}** used **${ability.name}**! All effects **cleansed**, bracing for **50%** less damage. **+${gained} PP** *(${player._pp}/${player.maxPP})*`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn();
      if (player._rewrittenGuardAbsorbed > 0) R.playerAction.message += ` *(Tanked **${player._rewrittenGuardAbsorbed}** damage)*`;
      player._rewrittenGuard = null; player._rewrittenGuardAbsorbed = 0;
      this.endTurn(R, player); return R;
    }
    if (ability.special?.type === 'parry') {
      player.parrying = true;
      R.playerAction = { success: true, message: `**${player.name}** enters a **parry stance**!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn();
      player.parrying = false;
      this.endTurn(R, player); return R;
    }
    // TAUNT
    if (ability.special?.type === 'taunt') {
      player.defMod += ability.special.selfDef; this.enemy.atkMod += ability.special.enemyAtk; this.enemy.taunted = true;
      R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! +${ability.special.selfDef} DEF! Enemy +${ability.special.enemyAtk} ATK but can't switch!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // TIMELINE STAR
    if (ability.special?.type === 'timelineStar') {
      player.saveState();
      R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! Current stats saved. They will be restored in 4 turns.`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // --- UPDATE 17 BUG FIX: Tears in the Rain Sans handlers ---
    // RAINFALL BONES — damage + flag attacker for Karma if they attack Sans next turn
    if (ability.special?.type === 'rainfallBones') {
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      player._rainfallBonesArmed = true; // attacker hits this turn? karma them
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} 🌧️ *If hit next turn, attacker will be inflicted with Karma!*`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // SORROW TEARS — 0 dmg, +2 DEF self for 2 turns, -25% enemy accuracy for 2 turns
    if (ability.special?.type === 'sorrowTears') {
      const defBoost = ability.special.defBoost || 2;
      const accRed = ability.special.accReduction || 0.25;
      const dur = ability.special.duration || 2;
      player.defMod += defBoost;
      if (!player._sorrowTearsDefTurns) player._sorrowTearsDefTurns = 0;
      player._sorrowTearsDefTurns += dur;
      player._sorrowTearsDefAmount = (player._sorrowTearsDefAmount || 0) + defBoost;
      this.enemy._missChanceBonus = (this.enemy._missChanceBonus || 0) + accRed;
      this.enemy._missChanceBonusTurns = (this.enemy._missChanceBonusTurns || 0) + dur;
      R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! 💧 +${defBoost} DEF for ${dur} turns! Enemy accuracy **-${Math.round(accRed * 100)}%** for ${dur} turns!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // ECHOING BLASTERS — damage + extra 15 if Heavy Rain active
    if (ability.special?.type === 'echoingBlasters') {
      const d = this.calculateDamage(player, ability, this.enemy);
      let echoBonus = 0;
      let echoMsg = '';
      if (player._heavyRainActive) {
        echoBonus = ability.special.echoDamage || 15;
        echoMsg = ` 🌧️ **Heavy Rain echo: +${echoBonus} damage!**`;
      }
      const totalDmg = d.totalDamage + echoBonus;
      this.enemy.takeDamage(totalDmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${totalDmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${echoMsg}`, damage: totalDmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // RAIN OVERFLOW — base 10 + 16 per 8 turns elapsed (max +96), apply Stun for 2 turns
    if (ability.special?.type === 'rainOverflow') {
      const perInterval = ability.special.perInterval || 8;
      const perBonus = ability.special.perBonus || 16;
      const maxBonus = ability.special.maxBonus || 96;
      const intervals = Math.floor(this.turnNumber / perInterval);
      const bonus = Math.min(intervals * perBonus, maxBonus);
      const baseDmg = 10; // UPDATE 17 buff — base 0 -> 10 so it's not dead on turn 1
      const totalDmg = baseDmg + bonus;
      this.enemy.takeDamage(totalDmg);
      // Apply Stun twice (= 2 turns of stun)
      const sr1 = this.enemy.addStatus('stun');
      const stun = this.enemy.statusEffects.find(s => s.name === 'Stun');
      if (stun) stun.turnsLeft = 2; // 2 stun applications = 2 turns
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${totalDmg}** damage! *(base ${baseDmg} + ${bonus} from ${this.turnNumber} turns elapsed)* 💫 **Stunned for 2 turns!**`, damage: totalDmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // --- UPDATE 17: FatalError B0N3S — damage + Karma + Glitched
    if (ability.special?.type === 'fatalBones') {
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      const kr = this.enemy.addStatus('karma'); const k = this.enemy.statusEffects.find(s => s.name === 'Karma'); if (k) k.turnsLeft = ability.special.karmaDuration || 2;
      const gr = this.enemy.addStatus('glitched'); const g = this.enemy.statusEffects.find(s => s.name === 'Glitched'); if (g) g.turnsLeft = ability.special.glitchedDuration || 2;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} ☯️ **Karma** + 🔀 **Glitched** applied!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // --- UPDATE 17: FatalError STR1NGS — damage + 20% Stun + Glitched
    if (ability.special?.type === 'fatalStrings') {
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      let stunMsg = '';
      if (Math.random() < (ability.special.stunChance || 0.2)) {
        this.enemy.addStatus('stun');
        const s = this.enemy.statusEffects.find(s => s.name === 'Stun');
        if (s) s.turnsLeft = ability.special.stunDuration || 2;
        stunMsg = ' 💫 **Stunned!**';
      }
      const gr = this.enemy.addStatus('glitched'); const g = this.enemy.statusEffects.find(s => s.name === 'Glitched'); if (g) g.turnsLeft = ability.special.glitchedDuration || 1;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${stunMsg} 🔀 **Glitched**!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // --- UPDATE 17: FatalError ERROR CODE: 404 — +3 ATK self for 1 turn, 50% Blindness
    if (ability.special?.type === 'errorCode404') {
      player.atkMod += (ability.special.atkBoost || 3);
      player._errorCode404AtkTurns = 1;
      player._errorCode404AtkAmount = ability.special.atkBoost || 3;
      let blindMsg = '';
      if (Math.random() < (ability.special.blindChance || 0.5)) {
        const br = this.enemy.addStatus('blindness');
        const b = this.enemy.statusEffects.find(s => s.name === 'Blindness');
        if (b) b.turnsLeft = ability.special.blindDuration || 3;
        blindMsg = ' 👁️ **Blindness** applied!';
      }
      R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! +${ability.special.atkBoost || 3} ATK for 1 turn!${blindMsg}`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // --- UPDATE 17: FatalError BL4STERS — damage + 5% self heal + Scary KR + Karma + Glitched
    if (ability.special?.type === 'fatalBlasters') {
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      let healMsg = '';
      if (Math.random() < (ability.special.healChance || 0.05)) {
        const healAmt = Math.floor(player.maxHp * (ability.special.healPercent || 0.03));
        player.heal(healAmt);
        healMsg = ` ✨ Healed **${healAmt} HP**!`;
      }
      const sr = this.enemy.addStatus('scaryKR'); const s = this.enemy.statusEffects.find(s => s.name === 'Scary KR'); if (s) s.turnsLeft = ability.special.scaryKRDuration || 2;
      const kr = this.enemy.addStatus('karma'); const k = this.enemy.statusEffects.find(s => s.name === 'Karma'); if (k) k.turnsLeft = ability.special.karmaDuration || 2;
      const gr = this.enemy.addStatus('glitched'); const g = this.enemy.statusEffects.find(s => s.name === 'Glitched'); if (g) g.turnsLeft = ability.special.glitchedDuration || 2;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${healMsg} ☯️ **Scary KR** + **Karma** + 🔀 **Glitched**!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // --- UPDATE 17: AfterDust Glitched and Dusted Bones — 2-5 hits + 5% bone zone + Karma 2 turns
    if (ability.special?.type === 'glitchedDustedBones') {
      const minHits = ability.special.minHits || 2;
      const maxHits = ability.special.maxHits || 5;
      const hits = Math.floor(Math.random() * (maxHits - minHits + 1)) + minHits;
      let total = 0;
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(player, ability, this.enemy);
        this.enemy.takeDamage(d.totalDamage);
        total += d.totalDamage;
        if (!this.enemy.isAlive) break;
      }
      let boneZoneMsg = '';
      if (Math.random() < (ability.special.boneZoneChance || 0.05)) {
        this.enemy.takeDamage(ability.special.glitchedDmg || 10);
        total += ability.special.glitchedDmg || 10;
        boneZoneMsg = ` 🦴 **Bone Zone summoned!** +${ability.special.glitchedDmg || 10} Glitched DMG!`;
      }
      const kr = this.enemy.addStatus('karma'); const k = this.enemy.statusEffects.find(s => s.name === 'Karma'); if (k) k.turnsLeft = ability.special.krDuration || 2;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! ${hits} hits — **${total}** total damage!${boneZoneMsg} ☯️ **Karma** for ${ability.special.krDuration || 2} turns!`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // --- UPDATE 17: AfterDust Blaster Finale — damage + 2% circle + Karma + Glitched
    if (ability.special?.type === 'blasterFinale') {
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      let circleMsg = '';
      if (Math.random() < (ability.special.circleChance || 0.02)) {
        const extra = 20;
        this.enemy.takeDamage(extra);
        circleMsg = ` 💥 **Blaster Circles** dealt **${extra}** bonus damage!`;
      }
      const kr = this.enemy.addStatus('karma'); const k = this.enemy.statusEffects.find(s => s.name === 'Karma'); if (k) k.turnsLeft = ability.special.krDuration || 1;
      const gr = this.enemy.addStatus('glitched'); const g = this.enemy.statusEffects.find(s => s.name === 'Glitched'); if (g) g.turnsLeft = ability.special.glitchedDuration || 1;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${circleMsg} ☯️ **Karma** + 🔀 **Glitched**!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // --- UPDATE 17: AfterDust Truly a Dusted Being — 8 dmg + Stun, 5% double swing for 10 bonus + 2-turn stun
    if (ability.special?.type === 'trulyDustedBeing') {
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      let bonusMsg = '';
      let stunDur = ability.special.normalStunDuration || 1;
      let totalDmg = d.totalDamage;
      if (Math.random() < (ability.special.doubleSwingChance || 0.05)) {
        const bonus = ability.special.doubleSwingBonusDmg || 10;
        this.enemy.takeDamage(bonus);
        totalDmg += bonus;
        stunDur = ability.special.doubleSwingStunDuration || 2;
        bonusMsg = ` 🌀 **Double swing!** +${bonus} damage!`;
      }
      this.enemy.addStatus('stun');
      const s = this.enemy.statusEffects.find(s => s.name === 'Stun');
      if (s) s.turnsLeft = stunDur;
      const gr = this.enemy.addStatus('glitched'); const g = this.enemy.statusEffects.find(s => s.name === 'Glitched'); if (g) g.turnsLeft = ability.special.glitchedDuration || 1;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${totalDmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${bonusMsg} 💫 **Stunned** for ${stunDur} turn(s)! 🔀 **Glitched**!`, damage: totalDmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // --- UPDATE 17: AfterDust DUSTY DETERMINATION — 50/50 damage boost or dodge
    if (ability.special?.type === 'dustyDetermination') {
      let msg = '';
      if (Math.random() < 0.5) {
        player._dustyDetBoost = ability.special.damageBoost || 1.3;
        player._dustyDetBoostTurns = ability.special.boostDuration || 3;
        msg = `🔥 **${(ability.special.damageBoost || 1.3) * 100 - 100}% damage boost** for ${ability.special.boostDuration || 3} turns!`;
      } else {
        const dodges = Math.floor(Math.random() * ((ability.special.dodgeMax || 4) - (ability.special.dodgeMin || 2) + 1)) + (ability.special.dodgeMin || 2);
        player._dustyDetDodges = (player._dustyDetDodges || 0) + dodges;
        msg = `🌀 **${dodges} dodge${dodges > 1 ? 's' : ''}** stored!`;
      }
      R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! ${msg}`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // --- UPDATE 17: Dream Sans Call for Help — random helper move
    if (ability.special?.type === 'callForHelp') {
      const helpers = ['ink_sans', 'underswap_sans', 'sans', 'underfell_sans', 'outertale_sans'];
      const choice = helpers[Math.floor(Math.random() * helpers.length)];
      const helperChar = CHARACTERS[choice];
      if (helperChar && helperChar.abilities) {
        const damaging = helperChar.abilities.filter(a => a.damageMax > 0);
        if (damaging.length > 0) {
          const move = damaging[Math.floor(Math.random() * damaging.length)];
          const d = this.calculateDamage(player, { ...move, type: move.type }, this.enemy);
          this.enemy.takeDamage(d.totalDamage);
          R.playerAction = { success: true, message: `**${player.name}** called for help! 💫 **${helperChar.name}** uses **${move.name}** for **${d.totalDamage}** damage!`, damage: d.totalDamage };
          if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
          R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
        }
      }
      R.playerAction = { success: true, message: `**${player.name}** called for help but no one came...`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // --- UPDATE 17: Dream Positive Apple — heals 60 HP over 4 turns (15 per turn)
    if (ability.special?.type === 'positiveApple') {
      player._positiveAppleTurns = ability.special.duration || 4;
      player._positiveAppleHeal = ability.special.healPerTurn || 15;
      player.heal(player._positiveAppleHeal);
      R.playerAction = { success: true, message: `**${player.name}** ate a **Positive Apple**! Heals ${player._positiveAppleHeal} HP this turn and every turn for ${ability.special.duration || 4} turns!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // --- UPDATE 17: Nightmare Sans Tentacle Slam — varies by ENRAGED state
    if (ability.special?.type === 'nightmareSlam') {
      let min = ability.damageMin, max = ability.damageMax;
      if (player._enragedActivated) {
        min = ability.special.enragedMin || 55;
        max = ability.special.enragedMax || 60;
      }
      const baseDmg = Math.floor(Math.random() * (max - min + 1)) + min;
      const customAbility = { ...ability, damageMin: baseDmg, damageMax: baseDmg };
      const d = this.calculateDamage(player, customAbility, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${player._enragedActivated ? ' 🌑 **ENRAGED!**' : ''}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // --- UPDATE 17: Nightmare Tentacle Barrage — multi-hit varies by ENRAGED
    if (ability.special?.type === 'nightmareBarrage') {
      // Disabled while shield is active
      if (player._tentacleShieldHp > 0) {
        R.playerAction = { success: false, message: `**${ability.name}** is disabled while **Tentacle Shield** is active!` };
        return R;
      }
      let hits, hitDmgMin, hitDmgMax;
      if (player._enragedActivated) {
        hits = ability.special.enragedHits || 5;
        hitDmgMin = hitDmgMax = ability.special.enragedHitDmg || 10;
      } else {
        hits = Math.floor(Math.random() * ((ability.special.normalMaxHits || 5) - (ability.special.normalMinHits || 4) + 1)) + (ability.special.normalMinHits || 4);
        hitDmgMin = ability.damageMin; hitDmgMax = ability.damageMax;
      }
      let total = 0;
      for (let i = 0; i < hits; i++) {
        const dmg = Math.floor(Math.random() * (hitDmgMax - hitDmgMin + 1)) + hitDmgMin;
        const fakeAbility = { ...ability, damageMin: dmg, damageMax: dmg };
        const d = this.calculateDamage(player, fakeAbility, this.enemy);
        this.enemy.takeDamage(d.totalDamage);
        total += d.totalDamage;
        if (!this.enemy.isAlive) break;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! ${hits} hits — **${total}** total damage!${player._enragedActivated ? ' 🌑 **ENRAGED!**' : ''}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // --- UPDATE 17: Tentacle Shield — 90 Shield HP
    if (ability.special?.type === 'tentacleShield') {
      player._tentacleShieldHp = ability.special.shieldAmount || 90;
      R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! 🛡️ **+${ability.special.shieldAmount || 90} Shield HP**! Tentacle Barrage disabled until shield breaks!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // --- UPDATE 17: Nightmare Negative Apple — heal Nightmare 50 HP, damage enemy 25
    if (ability.special?.type === 'negativeApple') {
      player.heal(ability.special.healAmount || 50);
      this.enemy.takeDamage(ability.damageMax || 25);
      R.playerAction = { success: true, message: `**${player.name}** ate a **Negative Apple**! Healed **${ability.special.healAmount || 50} HP**, enemy takes **${ability.damageMax || 25}** damage!`, damage: ability.damageMax || 25 };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // --- UPDATE 17: Influenced Killer Knife Combo — 2-4 hits, Bleed if 4 hits
    if (ability.special?.type === 'knifeComboInf') {
      let hits, hitDmgMin, hitDmgMax;
      // Check if CHARGED is active
      if (player._chargedActive) {
        hits = Math.floor(Math.random() * ((player._chargedKnifeHitsMax || 5) - (player._chargedKnifeHitsMin || 4) + 1)) + (player._chargedKnifeHitsMin || 4);
        hitDmgMin = hitDmgMax = player._chargedKnifeDmg || 15;
      } else {
        hits = Math.floor(Math.random() * ((ability.special.maxHits || 4) - (ability.special.minHits || 2) + 1)) + (ability.special.minHits || 2);
        hitDmgMin = ability.damageMin; hitDmgMax = ability.damageMax;
      }
      let total = 0;
      for (let i = 0; i < hits; i++) {
        const dmg = Math.floor(Math.random() * (hitDmgMax - hitDmgMin + 1)) + hitDmgMin;
        const fakeAbility = { ...ability, damageMin: dmg, damageMax: dmg };
        const d = this.calculateDamage(player, fakeAbility, this.enemy);
        this.enemy.takeDamage(d.totalDamage);
        total += d.totalDamage;
        if (!this.enemy.isAlive) break;
      }
      let bleedMsg = '';
      if (hits >= (ability.special.bleedThreshold || 4) || player._chargedActive) {
        this.enemy.addStatus('bleed');
        const b = this.enemy.statusEffects.find(s => s.name === 'Bleed');
        const bleedDur = player._chargedActive ? (player._chargedBleedDuration || 3) : (ability.special.bleedDuration || 2);
        if (b) b.turnsLeft = bleedDur;
        bleedMsg = ` 🩸 **Bleed** for ${bleedDur} turns!`;
      }
      const chargedNote = player._chargedActive ? ' ⚡ **CHARGED!**' : '';
      player._chargedActive = false;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}!${chargedNote} ${hits} hits — **${total}** total damage!${bleedMsg}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // --- UPDATE 17: Influenced Killer PERRY — reflect, with recovery threshold
    if (ability.special?.type === 'perry') {
      player._perryActive = true;
      player._perryRecoverThreshold = ability.special.recoverThreshold || 150;
      R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! 🛡️ Reflecting next attack — if it deals more than ${player._perryRecoverThreshold} damage, recovery for 1 turn.`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn();
      player._perryActive = false;
      this.endTurn(R, player); return R;
    }
    // --- UPDATE 17: Influenced Killer CHARGE — skip turn, gain CHARGED
    if (ability.special?.type === 'chargeInf') {
      player._chargedActive = true;
      player._chargedGooDmg = ability.special.chargedGooDmg || 60;
      player._chargedKnifeHitsMin = ability.special.chargedKnifeHits?.min || 4;
      player._chargedKnifeHitsMax = ability.special.chargedKnifeHits?.max || 5;
      player._chargedKnifeDmg = ability.special.chargedKnifeDmg || 15;
      player._chargedBleedDuration = ability.special.chargedBleedDuration || 3;
      R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! ⚡ **CHARGED!** Next Knife Combo or Goo Blaster will be empowered!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    if (ability.special?.type === 'bleed') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      const applyChance = ability.special.chance ?? ability.special.bleedChance ?? 1;
      let bleedMsg = '';
      if (Math.random() < applyChance) {
        const sr = this.enemy.addStatus('bleed');
        if (sr) {
          if (ability.special.duration) { const bl = this.enemy.statusEffects.find(s => s.name === 'Bleed'); if (bl) bl.turnsLeft = ability.special.duration; }
          bleedMsg = ` 🩸 **${sr.name}** applied${ability.special.duration ? ` for ${ability.special.duration} turns` : ''}!`;
        }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${bleedMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    if (ability.special?.type === 'burn') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      const statusKey = ability.special.statusOverride || (ability.special.duration >= 3 ? 'burn3' : 'burn');
      const applyChance = ability.special.burnChance ?? 1;
      const sr = Math.random() < applyChance ? this.enemy.addStatus(statusKey) : null;
      let burnMsg = sr ? ` **${sr.name}** applied for ${ability.special.duration} turns!` : '';
      // Party Lights — explosion moves trigger stun chance
      if (player.passive?.type === 'partyLights' && hasPassiveUnlocked(player.level) && Math.random() < player.passive.stunChance) {
        this.enemy.addStatus('stun'); burnMsg += ' **Party Lights: Stunned!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${burnMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // BLUE SOUL
    if (ability.special?.type === 'blueSoul') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.chance) { const sr = this.enemy.addStatus('blueSoul'); if (sr) sm = ` **${sr.name}** applied!`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // APPLY STATUS (Bone Zone)
    if (ability.special?.type === 'applyStatus') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      const sr = this.enemy.addStatus(ability.special.status);
      let statusMsg = sr ? ` **${sr.name}** applied!` : '';
      R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! **${d.totalDamage}** damage!${statusMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // HIGH CRIT (Toy Knife Slash)
    if (ability.special?.type === 'highCrit') {
      player.critBoost += ability.special.critBonus;
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      player.critBoost = 0;
      let sm = '';
      if (ability.special.statusOnHit) { const sr = this.enemy.addStatus(ability.special.statusOnHit); if (sr) sm = ` **${sr.name}** applied!`; }
      // --- SCAMTON EVENT: Light Ignition — Saber Slash burns once ---
      if ((player._lightIgnitionBurn || 0) > 0 && ability.name === 'Saber Slash' && d.totalDamage > 0) {
        const br = this.enemy.addStatus('burn');
        if (br) {
          // addStatus returns a copy — reach into the live status to set the 3-turn duration
          const _inst = this.enemy.statusEffects.find(x => x.name === 'Burn');
          if (_inst) _inst.turnsLeft = player._lightIgnitionBurn;
          sm += ` 🔥 **Burn** for ${player._lightIgnitionBurn} turns!`;
        }
        player._lightIgnitionBurn = 0;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // MULTI HIT (Knife Barrage)
    if (ability.special?.type === 'multiHit') {
      if (this.enemy.passive?.type === 'starDust') {
        // UPDATE 19 NERF: StarDust blocks extra hits but player still deals 1 hit
        { const d = this.calculateDamage(player, ability, this.enemy); const dr = this.enemy.takeDamage(d.totalDamage);
          this.applyFearOfDeath(player, this.enemy);
          R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! ✨ **StarDust** blocks the extra hits — **${d.totalDamage}** damage (1 hit only)${d.isCrit ? ' (CRIT)' : ''}!`, damage: d.totalDamage }; }
        if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
      const hits = Math.floor(Math.random() * (ability.special.maxHits - ability.special.minHits + 1)) + ability.special.minHits;
      let total = 0, msg = `**${player.name}** used **${ability.name}**!`;
      const appliedStatuses = new Set();
      for (let i = 0; i < hits; i++) {
        if (ability.special.critBonus) player.critBoost = ability.special.critBonus;
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
        msg += ` Hit ${i+1}: **${d.totalDamage}**${d.isCrit ? ' (CRIT)' : ''}!`;
        if (ability.special.poisonChance && Math.random() < ability.special.poisonChance) { const sr = this.enemy.addStatus('poison'); if (sr) appliedStatuses.add(sr.name); }
        if (ability.special.bleedChance && Math.random() < ability.special.bleedChance) { const sr = this.enemy.addStatus('bleed'); if (sr) appliedStatuses.add(sr.name); }
        if (ability.special.stunChance && Math.random() < ability.special.stunChance) { const sr = this.enemy.addStatus('stun'); if (sr) appliedStatuses.add(sr.name); }
        if (ability.special.burnChance && Math.random() < ability.special.burnChance) { const sr = this.enemy.addStatus('burn'); if (sr) appliedStatuses.add(sr.name); }
        if (ability.special.karmaChance && Math.random() < ability.special.karmaChance) { const sr = this.enemy.addStatus('karma'); if (sr) appliedStatuses.add(sr.name); }
        if (!this.enemy.isAlive) break;
      }
      player.critBoost = 0;
      if (total > 0 && ability.special.statusOnHit) { const sr = this.enemy.addStatus(ability.special.statusOnHit); if (sr) appliedStatuses.add(sr.name); }
      msg += ` (${hits} hits, **${total}** total)`;
      if (appliedStatuses.size > 0) msg += [...appliedStatuses].map(name => ` **${name}** applied!`).join('');
      R.playerAction = { success: true, message: msg, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // HANDS OF FATE (Gaster) — random status
    if (ability.special?.type === 'handsOfFate') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      const statuses = ['burn', 'poison', 'stun'];
      const picked = statuses[Math.floor(Math.random() * statuses.length)];
      this.enemy.addStatus(picked);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} Applied **${picked}**!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // GASTER SYMBOL — 10% double hit
    if (ability.special?.type === 'gasterSymbol') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let msg = `**${player.name}** used **᲼᲼᲼᲼**! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}`;
      let total = d.totalDamage;
      if (Math.random() < 0.2) {
        const d2 = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d2.totalDamage);
        total += d2.totalDamage;
        msg += ` **Double hit!** Second hit: **${d2.totalDamage}**${d2.isCrit ? ' (CRIT)' : ''}! Total: **${total}**`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: msg, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // SHARP BONE BARRAGE (Insanity Sans) — 3-8 hits, bleed/poison if 5+
    if (ability.special?.type === 'sharpBoneBarrage') {
      if (this.enemy.passive?.type === 'starDust') {
        // UPDATE 19 NERF: StarDust blocks extra hits but player still deals 1 hit
        { const d = this.calculateDamage(player, ability, this.enemy); const dr = this.enemy.takeDamage(d.totalDamage);
          this.applyFearOfDeath(player, this.enemy);
          R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! ✨ **StarDust** blocks the extra hits — **${d.totalDamage}** damage (1 hit only)${d.isCrit ? ' (CRIT)' : ''}!`, damage: d.totalDamage }; }
        if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
      const hits = Math.floor(Math.random() * (ability.special.maxHits - ability.special.minHits + 1)) + ability.special.minHits;
      let total = 0, msg = `**${player.name}** used **${ability.name}**!`;
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
        msg += ` Hit ${i+1}: **${d.totalDamage}**${d.isCrit ? ' (CRIT)' : ''}!`;
        if (!this.enemy.isAlive) break;
      }
      msg += ` (${hits} hits, **${total}** total)`;
      if (hits >= 5) {
        const status = Math.random() < 0.5 ? 'bleed' : 'poison';
        this.enemy.addStatus(status);
        msg += ` **${status.charAt(0).toUpperCase() + status.slice(1)}** applied (5+ hits)!`;
      }
      R.playerAction = { success: true, message: msg, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // GASTER BLASTER FRENZY (Insanity Sans) — clears self debuffs, 20% self -10 HP, poison enemy + -1 DEF
    if (ability.special?.type === 'gasterBlasterFrenzy') {
      // Clear self debuffs
      player.atkMod = Math.max(0, player.atkMod);
      player.defMod = Math.max(0, player.defMod);
      player.statusEffects = player.statusEffects.filter(s => s.name === 'Bone Zone' || s.name === 'Sharp Bone Zone');
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      this.enemy.addStatus('poison');
      this.enemy.defMod -= 1;
      let msg = `**${player.name}** used **${ability.name}**! Debuffs cleared! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} Enemy **Poisoned** for 2 turns, DEF -1!`;
      if (Math.random() < 0.2) { player.takeDamage(10); msg += ` (Recoil! -10 HP)`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: msg, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // INSANITY TELEPORT — dodge next attack + apply boneZone to enemy 2 turns
    if (ability.special?.type === 'insanityTeleport') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      player.dodgeNextAttack = true;
      if (!this.enemy.statusEffects.find(s => s.name === 'Bone Zone')) {
        this.enemy.statusEffects.push({ name: 'Bone Zone', emoji: '🦴', damagePerTurn: 10, turnsLeft: 2 });
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} Will dodge next attack! **Bone Zone** applied to enemy!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // SAVE POINT ANCHOR (Geno Sans) — damage reduction for N turns
    if (ability.special?.type === 'savePointAnchor') {
      if (!player._damageReduction) player._damageReduction = 0;
      player._damageReduction = ability.special.reduction;
      player._damageReductionTurns = ability.special.duration;
      R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! Damage reduced by ${Math.round(ability.special.reduction*100)}% for ${ability.special.duration} turns!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // SAVE SCREEN SLASH (Geno Sans) — chance to inflict Glitched
    if (ability.special?.type === 'saveScreenSlash') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.glitchedChance) { this.enemy.addStatus('glitched'); sm = ' **Glitched!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // GLITCHY BONES (Geno Sans) — chance enemy misses next attack
    if (ability.special?.type === 'glitchyBones') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.missChance) { this.enemy._missNextAttack = true; sm = ' Enemy will **miss** their next attack!'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // IGNITION ATTACK (Hardtale Sans) — burn chance based on level, HELLFIRE at Lv5
    if (ability.special?.type === 'ignitionAttack') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (hasPassiveUnlocked(player.level)) {
        const burnChance = (player.passive?.baseChance || 0.2) + 0.2 * (player.level - 1);
        if (Math.random() < burnChance) {
          const burnKey = player.level >= 5 ? 'burn3' : 'burn';
          this.enemy.addStatus(burnKey);
          sm = player.level >= 5 ? ' **HELLFIRE!**' : ' **Burn!**';
        }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ZA WARUDO (Hardtale Sans) — skip enemy turn + cancel charge
    if (ability.special?.type === 'zaWarudo') {
      this.enemy.skipNextTurn = true;
      if (this.enemy.isCharging) { this.enemy.isCharging = false; this.enemy.chargedAbility = null; }
      R.playerAction = { success: true, message: `**${player.name}** used **ZA WARUDO!** Time stops! Enemy's next turn is skipped!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // RK SHIELD (RK!Storyshift Chara) — if enemy hits while active, they get stunned
    if (ability.special?.type === 'rkShield') {
      player._rkShieldActive = true;
      R.playerAction = { success: true, message: `**${player.name}** raises their **Shield**! If the enemy attacks, they will be **Stunned**!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn();
      player._rkShieldActive = false;
      this.endTurn(R, player); return R;
    }

    // PERFECT SAVE (Flame Eye) — first use saves ATK/DEF; second use restores stats + heals 30 HP
    if (ability.special?.type === 'perfectSave') {
      if (!player._perfectSaveState) {
        player._perfectSaveState = { atkMod: player.atkMod, defMod: player.defMod };
        R.playerAction = { success: true, message: `**${player.name}** used **PERFECT SAVE** ⭐! Current stats saved (ATK mod: ${player.atkMod >= 0 ? '+' : ''}${player.atkMod}, DEF mod: ${player.defMod >= 0 ? '+' : ''}${player.defMod}). Reuse to restore and heal **${ability.special.healAmount || 30} HP**!`, damage: 0 };
      } else {
        const saved = player._perfectSaveState;
        player.atkMod = saved.atkMod;
        player.defMod = saved.defMod;
        const healed = player.heal(ability.special.healAmount || 30);
        player._perfectSaveState = null;
        R.playerAction = { success: true, message: `**${player.name}** used **PERFECT SAVE** ⭐! Stats restored! Healed **${healed} HP**! (${player.currentHp}/${player.maxHp})`, damage: 0 };
      }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // INK EFFECT (Ink Sans) — deal damage + apply Ink status
    if (ability.special?.type === 'inkEffect') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      const inkExists = this.enemy.statusEffects.find(s => s.name === 'Ink');
      if (!inkExists) this.enemy.statusEffects.push({ name: 'Ink', emoji: '🖌️', damagePerTurn: 6, turnsLeft: 2 });
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage! **Ink** applied!${d.isCrit ? ' **CRIT!**' : ''}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // SOUL TRAIT (Agem) — random soul effect
    if (ability.special?.type === 'soulTrait') {
      const traits = ['Bravery', 'Integrity', 'Patience', 'Perseverance'];
      const picked = traits[Math.floor(Math.random() * traits.length)];
      let msg = `**${player.name}** channeled **${picked}**! `;
      if (picked === 'Bravery') { player._damageBoostNext = 1.35; msg += 'Next attack deals 35% more damage!'; }
      else if (picked === 'Integrity') { this.enemy._missNextAttack = true; msg += 'Enemy has 10% miss chance next attack!'; }
      else if (picked === 'Patience') { this.enemy.addStatus('stun'); msg += 'Enemy stunned!'; }
      else if (picked === 'Perseverance') { player._blockNextHit = true; msg += 'Next hit against you is blocked!'; }
      R.playerAction = { success: true, message: msg, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // NUH UH (Agem) — if enemy attacks same turn, counter
    if (ability.special?.type === 'nuhUh') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      player._nuhUhActive = true;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **NUH UH!!!!!!**! **${d.totalDamage}** damage! Waiting to counter...`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // DUO BLASTERS / PORTAL PILLAR / TRIO BLASTERS — karma + stun
    if (ability.special?.type === 'duoBlasters') {
      let total = 0, msg = `**${player.name}** used **${ability.name}**!`, karmaApplied = false;
      for (let i = 0; i < 2; i++) {
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
        msg += ` Hit ${i+1}: **${d.totalDamage}**${d.isCrit ? ' (CRIT)' : ''}!`;
        if (!this.enemy.isAlive) break;
      }
      if (!karmaApplied && Math.random() < ability.special.karmaChance) { this.enemy.addStatus('karma'); msg += ' **Karma** applied!'; }
      R.playerAction = { success: true, message: msg, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    if (ability.special?.type === 'portalPillar') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.karmaChance) { this.enemy.addStatus('karma'); sm += ' **Karma!**'; }
      if (Math.random() < ability.special.stunChance) { this.enemy.addStatus('stun'); sm += ' **Stunned!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    if (ability.special?.type === 'trioBlasters') {
      let total = 0, msg = `**${player.name}** used **${ability.name}**!`, karmaApplied = false;
      for (let i = 0; i < 3; i++) {
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
        msg += ` Hit ${i+1}: **${d.totalDamage}**${d.isCrit ? ' (CRIT)' : ''}!`;
        if (!this.enemy.isAlive) break;
      }
      if (Math.random() < ability.special.karmaChance) { this.enemy.addStatus('karma'); msg += ' **Karma** applied!'; }
      R.playerAction = { success: true, message: msg, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // BONE VOLLEY (Murder Sans) — delayed explosion
    if (ability.special?.type === 'boneVolley') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      if (!this.enemy._boneVolleyTurns) this.enemy._boneVolleyTurns = 0;
      this.enemy._boneVolleyTurns = ability.special.duration;
      this.enemy._boneVolleyDmg = Math.floor(d.totalDamage * 0.3);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage! Bones latched on — will explode for ${this.enemy._boneVolleyDmg} dmg each turn for ${ability.special.duration} turns!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // SCARY KR (Murder Sans)
    if (ability.special?.type === 'scaryKR') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      this.enemy.addStatus('scaryKR');
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage! **Scary KR** applied for ${ability.special.duration} turns!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ORANGE SOUL (Underswap Papyrus)
    if (ability.special?.type === 'orangeSoul') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.chance) { this.enemy.addStatus('orangeSoul'); sm = ' **Orange Soul** applied!'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // OFF GUARD BLAST (Underswap Papyrus)
    if (ability.special?.type === 'offGuardBlast') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < 0.1) { this.enemy.addStatus('orangeSoul'); sm += ' **Orange Soul!**'; }
      if (Math.random() < 0.2) { this.enemy.addStatus('poison'); sm += ' **Poisoned!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // GRAVITY SHIFT (Underswap Papyrus) — enemy's next move fails
    if (ability.special?.type === 'gravityShift') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      if (Math.random() < ability.special.failChance) { this.enemy._nextMoveFails = true; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} Enemy may be disoriented!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // GET DUNKED KID (Underswap Papyrus) — counter if enemy attacks
    if (ability.special?.type === 'getDunkedKid') {
      player._getDunkedActive = true;
      R.playerAction = { success: true, message: `**${player.name}** readies **Get Dunked Kid**! Waiting for enemy to attack...`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // STRING SLAM (Error Sans)
    if (ability.special?.type === 'stringSlam') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.stunChance) { this.enemy.addStatus('stun'); sm += ' **Stunned!**'; }
      if (Math.random() < ability.special.weakenChance) { this.enemy._weakenedNext = true; sm += ' Enemy\'s next move weakened!'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // CAPTURE BONE (Error Sans)
    if (ability.special?.type === 'captureBone') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.pullChance) { this.enemy._forceMeleeNext = true; sm = ' Enemy is **pulled** — must use Melee next or take extra damage!'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // GLITCHED BLASTERS (Error Sans) — reflect next attack
    if (ability.special?.type === 'glitchedBlasters') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      if (Math.random() < ability.special.reflectChance) { this.enemy._reflectNext = true; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} ${this.enemy._reflectNext ? 'Enemy\'s next attack may backfire!' : ''}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ERROR RESET (Error Sans)
    if (ability.special?.type === 'errorReset') {
      if (this.turnNumber < ability.special.minTurn) {
        R.playerAction = { success: false, message: `**${ability.name}** can only be used after turn ${ability.special.minTurn}!` };
        ability.currentUses++; ability.cooldownLeft = 0; player._usedAbilityThisTurn = false; player._attackedThisTurn = false; return R;
      }
      player.atkMod = 0; player.defMod = 0;
      if (player._tempDebuffs) player._tempDebuffs = [];
      player.statusEffects = [];
      R.playerAction = { success: true, message: `**${player.name}** screams — all debuffs cleared and stats reset!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Domain Expansion COSMIC (The Outering One)
    if (ability.special?.type === 'domainExpansion') {
      const enemyStun = ability.special.stunDuration || 5;
      const selfStun = ability.special.selfStunDuration || 5;
      // --- UPDATE 20 BUG FIX: use a multi-turn stun counter instead of single stun status (which got consumed in 1 turn) ---
      this.enemy._domainStunTurns = enemyStun;
      player._domainSelfStunQueued = selfStun;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** invokes **Domain Expansion: COSMIC** ${emoji}! **${this.enemy.name}** is **STUNNED for ${enemyStun} turns**! ⚠️ When it ends, ${player.name} will be stunned for ${selfStun} turns!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // STAR RAIN (Fallen Stars playable) — fixed damage, once per battle
    if (ability.special?.type === 'starRain') {
      const dmg = ability.damageMin || 125;
      this.enemy.takeDamage(dmg);
      player._starRainUsed = true;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** calls down **STAR RAIN** ${emoji}! ⭐ **${dmg}** stellar damage!`, damage: dmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // OUTER TECHNIQUE NOVA (The Outering One) — 60% miss chance
    if (ability.special?.type === 'outerNova') {
      if (Math.random() < (ability.special.missChance || 0.6)) {
        const emoji = TYPES[ability.type]?.emoji || '';
        R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** unleashed **OUTER TECHNIQUE: NOVA** ${emoji}... but **MISSED!**`, damage: 0 };
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
      const dmg = ability.damageMin || 100;
      this.enemy.takeDamage(dmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** unleashes **OUTER TECHNIQUE: NOVA** ${emoji}! **${dmg}** cosmic damage!`, damage: dmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // BLACKHOLE COLLISION (M87 event boss player) — 250 fixed
    if (ability.special?.type === 'blackholeCollision') {
      const dmg = ability.damageMin || 250;
      this.enemy.takeDamage(dmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** unleashes **BLACKHOLE: COLLISION** ${emoji}! 🕳️ **${dmg}** apocalyptic damage!`, damage: dmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // NO MORE MERCY (Ainavolagem) — only at 20% HP
    if (ability.special?.type === 'noMoreMercy') {
      // UPDATE 31 BUG FIX: hpPct was referenced but never defined here — crashed the battle
      const hpPct = player.currentHp / player.maxHp;
      if (hpPct > ability.special.hpThreshold) {
        R.playerAction = { success: false, message: `**No More Mercy** can only be used at 20% HP or below!` };
        ability.currentUses++; ability.cooldownLeft = 0; player._usedAbilityThisTurn = false; player._attackedThisTurn = false; return R;
      }
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      const applied = [];
      const pool = ['karma', 'electrified', 'blueSoul', 'blindness', 'bleed', 'stun'];
      // Shuffle pool and pick guaranteed 2 unique statuses
      const shuffled = pool.sort(() => Math.random() - 0.5);
      for (let i = 0; i < 2; i++) { this.enemy.addStatus(shuffled[i]); applied.push(shuffled[i]); }
      // 15% chance for each additional
      let i = 2;
      while (i < shuffled.length && Math.random() < 0.15) { this.enemy.addStatus(shuffled[i]); applied.push(shuffled[i]); i++; }
      R.playerAction = { success: true, message: `**${player.name}** used **No More Mercy**! **${d.totalDamage}** damage! Applied: **${applied.join(', ')}**!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // AINAVOL BLASTER BARRAGE (Ainavolagem)
    if (ability.special?.type === 'ainavolBB') {
      const hits = Math.floor(Math.random() * (ability.special.maxHits - ability.special.minHits + 1)) + ability.special.minHits;
      let total = 0, msg = `**${player.name}** used **${ability.name}**!`;
      const statusPool = ['burn', 'electrified', 'karma'];
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
        msg += ` Hit ${i+1}: **${d.totalDamage}**${d.isCrit ? ' (CRIT)' : ''}!`;
        if (Math.random() < 0.3) { const s = statusPool[Math.floor(Math.random() * statusPool.length)]; this.enemy.addStatus(s); msg += ` **${s}!**`; }
        if (!this.enemy.isAlive) break;
      }
      msg += ` (${hits} hits, **${total}** total)`;
      R.playerAction = { success: true, message: msg, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // --- UPDATE 14: HELL BLASTER (CATASTROPHE!FELL) — Fire + Poison
    if (ability.special?.type === 'hellBlaster') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      const burnSr = this.enemy.addStatus('burn'); if (burnSr) sm += ' **Burn applied!**';
      const poisonSr = this.enemy.addStatus('poison'); if (poisonSr) sm += ' **Poison applied!**';
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // --- UPDATE 14: Chained Blaster (CATASTROPHE!FELL) — 2 hits, Poison + 15% Stun
    if (ability.special?.type === 'chainedBlaster') {
      if (this.enemy.passive?.type === 'starDust') {
        // UPDATE 19 NERF: StarDust blocks extra hits but player still deals 1 hit
        { const d = this.calculateDamage(player, ability, this.enemy); const dr = this.enemy.takeDamage(d.totalDamage);
          this.applyFearOfDeath(player, this.enemy);
          R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! ✨ **StarDust** blocks the extra hits — **${d.totalDamage}** damage (1 hit only)${d.isCrit ? ' (CRIT)' : ''}!`, damage: d.totalDamage }; }
        if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
      let total = 0, msg = `**${player.name}** used **${ability.name}**!`;
      let poisoned = false, stunned = false;
      for (let i = 0; i < 2; i++) {
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
        msg += ` Hit ${i+1}: **${d.totalDamage}**${d.isCrit ? ' (CRIT)' : ''}!`;
        if (!poisoned) { const sr = this.enemy.addStatus('poison'); if (sr) { msg += ' **Poisoned!**'; poisoned = true; } }
        if (!stunned && Math.random() < (ability.special.stunChance || 0.15)) { const sr = this.enemy.addStatus('stun'); if (sr) { msg += ' **Stunned!**'; stunned = true; } }
        if (!this.enemy.isAlive) break;
      }
      msg += ` (**${total}** total)`;
      R.playerAction = { success: true, message: msg, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // --- UPDATE 14: Chained Bones (CATASTROPHE!FELL) — 3-6 hits, Bleed
    if (ability.special?.type === 'chainedBones') {
      if (this.enemy.passive?.type === 'starDust') {
        // UPDATE 19 NERF: StarDust blocks extra hits but player still deals 1 hit
        { const d = this.calculateDamage(player, ability, this.enemy); const dr = this.enemy.takeDamage(d.totalDamage);
          this.applyFearOfDeath(player, this.enemy);
          R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! ✨ **StarDust** blocks the extra hits — **${d.totalDamage}** damage (1 hit only)${d.isCrit ? ' (CRIT)' : ''}!`, damage: d.totalDamage }; }
        if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
      const hits = Math.floor(Math.random() * (ability.special.maxHits - ability.special.minHits + 1)) + ability.special.minHits;
      let total = 0, msg = `**${player.name}** used **${ability.name}**!`;
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
        msg += ` Hit ${i+1}: **${d.totalDamage}**${d.isCrit ? ' (CRIT)' : ''}!`;
        if (!this.enemy.isAlive) break;
      }
      const bleedSr = this.enemy.addStatus('bleed'); if (bleedSr) msg += ' **Bleed!**';
      msg += ` (${hits} hits, **${total}** total)`;
      R.playerAction = { success: true, message: msg, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // --- UPDATE 14: FIRENUKE (CATASTROPHE!FELL) — 125 damage to both, Burn applied, self damage too
    if (ability.special?.type === 'firenuke') {
      const dmg = ability.damageMin || 125;
      this.enemy.takeDamage(dmg);
      player.currentHp = Math.max(0, player.currentHp - (ability.special.selfDamage || dmg));
      const burnSr = this.enemy.addStatus('burn');
      const emoji = TYPES[ability.type]?.emoji || '';
      let msg = `**${player.name}** used **F I R E N U K E** ${emoji}! **${dmg}** damage to enemy! **${player.name}** also takes **${ability.special.selfDamage || dmg}** damage!`;
      if (burnSr) msg += ' **Burn applied!**';
      R.playerAction = { success: true, abilityType: ability.type, message: msg, damage: dmg };
      // Check if player KO'd self
      if (!player.isAlive) {
        // continue to enemy check first
      }
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      // If player KO'd, switch handling will happen in normal flow
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // BONE SPASM (Time Paradox agem side)
    if (ability.special?.type === 'boneSpasm') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < 0.2) {
        const s = Math.random() < 0.5 ? 'burn' : 'electrified';
        this.enemy.addStatus(s); sm = ` **${s.charAt(0).toUpperCase() + s.slice(1)}!**`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // BLINDNESS
    if (ability.special?.type === 'blindness') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.chance) { this.enemy.addStatus('blindness'); sm = ' **Blindness** applied!'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // RUSHDOWN (Time Paradox agem side) — multi-hit, chance burn or flinch
    if (ability.special?.type === 'rushdown') {
      const hits = Math.floor(Math.random() * (ability.special.maxHits - ability.special.minHits + 1)) + ability.special.minHits;
      let total = 0, msg = `**${player.name}** used **${ability.name}**!`;
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
        msg += ` Hit ${i+1}: **${d.totalDamage}**${d.isCrit ? ' (CRIT)' : ''}!`;
        if (!this.enemy.isAlive) break;
      }
      msg += ` (${hits} hits, **${total}** total)`;
      if (Math.random() < 0.3) {
        const s = Math.random() < 0.5 ? 'burn' : 'flinch';
        this.enemy.addStatus(s); msg += ` **${s.charAt(0).toUpperCase() + s.slice(1)}!**`;
      }
      R.playerAction = { success: true, message: msg, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ARM BLASTER (Time Paradox agem side) — karma chance
    if (ability.special?.type === 'armBlaster') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.karmaChance) { this.enemy.addStatus('karma'); sm = ' **Karma** applied!'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // SPEAR IMPALE (Ainavolagem) — bleed or flinch
    if (ability.special?.type === 'spearImpale') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < 0.3) {
        const s = Math.random() < 0.5 ? 'bleed' : 'flinch';
        this.enemy.addStatus(s); sm = ` **${s.charAt(0).toUpperCase() + s.slice(1)}!**`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // NORMAL WITH COOLDOWN (Triple Blaster on Snowdin Dust)

    // STUN (used by Ground Skewer, Bone Skewer, Tracking Blaster)
    if (ability.special?.type === 'stun') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.chance) { this.enemy.addStatus('stun'); sm = ' **Stunned!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      if (ability.special.cooldown) ability.cooldownLeft = ability.special.cooldown;
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // TRACKING BLASTER — guaranteed hit, can't be parried, stun chance
    if (ability.special?.type === 'trackingBlaster') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.stunChance) { this.enemy.addStatus('stun'); sm = ' **Stunned!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      if (ability.special.cooldown) ability.cooldownLeft = ability.special.cooldown;
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage! *(Guaranteed hit)*${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // AXE THROW — high crit, miss chance
    if (ability.special?.type === 'axeThrow') {
      const emoji = TYPES[ability.type]?.emoji || '';
      if (ability.special.cooldown) ability.cooldownLeft = ability.special.cooldown;
      if (Math.random() < ability.special.missChance) {
        player.takeDamage(ability.special.selfDamage);
        player.addStatus('poison');
        R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** threw the axe... but it came back! **${ability.special.selfDamage}** self-damage + **Poisoned!**`, damage: 0 };
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
      const origCrit = this.CRIT_CHANCE; this.CRIT_CHANCE = origCrit + 0.25;
      const d = this.calculateDamage(player, ability, this.enemy); this.CRIT_CHANCE = origCrit;
      this.enemy.takeDamage(d.totalDamage);
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}`, damage: d.totalDamage };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // SHARP BONE ZONE — per-turn damage on enemy
    if (ability.special?.type === 'sharpBoneZone') {
      if (!this.enemy.statusEffects.find(s => s.id === 'sharpBoneZone')) {
        this.enemy.statusEffects.push({ id: 'sharpBoneZone', name: 'Sharp Bone Zone', emoji: '🦴', damagePerTurn: ability.special.damagePerTurn, turnsLeft: ability.special.duration });
      }
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** set up **Sharp Bone Zone**! Enemy takes **${ability.special.damagePerTurn}** dmg/turn for ${ability.special.duration} turns.`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // DEFENSE CURL — priority, self ATK -1, block high damage
    if (ability.special?.type === 'defenseCurl') {
      player.atkMod = (player.atkMod || 0) - 1;
      player.defenseCurlActive = true; // mark for enemy damage check
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** curls into defense! ATK -1. Will block hits over ${ability.special.blockThreshold} dmg.`, damage: 0 };
      // Execute enemy turn — check if damage blocked
      const enemyResult = this.executeEnemyTurn();
      if (enemyResult && enemyResult.damage > ability.special.blockThreshold && player.defenseCurlActive) {
        player.defenseCurlActive = false;
        // Heal the damage back and give DEF
        player.currentHp = Math.min(player.maxHp, player.currentHp + enemyResult.damage);
        player.defMod = (player.defMod || 0) + ability.special.defGain;
        enemyResult.message += ` *(Blocked! +${ability.special.defGain} DEF)*`;
        enemyResult.damage = 0;
      }
      player.defenseCurlActive = false;
      R.enemyAction = enemyResult; this.endTurn(R, player); return R;
    }

    // TEMP DEBUFF (Fracture Strike - not stackable, expires after N turns)
    if (ability.special?.type === 'tempDebuff') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      const target = ability.special.target === 'enemy' ? this.enemy : player;
      // Check if already debuffed by this (not stackable)
      if (!target._tempDebuffs) target._tempDebuffs = [];
      const existing = target._tempDebuffs.find(td => td.stat === ability.special.stat && td.source === ability.name);
      let debuffMsg = '';
      if (!existing) {
        if (ability.special.stat === 'atk') target.atkMod += ability.special.amount;
        if (ability.special.stat === 'def') target.defMod += ability.special.amount;
        target._tempDebuffs.push({ stat: ability.special.stat, amount: ability.special.amount, turnsLeft: ability.special.duration, source: ability.name });
        debuffMsg = ` ${target.name}'s ${ability.special.stat.toUpperCase()} ${ability.special.amount} for ${ability.special.duration} turns!`;
      } else {
        existing.turnsLeft = ability.special.duration;
        debuffMsg = ` (${ability.special.stat.toUpperCase()} debuff refreshed)`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${debuffMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // STEAL WEAPON — use random move from all characters in game
    if (ability.special?.type === 'stealWeapon') {
      const { CHARACTERS } = require('./gameData');
      const allChars = Object.values(CHARACTERS);
      const allMoves = [];
      allChars.forEach(ch => ch.abilities && ch.abilities.forEach(a => {
        if (a.damageMax > 0) allMoves.push({ ...a, ownerName: ch.name });
      }));
      const stolen = allMoves[Math.floor(Math.random() * allMoves.length)];
      const d = this.calculateDamage(player, stolen, this.enemy); this.enemy.takeDamage(d.totalDamage);
      const emoji = TYPES[stolen.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: stolen.type, message: `**${player.name}** stole **${stolen.name}** from ${stolen.ownerName}! ${emoji} **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // COINFLIP
    if (ability.special?.type === 'coinflip') {
      const statuses = ['poison', 'bleed', 'burn', 'stun'];
      const picked = statuses[Math.floor(Math.random() * statuses.length)];
      if (Math.random() < 0.5) {
        // Heads: deal damage + apply status to enemy
        const d = this.calculateDamage(player, { ...ability, damageMin: 15, damageMax: 25 }, this.enemy);
        this.enemy.takeDamage(d.totalDamage);
        this.enemy.addStatus(picked);
        R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** flips a coin... **Heads!** **${d.totalDamage}** damage! Applied **${picked}** to the enemy!`, damage: d.totalDamage };
      } else {
        // Tails: 20 self-damage + status on self
        player.takeDamage(20);
        player.addStatus(picked);
        R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** flips a coin... **Tails!** Takes 20 self-damage and **${picked}**!`, damage: 0 };
      }
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // FLAME BLASTER — 35% chance burn or poison
    if (ability.special?.type === 'flameBlaster') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.statusChance) {
        const s = Math.random() < 0.5 ? 'burn' : 'poison';
        this.enemy.addStatus(s); sm = ` **${s.charAt(0).toUpperCase() + s.slice(1)}!**`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    if (ability.special?.type === 'normal') {
      // Just normal damage, cooldown already handled at top
    }

    // BONE SWING (Last Breath Sans) — increasing bleed chance
    if (ability.special?.type === 'boneSwing') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      if (!player._boneSwingChance) player._boneSwingChance = ability.special.baseBleedChance;
      let bleedMsg = '';
      if (Math.random() < player._boneSwingChance) {
        this.enemy.addStatus('bleed');
        bleedMsg = ' **Bleed** applied!';
        player._boneSwingChance = ability.special.baseBleedChance; // reset
      } else {
        player._boneSwingChance += 0.1; // increase chance
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${bleedMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // BLASTER BARRAGE (Last Breath Sans) — 100% poison 1-5 turns
    if (ability.special?.type === 'blasterBarrage') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      const poisonTurns = Math.floor(Math.random() * 5) + 1;
      this.enemy.statusEffects.push({ name: 'Poison', emoji: '🟢', damagePerTurn: 3, turnsLeft: poisonTurns });
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage! **Poisoned** for ${poisonTurns} turns!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // COLOR BARRAGE (Last Breath Sans) — 50/50 lower ATK or DEF
    if (ability.special?.type === 'colorBarrage') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      const stat = Math.random() < 0.5 ? 'atk' : 'def';
      if (!this.enemy._tempDebuffs) this.enemy._tempDebuffs = [];
      if (stat === 'atk') this.enemy.atkMod -= 3;
      else this.enemy.defMod -= 3;
      this.enemy._tempDebuffs.push({ stat, amount: -3, turnsLeft: 2, source: 'Color Barrage' });
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage! Enemy ${stat.toUpperCase()} -3 for 1 turn!${d.isCrit ? ' **CRIT!**' : ''}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // BLOCKED (Last Breath Sans) — triple DEF for 2 turns
    if (ability.special?.type === 'blocked') {
      const boost = player.baseDef * 2; // triple = base + 2x base
      player.defMod += boost;
      if (!player._tempDebuffs) player._tempDebuffs = [];
      player._tempDebuffs.push({ stat: 'def', amount: boost, turnsLeft: ability.special.duration + 1, source: 'BLOCKED' });
      player._blockedActive = ability.special.duration + 1;
      R.playerAction = { success: true, message: `**${player.name}** used **BLOCKED**! DEF tripled for ${ability.special.duration} turns! Bone Swing disabled.`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // RAINING TACOS (Underswap Sans) — 0 ATK 3 turns, heal 20 HP 4 turns
    if (ability.special?.type === 'rainingTacos') {
      player._rainingTacosAtkLock = ability.special.atkLockTurns;
      player._rainingTacosHeal = ability.special.healDuration;
      player._rainingTacosHealAmt = ability.special.healPerTurn;
      R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! ATK locked for ${ability.special.atkLockTurns} turns, healing **${ability.special.healPerTurn} HP/turn** for ${ability.special.healDuration} turns!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // UNSEEN SENTENCE (Revenge Papyrus) — below 15% HP only, guaranteed stun + permanent -2 ATK
    if (ability.special?.type === 'unseenSentence') {
      const hpPct = player.currentHp / player.maxHp;
      if (hpPct > ability.special.hpThreshold) {
        R.playerAction = { success: false, message: `**The Unseen Sentence** can only be used below 15% HP!` };
        ability.currentUses++; ability.cooldownLeft = 0; player._usedAbilityThisTurn = false; player._attackedThisTurn = false; return R;
      }
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      this.enemy.addStatus('stun');
      this.enemy.atkMod -= 2; // permanent ATK reduction
      R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} **Stunned!** Enemy ATK permanently -2!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // BONES OF DESPERATION (IDUTSHANE) — gains +3 dmg each use
    if (ability.special?.type === 'bonesOfDesperation') {
      if (!player._bodBonus) player._bodBonus = 0;
      const boostedAbility = { ...ability, damageMin: ability.damageMin + Math.floor(player._bodBonus), damageMax: ability.damageMax + Math.floor(player._bodBonus) };
      const d = this.calculateDamage(player, boostedAbility, this.enemy); this.enemy.takeDamage(d.totalDamage);
      player._bodBonus += 3;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} (Bonus DMG: +${Math.floor(player._bodBonus - 3)})`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // BONE CARROUSEL (IDUTSHANE) — applies boneZone-style 5-10 dmg for 1-3 turns
    if (ability.special?.type === 'boneCarrousel') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      if (!this.enemy.statusEffects.find(s => s.id === 'boneCarrousel')) {
        const dur = Math.floor(Math.random() * 3) + 1;
        this.enemy.statusEffects.push({ id: 'boneCarrousel', name: 'Bone Carrousel', emoji: '🦴', damagePerTurn: 0, _minDmg: 5, _maxDmg: 10, turnsLeft: dur });
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage! Enemy takes 5-10 dmg at turn start for 1-3 turns!${d.isCrit ? ' **CRIT!**' : ''}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // AGGRAVATION (IDUTSHANE) — double crit for 2 turns, min turn 5
    if (ability.special?.type === 'aggravation') {
      if (this.turnNumber < ability.special.minTurn) {
        R.playerAction = { success: false, message: `**Aggravation** can only be used on turn ${ability.special.minTurn} or later!` };
        ability.currentUses++; ability.cooldownLeft = 0; player._usedAbilityThisTurn = false; player._attackedThisTurn = false; return R;
      }
      player._aggravationActive = true;
      player._aggravationTurns = ability.special.duration;
      const atkBoost = ability.special.atkBoost || 0;
      if (atkBoost) { player.atkMod += atkBoost; player._aggravationAtkBoost = atkBoost; }
      R.playerAction = { success: true, message: `**${player.name}** used **Aggravation**! Crit chance doubled for ${ability.special.duration} turns${atkBoost ? ` and gained **+${atkBoost} ATK**` : ''}!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // CHARGED BLASTER (a forced grin.) — 30% electrified, 10% backfire
    if (ability.special?.type === 'chargedBlaster') {
      if (Math.random() < ability.special.backfireChance) {
        const selfD = this.calculateDamage(player, ability, player); player.takeDamage(selfD.totalDamage);
        R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**... but it **backfired**! **${selfD.totalDamage}** self-damage!`, damage: 0 };
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.electrifiedChance) { this.enemy.addStatus('electrified'); sm = ' **Electrified!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // CAR BATTERY (a forced grin.) — guaranteed electrified + 50% stun
    if (ability.special?.type === 'carBattery') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      this.enemy.addStatus('electrified');
      let sm = ' **Electrified!**';
      if (Math.random() < ability.special.stunChance) { this.enemy.addStatus('stun'); sm += ' **Stunned!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // MY CREW! (Oceantale Sans) — summons crew for 10 dmg/turn for 2 turns
    // --- UPDATE 22: Cannonballs (Oceantale) — burn + 15% stun + crew extra hit while My Crew! active ---
    if (ability.special?.type === 'oceanCannonballs') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let total = d.totalDamage; let sm = '';
      const br = this.enemy.addStatus('burn'); if (br) sm += ' **Burn!**';
      if (Math.random() < (ability.special.stunChance || 0.15)) { const st = this.enemy.addStatus('stun'); if (st) sm += ' **Stunned!**'; }
      if ((this.enemy._crewTurns || 0) > 0 && Math.random() < (ability.special.crewExtraChance || 0.30) && this.enemy.isAlive) {
        const d2 = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d2.totalDamage); total += d2.totalDamage;
        sm += ` ⚓ A crewmate fires their own cannonball — **${d2.totalDamage}** extra damage!`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${total}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    if (ability.special?.type === 'myCrew') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      if (!this.enemy._crewTurns || this.enemy._crewTurns <= 0) {
        this.enemy._crewTurns = ability.special.duration;
        this.enemy._crewDmg = ability.special.damagePerTurn;
      }
      R.playerAction = { success: true, message: `**${player.name}** used **My Crew!** The crew arrives! **${d.totalDamage}** damage! Enemy takes **${ability.special.damagePerTurn}** dmg/turn for ${ability.special.duration} turns!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // TSUNAMI (Oceantale Sans) — damage + -2 DEF to both
    if (ability.special?.type === 'tsunami') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      player.defMod += ability.special.selfDef;
      this.enemy.defMod += ability.special.enemyDef;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **TSUNAMI** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} Both sides -2 DEF!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // MULTI DEBUFF PLAYER (Chilling Reveal — Fresh Sans) — debuff enemy ATK and DEF
    if (ability.special?.type === 'multiDebuffPlayer') {
      this.enemy.atkMod += ability.special.enemyAtk;
      this.enemy.defMod += ability.special.enemyDef;
      R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! Enemy ATK ${ability.special.enemyAtk}, DEF ${ability.special.enemyDef}!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // BLEED AND STUN — applies both bleed and optional stun
    if (ability.special?.type === 'bleedAndStun') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      const emoji = TYPES[ability.type]?.emoji || '';
      let sm = '';
      if (Math.random() < (ability.special.bleedChance || 0)) { this.enemy.addStatus('bleed'); sm += ' **Bleed!**'; }
      if (Math.random() < (ability.special.stunChance || 0)) { this.enemy.addStatus('stun'); sm += ' **Stunned!**'; }
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // UPDATE 30: UV Swap — Giant Gaster Blaster (poison 2t + 30% DEF-1)
    if (ability.special?.type === 'giantGasterBlaster') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      const sr = this.enemy.addStatus('poison');
      if (sr) { const ps = this.enemy.statusEffects.find(s => s.name === 'Poison'); if (ps && ability.special.poisonDuration) ps.turnsLeft = ability.special.poisonDuration; sm += ` 🟢 **Poison** for ${ability.special.poisonDuration || 2} turns!`; }
      if (Math.random() < (ability.special.defDownChance || 0.30)) { this.enemy.defMod -= (ability.special.defDown || 1); sm += ` **-${ability.special.defDown || 1} DEF!**`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // UPDATE 30: UV Swap — Blue Bone Combo (bleed 2t + 30% stun -> trap+cd, else blue soul 1t)
    if (ability.special?.type === 'uvBlueBoneCombo') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      const br = this.enemy.addStatus('bleed');
      if (br) { const bl = this.enemy.statusEffects.find(s => s.name === 'Bleed'); if (bl && ability.special.bleedDuration) bl.turnsLeft = ability.special.bleedDuration; sm += ` 🩸 **Bleed** for ${ability.special.bleedDuration || 2} turns!`; }
      if (Math.random() < (ability.special.stunChance || 0.30)) {
        this.enemy.addStatus('stun');
        this.enemy._uvTrapTurns = Math.max(this.enemy._uvTrapTurns || 0, ability.special.trapDuration || 2);
        ability.cooldownLeft = ability.special.stunCooldown || 3;
        sm += ` **Stunned!** Enemy cannot switch/escape for ${ability.special.trapDuration || 2} turns!`;
      } else {
        const su = this.enemy.addStatus('blueSoul');
        if (su) { const bs = this.enemy.statusEffects.find(s => s.name === 'Blue Soul'); if (bs) bs.turnsLeft = ability.special.blueSoulDuration || 1; sm += ` 💙 **Blue Soul** for ${ability.special.blueSoulDuration || 1} turn!`; }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // UPDATE 30: UV Swap — Bone Tower Barrage (60% bleed, 1.2x vs stunned/poisoned, +fixed status dmg debuff)
    if (ability.special?.type === 'uvBoneTowerBarrage') {
      const wasStunnedOrPoisoned = this.enemy.hasStatus('Stun') || this.enemy.hasStatus('Poison');
      const d = this.calculateDamage(player, ability, this.enemy);
      let dmg = d.totalDamage;
      if (wasStunnedOrPoisoned) dmg = Math.floor(dmg * (ability.special.statusBonusMult || 1.2));
      this.enemy.takeDamage(dmg);
      let sm = '';
      if (Math.random() < (ability.special.bleedChance || 0.6)) { const sr = this.enemy.addStatus('bleed'); if (sr) sm += ` 🩸 **Bleed!**`; }
      if (wasStunnedOrPoisoned) sm += ` (1.2x vs afflicted)`;
      this.enemy._statusDamageBonus = ability.special.statusDamageBonus || 10;
      this.enemy._statusDamageBonusTurns = 2;
      sm += ` ⚠️ Enemy's status damage +${ability.special.statusDamageBonus || 10} for 2 turns!`;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: dmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // UPDATE 30: LowTierFell — LowTier Blasters (3 hits + <10% HP true dmg + Scary KR/Poison)
    if (ability.special?.type === 'lowtierBlasters') {
      let total = 0;
      const hits = ability.special.hits || 3;
      for (let i = 0; i < hits; i++) { if (!this.enemy.isAlive) break; const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage; }
      let sm = '';
      if ((player.currentHp / player.maxHp) < (ability.special.lowHpThreshold || 0.10)) { this.enemy.currentHp = Math.max(0, this.enemy.currentHp - (ability.special.lowHpTrueDamage || 15)); total += (ability.special.lowHpTrueDamage || 15); sm += ` ⚡ **+${ability.special.lowHpTrueDamage || 15} true damage!**`; }
      const kr = this.enemy.addStatus('scaryKR'); if (kr) { const k = this.enemy.statusEffects.find(s => s.name === 'Scary KR'); if (k) k.turnsLeft = ability.special.scaryKRDuration || 1; sm += ' ☯️ **Scary KR!**'; }
      const po = this.enemy.addStatus('poison'); if (po) { const q = this.enemy.statusEffects.find(s => s.name === 'Poison'); if (q) q.turnsLeft = ability.special.poisonDuration || 1; sm += ' 🟢 **Poison!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! ${hits} blasters for **${total}** damage!${sm}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // UPDATE 30: LowTierFell — LowTier Bones (damage + Scary KR/Bleed)
    if (ability.special?.type === 'lowtierBones') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      const kr = this.enemy.addStatus('scaryKR'); if (kr) { const k = this.enemy.statusEffects.find(s => s.name === 'Scary KR'); if (k) k.turnsLeft = ability.special.scaryKRDuration || 1; sm += ' ☯️ **Scary KR!**'; }
      const bl = this.enemy.addStatus('bleed'); if (bl) { const b = this.enemy.statusEffects.find(s => s.name === 'Bleed'); if (b) b.turnsLeft = ability.special.bleedDuration || 1; sm += ' 🩸 **Bleed!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // UPDATE 30: LowTierFell — Chained Slam (30% miss, <15% true dmg, 40% multi-status)
    if (ability.special?.type === 'chainedSlam') {
      if (Math.random() < (ability.special.missChance || 0.30)) {
        R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}**... but it **missed**!`, damage: 0 };
        if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); let total = d.totalDamage;
      let sm = '';
      if ((player.currentHp / player.maxHp) < (ability.special.lowHpThreshold || 0.15)) { this.enemy.currentHp = Math.max(0, this.enemy.currentHp - (ability.special.lowHpTrueDamage || 10)); total += (ability.special.lowHpTrueDamage || 10); sm += ` 👊 **+${ability.special.lowHpTrueDamage || 10} true damage!**`; }
      if (Math.random() < (ability.special.statusChance || 0.40)) {
        const dur = ability.special.statusDuration || 2;
        for (const [key, nm] of [['scaryKR','Scary KR'],['bleed','Bleed'],['poison','Poison'],['karma','Karma']]) { const r = this.enemy.addStatus(key); if (r) { const st = this.enemy.statusEffects.find(s => s.name === nm); if (st) st.turnsLeft = dur; } }
        sm += ` ☯️🩸🟢 **Scary KR + Bleed + Poison + Karma (${dur}t)!**`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${total}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // UPDATE 30: LowTierFell — I'VE HAD ENOUGH OF YOU, BRAT! (bleed 2t + stun 1t)
    if (ability.special?.type === 'lowtierEnough') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      const bl = this.enemy.addStatus('bleed'); if (bl) { const b = this.enemy.statusEffects.find(s => s.name === 'Bleed'); if (b) b.turnsLeft = ability.special.bleedDuration || 2; sm += ' 🩸 **Bleed!**'; }
      const st = this.enemy.addStatus('stun'); if (st) sm += ' 💫 **Stunned!**';
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // UPDATE 30: Storyspin — Bat Whack (40% stun + 20% DEF-2)
    if (ability.special?.type === 'batWhack') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.stunChance || 0.40)) { const st = this.enemy.addStatus('stun'); if (st) sm += ' STUN'; }
      if (Math.random() < (ability.special.defDownChance || 0.20)) { this.enemy.defMod -= (ability.special.defDown || 2); sm += ` -${ability.special.defDown || 2} DEF`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm ? ' -' + sm : ''}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // UPDATE 30: Storyspin — Twisted Barrage (3-5 hits, 20%/hit pierce 10% DEF, Poison 2t)
    if (ability.special?.type === 'twistedBarrage') {
      const hits = Math.floor(Math.random() * ((ability.special.maxHits || 5) - (ability.special.minHits || 3) + 1)) + (ability.special.minHits || 3);
      let total = 0, pierces = 0;
      for (let i = 0; i < hits; i++) {
        if (!this.enemy.isAlive) break;
        let pierce = 0;
        if (Math.random() < (ability.special.pierceChance || 0.20)) { pierce = Math.floor(this.enemy.def * (ability.special.piercePercent || 0.10)); this.enemy.defMod -= pierce; pierces++; }
        const d = this.calculateDamage(player, ability, this.enemy);
        if (pierce) this.enemy.defMod += pierce;
        this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
      }
      let sm = '';
      const po = this.enemy.addStatus('poison'); if (po) { const q = this.enemy.statusEffects.find(s => s.name === 'Poison'); if (q) q.turnsLeft = ability.special.poisonDuration || 2; sm += ` Poison ${ability.special.poisonDuration || 2}t`; }
      if (pierces > 0) sm += ` (pierced ${pierces}x)`;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! ${hits} hits for **${total}** damage!${sm ? ' -' + sm : ''}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // UPDATE 30: Storyspin — Vision Manipulation (Blindness 3-5t)
    if (ability.special?.type === 'visionManipulation') {
      const dur = Math.floor(Math.random() * ((ability.special.blindMax || 5) - (ability.special.blindMin || 3) + 1)) + (ability.special.blindMin || 3);
      const br = this.enemy.addStatus('blindness'); let sm = '';
      if (br) { const b = this.enemy.statusEffects.find(s => s.name === 'Blindness'); if (b) b.turnsLeft = dur; sm = ` Blindness for ${dur} turns!`; } else { sm = ' (no effect)'; }
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}**!${sm}`, damage: 0 };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // UPDATE 30: Storyspin — Malfunctioning Blaster (25% malfunction: half dmg to both + crit 2t)
    if (ability.special?.type === 'malfunctioningBlaster') {
      const d = this.calculateDamage(player, ability, this.enemy);
      let dmg = d.totalDamage, sm = '';
      if (Math.random() < (ability.special.malfunctionChance || 0.25)) {
        dmg = Math.floor(dmg * 0.5);
        this.enemy.takeDamage(dmg);
        player.currentHp = Math.max(1, player.currentHp - dmg);
        player.critBoost = (ability.special.critBoost || 0.30);
        player._critBoostTurns = ability.special.critBoostTurns || 2;
        sm = ` MALFUNCTION! Half damage to both (${dmg} self) - +${Math.round((ability.special.critBoost || 0.30)*100)}% crit for ${ability.special.critBoostTurns || 2} turns!`;
      } else {
        this.enemy.takeDamage(dmg);
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: dmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // UPDATE 30: Papyrus Belief — Bone Pummel (25% DEF-2)
    if (ability.special?.type === 'bonePummel') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.defDownChance || 0.25)) { this.enemy.defMod -= (ability.special.defDown || 2); sm = ` -${ability.special.defDown || 2} DEF`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // UPDATE 30: Papyrus Belief — Bonely Retribution (25% stun; else enemy next attack -20%)
    if (ability.special?.type === 'bonelyRetribution') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.stunChance || 0.25)) { const st = this.enemy.addStatus('stun'); if (st) sm = ' STUN'; else sm = ''; }
      else { this.enemy._perseveranceDmgReduce = Math.max(this.enemy._perseveranceDmgReduce || 0, ability.special.weakenPercent || 0.20); sm = ` enemy next attack -${Math.round((ability.special.weakenPercent || 0.20)*100)}%`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // UPDATE 30: Papyrus Belief — Gravitational Despair (Blue Soul 3t)
    if (ability.special?.type === 'gravitationalDespair') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      const su = this.enemy.addStatus('blueSoul'); if (su) { const bs = this.enemy.statusEffects.find(s => s.name === 'Blue Soul'); if (bs) bs.turnsLeft = ability.special.blueSoulDuration || 3; sm = ` Blue Soul ${ability.special.blueSoulDuration || 3}t`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // UPDATE 30: Papyrus Belief — ISN'T HE A BLAST? (Blindness 3t + enemy next attack double-cost)
    if (ability.special?.type === 'isntHeABlast') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      const br = this.enemy.addStatus('blindness'); if (br) { const b = this.enemy.statusEffects.find(s => s.name === 'Blindness'); if (b) b.turnsLeft = ability.special.blindDuration || 3; sm = ` Blindness ${ability.special.blindDuration || 3}t`; }
      this.enemy._doubleCostNext = true;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm} (next enemy attack costs double)`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // UPDATE 30: Toxin — Bone-Twister (DoT dealing its damage each turn for 3 turns)
    if (ability.special?.type === 'boneTwister') {
      const d = this.calculateDamage(player, ability, this.enemy);
      const existing = this.enemy.statusEffects.find(st => st.name === 'Bone-Twister');
      if (existing) { existing.damagePerTurn = d.totalDamage; existing.turnsLeft = ability.special.dotTurns || 3; }
      else this.enemy.statusEffects.push({ id: 'boneTwister', name: 'Bone-Twister', emoji: '\u{1F9B4}', damagePerTurn: d.totalDamage, turnsLeft: ability.special.dotTurns || 3 });
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! Enemy takes **${d.totalDamage}** damage each turn for ${ability.special.dotTurns || 3} turns!`, damage: 0 };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // UPDATE 30: Toxin — Lost'N'Found (6-outcome weapon roulette)
    if (ability.special?.type === 'lostNFound') {
      const roll = Math.floor(Math.random() * 6) + 1;
      let total = 0, sm = '', label = '';
      if (roll === 1) { label = "Outerdust's Trident"; const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total = d.totalDamage; this.enemy.atkMod -= 4; sm = ' Enemy -4 ATK!'; }
      else if (roll === 2) { label = "Fell's Brass Knuckle"; player.critBoost = 0.70; const d = this.calculateDamage(player, ability, this.enemy); player.critBoost = 0; total = d.totalDamage * 2; this.enemy.takeDamage(total); ability.cooldownLeft = 3; sm = ' 2x damage (70% crit)! Lost\'N\'Found on 2-turn cooldown.'; }
      else if (roll === 3) { label = "Sudden's Revolver'n'Rounds"; const hits = Math.floor(Math.random() * 5) + 3; for (let i = 0; i < hits; i++) { if (!this.enemy.isAlive) break; const d = this.calculateDamage(player, ability, this.enemy); const dmg = Math.max(1, Math.floor(d.totalDamage * 0.25)); this.enemy.takeDamage(dmg); total += dmg; } sm = ` ${hits} hits!`; if (hits === 7) { this.enemy.addStatus('burn'); sm += ' OVERHEAT (Burn)!'; } }
      else if (roll === 4) { label = "Horror's Thigh-Bone"; player.critBoost = 0.30; const d = this.calculateDamage(player, ability, this.enemy); player.critBoost = 0; this.enemy.takeDamage(d.totalDamage); total = d.totalDamage; this.enemy.addStatus('hemorrhage'); this.enemy.addStatus('bleed'); sm = ' Hemorrhage + Bleed!'; }
      else if (roll === 5) { label = "Reaper's Scythe"; const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total = d.totalDamage; this.enemy._deathTouchStacks = Math.min(5, (this.enemy._deathTouchStacks || 0) + 2); sm = ` Death's Touch +2 (now ${this.enemy._deathTouchStacks}/5)!`; }
      else { label = "Distrust's Magical Bone Butter Knife"; const d = this.calculateDamage(player, ability, this.enemy); let base = d.totalDamage; let combo = base + Math.floor(base * 0.25) * 2; if (this.enemy.hasStatus('Bone-Twister')) { combo *= 2; sm = ' 2x (Bone-Twister)!'; } this.enemy.takeDamage(combo); total = combo; sm = ' 3 hits!' + sm; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** grabs **${label}** ${emoji}! **${total}** damage!${sm}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // UPDATE 30: Toxin — DT Injection / Spare Reservations (switch out w/ random ally, return after N turns)
    if (ability.special?.type === 'dtInjection' || ability.special?.type === 'spareReservations') {
      const toxinIdx = this.activePlayerIndex;
      const candidates = this.playerTeam.map((f, i) => ({ f, i })).filter(({ f, i }) => i !== toxinIdx && f.isAlive);
      if (candidates.length === 0) { R.playerAction = { success: false, message: 'No living teammate to switch to!' }; ability.currentUses++; return R; }
      // Overstocked Shelves passive on switch-out
      if (player.passive?.type === 'overstockedShelves') { player.heal(player.passive.healOnSwitch || 15); const _lnf = player.abilities.find(a => a.special?.type === 'lostNFound'); if (_lnf) _lnf.currentUses = Math.min(_lnf.maxUses, _lnf.currentUses + (player.passive.lostNFoundRestore || 2)); }
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      let effMsg = '';
      if (ability.special.type === 'dtInjection') { pick.f.atkMod += (ability.special.atkBoost || 3); pick.f.defMod += (ability.special.defBoost || 1); effMsg = `permanent +${ability.special.atkBoost || 3} ATK / +${ability.special.defBoost || 1} DEF`; }
      else { const h = pick.f.heal(ability.special.heal || 45); effMsg = `healed **${h} HP**`; }
      this.activePlayerIndex = pick.i;
      this._toxinSwap = { returnTurns: ability.special.returnAfter || 3, toxinIndex: toxinIdx, justCast: true };
      R.playerAction = { success: true, message: `**${player.name}** used **${ability.name}**! Switched in **${pick.f.name}** (${effMsg}). Toxin returns in ${ability.special.returnAfter || 3} turns.`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // REWIND (FT!Sans) — heals last damage taken, only below 100% HP
    if (ability.special?.type === 'rewind') {
      if (player.currentHp >= player.maxHp) {
        R.playerAction = { success: false, message: `**Rewind** can only be used below 100% HP!`, damage: 0 };
        ability.currentUses++; return R;
      }
      const healAmt = player._lastDamageTaken || 0;
      const healed = player.heal(healAmt);
      R.playerAction = { success: true, message: `**${player.name}** used **Rewind.**! Time reverses — healed **${healed} HP**!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // MEMORIES (FT!Sans) — summons random Undertale boss
    if (ability.special?.type === 'memories') {
      const summons = [
        { key: 'flowey', name: 'Flowey', chance: 0.50, type: 'Unique', damageMin: 5, damageMax: 6, hits: 5, guaranteed: true, emoji: '🌻' },
        { key: 'mettaton', name: 'Mettaton NEO', chance: 0.075, type: 'Unique', damageMin: 20, damageMax: 35, hits: 1, electrifiedChance: 0.25, emoji: '🤖' },
        { key: 'toriel', name: 'Toriel', chance: 0.30, type: 'Fire', damageMin: 20, damageMax: 30, hits: 1, burnChance: 0.30, emoji: '🔥' },
        { key: 'asgore', name: 'Asgore', chance: 0.05, type: 'Fire', damageMin: 25, damageMax: 35, hits: 1, burnChance: 0.50, emoji: '🔱' },
        { key: 'papyrus', name: 'Papyrus', chance: 0.15, type: 'Bone', damageMin: 5, damageMax: 7, hitsMin: 2, hitsMax: 5, emoji: '🦴' },
        { key: 'sans', name: 'Sans', chance: 0.015, type: 'Bone', damageMin: 55, damageMax: 55, hits: 1, emoji: '💀' },
        { key: 'undyne', name: 'Undyne the Undying', chance: 0.10, type: 'Weapon', damageMin: 25, damageMax: 30, hits: 1, emoji: '🔱' },
      ];
      // Pick which summon fires
      let roll = Math.random(), chosen = null;
      for (const s of summons) { roll -= s.chance; if (roll <= 0) { chosen = s; break; } }
      if (!chosen) chosen = summons[0];
      // Check per-summon uses
      if (player._memoriesUses[chosen.key] <= 0) {
        R.playerAction = { success: false, message: `**${chosen.name}** has no more appearances left!`, damage: 0 };
        ability.currentUses++; return R;
      }
      player._memoriesUses[chosen.key]--;
      const hits = chosen.hits || Math.floor(Math.random() * ((chosen.hitsMax || 1) - (chosen.hitsMin || 1) + 1)) + (chosen.hitsMin || 1);
      let total = 0, sm = '';
      for (let i = 0; i < hits; i++) {
        const dmg = Math.floor(Math.random() * (chosen.damageMax - chosen.damageMin + 1)) + chosen.damageMin;
        const dr = this.enemy.takeDamage(dmg); total += dr.damage;
      }
      if (chosen.burnChance && Math.random() < chosen.burnChance) { this.enemy.addStatus('burn'); sm += ' **Burn!**'; }
      if (chosen.electrifiedChance && Math.random() < chosen.electrifiedChance) { this.enemy.addStatus('electrified'); sm += ' **Electrified!**'; }
      const usesLeft = player._memoriesUses[chosen.key];
      R.playerAction = { success: true, abilityType: chosen.type, message: `**${player.name}** used **Memories.**! ${chosen.emoji} **${chosen.name}** appears and attacks! **${total}** total damage! *(${chosen.name} uses left: ${usesLeft})*${sm}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // SUMMONING ASSISTANCE (Shanghaivania Ink Sans)
    if (ability.special?.type === 'summoningAssistance') {
      const useClassic = Math.random() < 0.5;
      let summonName, attackPool;
      if (useClassic) {
        summonName = 'Classic Sans';
        attackPool = [
          { name: 'Bone Throw', type: 'Bone', dmgMin: 12, dmgMax: 16, status: 'karma', statusDuration: 2, msg: 'throws a bone' },
          { name: 'Bone Zone', type: 'Bone', dmgMin: 12, dmgMax: 15, boneZone: true, msg: 'creates a Bone Zone' },
          { name: 'Gaster Blaster', type: 'Magic', dmgMin: 16, dmgMax: 22, status: 'poison', status2: 'karma', statusDuration: 2, msg: 'fires a Gaster Blaster' },
        ];
        player._summonedClassicLastResort = true;
      } else {
        summonName = 'Fell Sans';
        attackPool = [
          { name: 'Sharp Bones', type: 'Bone', dmgMin: 15, dmgMax: 18, bleedChance: 0.5, msg: 'fires sharp bones' },
          { name: 'Chain Grab', type: 'Unique', dmgMin: 15, dmgMax: 15, stunChance: 0.3, msg: 'grabs and slams' },
          { name: 'Gaster Slam', type: 'Magic', dmgMin: 20, dmgMax: 20, stunTurns: 2, poisonChance: 0.5, msg: 'slams a Gaster Blaster from the sky' },
        ];
      }
      const atk = attackPool[Math.floor(Math.random() * attackPool.length)];
      const dmg = Math.floor(Math.random() * (atk.dmgMax - atk.dmgMin + 1)) + atk.dmgMin;
      const dr = this.enemy.takeDamage(dmg);
      let sm = '';
      if (atk.status) { this.enemy.addStatus(atk.status); sm += ` **${atk.status.charAt(0).toUpperCase()+atk.status.slice(1)}!**`; }
      if (atk.status2) { this.enemy.addStatus(atk.status2); sm += ` **Karma!**`; }
      if (atk.boneZone) { if (!this.enemy.statusEffects.find(s => s.name === 'Bone Zone')) this.enemy.statusEffects.push({ name: 'Bone Zone', emoji: '🦴', damagePerTurn: 10, turnsLeft: 2 }); sm += ' **Bone Zone!**'; }
      if (atk.bleedChance && Math.random() < atk.bleedChance) { this.enemy.addStatus('bleed'); sm += ' **Bleed!**'; }
      if (atk.stunChance && Math.random() < atk.stunChance) { this.enemy.addStatus('stun'); sm += ' **Stunned!**'; }
      if (atk.poisonChance && Math.random() < atk.poisonChance) { this.enemy.addStatus('poison'); sm += ' **Poisoned!**'; }
      if (atk.stunTurns) { this.enemy.addStatus('stun'); sm += ` **Stunned!**`; }
      // Living Canvas: 10% chance to trigger ink trail on Magic
      if (atk.type === 'Magic' && player.passive?.type === 'livingCanvas' && Math.random() < player.passive.inkTrailChance) {
        player._inkTrailActive = true; player._inkTrailTurns = 3; sm += ' 🎨 **Ink Trail!**';
      }
      R.playerAction = { success: true, abilityType: atk.type, message: `**${player.name}** calls **${summonName}**! ${summonName} ${atk.msg} — **${dr.damage}** damage!${sm}`, damage: dr.damage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // VIAL VOLLEY (Shanghaivania Ink Sans) — 7 soul traits
    if (ability.special?.type === 'vialVolley') {
      const traits = ['Patience', 'Bravery', 'Integrity', 'Kindness', 'Perseverance', 'Justice', 'Determination'];
      const trait = traits[Math.floor(Math.random() * traits.length)];
      let total = 0, sm = '';
      const emoji = TYPES[ability.type]?.emoji || '';
      if (trait === 'Patience') {
        if (!this.enemy._patienceKnives) { this.enemy._patienceKnives = { damagePerTurn: 10, turnsLeft: 2, explodeDmg: 20 }; }
        sm = `🟣 **Patience**: Spinning Knives! 10 dmg/turn for 2 turns, then explodes for 20!`;
      } else if (trait === 'Bravery') {
        this.enemy._braveryTrap = true;
        sm = `🟠 **Bravery**: Trap set! If enemy uses a non-attacking move, takes **25 damage**!`;
      } else if (trait === 'Integrity') {
        const dmg = Math.floor(Math.random() * 4) + 14;
        const dr = this.enemy.takeDamage(dmg); total = dr.damage;
        sm = `🔵 **Integrity**: High-speed projectiles! **${total}** damage (guaranteed hit)!`;
      } else if (trait === 'Kindness') {
        const dmg = 15; const dr = this.enemy.takeDamage(dmg); total = dr.damage;
        player._shieldHp = (player._shieldHp || 0) + 25;
        sm = `🟢 **Kindness**: **${total}** damage + gained **25 Shield HP**! (Total shield: ${player._shieldHp})`;
      } else if (trait === 'Perseverance') {
        this.enemy.addStatus('silence'); sm = `🟤 **Perseverance**: **Silence** applied! Enemy can't use Unique moves for 2 turns!`;
      } else if (trait === 'Justice') {
        let jTotal = 0;
        for (let i = 0; i < 6; i++) { const dmg = Math.floor(Math.random() * 3) + 5; const dr = this.enemy.takeDamage(dmg); jTotal += dr.damage; }
        player._justiceReload = true;
        sm = `🟡 **Justice**: Pistol Volley! 6 hits for **${jTotal}** total damage! **Reload** — skip next turn!`;
        total = jTotal;
      } else if (trait === 'Determination') {
        player.atkMod += 2; player.defMod += 2; player._determinationStage = (player._determinationStage || 0) + 1;
        if (!player._determinationTurns) player._determinationTurns = 3;
        sm = `🔴 **Determination**: +2 ATK, +2 DEF for 3 turns! (Stage ${player._determinationStage})`;
      }
      R.playerAction = { success: true, abilityType: 'Unique', message: `**${player.name}** used **Vial Volley** ${emoji}! ${sm}`, damage: total };
      if (total > 0 && !this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // LAST RESORT (Shanghaivania Ink Sans)
    if (ability.special?.type === 'lastResort') {
      if (!player._summonedClassicLastResort) {
        R.playerAction = { success: false, message: `**Last Resort** requires Summoning Assistance to have summoned **Classic Sans** first!`, damage: 0 };
        ability.currentUses++; return R;
      }
      if (player.turnCount < 5) {
        R.playerAction = { success: false, message: `**Last Resort** can only be used after **turn 5**!`, damage: 0 };
        ability.currentUses++; return R;
      }
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      const statuses = ['poison', 'bleed', 'blindness', 'stun'];
      const picked = statuses[Math.floor(Math.random() * statuses.length)];
      this.enemy.addStatus(picked);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **Last Resort** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} Applied **${picked.charAt(0).toUpperCase()+picked.slice(1)}**!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // NEW HOST (True Fresh!Sans)
    if (ability.special?.type === 'newHost') {
      const hpPct = this.enemy.currentHp / this.enemy.maxHp;
      if (hpPct > ability.special.hpThreshold) {
        R.playerAction = { success: false, message: `**NEW HOST** can only be used when the enemy is at **15% HP or below**!`, damage: 0 };
        ability.currentUses++; return R;
      }
      if (this.enemy.isBoss) {
        // PvE: instant kill boss
        this.enemy.currentHp = 0;
        R.playerAction = { success: true, message: `🦠 **${player.name}** used **NEW HOST**! The parasite leaps to the boss — **instant kill!**`, damage: this.enemy.maxHp };
        R.battleEnd = this.checkBattleEnd(); return R;
      }
      // PvE non-boss: instant kill
      this.enemy.currentHp = 0;
      R.playerAction = { success: true, message: `🦠 **${player.name}** used **NEW HOST**! The parasite moves on — **${this.enemy.name}** is finished!`, damage: this.enemy.maxHp };
      R.battleEnd = this.checkBattleEnd(); return R;
    }

    // JUDGMENT FLASH (Asgore boss) — guaranteed hit, 1.2x if enemy healed last turn
    if (ability.special?.type === 'judgmentFlash') {
      let dmg = Math.floor(Math.random() * (ability.damageMax - ability.damageMin + 1)) + ability.damageMin;
      if (this.player?._healedLastTurn) dmg = Math.floor(dmg * 1.2);
      const dr = this.enemy.takeDamage(dmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${dr.damage}** damage! *(Guaranteed hit${this.player?._healedLastTurn ? ', 1.2x — you healed last turn!' : ''})*`, damage: dr.damage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // TRIDENT SLASHES (Asgore boss) — 20% DEF reduce
    if (ability.special?.type === 'tridentSlashes') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.defReduceChance) { this.enemy.defMod -= ability.special.defReduceAmount; sm = ` Enemy DEF **-${ability.special.defReduceAmount}**!`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // CHARGE UP (Asgore Fire Walls) — skip turn then release unblockable blast
    if (ability.special?.type === 'chargeUp' && !player._asgoreCharging) {
      player._asgoreCharging = true;
      player._asgoreChargedDmg = Math.floor(Math.random() * (ability.damageMax - ability.damageMin + 1)) + ability.damageMin;
      ability.currentUses++;
      R.playerAction = { success: true, message: `⚠️ ${ability.special.chargeMessage}`, damage: 0, charging: true };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    if (ability.special?.type === 'chargeUp' && player._asgoreCharging) {
      player._asgoreCharging = false;
      const dr = this.enemy.takeDamage(player._asgoreChargedDmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `🔥 **${player.name}** releases **Fire Walls**! **${dr.damage}** unblockable damage!`, damage: dr.damage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ============================================================
    // === UPDATE 12 ABILITY SPECIALS ===
    // ============================================================

    // FADED BLASTER (C!Insanity Weak) — 30% chance reduce enemy next move dmg by 20%
    if (ability.special?.type === 'fadedBlaster') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.chance) {
        this.enemy._fadedBlasterReduction = ability.special.reduction;
        sm = ` Enemy's next attack damage reduced by **${Math.round(ability.special.reduction * 100)}%**!`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage, isCrit: d.isCrit };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // SHATTERED BONEWALL (C!Insanity Weak) — 30% chance to set counter, applies bleed
    if (ability.special?.type === 'shatteredBoneWall') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.counterChance) {
        this.enemy._boneWallCounter = ability.special.counterDamage;
        sm = ` 🦴 **Bone Wall** primed! +${ability.special.counterDamage} damage if enemy attacks next turn!`;
      }
      const sr = this.enemy.addStatus('bleed'); if (sr) sm += ` **Bleed** applied!`;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage, isCrit: d.isCrit };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // FRACTURED CLEAVE (C!Insanity Weak) — guaranteed bleed + 10% perma -2 enemy DEF
    if (ability.special?.type === 'fracturedCleave') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      const sr = this.enemy.addStatus('bleed'); if (sr) sm = ` **Bleed** applied!`;
      if (Math.random() < ability.special.defReduceChance) {
        this.enemy.defMod -= ability.special.defReduceAmount;
        sm += ` Enemy DEF permanently lowered by **${ability.special.defReduceAmount}**!`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage, isCrit: d.isCrit };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // WEAKENED CHUNG (C!Insanity Weak) — charge then release with karma
    if (ability.special?.type === 'weakenedChung' && !player.isReleasing) {
      if (!player.isCharging) {
        player.isCharging = true; player.chargedAbility = abilityIndex;
        player._weakenedChungCharging = true;
        R.playerAction = { success: true, message: `**${player.name}** clutches their head, channeling memories of **Chung**...`, damage: 0, charging: true };
        ability.currentUses++;
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
    }
    if (ability.special?.type === 'weakenedChung' && player.isReleasing) {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      const sr = this.enemy.addStatus('karma'); let sm = sr ? ` **Karma** applied!` : '';
      player._weakenedChungCharging = false;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** unleashes the violent outburst! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage, isCrit: d.isCrit };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // THOUSAND AXE SLASHES (C!Insanity) — multi-hit with all-hits-bonus
    // ===================== UPDATE 31 ABILITY HANDLERS =====================
    // --- helpers used by the U31 handlers ---
    const _u31crit = (f, fn) => { const b = f.critBoost || 0; f.critBoost = 1; try { return fn(); } finally { f.critBoost = b; } };
    const _u31hits = (n) => Math.max(1, n * ((player._rebarDoubleHits > 0) ? 2 : 1));
    const _u31end = (R2) => { if (!this.enemy.isAlive) { R2.battleEnd = this.checkBattleEnd(); return R2; } R2.enemyAction = this.executeEnemyTurn(); this.endTurn(R2, player); return R2; };

    // ===================== UPDATE 32: MAD MEW MEW =====================
    // Doki helpers — _u32doki() spends a full meter and returns true if this move hits twice.
    const _u32dokiMax = (player.passive?.threshold || 5);
    const _u32doubling = () => (player.passive?.type === 'dokiMeter' && hasPassiveUnlocked(player.level) && (player._doki || 0) >= _u32dokiMax);
    const _u32spend = () => { player._doki = 0; };
    const _u32dokiTag = () => (player.passive?.type === 'dokiMeter' ? ` 🩷 Doki: **${player._doki || 0}/${_u32dokiMax}**` : '');

    // PURPLE PURR-FECTION — always resolves LAST: the enemy moves first, then we cut their uses.
    if (ability.special?.type === 'purplePurrfection') {
      const sp = ability.special;
      this.enemy._usedAbilityThisTurn = false;
      R.enemyAction = this.executeEnemyTurn();
      let sm;
      if (!this.enemy._usedAbilityThisTurn || this.enemy._lastUsedMove == null) {
        sm = ` **${this.enemy.name}** skipped — the move **failed**!`;
      } else {
        const used = this.enemy.abilities[this.enemy._lastUsedMove];
        if (!used) sm = ' ...but there was nothing to drain!';
        else {
          const cut = Math.min(sp.useReduction || 3, used.currentUses);
          used.currentUses = Math.max(0, used.currentUses - (sp.useReduction || 3));
          sm = ` 🍵 **${used.name}** loses **${cut}** use${cut === 1 ? '' : 's'}! (${used.currentUses} left)`;
        }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}!${sm}${_u32dokiTag()}`, damage: 0 };
      if (!player.isAlive || !this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      this.endTurn(R, player); return R;
    }

    // CAT-NADO — 20% chance to heal the enemy, but grants +1 Doki
    if (ability.special?.type === 'catNado') {
      const sp = ability.special;
      const twice = _u32doubling();
      let total = 0, crit = false;
      const swings = twice ? 2 : 1;
      for (let i = 0; i < swings; i++) {
        const d = this.calculateDamage(player, ability, this.enemy);
        this.enemy.takeDamage(d.totalDamage); total += d.totalDamage; if (d.isCrit) crit = true;
        if (!this.enemy.isAlive) break;
      }
      let sm = '';
      if (Math.random() < (sp.healChance || 0.20)) {
        const amt = Math.floor(Math.random() * ((sp.healMax || 15) - (sp.healMin || 5) + 1)) + (sp.healMin || 5);
        const healed = this.enemy.heal(amt);
        player._doki = (player._doki || 0) + (sp.dokiGain || 1);
        sm = ` 💚 A heart slipped through — **${this.enemy.name}** healed **${healed} HP**, but Mew Mew gains **+1 Doki**!`;
      }
      if (twice) _u32spend();
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}!${twice ? ' 🩷 **5 DOKI — DOUBLE STRIKE!**' : ''} **${total}** damage!${crit ? ' **CRIT!**' : ''}${sm}${_u32dokiTag()}`, damage: total, isCrit: crit };
      return _u31end(R);
    }

    // POCKET BOMBS — 1-3 repeats; all 3 gives a 50% shot at +30 fixed damage
    if (ability.special?.type === 'pocketBombs') {
      const sp = ability.special;
      const twice = _u32doubling();
      const swings = twice ? 2 : 1;
      let total = 0, sm = '', allHits = 0;
      for (let sw = 0; sw < swings; sw++) {
        const rolled = _u31hits(Math.floor(Math.random() * ((sp.maxHits || 3) - (sp.minHits || 1) + 1)) + (sp.minHits || 1));
        let landed = 0;
        for (let i = 0; i < rolled; i++) {
          const d = this.calculateDamage(player, ability, this.enemy);
          this.enemy.takeDamage(d.totalDamage); total += d.totalDamage; landed++;
          if (!this.enemy.isAlive) break;
        }
        allHits += landed;
        // The bonus is gated on the REPEAT COUNT ROLLED, not on the target surviving.
        // (Gating on isAlive made the +30 silently vanish on kills.)
        if (rolled >= (sp.maxHits || 3) && Math.random() < (sp.bonusChance || 0.50)) {
          const bonus = sp.bonusDamage || 30;
          this.enemy.takeDamage(bonus); total += bonus;
          sm += ` 💥 **A gigantic one!** +**${bonus}** fixed damage!`;
        }
        if (!this.enemy.isAlive) break;
      }
      if (twice) _u32spend();
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}!${twice ? ' 🩷 **5 DOKI — DOUBLE STRIKE!**' : ''} Hit **${allHits}** times for **${total}** damage!${sm}${_u32dokiTag()}`, damage: total };
      return _u31end(R);
    }

    // SUPERB KARAOKE — needs 3+ Doki. 3 turns of passive lockout, +1 ATK/+1 DEF, heal absorption.
    if (ability.special?.type === 'superbKaraoke') {
      const sp = ability.special;
      if ((player._doki || 0) < (sp.dokiRequired || 3)) {
        ability.currentUses++; ability.cooldownLeft = 0;
        player._usedAbilityThisTurn = false; player._attackedThisTurn = false;
        this.turnNumber--; player.turnCount--;
        R.playerAction = { success: false, message: `🎤 **${ability.name}** needs at least **${sp.dokiRequired || 3} Doki**! (You have **${player._doki || 0}**)` };
        return R;
      }
      const twice = _u32doubling();
      let total = 0, crit = false;
      const swings = twice ? 2 : 1;
      for (let i = 0; i < swings; i++) {
        const d = this.calculateDamage(player, ability, this.enemy);
        this.enemy.takeDamage(d.totalDamage); total += d.totalDamage; if (d.isCrit) crit = true;
        if (!this.enemy.isAlive) break;
      }
      const dur = sp.duration || 3;
      // Disable the enemy's passive for the window by stashing it outright.
      if (this.enemy._karaokePassiveStash === undefined) this.enemy._karaokePassiveStash = this.enemy.passive;
      this.enemy.passive = null;
      this.enemy._passiveDisabledTurns = dur;
      this.enemy._karaokeAbsorbTurns = dur;
      this.enemy._karaokeAbsorber = player;
      player.atkMod += (sp.atkGain || 1);
      player.defMod += (sp.defGain || 1);
      if (twice) _u32spend();
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}!${twice ? ' 🩷 **5 DOKI — DOUBLE STRIKE!**' : ''} **${total}** damage!${crit ? ' **CRIT!**' : ''} 🎤 For **${dur}** turns: **${this.enemy.name}**'s passive is **disabled**, Mew Mew gains **+${sp.atkGain || 1} ATK / +${sp.defGain || 1} DEF**, and any healing they do is **absorbed**!${_u32dokiTag()}`, damage: total, isCrit: crit };
      return _u31end(R);
    }

    // ---------- KARMA!SANS ----------
    if (ability.special?.type === 'karmicBones') {
      const sp = ability.special;
      const rush = Math.random() < (sp.rushChance || 0.20);
      const hits = Math.floor(Math.random() * ((sp.maxHits || 6) - (sp.minHits || 3) + 1)) + (sp.minHits || 3);
      let total = 0;
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(player, ability, this.enemy);
        const dmg = rush ? Math.floor(d.totalDamage * (sp.rushMult || 1.3)) : d.totalDamage;
        this.enemy.takeDamage(dmg); total += dmg;
        if (!this.enemy.isAlive) break;
      }
      let sm = rush ? ` 💢 **DETERMINATION RUSH!** (${sp.rushMult || 1.3}x)` : '';
      if (player._applyStatusFor(this.enemy, 'scaryKR', sp.krDuration || 2)) sm += ` ☯️ **Scary KR** (${sp.krDuration || 2} turns)!`;
      if (Math.random() < (sp.bleedChance || 0.40) && player._applyStatusFor(this.enemy, 'bleed', sp.bleedDuration || 2)) sm += ` 🔴 **Bleed!**`;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! Hit **${hits}** times for **${total}** damage!${sm}`, damage: total };
      return _u31end(R);
    }
    if (ability.special?.type === 'desperationBlasters') {
      const sp = ability.special;
      const rush = Math.random() < (sp.rushChance || 0.20);
      const d = this.calculateDamage(player, ability, this.enemy);
      const dmg = rush ? Math.floor(d.totalDamage * (sp.rushMult || 1.4)) : d.totalDamage;
      this.enemy.takeDamage(dmg);
      let sm = rush ? ` 💢 **DETERMINATION RUSH!** (${sp.rushMult || 1.4}x)` : '';
      if (player._applyStatusFor(this.enemy, 'scaryKR', sp.krDuration || 3)) sm += ` ☯️ **Scary KR** (${sp.krDuration || 3} turns)!`;
      if (Math.random() < (sp.statusChance || 0.30)) {
        if (player._applyStatusFor(this.enemy, 'karma', sp.statusDuration || 2)) sm += ` ☯️ **Karma!**`;
        if (player._applyStatusFor(this.enemy, 'poison', sp.statusDuration || 2)) sm += ` 🟢 **Poison!**`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: dmg, isCrit: d.isCrit };
      return _u31end(R);
    }
    if (ability.special?.type === 'goodKarma') {
      const sp = ability.special;
      const amt = Math.floor(Math.random() * ((sp.healMax || 35) - (sp.healMin || 10) + 1)) + (sp.healMin || 10);
      const healed = player.heal(amt);
      let sm = `Healed **${healed} HP**!`;
      if ((player.currentHp / player.maxHp) < (sp.lowHpThreshold || 0.20) && Math.random() < (sp.krChance || 0.50)) {
        if (player._applyStatusFor(this.enemy, 'scaryKR', sp.krDuration || 4)) sm += ` ☯️ **Scary KR** applied for ${sp.krDuration || 4} turns!`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! ${sm}`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    if (ability.special?.type === 'absoluteRetribution') {
      const sp = ability.special;
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (player._applyStatusFor(this.enemy, 'scaryKR', sp.duration || 3)) sm += ` ☯️ **Scary KR!**`;
      if (player._applyStatusFor(this.enemy, 'karma', sp.duration || 3)) sm += ` ☯️ **Karma!**`;
      if (player._applyStatusFor(this.enemy, 'poison', sp.duration || 3)) sm += ` 🟢 **Poison!**`;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage, isCrit: d.isCrit };
      return _u31end(R);
    }

    // ---------- REBAR!INSANITY (base moveset) ----------
    if (ability.special?.type === 'rebarTopStrike') {
      const n = _u31hits(1); let total = 0;
      for (let i = 0; i < n; i++) { const d = _u31crit(player, () => this.calculateDamage(player, ability, this.enemy)); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage; if (!this.enemy.isAlive) break; }
      player._rebarBlockDoubleTurns = 2;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! A heavy overhead swing — **${total}** damage! **GUARANTEED CRIT!** 🔩 Block chance doubled!`, damage: total, isCrit: true };
      return _u31end(R);
    }
    if (ability.special?.type === 'rebarSweep') {
      const n = _u31hits(1); let total = 0, sm = '';
      for (let i = 0; i < n; i++) { const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage; if (!this.enemy.isAlive) break; }
      if (Math.random() < (ability.special.stunChance || 0.25) && this.enemy.addStatus('stun')) sm = ' 💫 **Stunned!**';
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${total}** damage!${sm}`, damage: total };
      return _u31end(R);
    }
    if (ability.special?.type === 'rebarStance') {
      const sp = ability.special;
      if (player._rebarStanceTurns > 0) { R.playerAction = { success: false, message: 'Already in a changed stance!' }; return R; }
      player.defMod += (sp.defUp || 3); player._rebarStanceDef = (sp.defUp || 3);
      player.atkMod -= (sp.atkDown || 6); player._rebarStanceAtk = (sp.atkDown || 6);
      player._rebarStanceBlockDouble = 1; player._rebarStanceTurns = (sp.duration || 5);
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** shifts into a **defensive stance**! 🛡️ **+${sp.defUp || 3} DEF**, block chance doubled, **-${sp.atkDown || 6} ATK** for ${sp.duration || 5} turns!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    if (ability.special?.type === 'rebarImpale' && !player.isReleasing) {
      if (!player.isCharging) {
        player.isCharging = true; player.chargedAbility = abilityIndex; ability.currentUses++;
        R.playerAction = { success: true, message: `**${player.name}** takes aim with the rebar...`, damage: 0, charging: true };
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
    }
    if (ability.special?.type === 'rebarImpale' && player.isReleasing) {
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (player._applyStatusFor(this.enemy, 'bleed', ability.special.bleedDuration || 6)) sm = ` 🔴 **Bleed for ${ability.special.bleedDuration || 6} turns!**`;
      player._swapMoveset(true);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** hurls the rebar clean through **${this.enemy.name}** for **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm} 🔩 *Impale moveset active — the rebar is no longer in hand.*`, damage: d.totalDamage, isCrit: d.isCrit };
      return _u31end(R);
    }

    // ---------- REBAR!INSANITY (Impale moveset) ----------
    if (ability.special?.type === 'rebarTopStrikeImpale') {
      const n = _u31hits(1); let total = 0, sm = '';
      for (let i = 0; i < n; i++) { const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage; if (!this.enemy.isAlive) break; }
      if (Math.random() < (ability.special.stunChance || 0.20) && this.enemy.addStatus('stun')) sm = ' 💫 **Stunned!**';
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** leaps forward with a **dropkick** ${emoji}! **${total}** damage!${sm}`, damage: total };
      return _u31end(R);
    }
    if (ability.special?.type === 'rebarSweepImpale') {
      const n = _u31hits(ability.special.hits || 2); let total = 0, stuns = 0;
      for (let i = 0; i < n; i++) {
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
        if (Math.random() < (ability.special.stunChance || 0.20) && this.enemy.addStatus('stun')) stuns++;
        if (!this.enemy.isAlive) break;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** sweeps their legs and knees them ${emoji}! Hit **${n}** times for **${total}** damage!${stuns ? ' 💫 **Stunned!**' : ''}`, damage: total };
      return _u31end(R);
    }
    if (ability.special?.type === 'rebarStanceImpale') {
      const sp = ability.special;
      if (player._rebarStanceTurns > 0) { R.playerAction = { success: false, message: 'Already in a changed stance!' }; return R; }
      player.atkMod -= (sp.atkDown || 10); player._rebarStanceAtk = (sp.atkDown || 10);
      player.defMod -= (sp.defDown || 10); player._rebarStanceDef = -(sp.defDown || 10);
      player._rebarDoubleHits = 1; player._rebarStanceTurns = (sp.duration || 5);
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** drops into a **faster stance**! ⚡ **-${sp.atkDown || 10} ATK**, **-${sp.defDown || 10} DEF**, but every attack hits **twice as many times** for ${sp.duration || 5} turns!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    if (ability.special?.type === 'rebarRetrieve' && !player.isReleasing) {
      if (!player.isCharging) {
        player.isCharging = true; player.chargedAbility = abilityIndex; ability.currentUses++;
        player._rebarChargeBlock = (ability.special.chargeBlockChance || 0.60);
        R.playerAction = { success: true, message: `**${player.name}** carefully moves in to retrieve the rebar... 🛡️ *(60% block chance while charging)*`, damage: 0, charging: true };
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
    }
    if (ability.special?.type === 'rebarRetrieve' && player.isReleasing) {
      player._rebarChargeBlock = 0;
      player._swapMoveset(false);
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** rips the rebar back out and grips it tight! 🔩 *Base moveset restored.*`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ---------- !REBAR! (base moveset) ----------
    if (ability.special?.type === 'steelBash') {
      const n = _u31hits(1); let total = 0;
      for (let i = 0; i < n; i++) { const d = _u31crit(player, () => this.calculateDamage(player, ability, this.enemy)); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage; if (!this.enemy.isAlive) break; }
      let sm = '';
      if (player._applyStatusFor(this.enemy, 'bleed', ability.special.bleedDuration || 2)) sm = ' 🔴 **Bleed!**';
      player._rebarBlockDoubleTurns = 2;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${total}** damage! **GUARANTEED CRIT!**${sm} 🔩 Block chance doubled!`, damage: total, isCrit: true };
      return _u31end(R);
    }
    if (ability.special?.type === 'gruesomeCombat') {
      const n = _u31hits(1); let total = 0;
      for (let i = 0; i < n; i++) {
        const d = _u31crit(player, () => this.calculateDamage(player, ability, this.enemy));
        const trueDmg = Math.floor(Math.random() * (ability.damageMax - ability.damageMin + 1)) + ability.damageMin;
        this.enemy.takeDamage(d.totalDamage);
        this.enemy.currentHp = Math.max(0, this.enemy.currentHp - trueDmg);
        total += d.totalDamage + trueDmg;
        if (!this.enemy.isAlive) break;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** spins on their planted arm and kicks with everything ${emoji}! **${total}** damage — **unavoidable critical hit!**`, damage: total, isCrit: true };
      return _u31end(R);
    }
    if (ability.special?.type === 'bloodthirst') {
      const sp = ability.special;
      if (player._bloodthirstActive) { R.playerAction = { success: false, message: '**BLOODTHIRST** is already active!' }; return R; }
      player._bloodthirstActive = true;
      player.atkMod += (sp.atkUp || 15); player._bloodthirstAtk = (sp.atkUp || 15);
      player.defMod -= (sp.defDown || 15); player._bloodthirstDef = (sp.defDown || 15);
      player._bloodthirstEndHeal = (sp.endHeal || 75); player._bloodthirstEndAtk = (sp.endAtk || 3);
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}**: *"THE BEST DEFENSE IS OFFENSE"* 🩸 **+${sp.atkUp || 15} ATK**, **-${sp.defDown || 15} DEF**, all block chance and damage reduction gone until the opponent falls!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    if (ability.special?.type === 'rebarGrab') {
      const sp = ability.special;
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      player._grabActive = true;
      player._grabHitsRemaining = (sp.hitsToBreak || 6);
      player._grabDot = (sp.dotDamage || 5);
      player._grabBreakCooldown = (sp.breakCooldown || 5);
      this.enemy._grabDmgReduction = (sp.dmgReduction || 0.20);
      player._swapMoveset(true);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** stabs their arm clean through **${this.enemy.name}** and **GRABS** them ${emoji}! **${d.totalDamage}** damage! They deal **20% less damage**, take **${sp.dotDamage || 5}/turn**, and must land **${sp.hitsToBreak || 6}** hits to break free!`, damage: d.totalDamage, isCrit: d.isCrit };
      return _u31end(R);
    }

    // ---------- !REBAR! (Grab moveset) ----------
    if (ability.special?.type === 'steelBashGrab') {
      const n = _u31hits(1); let total = 0;
      for (let i = 0; i < n; i++) { const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage; if (!this.enemy.isAlive) break; }
      let sm = '';
      if (Math.random() < (ability.special.chance || 0.30)) { player._grabHitsRemaining = (player._grabHitsRemaining || 0) + 1; sm = ` 🔩 The grab tightens — **${player._grabHitsRemaining}** hits now needed to break free!`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** cracks them with a **left hook** ${emoji}! **${total}** damage!${sm}`, damage: total };
      return _u31end(R);
    }
    if (ability.special?.type === 'gruesomeCombatGrab') {
      const n = _u31hits(ability.special.hits || 3); let total = 0;
      for (let i = 0; i < n; i++) { const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage; if (!this.enemy.isAlive) break; }
      player._grabActive = false; this.enemy._grabDmgReduction = 0; player._swapMoveset(false);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** drags them across the floor over **${n}** hits for **${total}** damage ${emoji}! 🔩 *The grab is released.*`, damage: total };
      return _u31end(R);
    }
    if (ability.special?.type === 'bloodthirstGrab') {
      const sp = ability.special;
      const fixed = (sp.fixedDamage || 35);
      this.enemy.currentHp = Math.max(0, this.enemy.currentHp - fixed);
      const healed = player.heal(sp.heal || 35);
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** bites down and drinks deep 🩸 **${fixed}** fixed damage, healed **${healed} HP**!`, damage: fixed };
      return _u31end(R);
    }
    if (ability.special?.type === 'rebarGrabThrow') {
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (this.enemy.addStatus('hemorrhage')) sm += ' 🩸 **Hemorrhage!**';
      if (this.enemy.addStatus('stun')) sm += ' 💫 **Stunned for 1 turn!**';
      player._grabActive = false; this.enemy._grabDmgReduction = 0; player._swapMoveset(false);
      const _g = player.abilities.find(a => a.special?.type === 'rebarGrab');
      if (_g) _g.cooldownLeft = (player._grabBreakCooldown || 5) + 1;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** rips them off the rebar arm and slams them into the floor ${emoji}! **${d.totalDamage}** damage!${sm}`, damage: d.totalDamage, isCrit: d.isCrit };
      return _u31end(R);
    }

    // ---------- UNNAMED KINDNESS ----------
    if (ability.special?.type === 'rustyPan') {
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.stunChance || 0.20) && this.enemy.addStatus('stun')) sm = ' 💫 **Stunned!**';
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** swings the **Rusty Pan** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage, isCrit: d.isCrit };
      return _u31end(R);
    }
    if (ability.special?.type === 'emberToss') {
      const sp = ability.special;
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (sp.hellfireChance || 0.40)) { if (this.enemy.addStatus('hellfire')) sm = ' 🔥 **HELLFIRE!**'; }
      else if (player._applyStatusFor(this.enemy, 'burn', sp.burnDuration || 3)) sm = ` 🟠 **Burn for ${sp.burnDuration || 3} turns!**`;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** tosses an ember ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage, isCrit: d.isCrit };
      return _u31end(R);
    }
    if (ability.special?.type === 'kindnessBlock') {
      const sp = ability.special;
      player._kindnessBlockPct = (sp.blockPercent || 0.80);
      player._kindnessBlockReflect = Math.random() < (sp.reflectChance || 0.50);
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** braces to **Block**! 🛡️ The next hit is reduced by **80%**${player._kindnessBlockReflect ? ' — and half of it will be **reflected** with a **stun**!' : '.'}`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    if (ability.special?.type === 'retensiveHealing') {
      const sp = ability.special;
      if (this.turnNumber < (sp.minTurn || 20)) { R.playerAction = { success: false, message: `**${ability.name}** can only be used after turn **${sp.minTurn || 20}**! (currently turn ${this.turnNumber})` }; return R; }
      if (this._retensiveHeal > 0) { R.playerAction = { success: false, message: '**Retensive Healing** is already active!' }; return R; }
      this._retensiveHeal = (sp.healPerTurn || 5);
      ability.currentUses = 0;
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** channels **Retensive Healing**! ✨ Whoever is active heals **${sp.healPerTurn || 5} HP** every turn for the rest of the battle.`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ---------- PAPYRUS/? ----------
    if (ability.special?.type === 'papQBoneBarrage') {
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      const st = player._applyGoop(this.enemy, ability.special.goop || 1, player.id);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} 🫠 **Goop** applied! (**${st}** stacks)`, damage: d.totalDamage, isCrit: d.isCrit };
      return _u31end(R);
    }
    if (ability.special?.type === 'papQBlueBones') {
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      this.enemy._papQBlueBoneTrap = (ability.special.goop || 1);
      this.enemy._papQBlueBoneSource = player.id;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** raises **Blue Bones** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} 🔵 If **${this.enemy.name}** attacks, they'll be covered in **Goop**!`, damage: d.totalDamage, isCrit: d.isCrit };
      return _u31end(R);
    }
    if (ability.special?.type === 'papQBlueSoul' && !player.isReleasing) {
      if (!player.isCharging) {
        player.isCharging = true; player.chargedAbility = abilityIndex; ability.currentUses++;
        R.playerAction = { success: true, message: `**${player.name}**'s eye flickers blue...`, damage: 0, charging: true };
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
    }
    if (ability.special?.type === 'papQBlueSoul' && player.isReleasing) {
      const sp = ability.special;
      this.enemy.defMod -= (sp.defDown || 2);
      let sm = `Enemy **-${sp.defDown || 2} DEF**!`;
      if (Math.random() < (sp.goopChance || 0.55)) { const st = player._applyGoop(this.enemy, sp.goop || 3, player.id); sm += ` 🫠 **${sp.goop || 3} Goop** stacks applied! (**${st}** total)`; }
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** seizes their **SOUL**! ${sm}`, damage: 0 };
      return _u31end(R);
    }
    if (ability.special?.type === 'papQSpecialAttack') {
      const sp = ability.special;
      if (Math.random() < (sp.failChance || 0.45)) {
        player.defMod -= (sp.selfDefDown || 2);
        R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}**'s **Special Attack** falls apart! **-${sp.selfDefDown || 2} DEF**...`, damage: 0 };
        return _u31end(R);
      }
      let total = 0, st = 0;
      const hits = _u31hits(sp.hits || 2);
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
        st = player._applyGoop(this.enemy, sp.goopPerHit || 2, player.id);
        if (!this.enemy.isAlive) break;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** lands the **Special Attack** ${emoji}! Hit **${hits}** times for **${total}** damage! 🫠 **Goop** — **${st}** stacks!`, damage: total };
      return _u31end(R);
    }

    // ---------- SIXBONES ----------
    if (ability.special?.type === 'sixBoneThrow') {
      const sp = ability.special;
      const stacks = player._goopStacks(this.enemy);
      if (stacks <= 0) {
        R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** throws bones... but there's no **Goop** to guide them. Nothing happens.`, damage: 0 };
        return _u31end(R);
      }
      let total = 0;
      for (let i = 0; i < stacks; i++) { const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage; if (!this.enemy.isAlive) break; }
      let sm = '';
      const defDrops = Math.floor(stacks / (sp.hitsPer || 6)) * (sp.defDown || 1);
      if (defDrops > 0) { this.enemy.defMod -= defDrops; sm = ` Enemy **-${defDrops} DEF** until S̷I̸X̶B̷O̶N̵E̸S̷ dies!`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! Hit **${stacks}** times (one per Goop stack) for **${total}** damage!${sm}`, damage: total };
      return _u31end(R);
    }
    if (ability.special?.type === 'sixBlaster') {
      const sp = ability.special;
      const roll = Math.random();
      if (roll < (sp.wildChance || 0.06)) {
        let total = 0, st = 0;
        for (let i = 0; i < 6; i++) { const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage; st = player._applyGoop(this.enemy, 1, player.id); if (!this.enemy.isAlive) break; }
        this.enemy.addStatus('stun'); player.addStatus('stun');
        R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}**'s blaster does **?̷?̸?̶** — **6** hits for **${total}** damage! 🫠 **${st}** Goop stacks! 💫 **BOTH fighters are stunned!**`, damage: total };
        return _u31end(R);
      }
      if (roll < (sp.wildChance || 0.06) + (sp.hitChance || 0.46)) {
        const hits = _u31hits(Math.random() < 0.5 ? 2 : 3);
        let total = 0, st = 0;
        for (let i = 0; i < hits; i++) { const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage; st = player._applyGoop(this.enemy, 1, player.id); if (!this.enemy.isAlive) break; }
        const emoji = TYPES[ability.type]?.emoji || '';
        R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}**'s blaster fires ${emoji}! **${hits}** hits for **${total}** damage! 🫠 **${st}** Goop stacks!`, damage: total };
        return _u31end(R);
      }
      player.addStatus('stun');
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}**'s blaster **fails** and backfires! 💫 **S̷I̸X̶B̷O̶N̵E̸S̷ is stunned for 1 turn!**`, damage: 0 };
      return _u31end(R);
    }
    if (ability.special?.type === 'sixHelpUs' && !player.isReleasing) {
      if (!player.isCharging) {
        player._sixChargeTurns = (player._sixChargeTurns || 0) + 1;
        if (player._sixChargeTurns < (ability.special.chargeTurns || 2)) {
          ability.currentUses++;
          R.playerAction = { success: true, message: `**${player.name}** is gathering them all... *(${player._sixChargeTurns}/${ability.special.chargeTurns || 2})*`, damage: 0, charging: true };
          R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
        }
        player.isCharging = true; player.chargedAbility = abilityIndex; ability.currentUses++;
        R.playerAction = { success: true, message: `**${player.name}** is gathering them all... *(${player._sixChargeTurns}/${ability.special.chargeTurns || 2})*`, damage: 0, charging: true };
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
    }
    if (ability.special?.type === 'sixHelpUs' && player.isReleasing) {
      player._sixChargeTurns = 0;
      const defCount = Math.max(0, player.def);
      const hits = defCount * 2;
      let total = 0, st = 0, stuns = 0;
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
        if (Math.random() < (ability.special.stunChance || 0.05) && this.enemy.addStatus('stun')) stuns++;
        if (!this.enemy.isAlive) break;
      }
      st = player._applyGoop(this.enemy, defCount, player.id);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** cries **H̷E̶L̵P̸ ̷U̶S̵** ${emoji}! **${hits}** hits (2 per point of DEF) for **${total}** damage! 🫠 **${st}** Goop stacks!${stuns ? ' 💫 **Stunned!**' : ''}`, damage: total };
      return _u31end(R);
    }
    if (ability.special?.type === 'sixNoEffect' && !player.isReleasing) {
      if (!player.isCharging) {
        if (player._goopStacks(this.enemy) < (ability.special.requiredGoop || 20)) {
          ability.currentUses++;
          R.playerAction = { success: false, message: `**${ability.name}** needs at least **${ability.special.requiredGoop || 20}** Goop stacks on the enemy! (currently **${player._goopStacks(this.enemy)}**)` };
          return R;
        }
        player.isCharging = true; player.chargedAbility = abilityIndex; ability.currentUses++;
        R.playerAction = { success: true, message: `**${player.name}** reaches for all of the goop at once...`, damage: 0, charging: true };
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
    }
    if (ability.special?.type === 'sixNoEffect' && player.isReleasing) {
      const sp = ability.special;
      if (Math.random() < (sp.failChance || 0.06)) {
        player.currentHp = Math.max(0, player.currentHp - (sp.failDamage || 666));
        player.addStatus('stun');
        const _st = player.statusEffects.find(s => s.name === 'Stun'); if (_st) _st.turnsLeft = (sp.failStun || 2);
        R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** tries to consume the goop — and it consumes **them** instead! 💀 **${sp.failDamage || 666}** damage and **stunned for ${sp.failStun || 2} turns!**`, damage: 0 };
        if (!player.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
        return _u31end(R);
      }
      const consumed = player._consumeGoop(this.enemy, null);
      const turns = Math.floor(consumed / 6);
      if (turns > 0) {
        const gain = 66 - player.def;
        player.defMod += gain;
        player._sixNoEffectDef = gain;
        player._sixNoEffectTurns = turns;
        player._sixDefStacks = player._sixDefStacks || [];
        player._sixDefStacks.push({ amount: gain, turns: turns });
      }
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** consumes **${consumed}** Goop stacks! 🫠 **DEF set to 66** for **${turns}** turn${turns === 1 ? '' : 's'}!`, damage: 0 };
      return _u31end(R);
    }

    // ---------- HARDMODE INSANITY ----------
    if (ability.special?.type === 'quietSlam') {
      const sp = ability.special;
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (sp.disableChance || 0.10) && this.enemy._lastUsedAbilityIndex != null) {
        const dis = this.enemy.abilities[this.enemy._lastUsedAbilityIndex];
        if (dis) { dis.cooldownLeft = Math.max(dis.cooldownLeft || 0, (sp.disableDuration || 2) + 1); sm = ` 🔇 **${dis.name}** disabled for ${sp.disableDuration || 2} turns!`; }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}**: *"QUIET!"* ${emoji} **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage, isCrit: d.isCrit };
      return _u31end(R);
    }
    if (ability.special?.type === 'marrowGrinder') {
      const sp = ability.special;
      const hits = _u31hits(Math.floor(Math.random() * ((sp.maxHits || 6) - (sp.minHits || 2) + 1)) + (sp.minHits || 2));
      let total = 0;
      for (let i = 0; i < hits; i++) { const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage; if (!this.enemy.isAlive) break; }
      let sm = '';
      if (hits >= (sp.hemorrhageThreshold || 6) && this.enemy.addStatus('hemorrhage')) sm = ' 🩸 **Hemorrhage!** (8 dmg/turn until they heal or switch)';
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! Hit **${hits}** times for **${total}** damage!${sm}`, damage: total };
      return _u31end(R);
    }
    if (ability.special?.type === 'meltingPoint') {
      const sp = ability.special;
      let dmg, ignored = false;
      if (Math.random() < (sp.ignoreChance || 0.25)) {
        ignored = true;
        const base = Math.floor(Math.random() * (ability.damageMax - ability.damageMin + 1)) + ability.damageMin;
        const reducedDef = Math.max(1, Math.floor(this.enemy.def * (1 - (sp.defIgnore || 0.50))));
        dmg = Math.max(COMBAT.MIN_DAMAGE, Math.floor((base * (player.atk * getTypeMultiplier(ability.type, this.enemy.type))) / reducedDef));
        this.enemy.takeDamage(dmg);
      } else {
        const d = this.calculateDamage(player, ability, this.enemy); dmg = d.totalDamage; this.enemy.takeDamage(dmg);
      }
      player.skipNextTurn = true;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** reaches **Melting Point** ${emoji}! **${dmg}** damage!${ignored ? ' 💧 **Ignored 50% DEF!**' : ''} His body starts to melt — **he must skip his next turn.**`, damage: dmg };
      return _u31end(R);
    }
    if (ability.special?.type === 'justStayDead') {
      const sp = ability.special;
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (this.enemy.addStatus('stun')) sm += ' 💫 **Stunned!**';
      if (Math.random() < (sp.statusChance || 0.50)) {
        const pick = Math.random() < 0.5 ? 'bleed' : 'blueSoul';
        if (player._applyStatusFor(this.enemy, pick, sp.duration || 2)) sm += pick === 'bleed' ? ' 🔴 **Bleed!**' : ' 🔵 **Blue Soul!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}**: *"Just Stay Dead!"* ${emoji} **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage, isCrit: d.isCrit };
      return _u31end(R);
    }

    // ---------- LAST BREATH P3 ----------
    if (ability.special?.type === 'boneFold') {
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.bleedChance || 0.35) && player._applyStatusFor(this.enemy, 'bleed', ability.special.bleedDuration || 2)) sm = ' 🔴 **Bleed!**';
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage, isCrit: d.isCrit };
      return _u31end(R);
    }
    if (ability.special?.type === 'blasterOverture') {
      const sp = ability.special;
      const hits = _u31hits(Math.floor(Math.random() * ((sp.maxHits || 3) - (sp.minHits || 2) + 1)) + (sp.minHits || 2));
      let total = 0;
      for (let i = 0; i < hits; i++) { const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage; if (!this.enemy.isAlive) break; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${hits}** blasters for **${total}** damage!`, damage: total };
      return _u31end(R);
    }
    if (ability.special?.type === 'colorOverload') {
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      const pick = ['blueSoul', 'karma', 'electrified'][Math.floor(Math.random() * 3)];
      const label = pick === 'blueSoul' ? '🔵 **Blue Soul!**' : pick === 'karma' ? '☯️ **Karma!**' : '⚡ **Electrified!**';
      const sm = this.enemy.addStatus(pick) ? ' ' + label : '';
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** floods the field with color ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage, isCrit: d.isCrit };
      return _u31end(R);
    }
    if (ability.special?.type === 'lastBreathStrike' && !player.isReleasing) {
      if (!player.isCharging) {
        player.isCharging = true; player.chargedAbility = abilityIndex; ability.currentUses++;
        R.playerAction = { success: true, message: `**${player.name}** draws one last breath...`, damage: 0, charging: true };
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
    }
    if (ability.special?.type === 'lastBreathStrike' && player.isReleasing) {
      const d = _u31crit(player, () => this.calculateDamage(player, ability, this.enemy));
      this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (player._applyStatusFor(this.enemy, 'scaryKR', ability.special.krDuration || 3)) sm = ` ☯️ **Scary KR for ${ability.special.krDuration || 3} turns!**`;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** unleashes **LAST BREATH** ${emoji}! **${d.totalDamage}** damage — **GUARANTEED CRIT!**${sm}`, damage: d.totalDamage, isCrit: true };
      return _u31end(R);
    }
    // ===================== END UPDATE 31 ABILITY HANDLERS =====================

    if (ability.special?.type === 'thousandAxeSlashes') {
      const hits = Math.floor(Math.random() * (ability.special.maxHits - ability.special.minHits + 1)) + ability.special.minHits;
      let total = 0, sm = '', bleedApplied = false;
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
        if (!bleedApplied && Math.random() < ability.special.bleedChance) {
          if (this.enemy.addStatus('bleed')) { sm += ` **Bleed!**`; bleedApplied = true; }
        }
      }
      if (hits >= 7) { this.enemy.defMod -= (ability.special.allHitsDefReduction || 2); sm += ` All 7 hits landed! Enemy **-${ability.special.allHitsDefReduction || 2} DEF** permanently!`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! Hit **${hits}** times for **${total}** total damage!${sm}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // BONE CALAMITY (C!Insanity) — battlefield bone shards 3 turns
    if (ability.special?.type === 'boneCalamity') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      this.enemy._boneShardsTurns = ability.special.shardsDuration;
      this.enemy._boneShardsRecoil = ability.special.recoilDamage;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} 🦴 **Bone Shards** cover the field! Enemy takes +${ability.special.recoilDamage} recoil on Melee/Weapon moves for ${ability.special.shardsDuration} turns!`, damage: d.totalDamage, isCrit: d.isCrit };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // BLASTER VOLLEY (C!Insanity) — applies electrified
    if (ability.special?.type === 'blasterVolley') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      const sr = this.enemy.addStatus('electrified'); let sm = sr ? ` **Electrified!** (-20% accuracy)` : '';
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage, isCrit: d.isCrit };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // C.H.U.N.G (C!Insanity) — charge then 10% def-ignore + poison/blindness
    if (ability.special?.type === 'chungBlast' && !player.isReleasing) {
      if (!player.isCharging) {
        player.isCharging = true; player.chargedAbility = abilityIndex;
        R.playerAction = { success: true, message: `**${player.name}** stops, eyes glowing with terrifying intensity, summoning a different blaster...`, damage: 0, charging: true };
        ability.currentUses++;
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
    }
    if (ability.special?.type === 'chungBlast' && player.isReleasing) {
      // Custom damage calc: ignore 30% DEF
      const baseDmg = Math.floor(Math.random() * (ability.damageMax - ability.damageMin + 1)) + ability.damageMin;
      const ignorePct = ability.special.defIgnore || 0.30;
      const reducedDef = Math.floor(this.enemy.def * (1 - ignorePct));
      const typeMult = getTypeMultiplier(ability.type, this.enemy.type);
      const isCrit = Math.random() < (COMBAT.CRIT_CHANCE + (player.critBoost || 0));
      const critMult = isCrit ? COMBAT.CRIT_MULTIPLIER : 1;
      let totalDamage = Math.max(COMBAT.MIN_DAMAGE, Math.floor(((baseDmg * (player.atk * typeMult)) / Math.max(1, reducedDef)) * critMult));
      this.enemy.takeDamage(totalDamage);
      const status = Math.random() < 0.5 ? 'poison' : 'blindness';
      const sr = this.enemy.addStatus(status); let sm = sr ? ` **${status.charAt(0).toUpperCase() + status.slice(1)}!**` : '';
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** unleashes **C.H.U.N.G**! Ignores ${Math.round(ignorePct * 100)}% DEF! **${totalDamage}** damage!${isCrit ? ' **CRIT!**' : ''}${sm}`, damage: totalDamage, isCrit };
      if (!this.enemy.isAlive) { player._chungPvpKill = true; R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // BONE MASSACRE (Final Insanity) — Bleed chance
    if (ability.special?.type === 'boneMassacre') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.bleedChance) {
        if (this.enemy.addStatus('bleed')) sm = ` **Bleed!**`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage, isCrit: d.isCrit };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // INSANITY SLASH (Final Insanity) — high crit, applies INSANITY stack(s)
    if (ability.special?.type === 'insanitySlash') {
      // Custom crit roll
      const baseDmg = Math.floor(Math.random() * (ability.damageMax - ability.damageMin + 1)) + ability.damageMin;
      const typeMult = getTypeMultiplier(ability.type, this.enemy.type);
      const isCrit = Math.random() < ability.special.critChance;
      const critMult = isCrit ? COMBAT.CRIT_MULTIPLIER : 1;
      let totalDamage = Math.max(COMBAT.MIN_DAMAGE, Math.floor(((baseDmg * (player.atk * typeMult)) / Math.max(1, this.enemy.def)) * critMult));
      this.enemy.takeDamage(totalDamage);
      const stacksToApply = isCrit ? 2 : 1;
      this.enemy._insanityStacks = (this.enemy._insanityStacks || 0) + stacksToApply;
      let sm = ` **${stacksToApply}** [INSANITY] stack(s) applied! (Total: ${this.enemy._insanityStacks})`;
      this._checkInsanityThresholds(R);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${totalDamage}** damage!${isCrit ? ' **CRIT!**' : ''}${sm}`, damage: totalDamage, isCrit };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // DEVASTATING ROAR (Final Insanity) — block enemy boost/def/heal next turn + 20% flinch
    if (ability.special?.type === 'devastatingRoar') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      this.enemy._roarLockoutTurns = 1;
      let sm = ` Enemy can't use boost/defense/healing moves next turn!`;
      if (Math.random() < ability.special.flinchChance) {
        this.enemy.addStatus('flinch'); sm += ` **Flinched!**`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage, isCrit: d.isCrit };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // FINAL C.H.U.N.G (Final Insanity) — consume INSANITY stacks for bonus dmg + stun
    if (ability.special?.type === 'finalChung') {
      const stacks = this.enemy._insanityStacks || 0;
      const bonus = stacks * ability.special.perStackDamage;
      const baseDmg = Math.floor(Math.random() * (ability.damageMax - ability.damageMin + 1)) + ability.damageMin;
      const typeMult = getTypeMultiplier(ability.type, this.enemy.type);
      const isCrit = Math.random() < (COMBAT.CRIT_CHANCE + (player.critBoost || 0));
      const critMult = isCrit ? COMBAT.CRIT_MULTIPLIER : 1;
      let totalDamage = Math.max(COMBAT.MIN_DAMAGE, Math.floor(((baseDmg * (player.atk * typeMult)) / Math.max(1, this.enemy.def)) * critMult)) + bonus;
      this.enemy.takeDamage(totalDamage);
      let sm = stacks > 0 ? ` Consumed **${stacks}** [INSANITY] stack(s) for **+${bonus}** bonus damage!` : '';
      if (stacks >= ability.special.stunThreshold) {
        this.enemy.addStatus('stun');
        sm += ` Enemy **STUNNED** for ${ability.special.stunDuration} turns!`;
      }
      this.enemy._insanityStacks = 0;
      ability.cooldownLeft = ability.special.cooldown || 3;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** unleashes **Final C.H.U.N.G**! **${totalDamage}** damage!${isCrit ? ' **CRIT!**' : ''}${sm}`, damage: totalDamage, isCrit };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // WEAK OMNIVERSAL CLEAVE (Weak Avenge Sans) — next Magic move +20% dmg
    if (ability.special?.type === 'weakOmniCleave') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      player._magicBoostNext = ability.special.magicBoost;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} Next Magic move deals **${ability.special.magicBoost}x** damage!`, damage: d.totalDamage, isCrit: d.isCrit };
      // Spite stack consumption (Melee hit on Weak Avenge)
      if (player.passive?.type === 'willToAvenge' && player._spiteStacks > 0) player._spiteStacks = 0;
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // WEAK AVENGE BONES (Weak Avenge Sans) — 30% chance -2 enemy ATK 1 turn
    if (ability.special?.type === 'weakAvengeBones') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.atkReduceChance) {
        this.enemy.atkMod -= ability.special.atkReduceAmount;
        this.enemy._tempAtkRevertTurns = ability.special.atkReduceTurns;
        this.enemy._tempAtkRevertAmount = ability.special.atkReduceAmount;
        sm = ` Enemy **-${ability.special.atkReduceAmount} ATK** for ${ability.special.atkReduceTurns} turn!`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage, isCrit: d.isCrit };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // WEAK AVENGE BLASTERS (Weak Avenge Sans) — Karma + low HP bonus
    if (ability.special?.type === 'weakAvengeBlasters') {
      const baseDmg = Math.floor(Math.random() * (ability.damageMax - ability.damageMin + 1)) + ability.damageMin;
      const typeMult = getTypeMultiplier(ability.type, this.enemy.type);
      const isCrit = Math.random() < (COMBAT.CRIT_CHANCE + (player.critBoost || 0));
      const critMult = isCrit ? COMBAT.CRIT_MULTIPLIER : 1;
      let totalDamage = Math.max(COMBAT.MIN_DAMAGE, Math.floor(((baseDmg * (player.atk * typeMult)) / Math.max(1, this.enemy.def)) * critMult));
      let lowHpBonus = '';
      if (player.currentHp / player.maxHp < ability.special.lowHpThreshold) {
        totalDamage += ability.special.lowHpBonus;
        lowHpBonus = ` **+${ability.special.lowHpBonus}** low HP bonus!`;
      }
      this.enemy.takeDamage(totalDamage);
      const sr = this.enemy.addStatus('karma'); let sm = sr ? ` **Karma!**` : '';
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${totalDamage}** damage!${isCrit ? ' **CRIT!**' : ''}${sm}${lowHpBonus}`, damage: totalDamage, isCrit };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // OMNI DEFLECT (Weak Avenge Sans) — counter stance
    if (ability.special?.type === 'omniDeflect') {
      player._omniDeflectActive = true;
      player._omniDeflectBase = ability.special.counterBase;
      player._omniDeflectDefGain = ability.special.defGain;
      R.playerAction = { success: true, message: `**${player.name}** holds the blade vertically, entering a **Counter Stance**!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn();
      // Resolve after enemy turn
      if (player._omniDeflectTriggered) {
        player._omniDeflectTriggered = false;
      } else if (player._omniDeflectActive) {
        // No melee used → +1 DEF
        player.defMod += ability.special.defGain;
        R.omniDeflectFallback = `⚔️ No Melee was used. **${player.name}** gained **+${ability.special.defGain} DEF**!`;
      }
      player._omniDeflectActive = false;
      this.endTurn(R, player); return R;
    }

    // OMNI SWORD DANCE (Avenge Sans) — high crit + 20% chance +2 ATK
    if (ability.special?.type === 'omniSwordDance') {
      const baseDmg = Math.floor(Math.random() * (ability.damageMax - ability.damageMin + 1)) + ability.damageMin;
      const typeMult = getTypeMultiplier(ability.type, this.enemy.type);
      const isCrit = Math.random() < ability.special.critChance;
      const critMult = isCrit ? COMBAT.CRIT_MULTIPLIER : 1;
      let totalDamage = Math.max(COMBAT.MIN_DAMAGE, Math.floor(((baseDmg * (player.atk * typeMult)) / Math.max(1, this.enemy.def)) * critMult));
      this.enemy.takeDamage(totalDamage);
      let sm = '';
      if (Math.random() < ability.special.atkBoostChance) {
        player.atkMod += ability.special.atkBoostAmount;
        sm = ` **+${ability.special.atkBoostAmount} ATK** gained!`;
      }
      // Omniversal Prodigy magic boost on Melee/Weapon hit
      if (player.passive?.type === 'omniversalProdigy' && hasPassiveUnlocked(player.level)) {
        player._magicDmgBoost = Math.min(ability.special.magicBoostCap || player.passive.magicBoostCap, (player._magicDmgBoost || 0) + (player.passive.magicBoostPerHit || 0.05));
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${totalDamage}** damage!${isCrit ? ' **CRIT!**' : ''}${sm}`, damage: totalDamage, isCrit };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // AVENGE BLASTERS (Avenge Sans) — 4 hits, Karma, 10% Dazed
    if (ability.special?.type === 'avengeBlasters') {
      let total = 0;
      for (let i = 0; i < ability.special.hits; i++) {
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
      }
      const sr = this.enemy.addStatus('karma'); let sm = sr ? ` **Karma!**` : '';
      if (Math.random() < ability.special.dazedChance) {
        this.enemy._dazedTurns = ability.special.dazedDuration;
        sm += ` **Dazed!** Counter moves blocked for ${ability.special.dazedDuration} turns!`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! Hit **${ability.special.hits}** times for **${total}** total damage!${sm}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // UNIVERSAL CUT (Avenge Sans) — block switch/dodge/TP for 2 turns
    if (ability.special?.type === 'universalCut') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      this.enemy._universalCutTurns = ability.special.restrictDuration;
      // Magic boost from Omniversal Prodigy
      if (player.passive?.type === 'omniversalProdigy' && hasPassiveUnlocked(player.level)) {
        player._magicDmgBoost = Math.min(player.passive.magicBoostCap || 0.25, (player._magicDmgBoost || 0) + (player.passive.magicBoostPerHit || 0.05));
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} Enemy can't switch, dodge, or teleport for **${ability.special.restrictDuration}** turns!`, damage: d.totalDamage, isCrit: d.isCrit };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // AVENGE SWORD BEAM (Avenge Sans) — disable random move + magic recoil flag
    if (ability.special?.type === 'avengeSwordBeam') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      // Pick a random ability with uses left to disable
      const usable = this.enemy.abilities.filter(a => a.currentUses > 0);
      let sm = '';
      if (usable.length > 0) {
        const target = usable[Math.floor(Math.random() * usable.length)];
        target._disabledTurns = ability.special.disableDuration;
        sm = ` Enemy ability **${target.name}** disabled for ${ability.special.disableDuration} turns!`;
      }
      this.enemy._magicRecoilNext = ability.special.magicRecoil;
      sm += ` If enemy uses Magic next turn: **${ability.special.magicRecoil} recoil**!`;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage, isCrit: d.isCrit };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ============================================================
    // === END UPDATE 12 ABILITY SPECIALS ===
    // ============================================================

    // ============================================================
    // === UPDATE 13 ABILITY SPECIALS ===
    // ============================================================

    // ---- MAFIATALE SANS ----
    // Bone Grenade
    if (ability.special?.type === 'boneGrenade') {
      let abilityCopy = { ...ability };
      let defIgnored = false;
      var dGren;
      if (Math.random() < (ability.special.defIgnoreChance || 0.3)) {
        // Lower enemy DEF temporarily for this calc via defMod
        const reduction = Math.ceil(this.enemy.def * (ability.special.defIgnoreAmount || 0.1));
        this.enemy.defMod -= reduction;
        dGren = this.calculateDamage(player, abilityCopy, this.enemy);
        this.enemy.defMod += reduction;
        defIgnored = true;
      } else {
        dGren = this.calculateDamage(player, abilityCopy, this.enemy);
      }
      this.enemy.takeDamage(dGren.totalDamage);
      let flinchMsg = '';
      if (Math.random() < (ability.special.flinchChance || 0.25)) { const sr = this.enemy.addStatus('flinch'); if (sr) flinchMsg = ' **Flinched!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${dGren.totalDamage}** damage!${dGren.isCrit ? ' **CRIT!**' : ''}${defIgnored ? ' *(Ignored 10% DEF!)*' : ''}${flinchMsg}`, damage: dGren.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Tommy Gun Burst
    if (ability.special?.type === 'tommyGunBurst') {
      const minH = ability.special.minHits || 2; const maxH = ability.special.maxHits || 6;
      const hits = Math.floor(Math.random() * (maxH - minH + 1)) + minH;
      let total = 0; let bleedApplied = false;
      for (let i = 0; i < hits; i++) {
        if (!this.enemy.isAlive) break;
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
        if (!bleedApplied && Math.random() < (ability.special.bleedPerHit || 0.05)) { const sr = this.enemy.addStatus('bleed'); if (sr) bleedApplied = true; }
      }
      let weakenMsg = '';
      if (hits >= (ability.special.weakenThreshold || 4)) { this.enemy._tommyGunWeaken = 0.10; weakenMsg = ' Enemy\'s next move deals 10% less!'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! ${hits} hits for **${total}** damage!${bleedApplied ? ' **Bleed!**' : ''}${weakenMsg}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Bribery
    if (ability.special?.type === 'bribery') {
      const dmg = Math.floor(Math.random() * (ability.damageMax - ability.damageMin + 1)) + ability.damageMin;
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let bonusMsg = '';
      const versusBoss = this.isBoss === true;
      if (versusBoss && (this.turnCount || 0) >= 3 && Math.random() < (ability.special.healChance || 0.2)) {
        const heal = Math.floor((player.maxHp || player.hp) * (ability.special.healPercent || 0.1));
        player.hp = Math.min(player.maxHp || player.hp, player.hp + heal);
        bonusMsg = ` Sans pocketed the bribe and healed **${heal} HP**!`;
      } else if (Math.random() < 0.5) {
        this.enemy._accuracyDebuff = Math.max(this.enemy._accuracyDebuff || 0, ability.special.accuracyDebuff || 0.3);
        this.enemy._accuracyDebuffTurns = ability.special.debuffDuration || 2;
        bonusMsg = ` Enemy accuracy -30% for ${ability.special.debuffDuration || 2} turns!`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${bonusMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // The Contract
    if (ability.special?.type === 'theContract') {
      const minTurn = ability.special.minTurn || 3;
      if ((this.turnCount || 0) < minTurn) {
        R.playerAction = { success: false, message: `**${ability.name}** can only be used after turn ${minTurn}!` };
        return R;
      }
      this.enemy._contractRecoilTurns = ability.special.duration || 2;
      this.enemy._contractRecoilPercent = ability.special.recoilPercent || 0.15;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** activated **${ability.name}** ${emoji}! For ${ability.special.duration || 2} turns, enemy attacks deal 15% recoil!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ---- OUTERDUST SANS ----
    // Star Devastation
    if (ability.special?.type === 'starDevastation') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let total = d.totalDamage; let splitMsg = '';
      if (Math.random() < (ability.special.splitChance || 0.3) && this.enemy.isAlive) {
        const splitDmg = Math.max(1, Math.floor(d.totalDamage * (ability.special.splitMultiplier || 0.5)));
        this.enemy.takeDamage(splitDmg); total += splitDmg; splitMsg = ` Star split for an extra **${splitDmg}** dmg!`;
      }
      // --- UPDATE 22: 10% chance to inflict Star Shards for 2 turns ---
      if (ability.special.starShardsChance && Math.random() < ability.special.starShardsChance && this.enemy.isAlive) {
        this.enemy._starShardsStacks = (this.enemy._starShardsStacks || 0) + 1;
        this.enemy._starShardsTurns = ability.special.starShardsDuration || 2;
        splitMsg += ' 🌟 **Star Shards inflicted!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${total}** damage!${d.isCrit ? ' **CRIT!**' : ''}${splitMsg}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ============================================================
    // UPDATE 22: FALLEN PRIEST + TS!UNDERSWAP SANS HANDLERS
    // ============================================================

    // A SINNER'S RAIN — 3-5 hits, 10% Regret (2 turns) per hit
    if (ability.special?.type === 'sinnersRain') {
      const hits = Math.floor(Math.random() * (ability.special.maxHits - ability.special.minHits + 1)) + ability.special.minHits;
      let total = 0, sm = '';
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
        if (Math.random() < (ability.special.regretChance || 0.10)) {
          const sr = this.enemy.addStatus('regret');
          const rg = this.enemy.statusEffects.find(st => st.name === 'Regret');
          if (rg) rg.turnsLeft = ability.special.regretDuration || 2;
          if (sr && !sm.includes('Regret')) sm += ' 😔 **Regret applied!**';
        }
        if (!this.enemy.isAlive) break;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! ${hits} hits for **${total}** total damage!${sm}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // BLASTER CROSS — 2x dmg if enemy >70% HP, 30% crit (Regret 3 turns on crit), capped at 50% of enemy HP
    if (ability.special?.type === 'blasterCross') {
      player.critBoost = Math.max(0, (ability.special.critChance || 0.30) - COMBAT.CRIT_CHANCE);
      const d = this.calculateDamage(player, ability, this.enemy);
      player.critBoost = 0;
      let dmg = d.totalDamage; let sm = '';
      if ((this.enemy.currentHp / this.enemy.maxHp) > (ability.special.hpThreshold || 0.70)) { dmg *= 2; sm += ' ✝️ **2x damage** (enemy above 70% HP)!'; }
      const cap = Math.floor(this.enemy.currentHp * (ability.special.hpCap || 0.50));
      if (dmg > cap) { dmg = Math.max(1, cap); sm += ' *(capped at 50% of enemy HP)*'; }
      this.enemy.takeDamage(dmg);
      if (d.isCrit) {
        const sr = this.enemy.addStatus('regret');
        const rg = this.enemy.statusEffects.find(st => st.name === 'Regret');
        if (rg) rg.turnsLeft = ability.special.regretDuration || 3;
        if (sr) sm += ' 😔 **Regret applied (3 turns)!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: dmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // THE CROSS — Blessing for 2 turns
    if (ability.special?.type === 'theCross') {
      player._blessingTurns = ability.special.blessingDuration || 2;
      player.addStatus('blessing');
      R.playerAction = { success: true, message: `**${player.name}** used **The Cross**! 🙏 **Blessing** for ${player._blessingTurns} turns — negates 30% of damage taken and heals for the negated amount!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // GOD'S NECROMANIAC — cycles the 5 base boss abilities (1 use each), +1 multihit per power of 10 of the respective boss kills
    if (ability.special?.type === 'godsNecromaniac') {
      const necroMoves = [
        { boss: 'toriel', name: 'Ember rain..', dmg: 14, type: 'Fire', emoji: '🔥', apply: (e) => { const h = e.addStatus('hellfire'); const hf = e.statusEffects.find(st => st.name === 'Hellfire'); if (hf) hf.turnsLeft = 1; if (!e._emberAtkDropped) { e.atkMod -= 2; e._emberAtkDropped = true; } return ' **Hellfire (1 turn)** + enemy **-2 ATK**!'; } },
        { boss: 'papyrus', name: 'Special Attack.?', dmg: 18, type: 'Bone', emoji: '🦴', apply: (e) => { const b = e.addStatus('blueSoul'); const bs = e.statusEffects.find(st => st.name === 'Blue Soul'); if (bs) bs.turnsLeft = 3; e.addStatus('stun'); return ' **Blue Soul (3 turns)** + **Stunned (1 turn)**!'; } },
        { boss: 'undyne', name: 'Spear Helix', dmg: 25, type: 'Melee', emoji: '🔱', apply: (e) => { const b = e.addStatus('bleed'); const bl = e.statusEffects.find(st => st.name === 'Bleed'); if (bl) bl.turnsLeft = 1; return ' **Bleed (1 turn per hit)**!'; } },
        { boss: 'mettaton_neo', name: 'Showstopper', dmg: 20, type: 'Shock', emoji: '⚡', apply: (e) => { const el = e.addStatus('electrified'); const ef = e.statusEffects.find(st => st.name === 'Electrified'); if (ef) ef.turnsLeft = 3; return ' **Shocked (3 turns)**!'; } },
        { boss: 'asgore', name: 'A Kings Greeting', dmg: 24, type: 'Fire', emoji: '👑', apply: (e) => { const b = e.addStatus('burn'); const bn = e.statusEffects.find(st => st.name === 'Burn'); if (bn) bn.turnsLeft = 1; const h = e.addStatus('hellfire'); const hf = e.statusEffects.find(st => st.name === 'Hellfire'); if (hf) hf.turnsLeft = 1; return ' **Burn + Hellfire (1 turn per hit)**!'; } },
      ];
      const idx = player._necroIndex || 0;
      if (idx >= necroMoves.length) {
        R.playerAction = { success: false, message: `**God's Necromaniac** has channeled all 5 boss abilities already!`, damage: 0 };
        ability.currentUses++; return R;
      }
      const mv = necroMoves[idx];
      player._necroIndex = idx + 1;
      // UPDATE 32 BUG FIX: the -2 ATK from Ember rain.. is a per-USE effect, not per-hit.
      // Bonus hits from boss kills were stacking it (-4 / -6 / -8) against a move that says -2.
      this.enemy._emberAtkDropped = false;
      const kills = (player._bossKills || {})[mv.boss] || 0;
      const bonusHits = kills >= 1 ? Math.floor(Math.log10(kills)) : 0;
      const hits = 1 + bonusHits;
      let total = 0; let sm = '';
      for (let i = 0; i < hits; i++) {
        const dr = this.enemy.takeDamage(mv.dmg); total += dr.damage;
        sm = mv.apply(this.enemy);
        if (!this.enemy.isAlive) break;
      }
      R.playerAction = { success: true, abilityType: mv.type, message: `**${player.name}** used **God's Necromaniac**! ${mv.emoji} **${mv.name}** (#${idx + 1}) hits ${hits}x for **${total}** total damage!${sm}${bonusHits > 0 ? ` *(+${bonusHits} hits from ${kills} ${mv.boss} kills)*` : ''}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // SACRIFICES MUST BE MADE.. — instantly kill base-5 boss (100+ kills), no drops, extra boss kills awarded
    if (ability.special?.type === 'sacrificesMustBeMade') {
      const baseBosses = ['toriel', 'papyrus', 'undyne', 'mettaton_neo', 'asgore'];
      if (!this.isBoss || !baseBosses.includes(this.enemyId)) {
        R.playerAction = { success: false, message: `**Sacrifices must be made..** is only usable against **Toriel, Papyrus, Undyne, Mettaton NEO or Asgore**!`, damage: 0 };
        ability.currentUses++; return R;
      }
      const kills = (player._bossKills || {})[this.enemyId] || 0;
      if (kills < 100) {
        R.playerAction = { success: false, message: `**Sacrifices must be made..** requires at least **100 kills** on this boss! (You have **${kills}**)`, damage: 0 };
        ability.currentUses++; return R;
      }
      let awarded = 2;
      if (kills >= 1000) awarded = 6 + 2 * Math.floor((kills - 1000) / 500);
      else if (kills >= 500) awarded = 3;
      this.enemy.currentHp = 0;
      this._noChanceDrops = true;
      this._extraBossKills = awarded - 1; // index.js adds 1 normally; these are the extras
      R.playerAction = { success: true, message: `✝️ *"It's not wrong if they agreed to it, right..?"*\n\n**${player.name}** used **Sacrifices must be made..** — **${this.enemy.name}** is instantly slain! No drops are awarded, but **${awarded} boss kills** are recorded!`, damage: 0 };
      R.battleEnd = this.checkBattleEnd(); return R;
    }

    // ============================================================
    // UPDATE 24: OCEANTALE PAPYRUS HANDLERS
    // ============================================================

    // HAND CANNON — 25% push: enemy flinches next turn + Soaked (-10% acc, 2 turns)
    if (ability.special?.type === 'handCannon') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.pushChance || 0.25)) {
        this.enemy.addStatus('flinch');
        const so = this.enemy.addStatus('soaked');
        const s = this.enemy.statusEffects.find(st => st.name === 'Soaked'); if (s) s.turnsLeft = ability.special.accDownDuration || 2;
        sm = ' 🌊 **Pushed back!** Enemy flinches next turn and is **Soaked** (-10% accuracy, 2 turns)!';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // HARPOON GUN — 30% chain: stun 1 turn + trap (no dodge/switch) 2 turns
    if (ability.special?.type === 'harpoonGun') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.chainChance || 0.30)) {
        this.enemy.addStatus('stun');
        this.enemy._harpoonTrapTurns = ability.special.trapDuration || 2; // no dodge/switch (relevant in PvP)
        sm = ' ⚓ **Chained!** Enemy stunned 1 turn and cannot dodge or switch for 2 turns!';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // BONE ANCHOR — 50% Blue Soul (2 turns); while affected, Melee vs enemy deals 1.2x (via _oceanMeleeVuln)
    if (ability.special?.type === 'boneAnchor') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.blueSoulChance || 0.50)) {
        this.enemy.addStatus('blueSoul');
        const bs = this.enemy.statusEffects.find(st => st.name === 'Blue Soul'); if (bs) bs.turnsLeft = ability.special.blueSoulDuration || 2;
        this.enemy._oceanMeleeVuln = true;
        sm = ' 💙 **Blue Soul!** (2 turns) — Melee attacks now deal 1.2x to the enemy!';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // BOAT CRUISE — 1.3x if a Swordfish Counter has triggered this match
    if (ability.special?.type === 'boatCruise') {
      const d = this.calculateDamage(player, ability, this.enemy);
      let dmg = d.totalDamage; let sm = '';
      if (player._swordfishTriggered) { dmg = Math.floor(dmg * (ability.special.bonusMult || 1.3)); sm = ' 🚢 **Swordfish Counter bonus — 1.3x damage!**'; }
      this.enemy.takeDamage(dmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: dmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ============================================================
    // UPDATE 24: PSYCHOPATHTALE / DUSTTALE ENDGOAL / REAPER CHARA / FEDORA HANDLERS
    // ============================================================
    // Helper: psycho-mode damage (temporarily swap range so type/crit math is preserved)
    const _psychoDmg = (abil) => {
      const psycho = !!player._psychoMode;
      const oMin = abil.damageMin, oMax = abil.damageMax;
      if (psycho && abil.special.psychoMin != null) { abil.damageMin = abil.special.psychoMin; abil.damageMax = abil.special.psychoMax; }
      const d = this.calculateDamage(player, abil, this.enemy);
      abil.damageMin = oMin; abil.damageMax = oMax;
      return { d, psycho };
    };

    // NEON SLASH
    if (ability.special?.type === 'neonSlash') {
      const { d, psycho } = _psychoDmg(ability); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (psycho) {
        const s = this.enemy.addStatus('schizo'); const so = this.enemy.statusEffects.find(st => st.name === 'Schizo'); if (so) so.turnsLeft = ability.special.schizoDuration; if (s) sm += ' 🌀 **Schizo!**';
        if (Math.random() < ability.special.psychoAtkDownChance) { this.enemy.atkMod -= ability.special.psychoAtkDown; sm += ` -${ability.special.psychoAtkDown} ATK!`; }
      } else {
        const s = this.enemy.addStatus('karma'); const ka = this.enemy.statusEffects.find(st => st.name === 'Karma'); if (ka) ka.turnsLeft = ability.special.karmaDuration; if (s) sm += ' ☯️ **Karma!**';
        if (Math.random() < ability.special.normalDefDownChance) { this.enemy.defMod -= ability.special.normalDefDown; sm += ` -${ability.special.normalDefDown} DEF!`; }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}!${psycho ? ' *(Psycho Mode)*' : ''} **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // PSYCHOTIC BLASTER
    if (ability.special?.type === 'psychoticBlaster') {
      const { d, psycho } = _psychoDmg(ability); let dmg = d.totalDamage; let sm = '';
      if (psycho) {
        if (Math.random() < ability.special.psychoBonusChance) { dmg = Math.floor(dmg * ability.special.psychoBonusMult); sm += ' 🌀 **+15% damage!**'; }
        const s = this.enemy.addStatus('schizo'); const so = this.enemy.statusEffects.find(st => st.name === 'Schizo'); if (so) so.turnsLeft = ability.special.schizoDuration; if (s) sm += ' **Schizo!**';
      } else {
        if (Math.random() < ability.special.normalNegateChance) { dmg = Math.floor(dmg * 0.90); sm += ' ☯️ *(10% negated)*'; }
        const s = this.enemy.addStatus('karma'); const ka = this.enemy.statusEffects.find(st => st.name === 'Karma'); if (ka) ka.turnsLeft = ability.special.karmaDuration; if (s) sm += ' **Karma!**';
      }
      this.enemy.takeDamage(dmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}!${psycho ? ' *(Psycho Mode)*' : ''} **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: dmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // BONE RAVAGE — multi-hit (6 normal / 5 psycho)
    if (ability.special?.type === 'boneRavage') {
      const psycho = !!player._psychoMode;
      const hits = psycho ? ability.special.psychoHits : ability.special.normalHits;
      let total = 0;
      for (let i = 0; i < hits; i++) { const { d } = _psychoDmg(ability); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage; if (!this.enemy.isAlive) break; }
      let sm = '';
      if (psycho) { const s = this.enemy.addStatus('schizo'); const so = this.enemy.statusEffects.find(st => st.name === 'Schizo'); if (so) so.turnsLeft = ability.special.schizoDuration; if (s) sm += ' 🌀 **Schizo!**'; }
      else { const s = this.enemy.addStatus('karma'); const ka = this.enemy.statusEffects.find(st => st.name === 'Karma'); if (ka) ka.turnsLeft = ability.special.karmaDuration; if (s) sm += ' ☯️ **Karma!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}!${psycho ? ' *(Psycho Mode)*' : ''} ${hits} hits for **${total}** total!${sm}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // LARGE SCHIZO BLASTER — charges 1 turn, then fires
    if (ability.special?.type === 'largeSchizoBlaster') {
      if (!player._largeSchizoCharging) {
        player._largeSchizoCharging = true;
        R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** begins charging **${ability.name}**... ⚡`, damage: 0 };
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
      player._largeSchizoCharging = false;
      const { d, psycho } = _psychoDmg(ability); let dmg = d.totalDamage; let sm = '';
      if (psycho) {
        if (Math.random() < ability.special.psychoBonusChance) { dmg = Math.floor(dmg * ability.special.psychoBonusMult); sm += ' 🌀 **+25% damage!**'; }
        const s = this.enemy.addStatus('schizo'); const so = this.enemy.statusEffects.find(st => st.name === 'Schizo'); if (so) so.turnsLeft = ability.special.schizoDuration; if (s) sm += ' **Schizo!**';
      } else {
        const s = this.enemy.addStatus('karma'); const ka = this.enemy.statusEffects.find(st => st.name === 'Karma'); if (ka) ka.turnsLeft = ability.special.karmaDuration; if (s) sm += ' ☯️ **Karma!**';
        if (Math.random() < ability.special.normalNegateChance) { player._negateNextPct = 0.25; sm += ' *(will negate 25% of next attack)*'; }
      }
      this.enemy.takeDamage(dmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** fires **${ability.name}** ${emoji}!${psycho ? ' *(Psycho Mode)*' : ''} **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: dmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // TELEKINETIC SLAM (Dusttale Endgoal)
    if (ability.special?.type === 'telekineticSlam') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      const low = (player.currentHp / player.maxHp) < 0.40;
      let sm = '';
      if (Math.random() < ability.special.blueSoulChance) { this.enemy.addStatus('blueSoul'); const bs = this.enemy.statusEffects.find(st => st.name === 'Blue Soul'); if (bs) bs.turnsLeft = ability.special.blueSoulDuration; sm += ' 💙 **Blue Soul!**'; }
      const stunChance = low ? ability.special.lowStunChance : ability.special.stunChance;
      if (Math.random() < stunChance) { this.enemy.addStatus('stun'); sm += ' **Stun!**'; if (low) { this.enemy.addStatus('boneZone'); const bz = this.enemy.statusEffects.find(st => st.name === 'Bone Zone'); if (bz) bz.turnsLeft = 2; sm += ' 🦴 **Bone Zone!**'; } }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // TRUE GENOCIDE (Dusttale Endgoal) — +5 dmg per 25 HP lost (max +20); below 40% +20% crit
    if (ability.special?.type === 'trueGenocide') {
      const low = (player.currentHp / player.maxHp) < 0.40;
      if (low) player.critBoost = (player.critBoost || 0) + ability.special.lowCritBonus;
      const d = this.calculateDamage(player, ability, this.enemy);
      if (low) player.critBoost = Math.max(0, (player.critBoost || 0) - ability.special.lowCritBonus);
      const hpLost = player.maxHp - player.currentHp;
      const bonus = Math.min(ability.special.maxBonus, Math.floor(hpLost / ability.special.perHpLost) * ability.special.bonusPer);
      const dmg = d.totalDamage + bonus;
      this.enemy.takeDamage(dmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${dmg}** damage!${bonus > 0 ? ` (+${bonus} from lost HP)` : ''}${d.isCrit ? ' **CRIT!**' : ''}`, damage: dmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // FLAWLESS BONE WALL (Dusttale Endgoal) — temp shield = 15% max HP, 2 turns
    if (ability.special?.type === 'flawlessBoneWall') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      const shield = Math.floor(player.maxHp * ability.special.shieldPct);
      player._tempShield = (player._tempShield || 0) + shield; player._tempShieldTurns = ability.special.shieldDuration;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage and gains a **${shield} HP shield** (2 turns)!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // INVENTORY FEAST (Dusttale Endgoal) — heal 35 + clear DoTs
    if (ability.special?.type === 'inventoryFeast') {
      const before = player.currentHp;
      player.currentHp = Math.min(player.maxHp, player.currentHp + ability.special.healAmount);
      player.statusEffects = player.statusEffects.filter(s => !['Bleed', 'Burn', 'Poison'].includes(s.name));
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** 🌭! Healed **${player.currentHp - before} HP** and cleared damage-over-time effects.`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // HELL RUSH (Reaper Chara) — 2-3 hits, 15% -1 DEF each, all-land +crit, 30% bleed
    if (ability.special?.type === 'hellRush') {
      const hits = Math.floor(Math.random() * (ability.special.maxHits - ability.special.minHits + 1)) + ability.special.minHits;
      let total = 0, landed = 0, sm = '';
      for (let i = 0; i < hits; i++) { const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage; landed++; if (Math.random() < ability.special.defDownChance) this.enemy.defMod -= 1; if (!this.enemy.isAlive) break; }
      if (landed >= 3) { player.critBoost = (player.critBoost || 0) + 0.10; sm += ' ✨ *(next move +10% crit)*'; }
      if (Math.random() < ability.special.bleedChance) { this.enemy.addStatus('bleed'); const bl = this.enemy.statusEffects.find(st => st.name === 'Bleed'); if (bl) bl.turnsLeft = ability.special.bleedDuration; sm += ' 🔴 **Bleed!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! ${landed} hits for **${total}**!${sm}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // DEVASTATING HATE (Reaper Chara) — 30% Blindness 3t OR Hate 2t
    if (ability.special?.type === 'devastatingHate') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.procChance) {
        if (Math.random() < 0.5) { this.enemy.addStatus('blindness'); const bl = this.enemy.statusEffects.find(st => st.name === 'Blindness'); if (bl) bl.turnsLeft = ability.special.blindnessDuration; sm = ' 👁️ **Blindness (3t)!**'; }
        else { this.enemy.addStatus('hate'); const ha = this.enemy.statusEffects.find(st => st.name === 'Hate'); if (ha) { ha.turnsLeft = ability.special.hateDuration; ha._caster = player.name; } sm = ' 🖤 **Hate (2t)!**'; }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // DARKNESS SANCTUARY (Reaper Chara) — 3t +3 DEF + status immunity + 1.1x Melee
    if (ability.special?.type === 'darknessSanctuary') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      player.defMod += ability.special.defBuff; player._sanctuaryTurns = ability.special.duration; player._statusImmune = true;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage! Sanctuary active (3 turns: +3 DEF, status immune, +1.1x Melee).`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // DEATH TORNADO (Reaper Chara) — 2-4 hits split, stun if Divine Hatred active, Hemorrhage
    if (ability.special?.type === 'deathTornado') {
      const hits = Math.floor(Math.random() * (ability.special.maxHits - ability.special.minHits + 1)) + ability.special.minHits;
      const full = this.calculateDamage(player, ability, this.enemy);
      const per = Math.max(1, Math.floor(full.totalDamage / hits));
      let total = 0;
      for (let i = 0; i < hits; i++) { this.enemy.takeDamage(per); total += per; if (!this.enemy.isAlive) break; }
      let sm = '';
      const low = (player.currentHp / player.maxHp) < 0.50;
      if (low && this.enemy.isAlive) { this.enemy.addStatus('stun'); sm += ' **Stun!**'; }
      if (this.enemy.isAlive) { this.enemy.addStatus('hemorrhage'); sm += ' 🩸 **Hemorrhage!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! ${hits} hits for **${total}**!${sm}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // GEMSTONE SWITCHUP (Fedora) — 33% -2 DEF
    if (ability.special?.type === 'gemstoneSwitchup') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.defDownChance) { this.enemy.defMod -= ability.special.defDown; sm = ` 💎 -${ability.special.defDown} DEF!`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // CRYSTAL SHAPED BOMB (Fedora) — sets a trap that explodes if enemy attacks next turn
    if (ability.special?.type === 'crystalShapedBomb') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      this.enemy._crystalBomb = { explode: ability.special.explodeDamage, splash: ability.special.splashDamage };
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage! A crystal ball is primed — if the enemy attacks next turn, it explodes for ${ability.special.explodeDamage}!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // CRYSTAL IMPALE (Fedora) — 3-4 hits, 50% Crystallize each
    if (ability.special?.type === 'crystalImpale') {
      const hits = Math.floor(Math.random() * (ability.special.maxHits - ability.special.minHits + 1)) + ability.special.minHits;
      let total = 0, applied = false;
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
        if (Math.random() < ability.special.crystallizeChance) { this._applyCrystallize(this.enemy, d.totalDamage, ability.special.crystallizeDuration); applied = true; }
        if (!this.enemy.isAlive) break;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! ${hits} hits for **${total}**!${applied ? ' 💎 **Crystallize!**' : ''}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // HAT TRICK (Fedora) — 1 of 4 random effects
    if (ability.special?.type === 'hatTrick') {
      const roll = Math.floor(Math.random() * 4); let msg = ''; let dmg = 0;
      if (roll === 0) { player.currentHp = Math.max(0, player.currentHp - 20); msg = '🔫 A gun shoots the fedora — **20 self-damage!**'; }
      else if (roll === 1) { dmg = 50; this.enemy.takeDamage(50); this.enemy.addStatus('stun'); msg = '🎩 The hat explodes — **50 damage** and **Stun!**'; }
      else if (roll === 2) { msg = '...nothing happens. Because it would be funny.'; }
      else { let t = 0; for (let i = 0; i < 7; i++) { this.enemy.takeDamage(5); t += 5; if (Math.random() < 0.75) this._applyCrystallize(this.enemy, 5, ability.special.crystallizeDuration); if (!this.enemy.isAlive) break; } dmg = t; msg = `💎 7 crystals fling out — **${t} damage** + Crystallize!`; }
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **Hat Trick** ✨! ${msg}`, damage: dmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // KETCHUP BLASTER (TS!Underswap Sans) — 10% "Blind" (skip next turn)
    if (ability.special?.type === 'ketchupBlaster') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.blindChance || 0.10)) { this.enemy.addStatus('flinch'); sm = ' 🍅 **Blinded** — enemy can\'t attack next turn!'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // BONE CHASERS (TS!Underswap Sans) — 25% Blue Soul (disable enemy passive 2 turns, no stack, no immediate reapply)
    if (ability.special?.type === 'tsBlueSoul') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.chance || 0.25)) {
        if ((this.enemy._tsBlueSoulTurns || 0) > 0) sm = ' *(Blue Soul already active — cannot stack)*';
        else if ((this.enemy._tsBlueSoulLockout || 0) > 0) sm = ' *(Blue Soul can\'t be re-applied right after it ends)*';
        else {
          this.enemy._tsBlueSoulTurns = ability.special.duration || 2;
          this.enemy._tsDisabledPassive = this.enemy.passive;
          this.enemy.passive = null;
          sm = ' 💙 **Blue Soul** — enemy passive disabled for 2 turns!';
        }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ============================================================
    // UPDATE 18: NEW CHARACTER COMBAT HANDLERS
    // ============================================================

    // --- POSSESSION SANS ---
    // Strangulation: 5 hits, 10% chance per hit to remove 1 DEF+ATK, applies Choked stacks
    if (ability.special?.type === 'strangulation') {
      let total = 0; let sm = '';
      for (let i = 0; i < ability.special.hits; i++) {
        if (!this.enemy.isAlive) break;
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
        if (Math.random() < ability.special.debuffChance) {
          this.enemy.atkMod -= 1; this.enemy.defMod -= 1;
          this.enemy._chokedStacks = (this.enemy._chokedStacks || 0) + 1;
          this.enemy._chokedTurns = (this.enemy._chokedStacks || 0);
          sm += ` **Choked!** (-1 DEF, stacks: ${this.enemy._chokedStacks})`;
        }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${total}** total damage!${sm}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    if (ability.special?.type === 'friendlinesslessBoneThrow') {
      let total = 0; let sm = '';
      for (let i = 0; i < ability.special.hits; i++) {
        if (!this.enemy.isAlive) break;
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
        if (Math.random() < ability.special.debuffChance) {
          if (Math.random() < 0.5) { this.enemy.atkMod -= 1; sm += ` -1 ATK!`; }
          else { this.enemy.defMod -= 1; sm += ` -1 DEF!`; }
          this.enemy._retributionStacks = (this.enemy._retributionStacks || 0) + 1;
        }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${total}** total damage!${sm}${this.enemy._retributionStacks ? ` ATK/DEF Retribution: ${this.enemy._retributionStacks} stacks` : ''}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    if (ability.special?.type === 'floweyBlaster') {
      let total = 0; let sm = '';
      for (let i = 0; i < ability.special.hits; i++) {
        if (!this.enemy.isAlive) break;
        if (Math.random() < ability.special.hitChance) {
          const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
          this.enemy.atkMod -= ability.special.atkDefReduction; this.enemy.defMod -= ability.special.atkDefReduction;
          this.enemy._retributionStacks = (this.enemy._retributionStacks || 0) + 1;
          sm += ` **Hit!** -${ability.special.atkDefReduction} ATK/-${ability.special.atkDefReduction} DEF!`;
        }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}!${sm || ' All shots missed!'}${total > 0 ? ` **${total}** total damage!` : ''}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    if (ability.special?.type === 'theOneInControl') {
      let total = 0; let hits = 0;
      for (let i = 0; i < ability.special.hits; i++) {
        if (!this.enemy.isAlive) break;
        if (Math.random() < ability.special.hitChance) {
          const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage; hits++;
          this.enemy._retributionStacks = (this.enemy._retributionStacks || 0) + 1;
          this.enemy._krStacks = (this.enemy._krStacks || 0) + 1;
        }
      }
      const krDmg = this.enemy._krStacks || 0;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **The One in Control**! ${hits} hits landed for **${total}** damage! KR: **${krDmg}** stacks (deals ${krDmg} dmg next turn, then disappears).`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    if (ability.special?.type === 'rapidShot') {
      // --- UPDATE 22 BUG FIX: 0 bullets is falsy — only init when undefined, otherwise reload never triggered ---
      if (player._bullets === undefined) player._bullets = player.passive?.type === 'theFinalChamber' ? (player.passive.maxShots || 6) : 6;
      // --- UPDATE 22 BUG FIX: 6th shot (last bullet) stuns 1 turn + guaranteed crit ---
      const isFinalShot = player.passive?.type === 'theFinalChamber' && hasPassiveUnlocked(player.level) && player._bullets === 1;
      if (isFinalShot) player.critBoost = 999;
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      if (isFinalShot) { player.critBoost = 0; this.enemy.addStatus('stun'); }
      let total = d.totalDamage; let sm = isFinalShot ? ' 🔫 **THE FINAL CHAMBER!** Guaranteed crit + enemy **Stunned**!' : '';
      if (d.isCrit) {
        const followUp = Math.floor(d.totalDamage * (ability.special.critFollowUpPct || 0.5));
        this.enemy.takeDamage(followUp); total += followUp;
        this.enemy.addStatus('bleed'); sm += ` **CRIT!** Follow-up shot for **${followUp}**! **Bleed** applied!`;
      }
      player._bullets = Math.max(0, (player._bullets || 6) - 1);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${total}** damage!${sm} (Bullets: ${player._bullets}/6)`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    if (ability.special?.type === 'coffeeChug') {
      const healed = player.heal(ability.special.healAmount || 20);
      let sm = `Healed **${healed} HP**!`;
      if (Math.random() < (ability.special.dodgeChance || 0.15)) { player._dodgeNext = true; sm += ' Gained a **dodge** for the next hit!'; }
      ability.cooldownLeft = ability.special.cooldown || 1;
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **Coffee Chug**! ☕ ${sm}`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    if (ability.special?.type === 'blasterSentry') {
      const dur = Math.floor(Math.random() * ((ability.special.maxDuration || 4) - (ability.special.minDuration || 2) + 1)) + (ability.special.minDuration || 2);
      player._blasterSentryTurns = dur; player._blasterSentryAbility = { ...ability };
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** summons a **Mini Gaster Blaster**! It will fire for **${dur}** turns!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    if (ability.special?.type === 'bulletHell') {
      if (player._bullets === undefined) player._bullets = 6;
      if (this.turnNumber < (ability.special.minTurn || 4)) { ability.currentUses++; this.turnNumber--; player.turnCount--; R.playerAction = { success: false, message: `**Bullet Hell** can only be used after turn ${ability.special.minTurn || 4}!` }; return R; }
      const bullets = player._bullets || 0;
      if (bullets < (ability.special.minBullets || 3)) { ability.currentUses++; this.turnNumber--; player.turnCount--; R.playerAction = { success: false, message: `**Bullet Hell** needs at least ${ability.special.minBullets || 3} bullets! (Current: ${bullets})` }; return R; }
      const extraBullets = bullets - (ability.special.minBullets || 3);
      const bonus = extraBullets * (ability.special.bonusPerBullet || 5);
      const d = this.calculateDamage(player, ability, this.enemy); const total = d.totalDamage + bonus;
      this.enemy.takeDamage(total); player._bullets = 0; player._reloadingExtended = true;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** unleashes **Bullet Hell**! Used all ${bullets} bullets! **${total}** damage! (+${bonus} bonus) ⚠️ Reload takes longer!`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    if (ability.special?.type === 'blasterHell') {
      let total = 0;
      for (let i = 0; i < 3; i++) {
        if (!this.enemy.isAlive) break;
        const d = this.calculateDamage(player, ability, this.enemy);
        const dmg = Math.floor(d.totalDamage * (player._oneLeftBuff === i ? 1.3 : 1)); this.enemy.takeDamage(dmg); total += dmg;
      }
      let sm = '';
      if (Math.random() < (ability.special.defReduceChance || 0.15)) { this.enemy.defMod -= 2; sm += ' **-2 DEF!**'; }
      this.enemy.addStatus('karma'); this.enemy.addStatus('poison'); sm += ' **Karma + Poison!**';
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${total}** total damage!${sm}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    if (ability.special?.type === 'bonePiercing') {
      let total = 0;
      for (let i = 0; i < 4; i++) { if (!this.enemy.isAlive) break; const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage; }
      this.enemy.addStatus('bleed');
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! 4 hits for **${total}** total damage! **Bleed!**`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    if (ability.special?.type === 'voidsHell') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let total = d.totalDamage; let sm = '';
      if (Math.random() < (ability.special.doubleChance || 0.30)) { const d2 = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d2.totalDamage); total += d2.totalDamage; sm = ' **Gaster slams twice!**'; }
      this.enemy.addStatus('blindness');
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${total}** damage!${sm} **Blindness!**`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    if (ability.special?.type === 'oneLefHeal') {
      player.maxHp = Math.max(1, player.maxHp - (ability.special.maxHpLoss || 5));
      player.currentHp = Math.min(player.maxHp, player.currentHp);
      const healed = player.heal(ability.special.healAmount || 30);
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **ONE LEFT.**! Healed **${healed} HP** using DETERMINATION. Max HP -${ability.special.maxHpLoss || 5} (now ${player.maxHp}).`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    if (ability.special?.type === 'knifeBarrage') {
      const minH = ability.special.minHits || 3; const maxH = ability.special.maxHits || 7;
      const hits = Math.floor(Math.random() * (maxH - minH + 1)) + minH;
      let total = 0; let crits = 0;
      for (let i = 0; i < hits; i++) {
        if (!this.enemy.isAlive) break;
        const critRoll = Math.random() < (ability.special.critChance || 0.20);
        const d = this.calculateDamage(player, { ...ability, _forceCrit: critRoll }, this.enemy);
        const dmg = critRoll ? Math.floor(d.totalDamage * 1.5) : d.totalDamage;
        this.enemy.takeDamage(dmg); total += dmg; if (critRoll) crits++;
      }
      let sm = crits > 0 ? ` ${crits} CRIT(s)!` : '';
      if (hits >= (ability.special.stunThreshold || 5) && Math.random() < (ability.special.stunChance || 0.20)) { this.enemy.addStatus('stun'); sm += ' **Stunned!**'; }
      if (player.passive?.type === 'lethalExchange') { player._lethalMeleeHit = true; player._lethalMagicBoost = player.passive.magicBoost || 1.2; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! ${hits} hits for **${total}** total damage!${sm}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    if (ability.special?.type === 'lethalGoopBlasters') {
      if (!player._lethalGoopCharging) {
        player._lethalGoopCharging = true; player.defMod += (ability.special.selfDebuff?.def || -2); player._lethalGoopDebuff = ability.special.selfDebuff?.def || -2;
        R.playerAction = { success: true, message: `**${player.name}** is charging **Lethal Goop Blasters**... DEF -${Math.abs(player._lethalGoopDebuff)}!`, damage: 0 };
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
      player._lethalGoopCharging = false; player.defMod -= (player._lethalGoopDebuff || -2); player._lethalGoopDebuff = 0;
      const d = this.calculateDamage(player, ability, this.enemy);
      let total = d.totalDamage;
      if ((player.currentHp / player.maxHp) < (ability.special.lowHpThreshold || 0.5)) total += (ability.special.lowHpBonus || 5);
      this.enemy.takeDamage(total); let sm = '';
      if (Math.random() < (ability.special.karmaChance || 0.40)) { const sr = this.enemy.addStatus('karma'); if (sr) sm = ' **Karma!**'; }
      if (player.passive?.type === 'lethalExchange') { player._lethalMagicBoost = player.passive.magicBoost || 1.2; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** releases **Lethal Goop Blasters**! **${total}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    if (ability.special?.type === 'theFinalBargain') {
      if (this.turnNumber < (ability.special.minTurn || 4)) { R.playerAction = { success: false, message: `**The Final Bargain** can only be used after turn ${ability.special.minTurn || 4}!` }; return R; }
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      const killed = !this.enemy.isAlive;
      const selfDmg = killed ? (ability.special.killSelfDmg || 10) : (ability.special.selfDmg || 20);
      player.currentHp = Math.max(1, player.currentHp - selfDmg);
      let sm = ` (Self: ${selfDmg} dmg)`;
      if (killed) { player.atkMod += (ability.special.killAtkBoost || 2); sm += ` 💀 **The deal is done!** +${ability.special.killAtkBoost || 2} ATK! No cooldown!`; }
      else { ability.cooldownLeft = ability.special.cooldown || 2; }
      if (player.passive?.type === 'lethalExchange') { player._lethalMeleeHit = true; player._lethalMagicBoost = player.passive.magicBoost || 1.2; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **The Final Bargain**! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (killed) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // --- UPDATE 18: Flame Eye handlers ---
    if (ability.special?.type === 'flameEyeBurn') {
      const hits = ability.special.hits || 1; let total = 0; let isCrit = false;
      for (let i = 0; i < hits; i++) { const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage; if (d.isCrit) isCrit = true; if (!this.enemy.isAlive) break; }
      let burnMsg = '';
      if (Math.random() < (ability.special.hellfireChance || 0)) { const sr = this.enemy.addStatus('hellfire'); if (sr) burnMsg = ' **HELLFIRE applied!**'; }
      else { const sr = this.enemy.addStatus('burn'); if (sr) burnMsg = ' **Burn applied!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      const hitMsg = hits > 1 ? ` ${hits} hits, **${total}** total!` : '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}!${hitMsg}${hits === 1 ? ` **${total}** damage!` : ''}${isCrit ? ' **CRIT!**' : ''}${burnMsg}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    if (ability.special?.type === 'flameEyeRoar') {
      if (!player._flameEyeRoarCharging) {
        player._flameEyeRoarCharging = true;
        if (ability.special.selfDebuff?.atk) player.atkMod += ability.special.selfDebuff.atk;
        if (ability.special.selfDebuff?.def) player.defMod += ability.special.selfDebuff.def;
        player._flameEyeRoarDebuff = { ...ability.special.selfDebuff };
        R.playerAction = { success: true, message: `**${player.name}** ${ability.special.chargeMessage || 'is charging...'}`, damage: 0 };
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
      const bypass = ability.special.defBypass || 0;
      const reduction = Math.floor(this.enemy.def * bypass); this.enemy.defMod -= reduction;
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.defMod += reduction; this.enemy.takeDamage(d.totalDamage);
      if (player._flameEyeRoarDebuff) { if (player._flameEyeRoarDebuff.atk) player.atkMod -= player._flameEyeRoarDebuff.atk; if (player._flameEyeRoarDebuff.def) player.defMod -= player._flameEyeRoarDebuff.def; player._flameEyeRoarDebuff = null; }
      player._flameEyeRoarCharging = false;
      const sr = this.enemy.addStatus('blindness'); let blindMsg = sr ? ` **Blinded** for ${ability.special.blindnessDuration || 4} turns!` : '';
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** unleashes **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} *(${Math.round(bypass * 100)}% DEF bypassed!)*${blindMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // --- TS!Sans karma handler (and any other move with type: 'karma') ---
    if (ability.special?.type === 'karma') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let karmaMsg = '';
      if (Math.random() < (ability.special.chance || 1.0)) {
        const sr = this.enemy.addStatus('karma');
        const k = this.enemy.statusEffects?.find(s => s.name === 'Karma');
        if (k && ability.special.duration) k.turnsLeft = ability.special.duration;
        if (sr) karmaMsg = ` ☯️ **Karma** applied for ${ability.special.duration || 2} turn(s)!`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${karmaMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // --- UPDATE 22: Meteor Cataclysm (Outerdust) — burn; vs already-burned target: flinch + pierce 10% DEF, 2 turn CD on flinch ---
    if (ability.special?.type === 'meteorCataclysm') {
      const alreadyBurned = this.enemy.hasStatus('Burn') || this.enemy.hasStatus('Hellfire');
      let pierceReduce = 0;
      if (alreadyBurned && ability.special.defPierce) {
        pierceReduce = Math.floor(this.enemy.def * ability.special.defPierce);
        if (pierceReduce > 0) this.enemy.defMod -= pierceReduce;
      }
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      if (pierceReduce > 0) this.enemy.defMod += pierceReduce;
      let sm = '';
      const br = this.enemy.addStatus('burn'); if (br) sm += ' **Burn applied!**';
      if (alreadyBurned) {
        this.enemy.addStatus('flinch');
        ability.cooldownLeft = (ability.special.flinchCooldown || 2) + 1;
        sm += ' ☄️ The burning target **flinches** (pierced 10% DEF)!';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Here Comes the Sun (sunBurn)
    if (ability.special?.type === 'sunBurn') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let burnMsg = '';
      if (Math.random() < (ability.special.hellfireChance || 0.33)) {
        const sr = this.enemy.addStatus('hellfire');
        if (sr) burnMsg = ' **HELLFIRE applied!**';
        // --- UPDATE 22: Hellfire landing destroys enemy DEF and grants Outerdust DEF ---
        if (sr && ability.special.hellfireDefDestroy) {
          this.enemy.defMod -= ability.special.hellfireDefDestroy;
          player.defMod += (ability.special.selfDefGain || 0);
          burnMsg += ` Enemy **-${ability.special.hellfireDefDestroy} DEF**, ${player.name} **+${ability.special.selfDefGain || 0} DEF**!`;
        }
      } else {
        const burnKey = (ability.special.burnDuration || 2) >= 3 ? 'burn3' : 'burn';
        const sr = this.enemy.addStatus(burnKey);
        if (sr) burnMsg = ' **Burn applied!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${burnMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }


    // ============================================================
    // === UPDATE 19 ABILITY HANDLERS ===
    // ============================================================

    // REAPER SANS: Scythe Sweep (1-3 hits, each applies Death's Touch)
    if (ability.special?.type === 'scytheSweep') {
      const hits = Math.floor(Math.random() * (ability.special.maxHits - ability.special.minHits + 1)) + ability.special.minHits;
      let total = 0;
      for (let i = 0; i < hits; i++) {
        if (!this.enemy.isAlive) break;
        const d = this.calculateDamage(player, ability, this.enemy);
        this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
      }
      // Stack death touch equal to number of hits
      for (let i = 0; i < hits; i++) this.applyFearOfDeath(player, this.enemy);
      const stacks = this.enemy._deathTouchStacks || 0;
      const emoji = TYPES[ability.type]?.emoji || '';
      const markedMsg = this.isMarkedForDeath(this.enemy) ? ' ☠️ **Enemy is MARKED!**' : '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! ${hits} hit${hits > 1 ? 's' : ''} for **${total}** damage! 💀 Death's Touch: **${stacks}/5** stacks!${markedMsg}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // REAPER SANS: Soul Reaper (heals per Death's Touch stack, no consume)
    if (ability.special?.type === 'soulReaper') {
      const stacks = this.enemy._deathTouchStacks || 0;
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      this.applyFearOfDeath(player, this.enemy);
      let healMsg = '';
      if (stacks > 0) {
        const healAmt = stacks * (ability.special.healPerStack || 5);
        player.heal(healAmt);
        healMsg = ` Healed **${healAmt} HP** (${stacks} stacks × ${ability.special.healPerStack || 5})!`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${healMsg} Stacks: **${this.enemy._deathTouchStacks || 0}/5**`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // REAPER SANS: Death Blaster (stun + poison if 3+ stacks, can't use back to back)
    if (ability.special?.type === 'deathBlaster') {
      if (player._deathBlasterUsedLastTurn) {
        R.playerAction = { success: false, message: '**Death Blaster** cannot be used twice in a row!' };
        ability.currentUses++; return R;
      }
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      this.applyFearOfDeath(player, this.enemy);
      let extras = '';
      if ((this.enemy._deathTouchStacks || 0) >= (ability.special.stackThreshold || 3)) {
        this.enemy.addStatus('stun'); extras += ' **STUNNED!**';
        this.enemy.addStatus('poison'); extras += ' **Poisoned!**';
      }
      player._deathBlasterUsedLastTurn = true;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // REAPER SANS: The Grand Harvest (requires Marked, ignores DEF)
    if (ability.special?.type === 'grandHarvest') {
      if (!this.isMarkedForDeath(this.enemy)) {
        R.playerAction = { success: false, message: '**The Grand Harvest** can only be used when the enemy is **Marked** (5 Death\'s Touch stacks)!' };
        ability.currentUses++; return R;
      }
      // --- UPDATE 30: Grand Harvest pierces 50% DEF + lifesteals 15% of damage dealt ---
      const _hvPierce = Math.floor(this.enemy.def * (ability.special.defPiercePercent || 0.50));
      this.enemy.defMod -= _hvPierce;
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.defMod += _hvPierce;
      // Apply 1.5x from Marked
      const finalDmg = Math.floor(d.totalDamage * 1.5);
      const result = this.enemy.takeDamage(finalDmg);
      const _hvLifesteal = player.heal(Math.floor(finalDmg * (ability.special.lifestealPercent || 0.15)));
      // Consume all stacks + set cooldown
      this.enemy._deathTouchStacks = 0;
      player._deathTouchCooldown = 1;
      const killed = !this.enemy.isAlive;
      let extras = '';
      if (killed) { const healed = player.heal(Math.floor(player.maxHp * (ability.special.healOnKillPercent || 0.10))); extras = ` 💀 **DEATH!** Healed **${healed} HP**!`; }
      else { const recoil = Math.floor(player.currentHp * (ability.special.recoilOnNoKillPercent || 0.20)); player.currentHp = Math.max(1, player.currentHp - recoil); extras = ` ⚠️ Missed kill — **${recoil} HP** recoil!`; }
      const _hvLifeMsg = _hvLifesteal > 0 ? ` 🩸 Lifesteal **+${_hvLifesteal} HP**!` : '';
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** unleashes **${ability.name}** ${emoji}! **${finalDmg}** damage (1.5x Marked, 50% DEF pierced)!${_hvLifeMsg}${extras} All Death's Touch stacks consumed.`, damage: finalDmg };
      if (killed) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // GREEN SANS: Lightsaber Slash
    if (ability.special?.type === 'lightSaberSlash') {
      const d = this.calculateDamage(player, ability, this.enemy);
      // Apply aura farm multiplier
      let finalDmg = d.totalDamage;
      if (player._auraFarmActive) { finalDmg = Math.floor(finalDmg * (player.passive?.multiplier || 1.5)); player._auraFarmActive = false; }
      this.enemy.takeDamage(finalDmg);
      let extras = '';
      if (Math.random() < (ability.special.bleedChance || 0.25)) { this.enemy.addStatus('bleed'); extras += ' **Bleed!**'; }
      if (Math.random() < (ability.special.burnChance || 0.25)) { this.enemy.addStatus('burn'); extras += ' **Burn!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${finalDmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: finalDmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // GREEN SANS: I will break your spine column (fixed 60 dmg + bleed)
    if (ability.special?.type === 'spineColumn') {
      let finalDmg = 60;
      if (player._auraFarmActive) { finalDmg = Math.floor(finalDmg * (player.passive?.multiplier || 1.5)); player._auraFarmActive = false; }
      this.enemy.takeDamage(finalDmg);
      this.enemy.addStatus('bleed');
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${finalDmg}** fixed damage! **Bleed applied!**`, damage: finalDmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // SERAPHIM: Justice will Remain (2 hits, bleed + karma per hit)
    if (ability.special?.type === 'justiceWillRemain') {
      const hits = ability.special.hits || 2;
      let total = 0; let bleedApplied = false; let karmaApplied = false;
      for (let i = 0; i < hits; i++) {
        if (!this.enemy.isAlive) break;
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
        if (!bleedApplied && Math.random() < (ability.special.bleedChance || 0.45)) { this.enemy.addStatus('bleed'); bleedApplied = true; }
        if (!karmaApplied && Math.random() < (ability.special.karmaChance || 0.45)) { this.enemy.addStatus('karma'); karmaApplied = true; }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! ${hits} hits for **${total}** total!${bleedApplied ? ' **Bleed!**' : ''}${karmaApplied ? ' **Karma!**' : ''}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // SERAPHIM: Soul Infused Blast (120 fixed, once per enemy)
    if (ability.special?.type === 'soulInfusedBlast') {
      if (player._soulBlastUsedOnThisEnemy) {
        R.playerAction = { success: false, message: '**Soul Infused Blast** can only be used **ONCE per enemy!**' };
        ability.currentUses++; return R;
      }
      player._soulBlastUsedOnThisEnemy = true;
      this.enemy.takeDamage(120);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** channels all soul energy into **${ability.name}** ${emoji}! **120** fixed damage!`, damage: 120 };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ROARING KNIGHT CHAR: Sword Throw
    if (ability.special?.type === 'rkSwordThrow') {
      const d = this.calculateDamage(player, ability, this.enemy);
      let finalDmg = d.totalDamage;
      // +15 if previous turn was Knife Thrust
      if (player._rkKnifeThrustLastTurn) { finalDmg += 15; player._rkKnifeThrustLastTurn = false; }
      // Check if this is the marked move
      if (player._rkMarkedIndex === player.abilities.indexOf(ability)) {
        player.atkMod += 2; player.defMod += 2; finalDmg += 12;
        player._rkMarkedBuff = 1; player._rkMarkedIndex = -1;
        if (!R.rkMarkUsed) R.rkMarkUsed = `⚔️ **MARKED move used!** +2 ATK, +2 DEF for 1 turn, +12 bonus damage!`;
      }
      this.enemy.takeDamage(finalDmg);
      player._rkSwordThrowLastTurn = true;
      let extras = '';
      if (Math.random() < (ability.special.bleedChance || 0.40)) { this.enemy.addStatus('bleed'); extras += ' **Bleed!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${finalDmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: finalDmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ROARING KNIGHT CHAR: Star Storm (applies Star Shards stacks)
    if (ability.special?.type === 'rkStarStorm') {
      const d = this.calculateDamage(player, ability, this.enemy);
      let finalDmg = d.totalDamage;
      if (player._rkMarkedIndex === player.abilities.indexOf(ability)) {
        player.atkMod += 2; player.defMod += 2; finalDmg += 12;
        player._rkMarkedBuff = 1; player._rkMarkedIndex = -1;
        if (!R.rkMarkUsed) R.rkMarkUsed = `⚔️ **MARKED move used!** +2 ATK, +2 DEF for 1 turn, +12 bonus damage!`;
      }
      this.enemy.takeDamage(finalDmg);
      const stacks = ability.special.starShardsStacks || 2;
      this.enemy._starShardsStacks = (this.enemy._starShardsStacks || 0) + stacks;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${finalDmg}** damage!${d.isCrit ? ' **CRIT!**' : ''} 🌟 Applied **${stacks} Star Shards** stacks! (Total: ${this.enemy._starShardsStacks})`, damage: finalDmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ROARING KNIGHT CHAR: Knife Thrust (blind + force switch chance)
    if (ability.special?.type === 'rkKnifeThrust') {
      const d = this.calculateDamage(player, ability, this.enemy);
      let finalDmg = d.totalDamage;
      if (player._rkMarkedIndex === player.abilities.indexOf(ability)) {
        player.atkMod += 2; player.defMod += 2; finalDmg += 12;
        player._rkMarkedBuff = 1; player._rkMarkedIndex = -1;
        if (!R.rkMarkUsed) R.rkMarkUsed = `⚔️ **MARKED move used!** +2 ATK, +2 DEF for 1 turn, +12 bonus damage!`;
      }
      this.enemy.takeDamage(finalDmg);
      player._rkKnifeThrustLastTurn = true; player._rkSwordThrowLastTurn = false;
      let extras = '';
      if (Math.random() < (ability.special.blindChance || 0.35)) { this.enemy.addStatus('blindness'); extras += ' **Blinded!**'; }
      if (Math.random() < (ability.special.forceSwitchChance || 0.10) && this.isPvP) {
        this.enemy._forceSwitchNextTurn = true; extras += ' **Force switch triggered!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${finalDmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: finalDmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ROARING KNIGHT CHAR: Reality Cut (-3 uses from enemy move)
    if (ability.special?.type === 'rkRealityCut') {
      const d = this.calculateDamage(player, ability, this.enemy);
      let finalDmg = d.totalDamage;
      if (player._rkMarkedIndex === player.abilities.indexOf(ability)) {
        player.atkMod += 2; player.defMod += 2; finalDmg += 12;
        player._rkMarkedBuff = 1; player._rkMarkedIndex = -1;
        if (!R.rkMarkUsed) R.rkMarkUsed = `⚔️ **MARKED move used!** +2 ATK, +2 DEF for 1 turn, +12 bonus damage!`;
      }
      this.enemy.takeDamage(finalDmg);
      // Drain 3 uses from a random ability
      const validAbilities = this.enemy.abilities.filter(a => a.currentUses > 0);
      let drainMsg = '';
      if (validAbilities.length > 0) {
        const target = validAbilities[Math.floor(Math.random() * validAbilities.length)];
        const drained = Math.min(target.currentUses, ability.special.usesDrain || 3);
        target.currentUses -= drained;
        drainMsg = ` 🌑 **Reality Cut** drained **${drained} uses** from **${target.name}**!`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${finalDmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${drainMsg}`, damage: finalDmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ROARING KNIGHT BOSS: Star Storm
    if (ability.special?.type === 'rkBossStarStorm') {
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      const stacks = ability.special.starShardsStacks || 2;
      this.enemy._starShardsStacks = (this.enemy._starShardsStacks || 0) + stacks;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} 🌟 Applied **${stacks} Star Shards** stacks!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ROARING KNIGHT BOSS: Sword Throw
    if (ability.special?.type === 'rkBossSwordThrow') {
      const d = this.calculateDamage(player, ability, this.enemy);
      let finalDmg = d.totalDamage;
      if (this.enemy._knifeWasLastMove) { finalDmg += (ability.special.knifeBonus || 5); }
      this.enemy.takeDamage(finalDmg); this.enemy._swordThrowLastMove = true; this.enemy._knifeWasLastMove = false;
      let extras = '';
      if (Math.random() < (ability.special.bleedChance || 0.40)) { this.activePlayer.addStatus('bleed'); extras += ' **Bleed!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}** ${emoji}! **${finalDmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: finalDmg };
      return R;
    }

    // ROARING KNIGHT BOSS: Knife Thrust
    if (ability.special?.type === 'rkBossKnifeThrust') {
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage); this.enemy._knifeWasLastMove = true; this.enemy._swordThrowLastMove = false;
      let extras = '';
      if (Math.random() < (ability.special.forceSwitchChance || 0.10)) {
        // Force switch active player to next alive slot
        const nextIdx = this.playerTeam.findIndex((f, i) => f.isAlive && i !== this.activePlayerIndex);
        if (nextIdx !== -1) { this.activePlayerIndex = nextIdx; extras += ` **Force Switch!** ${this.playerTeam[nextIdx].name} is now active!`; }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
      return R;
    }

    // ROARING KNIGHT BOSS: Reality Cut
    if (ability.special?.type === 'rkBossRealityCut') {
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      const validAbils = this.activePlayer.abilities.filter(a => a.currentUses > 0);
      let drainMsg = '';
      if (validAbils.length > 0) {
        const target = validAbils[Math.floor(Math.random() * validAbils.length)];
        const drain = Math.min(target.currentUses, ability.special.usesDrain || 3);
        target.currentUses -= drain;
        drainMsg = ` 🌑 Drained **${drain} uses** from **${target.name}**!`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${drainMsg}`, damage: d.totalDamage };
      return R;
    }

    // ============================================================
    // === END UPDATE 19 ABILITY HANDLERS ===
    // ============================================================

    // ============================================================
    // === UPDATE 20 ABILITY HANDLERS ===
    // ============================================================

    // PESTI SANS: apply Rust generic
    if (ability.special?.type === 'applyRust') {
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      let extras = '';
      if (Math.random() < (ability.special.chance || 1.0)) {
        const sr = this.enemy.addStatus('rust');
        if (sr) extras = ' **Rust applied!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // PESTI SANS: INFECTED GASTER BLASTERS — 50% miss + 25% rust 2 turns
    if (ability.special?.type === 'infectedGasterBlasters') {
      const emoji = TYPES[ability.type]?.emoji || '';
      if (Math.random() < (ability.special.missChance || 0.5)) {
        R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! ... **It missed!**`, damage: 0 };
        if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      let extras = '';
      if (Math.random() < (ability.special.rustChance || 0.25)) {
        const sr = this.enemy.addStatus('rust');
        if (sr) extras = ' **Rust applied!**';
      }
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // PESTI SANS: CONCENTRATED PIPE BLAST — 200 fixed dmg + rust + self damage
    if (ability.special?.type === 'concentratedPipeBlast') {
      const dmg = ability.damageMin || 200;
      this.enemy.takeDamage(dmg);
      this.enemy.addStatus('rust');
      // --- UPDATE 22: char version Rust lasts 1-2 turns (random) ---
      if (ability.special.rustDurationMin) {
        const rust = this.enemy.statusEffects.find(st => st.name === 'Rust');
        if (rust) rust.turnsLeft = Math.floor(Math.random() * ((ability.special.rustDurationMax || 2) - ability.special.rustDurationMin + 1)) + ability.special.rustDurationMin;
      }
      let selfDmg = ability.special.selfDamage || 200;
      // --- UPDATE 22: -15 self damage per duplicate Pesti on the team ---
      if (ability.special.duplicateReduction) {
        const dupes = this.playerTeam.filter(f => f.id === player.id).length - 1;
        if (dupes > 0) selfDmg = Math.max(0, selfDmg - dupes * ability.special.duplicateReduction);
      }
      player.currentHp = Math.max(0, player.currentHp - selfDmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${dmg}** fixed damage! **Rust applied!** ⚠️ ${player.name} takes **${selfDmg}** damage from the blast!`, damage: dmg };
      if (player.currentHp <= 0) {
        if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // FFTBO: Their Sins — 20% slam twice + stun 1 turn, Bleed 2 turns
    if (ability.special?.type === 'fftboTheirSins') {
      const d = this.calculateDamage(player, ability, this.enemy);
      let finalDmg = d.totalDamage;
      let extras = '';
      if (Math.random() < (ability.special.slamTwiceChance || 0.2)) {
        const d2 = this.calculateDamage(player, ability, this.enemy);
        finalDmg += d2.totalDamage;
        const sr = this.enemy.addStatus('stun');
        if (sr) extras += ' 🦴 **Slam twice + Blue Bone Zone Stun!**';
      }
      this.enemy.takeDamage(finalDmg);
      const br = this.enemy.addStatus('bleed');
      const bleed = this.enemy.statusEffects.find(s => s.name === 'Bleed');
      if (bleed) bleed.turnsLeft = ability.special.bleedDuration || 2;
      if (br) extras += ' **Bleed!**';
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${finalDmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: finalDmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // FFTBO: human, you're cooked. — 5 hits + KR + Bleed
    if (ability.special?.type === 'fftboCooked') {
      const hits = ability.special.hits || 5;
      let total = 0; let isCrit = false;
      for (let i = 0; i < hits; i++) { const d = this.calculateDamage(player, ability, this.enemy); total += d.totalDamage; if (d.isCrit) isCrit = true; }
      this.enemy.takeDamage(total);
      const kr = this.enemy.addStatus('karma');
      const k = this.enemy.statusEffects.find(s => s.name === 'Karma'); if (k) k.turnsLeft = ability.special.krDuration || 2;
      const br = this.enemy.addStatus('bleed');
      const bleed = this.enemy.statusEffects.find(s => s.name === 'Bleed'); if (bleed) bleed.turnsLeft = ability.special.bleedDuration || 2;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${hits} hits**, **${total}** total damage!${isCrit ? ' **CRIT!**' : ''} **Karma + Bleed!**`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // FFTBO: BONELIEST. — Blindness + Bleed for 2 turns
    if (ability.special?.type === 'fftboBoneliest') {
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      const bl = this.enemy.addStatus('blindness');
      const blS = this.enemy.statusEffects.find(s => s.name === 'Blindness'); if (blS) blS.turnsLeft = ability.special.blindDuration || 2;
      const br = this.enemy.addStatus('bleed');
      const bleed = this.enemy.statusEffects.find(s => s.name === 'Bleed'); if (bleed) bleed.turnsLeft = ability.special.bleedDuration || 2;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `💀 **${player.name}** turns into **BONELIEST.** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} **Blindness + Bleed!**`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // EVAN'S DUST: MEMORIES! Dodge — disable enemy attacks for 1 round
    if (ability.special?.type === 'memoriesDodge') {
      const sr = this.enemy.addStatus('memoriesDodge');
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `💭 **${player.name}** used **${ability.name}** ${emoji}! Enemy attacks **disabled for 1 round!**`, damage: 0 };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ============================================================
    // === END UPDATE 20 ABILITY HANDLERS ===
    // ============================================================

    // SINGULARITY
    if (ability.special?.type === 'singularity') {
      const dur = (ability.special.duration || 2) + 1; // +1 because endTurn decrements same turn
      player._singularityTurns = dur;
      player._singularityStored = 0;
      this.enemy._singularityTurns = dur;
      this.enemy._singularityStored = 0;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** activated **SINGULARITY** ${emoji}! Both fighters are absorbed... after 2 turns, 70% of damage stored explodes!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ---- JUDGEMENT HALL DUST SANS ----
    // Vengeful Rend
    if (ability.special?.type === 'vengefulRend') {
      const roll = Math.random();
      let abilityCopy = { ...ability };
      let bonusMsg = '';
      if (roll < 1/3) {
        // Burn
        const d = this.calculateDamage(player, abilityCopy, this.enemy); this.enemy.takeDamage(d.totalDamage);
        const sr = this.enemy.addStatus('burn'); if (sr) bonusMsg = ' **Burn!**';
        const emoji = TYPES[ability.type]?.emoji || '';
        R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${bonusMsg}`, damage: d.totalDamage };
      } else if (roll < 2/3) {
        // Stun
        const d = this.calculateDamage(player, abilityCopy, this.enemy); this.enemy.takeDamage(d.totalDamage);
        const sr = this.enemy.addStatus('stun'); if (sr) bonusMsg = ' **Stunned!**';
        const emoji = TYPES[ability.type]?.emoji || '';
        R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${bonusMsg}`, damage: d.totalDamage };
      } else {
        // Boosted damage only (1.25x)
        abilityCopy.damageMin = Math.floor(ability.damageMin * 1.25);
        abilityCopy.damageMax = Math.floor(ability.damageMax * 1.25);
        const d = this.calculateDamage(player, abilityCopy, this.enemy); this.enemy.takeDamage(d.totalDamage);
        const emoji = TYPES[ability.type]?.emoji || '';
        R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} *(Boosted!)*`, damage: d.totalDamage };
      }
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Octo Blasters
    if (ability.special?.type === 'octoBlasters') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let extras = '';
      if (Math.random() < (ability.special.poisonChance || 0.2)) { const sr = this.enemy.addStatus('poison'); if (sr) extras += ' **Poisoned!**'; }
      if (Math.random() < (ability.special.boundChance || 0.1)) { const sr = this.enemy.addStatus('bound'); if (sr) { extras += ' **Bound!**'; player._nextAttackGuaranteed = true; } }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Stolen Magic — picks a random boss attack effect
    if (ability.special?.type === 'stolenMagic') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      const choices = ['toriel', 'papyrus', 'undyne', 'mettaton', 'asgore'];
      const pick = choices[Math.floor(Math.random() * choices.length)];
      let stealMsg = '';
      if (pick === 'toriel') { const sr = this.enemy.addStatus('burn'); if (sr) stealMsg = ' Stole from Toriel — **Burn applied!**'; }
      else if (pick === 'papyrus') { const sr = this.enemy.addStatus('blueSoul'); if (sr) stealMsg = ' Stole from Papyrus — **Blue Soul applied!**'; }
      else if (pick === 'undyne') { player.critBoost = (player.critBoost || 0) + 0.25; stealMsg = ' Stole from Undyne — **+25% crit chance next turn!**'; }
      else if (pick === 'mettaton') { const extra = Math.floor(d.totalDamage * 0.5); this.enemy.takeDamage(extra); stealMsg = ` Stole from Mettaton — pierced for **+${extra}** dmg!`; }
      else if (pick === 'asgore') { this.enemy._skipNextTurn = true; stealMsg = ' Stole from Asgore — enemy **skips next turn!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${stealMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // "My Strongest Attack"
    if (ability.special?.type === 'myStrongestAttack') {
      const hpRatio = player.hp / (player.maxHp || player.hp);
      if (hpRatio > (ability.special.hpThreshold || 0.05)) {
        R.playerAction = { success: false, message: `**${ability.name}** can only be used below 5% HP!` };
        return R;
      }
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      this.enemy._myStrongestActive = true; // signals end-of-turn poison + hellfire ticks
      this.enemy.addStatus('stun');
      this.enemy.defMod = (this.enemy.defMod || 0) - (ability.special.defReducePermanent || 2);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} Enemy **Stunned**, -2 DEF permanent, Poison + Hellfire end of turn!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ---- HOTLANDS DUST SANS ----
    // Bone Shifter
    if (ability.special?.type === 'boneShifter') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      // Mark to apply bonus on enemy if they use Melee/Unique this turn (handled in enemy turn)
      this.enemy._boneShifterTrap = ability.special.tripDamage || 10;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} Bones laid as a trap!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Shockwave Canon Bomb
    if (ability.special?.type === 'shockwaveCanon') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let dMsg = '';
      if (Math.random() < (ability.special.disableChance || 0.2) && this.enemy.abilities && this.enemy.abilities.length > 0) {
        const idx = Math.floor(Math.random() * this.enemy.abilities.length);
        if (!this.enemy._disabledAbilities) this.enemy._disabledAbilities = {};
        this.enemy._disabledAbilities[idx] = ability.special.disableDuration || 2;
        dMsg = ` Disabled **${this.enemy.abilities[idx].name}** for ${ability.special.disableDuration || 2} turns!`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${dMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Stolen NEO Tech
    if (ability.special?.type === 'stolenNeoTech') {
      if (Math.random() < (ability.special.failChance || 0.25)) {
        const selfDmg = ability.special.selfDamage || 25;
        player.hp = Math.max(1, player.hp - selfDmg);
        const emoji = TYPES[ability.type]?.emoji || '';
        R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** tried **${ability.name}** ${emoji}! It backfired — took **${selfDmg}** self damage!`, damage: 0 };
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ---- CORE DUST SANS ----
    // Gun Beam (pierce DEF)
    if (ability.special?.type === 'gunBeam') {
      const pierceAmt = ability.special.pierceAmount || 0.20;
      const reduction = Math.floor(this.enemy.def * pierceAmt);
      this.enemy.defMod -= reduction;
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.defMod += reduction;
      this.enemy.takeDamage(d.totalDamage);
      if (player.passive?.type === 'coreOverload' && hasPassiveUnlocked(player.level) && !player._coreDisabled) {
        player._coreCharge = (player._coreCharge || 0) + 1;
        if (player._coreCharge >= 3) { player._coreOverloadSurge = true; player._coreCharge = 0; }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} *(${Math.round(pierceAmt * 100)}% DEF pierced!)*`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Gravity Well
    if (ability.special?.type === 'gravityWell') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let bsMsg = '';
      if (Math.random() < (ability.special.blueSoulChance || 0.25)) {
        this.enemy._passiveDisabledTurns = 1;
        this.enemy._missChanceBonus = (this.enemy._missChanceBonus || 0) + (ability.special.missAmount || 0.1);
        this.enemy._missChanceBonusTurns = 1;
        bsMsg = ' **Blue Soul!** Passive disabled, +10% miss next turn.';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${bsMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Spotlight Gaster Blaster
    if (ability.special?.type === 'spotlightGB') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      player._spotlightTurns = ability.special.accuracyTurns || 2;
      let stunMsg = '';
      if (Math.random() < (ability.special.stunChance || 0.3)) { const sr = this.enemy.addStatus('stun'); if (sr) stunMsg = ' **Stunned!**'; }
      // Magic move builds Core Charge
      if (player.passive?.type === 'coreOverload' && hasPassiveUnlocked(player.level) && !player._coreDisabled) {
        player._coreCharge = (player._coreCharge || 0) + 1;
        if (player._coreCharge >= 3) { player._coreOverloadSurge = true; player._coreCharge = 0; }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} 100% accuracy for 2 turns!${stunMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Meltdown Flash
    if (ability.special?.type === 'meltdownFlash') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let burnMsg = '';
      if (Math.random() < (ability.special.burnChance || 0.4)) {
        const burnKey = (ability.special.burnDuration || 3) >= 3 ? 'burn3' : 'burn';
        const sr = this.enemy.addStatus(burnKey); if (sr) burnMsg = ' **Burn applied!**';
      }
      player._coreDisabled = ability.special.disableTurns || 2;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${burnMsg} Core Overload disabled 2 turns!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ---- STORYSHIFT CHARA ----
    // Knife Barrage (multi-hit, all 5 = double final + bleed)
    if (ability.special?.type === 'knifeBarrage') {
      const minH = ability.special.minHits || 2; const maxH = ability.special.maxHits || 5;
      const hits = Math.floor(Math.random() * (maxH - minH + 1)) + minH;
      let total = 0; let lastDmg = 0; let bleedMsg = '';
      for (let i = 0; i < hits; i++) {
        if (!this.enemy.isAlive) break;
        let abilityCopy = { ...ability };
        if (i === hits - 1 && hits >= (ability.special.allHitsThreshold || 5)) {
          abilityCopy.damageMin = ability.damageMin * 2; abilityCopy.damageMax = ability.damageMax * 2;
          const sr = this.enemy.addStatus('bleed'); if (sr) bleedMsg = ' **Bleed!**';
        }
        const d = this.calculateDamage(player, abilityCopy, this.enemy); this.enemy.takeDamage(d.totalDamage);
        total += d.totalDamage; lastDmg = d.totalDamage;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! ${hits} hits for **${total}** damage!${bleedMsg}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Chaos Busters (2 hits, poison/flinch)
    if (ability.special?.type === 'chaosBusters') {
      const hits = ability.special.hits || 2;
      let total = 0;
      for (let i = 0; i < hits; i++) {
        if (!this.enemy.isAlive) break;
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
      }
      let extras = '';
      if (Math.random() < (ability.special.poisonChance || 0.15)) { const sr = this.enemy.addStatus('poison'); if (sr) extras += ' **Poisoned!**'; }
      if (Math.random() < (ability.special.flinchChance || 0.10)) { const sr = this.enemy.addStatus('flinch'); if (sr) extras += ' **Flinched!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! ${hits} hits for **${total}** damage!${extras}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Pellet Circle (block bypass)
    if (ability.special?.type === 'pelletCircle') {
      const d = this.calculateDamage(player, ability, this.enemy);
      let total = d.totalDamage;
      if (this.enemy._isBlocking) {
        total = Math.max(1, Math.floor(total * (ability.special.blockBypassMult || 0.5)));
      }
      this.enemy.takeDamage(total);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${total}** damage!${d.isCrit ? ' **CRIT!**' : ''}${this.enemy._isBlocking ? ' *(Front pellets blocked!)*' : ''}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Judgement Cut
    if (ability.special?.type === 'judgementCut') {
      const fullHp = this.enemy.hp >= (this.enemy.maxHp || this.enemy.hp);
      const lowHp = this.enemy.hp <= (this.enemy.maxHp || this.enemy.hp) * 0.2;
      let abilityCopy = { ...ability };
      if (fullHp || lowHp) { abilityCopy.damageMin = Math.floor(ability.damageMin * 1.5); abilityCopy.damageMax = Math.floor(ability.damageMax * 1.5); }
      const d = this.calculateDamage(player, abilityCopy, this.enemy); this.enemy.takeDamage(d.totalDamage);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${(fullHp || lowHp) ? ' *(1.5x boosted!)*' : ''}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ---- STORYFELL CHARA ----
    // Knife Rushdown
    if (ability.special?.type === 'knifeRushdown') {
      const minH = ability.special.minHits || 2; const maxH = ability.special.maxHits || 6;
      const hits = Math.floor(Math.random() * (maxH - minH + 1)) + minH;
      let total = 0; let lastDmg = 0;
      for (let i = 0; i < hits; i++) {
        if (!this.enemy.isAlive) break;
        let abilityCopy = { ...ability };
        if (i === hits - 1 && hits > (ability.special.bonusThreshold || 3)) {
          const bonusHits = hits - (ability.special.bonusThreshold || 3);
          abilityCopy.damageMin = ability.damageMin + bonusHits * (ability.special.bonusPerHit || 3);
          abilityCopy.damageMax = ability.damageMax + bonusHits * (ability.special.bonusPerHit || 3);
        }
        const d = this.calculateDamage(player, abilityCopy, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage; lastDmg = d.totalDamage;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! ${hits} hits for **${total}** damage!`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Vine Overgrowth
    if (ability.special?.type === 'vineOvergrowth') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let extras = '';
      if (Math.random() < (ability.special.stunChance || 0.2)) {
        // 2-turn stun
        const sr = this.enemy.addStatus('stun'); if (sr) {
          const eff = this.enemy.statusEffects.find(s => s.id === 'stun');
          if (eff) eff.turnsLeft = ability.special.stunDuration || 2;
          extras += ' **Stunned 2 turns!**';
        }
      }
      if (Math.random() < (ability.special.bleedChance || 0.3)) {
        const sr = this.enemy.addStatus('bleed'); if (sr) extras += ' **Bleed!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Hellfire Finale
    if (ability.special?.type === 'hellfireFinale') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let endMsg = '';
      if (!this.enemy.isAlive) {
        const heal = ability.special.healOnKill || 20;
        player.hp = Math.min(player.maxHp || player.hp, player.hp + heal);
        endMsg = ` Restored **${heal} HP** for the kill!`;
      } else {
        const burnKey = (ability.special.guaranteedBurnDuration || 2) >= 3 ? 'burn3' : 'burn';
        const sr = this.enemy.addStatus(burnKey); if (sr) endMsg = ' **Burn applied!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${endMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ---- CALL OF THE VOID ----
    // Bone Surge (bonus if enemy used damaging move)
    if (ability.special?.type === 'boneSurge') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let bonus = 0; let bonusMsg = '';
      if (this.enemy._lastUsedDamaging) {
        bonus = ability.special.bonusVsAttack || 10;
        this.enemy.takeDamage(bonus);
        bonusMsg = ` Blue bones added **+${bonus}** damage!`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage + bonus}** damage!${d.isCrit ? ' **CRIT!**' : ''}${bonusMsg}`, damage: d.totalDamage + bonus };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Inverse Gravity Blast
    if (ability.special?.type === 'inverseGravity') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let dMsg = '';
      if (Math.random() < (ability.special.debuffChance || 0.25)) {
        this.enemy._critDebuff = (this.enemy._critDebuff || 0) + (ability.special.critDebuff || 0.2);
        this.enemy._critDebuffTurns = 1;
        this.enemy._accuracyDebuff = Math.max(this.enemy._accuracyDebuff || 0, ability.special.accDebuff || 0.2);
        this.enemy._accuracyDebuffTurns = Math.max(this.enemy._accuracyDebuffTurns || 0, 1);
        dMsg = ' Enemy -20% Crit & Accuracy next turn!';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${dMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // System Sabotage
    if (ability.special?.type === 'systemSabotage') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let lockMsg = '';
      if (Math.random() < (ability.special.lockChance || 0.5)) {
        this.enemy._sabotageLock = 1; // 1 turn
        lockMsg = ' **System sabotaged!** Damaging/healing moves locked next turn!';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${lockMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // --- UPDATE 14: Maximum Extraction (Call of the Void Sans) ---
    if (ability.special?.type === 'maximumExtraction') {
      const turnBonus = Math.min(ability.special.maxBonus || 10, (this.turnNumber || 0) * (ability.special.bonusPerTurn || 2));
      const d = this.calculateDamage(player, ability, this.enemy);
      const totalDmg = d.totalDamage + turnBonus;
      this.enemy.takeDamage(totalDmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      let msg = `**${player.name}** used **${ability.name}** ${emoji}! **${totalDmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}`;
      if (turnBonus > 0) msg += ` (+${turnBonus} from ${this.turnNumber} turns elapsed)`;
      // On kill: restore all uses for other abilities
      if (!this.enemy.isAlive) {
        player.abilities.forEach((a, i) => {
          if (a.special?.type !== 'maximumExtraction') a.currentUses = a.maxUses;
        });
        msg += ' **Enemy defeated! All other ability uses restored!**';
        R.playerAction = { success: true, abilityType: ability.type, message: msg, damage: totalDmg };
        R.battleEnd = this.checkBattleEnd(); return R;
      }
      R.playerAction = { success: true, abilityType: ability.type, message: msg, damage: totalDmg };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }


    // ---- SWAPFELL PAPYRUS ----
    // Boné Wave
    if (ability.special?.type === 'boneWave') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let extras = '';
      const hazyStacks = this.enemy._hazyStacks || 0;
      if (hazyStacks > 0 && Math.random() < (ability.special.hazyBleedChance || 0.25)) {
        const sr = this.enemy.addStatus('bleed'); if (sr) extras = ' **Bleed!** (Hazy bonus)';
      }
      // Smoke Screen passive trigger
      this.applySmokeScreenPassive(player);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Bone Storm
    if (ability.special?.type === 'boneStorm') {
      const minH = ability.special.minHits || 5; const maxH = ability.special.maxHits || 10;
      const hits = Math.floor(Math.random() * (maxH - minH + 1)) + minH;
      let total = 0; let blindApplied = false;
      for (let i = 0; i < hits; i++) {
        if (!this.enemy.isAlive) break;
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
        if (!blindApplied && Math.random() < (ability.special.blindPerHit || 0.05)) { const sr = this.enemy.addStatus('blindness'); if (sr) blindApplied = true; }
      }
      this.applySmokeScreenPassive(player);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! ${hits} hits for **${total}** damage!${blindApplied ? ' **Blinded!**' : ''}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Soul Slam
    if (ability.special?.type === 'soulSlam') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let extras = '';
      if (Math.random() < (ability.special.flinchChance || 0.20)) { const sr = this.enemy.addStatus('flinch'); if (sr) extras = ' **Flinched!**'; }
      const stacks = this.enemy._hazyStacks || 0;
      if (stacks >= (ability.special.capStacks || 5) && ability.special.forceSwitchOnCap && this.isPvP) {
        // In PvP, force switch handled by caller via flag
        this.enemy._forceSwitchNextTurn = true;
        extras += ' Enemy is forced to switch next turn!';
      }
      this.applySmokeScreenPassive(player);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Smoky Counter
    if (ability.special?.type === 'smokyCounter') {
      player._smokyCounter = ability.special.counterDamage || 30;
      // Hazy stack ignoring cooldown
      this.enemy._hazyStacks = Math.min((this.enemy._hazyStacks || 0) + 1, 5);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** activated **${ability.name}** ${emoji}! Will dodge & counter for ${ability.special.counterDamage || 30} dmg next turn! +1 Hazy stack!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ---- HARDMODE SANS ----
    // Bone Sweep
    if (ability.special?.type === 'boneSweep') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      this.enemy._enemyDamageReduce = (this.enemy._enemyDamageReduce || 0) + (ability.special.damageReduce || 5);
      this.enemy._enemyDamageReduceTurns = Math.max(this.enemy._enemyDamageReduceTurns || 0, 1);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} Enemy's next attack -5 dmg!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Blaster Circle
    if (ability.special?.type === 'blasterCircle') {
      const minH = ability.special.minHits || 2; const maxH = ability.special.maxHits || 6;
      const hits = Math.floor(Math.random() * (maxH - minH + 1)) + minH;
      let total = 0;
      for (let i = 0; i < hits; i++) {
        if (!this.enemy.isAlive) break;
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
      }
      let extras = '';
      if (hits >= (ability.special.defReduceThreshold || 4)) {
        this.enemy.defMod = (this.enemy.defMod || 0) - (ability.special.defReduceAmount || 1);
        extras += ` Enemy -${ability.special.defReduceAmount || 1} DEF!`;
      }
      if (Math.random() < (ability.special.poisonChance || 0.5)) { const sr = this.enemy.addStatus('poison'); if (sr) extras += ' **Poisoned!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! ${hits} hits for **${total}** damage!${extras}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Blue Soul Control
    if (ability.special?.type === 'blueSoulControl') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let restrictMsg = '';
      if (Math.random() < (ability.special.restrictChance || 0.5)) {
        this.enemy._blueSoulRestrict = 1;
        restrictMsg = ' Enemy restricted to first 2 moves next turn!';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${restrictMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Final Gambit
    if (ability.special?.type === 'finalGambit') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let gambitMsg = '';
      const hpRatio = this.enemy.hp / (this.enemy.maxHp || this.enemy.hp);
      if (hpRatio < (ability.special.hpThreshold || 0.25) && this.enemy.isAlive) {
        this.enemy._finalGambitForcedSkip = 1;
        gambitMsg = ' Enemy is forced to skip attack next turn!';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${gambitMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ---- DUSTFELL SANS ----
    // Chain Strangle
    if (ability.special?.type === 'chainStrangle') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let extras = '';
      if (Math.random() < (ability.special.defDebuffChance || 0.15)) { this.enemy.defMod = (this.enemy.defMod || 0) - (ability.special.defDebuffAmount || 2); extras += ` -${ability.special.defDebuffAmount || 2} enemy DEF!`; }
      if (Math.random() < (ability.special.stunChance || 0.25)) { const sr = this.enemy.addStatus('stun'); if (sr) extras += ' **Stunned!**'; }
      this.applyMadnessStack(player, 1);
      player._lastUsedChainStrangle = true;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Cruel Blasters
    if (ability.special?.type === 'cruelBlasters') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let extras = '';
      if (Math.random() < (ability.special.atkDebuffChance || 0.25)) { this.enemy.atkMod = (this.enemy.atkMod || 0) - (ability.special.atkDebuffAmount || 2); extras += ` -${ability.special.atkDebuffAmount || 2} enemy ATK!`; }
      const lowHp = (this.enemy.hp / (this.enemy.maxHp || this.enemy.hp)) < (ability.special.lowHpThreshold || 0.5);
      if (lowHp) { this.applyMadnessStack(player, 2); this.enemy.defMod = (this.enemy.defMod || 0) - 1; extras += ' Low HP — +1 extra Madness, -1 enemy DEF!'; }
      else { this.applyMadnessStack(player, 1); }
      player._lastUsedChainStrangle = false;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Dusty Bonk
    if (ability.special?.type === 'dustyBonk') {
      let abilityCopy = { ...ability };
      let bleedFlag = false;
      if (player._lastUsedChainStrangle) {
        abilityCopy.damageMin = ability.damageMin + (ability.special.comboBonus || 10);
        abilityCopy.damageMax = ability.damageMax + (ability.special.comboBonus || 10);
        bleedFlag = true;
      }
      const d = this.calculateDamage(player, abilityCopy, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let extras = '';
      if (Math.random() < (ability.special.flinchChance || 0.25)) { const sr = this.enemy.addStatus('flinch'); if (sr) extras += ' **Flinched!**'; }
      if (bleedFlag) { const sr = this.enemy.addStatus('bleed'); if (sr) extras += ' **Bleed combo!**'; }
      this.applyMadnessStack(player, 1);
      player._lastUsedChainStrangle = false;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}${bleedFlag ? ' (+10 combo!)' : ''}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Final Execution
    if (ability.special?.type === 'finalExecution') {
      const required = ability.special.requiredStacks || 7;
      if ((player._madnessStacks || 0) < required) {
        R.playerAction = { success: false, message: `**${ability.name}** requires ${required}+ Madness stacks! You have ${player._madnessStacks || 0}.` };
        return R;
      }
      let abilityCopy = { ...ability };
      const lowHp = (this.enemy.hp / (this.enemy.maxHp || this.enemy.hp)) < (ability.special.lowHpThreshold || 0.35);
      if (lowHp) { abilityCopy.damageMin = Math.floor(ability.damageMin * (ability.special.lowHpMultiplier || 2.0)); abilityCopy.damageMax = Math.floor(ability.damageMax * (ability.special.lowHpMultiplier || 2.0)); }
      const d = this.calculateDamage(player, abilityCopy, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let killMsg = '';
      if (!this.enemy.isAlive) {
        const heal = Math.floor((player.maxHp || player.hp) * (ability.special.healOnKillPercent || 0.5));
        player.hp = Math.min(player.maxHp || player.hp, player.hp + heal);
        killMsg = ` Restored **${heal} HP** for the kill!`;
      }
      // Reset stats
      player._madnessStacks = 0;
      player.atkMod = 0; player.defMod = 0;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${lowHp ? ' *(2x for low HP!)*' : ''}${killMsg} Stats reset!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ---- METTATON NEO BOSS ABILITIES (also usable as enemy/PvP) ----
    // Arm Cannon (NEO) - DEF pierce by %
    if (ability.special?.type === 'armCannonNeo') {
      const reduction = Math.ceil(this.enemy.def * (ability.special.defPiercePercent || 0.15));
      this.enemy.defMod -= reduction;
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.defMod += reduction;
      this.enemy.takeDamage(d.totalDamage);
      // Showtime stack
      if (player.passive?.type === 'showtime' && hasPassiveUnlocked(player.level)) {
        if ((player._showtimeStacks || 0) < 5) {
          player._showtimeStacks = (player._showtimeStacks || 0) + 1;
          player.atkMod = (player.atkMod || 0) + 1; player.defMod = (player.defMod || 0) + 1;
        }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} *(15% DEF pierced!)*`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Mini-Mettatons
    if (ability.special?.type === 'miniMettatons') {
      const minH = ability.special.minHits || 1; const maxH = ability.special.maxHits || 4;
      const hits = Math.floor(Math.random() * (maxH - minH + 1)) + minH;
      let total = 0; let stunFlag = false;
      for (let i = 0; i < hits; i++) {
        if (!this.enemy.isAlive) break;
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage); total += d.totalDamage;
        if (!stunFlag && Math.random() < (ability.special.stunPerHit || 0.03)) { const sr = this.enemy.addStatus('stun'); if (sr) stunFlag = true; }
      }
      if (player.passive?.type === 'showtime' && hasPassiveUnlocked(player.level)) {
        if ((player._showtimeStacks || 0) < 5) {
          player._showtimeStacks = (player._showtimeStacks || 0) + 1;
          player.atkMod = (player.atkMod || 0) + 1; player.defMod = (player.defMod || 0) + 1;
        }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! ${hits} hits for **${total}** damage!${stunFlag ? ' **Stunned!**' : ''}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Bomb Square
    if (ability.special?.type === 'bombSquare') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      if (player.passive?.type === 'showtime' && hasPassiveUnlocked(player.level)) {
        if ((player._showtimeStacks || 0) < 5) {
          player._showtimeStacks = (player._showtimeStacks || 0) + 1;
          player.atkMod = (player.atkMod || 0) + 1; player.defMod = (player.defMod || 0) + 1;
        }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Rocket Kick
    if (ability.special?.type === 'rocketKick') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let healMsg = '';
      if (!this.enemy.isAlive) {
        const heal = ability.special.healOnKill || 20;
        player.hp = Math.min(player.maxHp || player.hp, player.hp + heal);
        healMsg = ` Restored **${heal} HP** for the kill!`;
      }
      if (player.passive?.type === 'showtime' && hasPassiveUnlocked(player.level)) {
        if ((player._showtimeStacks || 0) < 5) {
          player._showtimeStacks = (player._showtimeStacks || 0) + 1;
          player.atkMod = (player.atkMod || 0) + 1; player.defMod = (player.defMod || 0) + 1;
        }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${healMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ---- OMEGA FLOWEY BOSS ABILITIES ----
    // Pellet Barrage (stacking accuracy/crit)
    if (ability.special?.type === 'pelletBarrage') {
      if (!player._pelletBarrageStack) player._pelletBarrageStack = 0;
      const stackPer = ability.special.stackPerUse || 0.05;
      const cap = ability.special.maxStack || 0.25;
      player._pelletBarrageStack = Math.min(player._pelletBarrageStack + stackPer, cap);
      // 50/50 acc or crit boost
      if (Math.random() < 0.5) player._accuracyBoost = player._pelletBarrageStack;
      else player.critBoost = player._pelletBarrageStack;
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} (+5% accumulated)`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Vine Strikes
    if (ability.special?.type === 'vineStrikes') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let skipMsg = '';
      if (Math.random() < (ability.special.skipChance || 0.25)) { this.enemy._skipNextTurn = true; skipMsg = ' Enemy stuck — **skips next turn!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${skipMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // X-Bombs
    if (ability.special?.type === 'xBombs') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let burnMsg = '';
      if (Math.random() < (ability.special.burnChance || 0.4)) {
        const burnKey = (ability.special.burnDuration || 2) >= 3 ? 'burn3' : 'burn';
        const sr = this.enemy.addStatus(burnKey); if (sr) burnMsg = ' **Burn!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${burnMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // Mouth Beam
    if (ability.special?.type === 'mouthBeam') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      this.enemy._missChanceBonus = (this.enemy._missChanceBonus || 0) + (ability.special.missDebuff || 0.2);
      this.enemy._missChanceBonusTurns = 1;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} Vibrations linger — enemy +20% miss chance next attack!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ============================================================
    // === UPDATE 15 ABILITY SPECIALS ===
    // ============================================================

    // FRISK FIGHT — 25% bleed for 1 turn
    if (ability.special?.type === 'friskFight') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.bleedChance || 0.25)) {
        const sr = this.enemy.addStatus('bleed'); if (sr) { sm = ' **Bleed!**'; sr.turnsLeft = 1; }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // FRISK ACT — random: 20% Mercy / +6 DEF 1 turn / heavy attack +5 dmg (cooldown ACT)
    if (ability.special?.type === 'friskAct') {
      const roll = Math.random();
      if (roll < 0.34) {
        // Mercy outcome
        player._mercyMeter = Math.min(100, (player._mercyMeter || 0) + 20);
        R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **ACT**! Showed mercy. (+20% Mercy — total: **${player._mercyMeter}%**)`, damage: 0 };
      } else if (roll < 0.67) {
        // Defend outcome
        player.defMod += 6;
        player._friskActDefBoost = (player._friskActDefBoost || 0) + 1;
        R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **ACT**! Defended. **+6 DEF for 1 turn!**`, damage: 0 };
      } else {
        // Heavy attack
        const d = this.calculateDamage(player, ability, this.enemy);
        const total = d.totalDamage + 5;
        this.enemy.takeDamage(total);
        const actAbility = player.abilities.find(a => a.special?.type === 'friskAct');
        if (actAbility) actAbility.cooldownLeft = 1;
        const emoji = TYPES[ability.type]?.emoji || '';
        R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **ACT** ${emoji}! Heavy attack — **${total}** damage!${d.isCrit ? ' **CRIT!**' : ''} (ACT on cooldown for 1 turn)`, damage: total };
      }
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // FRISK ITEM — needs picker, handled via R.requiresPicker
    if (ability.special?.type === 'friskItem') {
      R.playerAction = { success: true, requiresPicker: 'friskItem', message: `**${player.name}** opens their inventory...`, damage: 0 };
      // Don't end turn here — picker callback will resume turn
      return R;
    }

    // FRISK MERCY — instantly spares enemy below 100 HP at 100% mercy
    if (ability.special?.type === 'friskMercy') {
      if ((player._mercyMeter || 0) < 100) {
        ability.currentUses++; // refund
        R.playerAction = { success: false, message: `**MERCY** requires 100% Mercy! (Currently: ${player._mercyMeter || 0}%)`, damage: 0 };
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
      if (this.enemy.currentHp >= 100) {
        ability.currentUses++; // refund
        R.playerAction = { success: false, message: `**MERCY** requires the enemy to have less than 100 HP!`, damage: 0 };
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
      player._mercyMeter = 0;
      this.enemy.currentHp = 0;
      this._mercyBonus = true; // flag for reward generation
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **MERCY**! The enemy was spared! (More currencies/drops, lower rare chance)`, damage: 0 };
      R.battleEnd = this.checkBattleEnd();
      return R;
    }

    // CHARA SLASH BARRAGE — 2-5 hits, all 5 = 5th guaranteed crit + Bleed 2 turns
    if (ability.special?.type === 'slashBarrage') {
      const minH = ability.special.minHits || 2, maxH = ability.special.maxHits || 5;
      const hits = Math.floor(Math.random() * (maxH - minH + 1)) + minH;
      let total = 0; let isFifthCrit = false; let bleedMsg = '';
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(player, ability, this.enemy);
        let hitDmg = d.totalDamage;
        if (i === 4 && hits === 5) {
          // Force crit
          hitDmg = Math.floor(hitDmg * 1.5);
          isFifthCrit = true;
        }
        total += hitDmg;
        this.enemy.takeDamage(hitDmg);
        if (!this.enemy.isAlive) break;
      }
      if (hits === 5) {
        const sr = this.enemy.addStatus('bleed'); if (sr) { sr.turnsLeft = 2; bleedMsg = ' **Bleed (2 turns)!**'; }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! Hit **${hits}** times for **${total}** total!${isFifthCrit ? ' **5th HIT CRIT!**' : ''}${bleedMsg}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // CHARA ERASE — flavor 999... but real 17-28. On kill: cooldown -1, else: bleed 2 turns
    if (ability.special?.type === 'eraseAttack') {
      const d = this.calculateDamage(player, ability, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      const emoji = TYPES[ability.type]?.emoji || '';
      let msg = `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}`;
      if (!this.enemy.isAlive) {
        ability.cooldownLeft = Math.max(0, (ability.cooldownLeft || 0) - 1);
        msg += ' Enemy erased! (Cooldown -1)';
        R.playerAction = { success: true, abilityType: ability.type, message: msg, damage: d.totalDamage };
        R.battleEnd = this.checkBattleEnd(); return R;
      }
      const sr = this.enemy.addStatus('bleed'); if (sr) { sr.turnsLeft = 2; msg += ' **Bleed (2 turns)!**'; }
      R.playerAction = { success: true, abilityType: ability.type, message: msg, damage: d.totalDamage };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // NMD CHARA — KNIFE SURROUND 2-6 hits, 20%/hit extends bleed by 1 turn
    if (ability.special?.type === 'knifeSurround') {
      const minH = ability.special.minHits || 2, maxH = ability.special.maxHits || 6;
      const hits = Math.floor(Math.random() * (maxH - minH + 1)) + minH;
      let total = 0; let bleedTurns = 0;
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(player, ability, this.enemy);
        total += d.totalDamage; this.enemy.takeDamage(d.totalDamage);
        if (Math.random() < (ability.special.bleedChance || 0.2)) bleedTurns++;
        if (!this.enemy.isAlive) break;
      }
      let msg = `**${player.name}** used **${ability.name}**! ${hits} hits for **${total}** total!`;
      if (bleedTurns > 0) {
        const existing = this.enemy.statusEffects.find(s => s.name === 'Bleed');
        if (existing) {
          existing.turnsLeft += bleedTurns;
          msg += ` **Bleed extended by ${bleedTurns} turns!**`;
        } else {
          const sr = this.enemy.addStatus('bleed'); if (sr) { sr.turnsLeft = bleedTurns; msg += ` **Bleed (${bleedTurns} turns)!**`; }
        }
      }
      R.playerAction = { success: true, abilityType: ability.type, message: msg, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // NMD CHARA — A LETHAL DEAL — 1.25x below 40%, +2 ATK on KO (max 2)
    if (ability.special?.type === 'lethalDeal') {
      const d = this.calculateDamage(player, ability, this.enemy);
      let dmg = d.totalDamage;
      let bonusMsg = '';
      if (this.enemy.currentHp <= this.enemy.maxHp * 0.4) {
        dmg = Math.floor(dmg * 1.25);
        bonusMsg = ' (1.25x — enemy below 40%!)';
      }
      this.enemy.takeDamage(dmg);
      let msg = `**${player.name}** used **A Lethal Deal**! **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${bonusMsg}`;
      if (!this.enemy.isAlive) {
        const stacks = (player._lethalDealStacks || 0);
        if (stacks < 2) {
          player._lethalDealStacks = stacks + 1;
          player.atkMod = (player.atkMod || 0) + 2;
          msg += ` **Enemy KO! +2 ATK (rest of battle, ${player._lethalDealStacks}/2 stacks)**`;
        }
        R.playerAction = { success: true, abilityType: ability.type, message: msg, damage: dmg };
        R.battleEnd = this.checkBattleEnd(); return R;
      }
      R.playerAction = { success: true, abilityType: ability.type, message: msg, damage: dmg };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // CORE FRISK — VOID EYES — 2-4 hits, 15% lifesteal 25%
    if (ability.special?.type === 'voidEyes') {
      const minH = ability.special.minHits || 2, maxH = ability.special.maxHits || 4;
      const hits = Math.floor(Math.random() * (maxH - minH + 1)) + minH;
      let total = 0;
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(player, ability, this.enemy);
        total += d.totalDamage; this.enemy.takeDamage(d.totalDamage);
        if (!this.enemy.isAlive) break;
      }
      let msg = `**${player.name}** used **${ability.name}**! ${hits} hits for **${total}** total!`;
      if (Math.random() < (ability.special.lifestealChance || 0.15)) {
        const heal = Math.floor(total * (ability.special.lifestealPercent || 0.25));
        player.heal(heal);
        msg += ` **Lifesteal! +${heal} HP**`;
      }
      R.playerAction = { success: true, abilityType: ability.type, message: msg, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // CORE FRISK — OMNIPRESENCE — damage + vanish 1 turn
    if (ability.special?.type === 'omnipresence') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      player._omnipresenceTurns = 1;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} Vanished — all damage negated next turn!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // KRIS — SLASH — +5 fixed if HP > 50%
    if (ability.special?.type === 'krisSlash') {
      const d = this.calculateDamage(player, ability, this.enemy);
      let dmg = d.totalDamage;
      let bonusMsg = '';
      if (player.currentHp > player.maxHp * (ability.special.hpThreshold || 0.5)) {
        dmg += (ability.special.bonusDmg || 5);
        bonusMsg = ` (+${ability.special.bonusDmg || 5} bonus — high HP!)`;
      }
      this.enemy.takeDamage(dmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${bonusMsg}`, damage: dmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // KRIS — X-SLASH — 2 hits, 20% bleed 2t + 10% def-1
    if (ability.special?.type === 'xSlash') {
      let total = 0;
      for (let i = 0; i < 2; i++) {
        const d = this.calculateDamage(player, ability, this.enemy);
        total += d.totalDamage; this.enemy.takeDamage(d.totalDamage);
        if (!this.enemy.isAlive) break;
      }
      let extras = '';
      if (Math.random() < (ability.special.bleedChance || 0.2)) {
        const sr = this.enemy.addStatus('bleed'); if (sr) { sr.turnsLeft = 2; extras += ' **Bleed (2 turns)!**'; }
      }
      if (Math.random() < (ability.special.defReduceChance || 0.1)) {
        this.enemy.defMod -= 1; extras += ' **Enemy DEF -1!**';
      }
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}**! 2 hits for **${total}** total!${extras}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // KRIS — COURAGE — +2 DEF for 2 turns
    if (ability.special?.type === 'courage') {
      const boost = ability.special.defBoost || 2; const dur = ability.special.duration || 2;
      player.defMod += boost;
      player._courageTurns = dur;
      player._courageBoost = boost;
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **Courage**! +${boost} DEF for ${dur} turns!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // KRIS — SPARE — enemy ATK -1, 20% chance -2
    if (ability.special?.type === 'spare') {
      const reduce = Math.random() < 0.2 ? 2 : 1;
      this.enemy.atkMod -= reduce;
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **Spare**! Enemy ATK -${reduce}!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // SUSIE — CRUNCH — 25% disable last move 1t, on crit heal 10
    if (ability.special?.type === 'crunch') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let extras = '';
      if (Math.random() < (ability.special.disableChance || 0.25)) {
        const lastMove = this.enemy._lastUsedMove;
        if (lastMove !== undefined && this.enemy.abilities[lastMove]) {
          this.enemy.abilities[lastMove].cooldownLeft = Math.max(this.enemy.abilities[lastMove].cooldownLeft || 0, 1);
          extras += ` **Disabled ${this.enemy.abilities[lastMove].name}!**`;
        }
      }
      if (d.isCrit) {
        player.heal(ability.special.critHeal || 10);
        extras += ` **Crit healed ${ability.special.critHeal || 10} HP!**`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // SUSIE — RUDE BUSTER — 10% chance bonus dmg
    if (ability.special?.type === 'rudeBuster') {
      const d = this.calculateDamage(player, ability, this.enemy);
      let dmg = d.totalDamage;
      let bonusMsg = '';
      if (Math.random() < (ability.special.bonusChance || 0.1)) {
        const opts = ability.special.bonusOptions || [30, 28, 20, 13, 11, 10, 7];
        const bonus = opts[Math.floor(Math.random() * opts.length)];
        dmg += bonus;
        bonusMsg = ` (+${bonus} bonus!)`;
      }
      this.enemy.takeDamage(dmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${bonusMsg}`, damage: dmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // RALSEI — BURN OUT — guaranteed Burn 2t, 10% Hellfire, consumes 1 Tension
    if (ability.special?.type === 'burnOut') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let burnMsg;
      if (Math.random() < (ability.special.hellfireChance || 0.1)) {
        const sr = this.enemy.addStatus('hellfire'); burnMsg = sr ? ' **HELLFIRE!**' : '';
      } else {
        const sr = this.enemy.addStatus('burn'); if (sr) { sr.turnsLeft = 2; } burnMsg = sr ? ' **Burn (2 turns)!**' : '';
      }
      // Consume 1 Tension Point
      const tension = player.statusEffects.find(s => s.name === 'Tension Point');
      if (tension) {
        if ((tension.stacks || 1) > 1) tension.stacks = (tension.stacks || 1) - 1;
        else player.statusEffects = player.statusEffects.filter(s => s.name !== 'Tension Point');
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${burnMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // RALSEI — HEAL PRAYER — picker target
    if (ability.special?.type === 'healPrayer') {
      R.playerAction = { success: true, requiresPicker: 'healPrayer', message: `**${player.name}** prepares to heal...`, damage: 0 };
      return R;
    }

    // RALSEI — COMICALLY LARGE BLUNT — 30 dmg, Relaxed 2 turns, consumes 2 Tension
    if (ability.special?.type === 'comicallyLargeBlunt') {
      const tension = player.statusEffects.find(s => s.name === 'Tension Point');
      const stacks = tension?.stacks || 0;
      if (stacks < 2) {
        ability.currentUses++;
        R.playerAction = { success: false, message: `**Comically Large Blunt** requires 2 Tension Points! (Currently: ${stacks})`, damage: 0 };
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      // Consume 2 tension
      tension.stacks = stacks - 2;
      if (tension.stacks <= 0) player.statusEffects = player.statusEffects.filter(s => s.name !== 'Tension Point');
      // Apply Relaxed
      const sr = player.addStatus('relaxed');
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage! **Relaxed for 2 turns!** (Consumed 2 Tension Points)`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ROSE — SINCERITY — 2-6 hits, 25%/hit extends bleed
    if (ability.special?.type === 'sincerity') {
      const minH = ability.special.minHits || 2, maxH = ability.special.maxHits || 6;
      const hits = Math.floor(Math.random() * (maxH - minH + 1)) + minH;
      let total = 0; let bleedTurns = 0;
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(player, ability, this.enemy);
        total += d.totalDamage; this.enemy.takeDamage(d.totalDamage);
        if (Math.random() < (ability.special.bleedChance || 0.25)) bleedTurns++;
        if (!this.enemy.isAlive) break;
      }
      let msg = `**${player.name}** used **${ability.name}**! ${hits} hits for **${total}** total!`;
      if (bleedTurns > 0) {
        const existing = this.enemy.statusEffects.find(s => s.name === 'Bleed');
        if (existing) { existing.turnsLeft += bleedTurns; msg += ` **Bleed extended by ${bleedTurns} turns!**`; }
        else { const sr = this.enemy.addStatus('bleed'); if (sr) { sr.turnsLeft = bleedTurns; msg += ` **Bleed (${bleedTurns} turns)!**`; } }
      }
      R.playerAction = { success: true, abilityType: ability.type, message: msg, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ROSE — AURA BLAST — 50% Bleed 2 turns
    if (ability.special?.type === 'auraBlast') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let bleedMsg = '';
      if (Math.random() < 0.5) {
        const sr = this.enemy.addStatus('bleed'); if (sr) { sr.turnsLeft = 2; bleedMsg = ' **Bleed (2 turns)!**'; }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${bleedMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ROSE — ASSISTANCE — uses random move from highest C!Insanity in team
    if (ability.special?.type === 'assistance') {
      const cInsanityHierarchy = ['final_insanity', 'c_insanity', 'c_insanity_weak'];
      let chosenForm = null;
      for (const form of cInsanityHierarchy) {
        if (this.playerTeam.some(t => t.id === form || t.character_id === form)) { chosenForm = form; break; }
      }
      if (!chosenForm) {
        ability.currentUses++;
        R.playerAction = { success: false, message: `**Assistance** requires a C!Insanity form in your team!`, damage: 0 };
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
      const cinChar = CHARACTERS[chosenForm];
      const moves = cinChar.abilities.filter(a => a.damageMax > 0);
      const picked = moves[Math.floor(Math.random() * moves.length)];
      const dmg = Math.floor(Math.random() * (picked.damageMax - picked.damageMin + 1)) + picked.damageMin;
      this.enemy.takeDamage(dmg);
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **Assistance**! Borrowed **${picked.name}** from **${cinChar.name}** — **${dmg}** damage!`, damage: dmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // CLOVER — GUN SWING — 5% stun, +5 if reloading
    if (ability.special?.type === 'gunSwing') {
      const d = this.calculateDamage(player, ability, this.enemy);
      let dmg = d.totalDamage;
      let bonusMsg = '';
      if (player._reloadingTurns > 0) {
        dmg += 5; bonusMsg = ' (+5 reloading bonus)';
      }
      this.enemy.takeDamage(dmg);
      let stunMsg = '';
      if (Math.random() < (ability.special.stunChance || 0.05)) {
        const sr = this.enemy.addStatus('stun'); if (sr) stunMsg = ' **STUN!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${bonusMsg}${stunMsg}`, damage: dmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // CLOVER — PEW PEW — 2-4 hits, costs ammo
    if (ability.special?.type === 'pewPew') {
      if ((player._ammo || 0) < (ability.special.ammoCost || 1)) {
        ability.currentUses++;
        R.playerAction = { success: false, message: `**Pew Pew** needs ${ability.special.ammoCost || 1} ammo! (Currently: ${player._ammo || 0})`, damage: 0 };
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
      player._ammo -= (ability.special.ammoCost || 1);
      const minH = ability.special.minHits || 2, maxH = ability.special.maxHits || 4;
      const hits = Math.floor(Math.random() * (maxH - minH + 1)) + minH;
      let total = 0;
      const enemyMissBonus = (this.enemy._missChanceBonus || 0) + (player._cloverAtkRetaliation ? 0.1 : 0);
      const accLowered = enemyMissBonus > 0;
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(player, ability, this.enemy);
        total += d.totalDamage; this.enemy.takeDamage(d.totalDamage);
        if (!this.enemy.isAlive) break;
      }
      let extras = '';
      if (accLowered) {
        player.atkMod += 2; extras = ' **Accuracy was lowered — +2 ATK to Clover!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! ${hits} hits — **${total}** total! Ammo: ${player._ammo}${extras}`, damage: total };
      if (player._ammo <= 0 && !player._reloadingTurns) {
        player._reloadingTurns = 2;
      }
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // CLOVER — CHARGED SHOT — costs 2 ammo, 1 turn charge, 25% +1 ATK or DEF
    if (ability.special?.type === 'chargedShot') {
      if (player.isCharging && player.chargedAbility?.special?.type === 'chargedShot') {
        // Releasing charge
        const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
        player.isCharging = false; player.chargedAbility = null;
        let statMsg = '';
        if (Math.random() < (ability.special.statBoostChance || 0.25)) {
          if (Math.random() < 0.5) { player.atkMod += 1; statMsg = ' **+1 ATK!**'; }
          else { player.defMod += 1; statMsg = ' **+1 DEF!**'; }
        }
        const emoji = TYPES[ability.type]?.emoji || '';
        R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** released **Charged Shot** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${statMsg}`, damage: d.totalDamage };
        if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
      // Begin charging
      if ((player._ammo || 0) < (ability.special.ammoCost || 2)) {
        ability.currentUses++;
        R.playerAction = { success: false, message: `**Charged Shot** needs ${ability.special.ammoCost || 2} ammo! (Currently: ${player._ammo || 0})`, damage: 0 };
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
      player._ammo -= (ability.special.ammoCost || 2);
      player.isCharging = true; player.chargedAbility = ability;
      ability.currentUses++; // refund — finalize on release
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** is charging **Charged Shot**...`, damage: 0 };
      if (player._ammo <= 0 && !player._reloadingTurns) player._reloadingTurns = 2;
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // CLOVER — GUN FINAL FLASH
    if (ability.special?.type === 'gunFinalFlash') {
      let d = this.calculateDamage(player, ability, this.enemy);
      let dmg = d.totalDamage;
      let pierceMsg = '';
      if (Math.random() < (ability.special.pierceChance || 0.4)) {
        // PvE: ignore 10% def
        const ignoreDef = Math.floor((this.enemy.def || 0) * (ability.special.defIgnore || 0.1));
        dmg += ignoreDef;
        pierceMsg = ` **Pierced! (+${ignoreDef} ignoring ${Math.round((ability.special.defIgnore || 0.1) * 100)}% DEF)**`;
      }
      this.enemy.takeDamage(dmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${pierceMsg}`, damage: dmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // NOELLE — ICE SHOCK
    if (ability.special?.type === 'iceShock') {
      const d = this.calculateDamage(player, ability, this.enemy);
      const ignoreDef = Math.floor((this.enemy.def || 0) * (ability.special.defIgnore || 0.05));
      const dmg = d.totalDamage + ignoreDef;
      this.enemy.takeDamage(dmg);
      this.enemy._cantFlee = true;
      // Trigger "It's so cold" passive if Noelle Snowgrave
      if (player.passive?.type === 'itsSoCold' && hasPassiveUnlocked(player.level)) {
        player.atkMod += (player.passive.atkGain || 1);
        player.defMod += (player.passive.defGain || 1);
        player.heal(player.passive.healAmount || 15);
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''} (ignored ${Math.round((ability.special.defIgnore || 0.05) * 100)}% DEF)`, damage: dmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // NOELLE — SLEEP MIST
    if (ability.special?.type === 'sleepMist') {
      player._sleepMistUses = (player._sleepMistUses || 0) + 1;
      let msg;
      if (player._sleepMistUses > (ability.special.threshold || 5)) {
        const sr = this.enemy.addStatus('sleep'); if (sr) sr.turnsLeft = 2;
        msg = `**${player.name}** used **Sleep Mist**! Enemy fell **Asleep for 2 turns!**`;
        player._sleepMistUses = 0;
      } else {
        this.enemy._missChanceBonus = (this.enemy._missChanceBonus || 0) + 0.2;
        this.enemy._missChanceBonusTurns = 1;
        msg = `**${player.name}** used **Sleep Mist**! Enemy accuracy -20% next turn. (${player._sleepMistUses}/${(ability.special.threshold || 5) + 1} until Sleep)`;
      }
      R.playerAction = { success: true, abilityType: ability.type, message: msg, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // NOELLE — HEAL PRAYER
    if (ability.special?.type === 'noelleHealPrayer') {
      R.playerAction = { success: true, requiresPicker: 'noelleHealPrayer', message: `**${player.name}** prepares to heal...`, damage: 0 };
      return R;
    }

    // NOELLE SNOWGRAVE — THORN THROW
    if (ability.special?.type === 'thornThrow') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      // Trigger "It's so cold" passive if applicable - but Thorn Throw is Melee not Frost, so only on Frost moves
      let bleedMsg = '';
      if (Math.random() < (ability.special.bleedChance || 0.5)) {
        const sr = this.enemy.addStatus('bleed'); if (sr) { sr.turnsLeft = 1; bleedMsg = ' **Bleed (1 turn)!**'; }
      }
      // Every 2 turns, increment weakening counter
      player._thornThrowCount = (player._thornThrowCount || 0) + 1;
      let weakenMsg = '';
      if (player._thornThrowCount % (ability.special.weakenInterval || 2) === 0) {
        player._thornRingWeaken = (player._thornRingWeaken || 0) + 1;
        weakenMsg = ` **Thorn Ring weakens! (-${(player._thornRingWeaken || 0) * 2} dmg to Enhanced Ice Shock & SNOWGRAVE)**`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${bleedMsg}${weakenMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // NOELLE SNOWGRAVE — ENHANCED ICE SHOCK
    if (ability.special?.type === 'enhancedIceShock') {
      const d = this.calculateDamage(player, ability, this.enemy);
      const weakenPenalty = (player._thornRingWeaken || 0) * 2;
      const dmg = Math.max(1, d.totalDamage - weakenPenalty);
      this.enemy.takeDamage(dmg);
      let frozenMsg = '';
      if (Math.random() < (ability.special.frozenChance || 0.5)) {
        const sr = this.enemy.addStatus('frozen'); if (sr) frozenMsg = ' **FROZEN (2 turns)!**';
      }
      // Trigger "It's so cold"
      if (player.passive?.type === 'itsSoCold' && hasPassiveUnlocked(player.level)) {
        player.atkMod += (player.passive.atkGain || 1);
        player.defMod += (player.passive.defGain || 1);
        player.heal(player.passive.healAmount || 15);
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${weakenPenalty > 0 ? ` (-${weakenPenalty} weakened)` : ''}${frozenMsg}`, damage: dmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // NOELLE SNOWGRAVE — SNOWGRAVE
    if (ability.special?.type === 'snowgrave') {
      if (!player.isCharging) {
        player.isCharging = true; player.chargedAbility = ability;
        ability.currentUses++; // refund - finalize on release
        R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** is channeling **SNOWGRAVE**...`, damage: 0 };
        R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
      }
      const d = this.calculateDamage(player, ability, this.enemy);
      const weakenPenalty = (player._thornRingWeaken || 0) * 2;
      const dmg = Math.max(1, d.totalDamage - weakenPenalty);
      this.enemy.takeDamage(dmg);
      player.isCharging = false; player.chargedAbility = null;
      let frozenMsg = '';
      if (Math.random() < (ability.special.frozenChance || 0.75)) {
        const sr = this.enemy.addStatus('frozen'); if (sr) frozenMsg = ' **FROZEN (2 turns)!**';
      }
      this.enemy._healDisabled = true;
      if (player.passive?.type === 'itsSoCold' && hasPassiveUnlocked(player.level)) {
        player.atkMod += (player.passive.atkGain || 1);
        player.defMod += (player.passive.defGain || 1);
        player.heal(player.passive.healAmount || 15);
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** unleashed **SNOWGRAVE** ${emoji}! **FATAL ${dmg} damage!**${weakenPenalty > 0 ? ` (-${weakenPenalty} weakened)` : ''}${frozenMsg} **Heals disabled!**`, damage: dmg };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ASGORE DREEMURR — FIREBALLS — 3 hits + Burn 2t
    if (ability.special?.type === 'fireballs') {
      let total = 0;
      const hits = ability.special.hits || 3;
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(player, ability, this.enemy);
        total += d.totalDamage; this.enemy.takeDamage(d.totalDamage);
        if (!this.enemy.isAlive) break;
      }
      const sr = this.enemy.addStatus('burn'); if (sr) sr.turnsLeft = ability.special.burnDuration || 2;
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}**! ${hits} fireballs — **${total}** damage! **Burn (2t)!**`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ASGORE DREEMURR — FIRE CIRCLE
    if (ability.special?.type === 'fireCircle') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      const sr = this.enemy.addStatus('burn'); if (sr) sr.turnsLeft = ability.special.burnDuration || 2;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage! **Burn (2t)!**`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ASGORE DREEMURR — TRIDENT SLASH — 21% bleed, 30% follow-up fireball
    if (ability.special?.type === 'tridentSlash') {
      const d = this.calculateDamage(player, ability, this.enemy);
      let total = d.totalDamage; this.enemy.takeDamage(d.totalDamage);
      let extras = '';
      if (Math.random() < (ability.special.bleedChance || 0.21)) {
        const sr = this.enemy.addStatus('bleed'); if (sr) extras += ' **Bleed!**';
      }
      if (Math.random() < (ability.special.followupChance || 0.3) && this.enemy.isAlive) {
        const bonus = ability.special.followupDmg || 10;
        this.enemy.takeDamage(bonus); total += bonus;
        const sr = this.enemy.addStatus('burn'); if (sr) sr.turnsLeft = 2;
        extras += ` **Follow-up fireball! +${bonus} dmg + Burn (2t)!**`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${total}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // TOGORE — TOGORETASTIC ABILITIES — 50% Concussion 2t
    if (ability.special?.type === 'togoretastic') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let concMsg = '';
      if (Math.random() < (ability.special.concussionChance || 0.5)) {
        const sr = this.enemy.addStatus('concussion'); if (sr) concMsg = ' **CONCUSSION (2 turns)!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${concMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // SANS? — GASTER BLASTERS? — 2 hits, 20% poison
    if (ability.special?.type === 'gasterBlastersQ') {
      let total = 0;
      const hits = ability.special.hits || 2;
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(player, ability, this.enemy);
        total += d.totalDamage; this.enemy.takeDamage(d.totalDamage);
        if (!this.enemy.isAlive) break;
      }
      let poisonMsg = '';
      if (Math.random() < (ability.special.poisonChance || 0.2)) {
        const sr = this.enemy.addStatus('poison'); if (sr) poisonMsg = ' **Poisoned!**';
      }
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}**! ${hits} hits — **${total}** damage!${poisonMsg}`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // SANS? — ATTACK REFLECTION — reflects last enemy damaging move
    if (ability.special?.type === 'attackReflection') {
      const lastDmg = this.enemy._lastDamageDealt || 0;
      if (lastDmg > 0) {
        this.enemy.takeDamage(lastDmg);
        R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **Attack Reflection**! Reflected **${lastDmg}** damage back at the enemy!`, damage: lastDmg };
      } else {
        R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **Attack Reflection**! ...but there's nothing to reflect!`, damage: 0 };
      }
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // YOUR FAULT — BLASTER SLAM — 25% concussion 2t
    if (ability.special?.type === 'blasterSlam') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let concMsg = '';
      if (Math.random() < (ability.special.concussionChance || 0.25)) {
        const sr = this.enemy.addStatus('concussion'); if (sr) concMsg = ' **CONCUSSION!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${concMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // YOUR FAULT — YOUR FAULT MOVE — 50% blindness 1t
    if (ability.special?.type === 'yourFaultMove') {
      const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
      let blindMsg = '';
      if (Math.random() < (ability.special.blindChance || 0.5)) {
        const sr = this.enemy.addStatus('blindness'); if (sr) { sr.turnsLeft = 1; blindMsg = ' **Blind (1 turn)!**'; }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${blindMsg}`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // YOUR FAULT — STOLEN SLASH BARRAGE — 2-7 hits, 15% per hit extends bleed
    if (ability.special?.type === 'stolenSlashBarrage') {
      const minH = ability.special.minHits || 2, maxH = ability.special.maxHits || 7;
      const hits = Math.floor(Math.random() * (maxH - minH + 1)) + minH;
      let total = 0; let bleedTurns = 0;
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(player, ability, this.enemy);
        total += d.totalDamage; this.enemy.takeDamage(d.totalDamage);
        if (Math.random() < (ability.special.bleedChance || 0.15)) bleedTurns++;
        if (!this.enemy.isAlive) break;
      }
      let msg = `**${player.name}** used **${ability.name}**! ${hits} hits for **${total}** total!`;
      if (bleedTurns > 0) {
        const existing = this.enemy.statusEffects.find(s => s.name === 'Bleed');
        if (existing) { existing.turnsLeft += bleedTurns; msg += ` **Bleed extended by ${bleedTurns} turns!**`; }
        else { const sr = this.enemy.addStatus('bleed'); if (sr) { sr.turnsLeft = bleedTurns; msg += ` **Bleed (${bleedTurns} turns)!**`; } }
      }
      R.playerAction = { success: true, abilityType: ability.type, message: msg, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // YOUR INNER TORMENT — SANSATIONAL FEATURES — 2-5 hits, 50/50 Bone or Unique
    if (ability.special?.type === 'sansationalFeatures') {
      const minH = ability.special.minHits || 2, maxH = ability.special.maxHits || 5;
      const hits = Math.floor(Math.random() * (maxH - minH + 1)) + minH;
      const chosenType = Math.random() < 0.5 ? 'Bone' : 'Unique';
      let total = 0;
      const fakeAbility = { ...ability, type: chosenType };
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(player, fakeAbility, this.enemy);
        total += d.totalDamage; this.enemy.takeDamage(d.totalDamage);
        if (!this.enemy.isAlive) break;
      }
      const emoji = TYPES[chosenType]?.emoji || '';
      R.playerAction = { success: true, abilityType: chosenType, message: `**${player.name}** used **${ability.name}** ${emoji} (${chosenType})! ${hits} hits — **${total}** damage!`, damage: total };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // YOUR INNER TORMENT — FLASHBACKS — 50% Reflection / 35% SlashBarrage / 15% DoubleHand+5
    if (ability.special?.type === 'flashbacks') {
      const r = Math.random();
      if (r < 0.5) {
        // Attack Reflection
        const lastDmg = this.enemy._lastDamageDealt || 0;
        if (lastDmg > 0) {
          this.enemy.takeDamage(lastDmg);
          R.playerAction = { success: true, abilityType: 'Unique', message: `**${player.name}** used **Flashbacks** — Attack Reflection! Reflected **${lastDmg}** damage!`, damage: lastDmg };
        } else {
          R.playerAction = { success: true, abilityType: 'Unique', message: `**${player.name}** used **Flashbacks** — Attack Reflection! Nothing to reflect!`, damage: 0 };
        }
      } else if (r < 0.85) {
        // Stolen Slash Barrage
        const hits = Math.floor(Math.random() * 6) + 2;
        let total = 0; let bleedTurns = 0;
        const fakeAbility = { ...ability, damageMin: 3, damageMax: 7, type: 'Melee' }; // buffed
        for (let i = 0; i < hits; i++) {
          const d = this.calculateDamage(player, fakeAbility, this.enemy);
          total += d.totalDamage; this.enemy.takeDamage(d.totalDamage);
          if (Math.random() < 0.15) bleedTurns++;
          if (!this.enemy.isAlive) break;
        }
        let msg = `**${player.name}** used **Flashbacks** — Stolen Slash Barrage! ${hits} hits for **${total}** damage!`;
        if (bleedTurns > 0) {
          const existing = this.enemy.statusEffects.find(s => s.name === 'Bleed');
          if (existing) { existing.turnsLeft += bleedTurns; msg += ` **Bleed extended by ${bleedTurns}!**`; }
          else { const sr = this.enemy.addStatus('bleed'); if (sr) { sr.turnsLeft = bleedTurns; msg += ` **Bleed (${bleedTurns} turns)!**`; } }
        }
        R.playerAction = { success: true, abilityType: 'Melee', message: msg, damage: total };
      } else {
        // Double Hand Crush +5
        let total = 0;
        const fakeAbility = { ...ability, damageMin: 15, damageMax: 20, type: 'Melee' };
        for (let i = 0; i < 2; i++) {
          const d = this.calculateDamage(player, fakeAbility, this.enemy);
          total += d.totalDamage + 5; this.enemy.takeDamage(d.totalDamage + 5);
          if (!this.enemy.isAlive) break;
        }
        R.playerAction = { success: true, abilityType: 'Melee', message: `**${player.name}** used **Flashbacks** — Double Hand Crush (buffed)! 2 hits for **${total}** damage!`, damage: total };
      }
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }

    // ============================================================
    // === END UPDATE 15 ABILITY SPECIALS ===
    // ============================================================

    // ============================================================
    // === END UPDATE 13 ABILITY SPECIALS ===
    // ============================================================

    // NORMAL DAMAGE
    // --- UPDATE 17: Influenced Killer CHARGED Goo Blaster
    if (player._chargedActive && ability.name === 'Goo Blaster') {
      const chargedDmg = player._chargedGooDmg || 60;
      const fakeAbility = { ...ability, damageMin: chargedDmg, damageMax: chargedDmg };
      const d = this.calculateDamage(player, fakeAbility, this.enemy);
      this.enemy.takeDamage(d.totalDamage);
      player._chargedActive = false;
      // Recovery for 1 turn, unusable for 2 turns
      player.skipNextTurn = true;
      ability.cooldownLeft = 2;
      const emoji = TYPES[ability.type]?.emoji || '';
      R.playerAction = { success: true, abilityType: ability.type, message: `**${player.name}** used **CHARGED ${ability.name}** ${emoji}! **${d.totalDamage}** damage! ⚡ Recovery needed next turn, unusable for 2 turns!`, damage: d.totalDamage };
      if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // Raining Tacos ATK lock
    if (player._rainingTacosAtkLock > 0) {
      R.playerAction = { success: true, message: `**${player.name}** can't attack — **Raining Tacos** has them distracted!`, damage: 0 };
      R.enemyAction = this.executeEnemyTurn(); this.endTurn(R, player); return R;
    }
    // --- UPDATE 18: Lethal Exchange (Lethal Deal) ---
    let lethalExchangeMsg = '';
    if (player.passive?.type === 'lethalExchange' && hasPassiveUnlocked(player.level)) {
      const isMelee = ability.type === 'Melee'; const isMagic = ability.type === 'Magic';
      if (isMagic && player._lethalMeleeHit) {
        player.atkMod += Math.floor(player.atk * 0.2); player._lethalMagicTempBoost = Math.floor(player.atk * 0.2);
        player._lethalMeleeHit = false; lethalExchangeMsg = ' ⚔️ **Lethal Exchange** — 1.2x Magic!';
      }
      if (isMelee) {
        player._lethalSharpnessCrit = Math.min(0.40, (player._lethalSharpnessCrit || 0) + (player.passive.critBoostPerMagic || 0.20));
        player.critBoost = (player.critBoost || 0) + player._lethalSharpnessCrit;
        player._lethalMeleeHit = true; lethalExchangeMsg = ` ⚔️ **Sharpness** — Crit chance +${Math.round(player._lethalSharpnessCrit * 100)}%!`;
      }
    }
    const d = this.calculateDamage(player, ability, this.enemy); this.enemy.takeDamage(d.totalDamage);
    if (player._lethalMagicTempBoost) { player.atkMod -= player._lethalMagicTempBoost; player._lethalMagicTempBoost = 0; }
    if (player.passive?.type === 'lethalExchange' && ability.type === 'Melee') { player.critBoost = Math.max(0, (player.critBoost || 0) - (player._lethalSharpnessCrit || 0)); player._lethalSharpnessCrit = 0; }
    let sm = '';
    // Hadouken (Toriel char passive): first 3 attacks apply burn
    if (player.passive?.type === 'hadouken' && hasPassiveUnlocked(player.level) && player.passive.attacksLeft > 0) {
      player.passive.attacksLeft--;
      this.enemy.addStatus('burn');
    }
    // --- UPDATE 15: Core Frisk Emptiness — 15% chance Voided on each attack ---
    if (player.passive?.type === 'emptiness' && hasPassiveUnlocked(player.level) && d.totalDamage > 0 && Math.random() < (player.passive.chance || 0.15)) {
      const sr = this.enemy.addStatus('voided'); if (sr) sm += ' 🟣 **Voided!**';
    }
    // Burning Desire flag for endTurn
    if (player.passive?.type === 'burningDesire') player._attackedThisTurnBD = true;
    if (ability.special?.type === 'poison' && Math.random() < ability.special.chance) { const sr = this.enemy.addStatus('poison'); if (sr) sm += ` **Poisoned!**`; }
    if (ability.special?.type === 'flashBlast' && Math.random() < (ability.special.chance || 0.35)) {
      if (Math.random() < 0.5) { const sr = this.enemy.addStatus('poison'); if (sr) sm += ` **Poisoned!**`; }
      else { const sr = this.enemy.addStatus('blueSoul'); if (sr) sm += ` **Blue Soul applied!**`; }
    }
    let te = ''; if (d.typeMult > 1.5) te = ' **Super effective!**'; else if (d.typeMult < 0.75) te = ' *Not very effective...*';
    const emoji = TYPES[ability.type]?.emoji || '';
    R.playerAction = { success: true, ability: ability.name, abilityType: ability.type, message: `**${player.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${te}${sm}`, damage: d.totalDamage, isCrit: d.isCrit, typeMult: d.typeMult };
    player.critBoost = 0;
    if (!this.enemy.isAlive) { R.battleEnd = this.checkBattleEnd(); return R; }
    R.enemyAction = this.executeEnemyTurn();
    // Outertale passive — check on active player regardless
    if (R.enemyAction?.abilityType === 'Magic' && player.passive?.type === 'counterMagic' && hasPassiveUnlocked(player.level)) {
      this.enemy.atkMod -= player.passive.atkReduction; this.enemy.defMod -= player.passive.defReduction;
      R.passiveProc = `**${player.passive.name}** activated! ${this.enemy.name} -${player.passive.atkReduction} ATK, -${player.passive.defReduction} DEF!`;
    }
    this.endTurn(R, player); return R;
  }

  endTurn(R, player) {
    // --- SCAMTON EVENT: Power Points — 10% of damage dealt this turn (effects excluded) ---
    if (player.hasPP && player.hasPP() && (R.playerAction?.damage || 0) > 0) {
      const gained = player.gainPP((R.playerAction.damage) * (player.passive.ratio || 0.10));
      if (gained > 0) R.ppGain = `⚡ **${player.name}** gained **+${gained} PP** (${player._pp}/${player.maxPP})`;
    }
    // UPDATE 30: Toxin — switch-back timer (DT Injection / Spare Reservations)
    if (this._toxinSwap) {
      if (this._toxinSwap.justCast) { this._toxinSwap.justCast = false; }
      else {
        this._toxinSwap.returnTurns--;
        if (this._toxinSwap.returnTurns <= 0) {
          const _ti = this._toxinSwap.toxinIndex;
          if (this.playerTeam[_ti] && this.playerTeam[_ti].isAlive) { this.activePlayerIndex = _ti; if (!R.update30Procs) R.update30Procs = []; R.update30Procs.push('Toxin returns to the field!'); }
          this._toxinSwap = null;
        }
      }
    }
    // --- UPDATE 22: Justice Served (TS!Underswap Sans) — +1 ATK per landed Food attack (cap 10) ---
    if (player.passive?.type === 'justiceServed' && hasPassiveUnlocked(player.level) && player._attackedThisTurn
        && (player._lastUsedAbility?.type || '').includes('Food') && (R.playerAction?.damage || 0) > 0) {
      const cap = player.passive.maxStacks || 10;
      if ((player._justiceServedStacks || 0) < cap) {
        player._justiceServedStacks = (player._justiceServedStacks || 0) + 1;
        player.passiveAtkAccumulated += 1;
        if (!R.justiceServedProc) R.justiceServedProc = `🍅 **Justice Served** — ${player.name} +1 ATK! (${player._justiceServedStacks}/${cap})`;
      }
    }
    // --- UPDATE 24: Psychotic Episodes (Psychopathtale) — every 5 turns, Psycho Mode for 3 turns ---
    if (player.passive?.type === 'psychoticEpisodes' && hasPassiveUnlocked(player.level)) {
      if (player._psychoTurns > 0) {
        player._psychoTurns--;
        if (player._psychoTurns <= 0 && player._psychoMode) { player._psychoMode = false; player.atkMod -= player.passive.atkSwing; player.defMod += player.passive.defSwing; R.psychoEnd = `🌀 ${player.name}'s episode subsides — back to normal.`; }
      } else if (player.turnCount > 0 && player.turnCount % player.passive.cycle === 0) {
        player._psychoMode = true; player._psychoTurns = player.passive.duration; player.atkMod += player.passive.atkSwing; player.defMod -= player.passive.defSwing;
        R.psychoticEpisode = `🌀 **Psychotic Episode!** ${player.name} enters Psycho Mode (+${player.passive.atkSwing} ATK / -${player.passive.defSwing} DEF) for ${player.passive.duration} turns!`;
      }
    }
    // --- UPDATE 24: Fedora type-swap — every 2 turns, random resist + random weakness ---
    if (player.typeSwap && player.turnCount > 0 && player.turnCount % (player.typeSwap.cycle || 2) === 0) {
      const pool = ['Bone','Magic','Food','Weapon','Unique','Melee','Fire','Shock','Frost','Galactic','Cosmic','Crystal'];
      player._swapResist = pool[Math.floor(Math.random() * pool.length)];
      player._swapWeak = pool[Math.floor(Math.random() * pool.length)];
      R.fedoraSwap = `💎 **Crystal Shift!** ${player.name} now resists **${player._swapResist}** and is weak to **${player._swapWeak}**.`;
    }
    // --- UPDATE 24: Darkness Sanctuary tick (Reaper Chara) ---
    if (player._sanctuaryTurns > 0) { player._sanctuaryTurns--; if (player._sanctuaryTurns <= 0) { player.defMod -= 3; player._statusImmune = false; } }
    // --- UPDATE 24: Temp shield tick (Dusttale Endgoal) ---
    if (player._tempShieldTurns > 0) { player._tempShieldTurns--; if (player._tempShieldTurns <= 0) player._tempShield = 0; }
    // --- UPDATE 22: Blessing tick (Fallen Priest) ---
    if (player._blessingTurns > 0) {
      player._blessingTurns--;
      if (player._blessingTurns <= 0) player.statusEffects = player.statusEffects.filter(st => st.name !== 'Blessing');
    }
    // --- UPDATE 22: TS Blue Soul tick — restore enemy passive when it expires, then 1-turn lockout ---
    if ((this.enemy._tsBlueSoulTurns || 0) > 0) {
      this.enemy._tsBlueSoulTurns--;
      if (this.enemy._tsBlueSoulTurns <= 0) {
        if (this.enemy._tsDisabledPassive) { this.enemy.passive = this.enemy._tsDisabledPassive; this.enemy._tsDisabledPassive = null; }
        this.enemy._tsBlueSoulLockout = 1;
      }
    } else if ((this.enemy._tsBlueSoulLockout || 0) > 0) {
      this.enemy._tsBlueSoulLockout--;
    }
    // --- UPDATE 20: Pesti Sans (char) "We all rust someday" — applies Blindness on attacks ---
    if (player._attackedThisTurn && player.passive?.type === 'weAllRustSomeday' && !player.passive.isBossVersion && hasPassiveUnlocked(player.level) && this.enemy.isAlive) {
      const br = this.enemy.addStatus('blindness');
      const bl = this.enemy.statusEffects.find(s => s.name === 'Blindness');
      if (bl) bl.turnsLeft = player.passive.blindnessDuration || 2;
      if (br && !R.pestiCharBlindness) R.pestiCharBlindness = `🟫 **We all rust someday** — Blindness applied to enemy!`;
    }
    // --- UPDATE 20 BUG FIX: Domain Expansion self-stun — applies when enemy's domain stun ends ---
    if (player._domainSelfStunQueued > 0 && (this.enemy._domainStunTurns || 0) <= 0) {
      player._domainSelfStunBackfire = player._domainSelfStunQueued;
      player._domainSelfStunQueued = 0;
      if (!R.domainBackfire) R.domainBackfire = `🌌 The Domain collapses — **${player.name}** is now stunned for ${player._domainSelfStunBackfire} turns!`;
    }
    // --- UPDATE 32: Doki Meter — skipping your turn grants +1 Doki ---
    if (player.passive?.type === 'dokiMeter' && hasPassiveUnlocked(player.level) && !player._usedAbilityThisTurn) {
      player._doki = (player._doki || 0) + (player.passive.skipDoki || 1);
      R.dokiSkip = `🩷 **Doki Meter** — ${player.name} skipped and gained **+1 Doki**! (${player._doki}/${player.passive.threshold || 5})`;
    }
    // --- UPDATE 32: Superb Karaoke — tick the 3 turn window, restore the enemy's passive ---
    if (this.enemy._karaokeAbsorbTurns > 0) {
      this.enemy._karaokeAbsorbTurns--;
      if (this.enemy._karaokeAbsorbTurns <= 0) {
        if (this.enemy._karaokePassiveStash !== undefined) { this.enemy.passive = this.enemy._karaokePassiveStash; this.enemy._karaokePassiveStash = undefined; }
        this.enemy._karaokeAbsorber = null;
        R.karaokeEnd = `🎤 **Superb Karaoke** ends — ${this.enemy.name}'s passive returns.`;
      }
    }
    const playerActionStatuses = player._usedAbilityThisTurn ? player.processActionStatusEffects(player._attackedThisTurn) : [];
    const enemyActionStatuses = this.enemy._usedAbilityThisTurn ? this.enemy.processActionStatusEffects(this.enemy._attackedThisTurn) : [];
    player._usedAbilityThisTurn = false; player._attackedThisTurn = false;
    this.enemy._usedAbilityThisTurn = false; this.enemy._attackedThisTurn = false;
    R.statusTick = playerActionStatuses.concat(this.processEndOfTurn(player));
    R.enemyStatusTick = enemyActionStatuses.concat(this.processEndOfTurn(this.enemy));
    // Process temp debuffs
    this.tickTempDebuffs(player);
    this.tickTempDebuffs(this.enemy);
    // Bone Carrousel tick on enemy
    const bcStatus = this.enemy.statusEffects.find(s => s.id === 'boneCarrousel');
    if (bcStatus) {
      const bcDmg = Math.floor(Math.random() * (bcStatus._maxDmg - bcStatus._minDmg + 1)) + bcStatus._minDmg;
      this.enemy.currentHp = Math.max(0, this.enemy.currentHp - bcDmg);
      if (!R.boneCarrouselTick) R.boneCarrouselTick = [];
      R.boneCarrouselTick.push(`🦴 **Bone Carrousel** deals **${bcDmg}** damage! (${bcStatus.turnsLeft - 1} turns left)`);
    }
    // My Crew! tick
    if (this.enemy._crewTurns > 0) {
      this.enemy.currentHp = Math.max(0, this.enemy.currentHp - this.enemy._crewDmg);
      this.enemy._crewTurns--;
      if (!R.crewTick) R.crewTick = [];
      R.crewTick.push(`🏴‍☠️ **The Crew** attacks! **${this.enemy._crewDmg}** damage! (${this.enemy._crewTurns} turns left)`);
      if (!this.enemy.isAlive && !R.battleEnd) R.battleEnd = { winner: 'player', message: `**${this.enemy.name}** was defeated by the crew!` };
    }
    // Tick BLOCKED active counter
    if (player._blockedActive > 0) player._blockedActive--;
    // Tick damage reduction turns (Save Point Anchor)
    if (player._damageReductionTurns > 0) {
      player._damageReductionTurns--;
      if (player._damageReductionTurns <= 0) { player._damageReduction = 0; }
    }
    // Tick aggravation turns (IDUTSHANE)
    if (player._aggravationTurns > 0) {
      player._aggravationTurns--;
      if (player._aggravationTurns <= 0) { player._aggravationActive = false; if (player._aggravationAtkBoost) { player.atkMod -= player._aggravationAtkBoost; player._aggravationAtkBoost = 0; } }
    }
    // Tick Bone Shards (C!Insanity Bone Calamity)
    if (this.enemy._boneShardsTurns > 0) {
      this.enemy._boneShardsTurns--;
      if (this.enemy._boneShardsTurns <= 0) { this.enemy._boneShardsRecoil = 0; if (!R.boneShardsExpired) R.boneShardsExpired = `🦴 **Bone Shards** faded from the field!`; }
    }
    // Tick Roar lockout (Final Insanity Devastating Roar)
    if (this.enemy._roarLockoutTurns > 0) this.enemy._roarLockoutTurns--;
    // Tick Universal Cut switch/dodge restriction (Avenge Sans)
    if (this.enemy._universalCutTurns > 0) this.enemy._universalCutTurns--;
    // Tick Dazed (Avenge Blasters)
    if (this.enemy._dazedTurns > 0) this.enemy._dazedTurns--;
    // Tick disabled abilities (Avenge Sword Beam)
    for (const a of this.enemy.abilities) {
      if (a._disabledTurns > 0) a._disabledTurns--;
    }
    // Tick Weak Avenge Bones temp ATK debuff revert
    if (this.enemy._tempAtkRevertTurns > 0) {
      this.enemy._tempAtkRevertTurns--;
      if (this.enemy._tempAtkRevertTurns <= 0 && this.enemy._tempAtkRevertAmount) {
        this.enemy.atkMod += this.enemy._tempAtkRevertAmount;
        this.enemy._tempAtkRevertAmount = 0;
      }
    }
    // --- UPDATE 15: ticks ---
    // Frisk ACT defend tick
    if (player._friskActDefBoost > 0) {
      player._friskActDefBoost--;
      if (player._friskActDefBoost <= 0) { player.defMod -= 6; }
    }
    // Kris insert: Update stacks. Unique just used → +1 stack. Melee just used → consume.
    if (player.passive?.type === 'krisInsert' && hasPassiveUnlocked(player.level)) {
      const lastAbility = player._lastUsedAbility;
      if (lastAbility?.type === 'Unique' && (player._krisCritStacks || 0) < (player.passive.maxStacks || 3)) {
        player._krisCritStacks = (player._krisCritStacks || 0) + 1;
      } else if (lastAbility?.type === 'Melee' && player._krisCritUsedThisAttack) {
        player._krisCritStacks = 0;
        player._krisCritUsedThisAttack = false;
      }
    }
    // Ralsei Tension: Unique just used → +1 stack
    if (player.passive?.type === 'tension' && hasPassiveUnlocked(player.level)) {
      const lastAbility = player._lastUsedAbility;
      if (lastAbility?.type === 'Unique' && lastAbility.special?.type !== 'comicallyLargeBlunt' && lastAbility.special?.type !== 'burnOut') {
        const tension = player.statusEffects.find(s => s.name === 'Tension Point');
        if (tension) {
          tension.stacks = Math.min((player.passive.maxStacks || 3), (tension.stacks || 1) + 1);
        } else {
          const sr = player.addStatus('tensionPoint'); if (sr) { /* added */ }
          const ts = player.statusEffects.find(s => s.name === 'Tension Point');
          if (ts) ts.stacks = 1;
        }
        const ts = player.statusEffects.find(s => s.name === 'Tension Point');
        // At 3 stacks, next move auto-restores 15
        if (ts && ts.stacks >= (player.passive.maxStacks || 3)) {
          player.heal(player.passive.healAtMax || 15);
          if (!R.tensionHeal) R.tensionHeal = `✨ **Tension overflow!** Ralsei restored ${player.passive.healAtMax || 15} HP!`;
        }
      }
    }
    // Frisk ACT def tick already above
    // --- UPDATE 17: Heavy Rain passive (Tears in the Rain Sans) — every 2 turns enemy gets -35% acc + no crit for 1 turn
    if (player.passive?.type === 'heavyRain' && hasPassiveUnlocked(player.level)) {
      player._heavyRainCounter = (player._heavyRainCounter || 0) + 1;
      // Clear previous heavyRain effects each turn
      if (player._heavyRainActive) {
        const prevRain = player._heavyRainAccApplied || 0;
        this.enemy._missChanceBonus = Math.max(0, (this.enemy._missChanceBonus || 0) - prevRain);
        player._heavyRainAccApplied = 0;
        this.enemy._noCritThisTurn = false;
        player._heavyRainActive = false;
      }
      const interval = player.passive.interval || 2;
      if (player._heavyRainCounter % interval === 0) {
        const accRed = player.passive.accReduction || 0.35;
        this.enemy._missChanceBonus = (this.enemy._missChanceBonus || 0) + accRed;
        player._heavyRainAccApplied = accRed;
        this.enemy._noCritThisTurn = true;
        player._heavyRainActive = true;
        if (!R.heavyRainProc) R.heavyRainProc = `🌧️ **Heavy Rain** falls over the battlefield! Enemy accuracy **-${Math.round(accRed * 100)}%** and **cannot crit** this turn!`;
      }
    }
    // --- UPDATE 17: Sorrow Tears tick (revert DEF + accuracy after duration ends)
    if (player._sorrowTearsDefTurns > 0) {
      player._sorrowTearsDefTurns--;
      if (player._sorrowTearsDefTurns <= 0 && player._sorrowTearsDefAmount) {
        player.defMod -= player._sorrowTearsDefAmount;
        player._sorrowTearsDefAmount = 0;
      }
    }
    if (this.enemy._missChanceBonusTurns > 0) {
      this.enemy._missChanceBonusTurns--;
      if (this.enemy._missChanceBonusTurns <= 0) {
        // clear non-heavyRain miss bonus (heavyRain manages its own)
        this.enemy._missChanceBonus = Math.max(0, (this.enemy._missChanceBonus || 0) - 0.25);
        if (this.enemy._missChanceBonus < 0.01) this.enemy._missChanceBonus = (player._heavyRainAccApplied || 0);
      }
    }
    // --- UPDATE 17: Rainfall Bones flag clears at turn end if not consumed
    if (player._rainfallBonesArmed && player._rainfallBonesArmedTurn === undefined) {
      player._rainfallBonesArmedTurn = this.turnNumber;
    } else if (player._rainfallBonesArmed && this.turnNumber > (player._rainfallBonesArmedTurn || 0) + 1) {
      player._rainfallBonesArmed = false;
      player._rainfallBonesArmedTurn = undefined;
    }
    // Asgore DRIVING IN MY CAR — 15% turn-based run-over (using nerfed values from balance)
    if (player.passive?.type === 'drivingInMyCar' && hasPassiveUnlocked(player.level) && Math.random() < (player.passive.runOverChance || 0.15)) {
      const dmg = player.passive.runOverDmg || 20;
      this.enemy.takeDamage(dmg);
      const sr = this.enemy.addStatus('stun'); if (sr) sr.turnsLeft = 1;
      if (!R.drivingProc) R.drivingProc = `🚗 **DRIVING IN MY CAR!** ${player.name} runs over the enemy! ${dmg} damage + Stun!`;
      if (!this.enemy.isAlive) { this.isOver = true; this.winner = 'player'; R.battleEnd = { winner: 'player', message: `**${this.enemy.name}** was run over by Asgore's car!` }; return; }
    }
    // Sans? Anomalous? — every 3 turns 20% chance to copy enemy last move
    if (player.passive?.type === 'anomalous' && hasPassiveUnlocked(player.level)) {
      player._anomalousTurnCount = (player._anomalousTurnCount || 0) + 1;
      if (player._anomalousTurnCount % 1 === 0 && Math.random() < (player.passive.chance || 0.2)) {
        const lastIdx = this.enemy._lastUsedMove;
        if (lastIdx !== undefined && this.enemy.abilities[lastIdx]) {
          const enemyMove = this.enemy.abilities[lastIdx];
          const fakeAbility = { ...enemyMove, type: 'Bone' };
          const d = this.calculateDamage(player, fakeAbility, this.enemy);
          this.enemy.takeDamage(d.totalDamage);
          if (!R.anomalousProc) R.anomalousProc = `🦴 **Anomalous?** ${player.name} copies **${enemyMove.name}** — ${d.totalDamage} damage!`;
          if (!this.enemy.isAlive) { this.isOver = true; this.winner = 'player'; R.battleEnd = { winner: 'player', message: `**${this.enemy.name}** was defeated by Sans?'s copy!` }; return; }
        }
      }
    }
    // Core Frisk Voided procs
    if (player._omnipresenceTurns > 0) player._omnipresenceTurns--;
    // Reset 1-turn flags
    player._anomalousLastTurn = false;
    // Tick Clover reload
    if (player._reloadingTurns > 0) {
      player._reloadingTurns--;
      if (player._reloadingTurns <= 0) {
        player._ammo = 6;
        if (!R.cloverReload) R.cloverReload = `🔫 **${player.name}** reloaded! Ammo: 6/6`;
      }
    }
    // Tick Ralsei start +3 DEF (1 turn only)
    if (player._ralseiStartDefTurns > 0) {
      player._ralseiStartDefTurns--;
      if (player._ralseiStartDefTurns <= 0) {
        player.defMod -= (player.passive?.startDefBoost || 3);
      }
    }
    // --- UPDATE 18: Bravery counter
    if (this.enemy._braveryCounterActive) {
      this.enemy._braveryCounterActive = false;
      if ((R.playerAction?.damage || 0) > 0) {
        const trueDmg = 40; player.currentHp = Math.max(0, player.currentHp - trueDmg);
        if (!R.braveryCounterProc) R.braveryCounterProc = `🧡 **NOT gonna sugar coat it** — Counter hit! **${trueDmg}** true damage to ${player.name}!`;
      }
    }
    // Recompute Insanity thresholds at end of turn
    if (this.enemy._insanityStacks > 0) this._checkInsanityThresholds(R);
    // --- UPDATE 18: Losing His Mind — heal 2x enemy's stacks on hit
    if (player.passive?.type === 'losingHisMind' && hasPassiveUnlocked(player.level) && (R.playerAction?.damage || 0) > 0) {
      const heStacks = this.enemy._insanityStacks || 0;
      if (heStacks > 0) { const healAmt = heStacks * 2; const healed = player.heal(healAmt); if (healed > 0 && !R.losingHisMindHeal) R.losingHisMindHeal = `🧠 **Losing His Mind** healed **${healed} HP** (2x ${heStacks} [INSANITY] stacks)!`; }
    }
    // Raining Tacos — 0 ATK lock + heal per turn
    if (player._rainingTacosAtkLock > 0) { player._rainingTacosAtkLock--; }
    if (player._rainingTacosHeal > 0) {
      player.heal(player._rainingTacosHealAmt || 20);
      player._rainingTacosHeal--;
      if (!R.rainingTacosHeal) R.rainingTacosHeal = `🌮 **Raining Tacos** heals **${player._rainingTacosHealAmt || 20} HP**!`;
    }
    // Check if enemy died from status tick / bone carrousel
    if (!this.enemy.isAlive) { this.isOver = true; this.winner = 'player'; R.battleEnd = { winner: 'player', message: `**${this.enemy.name}** was defeated by status damage!` }; return; }
    // Apply passives to ALL alive team members
    for (const fighter of this.playerTeam) {
      // --- UPDATE 14: Dying Will (CATASTROPHE!FELL) — alwaysActive, even at Lv1
      if (fighter.isAlive && !fighter.isAI && fighter.passive?.type === 'dyingWill' && fighter.passive.alwaysActive) {
        if (!fighter._dyingWillTurn) fighter._dyingWillTurn = 0;
        fighter._dyingWillTurn++;
        if (fighter._dyingWillTurn % (fighter.passive.interval || 2) === 0) {
          // Calculate effective ATK/DEF before decay (floor at 0 — stop losing once already at 0)
          const effectiveAtk = fighter.baseAtk + fighter.atkMod + fighter.passiveAtkAccumulated;
          const effectiveDef = fighter.baseDef + fighter.defMod;
          const atkDrop = Math.min(fighter.passive.atkLoss || 3, Math.max(0, effectiveAtk));
          const defDrop = Math.min(fighter.passive.defLoss || 2, Math.max(0, effectiveDef));
          fighter.passiveAtkAccumulated -= atkDrop;
          fighter.defMod -= defDrop;
          if (atkDrop > 0 || defDrop > 0) {
            if (!R.dyingWillProc) R.dyingWillProc = `🔥 **Dying Will** burns **${fighter.name}**! -${atkDrop} ATK, -${defDrop} DEF!`;
          }
        }
      }
      if (fighter.isAlive && !fighter.isAI && hasPassiveUnlocked(fighter.level)) {
        if (fighter.passive?.type === 'atkBoost') {
          fighter.passiveAtkAccumulated += fighter.passive.amount;
        }
        // Fractured Mind
        if (fighter.passive?.type === 'fracturedMind') {
          const hpPct = fighter.currentHp / fighter.maxHp;
          const threshold = Math.floor(hpPct * 10) / 10;
          if (!fighter._fracturedThreshold) fighter._fracturedThreshold = 1.0;
          if (threshold < fighter._fracturedThreshold) {
            fighter._fracturedThreshold = threshold;
            fighter.passiveAtkAccumulated += 2;
            fighter.defMod += 2;
            R.fracturedMindProc = `**Fractured Mind** triggered! **${fighter.name}** +2 ATK, +2 DEF!`;
          }
        }
        // Murder Passive — lose ATK each attack
        if (fighter.passive?.type === 'murderPassive') {
          if (!fighter._lastTurnCount) fighter._lastTurnCount = 0;
          if (fighter.turnCount > fighter._lastTurnCount) {
            fighter._lastTurnCount = fighter.turnCount;
            fighter.passiveAtkAccumulated = Math.max(-(fighter.passive.maxBonus), fighter.passiveAtkAccumulated - fighter.passive.lossPerAttack);
          }
        }
        // Phantom Brother — interval-based (Snowdin Dust) OR every-turn (JHall Dust)
        if (fighter.passive?.type === 'phantomBrother') {
          let phantomHit = false;
          if (fighter.passive.interval) {
            // Snowdin Dust: every Nth turn
            if (!fighter._phantomTurn) fighter._phantomTurn = 0;
            fighter._phantomTurn++;
            if (fighter._phantomTurn % fighter.passive.interval === 0) {
              this.enemy.currentHp = Math.max(0, this.enemy.currentHp - fighter.passive.damage);
              if (!R.phantomBrotherProc) R.phantomBrotherProc = `👻 **Phantom Brother** strikes! **${fighter.passive.damage}** true damage!`;
              phantomHit = true;
            }
          } else if (fighter.passive.amount) {
            // JHall Dust: every turn
            this.enemy.currentHp = Math.max(0, this.enemy.currentHp - fighter.passive.amount);
            if (!R.phantomBrotherProc) R.phantomBrotherProc = `👻 **Phantom Brother** strikes! **${fighter.passive.amount}** true damage!`;
            phantomHit = true;
          }
          // --- UPDATE 20 BUG FIX: if Phantom Brother kills the enemy, properly end the battle (enemy was surviving at 0 HP) ---
          if (phantomHit && this.enemy.currentHp <= 0) {
            this.isOver = true; this.winner = 'player';
            if (!R.battleEnd) R.battleEnd = { winner: 'player', message: `**${this.enemy.name}** was defeated by Phantom Brother!` };
          }
        }
        // Battle Body (Underswap Sans) — at 50% HP gain +5 DEF for 3 turns
        if (fighter.passive?.type === 'battleBody') {
          const hpPct = fighter.currentHp / fighter.maxHp;
          if (hpPct <= 0.5 && !fighter._battleBodyActive) {
            fighter._battleBodyActive = true;
            fighter._battleBodyTurns = 3;
            fighter.defMod += 5;
            if (!R.battleBodyProc) R.battleBodyProc = `🛡️ **Battle Body** activated! **${fighter.name}** +5 DEF for 3 turns!`;
          }
          if (fighter._battleBodyActive && fighter._battleBodyTurns > 0) {
            fighter._battleBodyTurns--;
            if (fighter._battleBodyTurns <= 0) { fighter._battleBodyActive = false; fighter.defMod -= 5; }
          }
        }
        // Soul Embers (Ruins Dust Sans) — Burn damage heals this fighter
        if (fighter.passive?.type === 'soulEmbers') {
          const burnTick = R.enemyStatusTick?.find(s => s.name === 'Burn');
          if (burnTick && burnTick.damage > 0) {
            fighter.heal(fighter.passive.healAmount);
            if (!R.soulEmbersProc) R.soulEmbersProc = `🔥 **Soul Embers** healed **${fighter.passive.healAmount} HP**!`;
          }
        }
        // Still Determined (Geno Sans) — survive at 0 HP for 1 more turn
        if (fighter.passive?.type === 'stillDetermined' && !fighter._stillDeterminedUsed) {
          if (fighter.currentHp <= 0) {
            fighter._stillDeterminedUsed = true;
            const twoTurns = Math.random() < 0.1;
            fighter._stillDeterminedTurns = twoTurns ? 2 : 1;
            fighter.currentHp = 1;
            if (!R.stillDeterminedProc) R.stillDeterminedProc = `💾 **Still Determined!** ${fighter.name} clings on for ${fighter._stillDeterminedTurns} more turn(s)!`;
          }
        }
        if (fighter._stillDeterminedTurns > 0) {
          fighter._stillDeterminedTurns--;
          if (fighter._stillDeterminedTurns <= 0 && fighter.currentHp <= 1) fighter.currentHp = 0;
        }
        // Error Passive — every 2 turns apply random debuff to enemy
        if (fighter.passive?.type === 'errorPassive') {
          if (!fighter._errorTurn) fighter._errorTurn = 0;
          fighter._errorTurn++;
          if (fighter._errorTurn % fighter.passive.interval === 0) {
            const debuffs = ['stun', 'blindness', 'poison', 'bleed'];
            const picked = debuffs[Math.floor(Math.random() * debuffs.length)];
            this.enemy.addStatus(picked);
            if (!R.errorPassiveProc) R.errorPassiveProc = `🔀 **Error Passive** triggered! **${picked}** applied to enemy!`;
          }
        }
        // Foresight (FT!Sans) — 20% dodge on incoming attacks (flagged in executeEnemyTurn)
        if (fighter.passive?.type === 'foresight' && hasPassiveUnlocked(fighter.level)) {
          fighter._foresightActive = Math.random() < fighter.passive.chance;
        }
        // The King Will. (StoryShift! Sans) — 15% chance -1 enemy ATK per turn
        if (fighter.passive?.type === 'theKingWill' && hasPassiveUnlocked(fighter.level)) {
          if (Math.random() < fighter.passive.chance) {
            this.enemy.atkMod -= 1;
            if (!R.kingWillProc) R.kingWillProc = `👑 **The King Will.** — Enemy ATK -1!`;
          }
        }
        // Rose's Assistant (C!Insanity Weak) — heal per turn
        if (fighter.passive?.type === 'rosesAssistant' && hasPassiveUnlocked(fighter.level)) {
          const healed = fighter.heal(fighter.passive.healAmount);
          if (healed > 0 && !R.rosesAssistantProc) R.rosesAssistantProc = `🌹 **Rose's Assistant** healed **${healed} HP**!`;
        }
        // Rose's Support (C!Insanity) — heal per turn + 20% chance +1 DEF
        if (fighter.passive?.type === 'rosesSupport' && hasPassiveUnlocked(fighter.level)) {
          const healed = fighter.heal(fighter.passive.healAmount);
          let msg = healed > 0 ? `🌹 **Rose's Support** healed **${healed} HP**!` : '';
          if (Math.random() < fighter.passive.defChance) { fighter.defMod += 1; msg += ` +1 DEF!`; }
          if (msg && !R.rosesSupportProc) R.rosesSupportProc = msg;
        }
        // ===================== UPDATE 31 PASSIVE TICKS =====================
        // Karmic Debt (Karma!Sans) — every 3 turns Scary KR damage doubles + he gains +4 DEF for that turn
        if (fighter.passive?.type === 'karmicDebt' && hasPassiveUnlocked(fighter.level) && fighter === this.activePlayer) {
          if (fighter._karmicDefTurns > 0) {
            fighter._karmicDefTurns--;
            if (fighter._karmicDefTurns <= 0) {
              fighter.defMod -= (fighter.passive.defBoost || 4);
              const _kr = this.enemy.statusEffects.find(s => s.name === 'Scary KR');
              if (_kr) _kr.damageOnAttack = 10;
            }
          }
          fighter._karmicTurn = (fighter._karmicTurn || 0) + 1;
          if (fighter._karmicTurn % (fighter.passive.interval || 3) === 0) {
            fighter.defMod += (fighter.passive.defBoost || 4);
            fighter._karmicDefTurns = 1;
            const _kr = this.enemy.statusEffects.find(s => s.name === 'Scary KR');
            if (_kr) _kr.damageOnAttack = (fighter.passive.krDamage || 20);
            if (!R.karmicDebtProc) R.karmicDebtProc = `☯️ **Karmic Debt** — Scary KR deals **double** damage this turn! **${fighter.name} +4 DEF!**`;
          }
        }
        // Papyrus/? — takes 16 damage a turn
        if (fighter.passive?.type === 'itHurtsPap' && hasPassiveUnlocked(fighter.level) && fighter === this.activePlayer && fighter.isAlive) {
          fighter.currentHp = Math.max(0, fighter.currentHp - (fighter.passive.selfDamage || 16));
          if (!R.itHurtsPapProc) R.itHurtsPapProc = `🫠 **h̷ ̶h̷e̶l̷p̸ ̶m̵e̷/̸s̴a̵n̷s̶** — **${fighter.name}** takes **${fighter.passive.selfDamage || 16}** damage!`;
        }
        // SIXBONES I̷T̸ ̶H̷U̵R̸T̷S̶ — resolve stacked DEF loss + hits-taken DEF gain
        if (fighter.passive?.type === 'itHurts' && hasPassiveUnlocked(fighter.level) && fighter === this.activePlayer) {
          if (fighter._sixDefRestore > 0) { fighter.defMod += fighter._sixDefRestore; fighter._sixDefRestore = 0; }
          if (Array.isArray(fighter._sixDefStacks) && fighter._sixDefStacks.length) {
            const expired = fighter._sixDefStacks.filter(st => --st.turns <= 0);
            for (const st of expired) fighter.defMod += st.amount;
            fighter._sixDefStacks = fighter._sixDefStacks.filter(st => st.turns > 0);
          }
          if (fighter._sixDefNextTurn > 0) {
            fighter.defMod += fighter._sixDefNextTurn;
            fighter._sixDefRestore = fighter._sixDefNextTurn;
            if (!R.sixDefProc) R.sixDefProc = `🦴 **I̷T̸ ̶H̷U̵R̸T̷S̶** — **+${fighter._sixDefNextTurn} DEF** from hits taken!`;
            fighter._sixDefNextTurn = 0;
          }
        }
        // Last Breath P3 — 1000 Fold: heal 8/turn, permanent +6 ATK the first time below 40% HP
        if (fighter.passive?.type === 'lastBreathP3' && hasPassiveUnlocked(fighter.level) && fighter.isAlive) {
          const healed = fighter.heal(fighter.passive.healPerTurn || 8);
          let lm = healed > 0 ? `💀 **1000 Fold** healed **${healed} HP**!` : '';
          if (!fighter._p3Surged && (fighter.currentHp / fighter.maxHp) < (fighter.passive.threshold || 0.40)) {
            fighter._p3Surged = true;
            fighter.passiveAtkAccumulated += (fighter.passive.atkBoost || 6);
            lm += ` **+${fighter.passive.atkBoost || 6} ATK — he's not holding back anymore!**`;
          }
          if (lm && !R.lastBreathP3Proc) R.lastBreathP3Proc = lm;
        }
        // Rose (synergy) — C!Insanity's Assist: every 2 turns the highest C!Insanity form attacks
        if (fighter.passive?.type === 'cInsanityAssist' && hasPassiveUnlocked(fighter.level) && fighter === this.activePlayer && this.enemy.isAlive) {
          fighter._assistTurn = (fighter._assistTurn || 0) + 1;
          if (fighter._assistTurn % (fighter.passive.interval || 2) === 0) {
            const order = ['c_insanity', 'c_insanity_weak'];
            const src = this.playerTeam.find(f => order.includes(f._originalId || f.id));
            if (src) {
              const pool = src.abilities.filter(a => a.damageMax > 0);
              if (pool.length) {
                const pick = pool[Math.floor(Math.random() * pool.length)];
                const d = this.calculateDamage(src, pick, this.enemy);
                this.enemy.takeDamage(d.totalDamage);
                if (!R.cInsanityAssistProc) R.cInsanityAssistProc = `🌹 **C!Insanity's Assist** — **${src.name}** cuts in with **${pick.name}** for **${d.totalDamage}** damage!`;
                if (!this.enemy.isAlive) { this.isOver = true; this.winner = 'player'; if (!R.battleEnd) R.battleEnd = { winner: 'player', message: `**${this.enemy.name}** was defeated by C!Insanity's Assist!` }; }
              }
            }
          }
        }
        // ===================== END UPDATE 31 PASSIVE TICKS =====================
        // --- UPDATE 18: NEW PASSIVE TICKS ---
        if (fighter.passive?.type === 'vineRestriction' && hasPassiveUnlocked(fighter.level)) {
          this.enemy.defMod -= (fighter.passive.defReduction || 1);
          let vm = `🌿 **Vine Restriction** — Enemy -1 DEF!`;
          if (Math.random() < (fighter.passive.atkChance || 0.20)) { this.enemy.atkMod -= 1; vm += ' -1 ATK!'; }
          if (!R.vineRestrictionProc) R.vineRestrictionProc = vm;
        }
        if (fighter.passive?.type === 'theFinalChamber' && hasPassiveUnlocked(fighter.level)) {
          // --- UPDATE 22 BUG FIX: 0 bullets is falsy — this line was refilling the cylinder before reload could ever trigger ---
          if (fighter._bullets === undefined) fighter._bullets = fighter.passive.maxShots || 6;
          let justStartedReload = false;
          if (fighter._bullets <= 0 && !fighter._reloading) {
            fighter._reloading = true; fighter._reloadTurns = fighter._reloadingExtended ? 2 : 1;
            fighter.defMod -= 5; fighter._reloadDefDebuff = 5;
            justStartedReload = true; // --- UPDATE 22 BUG FIX: don't finish the reload in the same tick it starts ---
            if (!R.finalChamberProc) R.finalChamberProc = `🔫 **Reloading!** DEF -5 for ${fighter._reloadTurns} turn(s). Only Coffee Chug available!`;
          }
          if (fighter._reloading && !justStartedReload) {
            fighter._reloadTurns--;
            if (fighter._reloadTurns <= 0) { fighter._reloading = false; fighter._reloadingExtended = false; fighter.defMod += (fighter._reloadDefDebuff || 5); fighter._reloadDefDebuff = 0; fighter._bullets = fighter.passive.maxShots || 6; if (!R.finalChamberProc) R.finalChamberProc = `🔫 **Reloaded!** Back to ${fighter._bullets} bullets!`; }
          }
        }
        if (fighter._blasterSentryTurns > 0) {
          const sentryAbil = fighter._blasterSentryAbility;
          const bypass = Math.random() < (sentryAbil?.special?.defBypassChance || 0.30) ? (sentryAbil?.special?.defBypassAmt || 0.15) : 0;
          const reduction = Math.floor(this.enemy.def * bypass); if (reduction > 0) this.enemy.defMod -= reduction;
          const sd = this.calculateDamage(fighter, { type: 'Magic', damageMin: sentryAbil?.damageMin || 12, damageMax: sentryAbil?.damageMax || 17 }, this.enemy);
          this.enemy.takeDamage(sd.totalDamage); if (reduction > 0) this.enemy.defMod += reduction;
          fighter._blasterSentryTurns--;
          if (!R.blasterSentryProc) R.blasterSentryProc = `🔫 **Blaster Sentry** fires for **${sd.totalDamage}** damage!${bypass > 0 ? ' (DEF bypassed!)' : ''} (${fighter._blasterSentryTurns} turns left)`;
          if (fighter._blasterSentryTurns <= 0) fighter._blasterSentryAbility = null;
        }
        // UPDATE 30: LowTierFell — THUNDER STRIKE (every N turns: true dmg + stun)
        if (fighter.passive?.type === 'thunderStrike' && hasPassiveUnlocked(fighter.level)) {
          if (!fighter._thunderTurn) fighter._thunderTurn = 0;
          fighter._thunderTurn++;
          if (fighter._thunderTurn % (fighter.passive.interval || 5) === 0) {
            this.enemy.currentHp = Math.max(0, this.enemy.currentHp - (fighter.passive.trueDamage || 30));
            this.enemy.addStatus('stun');
            if (!R.update30Procs) R.update30Procs = [];
            R.update30Procs.push(`⚡ **THUNDER STRIKE!** ${fighter.passive.trueDamage || 30} true damage + **Stun**!`);
            if (this.enemy.currentHp <= 0) { this.isOver = true; this.winner = 'player'; }
          }
        }
        // UPDATE 30: Papyrus Belief — below 40% HP grants permanent +4 DEF (once)
        if (fighter.passive?.type === 'shatteredExpectations' && hasPassiveUnlocked(fighter.level) && !fighter._beliefDefApplied && (fighter.currentHp / fighter.maxHp) < (fighter.passive.lowHpThreshold || 0.40)) {
          fighter.defMod += (fighter.passive.lowHpDefBoost || 4); fighter._beliefDefApplied = true;
          if (!R.update30Procs) R.update30Procs = []; R.update30Procs.push(`Shattered Expectations: +${fighter.passive.lowHpDefBoost || 4} DEF (below 40% HP)!`);
        }
        // UPDATE 30: Storyspin — consequences passive (+1 ATK/DEF per dead teammate)
        if (fighter.passive?.type === 'storyspinConsequences' && hasPassiveUnlocked(fighter.level)) {
          const dead = this.playerTeam.filter(f => f !== fighter && !f.isAlive).length;
          const bonus = dead * (fighter.passive.statPerDead || 1);
          const prev = fighter._storyspinApplied || 0;
          if (bonus !== prev) { const delta = bonus - prev; fighter.atkMod += delta; fighter.defMod += delta; fighter._storyspinApplied = bonus; if (!R.update30Procs) R.update30Procs = []; R.update30Procs.push(`Consequences: +${bonus} ATK/DEF (${dead} fallen)!`); }
        }
        // UPDATE 30: Storyspin Malfunctioning Blaster crit-boost window
        if (fighter._critBoostTurns > 0) { fighter._critBoostTurns--; if (fighter._critBoostTurns <= 0) fighter.critBoost = 0; }
        if (fighter.passive?.type === 'itsOnlyOneLeft' && hasPassiveUnlocked(fighter.level)) {
          const buffIdx = Math.floor(Math.random() * fighter.abilities.length);
          fighter._oneLeftBuff = buffIdx;
          if (!R.oneLeftProc) R.oneLeftProc = `💾 **It's only one left!** — **${fighter.abilities[buffIdx]?.name}** buffed +${fighter.passive.atkBoost || 3} ATK this turn!`;
        }
        if ((this.enemy._krStacks || 0) > 0) {
          const krDmg = this.enemy._krStacks; this.enemy.takeDamage(krDmg);
          if (!R.krTickProc) R.krTickProc = `☠️ **KR** ticks for **${krDmg}** damage! Stacks cleared.`;
          this.enemy._krStacks = 0;
        }
        // Will to Avenge (Weak Avenge Sans) — recompute crit boost from HP loss
        if (fighter.passive?.type === 'willToAvenge' && hasPassiveUnlocked(fighter.level)) {
          const hpLostPct = 1 - (fighter.currentHp / fighter.maxHp);
          fighter.critBoost = Math.floor(hpLostPct * 10) * 0.05; // 5% per 10% HP lost
        }
        // Omniversal Prodigy (Avenge Sans) — accuracy immune handled at executeEnemyTurn flag
        if (fighter.passive?.type === 'omniversalProdigy' && hasPassiveUnlocked(fighter.level)) {
          fighter._accuracyImmune = (fighter.currentHp / fighter.maxHp) > fighter.passive.accuracyImmuneThreshold;
        }
        // King's Hesitation (Asgore boss) — phase tracking
        if (fighter.passive?.type === 'kingsHesitation') {
          if (!fighter._asgorePhaseSet && fighter.turnCount >= 5) {
            fighter._asgorePhaseSet = true;
            fighter.atkMod += 4; fighter.defMod += 4;
            if (!R.kingsHesitationProc) R.kingsHesitationProc = `👑 **Asgore** becomes **Determined**! +4 ATK, +4 DEF permanently!`;
          }
        }
        // --- UPDATE 13 ---
        // Shifted Judgement (Storyshift Chara) — +10% crit per missed turn (max 50%)
        if (fighter.passive?.type === 'shiftedJudgement' && hasPassiveUnlocked(fighter.level)) {
          // If enemy didn't hit fighter (not damaged this turn), accumulate crit
          if (!fighter._lastDamageTaken || fighter._lastDamageTaken === 0) {
            fighter._shiftedJudgementCrit = Math.min(0.5, (fighter._shiftedJudgementCrit || 0) + 0.1);
            fighter.critBoost = (fighter.critBoost || 0) + 0.1;
          } else {
            fighter._shiftedJudgementCrit = 0;
          }
          fighter._lastDamageTaken = 0;
        }
        // Manic Fixation (Dustrust Sans) — kill tracking is handled at battle end; show accumulated
        // Parasitic Desires (True Fresh) — kill tracking handled at battle end
        // Living Canvas (Shanghaivania) — tick ink trail
        if (fighter.passive?.type === 'livingCanvas') {
          if (fighter._inkTrailActive) {
            fighter._inkTrailTurns--;
            if (fighter._inkTrailTurns <= 0) { fighter._inkTrailActive = false; if (!R.inkTrailExpired) R.inkTrailExpired = `🎨 **Ink Trail** faded!`; }
          }
        }
        // Justice Reload — skip next turn if flagged
        if (fighter._justiceReload) {
          fighter._justiceReload = false;
          fighter.skipNextTurn = true;
          if (!R.justiceReload) R.justiceReload = `🟡 **Reload** — **${fighter.name}** must skip next turn!`;
        }
        // Determination stage (Vial Volley) — tick down
        if (fighter._determinationTurns > 0) {
          fighter._determinationTurns--;
          if (fighter._determinationTurns <= 0) {
            const stage = fighter._determinationStage || 1;
            fighter.atkMod -= stage * 2; fighter.defMod -= stage * 2;
            fighter._determinationStage = 0;
            if (!R.determinationExpired) R.determinationExpired = `🔴 **Determination** boost expired!`;
          }
        }
        // Gaster's Help (Revenge Papyrus) — start of each turn: 50% shield or 50% assist
        if (fighter.passive?.type === 'gastersHelp') {
          if (Math.random() < 0.5) {
            fighter._gastersHelpShield = true;
            if (!R.gastersHelpProc) R.gastersHelpProc = `🖐️ **Gaster's Help**: Shield! Next hit on **${fighter.name}** is halved!`;
          } else {
            fighter._gastersHelpAssist = 10;
            if (!R.gastersHelpProc) R.gastersHelpProc = `🖐️ **Gaster's Help**: Assist! **${fighter.name}**'s next attack +10 DMG!`;
          }
        }
        // Time Split — switch stats every 2 turns
        if (fighter.passive?.type === 'timeSplit') {
          if (!fighter._timeSplitTurn) fighter._timeSplitTurn = 0;
          fighter._timeSplitTurn++;
          if (fighter._timeSplitTurn % 2 === 0) {
            const isAinavolSide = !fighter._agemSide;
            fighter._agemSide = isAinavolSide;
            if (isAinavolSide) {
              fighter.baseAtk = 17; fighter.baseDef = 12;
              fighter.abilities = fighter._phase2Abilities || fighter.abilities;
            } else {
              fighter.baseAtk = 12; fighter.baseDef = 17;
              fighter.abilities = fighter._originalAbilities || fighter.abilities;
            }
            if (!R.timeSplitMsg) R.timeSplitMsg = `**Time Paradox** switches to **${isAinavolSide ? 'agem?' : 'ainavol?'}** side!`;
          }
        }
      }
    }
    // Burning Desire (Ainavolagem) — apply burn after each attack
    if (player.isAlive && player.passive?.type === 'burningDesire' && hasPassiveUnlocked(player.level) && player._attackedThisTurnBD) {
      player._attackedThisTurnBD = false;
      if (Math.random() < player.passive.chance) {
        this.enemy.addStatus('burn');
        if (!R.burningDesireProc) R.burningDesireProc = `🔥 **Burning Desire** triggered! **Burn** applied!`;
      }
    }
    // Duality passive for enemy (Gaster boss)
    if (this.enemy.isAlive && this.enemy.passive?.type === 'duality') {
      if (!this.enemy._dualityState) this.enemy._dualityState = 'red';
      if (this.enemy._dualityState === 'red') { this.enemy.atkMod -= 4; this.enemy._dualityState = 'blue'; this.enemy.defMod += 4; }
      else { this.enemy.defMod -= 4; this.enemy._dualityState = 'red'; this.enemy.atkMod += 4; }
    }
    // --- UPDATE 17: FatalError UNKNOWN ERROR passive (boss or character) — shuffle ATK/DEF every turn + heal 1 HP
    if (this.enemy.isAlive && (this.enemy.passive?.type === 'unknownErrorBoss' || this.enemy.passive?.type === 'unknownError')) {
      // Heal +1 HP per turn
      this.enemy.heal(this.enemy.passive.healPerTurn || 1);
      // Shuffle: random ATK/DEF mod between -3 and +3 (relative to base)
      if (this.enemy._fatalAtkShuffle !== undefined) {
        this.enemy.atkMod -= this.enemy._fatalAtkShuffle;
        this.enemy.defMod -= this.enemy._fatalDefShuffle;
      }
      this.enemy._fatalAtkShuffle = Math.floor(Math.random() * 7) - 3;
      this.enemy._fatalDefShuffle = Math.floor(Math.random() * 7) - 3;
      this.enemy.atkMod += this.enemy._fatalAtkShuffle;
      this.enemy.defMod += this.enemy._fatalDefShuffle;
      if (!R.fatalShuffleProc) R.fatalShuffleProc = `🔀 **UNKNOWN ERROR** — ${this.enemy.name}'s stats shifted! (+1 HP)`;
    }
    // Also for player team members (FatalError as a playable char)
    for (const f of this.playerTeam) {
      if (!f.isAlive || f.isAI) continue;
      if (f.passive?.type === 'unknownError' && hasPassiveUnlocked(f.level)) {
        f.heal(f.passive.healPerTurn || 1);
        if (f._fatalAtkShuffle !== undefined) {
          f.atkMod -= f._fatalAtkShuffle; f.defMod -= f._fatalDefShuffle;
        }
        f._fatalAtkShuffle = Math.floor(Math.random() * 7) - 3;
        f._fatalDefShuffle = Math.floor(Math.random() * 7) - 3;
        f.atkMod += f._fatalAtkShuffle; f.defMod += f._fatalDefShuffle;
      }
    }
    // --- UPDATE 17: Nightmare Sans boss ENRAGED activation at <50% HP
    if (this.enemy.isAlive && this.enemy.passive?.type === 'enragedHelpBoss') {
      const threshold = this.enemy.passive.hpThreshold || 0.5;
      if (!this.enemy._enragedActivated && this.enemy.currentHp / this.enemy.maxHp < threshold) {
        this.enemy._enragedActivated = true;
        this.enemy.atkMod += (this.enemy.passive.atkBoost || 4);
        this.enemy.defMod += (this.enemy.passive.defBoost || 4);
        this.enemy._statusImmune = true;
        if (!R.enragedProc) R.enragedProc = `🌑 **ENRAGED!** ${this.enemy.name} is enraged! +${this.enemy.passive.atkBoost || 4} ATK, +${this.enemy.passive.defBoost || 4} DEF, status immune!`;
      }
      // Call helper every N turns
      if (this.enemy._enragedActivated) {
        this.enemy._enragedCallCounter = (this.enemy._enragedCallCounter || 0) + 1;
        if (this.enemy._enragedCallCounter % (this.enemy.passive.callInterval || 3) === 0) {
          const helpers = ['horror_sans', 'killer_sans', 'judgement_hall_dust_sans'];
          const choice = helpers[Math.floor(Math.random() * helpers.length)];
          const helperChar = CHARACTERS[choice];
          if (helperChar && helperChar.abilities && helperChar.abilities.length > 0) {
            const move = helperChar.abilities[Math.floor(Math.random() * helperChar.abilities.length)];
            const fakeAttacker = { ...this.enemy, atk: this.enemy.atk, atkMod: 0, baseAtk: this.enemy.atk, passive: null, _noCritThisTurn: false };
            const fakeMove = { ...move };
            if (fakeMove.damageMax > 0) {
              const dmg = Math.floor(Math.random() * (fakeMove.damageMax - fakeMove.damageMin + 1)) + fakeMove.damageMin;
              const player = this.activePlayer;
              player.takeDamage(dmg);
              if (!R.enragedCallProc) R.enragedCallProc = `🌑 **${helperChar.name}** answers the call — **${move.name}** for **${dmg}** damage!`;
            }
          }
        }
      }
    }
    // --- UPDATE 17: Nightmare Sans character ENRAGED — same logic but for player char
    for (const f of this.playerTeam) {
      if (!f.isAlive || f.isAI) continue;
      if (f.passive?.type === 'enragedHelp' && hasPassiveUnlocked(f.level)) {
        const threshold = f.passive.hpThreshold || 0.5;
        if (!f._enragedActivated && f.currentHp / f.maxHp < threshold) {
          f._enragedActivated = true;
          f.atkMod += (f.passive.atkBoost || 2);
          f.defMod -= (f.passive.defLoss || 2);
          if (!R.enragedCharProc) R.enragedCharProc = `🌑 **ENRAGED!** ${f.name} — +${f.passive.atkBoost || 2} ATK, -${f.passive.defLoss || 2} DEF!`;
        }
        if (f._enragedActivated && f === this.activePlayer) {
          f._enragedCallCounter = (f._enragedCallCounter || 0) + 1;
          if (f._enragedCallCounter % (f.passive.callInterval || 3) === 0) {
            const helpers = ['horror_sans', 'killer_sans', 'judgement_hall_dust_sans'];
            const choice = helpers[Math.floor(Math.random() * helpers.length)];
            const helperChar = CHARACTERS[choice];
            if (helperChar && helperChar.abilities && helperChar.abilities.length > 0) {
              const move = helperChar.abilities[Math.floor(Math.random() * helperChar.abilities.length)];
              if (move.damageMax > 0) {
                const dmg = Math.floor(Math.random() * (move.damageMax - move.damageMin + 1)) + move.damageMin;
                this.enemy.takeDamage(dmg);
                if (!R.enragedCharCallProc) R.enragedCharCallProc = `🌑 **${helperChar.name}** answers the call — **${move.name}** for **${dmg}** damage!`;
                if (!this.enemy.isAlive) { this.isOver = true; this.winner = 'player'; R.battleEnd = { winner: 'player', message: `**${this.enemy.name}** was defeated!` }; return; }
              }
            }
          }
        }
      }
    }
    // --- UPDATE 20: HIM "Full Admin Access" — every 3 turns, random effect on player
    if (this.enemy.isAlive && this.enemy.passive?.type === 'fullAdminAccess') {
      // Randomize HIM's stats each turn
      if (this.enemy._himAtkShuffle !== undefined) {
        this.enemy.atkMod -= this.enemy._himAtkShuffle;
        this.enemy.defMod -= this.enemy._himDefShuffle;
      }
      this.enemy._himAtkShuffle = Math.floor(Math.random() * 5) - 2; // -2 to +2
      this.enemy._himDefShuffle = Math.floor(Math.random() * 4) - 1; // -1 to +2
      this.enemy.atkMod += this.enemy._himAtkShuffle;
      this.enemy.defMod += this.enemy._himDefShuffle;
      // Every 3 turns trigger one of 4 admin effects
      this.enemy._himAdminCounter = (this.enemy._himAdminCounter || 0) + 1;
      if (this.enemy._himAdminCounter % (this.enemy.passive.interval || 3) === 0) {
        const roll = Math.floor(Math.random() * 4);
        const player = this.activePlayer;
        if (roll === 0) {
          // Swap player character at random
          const others = this.playerTeam.map((f, i) => ({ f, i })).filter(({ f, i }) => f.isAlive && i !== this.activePlayerIndex);
          if (others.length > 0) {
            const picked = others[Math.floor(Math.random() * others.length)];
            this.activePlayerIndex = picked.i;
            if (!R.himAdminProc) R.himAdminProc = `🕳️ **Full Admin Access** — HIM swaps your character! **${picked.f.name}** is now active!`;
          } else {
            if (!R.himAdminProc) R.himAdminProc = `🕳️ **Full Admin Access** — HIM tried to swap, but you have no other characters!`;
          }
        } else if (roll === 1) {
          // Player loses 7 ATK and DEF
          player.atkMod -= 7; player.defMod -= 7;
          if (!R.himAdminProc) R.himAdminProc = `🕳️ **Full Admin Access** — HIM strips ${player.name}'s power! **-7 ATK, -7 DEF!**`;
        } else if (roll === 2) {
          // Stun
          player.addStatus('stun');
          if (!R.himAdminProc) R.himAdminProc = `🕳️ **Full Admin Access** — HIM freezes the console! **${player.name} is Stunned!**`;
        } else {
          // Apply every debuff except stun
          ['poison', 'bleed', 'burn', 'blindness', 'karma'].forEach(s => player.addStatus(s));
          if (!R.himAdminProc) R.himAdminProc = `🕳️ **Full Admin Access** — HIM injects every curse into the system! **Poison + Bleed + Burn + Blindness + Karma applied to ${player.name}!**`;
        }
      }
    }
    // --- UPDATE 20: Pesti boss "We all rust someday" — apply Rust to player every turn
    if (this.enemy.isAlive && this.enemy.passive?.type === 'weAllRustSomeday' && this.enemy.passive.isBossVersion) {
      const sr = this.activePlayer.addStatus('rust');
      const rustStatus = this.activePlayer.statusEffects.find(s => s.name === 'Rust');
      if (rustStatus) rustStatus.turnsLeft = this.enemy.passive.rustDuration || 3;
      if (sr && !R.pestiRustProc) R.pestiRustProc = `🟫 **We all rust someday** — ${this.activePlayer.name} is afflicted with Rust!`;
    }
    // --- UPDATE 20: Pesti char "We all rust someday" — apply Blindness on attacks
    for (const f of this.playerTeam) {
      if (!f.isAlive || f.isAI) continue;
      if (f.passive?.type === 'weAllRustSomeday' && !f.passive.isBossVersion && hasPassiveUnlocked(f.level)) {
        f._pestiBlindnessFlag = true; // signal: next damaging move applies Blindness 2 turns
      }
    }
    // --- UPDATE 20: FFTBO passive — +3 dmg per 5 turns + 30% heal 20 HP
    for (const f of this.playerTeam) {
      if (!f.isAlive || f.isAI) continue;
      if (f.passive?.type === 'fftboPassive' && hasPassiveUnlocked(f.level)) {
        f._fftboTurnCounter = (f._fftboTurnCounter || 0) + 1;
        if (f._fftboTurnCounter % (f.passive.interval || 5) === 0) {
          f._fftboDmgBoost = (f._fftboDmgBoost || 0) + (f.passive.dmgBoost || 3);
          if (!R.fftboBoostProc) R.fftboBoostProc = `💀 **this has been my finale since day one.** — +${f.passive.dmgBoost || 3} damage stack! (Total +${f._fftboDmgBoost})`;
        }
        if (Math.random() < (f.passive.healChance || 0.3)) {
          f.heal(f.passive.healAmount || 20);
          if (!R.fftboHealProc) R.fftboHealProc = `💀 **Finale Heal** — ${f.name} heals **${f.passive.healAmount || 20} HP**!`;
        }
      }
    }
    // --- UPDATE 20: Fake!HyperDust "Fake passive" — heal every 2 turns
    for (const f of this.playerTeam) {
      if (!f.isAlive || f.isAI) continue;
      if (f.passive?.type === 'fakePassive' && hasPassiveUnlocked(f.level)) {
        f._fakePassiveCounter = (f._fakePassiveCounter || 0) + 1;
        if (f._fakePassiveCounter % (f.passive.interval || 2) === 0) {
          f.heal(f.passive.healAmount || 15);
          if (!R.fakePassiveProc) R.fakePassiveProc = `💭 **Fake passive** — ${f.name} heals **${f.passive.healAmount || 15} HP**!`;
        }
      }
    }
    // --- UPDATE 20: Fake!DustDust "HATRED." — auto Bone Zone multi-hit every 6 turns
    for (const f of this.playerTeam) {
      if (!f.isAlive || f.isAI) continue;
      if (f.passive?.type === 'hatredPassive' && hasPassiveUnlocked(f.level)) {
        f._hatredCounter = (f._hatredCounter || 0) + 1;
        if (f._hatredCounter % (f.passive.interval || 6) === 0) {
          const hits = Math.floor(Math.random() * 3) + 3; // 3-5 hits
          let total = 0;
          for (let i = 0; i < hits; i++) { total += Math.floor(Math.random() * 8) + 8; } // 8-15 per hit
          this.enemy.takeDamage(total);
          if (!R.hatredProc) R.hatredProc = `🌑 **HATRED.** — Auto Bone Zone! **${hits} hits**, **${total}** total damage!`;
          if (!this.enemy.isAlive) { this.isOver = true; this.winner = 'player'; R.battleEnd = { winner: 'player', message: `**${this.enemy.name}** was defeated!` }; return; }
        }
      }
    }
    // --- UPDATE 20: Evan's Dust "MEMORIES!" — every 3 turns, 15% chance to use a boss attack
    for (const f of this.playerTeam) {
      if (!f.isAlive || f.isAI) continue;
      if (f.passive?.type === 'evansMemories' && hasPassiveUnlocked(f.level)) {
        f._evansCounter = (f._evansCounter || 0) + 1;
        if (f._evansCounter % (f.passive.interval || 3) === 0 && Math.random() < (f.passive.chance || 0.15)) {
          // Pick a random boss and use one of their moves
          const bossIds = Object.keys(BOSSES).filter(b => BOSSES[b].abilities && BOSSES[b].abilities.length > 0 && b !== 'training_dummy');
          if (bossIds.length > 0) {
            const bossId = bossIds[Math.floor(Math.random() * bossIds.length)];
            const boss = BOSSES[bossId];
            const move = boss.abilities[Math.floor(Math.random() * boss.abilities.length)];
            if (move.damageMax > 0) {
              const dmg = Math.floor(Math.random() * (move.damageMax - move.damageMin + 1)) + move.damageMin;
              this.enemy.takeDamage(dmg);
              if (!R.evansMemoriesProc) R.evansMemoriesProc = `💭 **MEMORIES!** — ${f.name} remembers **${boss.name}'s ${move.name}**! **${dmg}** damage to enemy!`;
              if (!this.enemy.isAlive) { this.isOver = true; this.winner = 'player'; R.battleEnd = { winner: 'player', message: `**${this.enemy.name}** was defeated!` }; return; }
            }
          }
        }
      }
    }
    // --- UPDATE 17: AfterDust Sans Dusty Save passive — every 10 turns reverts HP to 35%, turn 5 check for buff
    for (const f of this.playerTeam) {
      if (!f.isAlive || f.isAI) continue;
      if (f.passive?.type === 'dustySave' && hasPassiveUnlocked(f.level)) {
        if (!f._dustySaveBaseAtk) { f._dustySaveBaseAtk = f.atk; f._dustySaveBaseDef = f.def; }
        f._dustySaveCounter = (f._dustySaveCounter || 0) + 1;
        // --- UPDATE 22 BUFF: every 5 turns (recurring), +30 HP, 2-turn DEF buff ---
        if (f._dustySaveCounter % 5 === 0 && (f.currentHp / f.maxHp) > 0.35) {
          f.currentHp = Math.min(f.maxHp, f.currentHp + 30);
          f.defMod += 2;
          f._dustySaveDefBuffTurns = 2;
          if (!R.dustySaveProc) R.dustySaveProc = `💀 **Dusty Save** — ${f.name} gains +30 HP and +2 DEF for 2 turns!`;
        }
        // Tick the def buff
        if (f._dustySaveDefBuffTurns > 0) {
          f._dustySaveDefBuffTurns--;
          if (f._dustySaveDefBuffTurns <= 0) { f.defMod -= 2; }
        }
        // Every 10 turns revert HP to 35%
        if (f._dustySaveCounter % 10 === 0) {
          f.currentHp = Math.floor(f.maxHp * 0.35);
          if (!R.dustySaveRevert) R.dustySaveRevert = `💀 **Dusty Save** — ${f.name}'s HP reverted to 35%!`;
        }
      }
    }
    // --- UPDATE 17: Influenced Killer Sans Determination — heal 25 HP every 2 turns
    for (const f of this.playerTeam) {
      if (!f.isAlive || f.isAI) continue;
      if (f.passive?.type === 'influencedDetermination' && hasPassiveUnlocked(f.level)) {
        f._infDetCounter = (f._infDetCounter || 0) + 1;
        if (f._infDetCounter % 2 === 0) {
          f.heal(f.passive.healPerTwoTurns || 25);
          if (!R.infDetProc) R.infDetProc = `❤️ **Determination** — ${f.name} heals **${f.passive.healPerTwoTurns || 25} HP**!`;
        }
      }
    }
    // --- UPDATE 17: Dream Sans positive apple healing tick
    for (const f of this.playerTeam) {
      if (!f.isAlive || f.isAI) continue;
      if (f._positiveAppleTurns > 0) {
        f.heal(f._positiveAppleHeal || 15);
        f._positiveAppleTurns--;
        if (!R.positiveAppleHeal) R.positiveAppleHeal = `🍏 **Positive Apple** heals ${f.name} for **${f._positiveAppleHeal || 15} HP**! (${f._positiveAppleTurns} turns left)`;
      }
    }
    // --- UPDATE 17: AfterDust Dusty Determination boost tick
    for (const f of this.playerTeam) {
      if (!f.isAlive || f.isAI) continue;
      if (f._dustyDetBoostTurns > 0) f._dustyDetBoostTurns--;
    }
    // --- UPDATE 17: FatalError ERROR CODE 404 ATK boost tick
    for (const f of this.playerTeam) {
      if (!f.isAlive || f.isAI) continue;
      if (f._errorCode404AtkTurns > 0) {
        f._errorCode404AtkTurns--;
        if (f._errorCode404AtkTurns <= 0 && f._errorCode404AtkAmount) {
          f.atkMod -= f._errorCode404AtkAmount;
          f._errorCode404AtkAmount = 0;
        }
      }
    }
    // --- UPDATE 17: Influenced Killer PERRY recovery tick
    for (const f of this.playerTeam) {
      if (!f.isAlive || f.isAI) continue;
      if (f._perryRecoverTurns > 0) f._perryRecoverTurns--;
    }
    // --- UPDATE 17: Influenced Killer CHARGE tick
    for (const f of this.playerTeam) {
      if (!f.isAlive || f.isAI) continue;
      if (f._chargedUnusableTurns > 0) f._chargedUnusableTurns--;
    }
    // Bone Volley tick
    if (this.enemy._boneVolleyTurns > 0) {
      this.enemy.currentHp = Math.max(0, this.enemy.currentHp - this.enemy._boneVolleyDmg);
      this.enemy._boneVolleyTurns--;
      if (!R.boneVolleyTick) R.boneVolleyTick = [];
      R.boneVolleyTick.push(`💥 **Bone Volley** explodes! **${this.enemy._boneVolleyDmg}** damage! (${this.enemy._boneVolleyTurns} turns left)`);
      if (!this.enemy.isAlive && !R.battleEnd) R.battleEnd = { winner: 'player', message: `**${this.enemy.name}** was defeated by Bone Volley!` };
    }
    // Patience Knives tick (Vial Volley)
    if (this.enemy._patienceKnives) {
      const pk = this.enemy._patienceKnives;
      this.enemy.currentHp = Math.max(0, this.enemy.currentHp - pk.damagePerTurn);
      pk.turnsLeft--;
      if (!R.patienceKnivesTick) R.patienceKnivesTick = `🟣 **Patience Knives** — ${pk.damagePerTurn} damage! (${pk.turnsLeft} turn(s) left)`;
      if (pk.turnsLeft <= 0) {
        this.enemy.currentHp = Math.max(0, this.enemy.currentHp - pk.explodeDmg);
        R.patienceKnivesTick += ` 💥 **EXPLOSION!** ${pk.explodeDmg} damage!`;
        this.enemy._patienceKnives = null;
      }
      if (!this.enemy.isAlive && !R.battleEnd) R.battleEnd = { winner: 'player', message: `**${this.enemy.name}** was defeated by Patience Knives!` };
    }
    // Ink Trail miss effect on enemy attacks
    const playerFighters = this.players || [];
    for (const pf of playerFighters) {
      if (pf._inkTrailActive && R.enemyAction && !R.enemyAction.missed) {
        if (Math.random() < 0.2) { R.inkTrailMiss = `🎨 **Ink Trail** blurred the enemy's vision — attack missed!`; R.enemyAction.damage = 0; R.enemyAction.missed = true; }
      }
    }
    this.applyEnemyPassives();
    // ============================================================
    // === UPDATE 13 END-OF-TURN TICKS ===
    // ============================================================
    // Increment Mafiatale turn counter for Bodyguards passive
    if (player.passive?.type === 'bodyguards' && hasPassiveUnlocked(player.level)) {
      player._mafiaTurnsActive = (player._mafiaTurnsActive || 0) + 1;
    }
    // Apply Bodyguards retaliation (set by takeDamage)
    if (player._bodyguardsRetaliate && this.enemy.isAlive) {
      const r = player._bodyguardsRetaliate;
      this.enemy.currentHp = Math.max(0, this.enemy.currentHp - r);
      if (!R.bodyguardsRetaliate) R.bodyguardsRetaliate = `🎩 **Bodyguards** retaliated! **${r}** damage to ${this.enemy.name}!`;
      player._bodyguardsRetaliate = 0;
    }
    // Smoky Counter retaliation
    if (player._smokyCounterRetaliate && this.enemy.isAlive) {
      const r = player._smokyCounterRetaliate;
      this.enemy.currentHp = Math.max(0, this.enemy.currentHp - r);
      if (!R.smokyCounterMsg) R.smokyCounterMsg = `💨 **Smoky Counter** dodged and struck back for **${r}** damage!`;
      player._smokyCounterRetaliate = 0;
    }
    // Sirius burn flag — apply burn after damage
    if (this.enemy.isAlive && this.enemy._siriusBurnFlag === undefined && player._siriusBurnFlag) {
      this.enemy.addStatus('burn');
      if (!R.siriusBurn) R.siriusBurn = `⭐ **Sirius** ignited the enemy! **Burn** applied!`;
      player._siriusBurnFlag = false;
    }
    // Falling Mini MTTs (Hotlands Dust passive) — 30% chance end-of-turn
    if (player.isAlive && player.passive?.type === 'fallingMiniMTTs' && hasPassiveUnlocked(player.level) && this.enemy.isAlive) {
      if (Math.random() < (player.passive.chance || 0.3)) {
        const dmg = player.passive.damage || 8;
        this.enemy.currentHp = Math.max(0, this.enemy.currentHp - dmg);
        this.enemy.defMod = (this.enemy.defMod || 0) - (player.passive.defReduce || 2);
        if (!R.fallingMTTsProc) R.fallingMTTsProc = `📺 **Falling Mini MTTs** crashed for **${dmg}** damage and -${player.passive.defReduce || 2} DEF!`;
      }
    }
    // Sadistic Persistence (Dustfell) — interrupt enemy heals if 5+ stacks
    if (player.isAlive && player.passive?.type === 'sadisticPersistence' && hasPassiveUnlocked(player.level)) {
      if ((player._madnessStacks || 0) > 5 && this.enemy._healedLastTurn && this.enemy.isAlive) {
        this.enemy.currentHp = Math.max(0, this.enemy.currentHp - 20);
        player._madnessStacks = Math.max(0, player._madnessStacks - 3);
        // Recalc atk/def based on stacks
        const pairs = Math.floor(player._madnessStacks / 2);
        // Don't recalc here directly — we just decrement; stat reset happens on Final Execution
        if (!R.madnessInterrupt) R.madnessInterrupt = `🩸 **Sadistic Persistence** interrupted the heal for **20** damage! (-3 Madness stacks)`;
      }
      this.enemy._healedLastTurn = false;
    }
    // Glitchy Save (Omega Flowey)
    if (this.enemy.passive?.type === 'glitchySave' && this.enemy.isAlive) {
      if (!this.enemy._floweyTurn) this.enemy._floweyTurn = 0;
      this.enemy._floweyTurn++;
      // Every 2 turns, attempt to save
      if (this.enemy._floweyTurn % 2 === 0) {
        if (this.enemy._wasAttackedThisTurn) {
          // SAVE failed — DEF dropped by 2 this turn (handled at attack time via _floweySaveTurnNext flag)
          if (!R.floweySaveFail) R.floweySaveFail = `💾 **Glitchy Save** failed! Flowey's DEF dropped by **2** this turn!`;
        } else {
          // Heal 100
          this.enemy.currentHp = Math.min(this.enemy.maxHp || this.enemy.currentHp + 100, this.enemy.currentHp + 100);
          if (!R.floweySaveHeal) R.floweySaveHeal = `💾 **Glitchy Save** restored Flowey for **100 HP**!`;
        }
        this.enemy._floweySaveTurnNext = true; // signal next turn is a save turn
      } else {
        this.enemy._floweySaveTurnNext = false;
      }
      this.enemy._wasAttackedThisTurn = false;
    }
    // SINGULARITY tick — release explosion when timer hits 0
    if (player._singularityTurns > 0) {
      player._singularityTurns--;
      if (player._singularityTurns === 0) {
        const stored = player._singularityStored || 0;
        const eStored = this.enemy._singularityStored || 0;
        const playerDmg = Math.floor((stored + eStored) * 0.7);
        const enemyDmg = Math.floor((stored + eStored) * 0.7);
        player.currentHp = Math.max(0, player.currentHp - playerDmg);
        if (this.enemy.isAlive) this.enemy.currentHp = Math.max(0, this.enemy.currentHp - enemyDmg);
        if (!R.singularityRelease) R.singularityRelease = `🌌 **SINGULARITY** explodes! Both fighters take **${playerDmg}** damage!`;
        player._singularityStored = 0; this.enemy._singularityStored = 0;
        this.enemy._singularityTurns = 0;
      }
    }
    // Tick miscellaneous turn-based debuffs/states
    if (this.enemy._accuracyDebuffTurns > 0) {
      this.enemy._accuracyDebuffTurns--;
      if (this.enemy._accuracyDebuffTurns <= 0) this.enemy._accuracyDebuff = 0;
    }
    if (this.enemy._critDebuffTurns > 0) {
      this.enemy._critDebuffTurns--;
      if (this.enemy._critDebuffTurns <= 0) this.enemy._critDebuff = 0;
    }
    if (this.enemy._missChanceBonusTurns > 0) {
      this.enemy._missChanceBonusTurns--;
      if (this.enemy._missChanceBonusTurns <= 0) this.enemy._missChanceBonus = 0;
    }
    if (this.enemy._passiveDisabledTurns > 0) this.enemy._passiveDisabledTurns--;
    if (player._smokeScreenCooldown > 0) player._smokeScreenCooldown--;
    if (player._coreDisabled > 0) player._coreDisabled--;
    if (player._spotlightTurns > 0) player._spotlightTurns--;
    if (this.enemy._contractRecoilTurns > 0) this.enemy._contractRecoilTurns--;
    if (this.enemy._blueSoulRestrict > 0) this.enemy._blueSoulRestrict--;
    if (this.enemy._finalGambitForcedSkip > 0) this.enemy._finalGambitForcedSkip--;
    if (this.enemy._sabotageLock > 0) this.enemy._sabotageLock--;
    if (this.enemy._enemyDamageReduceTurns > 0) {
      this.enemy._enemyDamageReduceTurns--;
      if (this.enemy._enemyDamageReduceTurns <= 0) this.enemy._enemyDamageReduce = 0;
    }
    // Hazy stack timer at cap
    if (this.enemy._hazyCapTimer > 0) {
      this.enemy._hazyCapTimer--;
      if (this.enemy._hazyCapTimer <= 0) this.enemy._hazyStacks = 0;
    }
    // Tick disabled abilities (Shockwave Canon disable)
    if (this.enemy._disabledAbilities) {
      for (const idx of Object.keys(this.enemy._disabledAbilities)) {
        this.enemy._disabledAbilities[idx]--;
        if (this.enemy._disabledAbilities[idx] <= 0) delete this.enemy._disabledAbilities[idx];
      }
    }
    // Clear Bone Shifter trap and Tommy Gun weaken (one-turn flags)
    if (this.enemy._boneShifterTrap) this.enemy._boneShifterTrap = 0;
    if (this.enemy._tommyGunWeaken) this.enemy._tommyGunWeaken = 0;
    // Clear last-used-damaging flag (will be re-set if enemy attacks next turn)
    this.enemy._lastUsedDamaging = false;
    // ============================================================
    // === END UPDATE 13 TICKS ===
    // ============================================================
    // --- UPDATE 31: Goop is removed when the Melting one dies ---
    for (const _f of this.playerTeam) {
      if (!_f.isAlive && (_f.passive?.type === 'itHurtsPap' || _f.passive?.type === 'itHurts')) {
        _f._clearGoopFrom(this.enemy, _f.id);
      }
    }
    // ===================== UPDATE 31 END-OF-TURN HOOKS =====================
    // Axe Momentum (C!Insanity base passive) — +1 ATK per damaging move landed, max +6
    if (player.passive?.type === 'axeMomentum' && hasPassiveUnlocked(player.level) && player._attackedThisTurn) {
      const cap = player.passive.maxStacks || 6;
      if ((player._axeMomentum || 0) < cap) {
        player._axeMomentum = (player._axeMomentum || 0) + 1;
        player.passiveAtkAccumulated += 1;
        if (!R.axeMomentumProc) R.axeMomentumProc = `🪓 **Axe Momentum** — **+1 ATK** (${player._axeMomentum}/${cap})!`;
      }
      if ((player._axeMomentum || 0) >= cap && this.enemy.isAlive) {
        if (player._applyStatusFor(this.enemy, 'bleed', player.passive.bleedDuration || 2)) {
          if (!R.axeMomentumBleed) R.axeMomentumBleed = `🪓 **Axe Momentum** is at full force — **Bleed** applied!`;
        }
      }
    }
    // Fractured Focus (C!Insanity Weak base passive) — 25% chance enemy -1 DEF, max 5
    if (player.passive?.type === 'fracturedFocus' && hasPassiveUnlocked(player.level) && player._attackedThisTurn) {
      const cap = player.passive.maxStacks || 5;
      if ((player._fracturedFocus || 0) < cap && Math.random() < (player.passive.chance || 0.25)) {
        player._fracturedFocus = (player._fracturedFocus || 0) + 1;
        this.enemy.defMod -= 1;
        if (!R.fracturedFocusProc) R.fracturedFocusProc = `💠 **Fractured Focus** — Enemy **-1 DEF** (${player._fracturedFocus}/${cap})!`;
      }
    }
    // Terminal Delirium (Hardmode Insanity) — queued melee-bone counter
    if (player._delirumCounter > 0 && this.enemy.isAlive) {
      const cd = player._delirumCounter; player._delirumCounter = 0;
      this.enemy.currentHp = Math.max(0, this.enemy.currentHp - cd);
      if (!R.terminalDeliriumProc) R.terminalDeliriumProc = `🦴 **Terminal Delirium** — instant counter for **${cd}** damage!`;
      if (this.enemy.currentHp <= 0) { this.isOver = true; this.winner = 'player'; if (!R.battleEnd) R.battleEnd = { winner: 'player', message: `**${this.enemy.name}** was defeated by Terminal Delirium!` }; }
    }
    // Retensive Healing (Unnamed Kindness) — permanent 5 HP/turn to whoever is active
    if (this._retensiveHeal > 0 && player.isAlive) {
      const rh = player.heal(this._retensiveHeal);
      if (rh > 0 && !R.retensiveHealProc) R.retensiveHealProc = `✨ **Retensive Healing** restored **${rh} HP** to **${player.name}**!`;
    }
    // GRAB (!REBAR!) — 5 dmg/turn to the grabbed enemy
    if (player._grabActive && this.enemy.isAlive) {
      this.enemy.currentHp = Math.max(0, this.enemy.currentHp - (player._grabDot || 5));
      if (!R.grabProc) R.grabProc = `🔩 The **GRAB** grinds for **${player._grabDot || 5}** damage! (**${player._grabHitsRemaining}** hits left to break free)`;
      if (this.enemy.currentHp <= 0) { this.isOver = true; this.winner = 'player'; if (!R.battleEnd) R.battleEnd = { winner: 'player', message: `**${this.enemy.name}** was crushed by the GRAB!` }; }
    }
    // BLOODTHIRST (!REBAR!) — ends when the opponent dies; heal 75 and gain permanent +3 ATK
    if (player._bloodthirstActive && !this.enemy.isAlive) {
      player._bloodthirstActive = false;
      player.atkMod -= (player._bloodthirstAtk || 15);
      player.defMod += (player._bloodthirstDef || 15);
      const bh = player.heal(player._bloodthirstEndHeal || 75);
      player.passiveAtkAccumulated += (player._bloodthirstEndAtk || 3);
      if (!R.bloodthirstEnd) R.bloodthirstEnd = `🩸 **BLOODTHIRST** ends — healed **${bh} HP** and gained a permanent **+${player._bloodthirstEndAtk || 3} ATK**!`;
    }
    // REBAR timed buffs / flags tick down
    if (player._rebarBlockDoubleTurns > 0) player._rebarBlockDoubleTurns--;
    if (player._rebarChargeBlock > 0 && !player.isCharging) player._rebarChargeBlock = 0;
    if (player._rebarStanceTurns > 0) {
      player._rebarStanceTurns--;
      if (player._rebarStanceTurns <= 0) {
        if (player._rebarStanceDef) { player.defMod -= player._rebarStanceDef; player._rebarStanceDef = 0; }
        if (player._rebarStanceAtk) { player.atkMod += player._rebarStanceAtk; player._rebarStanceAtk = 0; }
        player._rebarStanceBlockDouble = 0;
        player._rebarDoubleHits = 0;
        if (!R.rebarStanceEnd) R.rebarStanceEnd = `🔩 **${player.name}** returns to a neutral stance.`;
      }
    }
    // ===================== END UPDATE 31 END-OF-TURN HOOKS =====================
    player.tickCooldowns();
    this.enemy.tickCooldowns();
    // Timeline Star tick for all alive team members
    for (const fighter of this.playerTeam) {
      if (fighter.isAlive && fighter.savedStateTurnsLeft > 0) {
        const shouldRestore = fighter.tickTimeline();
        if (shouldRestore) {
          fighter.restoreState();
          if (!R.timelineRestore) R.timelineRestore = [];
          R.timelineRestore.push(`**${fighter.name}**'s stats have been restored by **Timeline Star**!`);
        }
      }
    }
    R.battleEnd = R.battleEnd || this.checkBattleEnd();
    // Tick team ability cooldown
    if (this.teamAbilityCooldown > 0) this.teamAbilityCooldown--;
    // Tick forced smile immunity
    if (this.enemy._forcedSmileImmune) {
      this.enemy._forcedSmileTurnsLeft--;
      if (this.enemy._forcedSmileTurnsLeft <= 0) {
        this.enemy._forcedSmileImmune = false;
        if (!R.forcedSmileEnd) R.forcedSmileEnd = `😬 **The forced grin fades...** The shield is gone! Now you can deal damage!`;
      }
    }
    // Tick NO EFFECT shield
    for (const fighter of this.playerTeam) {
      if (fighter._noEffectShieldTurns > 0) {
        fighter._noEffectShieldTurns--;
        if (fighter._noEffectShieldTurns <= 0) { fighter._noEffectShield = false; }
      }
    }
    // --- UPDATE 19: New passive ticks ---
    // Reaper Sans: Death's Touch HP drain on enemy
    if (this.enemy._deathTouchStacks > 0) {
      const dtResult = this.processFearOfDeathTick(this.enemy, player);
      if (dtResult && dtResult.drain > 0) {
        if (!R.deathTouchTick) R.deathTouchTick = [];
        const isMarked = this.isMarkedForDeath(this.enemy);
        R.deathTouchTick.push(`💀 **Death's Touch** (${dtResult.stacks} stacks) drains **${dtResult.drain} HP** from **${this.enemy.name}**!${isMarked ? ' ☠️ **MARKED — next attack deals 1.5x!**' : ''}`);
        if (!this.enemy.isAlive && !R.battleEnd) R.battleEnd = this.checkBattleEnd();
      }
    }
    // Green Sans: Aura Farm — track turns for passive buff
    if (player.passive?.type === 'auraFarm' && hasPassiveUnlocked(player.level)) {
      // Checked in executePlayerAbility start instead — remove from endTurn
    }
    // Seraphim: Souls Help — now fires at start of executePlayerAbility instead
    // Roaring Knight boss: Strife by Strife passive — mark a move every 3 turns
    if (this.enemy.passive?.type === 'strifeByStrife' && this.turnNumber > 0) {
      const markedIdx = this.processStrifeByStrife(this.enemy, player.abilities, this.turnNumber);
      if (markedIdx !== null) {
        const markedName = player.abilities[markedIdx]?.name || `Move ${markedIdx + 1}`;
        if (!R.strifeWarning) R.strifeWarning = `⚠️ **Strife by Strife!** The Roaring Knight marks **${markedName}** — using it will **SWOON** you instantly! Skip it to purify the mark.`;
      }
    }
    // Roaring Knight character: Strife by Strife char — mark self move every 3 turns
    if (player.passive?.type === 'rkCharPassive' && hasPassiveUnlocked(player.level)) {
      const markedIdx = this.processRkCharPassive(player, player.turnCount);
      if (markedIdx !== null) {
        const markedName = player.abilities[markedIdx]?.name || `Move ${markedIdx + 1}`;
        if (!R.rkMarkNotice) R.rkMarkNotice = `⚔️ **Strife by Strife:** **${markedName}** is MARKED! Use it for +2 ATK/DEF and +12 bonus damage this turn. Skip it to clear the mark.`;
      }
    }
    // Tick Death's Touch cooldown (Reaper Sans)
    for (const f of this.playerTeam) {
      if (f._deathTouchCooldown > 0) f._deathTouchCooldown--;
    }
    // Tick Reaper Sans Sword Throw bonus flag
    for (const f of this.playerTeam) {
      if (f._rkSwordThrowBonus > 0) f._rkSwordThrowBonus--;
    }
    // Tick Perseverance dmg reduce (Seraphim)
    if (this.enemy._perseveranceDmgReduce > 0) {
      this.enemy._perseveranceDmgReduce = 0; // consumed after 1 hit (handled in takeDamage area)
    }
    // Tick Integrity dodge (Seraphim)
    if (player._integrityDodge > 0) player._integrityDodge = 0;
    // Tick Star Shards stacks (they persist until cleared — no tick needed, just track)

    // --- JEVIL'S SCYTHE relic — holder gains +2 ATK each time they skip their turn ---
    if (player._jevilSkipped) {
      if (player.equipped === 'jevils_scythe') {
        player.passiveAtkAccumulated += 2;
        R.scytheProc = `🪓 **Jevil's Scythe** — ${player.name} skipped and gains **+2 ATK**!`;
      }
      player._jevilSkipped = false;
    }

    // --- JEVIL: THE WORLD REVOLVING passive — after each full turn, force-switch the player;
    // when Jevil runs out of attacks on every ability, the fight ends (player loses). ---
    if (this.enemy.passive?.type === 'theWorldRevolving' && !this.isOver && this.enemy.isAlive) {
      const outOfAttacks = (this.enemy._carouselTurns || 0) <= 0 && this.enemy.abilities.every(a => (a.currentUses || 0) <= 0);
      if (outOfAttacks) {
        this.isOver = true; this.winner = 'enemy';
        R.battleEnd = { winner: 'enemy', message: `**${this.enemy.name}** runs out of tricks... but so did you. The game ends. **UEE HEE HEE!**` };
      } else {
        const others = this.playerTeam.map((f, i) => ({ f, i })).filter(({ f, i }) => f.isAlive && i !== this.activePlayerIndex);
        if (others.length > 0) {
          const swap = others[Math.floor(Math.random() * others.length)];
          this.activePlayerIndex = swap.i;
          R.worldRevolving = `🎠 **THE WORLD REVOLVING!** You're spun out of the ring — **${swap.f.name}** is forced in!`;
        }
        // else: no other alive teammate — the passive does nothing this turn
      }
    }
  }

  releaseChargedAbility() {
    const p = this.activePlayer; if (!p.isCharging || p.chargedAbility === null) return null;
    p.isCharging = false; const i = p.chargedAbility; p.chargedAbility = null;
    p.isReleasing = true; const r = this.executePlayerAbility(i); p.isReleasing = false; return r;
  }

  // --- JEVIL: CAROUSEL OF CALAMITY resolver ---
  // First cast starts a forced ride; the ride locks Jevil into repeating the move
  // for `lockTurns` more turns, gaining +step damage each turn, then resets.
  // =====================================================================
  // SCAMTON [[THE GREAT]] — helpers
  // =====================================================================
  // Any living party member, bench included.
  _scamtonAnyTarget() {
    const alive = this.playerTeam.filter(f => f.isAlive);
    if (alive.length === 0) return this.activePlayer;
    return alive[Math.floor(Math.random() * alive.length)];
  }
  _scamtonHit(ability, target, overrideDmg = null) {
    const tmp = overrideDmg === null ? ability : { ...ability, damageMin: overrideDmg, damageMax: overrideDmg };
    const d = this.calculateDamage(this.enemy, tmp, target);
    target.takeDamage(d.totalDamage);
    return d;
  }
  // BIGSHOT EXPRESS — locks Scamton in for 3 turns; only the first cast spends a use.
  _scamtonExpressResolve(ability, player) {
    const sp = ability.special;
    const lockTurns = sp.lockTurns || 3;
    let firstCast = false;
    if ((this.enemy._expressTurns || 0) <= 0) {
      firstCast = true;
      this.enemy._expressTurns = lockTurns;
      this.enemy._expressCast = 0;
      this.enemy.defMod += (sp.defBoost || 4);
      if (!this.enemy._tempDebuffs) this.enemy._tempDebuffs = [];
      this.enemy._tempDebuffs.push({ stat: 'def', amount: (sp.defBoost || 4), turnsLeft: (sp.defTurns || 4), source: 'BIGSHOT EXPRESS' });
    } else {
      this.enemy._expressCast = (this.enemy._expressCast || 0) + 1;
    }
    this.enemy._expressTurns -= 1;
    const target = this._scamtonAnyTarget();
    const d = this._scamtonHit(ability, target);
    const benched = target !== this.activePlayer ? ' *(from the bench!)*' : '';
    const rideMsg = firstCast
      ? ` 🚂 *ALL ABOARD! **+${sp.defBoost || 4} DEF** for ${sp.defTurns || 4} turns!*`
      : ` 🚂 *The express rolls on... (${(this.enemy._expressCast || 0) + 1}/${lockTurns})*`;
    const overMsg = (this.enemy._expressTurns || 0) <= 0 ? ' 🚂 *The express pulls into the station.*' : '';
    return {
      ability: ability.name, abilityType: ability.type,
      message: `**${this.enemy.name}** used **${ability.name}** on **${target.name}**${benched}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${rideMsg}${overMsg}`,
      damage: d.totalDamage, scamtonTarget: target.name,
    };
  }
  // CARDS OF [[FATE]] — arms the 4-card picker; index.js renders it and calls resolveCardsOfFate().
  _scamtonArmCards(ability) {
    const sp = ability.special;
    const effects = ['heal', 'skip', 'damage', 'effect'];
    for (let i = effects.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [effects[i], effects[j]] = [effects[j], effects[i]]; }
    const suits = ['\u2666\uFE0F', '\u2660\uFE0F', '\u2764\uFE0F', '\u2663\uFE0F'];
    this._pendingCards = {
      effects, suits,
      timerSeconds: sp.timerSeconds || 10,
      healMin: sp.healMin || 20, healMax: sp.healMax || 30,
      damageMin: sp.damageMin || 30, damageMax: sp.damageMax || 40,
      abilityName: ability.name,
    };
    return {
      ability: ability.name, abilityType: ability.type,
      message: `🃏 **${this.enemy.name}** used **${ability.name}**! *[PICK A [[Card]], ANY [[KAARD]]!]* — **${sp.timerSeconds || 10} seconds** to choose, or fate chooses for you!`,
      damage: 0, cardsArmed: true,
    };
  }
  // Resolves a picked card. index === null means the timer ran out (fate auto-picks).
  resolveCardsOfFate(index = null) {
    const pc = this._pendingCards;
    if (!pc) return null;
    const auto = (index === null || index === undefined || index < 0 || index > 3);
    const pick = auto ? Math.floor(Math.random() * 4) : index;
    const effect = pc.effects[pick];
    const suit = pc.suits[pick];
    const player = this.activePlayer;
    this._pendingCards = null;
    let msg = '', dmg = 0, skipPlayerTurn = false;
    if (effect === 'heal') {
      const amt = Math.floor(Math.random() * (pc.healMax - pc.healMin + 1)) + pc.healMin;
      const before = this.enemy.currentHp;
      this.enemy.currentHp = Math.min(this.enemy.maxHp, this.enemy.currentHp + amt);
      msg = `${suit} — **${this.enemy.name}** recovers **${this.enemy.currentHp - before} HP**! *HEHEHAHAHA!*`;
    } else if (effect === 'skip') {
      skipPlayerTurn = true;
      msg = `${suit} — nothing happens... your turn slips away!`;
    } else if (effect === 'damage') {
      const amt = Math.floor(Math.random() * (pc.damageMax - pc.damageMin + 1)) + pc.damageMin;
      const r = player.takeDamage(amt);
      dmg = r.damage !== undefined ? r.damage : amt;
      msg = `${suit} — the card bites! **${dmg}** damage to **${player.name}**!${r.lastStand ? ' **Last Stand!**' : ''}`;
    } else {
      const pool = ['burn', 'poison', 'stun', 'karma', 'bleed'];
      const key = pool[Math.floor(Math.random() * pool.length)];
      const sr = player.addStatus(key);
      msg = sr ? `${suit} — a random curse! **${sr.name}** applied to **${player.name}**!` : `${suit} — a random curse... but nothing sticks!`;
    }
    if (skipPlayerTurn) player.skipNextTurn = true;
    return { message: `${auto ? '⏰ *Time\'s up — fate picks for you!* ' : ''}${msg}`, damage: dmg, cardResolved: true };
  }
  // THE TRUE POWER OF [[NEO]] — builds a fresh button sequence for the given round.
  _neoBuildRound(round) {
    const count = round >= 3 ? 10 : 5;
    const timer = round >= 3 ? 10 : 7;
    const dmg = round >= 3 ? 40 : 30;
    const order = Array.from({ length: count }, (_, i) => i + 1);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    return { round, count, timer, dmg, layout: order, progress: 0 };
  }
  // Fail: whole party takes flat damage, then the same round restarts.
  neoFail() {
    const mg = this._neoMinigame;
    if (!mg) return null;
    const hits = [];
    for (const f of this.playerTeam) {
      if (!f.isAlive) continue;
      const r = f.takeDamage(mg.dmg);
      hits.push(`**${f.name}** -${r.damage !== undefined ? r.damage : mg.dmg}`);
    }
    const wiped = this.playerTeam.every(f => !f.isAlive);
    if (wiped) { this._neoMinigame = null; return { wiped: true, message: `💀 **${mg.dmg}** damage to everyone — ${hits.join(', ')}. Your whole party has fallen...` };
    }
    this._neoMinigame = this._neoBuildRound(mg.round);
    return { wiped: false, message: `❌ **WRONG!** **${mg.dmg}** damage to everyone — ${hits.join(', ')}. *Sequence ${mg.round} restarts!*` };
  }
  // A number was pressed. Returns { ok, done, failed, message }.
  neoPress(value) {
    const mg = this._neoMinigame;
    if (!mg) return null;
    const expected = mg.progress + 1;
    if (value !== expected) { const f = this.neoFail(); return { ok: false, failed: true, wiped: f?.wiped, message: f?.message }; }
    mg.progress++;
    if (mg.progress >= mg.count) {
      if (mg.round >= 3) { this._neoMinigame = null; this.enemy._neoCleared = true; return { ok: true, done: true, message: '✅ **SEQUENCE 3 CLEARED!** *"...WHAT?!"* Your UI snaps back into place!' }; }
      this._neoMinigame = this._neoBuildRound(mg.round + 1);
      return { ok: true, done: false, message: `✅ **SEQUENCE ${mg.round} CLEARED!** *Sequence ${mg.round + 1} begins — ${this._neoMinigame.count} buttons, ${this._neoMinigame.timer} seconds!*` };
    }
    return { ok: true, done: false, message: null };
  }

  _jevilCarouselResolve(ability, player) {
    const base = ability.special.base || 20;
    const step = ability.special.step || 15;
    const lockTurns = ability.special.lockTurns || 2;
    if ((this.enemy._carouselTurns || 0) <= 0) {
      // Fresh ride begins (this is the first cast)
      this.enemy._carouselCast = 0;
      this.enemy._carouselTurns = lockTurns;
    } else {
      // Forced continuation
      this.enemy._carouselCast = (this.enemy._carouselCast || 0) + 1;
      this.enemy._carouselTurns -= 1;
    }
    const castIdx = this.enemy._carouselCast;
    const dmgVal = base + step * castIdx;
    const tmp = { ...ability, damageMin: dmgVal, damageMax: dmgVal };
    const d = this.calculateDamage(this.enemy, tmp, player);
    player.takeDamage(d.totalDamage);
    let extras;
    if ((this.enemy._carouselTurns || 0) <= 0) {
      this.enemy._carouselCast = undefined; // ride over — damage resets next time
      extras = ' 🎠 *The carousel grinds to a halt...*';
    } else {
      extras = ` 🎠 *PIIP PIIP! The carousel spins faster! (${castIdx + 1}/${lockTurns + 1})*`;
    }
    return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}**! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
  }

  executeEnemyTurn() {
    if (!this.enemy.isAlive) return null;
    const player = this.activePlayer;
    // --- UPDATE 20: Memories Dodge — enemy attacks disabled for 1 round
    const memDodge = this.enemy.statusEffects.find(s => s.name === 'Memories Dodge');
    if (memDodge) {
      this.enemy.statusEffects = this.enemy.statusEffects.filter(s => s !== memDodge);
      return { message: `💭 **${this.enemy.name}**'s attacks are disabled by Memories Dodge!`, damage: 0 };
    }
    // ZA WARUDO / skip
    if (this.enemy.skipNextTurn) {
      this.enemy.skipNextTurn = false;
      return { message: `**${this.enemy.name}** is frozen in time and can't attack!`, damage: 0 };
    }
    // --- UPDATE 13: skip check from Stolen Magic / Vine Strikes / Final Gambit ---
    if (this.enemy._skipNextTurn) {
      this.enemy._skipNextTurn = false;
      return { message: `**${this.enemy.name}** is forced to skip this turn!`, damage: 0 };
    }
    // Final Gambit forced skip
    if (this.enemy._finalGambitForcedSkip > 0) {
      return { message: `**${this.enemy.name}** is overwhelmed by **Final Gambit** and skips this turn!`, damage: 0 };
    }
    // --- UPDATE 20 BUG FIX: Domain Expansion multi-turn stun ---
    if (this.enemy._domainStunTurns > 0) {
      this.enemy._domainStunTurns--;
      return { message: `🌌 **${this.enemy.name}** is trapped in the **Domain** and can't attack! (${this.enemy._domainStunTurns} turns left)`, damage: 0 };
    }
    const incapacitated = this.enemy.statusEffects.find(s => s.name === 'Stun' || s.name === 'Flinch' || s.name === 'Frozen');
    if (incapacitated) {
      const state = incapacitated.name === 'Stun' ? 'stunned' : (incapacitated.name === 'Flinch' ? 'flinched' : 'frozen');
      if (incapacitated.name !== 'Frozen') {
        this.enemy.statusEffects = this.enemy.statusEffects.filter(s => s !== incapacitated);
      }
      return { message: `**${this.enemy.name}** is ${state} and can't attack!`, damage: 0 };
    }
    // --- UPDATE 22: Regret — 25% chance to not attack, -1 ATK each proc ---
    if (this.enemy.hasStatus('Regret') && Math.random() < 0.25) {
      this.enemy.atkMod -= 1;
      return { message: `😔 **${this.enemy.name}** is consumed by **Regret** and doesn't attack! **-1 ATK!**`, damage: 0 };
    }
    // Gravity Shift: next move fails
    if (this.enemy._nextMoveFails) {
      this.enemy._nextMoveFails = false;
      return { message: `**${this.enemy.name}** tries to attack but is **disoriented** and fails!`, damage: 0 };
    }
    // Insanity 4+ stacks — 30% move fail
    if (this.enemy._insanityMoveFail && Math.random() < this.enemy._insanityMoveFail) {
      return { message: `**${this.enemy.name}**'s SOUL is unstable from [INSANITY]! Move **failed**!`, damage: 0 };
    }
    // --- SCAMTON: THE TRUE POWER OF [[NEO]] — fires once at 300 HP or less ---
    if (this.enemy.passive?.type === 'neoPower' && !this.enemy._neoTriggered
        && this.enemy.currentHp <= (this.enemy.passive.threshold || 300)) {
      this.enemy._neoTriggered = true;
      this._neoMinigame = this._neoBuildRound(1);
      return {
        message: `*"**ENOUGH!!!**"*\n*"YOU [[BRATS]] HAVE TIRED ME OUT!!!"*\n*"[[Feast your eyes upon my g-]] THE TRUE POWER OF [[NEO]]!!!"*\n\n**Your UI is erased.** Hit the buttons **1 through ${this._neoMinigame.count}** in order — **${this._neoMinigame.timer} seconds!**`,
        damage: 0, neoStart: true,
      };
    }
    // --- SCAMTON: BIGSHOT EXPRESS forced-repeat lock ---
    if ((this.enemy._expressTurns || 0) > 0) {
      const eIdx = this.enemy.abilities.findIndex(a => a.special?.type === 'bigshotExpress');
      if (eIdx !== -1) {
        const eab = this.enemy.abilities[eIdx];
        this.enemy._lastUsedMove = eIdx;
        this.enemy._usedAbilityThisTurn = true; this.enemy._attackedThisTurn = true;
        return this._scamtonExpressResolve(eab, player);
      }
    }
    // --- JEVIL: CAROUSEL OF CALAMITY forced-repeat lock (must ride it out) ---
    if ((this.enemy._carouselTurns || 0) > 0) {
      const cIdx = this.enemy.abilities.findIndex(a => a.special?.type === 'jevilCarousel');
      if (cIdx !== -1) {
        const cab = this.enemy.abilities[cIdx];
        this.enemy._lastUsedMove = cIdx;
        this.enemy._usedAbilityThisTurn = true; this.enemy._attackedThisTurn = true;
        return this._jevilCarouselResolve(cab, player);
      }
    }
    const avail = this.enemy.abilities.map((a, i) => ({ ability: a, index: i })).filter(({ ability, index }) => {
      if (ability.currentUses <= 0) return false;
      if (ability.cooldownLeft > 0) return false;
      if (ability._disabledTurns > 0) return false;
      // --- UPDATE 13 ---
      // Shockwave Canon disabled abilities
      if (this.enemy._disabledAbilities && this.enemy._disabledAbilities[index] > 0) return false;
      // Blue Soul Restrict (Hardmode Sans) — restrict to first 2 moves
      if (this.enemy._blueSoulRestrict > 0 && index >= 2) return false;
      // System Sabotage — no damaging or healing moves
      if (this.enemy._sabotageLock > 0) {
        if (ability.damageMax > 0) return false;
        if (ability.special?.type === 'heal') return false;
      }
      // Devastating Roar lockout — block boost/heal/def moves
      if (this.enemy._roarLockoutTurns > 0) {
        const t = ability.special?.type;
        if (t === 'heal' || t === 'parry' || t === 'taunt' || t === 'debuff' || t === 'gravityManip' || t === 'savePointAnchor' || t === 'timelineStar' || t === 'aggravation') return false;
      }
      // Echo Protection: disable Flower Echo below 50% HP
      if (this.enemy.passive?.type === 'echoProtection' && ability.name === 'Flower Echo' && this.enemy.currentHp / this.enemy.maxHp < 0.5) return false;
      // Capture Bone: force melee
      if (this.enemy._forceMeleeNext && ability.type !== 'Melee') return false;
      return true;
    });
    if (this.enemy._forceMeleeNext) {
      // If no melee available, take extra damage instead
      if (avail.length === 0) {
        player.currentHp = Math.max(0, player.currentHp); // nothing to do
        this.enemy._forceMeleeNext = false;
        const extraDmg = 10;
        this.enemy.currentHp = Math.max(0, this.enemy.currentHp - extraDmg);
        return { message: `**${this.enemy.name}** struggles against the strings and takes **${extraDmg}** damage!`, damage: 0 };
      }
      this.enemy._forceMeleeNext = false;
    }
    if (avail.length === 0) return { message: `**${this.enemy.name}** has no moves left!` };
    const picked = avail[Math.floor(Math.random() * avail.length)];
    const ability = picked.ability;
    this.enemy._lastUsedMove = picked.index;
    ability.currentUses--;
    if (ability.special?.cooldown) ability.cooldownLeft = ability.special.cooldown + 1;
    this.enemy._usedAbilityThisTurn = true; this.enemy._attackedThisTurn = ability.damageMax > 0;
    // --- UPDATE 20: Pesto Sans "Food" passive — +1 ATK when opponent uses Food-type move
    if (player.passive?.type === 'pestoFood' && hasPassiveUnlocked(player.level) && (ability.type === 'Food' || (ability.type || '').includes('Food'))) {
      player.atkMod += (player.passive.atkBoost || 1);
      // Note: this stacks each food move used
    }
    if (this.enemy._attackedThisTurn) {
      const miss = this.enemy.consumeAttackMiss();
      if (miss) {
        const missMsg = miss.source === 'blindness' ? '**Blindness** caused the attack to miss!' : (miss.source === 'rain' ? '🌧️ the **Heavy Rain** blurred their vision — missed!' : 'the attack missed!');
        return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}**... but ${missMsg}`, damage: 0 };
      }
    }
    if (ability.special?.type === 'debuff') {
      const t = ability.special.target === 'enemy' ? player : this.enemy;
      if (ability.special.stat === 'atk') t.atkMod += ability.special.amount;
      if (ability.special.stat === 'def') t.defMod += ability.special.amount;
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}**! ${t.name}'s ${ability.special.stat.toUpperCase()} ${ability.special.amount}!`, damage: 0 };
    }
    if (ability.special?.type === 'multiDebuff') {
      if (ability.special.enemyDef) player.defMod += ability.special.enemyDef;
      if (ability.special.enemyAtk) player.atkMod += ability.special.enemyAtk;
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}**! Your DEF ${ability.special.enemyDef || 0}, ATK ${ability.special.enemyAtk || 0}!`, damage: 0 };
    }
    // --- SCAMTON: CARDS OF [[FATE]] — must be caught before the generic 0-damage branch ---
    if (ability.special?.type === 'cardsOfFate') {
      return this._scamtonArmCards(ability);
    }
    if (ability.damageMax <= 0) {
      if (ability.special?.type === 'blueSoulBoss') {
        player.defMod -= ability.special.defReduce;
        let stunMsg = '';
        if (Math.random() < ability.special.stunChance) { player.addStatus('stun'); stunMsg = ' **Stunned!**'; }
        return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}**! Your DEF -${ability.special.defReduce}!${stunMsg}`, damage: 0 };
      }
      if (ability.special?.type === 'handsOfFate') {
        const statuses = ['burn', 'poison', 'stun'];
        const picked = statuses[Math.floor(Math.random() * statuses.length)];
        player.addStatus(picked);
        return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}**! Applied **${picked}**!`, damage: 0 };
      }
      // specialAttack (Papyrus boss)
      if (ability.special?.type === 'specialAttack') {
        if (Math.random() < ability.special.failChance) {
          this.enemy.defMod += ability.special.defBoostOnFail;
          ability.cooldownLeft = (ability.special.cooldown || 3) + 1;
          return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}**... but it **failed**! +${ability.special.defBoostOnFail} DEF instead.`, damage: 0 };
        }
      }
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}**!`, damage: 0 };
    }
    // --- UPDATE 32: Doki Meter — Mad Mew Mew cannot dodge at all ---
    if (player._noDodge) { player.dodgeNextAttack = false; player._foresightActive = false; player._inkTrailActive = false; }
    if (player.dodgeNextAttack) { player.dodgeNextAttack = false; return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}**... **${player.name}** dodged!`, damage: 0 }; }
    // Foresight (FT!Sans) — 20% dodge chance
    if (player.passive?.type === 'foresight' && hasPassiveUnlocked(player.level) && player._foresightActive) {
      player._foresightActive = false;
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}**... **${player.name}** saw it coming! (**Foresight** dodged!)`, damage: 0, missed: true };
    }
    // Ink Trail (Shanghaivania) — 20% miss on enemy attack
    if (player._inkTrailActive && Math.random() < 0.2) {
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}**... 🎨 **Ink Trail** blurred their vision — missed!`, damage: 0, missed: true };
    }
    // King's Hesitation (Asgore) — -10% accuracy first 2 turns
    if (this.enemy.passive?.type === 'kingsHesitation' && !this.enemy._asgorePhaseSet && this.enemy.turnCount <= 2) {
      if (Math.random() < 0.10) return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}**... but hesitated and **missed**! (**King's Hesitation**)`, damage: 0 };
    }
    if (player.passive?.type === 'reflexes' && hasPassiveUnlocked(player.level) && Math.random() < player.def / 100) {
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}**... **${player.name}** reflexed and nullified the attack! (**Reflexes**).`, damage: 0 };
    }
    if (player.passive?.type === 'dodge' && hasPassiveUnlocked(player.level) && Math.random() < player.passive.chance) {
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}**... **${player.name}** dodged! (**${player.passive.name}**)`, damage: 0 };
    }
    if (player.parrying) {
      const d = this.calculateDamage(this.enemy, ability, player);
      const rm = getTypeMultiplier('Weapon', this.enemy.type);
      const rd = Math.max(1, Math.floor(d.totalDamage * rm)); this.enemy.takeDamage(rd);
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** attacked... **${player.name}** parried! **${rd}** reflected!`, damage: 0 };
    }
    // Get Dunked Kid counter
    if (player._getDunkedActive) {
      player._getDunkedActive = false;
      const counterAbility = { type: 'Unique', damageMin: 25, damageMax: 35 };
      const cd = this.calculateDamage(player, counterAbility, this.enemy);
      this.enemy.takeDamage(cd.totalDamage);
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** attacks... **GET DUNKED KID!** Countered for **${cd.totalDamage}** damage!`, damage: 0 };
    }
    // NUH UH counter
    if (player._nuhUhActive) {
      player._nuhUhActive = false;
      const sr = player.addStatus('blueSoul');
      const bonusDmg = 20;
      this.enemy.takeDamage(bonusDmg);
      player.passive && (player.passive._nuhUhPassiveDisabled = true);
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** attacks... **NUH UH!!!!!!** Counter! +${bonusDmg} bonus damage! **Blue Soul** applied! Passive disabled!`, damage: 0 };
    }
    // --- UPDATE 19: Roaring Knight boss special ability handlers ---
    if (ability.special?.type === 'rkBossSwordThrow') {
      const d = this.calculateDamage(this.enemy, ability, player);
      let finalDmg = d.totalDamage;
      if (this.enemy._knifeWasLastMove) { finalDmg += (ability.special.knifeBonus || 5); }
      player.takeDamage(finalDmg);
      this.enemy._swordThrowLastMove = true; this.enemy._knifeWasLastMove = false;
      let extras = '';
      if (Math.random() < (ability.special.bleedChance || 0.40)) { player.addStatus('bleed'); extras += ' **Bleed!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}** ${emoji}! **${finalDmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: finalDmg };
    }
    if (ability.special?.type === 'rkBossStarStorm') {
      const d = this.calculateDamage(this.enemy, ability, player);
      player.takeDamage(d.totalDamage);
      const stacks = ability.special.starShardsStacks || 2;
      player._starShardsStacks = (player._starShardsStacks || 0) + stacks;
      const emoji = TYPES[ability.type]?.emoji || '';
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} 🌟 **${stacks} Star Shards** applied to **${player.name}**! (${player._starShardsStacks} total)`, damage: d.totalDamage };
    }
    if (ability.special?.type === 'rkBossKnifeThrust') {
      const d = this.calculateDamage(this.enemy, ability, player);
      player.takeDamage(d.totalDamage);
      this.enemy._knifeWasLastMove = true; this.enemy._swordThrowLastMove = false;
      let extras = '';
      if (Math.random() < (ability.special.forceSwitchChance || 0.10)) {
        const nextIdx = this.playerTeam.findIndex((f, i) => f.isAlive && i !== this.activePlayerIndex);
        if (nextIdx !== -1) { this.activePlayerIndex = nextIdx; extras += ` **Force Switch!** ${this.playerTeam[this.activePlayerIndex].name} is now active!`; }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
    }
    if (ability.special?.type === 'rkBossRealityCut') {
      const d = this.calculateDamage(this.enemy, ability, player);
      player.takeDamage(d.totalDamage);
      const validAbils = player.abilities.filter(a => a.currentUses > 0);
      let drainMsg = '';
      if (validAbils.length > 0) {
        const target = validAbils[Math.floor(Math.random() * validAbils.length)];
        const drain = Math.min(target.currentUses, ability.special.usesDrain || 3);
        target.currentUses -= drain;
        drainMsg = ` 🌑 Drained **${drain} uses** from **${target.name}**!`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${drainMsg}`, damage: d.totalDamage };
    }
    // ============================================================
    // === JEVIL, THE LOUSY DEVIL — ability handlers ===
    // ============================================================
    // 1) DIAMOND WAVES! — 50% chance to slightly raise Jevil's own dodge
    if (ability.special?.type === 'jevilDiamondWaves') {
      const d = this.calculateDamage(this.enemy, ability, player);
      player.takeDamage(d.totalDamage);
      let extras = '';
      if (Math.random() < (ability.special.dodgeChance || 0.5)) {
        this.enemy._jevilDodge = Math.min(ability.special.dodgeCap || 0.30, (this.enemy._jevilDodge || 0) + (ability.special.dodgeGain || 0.05));
        extras = ` 💎 *Jevil grows harder to hit! (${Math.round(this.enemy._jevilDodge * 100)}% dodge)*`;
      }
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}**! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
    }
    // 2) CHAOS BOX! — inflict either karma, burn, -2 DEF, -2 ATK, or stun 3 turns
    if (ability.special?.type === 'jevilChaosBox') {
      const d = this.calculateDamage(this.enemy, ability, player);
      player.takeDamage(d.totalDamage);
      const pool = ['karma', 'burn', 'defDown', 'atkDown', 'stun'];
      const pick = pool[Math.floor(Math.random() * pool.length)];
      let effMsg = '';
      if (pick === 'karma') { const sr = player.addStatus('karma'); effMsg = sr ? ' ☯️ **Karma!**' : ''; }
      else if (pick === 'burn') { const sr = player.addStatus('burn'); effMsg = sr ? ' 🔥 **Burn!**' : ''; }
      else if (pick === 'defDown') { player.defMod -= 2; effMsg = ' 🛡️ **-2 DEF!**'; }
      else if (pick === 'atkDown') { player.atkMod -= 2; effMsg = ' ⚔️ **-2 ATK!**'; }
      else { player._chaosStunTurns = ability.special.stunDuration || 3; effMsg = ` 💫 **Stunned for ${ability.special.stunDuration || 3} turns!**`; }
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}**! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${effMsg}`, damage: d.totalDamage };
    }
    // 3) DEVIL'S KNIFE. — higher crit; on crit, +10 damage as Weakness
    if (ability.special?.type === 'jevilDevilsKnife') {
      const savedBoost = this.enemy.critBoost || 0;
      this.enemy.critBoost = savedBoost + (ability.special.critBonus || 0.30);
      const d = this.calculateDamage(this.enemy, ability, player);
      this.enemy.critBoost = savedBoost;
      let total = d.totalDamage; let extras = '';
      if (d.isCrit) { total += (ability.special.weaknessBonus || 10); extras = ` ⚡ *+${ability.special.weaknessBonus || 10} Weakness damage!*`; }
      player.takeDamage(total);
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}**! **${total}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: total };
    }
    // =====================================================================
    // SCAMTON [[THE GREAT]] — abilities
    // =====================================================================
    // 1) PIPIS POPPER — 1-3 hits, each can land on any party member (bench included)
    if (ability.special?.type === 'pipisPopper') {
      const sp = ability.special;
      const hits = Math.floor(Math.random() * ((sp.maxHits || 3) - (sp.minHits || 1) + 1)) + (sp.minHits || 1);
      let total = 0, crits = 0;
      const perTarget = {};
      for (let i = 0; i < hits; i++) {
        const t = this._scamtonAnyTarget();
        if (!t.isAlive) continue;
        const d = this._scamtonHit(ability, t);
        total += d.totalDamage; if (d.isCrit) crits++;
        perTarget[t.name] = (perTarget[t.name] || 0) + d.totalDamage;
      }
      const breakdown = Object.entries(perTarget).map(([n, v]) => `**${n}** -${v}`).join(', ');
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}**! **${hits}** hit${hits > 1 ? 's' : ''} for **${total}** total! ${breakdown}${crits ? ` *(${crits} CRIT!)*` : ''}`, damage: total };
    }
    // 2) [[HEART]] ATTACK! — +5% crit, extra swings as Scamton gets lower
    if (ability.special?.type === 'heartAttack') {
      const sp = ability.special;
      this.enemy.critBoost += (sp.critBonus || 0.05);
      let total = 0, swings = 0, crits = 0;
      const swing = () => { const d = this._scamtonHit(ability, player); total += d.totalDamage; swings++; if (d.isCrit) crits++; };
      swing();
      if (this.enemy.currentHp < (sp.threshold1 || 2000) && Math.random() < (sp.chance1 || 0.75) && player.isAlive) swing();
      if (this.enemy.currentHp < (sp.threshold2 || 1000) && Math.random() < (sp.chance2 || 0.50) && player.isAlive) swing();
      this.enemy.critBoost -= (sp.critBonus || 0.05);
      return { ability: ability.name, abilityType: ability.type, message: `💗 **${this.enemy.name}** used **${ability.name}**! **${swings}** swing${swings > 1 ? 's' : ''} for **${total}** damage!${crits ? ` *(${crits} CRIT!)*` : ''}`, damage: total };
    }
    // 4) BIGSHOT EXPRESS — first cast; the lock is handled at the top of the enemy turn
    if (ability.special?.type === 'bigshotExpress') {
      return this._scamtonExpressResolve(ability, player);
    }
    // 4) CAROUSEL OF CALAMITY! — first cast; the lock/escalation is handled in _jevilCarouselResolve
    if (ability.special?.type === 'jevilCarousel') {
      return this._jevilCarouselResolve(ability, player);
    }
    // ============================================================
    // === UPDATE 20 ENEMY ABILITY HANDLERS ===
    // ============================================================

    // PESTI SANS BOSS: applyRust
    if (ability.special?.type === 'applyRust') {
      const d = this.calculateDamage(this.enemy, ability, player);
      player.takeDamage(d.totalDamage);
      let extras = '';
      if (Math.random() < (ability.special.chance || 1.0)) {
        const sr = player.addStatus('rust');
        if (sr) extras = ' **Rust applied!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
    }

    // PESTI SANS BOSS: INFECTED GASTER BLASTERS
    if (ability.special?.type === 'infectedGasterBlasters') {
      const emoji = TYPES[ability.type]?.emoji || '';
      if (Math.random() < (ability.special.missChance || 0.5)) {
        return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}** ${emoji}! ... **It missed!**`, damage: 0 };
      }
      const d = this.calculateDamage(this.enemy, ability, player);
      player.takeDamage(d.totalDamage);
      let extras = '';
      if (Math.random() < (ability.special.rustChance || 0.25)) {
        const sr = player.addStatus('rust');
        if (sr) extras = ' **Rust applied!**';
      }
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
    }

    // PESTI SANS BOSS: CONCENTRATED PIPE BLAST
    if (ability.special?.type === 'concentratedPipeBlast') {
      const dmg = ability.damageMin || 200;
      player.takeDamage(dmg);
      player.addStatus('rust');
      const selfDmg = ability.special.selfDamage || 100;
      this.enemy.currentHp = Math.max(0, this.enemy.currentHp - selfDmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}** ${emoji}! **${dmg}** fixed damage! **Rust applied!** ⚠️ ${this.enemy.name} takes **${selfDmg}** recoil damage!`, damage: dmg };
    }

    // HIM: HANDHELD DESTRUCTION (scales with HP loss)
    if (ability.special?.type === 'handheldDestruction') {
      // base 10-10, hits 2-3 times. Each 30% HP lost: +15 dmg, -5 uses.
      // At 50% HP: 20% blindness chance. Below 855 HP threshold: 25 dmg, below 489 HP: 40 dmg
      const hpPct = this.enemy.currentHp / this.enemy.maxHp;
      const lossSteps = Math.floor((1 - hpPct) / 0.3); // 0,1,2,3 stages
      const bonusDmg = lossSteps * 15;
      const hits = Math.floor(Math.random() * 2) + 2; // 2-3
      let total = 0;
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(this.enemy, ability, player);
        total += d.totalDamage + bonusDmg;
      }
      player.takeDamage(total);
      let extras = '';
      if (hpPct <= 0.5 && Math.random() < 0.20) {
        const br = player.addStatus('blindness');
        if (br) extras = ' **Blindness!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}** ${emoji}! **${hits} hits**, **${total}** total damage!${bonusDmg > 0 ? ` (+${bonusDmg}/hit from HP loss)` : ''}${extras}`, damage: total };
    }

    // HIM: THE HANDS — multi-hit + blindness + karma
    if (ability.special?.type === 'theHands') {
      const hits = ability.special.hits || 2;
      let total = 0; let isCrit = false;
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(this.enemy, ability, player);
        total += d.totalDamage; if (d.isCrit) isCrit = true;
      }
      player.takeDamage(total);
      const bl = player.addStatus('blindness');
      const kr = player.addStatus('karma');
      const emoji = TYPES[ability.type]?.emoji || '';
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}** ${emoji}! **${hits} multi-hit**, **${total}** total damage!${isCrit ? ' **CRIT!**' : ''} **Blindness + Karma applied!**`, damage: total };
    }

    // HIM: PLATFORM DISRUPTION — blindness + 40% stun
    if (ability.special?.type === 'platformDisruption') {
      const d = this.calculateDamage(this.enemy, ability, player);
      player.takeDamage(d.totalDamage);
      const bl = player.addStatus('blindness');
      let extras = bl ? ' **Blindness!**' : '';
      if (Math.random() < (ability.special.stunChance || 0.40)) {
        const sr = player.addStatus('stun');
        if (sr) extras += ' **Stunned!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
    }

    // ============================================================
    // === END UPDATE 20 ENEMY ABILITY HANDLERS ===
    // ============================================================

    // --- UPDATE 18: New encounter enemy special types ---
    if (ability.special?.type === 'trueDamage') {
      const dmg = ability.special.amount || ability.damageMin;
      player.currentHp = Math.max(0, player.currentHp - dmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}** ${emoji}! **${dmg}** TRUE damage! (Bypasses all DEF!)`, damage: dmg };
    }
    if (ability.special?.type === 'braveryCounter') {
      this.enemy._braveryCounterActive = true;
      const emoji = TYPES[ability.type]?.emoji || '';
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** takes a counter stance! *(Any attack this turn deals ${ability.special.trueDmg} true dmg back!)*`, damage: 0 };
    }
    if (ability.special?.type === 'fireLazer') {
      const d2 = this.calculateDamage(this.enemy, ability, player); player.takeDamage(d2.totalDamage); let sm2 = '';
      if (Math.random() < 0.5) { const sr = player.addStatus('stun'); if (sr) sm2 = ' **Blue Soul — Stunned!**'; }
      else { const sr = player.addStatus('burn'); if (sr) sm2 = ' **Orange fire — Burned!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}** ${emoji}! **${d2.totalDamage}** damage!${d2.isCrit ? ' **CRIT!**' : ''}${sm2}`, damage: d2.totalDamage };
    }
    const d = this.calculateDamage(this.enemy, ability, player);
    // Glitched Blasters reflect
    if (this.enemy._reflectNext) {
      this.enemy._reflectNext = false;
      this.enemy.takeDamage(d.totalDamage);
      return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}**... but the **Glitched Blasters** backfired! **${d.totalDamage}** self-damage!`, damage: 0 };
    }
    // Weakened next (String Slam)
    let weakenMult = 1;
    if (this.enemy._weakenedNext) { this.enemy._weakenedNext = false; weakenMult = 0.75; }
    // --- UPDATE 13 ---
    // Tommy Gun Burst weaken (10% off enemy's next damaging move)
    if (this.enemy._tommyGunWeaken) { weakenMult *= (1 - this.enemy._tommyGunWeaken); }
    // Hardmode Bone Sweep damage reduce (-5 flat)
    let hardmodeReduce = 0;
    if (this.enemy._enemyDamageReduce) { hardmodeReduce = this.enemy._enemyDamageReduce; }
    let finalDmg = Math.max(0, Math.floor(d.totalDamage * weakenMult) - hardmodeReduce);
    // --- UPDATE 31: GRAB (!REBAR!) — the grabbed enemy deals 20% less damage ---
    if (this.enemy._grabDmgReduction > 0) finalDmg = Math.floor(finalDmg * (1 - this.enemy._grabDmgReduction));
    // --- UPDATE 15: Voided status — 25% chance to absorb 50% of enemy attack + Core Frisk +1 ATK
    if (this.enemy.statusEffects && this.enemy.statusEffects.find(s => s.name === 'Voided') && Math.random() < 0.25) {
      finalDmg = Math.floor(finalDmg * 0.5);
      // Find Core Frisk in team and grant +1 ATK
      const coreFrisk = this.playerTeam.find(f => f.id === 'core_frisk' && f.isAlive);
      if (coreFrisk) {
        coreFrisk.atkMod += 1;
        this._voidedAbsorbProc = true;
      }
    }
    // Glitchy Save: if Flowey was attacked on a save turn, his DEF was 0 (handled via passive flag — note: this is for incoming damage so already past us; just track for save logic)
    if (this.enemy.passive?.type === 'glitchySave') this.enemy._wasAttackedThisTurn = true;
    // Mark enemy used damaging move (for CotV Bone Surge bonus next turn)
    if (ability.damageMax > 0) this.enemy._lastUsedDamaging = true;
    // Bone Shifter trap (Hotlands Dust) — enemy used Melee/Unique → +10 dmg to enemy
    if (this.enemy._boneShifterTrap && (ability.type === 'Melee' || ability.type === 'Unique')) {
      const trip = this.enemy._boneShifterTrap;
      this.enemy.takeDamage(trip);
      this.enemy._boneShifterTrap = 0;
    }
    // Contract Recoil (Mafiatale): enemy takes 15% recoil when attacking
    if (this.enemy._contractRecoilTurns > 0 && ability.damageMax > 0) {
      const recoil = Math.floor(finalDmg * (this.enemy._contractRecoilPercent || 0.15));
      this.enemy.takeDamage(recoil);
    }
    // Bone Wall counter (set by Shattered BoneWall) — enemy takes bonus damage when attacking
    let boneWallCounter = 0;
    if (this.enemy._boneWallCounter && ability.damageMax > 0) {
      boneWallCounter = this.enemy._boneWallCounter; this.enemy._boneWallCounter = 0;
      this.enemy.takeDamage(boneWallCounter);
    }
    // Bone Shards recoil — enemy using Melee/Weapon takes recoil
    let boneShardsRecoil = 0;
    if (this.enemy._boneShardsTurns > 0 && (ability.type === 'Melee' || ability.type === 'Weapon')) {
      boneShardsRecoil = this.enemy._boneShardsRecoil || 0;
      this.enemy.takeDamage(boneShardsRecoil);
    }
    // Magic recoil (Avenge Sword Beam) — enemy using Magic takes recoil
    let magicRecoil = 0;
    if (this.enemy._magicRecoilNext && ability.type === 'Magic') {
      magicRecoil = this.enemy._magicRecoilNext; this.enemy._magicRecoilNext = 0;
      this.enemy.takeDamage(magicRecoil);
    }
    // Tag incoming attack type for Omniversal Prodigy parry check
    player._incomingAttackType = ability.type;
    let sm = ''; // status message — declared early so boneHell/gbCircle/gravityManip handlers can append to it
    // --- Bone Hell (Bad Time Sans) — override damage calculation
    if (ability.special?.type === 'boneHell') {
      const hits = Math.floor(Math.random() * ((ability.special.maxHits || 30) - (ability.special.minHits || 10) + 1)) + (ability.special.minHits || 10);
      const dmgPerHit = player._lastUsedDefensive ? 2 : 1;
      finalDmg = hits * dmgPerHit;
      sm += ` 🦴 **Bone Hell!** ${hits} hits${dmgPerHit === 2 ? ' (DOUBLED!)' : ''}!`;
    }
    // --- Bad Time Sans — Gaster Blaster Circle disable ---
    if (ability.special?.type === 'gbCircleBT' && Math.random() < (ability.special.dodgeBlockDisableChance || 0.4)) {
      player._dodgeBlockDisabled = 1;
      sm += ' **Dodge/Block disabled next turn!**';
    }
    // --- Bad Time Sans — Gravity Manipulation ---
    if (ability.special?.type === 'gravityManipBT') {
      if (Math.random() < (ability.special.atkDebuffChance || 0.75)) {
        player.atkMod = (player.atkMod || 0) - (ability.special.atkAmount || 3);
        player._gravityATKRevert = (player._gravityATKRevert || 0) + (ability.special.atkAmount || 3);
        player._gravityATKTurns = ability.special.atkTurns || 2;
        sm += ` **-${ability.special.atkAmount || 3} ATK for ${ability.special.atkTurns || 2} turns!**`;
      }
      if (Math.random() < (ability.special.stunChance || 0.5)) {
        const sr = player.addStatus('stun'); if (sr) sm += ' **Stunned!**';
      }
    }
    // --- Bad Time Sans — Final Stand (instant kill below 20% HP) ---
    if (ability.special?.type === 'finalStandBT' && player.currentHp / player.maxHp < (ability.special.hpThreshold || 0.2)) {
      player.currentHp = 0;
      this.enemy._badTimeFinalDodges = 2;
      sm += ' ☠️ **FINAL STAND — instant KO!**';
    }
    const result = player.takeDamage(finalDmg);
    player._incomingAttackType = null;
    // --- UPDATE 15: track enemy last damage dealt (for reflection moves)
    if (finalDmg > 0) this.enemy._lastDamageDealt = finalDmg;
    // YOUR FAULT passive — full reflection
    if (result.yourFaultParry) {
      finalDmg = 0;
      this.enemy.takeDamage(result.reflect || 0);
    }
    // Kindness Guardian — block + counter
    if (result.kindnessBlock) {
      finalDmg = 0;
      this.enemy.takeDamage(result.counter || 12);
    }
    // Omnipresence dodge
    if (result.omnipresenceDodge) {
      finalDmg = 0;
    }
    // Determination revive
    if (result.determinationRevive) {
      // already set HP=1 in passive
    }
    // Omniversal Prodigy parry triggered → 0 damage, counter 30%, chance to stun
    let omniProdigyCounter = 0, omniProdigyStunned = false;
    if (result.omniProdigyParry) {
      finalDmg = 0;
      omniProdigyCounter = result.reflect || 0;
      if (omniProdigyCounter > 0) this.enemy.takeDamage(omniProdigyCounter);
      if (result.omniProdigyStun) { const sr = this.enemy.addStatus('stun'); omniProdigyStunned = !!sr; }
    }
    // Oceantale Papyrus — Aquatic Reflexes block / swordfish counter
    let aquaticMsg = '';
    if (result.aquaticBlock) {
      finalDmg = 0;
      aquaticMsg = ` 🛡️ **Aquatic Reflexes** — ${player.name} blocks with his cutlass! (+1 DEF)`;
    }
    if (result.aquaticCounter) {
      finalDmg = 0;
      this.enemy.takeDamage(result.reflect || 0);
      aquaticMsg = ` 🐟 **Swordfish Counter!** ${player.name} reflects **${result.reflect || 0}** damage and gains +2 ATK!`;
    }
    // --- UPDATE 31: Steel Bones block ---
    if (result.steelBonesBlock) {
      finalDmg = 0;
      aquaticMsg += ` 🔩 **Steel Bones** — ${player.name} blocks it clean!`;
    }
    // --- UPDATE 31: Unnamed Kindness "Block" move — 80% absorbed, optional reflect + stun ---
    if (result.kindnessMoveBlock) {
      player._kindnessReflectPending = null; // consumed here in PvE
      finalDmg = result.damage || 0;
      aquaticMsg += ` 🛡️ **Block!** ${player.name} absorbs **${result.kindnessMoveBlock}** damage!`;
      if (result.kindnessReflect > 0) {
        this.enemy.takeDamage(result.kindnessReflect);
        aquaticMsg += ` Reflected **${result.kindnessReflect}** back!`;
        if (result.kindnessStun && this.enemy.addStatus('stun')) aquaticMsg += ` 💫 **Stunned!**`;
      }
    }
    // --- UPDATE 31: Papyrus/? Blue Bones trap — enemy attacked, so they get Goop ---
    if (this.enemy._papQBlueBoneTrap > 0 && ability.damageMax > 0) {
      const _st = player._applyGoop(this.enemy, this.enemy._papQBlueBoneTrap, this.enemy._papQBlueBoneSource);
      this.enemy._papQBlueBoneTrap = 0;
      aquaticMsg += ` 🫠 **Blue Bones** trigger — **Goop** applied! (**${_st}** stacks)`;
    }
    if (result.divineShield) { finalDmg = 0; aquaticMsg += ` 🩸 **Divine Hatred shield** absorbs the hit!`; }
    if (result.divineHatred) { aquaticMsg += ` 🩸 **Divine Hatred!** ${player.name} survives at 1 HP!`; }
    // Omni Deflect counter (Weak Avenge Sans)
    let omniDeflectMsg = '';
    if (player._omniDeflectActive && ability.type === 'Melee' && ability.damageMax > 0) {
      const counter = (player._omniDeflectBase || 0) + finalDmg;
      // Reverse the damage taken (parry)
      player.currentHp = Math.min(player.maxHp, player.currentHp + finalDmg);
      finalDmg = 0;
      this.enemy.takeDamage(counter);
      player._omniDeflectTriggered = true;
      omniDeflectMsg = ` ⚔️ **Omni Deflect!** Parried! Counter-strike for **${counter}** damage!`;
    }
    if (ability.special?.type === 'poison' && Math.random() < ability.special.chance) { const sr = player.addStatus('poison'); if (sr) sm = ` **Poisoned!**`; }
    if (ability.special?.type === 'burn') { const burnKey = ability.special.duration >= 3 ? 'burn3' : 'burn'; const sr = player.addStatus(burnKey); if (sr) sm = ` **Burn** applied!`; }
    // Hadouken passive (Toriel boss): first 3 attacks apply burn
    if (this.enemy.passive?.type === 'hadouken' && this.enemy.passive.attacksLeft > 0 && ability.damageMax > 0) {
      this.enemy.passive.attacksLeft--;
      player.addStatus('burn');
      sm += ' **Burn** (Hadouken!)';
    }
    let te = ''; if (d.typeMult > 1.5) te = ' **Super effective!**'; else if (d.typeMult < 0.75) te = ' *Not very effective...*';
    let ls = ''; if (result.lastStand) ls = `\n**Last Stand!** ${player.name} survives at 1 HP!`;
    let blockedMsg = ''; if (result.blocked) { blockedMsg = ` *(${player.name} **blocked** the hit!)*`; }
    let prodigyMsg = ''; if (result.omniProdigyParry) prodigyMsg = ` ⚔️ **Omniversal Prodigy** parried the attack!${omniProdigyCounter > 0 ? ` Countered for **${omniProdigyCounter}**!` : ''}${omniProdigyStunned ? ' **Stunned!**' : ''}`;
    let counterRecoilMsg = '';
    if (boneWallCounter > 0) counterRecoilMsg += ` 🦴 **Bone Wall** counter — **${boneWallCounter}** recoil!`;
    if (boneShardsRecoil > 0) counterRecoilMsg += ` 🦴 **Bone Shards** recoil — **${boneShardsRecoil}** damage!`;
    if (magicRecoil > 0) counterRecoilMsg += ` ✨ **Magic recoil** — **${magicRecoil}** damage!`;
    // RK Shield — stun enemy if they attacked while shield was active
    let rkShieldMsg = '';
    if (player._rkShieldActive && finalDmg > 0) {
      this.enemy.addStatus('stun');
      rkShieldMsg = ` 🛡️ **RK Shield** triggered! **${this.enemy.name}** is **Stunned**!`;
    }
    // --- UPDATE 17: Rainfall Bones karma — if Sans cast Rainfall Bones last turn and is hit this turn, apply Karma to attacker
    let rainfallKarmaMsg = '';
    if (player._rainfallBonesArmed && finalDmg > 0) {
      const sr = this.enemy.addStatus('karma');
      if (sr) {
        const k = this.enemy.statusEffects.find(s => s.name === 'Karma');
        if (k) k.turnsLeft = 1;
        rainfallKarmaMsg = ` 🌧️ **Rainfall Bones** triggers — attacker inflicted with **Karma** for 1 turn!`;
      }
      player._rainfallBonesArmed = false;
      player._rainfallBonesArmedTurn = undefined;
    }
    // --- UPDATE 17: Tentacle Shield absorption message
    let tentacleShieldMsg = '';
    if (result.tentacleShieldAbsorbed) {
      tentacleShieldMsg = ` 🛡️ **Tentacle Shield** absorbed **${result.tentacleShieldAbsorbed}** damage! (${player._tentacleShieldHp} Shield HP left)`;
      finalDmg = 0;
    }
    // --- UPDATE 17: Dusty Determination dodge
    let dustyDodgeMsg = '';
    if (result.dustyDodge) {
      dustyDodgeMsg = ` 🌀 **Dusty Determination** dodged the attack! (${player._dustyDetDodges} dodges left)`;
      finalDmg = 0;
    }
    // --- UPDATE 17: PERRY reflect
    let perryMsg = '';
    if (result.perryReflect) {
      this.enemy.takeDamage(result.perryReflect);
      perryMsg = ` ⚔️ **PERRY!** Reflected **${result.perryReflect}** damage back!${player.skipNextTurn ? ' Recovery needed next turn!' : ''}`;
      finalDmg = 0;
    }
    // --- UPDATE 17: Positive second life
    let positiveLifeMsg = '';
    if (result.positiveSecondLife) {
      positiveLifeMsg = `\n🌟 **POSITIVE!** ${player.name} enters second life! HP: ${player.maxHp}, ATK/DEF reduced!`;
    }
    // --- UPDATE 17: Influenced Determination revive
    let infDetReviveMsg = '';
    if (result.influencedDetermination) {
      infDetReviveMsg = `\n❤️ **Determination!** ${player.name} survives at 1 HP!`;
    }
    const weakMsg = weakenMult < 1 ? ' *(Weakened!)*' : '';
    const emoji = TYPES[ability.type]?.emoji || '';
    return { ability: ability.name, abilityType: ability.type, message: `**${this.enemy.name}** used **${ability.name}** ${emoji}! **${finalDmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${te}${sm}${ls}${blockedMsg}${prodigyMsg}${omniDeflectMsg}${aquaticMsg}${counterRecoilMsg}${weakMsg}${rkShieldMsg}${rainfallKarmaMsg}${tentacleShieldMsg}${dustyDodgeMsg}${perryMsg}${positiveLifeMsg}${infDetReviveMsg}`, damage: finalDmg };
  }

  processEndOfTurn(f) { if (!f.isAlive) return []; return f.processStatusEffects(); }

  // INSANITY threshold checks (Final Insanity passive - Losing His Mind)
  _checkInsanityThresholds(R) {
    const stacks = this.enemy._insanityStacks || 0;
    // Reset above 11
    if (stacks > 11) { this.enemy._insanityStacks = 0; if (!R.insanityResetProc) R.insanityResetProc = `🧠 [INSANITY] stacks reset! (exceeded 11)`; return; }
    // Recompute per-3 -2 ATK/-2 DEF debuff
    const targetDebuff = Math.floor(stacks / 3) * 2;
    const currentDebuff = this.enemy._insanityDebuffApplied || 0;
    if (targetDebuff > currentDebuff) {
      const diff = targetDebuff - currentDebuff;
      this.enemy.atkMod -= diff; this.enemy.defMod -= diff;
      this.enemy._insanityDebuffApplied = targetDebuff;
    }
    // 6 stacks: 30% move fail flag
    if (stacks >= 6) this.enemy._insanityMoveFail = 0.30;
    // 10 stacks: stun next turn
    if (stacks >= 10 && !this.enemy._insanityStunQueued) {
      this.enemy._insanityStunQueued = true;
      this.enemy.addStatus('stun');
      if (!R.insanityProc) R.insanityProc = `🧠 [INSANITY] reached 10 stacks! Enemy **STUNNED**!`;
    }
  }

  tickTempDebuffs(fighter) {
    if (!fighter._tempDebuffs) return;
    fighter._tempDebuffs = fighter._tempDebuffs.filter(td => {
      if (td.turnsLeft <= 1) {
        // Reverse the debuff on expiry
        if (td.stat === 'atk') fighter.atkMod -= td.amount;
        if (td.stat === 'def') fighter.defMod -= td.amount;
        return false;
      }
      td.turnsLeft--;
      return true;
    });
  }
  applyEnemyPassives() {
    if (this.enemy.isAlive && this.enemy.passive?.type === 'regenHP') this.enemy.heal(this.enemy.passive.amount);
    if (this.enemy.isAlive && this.enemy.passive?.type === 'atkBoost') this.enemy.atkMod += this.enemy.passive.amount;
    // Forced Smile — immune to damage for first N turns
    if (this.enemy.isAlive && this.enemy.passive?.type === 'forcedSmile') {
      if (!this.enemy._forcedSmileTurns) this.enemy._forcedSmileTurns = this.enemy.passive.immuneTurns;
      // immunity is handled in takeDamage check below via _forcedSmileImmune flag
    }
    // Echo Protection — below 50% HP: +2 DEF, disable Flower Echo
    if (this.enemy.isAlive && this.enemy.passive?.type === 'echoProtection') {
      const below50 = this.enemy.currentHp / this.enemy.maxHp < 0.5;
      if (below50 && !this.enemy._echoProtActive) {
        this.enemy._echoProtActive = true;
        this.enemy.defMod += 2;
      } else if (!below50 && this.enemy._echoProtActive) {
        this.enemy._echoProtActive = false;
        this.enemy.defMod -= 2;
      }
    }
  }
  checkBattleEnd() {
    if (!this.enemy.isAlive) {
      this.isOver = true; this.winner = 'player';
      // Manic Fixation (Dustrust Sans) — +2 ATK per kill
      for (const f of this.playerTeam) {
        if (f.isAlive && f.passive?.type === 'manicFixation') {
          f.passiveAtkAccumulated += f.passive.atkPerKill;
        }
        // Parasitic Desires (True Fresh) — +50 HP regen, +1 DEF per kill
        if (f.isAlive && f.passive?.type === 'parasiticDesires') {
          f.heal(50); f.defMod += 1;
        }
      }
      return { winner: 'player', message: `**${this.enemy.name}** has been defeated!` };
    }
    if (this.alivePlayerCount === 0) { this.isOver = true; this.winner = 'enemy'; return { winner: 'enemy', message: 'All your characters have been defeated...' }; }
    if (!this.activePlayer.isAlive) {
      const n = this.playerTeam.findIndex((f, i) => f.isAlive && i !== this.activePlayerIndex);
      if (n !== -1) { this.activePlayerIndex = n; return { winner: null, autoSwitch: true, message: `**${this.playerTeam[this.activePlayerIndex].name}** steps in!` }; }
    }
    return null;
  }
  generateRewards(enemyData) {
    // --- UPDATE 22: Sacrifices must be made.. — no drops at all ---
    if (this._noChanceDrops) return [];
    const rewards = [], rt = enemyData.rewards;
    if (rt.dtVial && Math.random() < rt.dtVial.chance) { const mn = rt.dtVial.min||1, mx = rt.dtVial.max||1; rewards.push({ item: 'dt_vial', amount: Math.floor(Math.random()*(mx-mn+1))+mn, name: 'DT Vial', emoji: '🧪' }); }
    if (rt.soulEssence && Math.random() < rt.soulEssence.chance) { rewards.push({ item: 'soul_essence', amount: Math.floor(Math.random()*(rt.soulEssence.max-rt.soulEssence.min+1))+rt.soulEssence.min, name: 'Soul Essence', emoji: '💜' }); }
    if (rt.starPiece && Math.random() < rt.starPiece.chance) { const mn = rt.starPiece.min||1, mx = rt.starPiece.max||1; rewards.push({ item: 'star_piece', amount: Math.floor(Math.random()*(mx-mn+1))+mn, name: 'Star Piece', emoji: '🌟' }); }
    if (rt.agoresTrident && Math.random() < rt.agoresTrident.chance) rewards.push({ item: 'asgores_trident', amount: 1, name: "Asgore's Trident", emoji: '🔱' });
    if (rt.crownOfTheKing && Math.random() < rt.crownOfTheKing.chance) rewards.push({ item: 'crown_of_the_king', amount: 1, name: 'Crown of the King', emoji: '👑' });
    if (rt.timeOrb && Math.random() < rt.timeOrb.chance) rewards.push({ item: 'time_orb', amount: 1, name: 'Time Orb', emoji: '🔵' });
    if (rt.tier3MonsterSoul && Math.random() < rt.tier3MonsterSoul.chance) { const mn = rt.tier3MonsterSoul.min||1, mx = rt.tier3MonsterSoul.max||1; rewards.push({ item: 'tier3_monster_soul', amount: Math.floor(Math.random()*(mx-mn+1))+mn, name: 'Tier 3 Monster Soul', emoji: '💎' }); }
    // --- UPDATE 15: DT Soul + Thorns ---
    if (rt.dtSoul && Math.random() < rt.dtSoul.chance) { const mn = rt.dtSoul.min||1, mx = rt.dtSoul.max||1; rewards.push({ item: 'dt_soul', amount: Math.floor(Math.random()*(mx-mn+1))+mn, name: 'DT Soul', emoji: '💗' }); }
    if (rt.thorns && Math.random() < rt.thorns.chance) { const mn = rt.thorns.min||1, mx = rt.thorns.max||1; rewards.push({ item: 'thorns', amount: Math.floor(Math.random()*(mx-mn+1))+mn, name: 'Thorns', emoji: '🌹' }); }
    if (rt.vhsTape && Math.random() < rt.vhsTape.chance) rewards.push({ item: 'vhs_tape', amount: 1, name: 'VHS Tape', emoji: '📼' });
    if (rt.stolenSlash && Math.random() < rt.stolenSlash.chance) rewards.push({ item: 'stolen_slash', amount: 1, name: 'Stolen Slash', emoji: '🗡️' });
    if (rt.administratorPermissions && Math.random() < rt.administratorPermissions.chance) rewards.push({ item: 'administrator_permissions', amount: 1, name: 'Administrator Permissions', emoji: '🔑' });
    if (rt.sirius && Math.random() < rt.sirius.chance) rewards.push({ item: 'sirius', amount: 1, name: 'Sirius', emoji: '⭐' });
    if (rt.star_shard && Math.random() < rt.star_shard.chance) rewards.push({ item: 'star_shard', amount: 1, name: 'Star Shard', emoji: '🌟' });
    if (rt.phoenix_a && Math.random() < rt.phoenix_a.chance) rewards.push({ item: 'phoenix_a', amount: 1, name: 'Phoenix A', emoji: '🔥' });
    if (rt.stardust_item && Math.random() < rt.stardust_item.chance) rewards.push({ item: 'stardust_item', amount: 1, name: 'Stardust', emoji: '✨' });
    if (rt.supernova && Math.random() < rt.supernova.chance) rewards.push({ item: 'supernova', amount: 1, name: 'Supernova', emoji: '💥' });
    if (rt.umbrella && Math.random() < rt.umbrella.chance) rewards.push({ item: 'umbrella', amount: 1, name: 'Umbrella', emoji: '☂️' });
    if (rt.sans_magic_eye && Math.random() < rt.sans_magic_eye.chance) rewards.push({ item: 'sans_magic_eye', amount: 1, name: "Sans' Magic Eye", emoji: '👁️' });
    if (rt.ketchup_bottle && Math.random() < rt.ketchup_bottle.chance) rewards.push({ item: 'ketchup_bottle', amount: 1, name: 'Ketchup Bottle', emoji: '🍅' });
    if (rt.ketchup_gun && Math.random() < rt.ketchup_gun.chance) rewards.push({ item: 'ketchup_gun', amount: 1, name: 'Ketchup Gun', emoji: '🔫' });
    // --- UPDATE 19: Generic extraDrops processing (fixes human soul enemy drops) ---
    if (rt.extraDrops && Array.isArray(rt.extraDrops)) {
      for (const drop of rt.extraDrops) {
        if (Math.random() < (drop.chance || 0)) {
          rewards.push({ item: drop.item, amount: 1, name: drop.name, emoji: drop.emoji });
        }
      }
    }
    // --- UPDATE 19: Roaring Knight boss drops ---
    if (rt.blackShard && Math.random() < (rt.blackShard.chance || 1.0)) rewards.push({ item: 'black_shard', amount: rt.blackShard.amount || 1, name: 'Black Shard', emoji: '🖤' });
    if (rt.shadowCrystal && Math.random() < (rt.shadowCrystal.chance || 0.10)) rewards.push({ item: 'shadow_crystal', amount: 1, name: 'Shadow Crystal', emoji: '🔮' });
    // --- UPDATE 20: Pesti Sans boss + HIM superboss drops ---
    if (rt.rusted_metal_pipe && Math.random() < rt.rusted_metal_pipe.chance) rewards.push({ item: 'rusted_metal_pipe', amount: rt.rusted_metal_pipe.amount || 1, name: 'Rusted Metal Pipe', emoji: '🪈' });
    if (rt.gasters_hands && Math.random() < rt.gasters_hands.chance) { const mn = rt.gasters_hands.min||1, mx = rt.gasters_hands.max||1; rewards.push({ item: 'gasters_hands', amount: Math.floor(Math.random()*(mx-mn+1))+mn, name: "Gaster's Hands", emoji: '🖐️' }); }
    if (rt.his_guidance && Math.random() < rt.his_guidance.chance) { const mn = rt.his_guidance.min||1, mx = rt.his_guidance.max||1; rewards.push({ item: 'his_guidance', amount: Math.floor(Math.random()*(mx-mn+1))+mn, name: 'His Guidance', emoji: '👁️' }); }
    if (rt.cosmic_dust && Math.random() < rt.cosmic_dust.chance) { const mn = rt.cosmic_dust.min||1, mx = rt.cosmic_dust.max||1; rewards.push({ item: 'cosmic_dust', amount: Math.floor(Math.random()*(mx-mn+1))+mn, name: 'Cosmic Dust', emoji: '✨' }); }
    if (rt.dt_injector && Math.random() < rt.dt_injector.chance) { const mn = rt.dt_injector.min||1, mx = rt.dt_injector.max||1; rewards.push({ item: 'dt_injector', amount: Math.floor(Math.random()*(mx-mn+1))+mn, name: 'DT Injector', emoji: '💉' }); }
    if (rt.void_catalyst && Math.random() < rt.void_catalyst.chance) rewards.push({ item: 'void_catalyst', amount: rt.void_catalyst.amount || 1, name: 'Void Catalyst', emoji: '🕳️' });
    return rewards;
  }
  getBattleState() {
    const p = this.activePlayer;
    return {
      player: { id: p.id, name: p.name + (p.shiny ? ' ✦' : ''), type: p.type, level: p.level || 1, hp: p.currentHp, maxHp: p.maxHp, atk: p.atk, def: p.def, pp: (p.hasPP && p.hasPP()) ? (p._pp || 0) : null, maxPP: (p.hasPP && p.hasPP()) ? p.maxPP : null, statusEffects: p.statusEffects.map(s => `${s.emoji} ${s.name} (${s.turnsLeft})`), isCharging: p.isCharging, abilities: p.abilities.map((a, i) => ({ index: i, name: a.name, type: a.type, typeEmoji: TYPES[a.type]?.emoji || '', uses: a.currentUses, maxUses: a.maxUses, cooldownLeft: a.cooldownLeft || 0, ppCost: a.special?.ppCost || 0, needsPartyTarget: (a.special?.type === 'motivateUp' || a.special?.type === 'immunityShield') })) },
      enemy: { name: this.enemy.name, type: this.enemy.type, hp: this.enemy.currentHp, maxHp: this.enemy.maxHp, atk: this.enemy.atk, def: this.enemy.def, statusEffects: this.enemy.statusEffects.map(s => `${s.emoji} ${s.name} (${s.turnsLeft})`) },
      teamAlive: this.alivePlayerCount, teamTotal: this.playerTeam.length, turnNumber: this.turnNumber,
      isBoss: this.isBoss || false, teamAbilityCooldown: this.teamAbilityCooldown || 0,
      // --- SCAMTON EVENT: active minigames replace the normal battle UI ---
      neo: this._neoMinigame ? { round: this._neoMinigame.round, count: this._neoMinigame.count, timer: this._neoMinigame.timer, layout: this._neoMinigame.layout.slice(), progress: this._neoMinigame.progress } : null,
      cards: this._pendingCards ? { suits: this._pendingCards.suits.slice(), timerSeconds: this._pendingCards.timerSeconds } : null,
      playerTeamBars: this.playerTeam.map(f => `${f.isAlive ? '' : '💀 '}**${f.name}** — ${f.currentHp}/${f.maxHp} HP`).join('\n'),
    };
  }
}
module.exports = { Battle, Fighter, applyTeamSynergy };