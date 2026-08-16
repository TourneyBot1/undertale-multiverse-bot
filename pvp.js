const { TYPES, getTypeMultiplier, STATUS_EFFECTS, COMBAT, hasPassiveUnlocked, CHARACTERS, BOSSES } = require('./gameData');
const { Fighter, applyTeamSynergy } = require('./combat');

class PvPBattle {
  constructor(team1Data, team2Data, player1Id, player2Id) {
    // --- UPDATE 31: resolve and apply each side's single active team synergy ---
    const _syn1 = applyTeamSynergy(team1Data); const _syn2 = applyTeamSynergy(team2Data);
    this.activeSynergy1 = _syn1.synergy || null; this.activeSynergy2 = _syn2.synergy || null;
    team1Data = _syn1.team; team2Data = _syn2.team;
    this.team1 = team1Data.map(c => new Fighter(c, false));
    this.team2 = team2Data.map(c => new Fighter(c, false));
    this.active1 = 0;
    this.active2 = 0;
    this.player1Id = player1Id;
    this.player2Id = player2Id;
    this.turnNumber = 0;
    this.currentTurn = player1Id; // whose turn it is
    this.isOver = false;
    this.winner = null;
    this.lastLog = [];
    // --- UPDATE 30: Underfell/Outertale team overload (3+ of a family) ---
    for (const team of [this.team1, this.team2]) {
      const ufCount = team.filter(f => f.id === 'underfell_sans').length;
      const otCount = team.filter(f => f.id === 'outertale_sans').length;
      if (ufCount >= 3) for (const f of team) { if (f.id === 'underfell_sans') { f.defMod -= 1; f._familyCdOverride = 3; } }
      if (otCount >= 3) for (const f of team) { if (f.id === 'outertale_sans') { f.defMod -= 2; f._familyCdOverride = 3; } }
    }
  }

  get p1() { return this.team1[this.active1]; }
  get p2() { return this.team2[this.active2]; }
  get alive1() { return this.team1.filter(f => f.isAlive).length; }
  get alive2() { return this.team2.filter(f => f.isAlive).length; }

  getAttacker() { return this.currentTurn === this.player1Id ? this.p1 : this.p2; }
  // --- SCAMTON EVENT: the acting fighter's own team (Heal Hail / Motivate Up / Immunity Shield) ---
  getAttackerTeam() { return this.currentTurn === this.player1Id ? this.team1 : this.team2; }
  getDefender() { return this.currentTurn === this.player1Id ? this.p2 : this.p1; }

  // ===== BATCH 2 FIX: per-turn passives that only existed in the PvE engine =====
  // Ticks the acting fighter's end-of-turn passive. Called from postTurn.
  applyPvPTurnPassives(attacker, defender, log) {
    if (!attacker || !attacker.passive || !attacker.isAlive) return;
    if (!hasPassiveUnlocked(attacker.level)) return;
    const p = attacker.passive;
    // ===================== UPDATE 31 PVP PASSIVE TICKS =====================
    // Karmic Debt (Karma!Sans)
    if (p.type === 'karmicDebt') {
      if (attacker._karmicDefTurns > 0) {
        attacker._karmicDefTurns--;
        if (attacker._karmicDefTurns <= 0) {
          attacker.defMod -= (p.defBoost || 4);
          const _kr = defender.statusEffects.find(s => s.name === 'Scary KR');
          if (_kr) _kr.damageOnAttack = 10;
        }
      }
      attacker._karmicTurn = (attacker._karmicTurn || 0) + 1;
      if (attacker._karmicTurn % (p.interval || 3) === 0) {
        attacker.defMod += (p.defBoost || 4);
        attacker._karmicDefTurns = 1;
        const _kr = defender.statusEffects.find(s => s.name === 'Scary KR');
        if (_kr) _kr.damageOnAttack = (p.krDamage || 20);
        log.push(`☯️ **Karmic Debt** — Scary KR deals **double** damage this turn! **${attacker.name} +4 DEF!**`);
      }
    }
    // Papyrus/? — takes 16 damage a turn
    if (p.type === 'itHurtsPap' && attacker.isAlive) {
      attacker.currentHp = Math.max(0, attacker.currentHp - (p.selfDamage || 16));
      log.push(`🫠 **h̷ ̶h̷e̶l̷p̸ ̶m̵e̷/̸s̴a̵n̷s̶** — **${attacker.name}** takes **${p.selfDamage || 16}** damage!`);
    }
    // SIXBONES I̷T̸ ̶H̷U̵R̸T̷S̶
    if (p.type === 'itHurts') {
      if (attacker._sixDefRestore > 0) { attacker.defMod += attacker._sixDefRestore; attacker._sixDefRestore = 0; }
      if (Array.isArray(attacker._sixDefStacks) && attacker._sixDefStacks.length) {
        const expired = attacker._sixDefStacks.filter(st => --st.turns <= 0);
        for (const st of expired) attacker.defMod += st.amount;
        attacker._sixDefStacks = attacker._sixDefStacks.filter(st => st.turns > 0);
      }
      if (attacker._sixDefNextTurn > 0) {
        attacker.defMod += attacker._sixDefNextTurn;
        attacker._sixDefRestore = attacker._sixDefNextTurn;
        log.push(`🦴 **I̷T̸ ̶H̷U̵R̸T̷S̶** — **+${attacker._sixDefNextTurn} DEF** from hits taken!`);
        attacker._sixDefNextTurn = 0;
      }
    }
    // Last Breath P3 — 1000 Fold
    if (p.type === 'lastBreathP3' && attacker.isAlive) {
      const healed = attacker.heal(p.healPerTurn || 8);
      if (healed > 0) log.push(`💀 **1000 Fold** — ${attacker.name} healed **${healed} HP**!`);
      if (!attacker._p3Surged && (attacker.currentHp / attacker.maxHp) < (p.threshold || 0.40)) {
        attacker._p3Surged = true;
        attacker.passiveAtkAccumulated += (p.atkBoost || 6);
        log.push(`💀 **1000 Fold** — **+${p.atkBoost || 6} ATK!** He's not holding back anymore.`);
      }
    }
    // Rose (synergy) — C!Insanity's Assist every 2 turns
    if (p.type === 'cInsanityAssist' && defender.isAlive) {
      attacker._assistTurn = (attacker._assistTurn || 0) + 1;
      if (attacker._assistTurn % (p.interval || 2) === 0) {
        const order = ['c_insanity', 'c_insanity_weak'];
        const team = this.team1.includes(attacker) ? this.team1 : this.team2;
        const src = team.find(f => order.includes(f._originalId || f.id));
        if (src) {
          const pool = src.abilities.filter(a => a.damageMax > 0);
          if (pool.length) {
            const pick = pool[Math.floor(Math.random() * pool.length)];
            const d = this.calculateDamage(src, pick, defender);
            defender.takeDamage(d.totalDamage);
            log.push(`🌹 **C!Insanity's Assist** — **${src.name}** cuts in with **${pick.name}** for **${d.totalDamage}** damage!`);
          }
        }
      }
    }
    // Axe Momentum (C!Insanity base passive)
    if (p.type === 'axeMomentum' && attacker._attackedThisTurn) {
      const cap = p.maxStacks || 6;
      if ((attacker._axeMomentum || 0) < cap) {
        attacker._axeMomentum = (attacker._axeMomentum || 0) + 1;
        attacker.passiveAtkAccumulated += 1;
        log.push(`🪓 **Axe Momentum** — **+1 ATK** (${attacker._axeMomentum}/${cap})!`);
      }
      if ((attacker._axeMomentum || 0) >= cap && defender.isAlive) {
        if (attacker._applyStatusFor(defender, 'bleed', p.bleedDuration || 2)) log.push(`🪓 **Axe Momentum** is at full force — **Bleed** applied!`);
      }
    }
    // Fractured Focus (C!Insanity Weak base passive)
    if (p.type === 'fracturedFocus' && attacker._attackedThisTurn) {
      const cap = p.maxStacks || 5;
      if ((attacker._fracturedFocus || 0) < cap && Math.random() < (p.chance || 0.25)) {
        attacker._fracturedFocus = (attacker._fracturedFocus || 0) + 1;
        defender.defMod -= 1;
        log.push(`💠 **Fractured Focus** — ${defender.name} **-1 DEF** (${attacker._fracturedFocus}/${cap})!`);
      }
    }
    // Terminal Delirium (Hardmode Insanity) — queued counter
    if (attacker._delirumCounter > 0 && defender.isAlive) {
      const cd = attacker._delirumCounter; attacker._delirumCounter = 0;
      defender.currentHp = Math.max(0, defender.currentHp - cd);
      log.push(`🦴 **Terminal Delirium** — instant counter for **${cd}** damage!`);
    }
    // Retensive Healing (Unnamed Kindness) — per-side permanent regen
    { const _rkey = this.team1.includes(attacker) ? '_retensiveHeal1' : '_retensiveHeal2';
      if (this[_rkey] > 0 && attacker.isAlive) {
        const rh = attacker.heal(this[_rkey]);
        if (rh > 0) log.push(`✨ **Retensive Healing** restored **${rh} HP** to **${attacker.name}**!`);
      } }
    // GRAB (!REBAR!) — 5 dmg/turn to the grabbed opponent
    if (attacker._grabActive && defender.isAlive) {
      defender.currentHp = Math.max(0, defender.currentHp - (attacker._grabDot || 5));
      log.push(`🔩 The **GRAB** grinds for **${attacker._grabDot || 5}** damage! (**${attacker._grabHitsRemaining}** hits left to break free)`);
    }
    // BLOODTHIRST (!REBAR!) — ends when the opponent dies or switches out
    if (attacker._bloodthirstActive && (!defender.isAlive || attacker._bloodthirstTarget !== defender)) {
      attacker._bloodthirstActive = false;
      attacker.atkMod -= (attacker._bloodthirstAtk || 15);
      attacker.defMod += (attacker._bloodthirstDef || 15);
      const bh = attacker.heal(attacker._bloodthirstEndHeal || 75);
      attacker.passiveAtkAccumulated += (attacker._bloodthirstEndAtk || 3);
      log.push(`🩸 **BLOODTHIRST** ends — healed **${bh} HP** and gained a permanent **+${attacker._bloodthirstEndAtk || 3} ATK**!`);
    }
    // REBAR timed buffs tick down
    if (attacker._rebarBlockDoubleTurns > 0) attacker._rebarBlockDoubleTurns--;
    if (attacker._rebarChargeBlock > 0 && !attacker.isCharging) attacker._rebarChargeBlock = 0;
    if (attacker._rebarStanceTurns > 0) {
      attacker._rebarStanceTurns--;
      if (attacker._rebarStanceTurns <= 0) {
        if (attacker._rebarStanceDef) { attacker.defMod -= attacker._rebarStanceDef; attacker._rebarStanceDef = 0; }
        if (attacker._rebarStanceAtk) { attacker.atkMod += attacker._rebarStanceAtk; attacker._rebarStanceAtk = 0; }
        attacker._rebarStanceBlockDouble = 0; attacker._rebarDoubleHits = 0;
        log.push(`🔩 **${attacker.name}** returns to a neutral stance.`);
      }
    }
    // ===================== END UPDATE 31 PVP PASSIVE TICKS =====================
    // UPDATE 30: Papyrus Belief — below 40% HP grants permanent +4 DEF (once)
    if (p.type === 'shatteredExpectations' && !attacker._beliefDefApplied && (attacker.currentHp / attacker.maxHp) < (p.lowHpThreshold || 0.40)) {
      attacker.defMod += (p.lowHpDefBoost || 4); attacker._beliefDefApplied = true;
      log.push(`Shattered Expectations: +${p.lowHpDefBoost || 4} DEF (below 40% HP)!`);
    }
    // UPDATE 30: Storyspin — consequences passive (+1 ATK/DEF per dead teammate)
    if (p.type === 'storyspinConsequences') {
      const team = this.team1.includes(attacker) ? this.team1 : this.team2;
      const dead = team.filter(f => f !== attacker && !f.isAlive).length;
      const bonus = dead * (p.statPerDead || 1);
      const prev = attacker._storyspinApplied || 0;
      if (bonus !== prev) { const delta = bonus - prev; attacker.atkMod += delta; attacker.defMod += delta; attacker._storyspinApplied = bonus; log.push(`Consequences: +${bonus} ATK/DEF (${dead} fallen)!`); }
    }
    // UPDATE 30: Storyspin Malfunctioning Blaster crit-boost window
    if (attacker._critBoostTurns > 0) { attacker._critBoostTurns--; if (attacker._critBoostTurns <= 0) attacker.critBoost = 0; }
    // UPDATE 30: LowTierFell — THUNDER STRIKE (every N turns: true dmg + stun)
    if (p.type === 'thunderStrike') {
      if (!attacker._thunderTurn) attacker._thunderTurn = 0;
      attacker._thunderTurn++;
      if (attacker._thunderTurn % (p.interval || 5) === 0) {
        defender.currentHp = Math.max(0, defender.currentHp - (p.trueDamage || 30));
        defender.addStatus('stun');
        log.push(`⚡ **THUNDER STRIKE!** ${p.trueDamage || 30} true damage + **Stun**!`);
      }
    }

    // Duality (W.D. Gaster) — alternate +4 ATK / +4 DEF each turn
    if (p.type === 'duality') {
      if (!attacker._dualityState) attacker._dualityState = 'red';
      if (attacker._dualityState === 'red') { attacker.atkMod -= 4; attacker.defMod += 4; attacker._dualityState = 'blue'; log.push(`⚔️ **Duality** — ${attacker.name} shifts to **Blue** (+4 DEF).`); }
      else { attacker.defMod -= 4; attacker.atkMod += 4; attacker._dualityState = 'red'; log.push(`⚔️ **Duality** — ${attacker.name} shifts to **Red** (+4 ATK).`); }
    }

    // Vine Restriction (Possession Sans) — strip enemy DEF each turn
    if (p.type === 'vineRestriction') {
      defender.defMod -= (p.defReduction || 1);
      let vm = `🌿 **Vine Restriction** — ${defender.name} **-${p.defReduction || 1} DEF!**`;
      if (Math.random() < (p.atkChance || 0.2)) { defender.atkMod -= 1; vm += ' **-1 ATK!**'; }
      log.push(vm);
    }

    // FFTBO — stacking damage boost every N turns + chance to heal
    if (p.type === 'fftboPassive') {
      attacker._fftboTurnCounter = (attacker._fftboTurnCounter || 0) + 1;
      if (attacker._fftboTurnCounter % (p.interval || 5) === 0) {
        attacker._fftboDmgBoost = (attacker._fftboDmgBoost || 0) + (p.dmgBoost || 3);
        log.push(`💀 **Finale** — +${p.dmgBoost || 3} damage stack! (Total +${attacker._fftboDmgBoost})`);
      }
      if (Math.random() < (p.healChance || 0.3)) { const h = attacker.heal(p.healAmount || 20); if (h) log.push(`💀 **Finale Heal** — ${attacker.name} heals **${h} HP**!`); }
    }

    // Psychotic Episodes (Psychopathtale) — Psycho Mode every N turns
    if (p.type === 'psychoticEpisodes') {
      attacker._psychoTurnCounter = (attacker._psychoTurnCounter || 0) + 1;
      if (attacker._psychoTurns > 0) {
        attacker._psychoTurns--;
        if (attacker._psychoTurns <= 0 && attacker._psychoMode) { attacker._psychoMode = false; attacker.atkMod -= p.atkSwing; attacker.defMod += p.defSwing; log.push(`🌀 ${attacker.name}'s episode subsides — back to normal.`); }
      } else if (attacker._psychoTurnCounter % p.cycle === 0) {
        attacker._psychoMode = true; attacker._psychoTurns = p.duration; attacker.atkMod += p.atkSwing; attacker.defMod -= p.defSwing;
        log.push(`🌀 **Psychotic Episode!** ${attacker.name} enters Psycho Mode (+${p.atkSwing} ATK / -${p.defSwing} DEF) for ${p.duration} turns!`);
      }
    }

    // Phantom Brother (Snowdin/JHall Dust) — automatic true damage
    if (p.type === 'phantomBrother') {
      let dealt = 0;
      if (p.interval) { attacker._phantomTurn = (attacker._phantomTurn || 0) + 1; if (attacker._phantomTurn % p.interval === 0) dealt = p.damage; }
      else if (p.amount) { dealt = p.amount; }
      if (dealt > 0) { defender.currentHp = Math.max(0, defender.currentHp - dealt); log.push(`👻 **Phantom Brother** strikes! **${dealt}** true damage!`); }
    }

    // ENRAGED/help (Nightmare) — enrage under threshold + periodic ally call
    if (p.type === 'enragedHelp') {
      const threshold = p.hpThreshold || 0.5;
      if (!attacker._enragedActivated && attacker.currentHp / attacker.maxHp < threshold) {
        attacker._enragedActivated = true; attacker.atkMod += (p.atkBoost || 2); attacker.defMod -= (p.defLoss || 2);
        log.push(`🌑 **ENRAGED!** ${attacker.name} — +${p.atkBoost || 2} ATK, -${p.defLoss || 2} DEF!`);
      }
      if (attacker._enragedActivated) {
        attacker._enragedCallCounter = (attacker._enragedCallCounter || 0) + 1;
        if (attacker._enragedCallCounter % (p.callInterval || 4) === 0) {
          const helpers = ['horror_sans', 'killer_sans', 'judgement_hall_dust_sans'];
          const helperChar = CHARACTERS[helpers[Math.floor(Math.random() * helpers.length)]];
          if (helperChar && helperChar.abilities && helperChar.abilities.length) {
            const move = helperChar.abilities[Math.floor(Math.random() * helperChar.abilities.length)];
            if (move.damageMax > 0) {
              const dmg = Math.floor(Math.random() * (move.damageMax - move.damageMin + 1)) + move.damageMin;
              defender.currentHp = Math.max(0, defender.currentHp - dmg);
              log.push(`🌑 **${helperChar.name}** answers the call — **${move.name}** for **${dmg}** damage!`);
            }
          }
        }
      }
    }
    // Fractured Mind (Insanity Sans) — each new 10% HP threshold lost: +2 ATK, +2 DEF
    if (p.type === 'fracturedMind') {
      const threshold = Math.floor((attacker.currentHp / attacker.maxHp) * 10) / 10;
      if (attacker._fracturedThreshold === undefined) attacker._fracturedThreshold = 1.0;
      if (threshold < attacker._fracturedThreshold) {
        attacker._fracturedThreshold = threshold;
        attacker.passiveAtkAccumulated = (attacker.passiveAtkAccumulated || 0) + 2;
        attacker.defMod += 2;
        log.push(`🧠 **Fractured Mind** — ${attacker.name} +2 ATK, +2 DEF!`);
      }
    }

    // Battle Body (Underswap Sans) — at <=50% HP gain +5 DEF for 3 turns
    if (p.type === 'battleBody') {
      if (attacker.currentHp / attacker.maxHp <= 0.5 && !attacker._battleBodyActive) {
        attacker._battleBodyActive = true; attacker._battleBodyTurns = 3; attacker.defMod += 5;
        log.push(`🛡️ **Battle Body** — ${attacker.name} +5 DEF for 3 turns!`);
      }
      if (attacker._battleBodyActive && attacker._battleBodyTurns > 0) {
        attacker._battleBodyTurns--;
        if (attacker._battleBodyTurns <= 0) { attacker._battleBodyActive = false; attacker.defMod -= 5; }
      }
    }

    // Soul Embers (Ruins Dust Sans) — heal while the enemy is burning
    if (p.type === 'soulEmbers' && defender.hasStatus && defender.hasStatus('Burn')) {
      const h = attacker.heal(p.healAmount || 5);
      if (h) log.push(`🔥 **Soul Embers** — ${attacker.name} heals **${h} HP** from the flames!`);
    }

    // Error Passive (Error Sans) — every N turns, random debuff to enemy
    if (p.type === 'errorPassive') {
      attacker._errorTurn = (attacker._errorTurn || 0) + 1;
      if (attacker._errorTurn % (p.interval || 2) === 0) {
        const picked = ['stun', 'blindness', 'poison', 'bleed'][Math.floor(Math.random() * 4)];
        defender.addStatus(picked);
        log.push(`🔀 **Error Passive** — **${picked}** applied to ${defender.name}!`);
      }
    }

    // Sirius (Outerdust) burn rider — set in calculateDamage, applied here
    if (attacker._siriusBurnFlag) { attacker._siriusBurnFlag = false; const sr = defender.addStatus('burn'); if (sr) log.push(`☀️ **Sirius** — ${defender.name} is **Burned**!`); }

    // Love for Humans (Negatale) — +ATK/DEF vs killer-type enemies (applied once per matchup)
    if (p.type === 'loveForHumans' && !attacker._loveApplied) {
      const targets = p.targetIds || ['killer_sans', 'female_killer_sans', 'murder_sans', 'judgement_hall_dust_sans'];
      if (targets.includes(defender.id)) {
        attacker._loveApplied = true; attacker.atkMod += (p.atkBoost || 3); attacker.defMod += (p.defBoost || 3);
        log.push(`❤️ **Love for Humans** — ${attacker.name} +${p.atkBoost || 3} ATK / +${p.defBoost || 3} DEF vs ${defender.name}!`);
      }
    }

    // Fake passive (Fake!HyperDust) — heal every N turns
    if (p.type === 'fakePassive') {
      attacker._fakePassiveCounter = (attacker._fakePassiveCounter || 0) + 1;
      if (attacker._fakePassiveCounter % (p.interval || 2) === 0) { const h = attacker.heal(p.healAmount || 15); if (h) log.push(`💭 **Fake passive** — ${attacker.name} heals **${h} HP**!`); }
    }

    // Dusty Save (AfterDust) — every 5 turns +30 HP and +2 DEF for 2 turns
    if (p.type === 'dustySave') {
      attacker._dustySaveCounter = (attacker._dustySaveCounter || 0) + 1;
      if (attacker._dustySaveCounter % 5 === 0 && (attacker.currentHp / attacker.maxHp) > 0.35) {
        attacker.currentHp = Math.min(attacker.maxHp, attacker.currentHp + 30); attacker.defMod += 2; attacker._dustySaveDefBuffTurns = 2;
        log.push(`💀 **Dusty Save** — ${attacker.name} gains +30 HP and +2 DEF for 2 turns!`);
      }
      if (attacker._dustySaveDefBuffTurns > 0) { attacker._dustySaveDefBuffTurns--; if (attacker._dustySaveDefBuffTurns <= 0) attacker.defMod -= 2; }
    }

    // We All Rust Someday (Pesti Sans) — applies Blindness when they attacked this turn
    if (p.type === 'weAllRustSomeday' && !p.isBossVersion && attacker._attackedThisTurn && defender.isAlive) {
      const br = defender.addStatus('blindness');
      const bl = defender.statusEffects.find(s => s.name === 'Blindness'); if (bl) bl.turnsLeft = p.blindnessDuration || 2;
      if (br) log.push(`🟫 **We all rust someday** — ${defender.name} is **Blinded**!`);
    }

    // Heavy Rain (Tears in the Rain) — every N turns, enemy -accuracy + no crit next turn
    if (p.type === 'heavyRain') {
      attacker._heavyRainCounter = (attacker._heavyRainCounter || 0) + 1;
      if (attacker._heavyRainActive) { defender._missChanceBonus = Math.max(0, (defender._missChanceBonus || 0) - (attacker._heavyRainAccApplied || 0)); attacker._heavyRainAccApplied = 0; defender._noCritThisTurn = false; attacker._heavyRainActive = false; }
      if (attacker._heavyRainCounter % (p.interval || 2) === 0) {
        const accRed = p.accReduction || 0.35;
        defender._missChanceBonus = (defender._missChanceBonus || 0) + accRed; attacker._heavyRainAccApplied = accRed;
        defender._noCritThisTurn = true; attacker._heavyRainActive = true;
        log.push(`🌧️ **Heavy Rain** — ${defender.name}'s accuracy drops and they can't crit!`);
      }
    }

    // Evans' Memories (Dust!Tale: [Evan's]) — every N turns, chance to fire a random boss move
    if (p.type === 'evansMemories') {
      attacker._evansCounter = (attacker._evansCounter || 0) + 1;
      if (attacker._evansCounter % (p.interval || 3) === 0 && Math.random() < (p.chance || 0.15)) {
        const bossIds = Object.keys(BOSSES).filter(b => BOSSES[b].abilities && BOSSES[b].abilities.length > 0 && b !== 'training_dummy');
        if (bossIds.length) {
          const boss = BOSSES[bossIds[Math.floor(Math.random() * bossIds.length)]];
          const move = boss.abilities[Math.floor(Math.random() * boss.abilities.length)];
          if (move.damageMax > 0) {
            const dmg = Math.floor(Math.random() * (move.damageMax - move.damageMin + 1)) + move.damageMin;
            defender.currentHp = Math.max(0, defender.currentHp - dmg);
            log.push(`💭 **MEMORIES!** — ${attacker.name} channels **${boss.name}'s ${move.name}** for **${dmg}** damage!`);
          }
        }
      }
    }
    // Clear "this turn" Souls Help flags at end of the holder's turn
    if (attacker._justiceBoostThisTurn) attacker._justiceBoostThisTurn = false;
    if (attacker._justicePierceChance) attacker._justicePierceChance = 0;
    if (attacker._integrityDodge) attacker._integrityDodge = 0;

    // Hadouken (Toriel) — first N attacks apply Burn
    if (p.type === 'hadouken' && attacker._attackedThisTurn) {
      if (attacker._hadoukenLeft === undefined) attacker._hadoukenLeft = (p.attacksLeft ?? p.attacks ?? 3);
      if (attacker._hadoukenLeft > 0) { attacker._hadoukenLeft--; const sr = defender.addStatus('burn'); if (sr) log.push(`🔥 **Hadouken** — ${defender.name} is **Burned**!`); }
    }

    // Emptiness (Core Frisk) — chance to apply Voided on attack
    if (p.type === 'emptiness' && attacker._attackedThisTurn && Math.random() < (p.chance || 0.15)) {
      const sr = defender.addStatus('voided'); if (sr) log.push(`🟣 **Emptiness** — ${defender.name} is **Voided!**`);
    }

    // Shifted Judgement (Storyshift Chara) — crit stacks each turn the holder isn't hit
    if (p.type === 'shiftedJudgement') {
      if (!attacker._lastDamageTaken || attacker._lastDamageTaken === 0) {
        attacker._shiftedJudgementCrit = Math.min(0.5, (attacker._shiftedJudgementCrit || 0) + 0.1);
        attacker.critBoost = (attacker.critBoost || 0) + 0.1;
        log.push(`⚖️ **Shifted Judgement** — ${attacker.name}'s crit chance rises! (+10%)`);
      } else { attacker._shiftedJudgementCrit = 0; }
      attacker._lastDamageTaken = 0;
    }
  }

  // Souls Help (Seraphim) — a random soul lends power at the start of the turn.
  triggerSoulsHelp(player, defender, log) {
    const souls = ['determination', 'kindness', 'justice', 'bravery', 'integrity', 'patience', 'perseverance'];
    const picked = souls[Math.floor(Math.random() * souls.length)];
    switch (picked) {
      case 'determination': {
        const r = Math.random();
        if (r < 0.143) { const h = player.heal(15); log.push(`✨ **Souls Help (DT):** Kindness echo — healed **${h} HP**.`); }
        else if (r < 0.286) { player._justiceBoostThisTurn = true; log.push(`✨ **Souls Help (DT):** Justice echo — bonus damage this turn.`); }
        else if (r < 0.429) { player._braveryBoostNext = 1.15; log.push(`✨ **Souls Help (DT):** Bravery echo — +15% damage next turn.`); }
        else if (r < 0.572) { player._integrityDodge = 0.10; log.push(`✨ **Souls Help (DT):** Integrity echo — 10% dodge this turn.`); }
        else if (r < 0.715) { defender.addStatus('stun'); log.push(`✨ **Souls Help (DT):** Patience echo — ${defender.name} stunned!`); }
        else { defender._perseveranceDmgReduce = 0.25; log.push(`✨ **Souls Help (DT):** Perseverance echo — enemy's next attack -25%.`); }
        break;
      }
      case 'kindness': { const h = player.heal(30); log.push(`💚 **Souls Help (Kindness):** Healed **${h} HP**.`); break; }
      case 'justice': { player._justiceBoostThisTurn = true; player._justicePierceChance = 0.50; log.push(`💛 **Souls Help (Justice):** Bonus damage + 50% chance to pierce 30% DEF.`); break; }
      case 'bravery': { player._braveryBoostNext = 1.30; log.push(`🧡 **Souls Help (Bravery):** +30% damage next turn.`); break; }
      case 'integrity': { player._integrityDodge = 0.20; log.push(`💙 **Souls Help (Integrity):** 20% dodge this turn.`); break; }
      case 'patience': { defender.addStatus('stun'); log.push(`💙 **Souls Help (Patience):** ${defender.name} stunned for 1 turn!`); break; }
      case 'perseverance': { defender._perseveranceDmgReduce = 0.50; log.push(`💜 **Souls Help (Perseverance):** Enemy's next attack -50%.`); break; }
    }
  }

  switchTurn() {
    this.currentTurn = this.currentTurn === this.player1Id ? this.player2Id : this.player1Id;
  }

  // Turn-timeout skip: the current player forfeits their turn (no action).
  // Their end-of-turn effects (burn/poison/cooldowns/singularity) still tick via
  // postTurn, which also switches the turn to the opponent.
  skipTurn() {
    const log = [];
    const attacker = this.getAttacker();
    const defender = this.getDefender();
    log.push(`⏰ **${attacker.name}**'s turn was skipped — out of time!`);
    attacker._usedAbilityThisTurn = false;
    attacker._attackedThisTurn = false;
    this.postTurn(attacker, defender, log);
    return { success: true, log, battleEnd: this.checkEnd() };
  }

  switchCharacter(playerId, index) {
    if (playerId === this.player1Id) {
      if (index < 0 || index >= this.team1.length) return { success: false, message: 'Invalid slot.' };
      if (index === this.active1) return { success: false, message: 'Already active!' };
      if (!this.team1[index].isAlive) return { success: false, message: 'That character is defeated!' };
      if (this.p1._universalCutTurns > 0) return { success: false, message: '⚔️ **Universal Cut** prevents switching!' };
      if (this.p1._uvTrapTurns > 0) return { success: false, message: '🦴 **Blue Bone Combo** traps you — cannot switch!' };
      // --- UPDATE 15: Face Me Head On (RK!Swap Papyrus / RK!Storyshift Chara) — opponent locks switching ---
      if (this.p2?.passive?.type === 'faceMeHeadOn' && this.p2.isAlive) return { success: false, message: `**Face Me Head On!** ${this.p2.name} won't let you switch!` };
      // Reset INSANITY stacks on opponent if leaving Final Insanity
      if (this.p1.passive?.type === 'losingHisMind') {
        this.p2._insanityStacks = 0; this.p2._insanityDebuffApplied = 0; this.p2._insanityMoveFail = 0; this.p2._insanityStunQueued = false;
      }
      const old = this.p1.name;
      // UPDATE 30: Toxin — Overstocked Shelves on switch-out
      if (this.p1.passive?.type === 'overstockedShelves' && hasPassiveUnlocked(this.p1.level)) { this.p1.heal(this.p1.passive.healOnSwitch || 15); const _lnf = this.p1.abilities.find(a => a.special?.type === 'lostNFound'); if (_lnf) _lnf.currentUses = Math.min(_lnf.maxUses, _lnf.currentUses + (this.p1.passive.lostNFoundRestore || 2)); }
      // --- UPDATE 31: Goop is removed when the Melting one switches out ---
      if (this.p1.passive?.type === 'itHurtsPap' || this.p1.passive?.type === 'itHurts') this.p1._clearGoopFrom(this.p2, this.p1.id);
      this.active1 = index;
      return { success: true, message: `Switched from **${old}** to **${this.p1.name}**!` };
    } else {
      if (index < 0 || index >= this.team2.length) return { success: false, message: 'Invalid slot.' };
      if (index === this.active2) return { success: false, message: 'Already active!' };
      if (!this.team2[index].isAlive) return { success: false, message: 'That character is defeated!' };
      if (this.p2._universalCutTurns > 0) return { success: false, message: '⚔️ **Universal Cut** prevents switching!' };
      if (this.p2._uvTrapTurns > 0) return { success: false, message: '🦴 **Blue Bone Combo** traps you — cannot switch!' };
      // --- UPDATE 15: Face Me Head On ---
      if (this.p1?.passive?.type === 'faceMeHeadOn' && this.p1.isAlive) return { success: false, message: `**Face Me Head On!** ${this.p1.name} won't let you switch!` };
      // Reset INSANITY stacks on opponent if leaving Final Insanity
      if (this.p2.passive?.type === 'losingHisMind') {
        this.p1._insanityStacks = 0; this.p1._insanityDebuffApplied = 0; this.p1._insanityMoveFail = 0; this.p1._insanityStunQueued = false;
      }
      const old = this.p2.name;
      // UPDATE 30: Toxin — Overstocked Shelves on switch-out
      if (this.p2.passive?.type === 'overstockedShelves' && hasPassiveUnlocked(this.p2.level)) { this.p2.heal(this.p2.passive.healOnSwitch || 15); const _lnf = this.p2.abilities.find(a => a.special?.type === 'lostNFound'); if (_lnf) _lnf.currentUses = Math.min(_lnf.maxUses, _lnf.currentUses + (this.p2.passive.lostNFoundRestore || 2)); }
      // --- UPDATE 31: Goop is removed when the Melting one switches out ---
      if (this.p2.passive?.type === 'itHurtsPap' || this.p2.passive?.type === 'itHurts') this.p2._clearGoopFrom(this.p1, this.p2.id);
      this.active2 = index;
      return { success: true, message: `Switched from **${old}** to **${this.p2.name}**!` };
    }
  }

  calculateDamage(attacker, ability, defender) {
    const dmg = Math.floor(Math.random() * (ability.damageMax - ability.damageMin + 1)) + ability.damageMin;
    const typeMult = getTypeMultiplier(ability.type, defender.type);
    defender._incomingTypeMult = typeMult; // UPDATE 32: read by Doki Meter in takeDamage
    defender._incomingAbilityType = ability.type; // SCAMTON EVENT: read by Patience Parry in takeDamage
    let critChance = COMBAT.CRIT_CHANCE + (attacker.critBoost || 0);
    if (attacker.passive?.type === 'doubleCrit' && hasPassiveUnlocked(attacker.level)) critChance *= 2;
    // Rosy Pink Tint (a forced grin.) — chance for guaranteed hit flag + crit boost
    if (attacker.passive?.type === 'rosyPinkTint' && hasPassiveUnlocked(attacker.level) && Math.random() < (attacker.passive.chance || 0.2)) { attacker._rosyPinkActive = true; critChance += 0.15; }
    // Heavy Rain — target can't crit this turn
    if (attacker._noCritThisTurn) critChance = 0;
    const isCrit = Math.random() < critChance;
    const critMult = isCrit ? COMBAT.CRIT_MULTIPLIER : 1;
    let total = ((dmg * (attacker.atk * typeMult)) / defender.def) * critMult;
    if (attacker.id === 'underswap_papyrus' && defender.hasStatus('Orange Soul')) total *= 1.1;
    if (attacker.passive?.type === 'shatteredExpectations' && hasPassiveUnlocked(attacker.level) && ability.type === 'Bone' && defender.hasStatus('Blue Soul')) total *= (attacker.passive.blueSoulBoneMult || 1.3);
    // Will to Avenge — Spite stacks: +1 ATK per stack on Melee, all consumed
    if (attacker.passive?.type === 'willToAvenge' && hasPassiveUnlocked(attacker.level) && ability.type === 'Melee' && (attacker._spiteStacks || 0) > 0) {
      total += attacker._spiteStacks * typeMult;
      attacker._spiteStacks = 0;
    }
    // Omniversal Prodigy Magic boost
    if (attacker.passive?.type === 'omniversalProdigy' && hasPassiveUnlocked(attacker.level) && ability.type === 'Magic' && (attacker._magicDmgBoost || 0) > 0) {
      total *= (1 + attacker._magicDmgBoost);
    }
    // Weak Omniversal Cleave next-Magic boost (consumed)
    if (attacker._magicBoostNext && ability.type === 'Magic') {
      total *= attacker._magicBoostNext;
      attacker._magicBoostNext = 0;
    }
    // Faded Blaster reduction
    if (attacker._fadedBlasterReduction) {
      total *= (1 - attacker._fadedBlasterReduction);
      attacker._fadedBlasterReduction = 0;
    }
    // FFTBO stacking flat damage boost (this has been my finale since day one)
    if ((attacker._fftboDmgBoost || 0) > 0) total += attacker._fftboDmgBoost;
    // --- Ported attacker damage-modifier passives (from PvE engine) ---
    if (attacker.passive?.type === 'blackSoul' && hasPassiveUnlocked(attacker.level) && defender.statusEffects && defender.statusEffects.length > 0) total *= (attacker.passive.multiplier || 1.2);
    if (attacker.passive?.type === 'auraManipulation' && hasPassiveUnlocked(attacker.level) && Math.random() < (attacker.passive.chance || 0.2)) total *= (attacker.passive.multiplier || 1.5);
    if (attacker._gastersHelpAssist > 0) { total += attacker._gastersHelpAssist; attacker._gastersHelpAssist = 0; }
    if (attacker._dustyDetBoost && attacker._dustyDetBoostTurns > 0) total *= attacker._dustyDetBoost;
    if (attacker._damageBoostNext) { total *= attacker._damageBoostNext; attacker._damageBoostNext = 0; }
    if (attacker.passive?.type === 'sirius' && hasPassiveUnlocked(attacker.level) && Math.random() < (attacker.passive.chance || 0.2)) { total *= (attacker.passive.multiplier || 1.5); attacker._siriusBurnFlag = true; }
    if (attacker.passive?.type === 'ruthlessJudgement' && hasPassiveUnlocked(attacker.level) && defender.statusEffects && defender.statusEffects.length > 0) total *= (attacker.passive.multiplier || 1.2);
    if (defender.statusEffects?.some(s => s.name === 'Schizo') && Math.random() < 0.25) total *= 1.10;
    if (attacker.passive?.type === 'divineHatred' && hasPassiveUnlocked(attacker.level) && (attacker.currentHp / attacker.maxHp) < (attacker.passive.hpThreshold || 0.5)) total += Math.floor((defender.def || 0) * (attacker.passive.defIgnore || 0.20));
    // Souls Help (Seraphim) boosts
    if (attacker._justiceBoostThisTurn) total *= 1.2;
    if (attacker._braveryBoostNext) { total *= attacker._braveryBoostNext; attacker._braveryBoostNext = 0; }
    if (defender._perseveranceDmgReduce) { total *= (1 - defender._perseveranceDmgReduce); defender._perseveranceDmgReduce = 0; }
    // --- UPDATE 31: GRAB (!REBAR!) — the grabbed fighter deals 20% less damage ---
    if (attacker._grabDmgReduction > 0) total *= (1 - attacker._grabDmgReduction);
    total = Math.max(COMBAT.MIN_DAMAGE, Math.floor(total));
    // --- SCAMTON EVENT: bank damage dealt so postTurn can convert it to PP ---
    if (attacker.hasPP && attacker.hasPP()) attacker._ppDamageThisTurn = (attacker._ppDamageThisTurn || 0) + total;
    return { totalDamage: total, isCrit, typeMult };
  }

  // INSANITY threshold checks for PvP (Final Insanity Losing His Mind)
  _pvpCheckInsanity(attacker, defender, log) {
    const stacks = defender._insanityStacks || 0;
    if (stacks > 11) { defender._insanityStacks = 0; log.push(`🧠 [INSANITY] stacks reset! (exceeded 11)`); return; }
    const targetDebuff = Math.floor(stacks / 3) * 2;
    const currentDebuff = defender._insanityDebuffApplied || 0;
    if (targetDebuff > currentDebuff) {
      const diff = targetDebuff - currentDebuff;
      defender.atkMod -= diff; defender.defMod -= diff;
      defender._insanityDebuffApplied = targetDebuff;
    }
    if (stacks >= 6) defender._insanityMoveFail = 0.30;
    if (stacks >= 10 && !defender._insanityStunQueued) {
      defender._insanityStunQueued = true;
      defender.addStatus('stun');
      log.push(`🧠 [INSANITY] reached 10 stacks! Defender **STUNNED**!`);
    }
  }

  executeAbility(playerId, abilityIndex) {
    const attacker = this.getAttacker();
    const defender = this.getDefender();
    const ability = attacker.abilities[abilityIndex];
    const log = [];
    attacker._tailRestoreSpecial(); // Jevil's Tail: undo last turn's doubling

    if (!ability || ability.currentUses <= 0) return { success: false, message: 'No uses left!' };
    if (ability.cooldownLeft > 0) return { success: false, message: `**${ability.name}** on cooldown! (${ability.cooldownLeft} turns)` };
    if (ability._disabledTurns > 0) return { success: false, message: `**${ability.name}** is **disabled** for ${ability._disabledTurns} more turn(s)!` };
    // --- SCAMTON EVENT: Power Points cost gate ---
    if (ability.special?.ppCost) {
      const _cur = attacker._pp || 0;
      if (_cur < ability.special.ppCost) return { success: false, message: `⚡ **${ability.name}** requires **${ability.special.ppCost} PP** — you have **${_cur}**!` };
    }

    // --- UPDATE 18: track if ability is damaging for Losing His Mind passive ---
    attacker._lastAbilityWasDamaging = (ability.damageMax || 0) > 0;
    // Souls Help (Seraphim) — random soul effect at the start of the turn
    if (attacker.passive?.type === 'soulsHelp' && hasPassiveUnlocked(attacker.level)) this.triggerSoulsHelp(attacker, defender, log);
    if (attacker._roarLockoutTurns > 0) {
      const t = ability.special?.type;
      if (t === 'heal' || t === 'parry' || t === 'taunt' || t === 'debuff' || t === 'gravityManip' || t === 'savePointAnchor' || t === 'timelineStar' || t === 'aggravation') {
        return { success: false, message: `**${ability.name}** is locked out by **Devastating Roar**!` };
      }
    }

    // Insanity 4+ stacks — 30% move fail
    if (attacker._insanityMoveFail && Math.random() < attacker._insanityMoveFail) {
      ability.currentUses--;
      attacker._skippedLastTurn = true; // UPDATE 32
      log.push(`**${attacker.name}**'s SOUL is unstable from [INSANITY]! Move **failed**!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    if (attacker.skipNextTurn) {
      attacker.skipNextTurn = false;
      attacker._skippedLastTurn = true; // UPDATE 32
      log.push(`**${attacker.name}** is recovering and can't attack!`);
      if (attacker.equipped === 'jevils_scythe') { attacker.passiveAtkAccumulated += 2; log.push(`🪓 **Jevil's Scythe** — ${attacker.name} skipped and gains **+2 ATK**!`); }
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    const incapacitated = attacker.statusEffects.find(s => s.name === 'Stun' || s.name === 'Flinch' || s.name === 'Frozen');
    if (incapacitated) {
      const state = incapacitated.name === 'Stun' ? 'stunned' : (incapacitated.name === 'Flinch' ? 'flinched' : 'frozen');
      // Stun/Flinch are consumed immediately; Frozen ticks down normally (matches combat.js)
      if (incapacitated.name !== 'Frozen') {
        attacker.statusEffects = attacker.statusEffects.filter(s => s !== incapacitated);
      }
      ability.currentUses++; // refund the use
      this.turnNumber++; attacker.turnCount++;
      attacker._skippedLastTurn = true; // UPDATE 32
      log.push(`**${attacker.name}** is ${state} and can't attack!`);
      if (attacker.equipped === 'jevils_scythe') { attacker.passiveAtkAccumulated += 2; log.push(`🪓 **Jevil's Scythe** — ${attacker.name} skipped and gains **+2 ATK**!`); }
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    ability.currentUses--;
    this.turnNumber++;
    attacker.turnCount++;
    attacker._tailDoubleSpecial(ability); // Jevil's Tail: double this attack's effect-proc chances
    // Skip cooldown on the CHARGE turn — only apply it on RELEASE (ported from combat.js UPDATE 20 fix).
    // Without this, Flame Eye ROAR / CHUNG etc. lock themselves out mid-charge and can never fire.
    const _isChargeStarting = ['flameEyeRoar', 'chungBlast', 'weakenedChung', 'finalChung', 'charge', 'comicallyLargeBlunt', 'rebarImpale', 'rebarRetrieve', 'papQBlueSoul', 'sixHelpUs', 'sixNoEffect', 'lastBreathStrike'].includes(ability.special?.type) && !attacker.isCharging && !attacker._flameEyeRoarCharging && !attacker._chungCharging && !attacker.isReleasing;
    if (ability.special?.cooldown && !_isChargeStarting) ability.cooldownLeft = (attacker._familyCdOverride || ability.special.cooldown) + 1;
    attacker._usedAbilityThisTurn = true;
    attacker._attackedThisTurn = ability.damageMax > 0;
    attacker._lastUsedAbilityIndex = abilityIndex; // UPDATE 32: needed by Purple Purr-fection
    attacker._skippedLastTurn = false; // UPDATE 32: they acted this turn
    // --- UPDATE 30: Papyrus Belief — Shattered Expectations bone/magic alternation ---
    if (attacker.passive?.type === 'shatteredExpectations' && hasPassiveUnlocked(attacker.level) && (ability.type === 'Bone' || ability.type === 'Magic')) {
      const prevType = attacker._beliefLastType;
      if (prevType && prevType !== ability.type) {
        if (Math.random() < (attacker.passive.overwhelmChance || 0.10)) {
          const active = defender.statusEffects.filter(st => st.turnsLeft > 0);
          if (active.length) { active[Math.floor(Math.random()*active.length)].turnsLeft += 1; }
          defender.skipNextTurn = true;
          log.push('Shattered Expectations: OVERWHELM! Status extended + Papyrus gets an extra turn!');
        }
      }
      attacker._beliefLastType = ability.type;
    }
    // --- UPDATE 30: Papyrus Belief — ISN'T HE A BLAST double-cost consumption ---
    if (attacker._doubleCostNext) { attacker._doubleCostNext = false; ability.currentUses = Math.max(0, ability.currentUses - 1); log.push(`**${attacker.name}**'s attack costs double uses (Papyrus Belief)!`); }

    if (attacker._attackedThisTurn) {
      const miss = attacker.consumeAttackMiss();
      if (miss) {
        const missMsg = miss.source === 'blindness' ? '**Blindness** caused the attack to miss!' : 'the attack missed!';
        log.push(`**${attacker.name}** used **${ability.name}**... but ${missMsg}`);
        this.postTurn(attacker, defender, log);
        return { success: true, log, battleEnd: this.checkEnd() };
      }
      // Defender dodge passives (Reflexes / generic Dodge / Souls Help Integrity)
      // --- UPDATE 32: Doki Meter — Mad Mew Mew cannot dodge at all ---
      if (defender._noDodge) { defender.dodgeNextAttack = false; defender._integrityDodge = 0; }
      let dodged = null;
      if (defender._noDodge) dodged = null;
      else if (defender.passive?.type === 'reflexes' && hasPassiveUnlocked(defender.level) && Math.random() < (defender.def / 100)) dodged = 'Reflexes';
      else if (defender.passive?.type === 'dodge' && hasPassiveUnlocked(defender.level) && Math.random() < (defender.passive.chance || 0)) dodged = defender.passive.name || 'Dodge';
      else if (defender._integrityDodge && Math.random() < defender._integrityDodge) dodged = 'Integrity';
      if (dodged) {
        log.push(`**${attacker.name}** used **${ability.name}**... but **${defender.name}** dodged it! (**${dodged}**)`);
        this.postTurn(attacker, defender, log);
        return { success: true, log, battleEnd: this.checkEnd() };
      }
    }

    // TELEPORT
    if (ability.special?.type === 'teleport') {
      attacker.dodgeNextAttack = true;
      attacker.critBoost = ability.special.critBoost;
      log.push(`**${attacker.name}** used **${ability.name}**! Will dodge and gain crit boost!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // HEAL
    if (ability.special?.type === 'heal') {
      if (attacker.hasStatus('Glitched')) {
        const result = attacker.takeDamage(ability.special.amount);
        log.push(`**${attacker.name}** used **${ability.name}**... but **Glitched** turned the heal into **${ability.special.amount}** self-damage!${result.lastStand ? `\n**Last Stand!** ${attacker.name} survives at 1 HP!` : ''}`);
        this.postTurn(attacker, defender, log);
        return { success: true, log, battleEnd: this.checkEnd() };
      }
      const h = attacker.heal(ability.special.amount);
      log.push(`**${attacker.name}** used **${ability.name}**! Recovered **${h} HP**! (${attacker.currentHp}/${attacker.maxHp})`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // --- UPDATE 15: FIRENUKE (CATASTROPHE!FELL) — fixed 125 dmg both, Burn defender ---
    if (ability.special?.type === 'firenuke') {
      const dmg = ability.damageMin || 125;
      const selfDmg = ability.special.selfDamage || dmg;
      defender.takeDamage(dmg);
      attacker.currentHp = Math.max(0, attacker.currentHp - selfDmg);
      const burnSr = defender.addStatus('burn');
      const emoji = TYPES[ability.type]?.emoji || '';
      let msg = `**${attacker.name}** used **H E L L N U K E** ${emoji}! **${dmg}** damage to **${defender.name}**! **${attacker.name}** also takes **${selfDmg}** damage!`;
      if (burnSr) msg += ' **Burn applied!**';
      log.push(msg);
      // If defender is KO'd, attacker wins regardless of self-damage — check before postTurn autoSwitch
      if (!defender.isAlive) {
        this.autoSwitch(log);
        const end = this.checkEnd();
        if (end) {
          this.isOver = true;
          return { success: true, log, battleEnd: end };
        }
      }
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // BONE FIELD
    if (ability.special?.type === 'boneField') {
      const sr = defender.addStatus('boneField');
      if (sr) Object.assign(defender.statusEffects.find(s => s.name === sr.name), { damageMin: ability.special.damageMin, damageMax: ability.special.damageMax });
      log.push(`**${attacker.name}** used **${ability.name}**! Enemy will take **${ability.special.damageMin}-${ability.special.damageMax}** damage when using abilities for ${ability.special.duration} turns!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // CHARGE
    if (ability.special?.type === 'charge' && !attacker.isReleasing) {
      if (!attacker.isCharging) {
        attacker.isCharging = true;
        attacker.chargedAbility = abilityIndex;
        if (ability.special.selfDebuff) {
          attacker.atkMod += (ability.special.selfDebuff.atk || 0);
          attacker.defMod += (ability.special.selfDebuff.def || 0);
        }
        log.push(`**${attacker.name}** ${ability.special.chargeMessage}`);
        ability.currentUses++;
        this.postTurn(attacker, defender, log);
        return { success: true, log, battleEnd: this.checkEnd() };
      }
    }

    // DEBUFF
    if (ability.special?.type === 'debuff') {
      const target = ability.special.target === 'enemy' ? defender : attacker;
      if (ability.special.stat === 'atk') target.atkMod += ability.special.amount;
      if (ability.special.stat === 'def') target.defMod += ability.special.amount;
      log.push(`**${attacker.name}** used **${ability.name}**! ${target.name}'s ${ability.special.stat.toUpperCase()} ${ability.special.amount}!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // GRAVITY MANIP
    if (ability.special?.type === 'gravityManip') {
      attacker.defMod += ability.special.selfDef;
      defender.defMod += ability.special.enemyDef;
      let d = null;
      if (ability.damageMax > 0) { d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); }
      log.push(`**${attacker.name}** used **${ability.name}**!${d ? ` **${d.totalDamage}** damage!` : ''}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // RISKY
    if (ability.special?.type === 'risky') {
      if (Math.random() < ability.special.missChance) {
        log.push(`**${attacker.name}** used **${ability.name}**... **missed**!`);
      } else {
        const d = this.calculateDamage(attacker, ability, defender);
        defender.takeDamage(d.totalDamage);
        log.push(`**${attacker.name}** used **${ability.name}**! **HIT!** **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}`);
        if (ability.special.statusOnHit) { const sr = defender.addStatus(ability.special.statusOnHit); if (sr) log.push(`**${sr.name}** applied!`); }
      }
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // GOOP BLASTER
    if (ability.special?.type === 'goopBlaster') {
      const d = this.calculateDamage(attacker, ability, defender);
      defender.takeDamage(d.totalDamage);
      defender.defMod += ability.special.enemyDef;
      defender.atkMod += ability.special.enemyAtk;
      attacker.skipNextTurn = true;
      log.push(`**${attacker.name}** used **${ability.name}**! **${d.totalDamage}** damage! Enemy debuffed. Can't attack next turn!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // DOUBLE HIT
    if (ability.special?.type === 'doubleHit') {
      if (defender.passive?.type === 'starDust') {
        // UPDATE 19 NERF: StarDust blocks extra hits but no longer disables the attacker
        const d1 = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d1.totalDamage);
        log.push(`**${attacker.name}** used **${ability.name}**! ✨ **StarDust** blocks extra hits — **${d1.totalDamage}** damage (1 hit only)!`);
        this.postTurn(attacker, defender, log);
        return { success: true, log, battleEnd: this.checkEnd() };
      }
      let total = 0, msg = `**${attacker.name}** used **${ability.name}**!`;
      for (let i = 0; i < 2; i++) {
        const d = this.calculateDamage(attacker, ability, defender);
        defender.takeDamage(d.totalDamage); total += d.totalDamage;
        msg += ` Hit ${i+1}: **${d.totalDamage}**${d.isCrit ? ' (CRIT)' : ''}!`;
      }
      if (ability.special.poisonChance && Math.random() < ability.special.poisonChance) { defender.addStatus('poison'); msg += ' **Poisoned!**'; }
      log.push(msg);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // PARRY
    if (ability.special?.type === 'parry') {
      attacker.parrying = true;
      log.push(`**${attacker.name}** enters a **parry stance**!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // TAUNT
    if (ability.special?.type === 'taunt') {
      attacker.defMod += ability.special.selfDef;
      defender.atkMod += ability.special.enemyAtk;
      defender.taunted = true;
      log.push(`**${attacker.name}** used **${ability.name}**! +${ability.special.selfDef} DEF! Enemy +${ability.special.enemyAtk} ATK but can't switch!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // TIMELINE STAR
    if (ability.special?.type === 'timelineStar') {
      attacker.saveState();
      log.push(`**${attacker.name}** used **Timeline Star**! Current stats saved. Will be restored in 4 turns.`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // STEAL WEAPON
    if (ability.special?.type === 'stealWeapon') {
      const { CHARACTERS } = require('./gameData');
      const allChars = Object.values(CHARACTERS);
      const allMoves = [];
      allChars.forEach(ch => ch.abilities && ch.abilities.forEach(a => {
        if (a.damageMax > 0) allMoves.push({ ...a, ownerName: ch.name });
      }));
      const stolen = allMoves[Math.floor(Math.random() * allMoves.length)];
      const d = this.calculateDamage(attacker, stolen, defender); defender.takeDamage(d.totalDamage);
      const emoji = TYPES[stolen.type]?.emoji || '';
      log.push(`**${attacker.name}** stole **${stolen.name}** from ${stolen.ownerName}! ${emoji} **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // COINFLIP
    if (ability.special?.type === 'coinflip') {
      const statuses = ['poison', 'bleed', 'burn', 'stun'];
      const picked = statuses[Math.floor(Math.random() * statuses.length)];
      if (Math.random() < 0.5) {
        const d = this.calculateDamage(attacker, { ...ability, damageMin: 15, damageMax: 25 }, defender);
        defender.takeDamage(d.totalDamage); defender.addStatus(picked);
        log.push(`**${attacker.name}** flips a coin... **Heads!** **${d.totalDamage}** damage! Applied **${picked}** to enemy!`);
      } else {
        attacker.takeDamage(20); attacker.addStatus(picked);
        log.push(`**${attacker.name}** flips a coin... **Tails!** Takes 20 self-damage and **${picked}**!`);
      }
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // TEMP DEBUFF (Fracture Strike)
    if (ability.special?.type === 'tempDebuff') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      if (!defender._tempDebuffs) defender._tempDebuffs = [];
      const existing = defender._tempDebuffs.find(td => td.stat === ability.special.stat && td.source === ability.name);
      let debuffMsg = '';
      if (!existing) {
        if (ability.special.stat === 'atk') defender.atkMod += ability.special.amount;
        if (ability.special.stat === 'def') defender.defMod += ability.special.amount;
        defender._tempDebuffs.push({ stat: ability.special.stat, amount: ability.special.amount, turnsLeft: ability.special.duration, source: ability.name });
        debuffMsg = ` ${defender.name}'s ${ability.special.stat.toUpperCase()} ${ability.special.amount} for ${ability.special.duration} turns!`;
      } else { existing.turnsLeft = ability.special.duration; debuffMsg = ` (debuff refreshed)`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${debuffMsg}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // ===== BATCH 1 FIX: ability specials that were unhandled in PvP =====

    // priority (Underswap Sans — Bone Drop): damage + flinch chance
    if (ability.special?.type === 'priority') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.flinchChance || 0.2)) { const sr = defender.addStatus('flinch'); if (sr) sm = ' **Flinched!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // gravityEffect (M87 — M B Z / Time Space Cut): damage + gravity pin (stun chance)
    if (ability.special?.type === 'gravityEffect') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.stunChance || 0.25)) { const sr = defender.addStatus('stun'); if (sr) sm = ' 🌌 **Gravity pins them — Stunned!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // blueBones (Papyrus — Blue Bones): trap. Enemy takes damage when they next attack.
    if (ability.special?.type === 'blueBones') {
      defender.addStatus('boneField');
      const bf = defender.statusEffects.find(s => s.name === 'Bone Field');
      if (bf) { bf.damageMin = ability.damageMin; bf.damageMax = ability.damageMax; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! 🔵 Blue bones set — if the enemy attacks, they take **${ability.damageMin}-${ability.damageMax}** damage!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // rkBoneZone (RK!Swap Papyrus — Bone Zone): damage + Orange Soul + karma chance
    if (ability.special?.type === 'rkBoneZone') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.orangeChance ?? 1)) {
        defender.addStatus('orangeSoul');
        const os = defender.statusEffects.find(s => s.name === 'Orange Soul');
        if (os && ability.special.orangeDuration) os.turnsLeft = ability.special.orangeDuration;
        sm += ' 🧡 **Orange Soul!**';
      }
      if (Math.random() < (ability.special.karmaChance || 0)) { const sr = defender.addStatus('karma'); if (sr) sm += ' ☯️ **Karma!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // randomBones (TS!Papyrus — Random Bones): White (dmg), Blue (-1 DEF), Orange (-1 ATK)
    if (ability.special?.type === 'randomBones') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      const roll = Math.random();
      if (roll < 0.34) { defender.defMod -= 1; sm = ' 🔵 Blue bone — **DEF -1!**'; }
      else if (roll < 0.67) { defender.atkMod -= 1; sm = ' 🧡 Orange bone — **ATK -1!**'; }
      else { sm = ' ⚪ White bone — pure damage!'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // highGravity (Fallen Stars — Gravity Slam): damage + strong stun chance (2 turns)
    if (ability.special?.type === 'highGravity') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.chance || 0.4)) {
        const sr = defender.addStatus('stun');
        if (sr) { const st = defender.statusEffects.find(s => s.name === 'Stun'); if (st) st.turnsLeft = Math.max(st.turnsLeft, 2); sm = ' 🪐 **High gravity — Stunned 2 turns!**'; }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // krChance (Fallen Stars — Cosmic Blasters): damage + Scary KR chance
    if (ability.special?.type === 'krChance') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.chance || 0.35)) { const sr = defender.addStatus('scaryKR'); if (sr) sm = ' ☯️ **Scary KR — takes damage when attacking!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // charaErase (Chara — ERASE): damage; kill => cooldown -1, no kill => Bleed
    if (ability.special?.type === 'charaErase') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (defender.currentHp <= 0) {
        if (ability.cooldownLeft > 0) ability.cooldownLeft = Math.max(0, ability.cooldownLeft - 1);
        sm = ' 💀 **ERASED** — cooldown reduced!';
      } else { const sr = defender.addStatus('bleed'); if (sr) sm = ' **Bleed!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // krisSpare (Kris — Spare): enemy ATK -1 (20% chance -2 instead)
    if (ability.special?.type === 'krisSpare') {
      const amt = Math.random() < 0.2 ? 2 : 1;
      defender.atkMod -= amt;
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! Spared the enemy — their **ATK -${amt}!**`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // suzieCrunch (Susie — Crunch): damage + disable-move chance; crit heals 10
    if (ability.special?.type === 'suzieCrunch') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.disableChance || 0.25)) {
        const usable = (defender.abilities || []).filter(a => a && a.currentUses > 0 && a._disabledTurns <= 0);
        if (usable.length) { const t = usable[Math.floor(Math.random() * usable.length)]; t._disabledTurns = 2; sm += ` 🦷 **Disabled ${t.name}!**`; }
      }
      if (d.isCrit) { const h = attacker.heal(10); if (h) sm += ` 💚 **Healed ${h}!**`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // ralseiburn (Ralsei — Burn Out): damage + guaranteed Burn (10% Hellfire instead)
    if (ability.special?.type === 'ralseiburn') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < 0.1) { const sr = defender.addStatus('hellfire'); if (sr) sm = ' 🔥 **HELLFIRE!**'; else { defender.addStatus('burn'); sm = ' **Burn!**'; } }
      else { const sr = defender.addStatus('burn'); if (sr) { const b = defender.statusEffects.find(s => s.name === 'Burn'); if (b) b.turnsLeft = Math.max(b.turnsLeft, 2); sm = ' **Burn (2t)!**'; } }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // tridentSlashDreemurr (Asgore — Trident Slash): damage + Bleed chance + follow-up fireball
    if (ability.special?.type === 'tridentSlashDreemurr') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.bleedChance || 0.21)) { const sr = defender.addStatus('bleed'); if (sr) sm += ' **Bleed!**'; }
      if (Math.random() < (ability.special.fireballChance || 0.3)) {
        defender.takeDamage(10);
        const sr = defender.addStatus('burn'); if (sr) {}
        sm += ' 🔥 **Follow-up fireball — +10 & Burn!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // frozen (Noelle Snowgrave — Enhanced Ice Shock): damage + Frozen chance
    if (ability.special?.type === 'frozen') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.chance || 0.5)) {
        const sr = defender.addStatus('frozen');
        if (sr) { const fz = defender.statusEffects.find(s => s.name === 'Frozen'); if (fz && ability.special.duration) fz.turnsLeft = ability.special.duration; sm = ' 🧊 **Frozen!**'; }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // concussion (Torgore / YOUR FAULT — Blaster Slam): damage + Concussion chance
    if (ability.special?.type === 'concussion') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.chance || 0.25)) {
        const sr = defender.addStatus('concussion');
        if (sr) { const cc = defender.statusEffects.find(s => s.name === 'Concussion'); if (cc && ability.special.duration) cc.turnsLeft = ability.special.duration; sm = ' 🤕 **Concussion!**'; }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // TRACKING BLASTER
    if (ability.special?.type === 'trackingBlaster') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.stunChance) { defender.addStatus('stun'); sm = ' **Stunned!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage! *(Guaranteed hit)*${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // MULTI HIT
    if (ability.special?.type === 'multiHit') {
      if (defender.passive?.type === 'starDust') {
        // UPDATE 19 NERF: StarDust blocks extra hits but no longer disables the attacker
        const d1 = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d1.totalDamage);
        log.push(`**${attacker.name}** used **${ability.name}**! ✨ **StarDust** blocks extra hits — **${d1.totalDamage}** damage (1 hit only)!`);
        this.postTurn(attacker, defender, log);
        return { success: true, log, battleEnd: this.checkEnd() };
      }
      const hits = Math.floor(Math.random() * (ability.special.maxHits - ability.special.minHits + 1)) + ability.special.minHits;
      let total = 0, msg = `**${attacker.name}** used **${ability.name}**!`;
      const appliedStatuses = new Set();
      for (let i = 0; i < hits; i++) {
        if (ability.special.critBonus) attacker.critBoost = ability.special.critBonus;
        const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage;
        msg += ` Hit ${i+1}: **${d.totalDamage}**${d.isCrit ? ' (CRIT)' : ''}!`;
        if (ability.special.poisonChance && Math.random() < ability.special.poisonChance) { const sr = defender.addStatus('poison'); if (sr) appliedStatuses.add(sr.name); }
        if (!defender.isAlive) break;
      }
      attacker.critBoost = 0;
      if (total > 0 && ability.special.statusOnHit) { const sr = defender.addStatus(ability.special.statusOnHit); if (sr) appliedStatuses.add(sr.name); }
      msg += ` (${hits} hits, **${total}** total)`;
      if (appliedStatuses.size > 0) msg += [...appliedStatuses].map(name => ` **${name}** applied!`).join('');
      log.push(msg);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // STUN
    if (ability.special?.type === 'stun') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.chance) { defender.addStatus('stun'); sm = ' **Stunned!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // BURN
    if (ability.special?.type === 'burn') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      const statusKey = ability.special.statusOverride || (ability.special.duration >= 3 ? 'burn3' : 'burn');
      const applyChance = ability.special.burnChance ?? 1;
      const sr = Math.random() < applyChance ? defender.addStatus(statusKey) : null;
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sr ? ` **${sr.name}** applied!` : ''}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // BLUE SOUL
    if (ability.special?.type === 'blueSoul') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      const emoji = TYPES[ability.type]?.emoji || '';
      let sm = '';
      if (Math.random() < ability.special.chance) { const sr = defender.addStatus('blueSoul'); if (sr) sm = ` **${sr.name}** applied!`; }
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // APPLY STATUS
    if (ability.special?.type === 'applyStatus') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      const sr = defender.addStatus(ability.special.status);
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sr ? ` **${sr.name}** applied!` : ''}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // HIGH CRIT
    // =====================================================================
    // SCAMTON EVENT — THE REWRITTEN (Asriel / Noelle / Charkis)
    // =====================================================================
    // LIGHT IGNITION — 10 PP, become Fire/Melee, arm a one-time Burn
    if (ability.special?.type === 'lightIgnition') {
      const sp = ability.special;
      ability.currentUses--;
      attacker.spendPP(sp.ppCost);
      attacker.type = 'Fire/Melee';
      attacker._lightIgnitionBurn = sp.burnDuration || 3;
      log.push(`🔥 **${attacker.name}** used **${ability.name}**! Now **Fire/Melee** for the rest of the battle — **Saber Slash** will **Burn** for ${attacker._lightIgnitionBurn} turns once. *(PP: ${attacker._pp}/${attacker.maxPP})*`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    // DICE TIME — 30 PP, roll 1-6
    if (ability.special?.type === 'diceTime') {
      const sp = ability.special;
      ability.currentUses--;
      attacker.spendPP(sp.ppCost);
      const roll = Math.floor(Math.random() * 6) + 1;
      let msg = '';
      if (roll === 1) { attacker.takeDamage(10); msg = '**1** — takes **10** self damage!'; }
      else if (roll === 2) { msg = '**2** — nothing happens.'; }
      else if (roll === 3) { attacker.statusEffects = []; msg = '**3** — all current effects **cleansed**!'; }
      else if (roll === 4) { const h = attacker.heal(25); msg = `**4** — recovered **${h} HP**!`; }
      else if (roll === 5) { attacker.atkMod += 2; attacker.defMod += 2; if (!attacker._tempDebuffs) attacker._tempDebuffs = []; attacker._tempDebuffs.push({ stat: 'atk', amount: 2, turnsLeft: 3, source: 'Dice Time' }); attacker._tempDebuffs.push({ stat: 'def', amount: 2, turnsLeft: 3, source: 'Dice Time' }); msg = '**5** — **+2 ATK** and **+2 DEF** for 3 turns!'; }
      else { const halve = Math.floor(defender.def / 2); defender.defMod -= halve; msg = `**6** — **${defender.name}'s DEF is halved!** (-${halve} DEF)`; }
      log.push(`🎲 **${attacker.name}** used **${ability.name}**! ${msg} *(PP: ${attacker._pp}/${attacker.maxPP})*`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    // PATIENCE PARRY — guard vs Magic/Unique, 50% of absorbed damage becomes PP
    if (ability.special?.type === 'patienceParry') {
      const sp = ability.special;
      ability.currentUses--;
      attacker._rewrittenGuard = { pct: sp.blockPercent, types: ['Magic', 'Unique'], ppConvert: sp.ppConvert, label: ability.name };
      attacker._rewrittenGuardAbsorbed = 0; attacker._rewrittenGuardPPGain = 0;
      log.push(`🛡️ **${attacker.name}** used **${ability.name}**! Braced against **Magic** and **Unique** attacks.`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    // ICESHOCK — 30 PP, flat 50, guaranteed crit
    if (ability.special?.type === 'noelleIceShock') {
      const sp = ability.special;
      ability.currentUses--;
      attacker.spendPP(sp.ppCost);
      attacker.critBoost += 1;
      const d = this.calculateDamage(attacker, ability, defender);
      defender.takeDamage(d.totalDamage);
      attacker.critBoost = 0;
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`❄️ **${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage! **CRIT!** *(PP: ${attacker._pp}/${attacker.maxPP})*`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    // HEAL HAIL — 50 PP, heal the acting side's whole party
    if (ability.special?.type === 'healHail') {
      const sp = ability.special;
      ability.currentUses--;
      attacker.spendPP(sp.ppCost);
      const healed = [];
      for (const f of this.getAttackerTeam()) {
        if (!f.isAlive) continue;
        const h = f.heal(sp.healAmount || 20);
        if (h > 0) healed.push(`**${f.name}** +${h}`);
      }
      log.push(`🌨️ **${attacker.name}** used **${ability.name}**! ${healed.length ? healed.join(', ') : 'Nobody needed healing'}. *(PP: ${attacker._pp}/${attacker.maxPP})*`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    // GLACIER DEFENSE — guard 50%, +20 PP
    if (ability.special?.type === 'glacierDefense') {
      const sp = ability.special;
      ability.currentUses--;
      const gained = attacker.gainPP(sp.ppGain || 20);
      attacker._rewrittenGuard = { pct: sp.blockPercent, types: null, ppConvert: 0, label: ability.name };
      attacker._rewrittenGuardAbsorbed = 0;
      log.push(`🧊 **${attacker.name}** used **${ability.name}**! Bracing for **50%** less damage. **+${gained} PP** *(${attacker._pp}/${attacker.maxPP})*`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    // MOTIVATE UP — 20 PP, +2 ATK / +2 DEF to a chosen ally for 5 turns
    if (ability.special?.type === 'motivateUp') {
      const sp = ability.special;
      ability.currentUses--;
      attacker.spendPP(sp.ppCost);
      const myTeam = this.getAttackerTeam();
      const tgt = (attacker._ppTargetIndex !== null && attacker._ppTargetIndex !== undefined && myTeam[attacker._ppTargetIndex] && myTeam[attacker._ppTargetIndex].isAlive) ? myTeam[attacker._ppTargetIndex] : attacker;
      attacker._ppTargetIndex = null;
      tgt.atkMod += sp.atk; tgt.defMod += sp.def;
      if (!tgt._tempDebuffs) tgt._tempDebuffs = [];
      tgt._tempDebuffs.push({ stat: 'atk', amount: sp.atk, turnsLeft: sp.turns, source: 'Motivate Up' });
      tgt._tempDebuffs.push({ stat: 'def', amount: sp.def, turnsLeft: sp.turns, source: 'Motivate Up' });
      log.push(`📣 **${attacker.name}** used **${ability.name}** on **${tgt.name}**! **+${sp.atk} ATK** and **+${sp.def} DEF** for ${sp.turns} turns. *(PP: ${attacker._pp}/${attacker.maxPP})*`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    // IMMUNITY SHIELD — 35 PP, chosen ally fully tanks one hit + full cleanse
    if (ability.special?.type === 'immunityShield') {
      const sp = ability.special;
      ability.currentUses--;
      attacker.spendPP(sp.ppCost);
      const myTeam = this.getAttackerTeam();
      const tgt = (attacker._ppTargetIndex !== null && attacker._ppTargetIndex !== undefined && myTeam[attacker._ppTargetIndex] && myTeam[attacker._ppTargetIndex].isAlive) ? myTeam[attacker._ppTargetIndex] : attacker;
      attacker._ppTargetIndex = null;
      tgt._immunityShield = true;
      tgt.statusEffects = [];
      log.push(`✨ **${attacker.name}** used **${ability.name}** on **${tgt.name}**! They will **fully tank the next hit** and were **cleansed**. *(PP: ${attacker._pp}/${attacker.maxPP})*`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    // HAT STANCE — guard 50%, +15 PP, self cleanse
    if (ability.special?.type === 'hatStance') {
      const sp = ability.special;
      ability.currentUses--;
      const gained = attacker.gainPP(sp.ppGain || 15);
      attacker.statusEffects = [];
      attacker._rewrittenGuard = { pct: sp.blockPercent, types: null, ppConvert: 0, label: ability.name };
      attacker._rewrittenGuardAbsorbed = 0;
      log.push(`🎩 **${attacker.name}** used **${ability.name}**! All effects **cleansed**, bracing for **50%** less damage. **+${gained} PP** *(${attacker._pp}/${attacker.maxPP})*`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'highCrit') {
      attacker.critBoost += ability.special.critBonus;
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      attacker.critBoost = 0;
      const emoji = TYPES[ability.type]?.emoji || '';
      let sm = '';
      if (ability.special.statusOnHit) { const sr = defender.addStatus(ability.special.statusOnHit); if (sr) sm = ` **${sr.name}** applied!`; }
      // --- SCAMTON EVENT: Light Ignition — Saber Slash burns once ---
      if ((attacker._lightIgnitionBurn || 0) > 0 && ability.name === 'Saber Slash' && d.totalDamage > 0) {
        const br = defender.addStatus('burn');
        if (br) {
          const _inst = defender.statusEffects.find(x => x.name === 'Burn');
          if (_inst) _inst.turnsLeft = attacker._lightIgnitionBurn;
          sm += ` 🔥 **Burn** for ${attacker._lightIgnitionBurn} turns!`;
        }
        attacker._lightIgnitionBurn = 0;
      }
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // BONE SWING
    if (ability.special?.type === 'boneSwing') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      if (!attacker._boneSwingChance) attacker._boneSwingChance = ability.special.baseBleedChance;
      let bleedMsg = '';
      if (Math.random() < attacker._boneSwingChance) { defender.addStatus('bleed'); bleedMsg = ' **Bleed** applied!'; attacker._boneSwingChance = ability.special.baseBleedChance; }
      else { attacker._boneSwingChance += 0.1; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${bleedMsg}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // BLASTER BARRAGE
    if (ability.special?.type === 'blasterBarrage') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      const poisonTurns = Math.floor(Math.random() * 5) + 1;
      defender.statusEffects.push({ name: 'Poison', emoji: '🟢', damagePerTurn: 3, turnsLeft: poisonTurns });
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage! **Poisoned** for ${poisonTurns} turns!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // COLOR BARRAGE
    if (ability.special?.type === 'colorBarrage') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      const stat = Math.random() < 0.5 ? 'atk' : 'def';
      if (!defender._tempDebuffs) defender._tempDebuffs = [];
      if (stat === 'atk') defender.atkMod -= 3; else defender.defMod -= 3;
      defender._tempDebuffs.push({ stat, amount: -3, turnsLeft: 1, source: 'Color Barrage' });
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage! Enemy ${stat.toUpperCase()} -3 for 1 turn!${d.isCrit ? ' **CRIT!**' : ''}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // BLOCKED
    if (ability.special?.type === 'blocked') {
      const boost = attacker.baseDef * 2;
      attacker.defMod += boost;
      if (!attacker._tempDebuffs) attacker._tempDebuffs = [];
      attacker._tempDebuffs.push({ stat: 'def', amount: boost, turnsLeft: ability.special.duration, source: 'BLOCKED' });
      attacker._blockedActive = ability.special.duration;
      log.push(`**${attacker.name}** used **BLOCKED**! DEF tripled for ${ability.special.duration} turns! Bone Swing disabled.`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // FLAME BLASTER
    if (ability.special?.type === 'flameBlaster') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.statusChance) { const s = Math.random() < 0.5 ? 'burn' : 'poison'; defender.addStatus(s); sm = ` **${s.charAt(0).toUpperCase() + s.slice(1)}!**`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // SHARP BONE BARRAGE
    if (ability.special?.type === 'sharpBoneBarrage') {
      if (defender.passive?.type === 'starDust') {
        // UPDATE 19 NERF: StarDust blocks extra hits but no longer disables the attacker
        const d1 = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d1.totalDamage);
        log.push(`**${attacker.name}** used **${ability.name}**! ✨ **StarDust** blocks extra hits — **${d1.totalDamage}** damage (1 hit only)!`);
        this.postTurn(attacker, defender, log);
        return { success: true, log, battleEnd: this.checkEnd() };
      }
      const hits = Math.floor(Math.random() * (ability.special.maxHits - ability.special.minHits + 1)) + ability.special.minHits;
      let total = 0, msg = `**${attacker.name}** used **${ability.name}**!`;
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage;
        msg += ` Hit ${i+1}: **${d.totalDamage}**${d.isCrit ? ' (CRIT)' : ''}!`;
        if (!defender.isAlive) break;
      }
      msg += ` (${hits} hits, **${total}** total)`;
      if (hits >= 5) { const status = Math.random() < 0.5 ? 'bleed' : 'poison'; defender.addStatus(status); msg += ` **${status.charAt(0).toUpperCase() + status.slice(1)}** applied!`; }
      log.push(msg);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // GASTER BLASTER FRENZY
    if (ability.special?.type === 'gasterBlasterFrenzy') {
      attacker.atkMod = Math.max(0, attacker.atkMod); attacker.defMod = Math.max(0, attacker.defMod);
      attacker.statusEffects = attacker.statusEffects.filter(s => s.name === 'Bone Zone' || s.name === 'Sharp Bone Zone');
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      defender.addStatus('poison'); defender.defMod -= 1;
      let msg = `**${attacker.name}** used **${ability.name}**! Debuffs cleared! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} Enemy **Poisoned**, DEF -1!`;
      if (Math.random() < 0.2) { attacker.takeDamage(10); msg += ` (Recoil! -10 HP)`; }
      log.push(msg);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // INSANITY TELEPORT
    if (ability.special?.type === 'insanityTeleport') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      attacker.dodgeNextAttack = true;
      if (!defender.statusEffects.find(s => s.name === 'Bone Zone')) defender.statusEffects.push({ name: 'Bone Zone', emoji: '🦴', damagePerTurn: 10, turnsLeft: 2 });
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} Will dodge next attack! **Bone Zone** applied!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // HANDS OF FATE
    if (ability.special?.type === 'handsOfFate') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      const statuses = ['burn', 'poison', 'stun'];
      const picked = statuses[Math.floor(Math.random() * statuses.length)];
      defender.addStatus(picked);
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} Applied **${picked}**!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // GASTER SYMBOL
    if (ability.special?.type === 'gasterSymbol') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let msg = `**${attacker.name}** used **᲼᲼᲼᲼**! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}`;
      let total = d.totalDamage;
      if (Math.random() < 0.1) { const d2 = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d2.totalDamage); total += d2.totalDamage; msg += ` **Double hit!** Second: **${d2.totalDamage}**! Total: **${total}**`; }
      log.push(msg);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // SILENCE CHECK — block Unique moves
    if (attacker.hasStatus('Silence') && ability.type === 'Unique') {
      ability.currentUses++;
      log.push(`**${attacker.name}** is **Silenced** and cannot use Unique moves!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // BLEED AND STUN
    if (ability.special?.type === 'bleedAndStun') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      const emoji = TYPES[ability.type]?.emoji || '';
      let sm = '';
      if (Math.random() < (ability.special.bleedChance || 0)) { defender.addStatus('bleed'); sm += ' **Bleed!**'; }
      if (Math.random() < (ability.special.stunChance || 0)) { defender.addStatus('stun'); sm += ' **Stunned!**'; }
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // UPDATE 30: UV Swap — Giant Gaster Blaster (poison 2t + 30% DEF-1)
    if (ability.special?.type === 'giantGasterBlaster') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      const emoji = TYPES[ability.type]?.emoji || '';
      let sm = '';
      const sr = defender.addStatus('poison');
      if (sr) { const ps = defender.statusEffects.find(s => s.name === 'Poison'); if (ps && ability.special.poisonDuration) ps.turnsLeft = ability.special.poisonDuration; sm += ` 🟢 **Poison** for ${ability.special.poisonDuration || 2} turns!`; }
      if (Math.random() < (ability.special.defDownChance || 0.30)) { defender.defMod -= (ability.special.defDown || 1); sm += ` **-${ability.special.defDown || 1} DEF!**`; }
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    // UPDATE 30: UV Swap — Blue Bone Combo (bleed 2t + 30% stun -> trap+cd, else blue soul 1t)
    if (ability.special?.type === 'uvBlueBoneCombo') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      const emoji = TYPES[ability.type]?.emoji || '';
      let sm = '';
      const br = defender.addStatus('bleed');
      if (br) { const bl = defender.statusEffects.find(s => s.name === 'Bleed'); if (bl && ability.special.bleedDuration) bl.turnsLeft = ability.special.bleedDuration; sm += ` 🩸 **Bleed** for ${ability.special.bleedDuration || 2} turns!`; }
      if (Math.random() < (ability.special.stunChance || 0.30)) {
        defender.addStatus('stun');
        defender._uvTrapTurns = Math.max(defender._uvTrapTurns || 0, ability.special.trapDuration || 2);
        ability.cooldownLeft = ability.special.stunCooldown || 3;
        sm += ` **Stunned!** ${defender.name} cannot switch for ${ability.special.trapDuration || 2} turns!`;
      } else {
        const su = defender.addStatus('blueSoul');
        if (su) { const bs = defender.statusEffects.find(s => s.name === 'Blue Soul'); if (bs) bs.turnsLeft = ability.special.blueSoulDuration || 1; sm += ` 💙 **Blue Soul** for ${ability.special.blueSoulDuration || 1} turn!`; }
      }
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    // UPDATE 30: UV Swap — Bone Tower Barrage (60% bleed, 1.2x vs stunned/poisoned, +fixed status dmg debuff)
    if (ability.special?.type === 'uvBoneTowerBarrage') {
      const wasStunnedOrPoisoned = defender.hasStatus('Stun') || defender.hasStatus('Poison');
      const d = this.calculateDamage(attacker, ability, defender);
      let dmg = d.totalDamage;
      if (wasStunnedOrPoisoned) dmg = Math.floor(dmg * (ability.special.statusBonusMult || 1.2));
      defender.takeDamage(dmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      let sm = '';
      if (Math.random() < (ability.special.bleedChance || 0.6)) { defender.addStatus('bleed'); sm += ` 🩸 **Bleed!**`; }
      if (wasStunnedOrPoisoned) sm += ` (1.2x vs afflicted)`;
      defender._statusDamageBonus = ability.special.statusDamageBonus || 10;
      defender._statusDamageBonusTurns = 2;
      sm += ` ⚠️ Status damage +${ability.special.statusDamageBonus || 10} for 2 turns!`;
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    // UPDATE 30: LowTierFell — LowTier Blasters
    if (ability.special?.type === 'lowtierBlasters') {
      let total = 0; const hits = ability.special.hits || 3;
      for (let i = 0; i < hits; i++) { if (!defender.isAlive) break; const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage; }
      let sm = '';
      if ((attacker.currentHp / attacker.maxHp) < (ability.special.lowHpThreshold || 0.10)) { defender.currentHp = Math.max(0, defender.currentHp - (ability.special.lowHpTrueDamage || 15)); total += (ability.special.lowHpTrueDamage || 15); sm += ` ⚡ **+${ability.special.lowHpTrueDamage || 15} true!**`; }
      const kr = defender.addStatus('scaryKR'); if (kr) { const k = defender.statusEffects.find(s => s.name === 'Scary KR'); if (k) k.turnsLeft = ability.special.scaryKRDuration || 1; sm += ' ☯️ **Scary KR!**'; }
      const po = defender.addStatus('poison'); if (po) { const q = defender.statusEffects.find(s => s.name === 'Poison'); if (q) q.turnsLeft = ability.special.poisonDuration || 1; sm += ' 🟢 **Poison!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! ${hits} blasters for **${total}** damage!${sm}`);
      this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    }
    // UPDATE 30: LowTierFell — LowTier Bones
    if (ability.special?.type === 'lowtierBones') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      const kr = defender.addStatus('scaryKR'); if (kr) { const k = defender.statusEffects.find(s => s.name === 'Scary KR'); if (k) k.turnsLeft = ability.special.scaryKRDuration || 1; sm += ' ☯️ **Scary KR!**'; }
      const bl = defender.addStatus('bleed'); if (bl) { const b = defender.statusEffects.find(s => s.name === 'Bleed'); if (b) b.turnsLeft = ability.special.bleedDuration || 1; sm += ' 🩸 **Bleed!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    }
    // UPDATE 30: LowTierFell — Chained Slam
    if (ability.special?.type === 'chainedSlam') {
      if (Math.random() < (ability.special.missChance || 0.30)) {
        log.push(`**${attacker.name}** used **${ability.name}**... but it **missed**!`);
        this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
      }
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); let total = d.totalDamage;
      let sm = '';
      if ((attacker.currentHp / attacker.maxHp) < (ability.special.lowHpThreshold || 0.15)) { defender.currentHp = Math.max(0, defender.currentHp - (ability.special.lowHpTrueDamage || 10)); total += (ability.special.lowHpTrueDamage || 10); sm += ` 👊 **+${ability.special.lowHpTrueDamage || 10} true!**`; }
      if (Math.random() < (ability.special.statusChance || 0.40)) {
        const dur = ability.special.statusDuration || 2;
        for (const [key, nm] of [['scaryKR','Scary KR'],['bleed','Bleed'],['poison','Poison'],['karma','Karma']]) { const r = defender.addStatus(key); if (r) { const st = defender.statusEffects.find(s => s.name === nm); if (st) st.turnsLeft = dur; } }
        sm += ` ☯️🩸🟢 **Scary KR + Bleed + Poison + Karma (${dur}t)!**`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${total}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    }
    // UPDATE 30: LowTierFell — I'VE HAD ENOUGH OF YOU, BRAT!
    if (ability.special?.type === 'lowtierEnough') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      const bl = defender.addStatus('bleed'); if (bl) { const b = defender.statusEffects.find(s => s.name === 'Bleed'); if (b) b.turnsLeft = ability.special.bleedDuration || 2; sm += ' 🩸 **Bleed!**'; }
      const st = defender.addStatus('stun'); if (st) sm += ' 💫 **Stunned!**';
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    }
    // UPDATE 30: Storyspin — Bat Whack
    if (ability.special?.type === 'batWhack') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.stunChance || 0.40)) { const st = defender.addStatus('stun'); if (st) sm += ' STUN'; }
      if (Math.random() < (ability.special.defDownChance || 0.20)) { defender.defMod -= (ability.special.defDown || 2); sm += ` -${ability.special.defDown || 2} DEF`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm ? ' -' + sm : ''}`);
      this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    }
    // UPDATE 30: Storyspin — Twisted Barrage
    if (ability.special?.type === 'twistedBarrage') {
      const hits = Math.floor(Math.random() * ((ability.special.maxHits || 5) - (ability.special.minHits || 3) + 1)) + (ability.special.minHits || 3);
      let total = 0, pierces = 0;
      for (let i = 0; i < hits; i++) {
        if (!defender.isAlive) break;
        let pierce = 0;
        if (Math.random() < (ability.special.pierceChance || 0.20)) { pierce = Math.floor(defender.def * (ability.special.piercePercent || 0.10)); defender.defMod -= pierce; pierces++; }
        const d = this.calculateDamage(attacker, ability, defender);
        if (pierce) defender.defMod += pierce;
        defender.takeDamage(d.totalDamage); total += d.totalDamage;
      }
      let sm = '';
      const po = defender.addStatus('poison'); if (po) { const q = defender.statusEffects.find(s => s.name === 'Poison'); if (q) q.turnsLeft = ability.special.poisonDuration || 2; sm += ` Poison ${ability.special.poisonDuration || 2}t`; }
      if (pierces > 0) sm += ` (pierced ${pierces}x)`;
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! ${hits} hits for **${total}** damage!${sm ? ' -' + sm : ''}`);
      this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    }
    // UPDATE 30: Storyspin — Vision Manipulation
    if (ability.special?.type === 'visionManipulation') {
      const dur = Math.floor(Math.random() * ((ability.special.blindMax || 5) - (ability.special.blindMin || 3) + 1)) + (ability.special.blindMin || 3);
      const br = defender.addStatus('blindness'); let sm = '';
      if (br) { const b = defender.statusEffects.find(s => s.name === 'Blindness'); if (b) b.turnsLeft = dur; sm = ` Blindness for ${dur} turns!`; } else { sm = ' (no effect)'; }
      log.push(`**${attacker.name}** used **${ability.name}**!${sm}`);
      this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    }
    // UPDATE 30: Storyspin — Malfunctioning Blaster
    if (ability.special?.type === 'malfunctioningBlaster') {
      const d = this.calculateDamage(attacker, ability, defender);
      let dmg = d.totalDamage, sm = '';
      if (Math.random() < (ability.special.malfunctionChance || 0.25)) {
        dmg = Math.floor(dmg * 0.5);
        defender.takeDamage(dmg);
        attacker.currentHp = Math.max(1, attacker.currentHp - dmg);
        attacker.critBoost = (ability.special.critBoost || 0.30);
        attacker._critBoostTurns = ability.special.critBoostTurns || 2;
        sm = ` MALFUNCTION! Half damage to both (${dmg} self) - crit up ${ability.special.critBoostTurns || 2}t!`;
      } else { defender.takeDamage(dmg); }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    }
    // UPDATE 30: Papyrus Belief — Bone Pummel
    if (ability.special?.type === 'bonePummel') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.defDownChance || 0.25)) { defender.defMod -= (ability.special.defDown || 2); sm = ` -${ability.special.defDown || 2} DEF`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    }
    // UPDATE 30: Papyrus Belief — Bonely Retribution
    if (ability.special?.type === 'bonelyRetribution') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.stunChance || 0.25)) { const st = defender.addStatus('stun'); if (st) sm = ' STUN'; }
      else { defender._perseveranceDmgReduce = Math.max(defender._perseveranceDmgReduce || 0, ability.special.weakenPercent || 0.20); sm = ` enemy next attack -${Math.round((ability.special.weakenPercent || 0.20)*100)}%`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    }
    // UPDATE 30: Papyrus Belief — Gravitational Despair
    if (ability.special?.type === 'gravitationalDespair') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      const su = defender.addStatus('blueSoul'); if (su) { const bs = defender.statusEffects.find(s => s.name === 'Blue Soul'); if (bs) bs.turnsLeft = ability.special.blueSoulDuration || 3; sm = ` Blue Soul ${ability.special.blueSoulDuration || 3}t`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    }
    // UPDATE 30: Papyrus Belief — ISN'T HE A BLAST?
    if (ability.special?.type === 'isntHeABlast') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      const br = defender.addStatus('blindness'); if (br) { const b = defender.statusEffects.find(s => s.name === 'Blindness'); if (b) b.turnsLeft = ability.special.blindDuration || 3; sm = ` Blindness ${ability.special.blindDuration || 3}t`; }
      defender._doubleCostNext = true;
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm} (next enemy attack costs double)`);
      this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    }
    // UPDATE 30: Toxin — Bone-Twister
    if (ability.special?.type === 'boneTwister') {
      const d = this.calculateDamage(attacker, ability, defender);
      const existing = defender.statusEffects.find(st => st.name === 'Bone-Twister');
      if (existing) { existing.damagePerTurn = d.totalDamage; existing.turnsLeft = ability.special.dotTurns || 3; }
      else defender.statusEffects.push({ id: 'boneTwister', name: 'Bone-Twister', emoji: '\u{1F9B4}', damagePerTurn: d.totalDamage, turnsLeft: ability.special.dotTurns || 3 });
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! Enemy takes **${d.totalDamage}** damage each turn for ${ability.special.dotTurns || 3} turns!`);
      this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    }
    // UPDATE 30: Toxin — Lost'N'Found
    if (ability.special?.type === 'lostNFound') {
      const roll = Math.floor(Math.random() * 6) + 1;
      let total = 0, sm = '', label = '';
      if (roll === 1) { label = "Outerdust's Trident"; const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total = d.totalDamage; defender.atkMod -= 4; sm = ' Enemy -4 ATK!'; }
      else if (roll === 2) { label = "Fell's Brass Knuckle"; attacker.critBoost = 0.70; const d = this.calculateDamage(attacker, ability, defender); attacker.critBoost = 0; total = d.totalDamage * 2; defender.takeDamage(total); ability.cooldownLeft = 3; sm = ' 2x damage (70% crit)! 2-turn cooldown.'; }
      else if (roll === 3) { label = "Sudden's Revolver'n'Rounds"; const hits = Math.floor(Math.random() * 5) + 3; for (let i = 0; i < hits; i++) { if (!defender.isAlive) break; const d = this.calculateDamage(attacker, ability, defender); const dmg = Math.max(1, Math.floor(d.totalDamage * 0.25)); defender.takeDamage(dmg); total += dmg; } sm = ` ${hits} hits!`; if (hits === 7) { defender.addStatus('burn'); sm += ' OVERHEAT (Burn)!'; } }
      else if (roll === 4) { label = "Horror's Thigh-Bone"; attacker.critBoost = 0.30; const d = this.calculateDamage(attacker, ability, defender); attacker.critBoost = 0; defender.takeDamage(d.totalDamage); total = d.totalDamage; defender.addStatus('hemorrhage'); defender.addStatus('bleed'); sm = ' Hemorrhage + Bleed!'; }
      else if (roll === 5) { label = "Reaper's Scythe"; const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total = d.totalDamage; defender._deathTouchStacks = Math.min(5, (defender._deathTouchStacks || 0) + 2); sm = ` Death's Touch +2 (now ${defender._deathTouchStacks}/5)!`; }
      else { label = "Distrust's Magical Bone Butter Knife"; const d = this.calculateDamage(attacker, ability, defender); let base = d.totalDamage; let combo = base + Math.floor(base * 0.25) * 2; if (defender.hasStatus('Bone-Twister')) { combo *= 2; sm = ' 2x (Bone-Twister)!'; } defender.takeDamage(combo); total = combo; sm = ' 3 hits!' + sm; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** grabs **${label}** ${emoji}! **${total}** damage!${sm}`);
      this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    }
    // UPDATE 30: Toxin — DT Injection / Spare Reservations
    if (ability.special?.type === 'dtInjection' || ability.special?.type === 'spareReservations') {
      const isP1 = this.team1.includes(attacker); const team = isP1 ? this.team1 : this.team2; const curIdx = isP1 ? this.active1 : this.active2;
      const candidates = team.map((f, i) => ({ f, i })).filter(({ f, i }) => i !== curIdx && f.isAlive);
      if (candidates.length === 0) { ability.currentUses++; log.push('No living teammate to switch to!'); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (attacker.passive?.type === 'overstockedShelves') { attacker.heal(attacker.passive.healOnSwitch || 15); const _lnf = attacker.abilities.find(a => a.special?.type === 'lostNFound'); if (_lnf) _lnf.currentUses = Math.min(_lnf.maxUses, _lnf.currentUses + (attacker.passive.lostNFoundRestore || 2)); }
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      let effMsg = '';
      if (ability.special.type === 'dtInjection') { pick.f.atkMod += (ability.special.atkBoost || 3); pick.f.defMod += (ability.special.defBoost || 1); effMsg = `+${ability.special.atkBoost || 3} ATK / +${ability.special.defBoost || 1} DEF`; }
      else { const h = pick.f.heal(ability.special.heal || 45); effMsg = `healed **${h} HP**`; }
      if (isP1) this.active1 = pick.i; else this.active2 = pick.i;
      this[isP1 ? '_toxinSwap1' : '_toxinSwap2'] = { returnTurns: ability.special.returnAfter || 3, toxinIndex: curIdx, justCast: true };
      log.push(`**${attacker.name}** used **${ability.name}**! Switched in **${pick.f.name}** (${effMsg}). Toxin returns in ${ability.special.returnAfter || 3} turns.`);
      this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    }
    // REWIND (FT!Sans) — heals last damage taken
    if (ability.special?.type === 'rewind') {
      if (attacker.currentHp >= attacker.maxHp) {
        ability.currentUses++;
        log.push(`**Rewind** can only be used below 100% HP!`);
        return { success: false, message: 'Rewind can only be used below 100% HP!' };
      }
      const healAmt = attacker._lastDamageTaken || 0;
      const healed = attacker.heal(healAmt);
      log.push(`**${attacker.name}** used **Rewind.**! Time reverses — healed **${healed} HP**! (${attacker.currentHp}/${attacker.maxHp})`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // NEW HOST (True Fresh!Sans PvP) — if enemy ≤15% HP, True Fresh dies but steals their character
    if (ability.special?.type === 'newHost') {
      const hpPct = defender.currentHp / defender.maxHp;
      if (hpPct > ability.special.hpThreshold) {
        ability.currentUses++;
        log.push(`**NEW HOST** can only be used when the enemy is at **15% HP or below**!`);
        return { success: false, message: 'NEW HOST: enemy must be at 15% HP or below!' };
      }
      // True Fresh dies, enemy character dies, attacker's team gets that character at 50% HP -5 ATK -5 DEF
      attacker.currentHp = 0;
      defender.currentHp = 0;
      const stolenChar = { ...defender, currentHp: Math.floor(defender.maxHp * 0.5), atkMod: (defender.atkMod || 0) - 5, defMod: (defender.defMod || 0) - 5 };
      const attackerTeam = this.currentTurn === this.player1Id ? this.team1 : this.team2;
      attackerTeam.push(stolenChar);
      log.push(`🦠 **${attacker.name}** used **NEW HOST**! The parasite leaps — **True Fresh!Sans dies** but **steals ${defender.name}** for the team at 50% HP! (-5 ATK, -5 DEF)`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // VIAL VOLLEY (Shanghaivania — PvP version)
    if (ability.special?.type === 'vialVolley') {
      const traits = ['Patience', 'Bravery', 'Integrity', 'Kindness', 'Perseverance', 'Justice', 'Determination'];
      const trait = traits[Math.floor(Math.random() * traits.length)];
      let total = 0, sm = '';
      if (trait === 'Patience') {
        if (!defender._patienceKnives) defender._patienceKnives = { damagePerTurn: 10, turnsLeft: 2, explodeDmg: 20 };
        sm = `🟣 **Patience**: Spinning Knives! 10 dmg/turn, explodes for 20 after 2 turns!`;
      } else if (trait === 'Bravery') {
        defender._braveryTrap = true; sm = `🟠 **Bravery**: Trap! Non-attacking move = 25 damage!`;
      } else if (trait === 'Integrity') {
        const dmg = Math.floor(Math.random() * 4) + 14; defender.takeDamage(dmg); total = dmg;
        sm = `🔵 **Integrity**: Guaranteed **${total}** damage!`;
      } else if (trait === 'Kindness') {
        defender.takeDamage(15); total = 15; attacker._shieldHp = (attacker._shieldHp || 0) + 25;
        sm = `🟢 **Kindness**: 15 damage + **25 Shield HP** gained!`;
      } else if (trait === 'Perseverance') {
        defender.addStatus('silence'); sm = `🟤 **Perseverance**: **Silence** applied!`;
      } else if (trait === 'Justice') {
        let jTotal = 0;
        for (let i = 0; i < 6; i++) { const dmg = Math.floor(Math.random() * 3) + 5; defender.takeDamage(dmg); jTotal += dmg; }
        attacker.skipNextTurn = true; total = jTotal;
        sm = `🟡 **Justice**: 6 hits, **${total}** total! Must **Reload** next turn!`;
      } else if (trait === 'Determination') {
        attacker.atkMod += 2; attacker.defMod += 2; attacker._determinationTurns = 3;
        sm = `🔴 **Determination**: +2 ATK, +2 DEF for 3 turns!`;
      }
      log.push(`**${attacker.name}** used **Vial Volley**! ${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // SUMMONING ASSISTANCE (Shanghaivania — PvP version)
    if (ability.special?.type === 'summoningAssistance') {
      const useClassic = Math.random() < 0.5;
      const summonName = useClassic ? 'Classic Sans' : 'Fell Sans';
      const attackPool = useClassic ? [
        { name: 'Bone Throw', type: 'Bone', dmgMin: 12, dmgMax: 16, status: 'karma' },
        { name: 'Bone Zone', type: 'Bone', dmgMin: 12, dmgMax: 15, boneZone: true },
        { name: 'Gaster Blaster', type: 'Magic', dmgMin: 16, dmgMax: 22, status: 'poison', status2: 'karma' },
      ] : [
        { name: 'Sharp Bones', type: 'Bone', dmgMin: 15, dmgMax: 18, bleedChance: 0.5 },
        { name: 'Chain Grab', type: 'Unique', dmgMin: 15, dmgMax: 15, stunChance: 0.3 },
        { name: 'Gaster Slam', type: 'Magic', dmgMin: 20, dmgMax: 20, stunTurns: 2, poisonChance: 0.5 },
      ];
      const atk = attackPool[Math.floor(Math.random() * attackPool.length)];
      const dmg = Math.floor(Math.random() * (atk.dmgMax - atk.dmgMin + 1)) + atk.dmgMin;
      defender.takeDamage(dmg);
      let sm = '';
      if (atk.status) { defender.addStatus(atk.status); sm += ` **${atk.status}!**`; }
      if (atk.status2) { defender.addStatus(atk.status2); sm += ` **Karma!**`; }
      if (atk.boneZone) { defender.statusEffects.push({ name: 'Bone Zone', emoji: '🦴', damagePerTurn: 10, turnsLeft: 2 }); sm += ' **Bone Zone!**'; }
      if (atk.bleedChance && Math.random() < atk.bleedChance) { defender.addStatus('bleed'); sm += ' **Bleed!**'; }
      if (atk.stunChance && Math.random() < atk.stunChance) { defender.addStatus('stun'); sm += ' **Stunned!**'; }
      if (atk.poisonChance && Math.random() < atk.poisonChance) { defender.addStatus('poison'); sm += ' **Poisoned!**'; }
      if (useClassic) attacker._summonedClassicLastResort = true;
      // Living Canvas: 10% Ink Trail on Magic
      if (atk.type === 'Magic' && attacker.passive?.type === 'livingCanvas' && Math.random() < 0.1) {
        attacker._inkTrailActive = true; attacker._inkTrailTurns = 3; sm += ' 🎨 **Ink Trail!**';
      }
      log.push(`**${attacker.name}** calls **${summonName}**! ${atk.name} — **${dmg}** damage!${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // LAST RESORT (Shanghaivania — PvP version)
    if (ability.special?.type === 'lastResort') {
      if (!attacker._summonedClassicLastResort || attacker.turnCount < 5) {
        ability.currentUses++;
        log.push(`**Last Resort** requires Classic Sans from Summoning Assistance AND turn 5+!`);
        return { success: false, message: 'Last Resort conditions not met!' };
      }
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      const statuses = ['poison', 'bleed', 'blindness', 'stun'];
      const picked = statuses[Math.floor(Math.random() * statuses.length)];
      defender.addStatus(picked);
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **Last Resort** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} Applied **${picked}**!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // ============================================================
    // === UPDATE 12 PVP ABILITY SPECIALS ===
    // ============================================================

    // FADED BLASTER (C!Insanity Weak) — 30% reduce defender's next attack
    if (ability.special?.type === 'fadedBlaster') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.chance) {
        defender._fadedBlasterReduction = ability.special.reduction;
        sm = ` Defender's next attack reduced by **${Math.round(ability.special.reduction * 100)}%**!`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // SHATTERED BONEWALL (C!Insanity Weak) — 30% counter + bleed
    if (ability.special?.type === 'shatteredBoneWall') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.counterChance) {
        defender._boneWallCounter = ability.special.counterDamage;
        sm = ` 🦴 **Bone Wall** primed!`;
      }
      defender.addStatus('bleed'); sm += ' **Bleed!**';
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // FRACTURED CLEAVE (C!Insanity Weak) — bleed + 10% perma -2 DEF
    if (ability.special?.type === 'fracturedCleave') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      defender.addStatus('bleed'); let sm = ' **Bleed!**';
      if (Math.random() < ability.special.defReduceChance) { defender.defMod -= ability.special.defReduceAmount; sm += ` Defender DEF -${ability.special.defReduceAmount} permanently!`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // WEAKENED CHUNG (C!Insanity Weak) — charge then karma + 10 HP on PvP kill
    if (ability.special?.type === 'weakenedChung' && !attacker.isReleasing) {
      if (!attacker.isCharging) {
        attacker.isCharging = true; attacker.chargedAbility = abilityIndex;
        ability.currentUses++;
        log.push(`**${attacker.name}** clutches their head, channeling memories of **Chung**...`);
        this.postTurn(attacker, defender, log);
        return { success: true, log, battleEnd: this.checkEnd() };
      }
    }
    if (ability.special?.type === 'weakenedChung' && attacker.isReleasing) {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      defender.addStatus('karma');
      let sm = ' **Karma!**';
      // Set cooldown on release
      if (ability.special?.cooldown) ability.cooldownLeft = ability.special.cooldown + 1;
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** unleashes the violent outburst! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      // PvP kill bonus
      if (!defender.isAlive) { const h = attacker.heal(10); log.push(`💀 **PvP kill!** ${attacker.name} restored **${h} HP**!`); }
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // THOUSAND AXE SLASHES (C!Insanity) — 2-5 hits, bleed chance per hit, all-5 -1 DEF
    // ===================== UPDATE 31 ABILITY HANDLERS (PvP) =====================
    // --- helpers used by the U31 handlers ---
    const _u31crit = (f, fn) => { const b = f.critBoost || 0; f.critBoost = 1; try { return fn(); } finally { f.critBoost = b; } };
    const _u31hits = (n) => Math.max(1, n * ((attacker._rebarDoubleHits > 0) ? 2 : 1));
    const _u31team = () => (this.team1.includes(attacker) ? this.team1 : this.team2);
    const _u31rkey = () => (this.team1.includes(attacker) ? '_retensiveHeal1' : '_retensiveHeal2');

    // ===================== UPDATE 32: MAD MEW MEW (PvP) =====================
    const _u32dokiMax = (attacker.passive?.threshold || 5);
    const _u32doubling = () => (attacker.passive?.type === 'dokiMeter' && hasPassiveUnlocked(attacker.level) && (attacker._doki || 0) >= _u32dokiMax);
    const _u32spend = () => { attacker._doki = 0; };
    const _u32dokiTag = () => (attacker.passive?.type === 'dokiMeter' ? ` 🩷 Doki: **${attacker._doki || 0}/${_u32dokiMax}**` : '');

    // PURPLE PURR-FECTION — PvP has no simultaneous turns, so it drains the
    // opponent's MOST RECENT move. Fails if they haven't acted / skipped their last turn.
    if (ability.special?.type === 'purplePurrfection') {
      const sp = ability.special;
      let sm;
      const idx = defender._lastUsedAbilityIndex;
      const used = (idx != null) ? defender.abilities[idx] : null;
      if (!used || defender._skippedLastTurn) {
        sm = ` **${defender.name}** skipped — the move **failed**!`;
      } else {
        const cut = Math.min(sp.useReduction || 3, used.currentUses);
        used.currentUses = Math.max(0, used.currentUses - (sp.useReduction || 3));
        sm = ` 🍵 **${used.name}** loses **${cut}** use${cut === 1 ? '' : 's'}! (${used.currentUses} left)`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}!${sm}${_u32dokiTag()}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // CAT-NADO
    if (ability.special?.type === 'catNado') {
      const sp = ability.special;
      const twice = _u32doubling();
      let total = 0, crit = false;
      for (let i = 0; i < (twice ? 2 : 1); i++) {
        const d = this.calculateDamage(attacker, ability, defender);
        defender.takeDamage(d.totalDamage); total += d.totalDamage; if (d.isCrit) crit = true;
        if (!defender.isAlive) break;
      }
      let sm = '';
      if (Math.random() < (sp.healChance || 0.20)) {
        const amt = Math.floor(Math.random() * ((sp.healMax || 15) - (sp.healMin || 5) + 1)) + (sp.healMin || 5);
        const healed = defender.heal(amt);
        attacker._doki = (attacker._doki || 0) + (sp.dokiGain || 1);
        sm = ` 💚 A heart slipped through — **${defender.name}** healed **${healed} HP**, but Mew Mew gains **+1 Doki**!`;
      }
      if (twice) _u32spend();
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}!${twice ? ' 🩷 **5 DOKI — DOUBLE STRIKE!**' : ''} **${total}** damage!${crit ? ' **CRIT!**' : ''}${sm}${_u32dokiTag()}`);
      if (!defender.isAlive) { const h = attacker.heal(10); log.push(`💀 **PvP kill!** ${attacker.name} restored **${h} HP**!`); }
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // POCKET BOMBS
    if (ability.special?.type === 'pocketBombs') {
      const sp = ability.special;
      const twice = _u32doubling();
      let total = 0, sm = '', allHits = 0;
      for (let sw = 0; sw < (twice ? 2 : 1); sw++) {
        const rolled = _u31hits(Math.floor(Math.random() * ((sp.maxHits || 3) - (sp.minHits || 1) + 1)) + (sp.minHits || 1));
        let landed = 0;
        for (let i = 0; i < rolled; i++) {
          const d = this.calculateDamage(attacker, ability, defender);
          defender.takeDamage(d.totalDamage); total += d.totalDamage; landed++;
          if (!defender.isAlive) break;
        }
        allHits += landed;
        // Gated on the REPEAT COUNT ROLLED, not on the target surviving.
        if (rolled >= (sp.maxHits || 3) && Math.random() < (sp.bonusChance || 0.50)) {
          const bonus = sp.bonusDamage || 30;
          defender.takeDamage(bonus); total += bonus;
          sm += ` 💥 **A gigantic one!** +**${bonus}** fixed damage!`;
        }
        if (!defender.isAlive) break;
      }
      if (twice) _u32spend();
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}!${twice ? ' 🩷 **5 DOKI — DOUBLE STRIKE!**' : ''} Hit **${allHits}** times for **${total}** damage!${sm}${_u32dokiTag()}`);
      if (!defender.isAlive) { const h = attacker.heal(10); log.push(`💀 **PvP kill!** ${attacker.name} restored **${h} HP**!`); }
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // SUPERB KARAOKE
    if (ability.special?.type === 'superbKaraoke') {
      const sp = ability.special;
      if ((attacker._doki || 0) < (sp.dokiRequired || 3)) {
        ability.currentUses++; ability.cooldownLeft = 0;
        attacker._usedAbilityThisTurn = false; attacker._attackedThisTurn = false;
        this.turnNumber--; attacker.turnCount--;
        return { success: false, message: `🎤 **${ability.name}** needs at least **${sp.dokiRequired || 3} Doki**! (You have **${attacker._doki || 0}**)` };
      }
      const twice = _u32doubling();
      let total = 0, crit = false;
      for (let i = 0; i < (twice ? 2 : 1); i++) {
        const d = this.calculateDamage(attacker, ability, defender);
        defender.takeDamage(d.totalDamage); total += d.totalDamage; if (d.isCrit) crit = true;
        if (!defender.isAlive) break;
      }
      const dur = sp.duration || 3;
      if (defender._karaokePassiveStash === undefined) defender._karaokePassiveStash = defender.passive;
      defender.passive = null;
      defender._passiveDisabledTurns = dur;
      defender._karaokeAbsorbTurns = dur;
      defender._karaokeAbsorber = attacker;
      attacker.atkMod += (sp.atkGain || 1);
      attacker.defMod += (sp.defGain || 1);
      if (twice) _u32spend();
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}!${twice ? ' 🩷 **5 DOKI — DOUBLE STRIKE!**' : ''} **${total}** damage!${crit ? ' **CRIT!**' : ''} 🎤 For **${dur}** turns: **${defender.name}**'s passive is **disabled**, Mew Mew gains **+${sp.atkGain || 1} ATK / +${sp.defGain || 1} DEF**, and any healing they do is **absorbed**!${_u32dokiTag()}`);
      if (!defender.isAlive) { const h = attacker.heal(10); log.push(`💀 **PvP kill!** ${attacker.name} restored **${h} HP**!`); }
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // ---------- KARMA!SANS ----------
    if (ability.special?.type === 'karmicBones') {
      const sp = ability.special;
      const rush = Math.random() < (sp.rushChance || 0.20);
      const hits = Math.floor(Math.random() * ((sp.maxHits || 6) - (sp.minHits || 3) + 1)) + (sp.minHits || 3);
      let total = 0;
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(attacker, ability, defender);
        const dmg = rush ? Math.floor(d.totalDamage * (sp.rushMult || 1.3)) : d.totalDamage;
        defender.takeDamage(dmg); total += dmg;
        if (!defender.isAlive) break;
      }
      let sm = rush ? ` 💢 **DETERMINATION RUSH!** (${sp.rushMult || 1.3}x)` : '';
      if (attacker._applyStatusFor(defender, 'scaryKR', sp.krDuration || 2)) sm += ` ☯️ **Scary KR** (${sp.krDuration || 2} turns)!`;
      if (Math.random() < (sp.bleedChance || 0.40) && attacker._applyStatusFor(defender, 'bleed', sp.bleedDuration || 2)) sm += ` 🔴 **Bleed!**`;
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! Hit **${hits}** times for **${total}** damage!${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'desperationBlasters') {
      const sp = ability.special;
      const rush = Math.random() < (sp.rushChance || 0.20);
      const d = this.calculateDamage(attacker, ability, defender);
      const dmg = rush ? Math.floor(d.totalDamage * (sp.rushMult || 1.4)) : d.totalDamage;
      defender.takeDamage(dmg);
      let sm = rush ? ` 💢 **DETERMINATION RUSH!** (${sp.rushMult || 1.4}x)` : '';
      if (attacker._applyStatusFor(defender, 'scaryKR', sp.krDuration || 3)) sm += ` ☯️ **Scary KR** (${sp.krDuration || 3} turns)!`;
      if (Math.random() < (sp.statusChance || 0.30)) {
        if (attacker._applyStatusFor(defender, 'karma', sp.statusDuration || 2)) sm += ` ☯️ **Karma!**`;
        if (attacker._applyStatusFor(defender, 'poison', sp.statusDuration || 2)) sm += ` 🟢 **Poison!**`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'goodKarma') {
      const sp = ability.special;
      const amt = Math.floor(Math.random() * ((sp.healMax || 35) - (sp.healMin || 10) + 1)) + (sp.healMin || 10);
      const healed = attacker.heal(amt);
      let sm = `Healed **${healed} HP**!`;
      if ((attacker.currentHp / attacker.maxHp) < (sp.lowHpThreshold || 0.20) && Math.random() < (sp.krChance || 0.50)) {
        if (attacker._applyStatusFor(defender, 'scaryKR', sp.krDuration || 4)) sm += ` ☯️ **Scary KR** applied for ${sp.krDuration || 4} turns!`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! ${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'absoluteRetribution') {
      const sp = ability.special;
      const d = this.calculateDamage(attacker, ability, defender);
      defender.takeDamage(d.totalDamage);
      let sm = '';
      if (attacker._applyStatusFor(defender, 'scaryKR', sp.duration || 3)) sm += ` ☯️ **Scary KR!**`;
      if (attacker._applyStatusFor(defender, 'karma', sp.duration || 3)) sm += ` ☯️ **Karma!**`;
      if (attacker._applyStatusFor(defender, 'poison', sp.duration || 3)) sm += ` 🟢 **Poison!**`;
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // ---------- REBAR!INSANITY (base moveset) ----------
    if (ability.special?.type === 'rebarTopStrike') {
      const n = _u31hits(1); let total = 0;
      for (let i = 0; i < n; i++) { const d = _u31crit(attacker, () => this.calculateDamage(attacker, ability, defender)); defender.takeDamage(d.totalDamage); total += d.totalDamage; if (!defender.isAlive) break; }
      attacker._rebarBlockDoubleTurns = 2;
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! A heavy overhead swing — **${total}** damage! **GUARANTEED CRIT!** 🔩 Block chance doubled!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'rebarSweep') {
      const n = _u31hits(1); let total = 0, sm = '';
      for (let i = 0; i < n; i++) { const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage; if (!defender.isAlive) break; }
      if (Math.random() < (ability.special.stunChance || 0.25) && defender.addStatus('stun')) sm = ' 💫 **Stunned!**';
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${total}** damage!${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'rebarStance') {
      const sp = ability.special;
      if (attacker._rebarStanceTurns > 0) { return { success: false, log: ['Already in a changed stance!'] }; }
      attacker.defMod += (sp.defUp || 3); attacker._rebarStanceDef = (sp.defUp || 3);
      attacker.atkMod -= (sp.atkDown || 6); attacker._rebarStanceAtk = (sp.atkDown || 6);
      attacker._rebarStanceBlockDouble = 1; attacker._rebarStanceTurns = (sp.duration || 5);
      log.push(`**${attacker.name}** shifts into a **defensive stance**! 🛡️ **+${sp.defUp || 3} DEF**, block chance doubled, **-${sp.atkDown || 6} ATK** for ${sp.duration || 5} turns!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'rebarImpale' && !attacker.isReleasing) {
      if (!attacker.isCharging) {
        attacker.isCharging = true; attacker.chargedAbility = abilityIndex; ability.currentUses++;
        log.push(`**${attacker.name}** takes aim with the rebar...`);
        this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
      }
    }
    if (ability.special?.type === 'rebarImpale' && attacker.isReleasing) {
      const d = this.calculateDamage(attacker, ability, defender);
      defender.takeDamage(d.totalDamage);
      let sm = '';
      if (attacker._applyStatusFor(defender, 'bleed', ability.special.bleedDuration || 6)) sm = ` 🔴 **Bleed for ${ability.special.bleedDuration || 6} turns!**`;
      attacker._swapMoveset(true);
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** hurls the rebar clean through **${defender.name}** for **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm} 🔩 *Impale moveset active — the rebar is no longer in hand.*`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // ---------- REBAR!INSANITY (Impale moveset) ----------
    if (ability.special?.type === 'rebarTopStrikeImpale') {
      const n = _u31hits(1); let total = 0, sm = '';
      for (let i = 0; i < n; i++) { const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage; if (!defender.isAlive) break; }
      if (Math.random() < (ability.special.stunChance || 0.20) && defender.addStatus('stun')) sm = ' 💫 **Stunned!**';
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** leaps forward with a **dropkick** ${emoji}! **${total}** damage!${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'rebarSweepImpale') {
      const n = _u31hits(ability.special.hits || 2); let total = 0, stuns = 0;
      for (let i = 0; i < n; i++) {
        const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage;
        if (Math.random() < (ability.special.stunChance || 0.20) && defender.addStatus('stun')) stuns++;
        if (!defender.isAlive) break;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** sweeps their legs and knees them ${emoji}! Hit **${n}** times for **${total}** damage!${stuns ? ' 💫 **Stunned!**' : ''}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'rebarStanceImpale') {
      const sp = ability.special;
      if (attacker._rebarStanceTurns > 0) { return { success: false, log: ['Already in a changed stance!'] }; }
      attacker.atkMod -= (sp.atkDown || 10); attacker._rebarStanceAtk = (sp.atkDown || 10);
      attacker.defMod -= (sp.defDown || 10); attacker._rebarStanceDef = -(sp.defDown || 10);
      attacker._rebarDoubleHits = 1; attacker._rebarStanceTurns = (sp.duration || 5);
      log.push(`**${attacker.name}** drops into a **faster stance**! ⚡ **-${sp.atkDown || 10} ATK**, **-${sp.defDown || 10} DEF**, but every attack hits **twice as many times** for ${sp.duration || 5} turns!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'rebarRetrieve' && !attacker.isReleasing) {
      if (!attacker.isCharging) {
        attacker.isCharging = true; attacker.chargedAbility = abilityIndex; ability.currentUses++;
        attacker._rebarChargeBlock = (ability.special.chargeBlockChance || 0.60);
        log.push(`**${attacker.name}** carefully moves in to retrieve the rebar... 🛡️ *(60% block chance while charging)*`);
        this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
      }
    }
    if (ability.special?.type === 'rebarRetrieve' && attacker.isReleasing) {
      attacker._rebarChargeBlock = 0;
      attacker._swapMoveset(false);
      log.push(`**${attacker.name}** rips the rebar back out and grips it tight! 🔩 *Base moveset restored.*`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // ---------- !REBAR! (base moveset) ----------
    if (ability.special?.type === 'steelBash') {
      const n = _u31hits(1); let total = 0;
      for (let i = 0; i < n; i++) { const d = _u31crit(attacker, () => this.calculateDamage(attacker, ability, defender)); defender.takeDamage(d.totalDamage); total += d.totalDamage; if (!defender.isAlive) break; }
      let sm = '';
      if (attacker._applyStatusFor(defender, 'bleed', ability.special.bleedDuration || 2)) sm = ' 🔴 **Bleed!**';
      attacker._rebarBlockDoubleTurns = 2;
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${total}** damage! **GUARANTEED CRIT!**${sm} 🔩 Block chance doubled!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'gruesomeCombat') {
      const n = _u31hits(1); let total = 0;
      for (let i = 0; i < n; i++) {
        const d = _u31crit(attacker, () => this.calculateDamage(attacker, ability, defender));
        const trueDmg = Math.floor(Math.random() * (ability.damageMax - ability.damageMin + 1)) + ability.damageMin;
        defender.takeDamage(d.totalDamage);
        defender.currentHp = Math.max(0, defender.currentHp - trueDmg);
        total += d.totalDamage + trueDmg;
        if (!defender.isAlive) break;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** spins on their planted arm and kicks with everything ${emoji}! **${total}** damage — **unavoidable critical hit!**`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'bloodthirst') {
      const sp = ability.special;
      if (attacker._bloodthirstActive) { return { success: false, log: ['**BLOODTHIRST** is already active!'] }; }
      attacker._bloodthirstActive = true;
      attacker.atkMod += (sp.atkUp || 15); attacker._bloodthirstAtk = (sp.atkUp || 15);
      attacker.defMod -= (sp.defDown || 15); attacker._bloodthirstDef = (sp.defDown || 15);
      attacker._bloodthirstEndHeal = (sp.endHeal || 75); attacker._bloodthirstEndAtk = (sp.endAtk || 3); attacker._bloodthirstTarget = defender;
      log.push(`**${attacker.name}**: *"THE BEST DEFENSE IS OFFENSE"* 🩸 **+${sp.atkUp || 15} ATK**, **-${sp.defDown || 15} DEF**, all block chance and damage reduction gone until the opponent falls!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'rebarGrab') {
      const sp = ability.special;
      const d = this.calculateDamage(attacker, ability, defender);
      defender.takeDamage(d.totalDamage);
      attacker._grabActive = true;
      attacker._grabHitsRemaining = (sp.hitsToBreak || 6);
      attacker._grabDot = (sp.dotDamage || 5);
      attacker._grabBreakCooldown = (sp.breakCooldown || 5);
      defender._grabDmgReduction = (sp.dmgReduction || 0.20);
      attacker._swapMoveset(true);
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** stabs their arm clean through **${defender.name}** and **GRABS** them ${emoji}! **${d.totalDamage}** damage! They deal **20% less damage**, take **${sp.dotDamage || 5}/turn**, and must land **${sp.hitsToBreak || 6}** hits to break free!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // ---------- !REBAR! (Grab moveset) ----------
    if (ability.special?.type === 'steelBashGrab') {
      const n = _u31hits(1); let total = 0;
      for (let i = 0; i < n; i++) { const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage; if (!defender.isAlive) break; }
      let sm = '';
      if (Math.random() < (ability.special.chance || 0.30)) { attacker._grabHitsRemaining = (attacker._grabHitsRemaining || 0) + 1; sm = ` 🔩 The grab tightens — **${attacker._grabHitsRemaining}** hits now needed to break free!`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** cracks them with a **left hook** ${emoji}! **${total}** damage!${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'gruesomeCombatGrab') {
      const n = _u31hits(ability.special.hits || 3); let total = 0;
      for (let i = 0; i < n; i++) { const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage; if (!defender.isAlive) break; }
      attacker._grabActive = false; defender._grabDmgReduction = 0; attacker._swapMoveset(false);
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** drags them across the floor over **${n}** hits for **${total}** damage ${emoji}! 🔩 *The grab is released.*`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'bloodthirstGrab') {
      const sp = ability.special;
      const fixed = (sp.fixedDamage || 35);
      defender.currentHp = Math.max(0, defender.currentHp - fixed);
      const healed = attacker.heal(sp.heal || 35);
      log.push(`**${attacker.name}** bites down and drinks deep 🩸 **${fixed}** fixed damage, healed **${healed} HP**!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'rebarGrabThrow') {
      const d = this.calculateDamage(attacker, ability, defender);
      defender.takeDamage(d.totalDamage);
      let sm = '';
      if (defender.addStatus('hemorrhage')) sm += ' 🩸 **Hemorrhage!**';
      if (defender.addStatus('stun')) sm += ' 💫 **Stunned for 1 turn!**';
      attacker._grabActive = false; defender._grabDmgReduction = 0; attacker._swapMoveset(false);
      const _g = attacker.abilities.find(a => a.special?.type === 'rebarGrab');
      if (_g) _g.cooldownLeft = (attacker._grabBreakCooldown || 5) + 1;
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** rips them off the rebar arm and slams them into the floor ${emoji}! **${d.totalDamage}** damage!${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // ---------- UNNAMED KINDNESS ----------
    if (ability.special?.type === 'rustyPan') {
      const d = this.calculateDamage(attacker, ability, defender);
      defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.stunChance || 0.20) && defender.addStatus('stun')) sm = ' 💫 **Stunned!**';
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** swings the **Rusty Pan** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'emberToss') {
      const sp = ability.special;
      const d = this.calculateDamage(attacker, ability, defender);
      defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (sp.hellfireChance || 0.40)) { if (defender.addStatus('hellfire')) sm = ' 🔥 **HELLFIRE!**'; }
      else if (attacker._applyStatusFor(defender, 'burn', sp.burnDuration || 3)) sm = ` 🟠 **Burn for ${sp.burnDuration || 3} turns!**`;
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** tosses an ember ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'kindnessBlock') {
      const sp = ability.special;
      attacker._kindnessBlockPct = (sp.blockPercent || 0.80);
      attacker._kindnessBlockReflect = Math.random() < (sp.reflectChance || 0.50);
      log.push(`**${attacker.name}** braces to **Block**! 🛡️ The next hit is reduced by **80%**${attacker._kindnessBlockReflect ? ' — and half of it will be **reflected** with a **stun**!' : '.'}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'retensiveHealing') {
      const sp = ability.special;
      if (this.turnNumber < (sp.minTurn || 20)) { return { success: false, log: [`**${ability.name}** can only be used after turn **${sp.minTurn || 20}**! (currently turn ${this.turnNumber})`] }; }
      if (this[_u31rkey()] > 0) { return { success: false, log: ['**Retensive Healing** is already active!'] }; }
      this[_u31rkey()] = (sp.healPerTurn || 5);
      ability.currentUses = 0;
      log.push(`**${attacker.name}** channels **Retensive Healing**! ✨ Whoever is active heals **${sp.healPerTurn || 5} HP** every turn for the rest of the battle.`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // ---------- PAPYRUS/? ----------
    if (ability.special?.type === 'papQBoneBarrage') {
      const d = this.calculateDamage(attacker, ability, defender);
      defender.takeDamage(d.totalDamage);
      const st = attacker._applyGoop(defender, ability.special.goop || 1, attacker.id);
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} 🫠 **Goop** applied! (**${st}** stacks)`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'papQBlueBones') {
      const d = this.calculateDamage(attacker, ability, defender);
      defender.takeDamage(d.totalDamage);
      defender._papQBlueBoneTrap = (ability.special.goop || 1);
      defender._papQBlueBoneSource = attacker.id;
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** raises **Blue Bones** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} 🔵 If **${defender.name}** attacks, they'll be covered in **Goop**!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'papQBlueSoul' && !attacker.isReleasing) {
      if (!attacker.isCharging) {
        attacker.isCharging = true; attacker.chargedAbility = abilityIndex; ability.currentUses++;
        log.push(`**${attacker.name}**'s eye flickers blue...`);
        this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
      }
    }
    if (ability.special?.type === 'papQBlueSoul' && attacker.isReleasing) {
      const sp = ability.special;
      defender.defMod -= (sp.defDown || 2);
      let sm = `Enemy **-${sp.defDown || 2} DEF**!`;
      if (Math.random() < (sp.goopChance || 0.55)) { const st = attacker._applyGoop(defender, sp.goop || 3, attacker.id); sm += ` 🫠 **${sp.goop || 3} Goop** stacks applied! (**${st}** total)`; }
      log.push(`**${attacker.name}** seizes their **SOUL**! ${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'papQSpecialAttack') {
      const sp = ability.special;
      if (Math.random() < (sp.failChance || 0.45)) {
        attacker.defMod -= (sp.selfDefDown || 2);
        log.push(`**${attacker.name}**'s **Special Attack** falls apart! **-${sp.selfDefDown || 2} DEF**...`);
        this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
      }
      let total = 0, st = 0;
      const hits = _u31hits(sp.hits || 2);
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage;
        st = attacker._applyGoop(defender, sp.goopPerHit || 2, attacker.id);
        if (!defender.isAlive) break;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** lands the **Special Attack** ${emoji}! Hit **${hits}** times for **${total}** damage! 🫠 **Goop** — **${st}** stacks!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // ---------- SIXBONES ----------
    if (ability.special?.type === 'sixBoneThrow') {
      const sp = ability.special;
      const stacks = attacker._goopStacks(defender);
      if (stacks <= 0) {
        log.push(`**${attacker.name}** throws bones... but there's no **Goop** to guide them. Nothing happens.`);
        this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
      }
      let total = 0;
      for (let i = 0; i < stacks; i++) { const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage; if (!defender.isAlive) break; }
      let sm = '';
      const defDrops = Math.floor(stacks / (sp.hitsPer || 6)) * (sp.defDown || 1);
      if (defDrops > 0) { defender.defMod -= defDrops; sm = ` Enemy **-${defDrops} DEF** until S̷I̸X̶B̷O̶N̵E̸S̷ dies!`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! Hit **${stacks}** times (one per Goop stack) for **${total}** damage!${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'sixBlaster') {
      const sp = ability.special;
      const roll = Math.random();
      if (roll < (sp.wildChance || 0.06)) {
        let total = 0, st = 0;
        for (let i = 0; i < 6; i++) { const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage; st = attacker._applyGoop(defender, 1, attacker.id); if (!defender.isAlive) break; }
        defender.addStatus('stun'); attacker.addStatus('stun');
        log.push(`**${attacker.name}**'s blaster does **?̷?̸?̶** — **6** hits for **${total}** damage! 🫠 **${st}** Goop stacks! 💫 **BOTH fighters are stunned!**`);
        this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
      }
      if (roll < (sp.wildChance || 0.06) + (sp.hitChance || 0.46)) {
        const hits = _u31hits(Math.random() < 0.5 ? 2 : 3);
        let total = 0, st = 0;
        for (let i = 0; i < hits; i++) { const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage; st = attacker._applyGoop(defender, 1, attacker.id); if (!defender.isAlive) break; }
        const emoji = TYPES[ability.type]?.emoji || '';
        log.push(`**${attacker.name}**'s blaster fires ${emoji}! **${hits}** hits for **${total}** damage! 🫠 **${st}** Goop stacks!`);
        this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
      }
      attacker.addStatus('stun');
      log.push(`**${attacker.name}**'s blaster **fails** and backfires! 💫 **S̷I̸X̶B̷O̶N̵E̸S̷ is stunned for 1 turn!**`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'sixHelpUs' && !attacker.isReleasing) {
      if (!attacker.isCharging) {
        attacker._sixChargeTurns = (attacker._sixChargeTurns || 0) + 1;
        if (attacker._sixChargeTurns < (ability.special.chargeTurns || 2)) {
          ability.currentUses++;
          log.push(`**${attacker.name}** is gathering them all... *(${attacker._sixChargeTurns}/${ability.special.chargeTurns || 2})*`);
          this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
        }
        attacker.isCharging = true; attacker.chargedAbility = abilityIndex; ability.currentUses++;
        log.push(`**${attacker.name}** is gathering them all... *(${attacker._sixChargeTurns}/${ability.special.chargeTurns || 2})*`);
        this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
      }
    }
    if (ability.special?.type === 'sixHelpUs' && attacker.isReleasing) {
      attacker._sixChargeTurns = 0;
      const defCount = Math.max(0, attacker.def);
      const hits = defCount * 2;
      let total = 0, st = 0, stuns = 0;
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage;
        if (Math.random() < (ability.special.stunChance || 0.05) && defender.addStatus('stun')) stuns++;
        if (!defender.isAlive) break;
      }
      st = attacker._applyGoop(defender, defCount, attacker.id);
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** cries **H̷E̶L̵P̸ ̷U̶S̵** ${emoji}! **${hits}** hits (2 per point of DEF) for **${total}** damage! 🫠 **${st}** Goop stacks!${stuns ? ' 💫 **Stunned!**' : ''}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'sixNoEffect' && !attacker.isReleasing) {
      if (!attacker.isCharging) {
        if (attacker._goopStacks(defender) < (ability.special.requiredGoop || 20)) {
          ability.currentUses++;
          return { success: false, log: [`**${ability.name}** needs at least **${ability.special.requiredGoop || 20}** Goop stacks on the enemy! (currently **${attacker._goopStacks(defender)}**)`] };
        }
        attacker.isCharging = true; attacker.chargedAbility = abilityIndex; ability.currentUses++;
        log.push(`**${attacker.name}** reaches for all of the goop at once...`);
        this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
      }
    }
    if (ability.special?.type === 'sixNoEffect' && attacker.isReleasing) {
      const sp = ability.special;
      if (Math.random() < (sp.failChance || 0.06)) {
        attacker.currentHp = Math.max(0, attacker.currentHp - (sp.failDamage || 666));
        attacker.addStatus('stun');
        const _st = attacker.statusEffects.find(s => s.name === 'Stun'); if (_st) _st.turnsLeft = (sp.failStun || 2);
        log.push(`**${attacker.name}** tries to consume the goop — and it consumes **them** instead! 💀 **${sp.failDamage || 666}** damage and **stunned for ${sp.failStun || 2} turns!**`);
        if (!attacker.isAlive) { return { success: true, log, battleEnd: this.checkEnd() }; }
        this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
      }
      const consumed = attacker._consumeGoop(defender, null);
      const turns = Math.floor(consumed / 6);
      if (turns > 0) {
        const gain = 66 - attacker.def;
        attacker.defMod += gain;
        attacker._sixNoEffectDef = gain;
        attacker._sixNoEffectTurns = turns;
        attacker._sixDefStacks = attacker._sixDefStacks || [];
        attacker._sixDefStacks.push({ amount: gain, turns: turns });
      }
      log.push(`**${attacker.name}** consumes **${consumed}** Goop stacks! 🫠 **DEF set to 66** for **${turns}** turn${turns === 1 ? '' : 's'}!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // ---------- HARDMODE INSANITY ----------
    if (ability.special?.type === 'quietSlam') {
      const sp = ability.special;
      const d = this.calculateDamage(attacker, ability, defender);
      defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (sp.disableChance || 0.10) && defender._lastUsedAbilityIndex != null) {
        const dis = defender.abilities[defender._lastUsedAbilityIndex];
        if (dis) { dis.cooldownLeft = Math.max(dis.cooldownLeft || 0, (sp.disableDuration || 2) + 1); sm = ` 🔇 **${dis.name}** disabled for ${sp.disableDuration || 2} turns!`; }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}**: *"QUIET!"* ${emoji} **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'marrowGrinder') {
      const sp = ability.special;
      const hits = _u31hits(Math.floor(Math.random() * ((sp.maxHits || 6) - (sp.minHits || 2) + 1)) + (sp.minHits || 2));
      let total = 0;
      for (let i = 0; i < hits; i++) { const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage; if (!defender.isAlive) break; }
      let sm = '';
      if (hits >= (sp.hemorrhageThreshold || 6) && defender.addStatus('hemorrhage')) sm = ' 🩸 **Hemorrhage!** (8 dmg/turn until they heal or switch)';
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! Hit **${hits}** times for **${total}** damage!${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'meltingPoint') {
      const sp = ability.special;
      let dmg, ignored = false;
      if (Math.random() < (sp.ignoreChance || 0.25)) {
        ignored = true;
        const base = Math.floor(Math.random() * (ability.damageMax - ability.damageMin + 1)) + ability.damageMin;
        const reducedDef = Math.max(1, Math.floor(defender.def * (1 - (sp.defIgnore || 0.50))));
        dmg = Math.max(COMBAT.MIN_DAMAGE, Math.floor((base * (attacker.atk * getTypeMultiplier(ability.type, defender.type))) / reducedDef));
        defender.takeDamage(dmg);
      } else {
        const d = this.calculateDamage(attacker, ability, defender); dmg = d.totalDamage; defender.takeDamage(dmg);
      }
      attacker.skipNextTurn = true;
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** reaches **Melting Point** ${emoji}! **${dmg}** damage!${ignored ? ' 💧 **Ignored 50% DEF!**' : ''} His body starts to melt — **he must skip his next turn.**`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'justStayDead') {
      const sp = ability.special;
      const d = this.calculateDamage(attacker, ability, defender);
      defender.takeDamage(d.totalDamage);
      let sm = '';
      if (defender.addStatus('stun')) sm += ' 💫 **Stunned!**';
      if (Math.random() < (sp.statusChance || 0.50)) {
        const pick = Math.random() < 0.5 ? 'bleed' : 'blueSoul';
        if (attacker._applyStatusFor(defender, pick, sp.duration || 2)) sm += pick === 'bleed' ? ' 🔴 **Bleed!**' : ' 🔵 **Blue Soul!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}**: *"Just Stay Dead!"* ${emoji} **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // ---------- LAST BREATH P3 ----------
    if (ability.special?.type === 'boneFold') {
      const d = this.calculateDamage(attacker, ability, defender);
      defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.bleedChance || 0.35) && attacker._applyStatusFor(defender, 'bleed', ability.special.bleedDuration || 2)) sm = ' 🔴 **Bleed!**';
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'blasterOverture') {
      const sp = ability.special;
      const hits = _u31hits(Math.floor(Math.random() * ((sp.maxHits || 3) - (sp.minHits || 2) + 1)) + (sp.minHits || 2));
      let total = 0;
      for (let i = 0; i < hits; i++) { const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage; if (!defender.isAlive) break; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${hits}** blasters for **${total}** damage!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'colorOverload') {
      const d = this.calculateDamage(attacker, ability, defender);
      defender.takeDamage(d.totalDamage);
      const pick = ['blueSoul', 'karma', 'electrified'][Math.floor(Math.random() * 3)];
      const label = pick === 'blueSoul' ? '🔵 **Blue Soul!**' : pick === 'karma' ? '☯️ **Karma!**' : '⚡ **Electrified!**';
      const sm = defender.addStatus(pick) ? ' ' + label : '';
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** floods the field with color ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    if (ability.special?.type === 'lastBreathStrike' && !attacker.isReleasing) {
      if (!attacker.isCharging) {
        attacker.isCharging = true; attacker.chargedAbility = abilityIndex; ability.currentUses++;
        log.push(`**${attacker.name}** draws one last breath...`);
        this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
      }
    }
    if (ability.special?.type === 'lastBreathStrike' && attacker.isReleasing) {
      const d = _u31crit(attacker, () => this.calculateDamage(attacker, ability, defender));
      defender.takeDamage(d.totalDamage);
      let sm = '';
      if (attacker._applyStatusFor(defender, 'scaryKR', ability.special.krDuration || 3)) sm = ` ☯️ **Scary KR for ${ability.special.krDuration || 3} turns!**`;
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** unleashes **LAST BREATH** ${emoji}! **${d.totalDamage}** damage — **GUARANTEED CRIT!**${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }
    // ===================== END UPDATE 31 ABILITY HANDLERS (PvP) =====================

    if (ability.special?.type === 'thousandAxeSlashes') {
      const hits = Math.floor(Math.random() * (ability.special.maxHits - ability.special.minHits + 1)) + ability.special.minHits;
      let total = 0, sm = '', bleedApplied = false;
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage;
        if (!bleedApplied && Math.random() < ability.special.bleedChance) { defender.addStatus('bleed'); sm += ' **Bleed!**'; bleedApplied = true; }
      }
      if (hits >= 5) { defender.defMod -= 1; sm += ` All 5 hits! Defender **-1 DEF** permanently!`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! Hit **${hits}** times for **${total}** total damage!${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // BONE CALAMITY (C!Insanity) — battlefield bone shards 3 turns
    if (ability.special?.type === 'boneCalamity') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      defender._boneShardsTurns = ability.special.shardsDuration;
      defender._boneShardsRecoil = ability.special.recoilDamage;
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} 🦴 **Bone Shards** cover the field! Defender takes +${ability.special.recoilDamage} recoil on Melee/Weapon for ${ability.special.shardsDuration} turns!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // BLASTER VOLLEY (C!Insanity) — applies electrified
    if (ability.special?.type === 'blasterVolley') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      defender.addStatus('electrified');
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} **Electrified!**`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // C.H.U.N.G (C!Insanity) — charge, ignore 10% DEF, poison/blindness, +2 ATK perma on PvP kill
    if (ability.special?.type === 'chungBlast' && !attacker.isReleasing) {
      if (!attacker.isCharging) {
        attacker.isCharging = true; attacker.chargedAbility = abilityIndex;
        ability.currentUses++;
        log.push(`**${attacker.name}** stops, summoning a different blaster...`);
        this.postTurn(attacker, defender, log);
        return { success: true, log, battleEnd: this.checkEnd() };
      }
    }
    if (ability.special?.type === 'chungBlast' && attacker.isReleasing) {
      const baseDmg = Math.floor(Math.random() * (ability.damageMax - ability.damageMin + 1)) + ability.damageMin;
      const ignorePct = ability.special.defIgnore || 0.30;
      const reducedDef = Math.floor(defender.def * (1 - ignorePct));
      const typeMult = getTypeMultiplier(ability.type, defender.type);
      const isCrit = Math.random() < (COMBAT.CRIT_CHANCE + (attacker.critBoost || 0));
      const critMult = isCrit ? COMBAT.CRIT_MULTIPLIER : 1;
      const totalDamage = Math.max(COMBAT.MIN_DAMAGE, Math.floor(((baseDmg * (attacker.atk * typeMult)) / Math.max(1, reducedDef)) * critMult));
      defender.takeDamage(totalDamage);
      const status = Math.random() < 0.5 ? 'poison' : 'blindness';
      defender.addStatus(status);
      // Set cooldown on release
      if (ability.special?.cooldown) ability.cooldownLeft = ability.special.cooldown + 1;
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** unleashes **C.H.U.N.G**! Ignores ${Math.round(ignorePct * 100)}% DEF! **${totalDamage}** damage!${isCrit ? ' **CRIT!**' : ''} **${status.charAt(0).toUpperCase() + status.slice(1)}!**`);
      if (!defender.isAlive) { attacker.passiveAtkAccumulated = (attacker.passiveAtkAccumulated || 0) + 2; log.push(`💀 **PvP kill!** ${attacker.name} gains **+2 ATK** permanently!`); }
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // BONE MASSACRE (Final Insanity) — bleed chance
    if (ability.special?.type === 'boneMassacre') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.bleedChance) { defender.addStatus('bleed'); sm = ' **Bleed!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // INSANITY SLASH (Final Insanity) — 30% crit, applies 1-2 INSANITY stacks
    if (ability.special?.type === 'insanitySlash') {
      const baseDmg = Math.floor(Math.random() * (ability.damageMax - ability.damageMin + 1)) + ability.damageMin;
      const typeMult = getTypeMultiplier(ability.type, defender.type);
      const isCrit = Math.random() < ability.special.critChance;
      const critMult = isCrit ? COMBAT.CRIT_MULTIPLIER : 1;
      const totalDamage = Math.max(COMBAT.MIN_DAMAGE, Math.floor(((baseDmg * (attacker.atk * typeMult)) / Math.max(1, defender.def)) * critMult));
      defender.takeDamage(totalDamage);
      const stacksToApply = isCrit ? 2 : 1;
      defender._insanityStacks = (defender._insanityStacks || 0) + stacksToApply;
      this._pvpCheckInsanity(attacker, defender, log);
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${totalDamage}** damage!${isCrit ? ' **CRIT!**' : ''} **${stacksToApply}** [INSANITY] stack(s) applied! (Total: ${defender._insanityStacks})`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // DEVASTATING ROAR (Final Insanity) — block boost/heal/def + 20% flinch
    if (ability.special?.type === 'devastatingRoar') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      defender._roarLockoutTurns = 1;
      let sm = ` Defender can't use boost/defense/healing next turn!`;
      if (Math.random() < ability.special.flinchChance) { defender.addStatus('flinch'); sm += ' **Flinched!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // FINAL C.H.U.N.G (Final Insanity) — consume INSANITY stacks
    if (ability.special?.type === 'finalChung') {
      const stacks = defender._insanityStacks || 0;
      const bonus = stacks * ability.special.perStackDamage;
      const baseDmg = Math.floor(Math.random() * (ability.damageMax - ability.damageMin + 1)) + ability.damageMin;
      const typeMult = getTypeMultiplier(ability.type, defender.type);
      const isCrit = Math.random() < (COMBAT.CRIT_CHANCE + (attacker.critBoost || 0));
      const critMult = isCrit ? COMBAT.CRIT_MULTIPLIER : 1;
      const totalDamage = Math.max(COMBAT.MIN_DAMAGE, Math.floor(((baseDmg * (attacker.atk * typeMult)) / Math.max(1, defender.def)) * critMult)) + bonus;
      defender.takeDamage(totalDamage);
      let sm = stacks > 0 ? ` Consumed **${stacks}** [INSANITY] stack(s) for **+${bonus}** bonus damage!` : '';
      if (stacks >= ability.special.stunThreshold) { defender.addStatus('stun'); sm += ` Defender **STUNNED**!`; }
      defender._insanityStacks = 0;
      // --- UPDATE 18: PvP kill grants +2 ATK permanently ---
      if (!defender.isAlive) { attacker.atkMod += 2; sm += ` 💀 **PvP kill!** +2 ATK permanently!`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** unleashes **Final C.H.U.N.G**! **${totalDamage}** damage!${isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // WEAK OMNIVERSAL CLEAVE (Weak Avenge Sans) — Melee, sets 1.2x next Magic
    if (ability.special?.type === 'weakOmniCleave') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      attacker._magicBoostNext = ability.special.magicBoost;
      // Consume Spite stacks (already added in damage calc)
      if (attacker.passive?.type === 'willToAvenge' && attacker._spiteStacks > 0) attacker._spiteStacks = 0;
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} Next Magic move deals **${ability.special.magicBoost}x** damage!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // WEAK AVENGE BONES (Weak Avenge Sans) — 30% chance -2 enemy ATK 1 turn
    if (ability.special?.type === 'weakAvengeBones') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.atkReduceChance) {
        defender.atkMod -= ability.special.atkReduceAmount;
        defender._tempAtkRevertTurns = ability.special.atkReduceTurns;
        defender._tempAtkRevertAmount = ability.special.atkReduceAmount;
        sm = ` Defender **-${ability.special.atkReduceAmount} ATK** for ${ability.special.atkReduceTurns} turn!`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // WEAK AVENGE BLASTERS (Weak Avenge Sans) — Karma + low HP bonus
    if (ability.special?.type === 'weakAvengeBlasters') {
      const baseDmg = Math.floor(Math.random() * (ability.damageMax - ability.damageMin + 1)) + ability.damageMin;
      const typeMult = getTypeMultiplier(ability.type, defender.type);
      const isCrit = Math.random() < (COMBAT.CRIT_CHANCE + (attacker.critBoost || 0));
      const critMult = isCrit ? COMBAT.CRIT_MULTIPLIER : 1;
      let totalDamage = Math.max(COMBAT.MIN_DAMAGE, Math.floor(((baseDmg * (attacker.atk * typeMult)) / Math.max(1, defender.def)) * critMult));
      let bonusMsg = '';
      if (attacker.currentHp / attacker.maxHp < ability.special.lowHpThreshold) {
        totalDamage += ability.special.lowHpBonus;
        bonusMsg = ` **+${ability.special.lowHpBonus}** low HP bonus!`;
      }
      defender.takeDamage(totalDamage);
      defender.addStatus('karma');
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${totalDamage}** damage!${isCrit ? ' **CRIT!**' : ''} **Karma!**${bonusMsg}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // OMNI DEFLECT (Weak Avenge Sans) — counter stance for next Melee
    if (ability.special?.type === 'omniDeflect') {
      attacker._omniDeflectActive = true;
      attacker._omniDeflectBase = ability.special.counterBase;
      attacker._omniDeflectDefGain = ability.special.defGain;
      log.push(`**${attacker.name}** holds the blade vertically, entering a **Counter Stance**!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // OMNI SWORD DANCE (Avenge Sans) — high crit + 20% +2 ATK
    if (ability.special?.type === 'omniSwordDance') {
      const baseDmg = Math.floor(Math.random() * (ability.damageMax - ability.damageMin + 1)) + ability.damageMin;
      const typeMult = getTypeMultiplier(ability.type, defender.type);
      const isCrit = Math.random() < ability.special.critChance;
      const critMult = isCrit ? COMBAT.CRIT_MULTIPLIER : 1;
      const totalDamage = Math.max(COMBAT.MIN_DAMAGE, Math.floor(((baseDmg * (attacker.atk * typeMult)) / Math.max(1, defender.def)) * critMult));
      defender.takeDamage(totalDamage);
      let sm = '';
      if (Math.random() < ability.special.atkBoostChance) { attacker.atkMod += ability.special.atkBoostAmount; sm = ` **+${ability.special.atkBoostAmount} ATK**!`; }
      // Magic boost from passive
      if (attacker.passive?.type === 'omniversalProdigy' && hasPassiveUnlocked(attacker.level)) {
        attacker._magicDmgBoost = Math.min(attacker.passive.magicBoostCap || 0.25, (attacker._magicDmgBoost || 0) + (attacker.passive.magicBoostPerHit || 0.05));
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${totalDamage}** damage!${isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // AVENGE BLASTERS (Avenge Sans) — 4 hits, Karma, 10% Dazed
    if (ability.special?.type === 'avengeBlasters') {
      let total = 0;
      for (let i = 0; i < ability.special.hits; i++) {
        const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage;
      }
      defender.addStatus('karma');
      let sm = ' **Karma!**';
      if (Math.random() < ability.special.dazedChance) { defender._dazedTurns = ability.special.dazedDuration; sm += ` **Dazed!**`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! Hit **${ability.special.hits}** times for **${total}** total damage!${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // UNIVERSAL CUT (Avenge Sans) — block switch/dodge/TP for 2 turns
    if (ability.special?.type === 'universalCut') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      defender._universalCutTurns = ability.special.restrictDuration;
      if (attacker.passive?.type === 'omniversalProdigy' && hasPassiveUnlocked(attacker.level)) {
        attacker._magicDmgBoost = Math.min(attacker.passive.magicBoostCap || 0.25, (attacker._magicDmgBoost || 0) + (attacker.passive.magicBoostPerHit || 0.05));
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} Defender can't switch/dodge/teleport for **${ability.special.restrictDuration}** turns!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // AVENGE SWORD BEAM (Avenge Sans) — disable random move + magic recoil
    if (ability.special?.type === 'avengeSwordBeam') {
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      const usable = defender.abilities.filter(a => a.currentUses > 0);
      let sm = '';
      if (usable.length > 0) {
        const target = usable[Math.floor(Math.random() * usable.length)];
        target._disabledTurns = ability.special.disableDuration;
        sm = ` Defender's **${target.name}** disabled for ${ability.special.disableDuration} turns!`;
      }
      defender._magicRecoilNext = ability.special.magicRecoil;
      sm += ` If defender uses Magic next turn: **${ability.special.magicRecoil} recoil**!`;
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // ============================================================

    // CALL FOR HELP (Dream Sans) — PvP version
    if (ability.special?.type === 'callForHelp') {
      const { CHARACTERS } = require('./gameData');
      const helpers = ['sans', 'underswap_sans', 'underfell_sans', 'outertale_sans', 'ink_sans'];
      const helperId = helpers[Math.floor(Math.random() * helpers.length)];
      const helperChar = CHARACTERS[helperId];
      if (helperChar && helperChar.abilities.length > 0) {
        const helperAbility = helperChar.abilities[Math.floor(Math.random() * Math.min(2, helperChar.abilities.length))];
        const d = this.calculateDamage(attacker, helperAbility, defender); defender.takeDamage(d.totalDamage);
        log.push(`**${attacker.name}** calls **${helperChar.name}** for help! **${helperAbility.name}** — **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}`);
      } else {
        log.push(`**${attacker.name}** calls for help but no one comes!`);
      }
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // ROSE ASSISTANCE (Rose) — borrows a move from highest C!Insanity on team
    if (ability.special?.type === 'roseAssistance') {
      const { CHARACTERS } = require('./gameData');
      const cinForms = ['final_insanity', 'c_insanity', 'c_insanity_weak'];
      let cinChar = null;
      const myTeam = this.currentTurn === this.player1Id ? this.team1 : this.team2;
      for (const form of cinForms) {
        if (myTeam.some(f => f.id === form)) { cinChar = CHARACTERS[form]; break; }
      }
      if (cinChar && cinChar.abilities.length > 0) {
        const stolen = cinChar.abilities[Math.floor(Math.random() * cinChar.abilities.length)];
        const d = this.calculateDamage(attacker, stolen, defender); defender.takeDamage(d.totalDamage);
        log.push(`**${attacker.name}** borrows **${stolen.name}** from **${cinChar.name}**! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}`);
      } else {
        const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
        log.push(`**${attacker.name}** used **${ability.name}**! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}`);
      }
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // ===== PORTED PVE SPECIALS (188 handlers, mirrored from combat.js) =====
    if (ability.special?.type === 'aggravation') {
      let __pa = null;

      if (this.turnNumber < ability.special.minTurn) {
        __pa = { success: false, message: `**Aggravation** can only be used on turn ${ability.special.minTurn} or later!` };
        ability.currentUses++; ability.cooldownLeft = 0; attacker._usedAbilityThisTurn = false; attacker._attackedThisTurn = false; return { success: false, message: (__pa && __pa.message) || 'Move failed!' };
      }
      attacker._aggravationActive = true;
      attacker._aggravationTurns = ability.special.duration;
      const atkBoost = ability.special.atkBoost || 0;
      if (atkBoost) { attacker.atkMod += atkBoost; attacker._aggravationAtkBoost = atkBoost; }
      __pa = { success: true, message: `**${attacker.name}** used **Aggravation**! Crit chance doubled for ${ability.special.duration} turns${atkBoost ? ` and gained **+${atkBoost} ATK**` : ''}!`, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'ainavolBB') {
      let __pa = null;

      const hits = Math.floor(Math.random() * (ability.special.maxHits - ability.special.minHits + 1)) + ability.special.minHits;
      let total = 0, msg = `**${attacker.name}** used **${ability.name}**!`;
      const statusPool = ['burn', 'electrified', 'karma'];
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage;
        msg += ` Hit ${i+1}: **${d.totalDamage}**${d.isCrit ? ' (CRIT)' : ''}!`;
        if (Math.random() < 0.3) { const s = statusPool[Math.floor(Math.random() * statusPool.length)]; defender.addStatus(s); msg += ` **${s}!**`; }
        if (!defender.isAlive) break;
      }
      msg += ` (${hits} hits, **${total}** total)`;
      __pa = { success: true, message: msg, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'applyRust') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender);
      defender.takeDamage(d.totalDamage);
      let extras = '';
      if (Math.random() < (ability.special.chance || 1.0)) {
        const sr = defender.addStatus('rust');
        if (sr) extras = ' **Rust applied!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'attackReflection') {
      let __pa = null;

      const lastDmg = defender._lastDamageDealt || 0;
      if (lastDmg > 0) {
        defender.takeDamage(lastDmg);
        __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **Attack Reflection**! Reflected **${lastDmg}** damage back at the enemy!`, damage: lastDmg };
      } else {
        __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **Attack Reflection**! ...but there's nothing to reflect!`, damage: 0 };
      }
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'axeThrow') {
      let __pa = null;

      const emoji = TYPES[ability.type]?.emoji || '';
      if (ability.special.cooldown) ability.cooldownLeft = ability.special.cooldown;
      if (Math.random() < ability.special.missChance) {
        attacker.takeDamage(ability.special.selfDamage);
        attacker.addStatus('poison');
        __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** threw the axe... but it came back! **${ability.special.selfDamage}** self-damage + **Poisoned!**`, damage: 0 };
        if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
      }
      const origCrit = attacker.critBoost || 0; attacker.critBoost = origCrit + 0.25;
      const d = this.calculateDamage(attacker, ability, defender); attacker.critBoost = origCrit;
      defender.takeDamage(d.totalDamage);
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}`, damage: d.totalDamage };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'blackholeCollision') {
      let __pa = null;

      const dmg = ability.damageMin || 250;
      defender.takeDamage(dmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** unleashes **BLACKHOLE: COLLISION** ${emoji}! 🕳️ **${dmg}** apocalyptic damage!`, damage: dmg };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'blasterCircle') {
      let __pa = null;

      const minH = ability.special.minHits || 2; const maxH = ability.special.maxHits || 6;
      const hits = Math.floor(Math.random() * (maxH - minH + 1)) + minH;
      let total = 0;
      for (let i = 0; i < hits; i++) {
        if (!defender.isAlive) break;
        const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage;
      }
      let extras = '';
      if (hits >= (ability.special.defReduceThreshold || 4)) {
        defender.defMod = (defender.defMod || 0) - (ability.special.defReduceAmount || 1);
        extras += ` Enemy -${ability.special.defReduceAmount || 1} DEF!`;
      }
      if (Math.random() < (ability.special.poisonChance || 0.5)) { const sr = defender.addStatus('poison'); if (sr) extras += ' **Poisoned!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! ${hits} hits for **${total}** damage!${extras}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'blasterCross') {
      let __pa = null;

      attacker.critBoost = Math.max(0, (ability.special.critChance || 0.30) - COMBAT.CRIT_CHANCE);
      const d = this.calculateDamage(attacker, ability, defender);
      attacker.critBoost = 0;
      let dmg = d.totalDamage; let sm = '';
      if ((defender.currentHp / defender.maxHp) > (ability.special.hpThreshold || 0.70)) { dmg *= 2; sm += ' ✝️ **2x damage** (enemy above 70% HP)!'; }
      const cap = Math.floor(defender.currentHp * (ability.special.hpCap || 0.50));
      if (dmg > cap) { dmg = Math.max(1, cap); sm += ' *(capped at 50% of enemy HP)*'; }
      defender.takeDamage(dmg);
      if (d.isCrit) {
        const sr = defender.addStatus('regret');
        const rg = defender.statusEffects.find(st => st.name === 'Regret');
        if (rg) rg.turnsLeft = ability.special.regretDuration || 3;
        if (sr) sm += ' 😔 **Regret applied (3 turns)!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: dmg };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'blasterFinale') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender);
      defender.takeDamage(d.totalDamage);
      let circleMsg = '';
      if (Math.random() < (ability.special.circleChance || 0.02)) {
        const extra = 20;
        defender.takeDamage(extra);
        circleMsg = ` 💥 **Blaster Circles** dealt **${extra}** bonus damage!`;
      }
      const kr = defender.addStatus('karma'); const k = defender.statusEffects.find(s => s.name === 'Karma'); if (k) k.turnsLeft = ability.special.krDuration || 1;
      const gr = defender.addStatus('glitched'); const g = defender.statusEffects.find(s => s.name === 'Glitched'); if (g) g.turnsLeft = ability.special.glitchedDuration || 1;
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${circleMsg} ☯️ **Karma** + 🔀 **Glitched**!`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'blasterHell') {
      let __pa = null;

      let total = 0;
      for (let i = 0; i < 3; i++) {
        if (!defender.isAlive) break;
        const d = this.calculateDamage(attacker, ability, defender);
        const dmg = Math.floor(d.totalDamage * (attacker._oneLeftBuff === i ? 1.3 : 1)); defender.takeDamage(dmg); total += dmg;
      }
      let sm = '';
      if (Math.random() < (ability.special.defReduceChance || 0.15)) { defender.defMod -= 2; sm += ' **-2 DEF!**'; }
      defender.addStatus('karma'); defender.addStatus('poison'); sm += ' **Karma + Poison!**';
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${total}** total damage!${sm}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'blasterSentry') {
      let __pa = null;

      const dur = Math.floor(Math.random() * ((ability.special.maxDuration || 4) - (ability.special.minDuration || 2) + 1)) + (ability.special.minDuration || 2);
      attacker._blasterSentryTurns = dur; attacker._blasterSentryAbility = { ...ability };
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** summons a **Mini Gaster Blaster**! It will fire for **${dur}** turns!`, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'blindness') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.chance) { defender.addStatus('blindness'); sm = ' **Blindness** applied!'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'blueSoulBoss') {
      let __pa = null;

        attacker.defMod -= ability.special.defReduce;
        let stunMsg = '';
        if (Math.random() < ability.special.stunChance) { attacker.addStatus('stun'); stunMsg = ' **Stunned!**'; }
        return { ability: ability.name, abilityType: ability.type, message: `**${defender.name}** used **${ability.name}**! Your DEF -${ability.special.defReduce}!${stunMsg}`, damage: 0 };
      
    }

    if (ability.special?.type === 'blueSoulControl') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let restrictMsg = '';
      if (Math.random() < (ability.special.restrictChance || 0.5)) {
        defender._blueSoulRestrict = 1;
        restrictMsg = ' Enemy restricted to first 2 moves next turn!';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${restrictMsg}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'boatCruise') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender);
      let dmg = d.totalDamage; let sm = '';
      if (attacker._swordfishTriggered) { dmg = Math.floor(dmg * (ability.special.bonusMult || 1.3)); sm = ' 🚢 **Swordfish Counter bonus — 1.3x damage!**'; }
      defender.takeDamage(dmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: dmg };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'boneAnchor') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.blueSoulChance || 0.50)) {
        defender.addStatus('blueSoul');
        const bs = defender.statusEffects.find(st => st.name === 'Blue Soul'); if (bs) bs.turnsLeft = ability.special.blueSoulDuration || 2;
        defender._oceanMeleeVuln = true;
        sm = ' 💙 **Blue Soul!** (2 turns) — Melee attacks now deal 1.2x to the enemy!';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'boneCarrousel') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      if (!defender.statusEffects.find(s => s.id === 'boneCarrousel')) {
        const dur = Math.floor(Math.random() * 3) + 1;
        defender.statusEffects.push({ id: 'boneCarrousel', name: 'Bone Carrousel', emoji: '🦴', damagePerTurn: 0, _minDmg: 5, _maxDmg: 10, turnsLeft: dur });
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage! Enemy takes 5-10 dmg at turn start for 1-3 turns!${d.isCrit ? ' **CRIT!**' : ''}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'boneGrenade') {
      let __pa = null;

      let abilityCopy = { ...ability };
      let defIgnored = false;
      var dGren;
      if (Math.random() < (ability.special.defIgnoreChance || 0.3)) {
        // Lower enemy DEF temporarily for this calc via defMod
        const reduction = Math.ceil(defender.def * (ability.special.defIgnoreAmount || 0.1));
        defender.defMod -= reduction;
        dGren = this.calculateDamage(attacker, abilityCopy, defender);
        defender.defMod += reduction;
        defIgnored = true;
      } else {
        dGren = this.calculateDamage(attacker, abilityCopy, defender);
      }
      defender.takeDamage(dGren.totalDamage);
      let flinchMsg = '';
      if (Math.random() < (ability.special.flinchChance || 0.25)) { const sr = defender.addStatus('flinch'); if (sr) flinchMsg = ' **Flinched!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${dGren.totalDamage}** damage!${dGren.isCrit ? ' **CRIT!**' : ''}${defIgnored ? ' *(Ignored 10% DEF!)*' : ''}${flinchMsg}`, damage: dGren.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'bonePiercing') {
      let __pa = null;

      let total = 0;
      for (let i = 0; i < 4; i++) { if (!defender.isAlive) break; const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage; }
      defender.addStatus('bleed');
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! 4 hits for **${total}** total damage! **Bleed!**`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'boneRavage') {
      let __pa = null;

      const psycho = !!attacker._psychoMode;
      const hits = psycho ? ability.special.psychoHits : ability.special.normalHits;
      let total = 0;
      for (let i = 0; i < hits; i++) { const { d } = this._psychoDmg(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage; if (!defender.isAlive) break; }
      let sm = '';
      if (psycho) { const s = defender.addStatus('schizo'); const so = defender.statusEffects.find(st => st.name === 'Schizo'); if (so) so.turnsLeft = ability.special.schizoDuration; if (s) sm += ' 🌀 **Schizo!**'; }
      else { const s = defender.addStatus('karma'); const ka = defender.statusEffects.find(st => st.name === 'Karma'); if (ka) ka.turnsLeft = ability.special.karmaDuration; if (s) sm += ' ☯️ **Karma!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}!${psycho ? ' *(Psycho Mode)*' : ''} ${hits} hits for **${total}** total!${sm}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'boneShifter') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      // Mark to apply bonus on enemy if they use Melee/Unique this turn (handled in enemy turn)
      defender._boneShifterTrap = ability.special.tripDamage || 10;
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} Bones laid as a trap!`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'boneStorm') {
      let __pa = null;

      const minH = ability.special.minHits || 5; const maxH = ability.special.maxHits || 10;
      const hits = Math.floor(Math.random() * (maxH - minH + 1)) + minH;
      let total = 0; let blindApplied = false;
      for (let i = 0; i < hits; i++) {
        if (!defender.isAlive) break;
        const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage;
        if (!blindApplied && Math.random() < (ability.special.blindPerHit || 0.05)) { const sr = defender.addStatus('blindness'); if (sr) blindApplied = true; }
      }
      this.applySmokeScreenPassive(attacker, defender);
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! ${hits} hits for **${total}** damage!${blindApplied ? ' **Blinded!**' : ''}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'boneSurge') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let bonus = 0; let bonusMsg = '';
      if (defender._lastUsedDamaging) {
        bonus = ability.special.bonusVsAttack || 10;
        defender.takeDamage(bonus);
        bonusMsg = ` Blue bones added **+${bonus}** damage!`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage + bonus}** damage!${d.isCrit ? ' **CRIT!**' : ''}${bonusMsg}`, damage: d.totalDamage + bonus };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'boneSweep') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      defender._enemyDamageReduce = (defender._enemyDamageReduce || 0) + (ability.special.damageReduce || 5);
      defender._enemyDamageReduceTurns = Math.max(defender._enemyDamageReduceTurns || 0, 1);
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} Enemy's next attack -5 dmg!`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'boneVolley') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      if (!defender._boneVolleyTurns) defender._boneVolleyTurns = 0;
      defender._boneVolleyTurns = ability.special.duration;
      defender._boneVolleyDmg = Math.floor(d.totalDamage * 0.3);
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage! Bones latched on — will explode for ${defender._boneVolleyDmg} dmg each turn for ${ability.special.duration} turns!`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'boneWave') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let extras = '';
      const hazyStacks = defender._hazyStacks || 0;
      if (hazyStacks > 0 && Math.random() < (ability.special.hazyBleedChance || 0.25)) {
        const sr = defender.addStatus('bleed'); if (sr) extras = ' **Bleed!** (Hazy bonus)';
      }
      // Smoke Screen passive trigger
      this.applySmokeScreenPassive(attacker, defender);
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'bonesOfDesperation') {
      let __pa = null;

      if (!attacker._bodBonus) attacker._bodBonus = 0;
      const boostedAbility = { ...ability, damageMin: ability.damageMin + Math.floor(attacker._bodBonus), damageMax: ability.damageMax + Math.floor(attacker._bodBonus) };
      const d = this.calculateDamage(attacker, boostedAbility, defender); defender.takeDamage(d.totalDamage);
      attacker._bodBonus += 3;
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} (Bonus DMG: +${Math.floor(attacker._bodBonus - 3)})`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'bribery') {
      let __pa = null;

      const dmg = Math.floor(Math.random() * (ability.damageMax - ability.damageMin + 1)) + ability.damageMin;
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let bonusMsg = '';
      const versusBoss = false === true;
      if (versusBoss && (this.turnNumber || 0) >= 3 && Math.random() < (ability.special.healChance || 0.2)) {
        const heal = Math.floor((attacker.maxHp || attacker.hp) * (ability.special.healPercent || 0.1));
        attacker.hp = Math.min(attacker.maxHp || attacker.hp, attacker.hp + heal);
        bonusMsg = ` Sans pocketed the bribe and healed **${heal} HP**!`;
      } else if (Math.random() < 0.5) {
        defender._accuracyDebuff = Math.max(defender._accuracyDebuff || 0, ability.special.accuracyDebuff || 0.3);
        defender._accuracyDebuffTurns = ability.special.debuffDuration || 2;
        bonusMsg = ` Enemy accuracy -30% for ${ability.special.debuffDuration || 2} turns!`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${bonusMsg}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'bulletHell') {
      let __pa = null;

      if (attacker._bullets === undefined) attacker._bullets = 6;
      if (this.turnNumber < (ability.special.minTurn || 4)) { ability.currentUses++; this.turnNumber--; attacker.turnCount--; __pa = { success: false, message: `**Bullet Hell** can only be used after turn ${ability.special.minTurn || 4}!` }; return { success: false, message: (__pa && __pa.message) || 'Move failed!' }; }
      const bullets = attacker._bullets || 0;
      if (bullets < (ability.special.minBullets || 3)) { ability.currentUses++; this.turnNumber--; attacker.turnCount--; __pa = { success: false, message: `**Bullet Hell** needs at least ${ability.special.minBullets || 3} bullets! (Current: ${bullets})` }; return { success: false, message: (__pa && __pa.message) || 'Move failed!' }; }
      const extraBullets = bullets - (ability.special.minBullets || 3);
      const bonus = extraBullets * (ability.special.bonusPerBullet || 5);
      const d = this.calculateDamage(attacker, ability, defender); const total = d.totalDamage + bonus;
      defender.takeDamage(total); attacker._bullets = 0; attacker._reloadingExtended = true;
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** unleashes **Bullet Hell**! Used all ${bullets} bullets! **${total}** damage! (+${bonus} bonus) ⚠️ Reload takes longer!`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'captureBone') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.pullChance) { defender._forceMeleeNext = true; sm = ' Enemy is **pulled** — must use Melee next or take extra damage!'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'carBattery') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      defender.addStatus('electrified');
      let sm = ' **Electrified!**';
      if (Math.random() < ability.special.stunChance) { defender.addStatus('stun'); sm += ' **Stunned!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'chainStrangle') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let extras = '';
      if (Math.random() < (ability.special.defDebuffChance || 0.15)) { defender.defMod = (defender.defMod || 0) - (ability.special.defDebuffAmount || 2); extras += ` -${ability.special.defDebuffAmount || 2} enemy DEF!`; }
      if (Math.random() < (ability.special.stunChance || 0.25)) { const sr = defender.addStatus('stun'); if (sr) extras += ' **Stunned!**'; }
      this.applyMadnessStack(attacker, 1);
      attacker._lastUsedChainStrangle = true;
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'chainedBlaster') {
      let __pa = null;

      if (defender.passive?.type === 'starDust') {
        // UPDATE 19 NERF: StarDust blocks extra hits but attacker still deals 1 hit
        { const d = this.calculateDamage(attacker, ability, defender); const dr = defender.takeDamage(d.totalDamage);
          this.applyFearOfDeath(attacker, defender);
          __pa = { success: true, message: `**${attacker.name}** used **${ability.name}**! ✨ **StarDust** blocks the extra hits — **${d.totalDamage}** damage (1 hit only)${d.isCrit ? ' (CRIT)' : ''}!`, damage: d.totalDamage }; }
        if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
        if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
      }
      let total = 0, msg = `**${attacker.name}** used **${ability.name}**!`;
      let poisoned = false, stunned = false;
      for (let i = 0; i < 2; i++) {
        const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage;
        msg += ` Hit ${i+1}: **${d.totalDamage}**${d.isCrit ? ' (CRIT)' : ''}!`;
        if (!poisoned) { const sr = defender.addStatus('poison'); if (sr) { msg += ' **Poisoned!**'; poisoned = true; } }
        if (!stunned && Math.random() < (ability.special.stunChance || 0.15)) { const sr = defender.addStatus('stun'); if (sr) { msg += ' **Stunned!**'; stunned = true; } }
        if (!defender.isAlive) break;
      }
      msg += ` (**${total}** total)`;
      __pa = { success: true, message: msg, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'chainedBones') {
      let __pa = null;

      if (defender.passive?.type === 'starDust') {
        // UPDATE 19 NERF: StarDust blocks extra hits but attacker still deals 1 hit
        { const d = this.calculateDamage(attacker, ability, defender); const dr = defender.takeDamage(d.totalDamage);
          this.applyFearOfDeath(attacker, defender);
          __pa = { success: true, message: `**${attacker.name}** used **${ability.name}**! ✨ **StarDust** blocks the extra hits — **${d.totalDamage}** damage (1 hit only)${d.isCrit ? ' (CRIT)' : ''}!`, damage: d.totalDamage }; }
        if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
        if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
      }
      const hits = Math.floor(Math.random() * (ability.special.maxHits - ability.special.minHits + 1)) + ability.special.minHits;
      let total = 0, msg = `**${attacker.name}** used **${ability.name}**!`;
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage;
        msg += ` Hit ${i+1}: **${d.totalDamage}**${d.isCrit ? ' (CRIT)' : ''}!`;
        if (!defender.isAlive) break;
      }
      const bleedSr = defender.addStatus('bleed'); if (bleedSr) msg += ' **Bleed!**';
      msg += ` (${hits} hits, **${total}** total)`;
      __pa = { success: true, message: msg, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'chaosBusters') {
      let __pa = null;

      const hits = ability.special.hits || 2;
      let total = 0;
      for (let i = 0; i < hits; i++) {
        if (!defender.isAlive) break;
        const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage;
      }
      let extras = '';
      if (Math.random() < (ability.special.poisonChance || 0.15)) { const sr = defender.addStatus('poison'); if (sr) extras += ' **Poisoned!**'; }
      if (Math.random() < (ability.special.flinchChance || 0.10)) { const sr = defender.addStatus('flinch'); if (sr) extras += ' **Flinched!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! ${hits} hits for **${total}** damage!${extras}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'chargeInf') {
      let __pa = null;

      attacker._chargedActive = true;
      attacker._chargedGooDmg = ability.special.chargedGooDmg || 60;
      attacker._chargedKnifeHitsMin = ability.special.chargedKnifeHits?.min || 4;
      attacker._chargedKnifeHitsMax = ability.special.chargedKnifeHits?.max || 5;
      attacker._chargedKnifeDmg = ability.special.chargedKnifeDmg || 15;
      attacker._chargedBleedDuration = ability.special.chargedBleedDuration || 3;
      __pa = { success: true, message: `**${attacker.name}** used **${ability.name}**! ⚡ **CHARGED!** Next Knife Combo or Goo Blaster will be empowered!`, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'chargedBlaster') {
      let __pa = null;

      if (Math.random() < ability.special.backfireChance) {
        const selfD = this.calculateDamage(attacker, ability, attacker); attacker.takeDamage(selfD.totalDamage);
        __pa = { success: true, message: `**${attacker.name}** used **${ability.name}**... but it **backfired**! **${selfD.totalDamage}** self-damage!`, damage: 0 };
        if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
      }
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.electrifiedChance) { defender.addStatus('electrified'); sm = ' **Electrified!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'coffeeChug') {
      let __pa = null;

      const healed = attacker.heal(ability.special.healAmount || 20);
      let sm = `Healed **${healed} HP**!`;
      if (Math.random() < (ability.special.dodgeChance || 0.15)) { attacker._dodgeNext = true; sm += ' Gained a **dodge** for the next hit!'; }
      ability.cooldownLeft = ability.special.cooldown || 1;
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **Coffee Chug**! ☕ ${sm}`, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'comicallyLargeBlunt') {
      let __pa = null;

      const tension = attacker.statusEffects.find(s => s.name === 'Tension Point');
      const stacks = tension?.stacks || 0;
      if (stacks < 2) {
        ability.currentUses++;
        __pa = { success: false, message: `**Comically Large Blunt** requires 2 Tension Points! (Currently: ${stacks})`, damage: 0 };
        if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
      }
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      // Consume 2 tension
      tension.stacks = stacks - 2;
      if (tension.stacks <= 0) attacker.statusEffects = attacker.statusEffects.filter(s => s.name !== 'Tension Point');
      // Apply Relaxed
      const sr = attacker.addStatus('relaxed');
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage! **Relaxed for 2 turns!** (Consumed 2 Tension Points)`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'concentratedPipeBlast') {
      let __pa = null;

      const dmg = ability.damageMin || 200;
      defender.takeDamage(dmg);
      defender.addStatus('rust');
      // --- UPDATE 22: char version Rust lasts 1-2 turns (random) ---
      if (ability.special.rustDurationMin) {
        const rust = defender.statusEffects.find(st => st.name === 'Rust');
        if (rust) rust.turnsLeft = Math.floor(Math.random() * ((ability.special.rustDurationMax || 2) - ability.special.rustDurationMin + 1)) + ability.special.rustDurationMin;
      }
      let selfDmg = ability.special.selfDamage || 200;
      // --- UPDATE 22: -15 self damage per duplicate Pesti on the team ---
      if (ability.special.duplicateReduction) {
        const dupes = ((this.currentTurn === this.player1Id ? this.team1 : this.team2) || []).filter(f => f.id === attacker.id).length - 1;
        if (dupes > 0) selfDmg = Math.max(0, selfDmg - dupes * ability.special.duplicateReduction);
      }
      attacker.currentHp = Math.max(0, attacker.currentHp - selfDmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${dmg}** fixed damage! **Rust applied!** ⚠️ ${attacker.name} takes **${selfDmg}** damage from the blast!`, damage: dmg };
      if (attacker.currentHp <= 0) {
        if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
        if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
      }
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'cruelBlasters') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let extras = '';
      if (Math.random() < (ability.special.atkDebuffChance || 0.25)) { defender.atkMod = (defender.atkMod || 0) - (ability.special.atkDebuffAmount || 2); extras += ` -${ability.special.atkDebuffAmount || 2} enemy ATK!`; }
      const lowHp = (defender.hp / (defender.maxHp || defender.hp)) < (ability.special.lowHpThreshold || 0.5);
      if (lowHp) { this.applyMadnessStack(attacker, 2); defender.defMod = (defender.defMod || 0) - 1; extras += ' Low HP — +1 extra Madness, -1 enemy DEF!'; }
      else { this.applyMadnessStack(attacker, 1); }
      attacker._lastUsedChainStrangle = false;
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'crystalImpale') {
      let __pa = null;

      const hits = Math.floor(Math.random() * (ability.special.maxHits - ability.special.minHits + 1)) + ability.special.minHits;
      let total = 0, applied = false;
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage;
        if (Math.random() < ability.special.crystallizeChance) { this._applyCrystallize(defender, d.totalDamage, ability.special.crystallizeDuration); applied = true; }
        if (!defender.isAlive) break;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! ${hits} hits for **${total}**!${applied ? ' 💎 **Crystallize!**' : ''}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'crystalShapedBomb') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      defender._crystalBomb = { explode: ability.special.explodeDamage, splash: ability.special.splashDamage };
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage! A crystal ball is primed — if the enemy attacks next turn, it explodes for ${ability.special.explodeDamage}!`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'darknessSanctuary') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      attacker.defMod += ability.special.defBuff; attacker._sanctuaryTurns = ability.special.duration; attacker._statusImmune = true;
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage! Sanctuary active (3 turns: +3 DEF, status immune, +1.1x Melee).`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'deathBlaster') {
      let __pa = null;

      if (attacker._deathBlasterUsedLastTurn) {
        __pa = { success: false, message: '**Death Blaster** cannot be used twice in a row!' };
        ability.currentUses++; return { success: false, message: (__pa && __pa.message) || 'Move failed!' };
      }
      const d = this.calculateDamage(attacker, ability, defender);
      defender.takeDamage(d.totalDamage);
      this.applyFearOfDeath(attacker, defender);
      let extras = '';
      if ((defender._deathTouchStacks || 0) >= (ability.special.stackThreshold || 3)) {
        defender.addStatus('stun'); extras += ' **STUNNED!**';
        defender.addStatus('poison'); extras += ' **Poisoned!**';
      }
      attacker._deathBlasterUsedLastTurn = true;
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'deathTornado') {
      let __pa = null;

      const hits = Math.floor(Math.random() * (ability.special.maxHits - ability.special.minHits + 1)) + ability.special.minHits;
      const full = this.calculateDamage(attacker, ability, defender);
      const per = Math.max(1, Math.floor(full.totalDamage / hits));
      let total = 0;
      for (let i = 0; i < hits; i++) { defender.takeDamage(per); total += per; if (!defender.isAlive) break; }
      let sm = '';
      const low = (attacker.currentHp / attacker.maxHp) < 0.50;
      if (low && defender.isAlive) { defender.addStatus('stun'); sm += ' **Stun!**'; }
      if (defender.isAlive) { defender.addStatus('hemorrhage'); sm += ' 🩸 **Hemorrhage!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! ${hits} hits for **${total}**!${sm}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'defenseCurl') {
      attacker.atkMod = (attacker.atkMod || 0) - 1;
      attacker.defenseCurlActive = true;
      attacker._defenseCurlBlockThreshold = ability.special.blockThreshold;
      attacker._defenseCurlDefGain = ability.special.defGain;
      log.push(`**${attacker.name}** curls into defense! ATK -1. Blocks the next hit over ${ability.special.blockThreshold} dmg.`);
      this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    }

    if (ability.special?.type === 'devastatingHate') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.procChance) {
        if (Math.random() < 0.5) { defender.addStatus('blindness'); const bl = defender.statusEffects.find(st => st.name === 'Blindness'); if (bl) bl.turnsLeft = ability.special.blindnessDuration; sm = ' 👁️ **Blindness (3t)!**'; }
        else { defender.addStatus('hate'); const ha = defender.statusEffects.find(st => st.name === 'Hate'); if (ha) { ha.turnsLeft = ability.special.hateDuration; ha._caster = attacker.name; } sm = ' 🖤 **Hate (2t)!**'; }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'domainExpansion') {
      let __pa = null;

      const enemyStun = ability.special.stunDuration || 5;
      const selfStun = ability.special.selfStunDuration || 5;
      // --- UPDATE 20 BUG FIX: use a multi-turn stun counter instead of single stun status (which got consumed in 1 turn) ---
      defender._domainStunTurns = enemyStun;
      attacker._domainSelfStunQueued = selfStun;
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** invokes **Domain Expansion: COSMIC** ${emoji}! **${defender.name}** is **STUNNED for ${enemyStun} turns**! ⚠️ When it ends, ${attacker.name} will be stunned for ${selfStun} turns!`, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'duoBlasters') {
      let __pa = null;

      let total = 0, msg = `**${attacker.name}** used **${ability.name}**!`, karmaApplied = false;
      for (let i = 0; i < 2; i++) {
        const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage;
        msg += ` Hit ${i+1}: **${d.totalDamage}**${d.isCrit ? ' (CRIT)' : ''}!`;
        if (!defender.isAlive) break;
      }
      if (!karmaApplied && Math.random() < ability.special.karmaChance) { defender.addStatus('karma'); msg += ' **Karma** applied!'; }
      __pa = { success: true, message: msg, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'dustyBonk') {
      let __pa = null;

      let abilityCopy = { ...ability };
      let bleedFlag = false;
      if (attacker._lastUsedChainStrangle) {
        abilityCopy.damageMin = ability.damageMin + (ability.special.comboBonus || 10);
        abilityCopy.damageMax = ability.damageMax + (ability.special.comboBonus || 10);
        bleedFlag = true;
      }
      const d = this.calculateDamage(attacker, abilityCopy, defender); defender.takeDamage(d.totalDamage);
      let extras = '';
      if (Math.random() < (ability.special.flinchChance || 0.25)) { const sr = defender.addStatus('flinch'); if (sr) extras += ' **Flinched!**'; }
      if (bleedFlag) { const sr = defender.addStatus('bleed'); if (sr) extras += ' **Bleed combo!**'; }
      this.applyMadnessStack(attacker, 1);
      attacker._lastUsedChainStrangle = false;
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}${bleedFlag ? ' (+10 combo!)' : ''}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'dustyDetermination') {
      let __pa = null;

      let msg = '';
      if (Math.random() < 0.5) {
        attacker._dustyDetBoost = ability.special.damageBoost || 1.3;
        attacker._dustyDetBoostTurns = ability.special.boostDuration || 3;
        msg = `🔥 **${(ability.special.damageBoost || 1.3) * 100 - 100}% damage boost** for ${ability.special.boostDuration || 3} turns!`;
      } else {
        const dodges = Math.floor(Math.random() * ((ability.special.dodgeMax || 4) - (ability.special.dodgeMin || 2) + 1)) + (ability.special.dodgeMin || 2);
        attacker._dustyDetDodges = (attacker._dustyDetDodges || 0) + dodges;
        msg = `🌀 **${dodges} dodge${dodges > 1 ? 's' : ''}** stored!`;
      }
      __pa = { success: true, message: `**${attacker.name}** used **${ability.name}**! ${msg}`, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'echoingBlasters') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender);
      let echoBonus = 0;
      let echoMsg = '';
      if (attacker._heavyRainActive) {
        echoBonus = ability.special.echoDamage || 15;
        echoMsg = ` 🌧️ **Heavy Rain echo: +${echoBonus} damage!**`;
      }
      const totalDmg = d.totalDamage + echoBonus;
      defender.takeDamage(totalDmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${totalDmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${echoMsg}`, damage: totalDmg };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'errorReset') {
      let __pa = null;

      if (this.turnNumber < ability.special.minTurn) {
        __pa = { success: false, message: `**${ability.name}** can only be used after turn ${ability.special.minTurn}!` };
        ability.currentUses++; ability.cooldownLeft = 0; attacker._usedAbilityThisTurn = false; attacker._attackedThisTurn = false; return { success: false, message: (__pa && __pa.message) || 'Move failed!' };
      }
      attacker.atkMod = 0; attacker.defMod = 0;
      if (attacker._tempDebuffs) attacker._tempDebuffs = [];
      attacker.statusEffects = [];
      __pa = { success: true, message: `**${attacker.name}** screams — all debuffs cleared and stats reset!`, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'fftboBoneliest') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender);
      defender.takeDamage(d.totalDamage);
      const bl = defender.addStatus('blindness');
      const blS = defender.statusEffects.find(s => s.name === 'Blindness'); if (blS) blS.turnsLeft = ability.special.blindDuration || 2;
      const br = defender.addStatus('bleed');
      const bleed = defender.statusEffects.find(s => s.name === 'Bleed'); if (bleed) bleed.turnsLeft = ability.special.bleedDuration || 2;
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `💀 **${attacker.name}** turns into **BONELIEST.** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} **Blindness + Bleed!**`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'fftboCooked') {
      let __pa = null;

      const hits = ability.special.hits || 5;
      let total = 0; let isCrit = false;
      for (let i = 0; i < hits; i++) { const d = this.calculateDamage(attacker, ability, defender); total += d.totalDamage; if (d.isCrit) isCrit = true; }
      defender.takeDamage(total);
      const kr = defender.addStatus('karma');
      const k = defender.statusEffects.find(s => s.name === 'Karma'); if (k) k.turnsLeft = ability.special.krDuration || 2;
      const br = defender.addStatus('bleed');
      const bleed = defender.statusEffects.find(s => s.name === 'Bleed'); if (bleed) bleed.turnsLeft = ability.special.bleedDuration || 2;
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${hits} hits**, **${total}** total damage!${isCrit ? ' **CRIT!**' : ''} **Karma + Bleed!**`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'fftboTheirSins') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender);
      let finalDmg = d.totalDamage;
      let extras = '';
      if (Math.random() < (ability.special.slamTwiceChance || 0.2)) {
        const d2 = this.calculateDamage(attacker, ability, defender);
        finalDmg += d2.totalDamage;
        const sr = defender.addStatus('stun');
        if (sr) extras += ' 🦴 **Slam twice + Blue Bone Zone Stun!**';
      }
      defender.takeDamage(finalDmg);
      const br = defender.addStatus('bleed');
      const bleed = defender.statusEffects.find(s => s.name === 'Bleed');
      if (bleed) bleed.turnsLeft = ability.special.bleedDuration || 2;
      if (br) extras += ' **Bleed!**';
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${finalDmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: finalDmg };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'finalExecution') {
      let __pa = null;

      const required = ability.special.requiredStacks || 7;
      if ((attacker._madnessStacks || 0) < required) {
        __pa = { success: false, message: `**${ability.name}** requires ${required}+ Madness stacks! You have ${attacker._madnessStacks || 0}.` };
        return { success: false, message: (__pa && __pa.message) || 'Move failed!' };
      }
      let abilityCopy = { ...ability };
      const lowHp = (defender.hp / (defender.maxHp || defender.hp)) < (ability.special.lowHpThreshold || 0.35);
      if (lowHp) { abilityCopy.damageMin = Math.floor(ability.damageMin * (ability.special.lowHpMultiplier || 2.0)); abilityCopy.damageMax = Math.floor(ability.damageMax * (ability.special.lowHpMultiplier || 2.0)); }
      const d = this.calculateDamage(attacker, abilityCopy, defender); defender.takeDamage(d.totalDamage);
      let killMsg = '';
      if (!defender.isAlive) {
        const heal = Math.floor((attacker.maxHp || attacker.hp) * (ability.special.healOnKillPercent || 0.5));
        attacker.hp = Math.min(attacker.maxHp || attacker.hp, attacker.hp + heal);
        killMsg = ` Restored **${heal} HP** for the kill!`;
      }
      // Reset stats
      attacker._madnessStacks = 0;
      attacker.atkMod = 0; attacker.defMod = 0;
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${lowHp ? ' *(2x for low HP!)*' : ''}${killMsg} Stats reset!`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'finalGambit') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let gambitMsg = '';
      const hpRatio = defender.hp / (defender.maxHp || defender.hp);
      if (hpRatio < (ability.special.hpThreshold || 0.25) && defender.isAlive) {
        defender._finalGambitForcedSkip = 1;
        gambitMsg = ' Enemy is forced to skip attack next turn!';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${gambitMsg}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'flameEyeBurn') {
      let __pa = null;

      const hits = ability.special.hits || 1; let total = 0; let isCrit = false;
      for (let i = 0; i < hits; i++) { const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage; if (d.isCrit) isCrit = true; if (!defender.isAlive) break; }
      let burnMsg = '';
      if (Math.random() < (ability.special.hellfireChance || 0)) { const sr = defender.addStatus('hellfire'); if (sr) burnMsg = ' **HELLFIRE applied!**'; }
      else { const sr = defender.addStatus('burn'); if (sr) burnMsg = ' **Burn applied!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      const hitMsg = hits > 1 ? ` ${hits} hits, **${total}** total!` : '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}!${hitMsg}${hits === 1 ? ` **${total}** damage!` : ''}${isCrit ? ' **CRIT!**' : ''}${burnMsg}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'flameEyeRoar') {
      let __pa = null;

      if (!attacker._flameEyeRoarCharging) {
        attacker._flameEyeRoarCharging = true;
        if (ability.special.selfDebuff?.atk) attacker.atkMod += ability.special.selfDebuff.atk;
        if (ability.special.selfDebuff?.def) attacker.defMod += ability.special.selfDebuff.def;
        attacker._flameEyeRoarDebuff = { ...ability.special.selfDebuff };
        __pa = { success: true, message: `**${attacker.name}** ${ability.special.chargeMessage || 'is charging...'}`, damage: 0 };
        if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
      }
      const bypass = ability.special.defBypass || 0;
      const reduction = Math.floor(defender.def * bypass); defender.defMod -= reduction;
      const d = this.calculateDamage(attacker, ability, defender); defender.defMod += reduction; defender.takeDamage(d.totalDamage);
      if (attacker._flameEyeRoarDebuff) { if (attacker._flameEyeRoarDebuff.atk) attacker.atkMod -= attacker._flameEyeRoarDebuff.atk; if (attacker._flameEyeRoarDebuff.def) attacker.defMod -= attacker._flameEyeRoarDebuff.def; attacker._flameEyeRoarDebuff = null; }
      attacker._flameEyeRoarCharging = false;
      const sr = defender.addStatus('blindness'); let blindMsg = sr ? ` **Blinded** for ${ability.special.blindnessDuration || 4} turns!` : '';
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** unleashes **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} *(${Math.round(bypass * 100)}% DEF bypassed!)*${blindMsg}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'flashbacks') {
      let __pa = null;

      const r = Math.random();
      if (r < 0.5) {
        // Attack Reflection
        const lastDmg = defender._lastDamageDealt || 0;
        if (lastDmg > 0) {
          defender.takeDamage(lastDmg);
          __pa = { success: true, abilityType: 'Unique', message: `**${attacker.name}** used **Flashbacks** — Attack Reflection! Reflected **${lastDmg}** damage!`, damage: lastDmg };
        } else {
          __pa = { success: true, abilityType: 'Unique', message: `**${attacker.name}** used **Flashbacks** — Attack Reflection! Nothing to reflect!`, damage: 0 };
        }
      } else if (r < 0.85) {
        // Stolen Slash Barrage
        const hits = Math.floor(Math.random() * 6) + 2;
        let total = 0; let bleedTurns = 0;
        const fakeAbility = { ...ability, damageMin: 3, damageMax: 7, type: 'Melee' }; // buffed
        for (let i = 0; i < hits; i++) {
          const d = this.calculateDamage(attacker, fakeAbility, defender);
          total += d.totalDamage; defender.takeDamage(d.totalDamage);
          if (Math.random() < 0.15) bleedTurns++;
          if (!defender.isAlive) break;
        }
        let msg = `**${attacker.name}** used **Flashbacks** — Stolen Slash Barrage! ${hits} hits for **${total}** damage!`;
        if (bleedTurns > 0) {
          const existing = defender.statusEffects.find(s => s.name === 'Bleed');
          if (existing) { existing.turnsLeft += bleedTurns; msg += ` **Bleed extended by ${bleedTurns}!**`; }
          else { const sr = defender.addStatus('bleed'); if (sr) { sr.turnsLeft = bleedTurns; msg += ` **Bleed (${bleedTurns} turns)!**`; } }
        }
        __pa = { success: true, abilityType: 'Melee', message: msg, damage: total };
      } else {
        // Double Hand Crush +5
        let total = 0;
        const fakeAbility = { ...ability, damageMin: 15, damageMax: 20, type: 'Melee' };
        for (let i = 0; i < 2; i++) {
          const d = this.calculateDamage(attacker, fakeAbility, defender);
          total += d.totalDamage + 5; defender.takeDamage(d.totalDamage + 5);
          if (!defender.isAlive) break;
        }
        __pa = { success: true, abilityType: 'Melee', message: `**${attacker.name}** used **Flashbacks** — Double Hand Crush (buffed)! 2 hits for **${total}** damage!`, damage: total };
      }
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'flawlessBoneWall') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      const shield = Math.floor(attacker.maxHp * ability.special.shieldPct);
      attacker._tempShield = (attacker._tempShield || 0) + shield; attacker._tempShieldTurns = ability.special.shieldDuration;
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage and gains a **${shield} HP shield** (2 turns)!`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'floweyBlaster') {
      let __pa = null;

      let total = 0; let sm = '';
      for (let i = 0; i < ability.special.hits; i++) {
        if (!defender.isAlive) break;
        if (Math.random() < ability.special.hitChance) {
          const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage;
          defender.atkMod -= ability.special.atkDefReduction; defender.defMod -= ability.special.atkDefReduction;
          defender._retributionStacks = (defender._retributionStacks || 0) + 1;
          sm += ` **Hit!** -${ability.special.atkDefReduction} ATK/-${ability.special.atkDefReduction} DEF!`;
        }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}!${sm || ' All shots missed!'}${total > 0 ? ` **${total}** total damage!` : ''}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'friendlinesslessBoneThrow') {
      let __pa = null;

      let total = 0; let sm = '';
      for (let i = 0; i < ability.special.hits; i++) {
        if (!defender.isAlive) break;
        const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage;
        if (Math.random() < ability.special.debuffChance) {
          if (Math.random() < 0.5) { defender.atkMod -= 1; sm += ` -1 ATK!`; }
          else { defender.defMod -= 1; sm += ` -1 DEF!`; }
          defender._retributionStacks = (defender._retributionStacks || 0) + 1;
        }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${total}** total damage!${sm}${defender._retributionStacks ? ` ATK/DEF Retribution: ${defender._retributionStacks} stacks` : ''}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'friskAct') {
      let __pa = null;

      const roll = Math.random();
      if (roll < 0.34) {
        // Mercy outcome
        attacker._mercyMeter = Math.min(100, (attacker._mercyMeter || 0) + 20);
        __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **ACT**! Showed mercy. (+20% Mercy — total: **${attacker._mercyMeter}%**)`, damage: 0 };
      } else if (roll < 0.67) {
        // Defend outcome
        attacker.defMod += 6;
        attacker._friskActDefBoost = (attacker._friskActDefBoost || 0) + 1;
        __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **ACT**! Defended. **+6 DEF for 1 turn!**`, damage: 0 };
      } else {
        // Heavy attack
        const d = this.calculateDamage(attacker, ability, defender);
        const total = d.totalDamage + 5;
        defender.takeDamage(total);
        const actAbility = attacker.abilities.find(a => a.special?.type === 'friskAct');
        if (actAbility) actAbility.cooldownLeft = 1;
        const emoji = TYPES[ability.type]?.emoji || '';
        __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **ACT** ${emoji}! Heavy attack — **${total}** damage!${d.isCrit ? ' **CRIT!**' : ''} (ACT on cooldown for 1 turn)`, damage: total };
      }
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'friskItem') {
      let __pa = null;

      __pa = { success: true, requiresPicker: 'friskItem', message: `**${attacker.name}** opens their inventory...`, damage: 0 };
      // Don't end turn here — picker callback will resume turn
      return { success: false, message: (__pa && __pa.message) || 'Move failed!' };
    
    }

    if (ability.special?.type === 'friskMercy') {
      let __pa = null;

      if ((attacker._mercyMeter || 0) < 100) {
        ability.currentUses++; // refund
        __pa = { success: false, message: `**MERCY** requires 100% Mercy! (Currently: ${attacker._mercyMeter || 0}%)`, damage: 0 };
        if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
      }
      if (defender.currentHp >= 100) {
        ability.currentUses++; // refund
        __pa = { success: false, message: `**MERCY** requires the enemy to have less than 100 HP!`, damage: 0 };
        if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
      }
      attacker._mercyMeter = 0;
      defender.currentHp = 0;
      this._mercyBonus = true; // flag for reward generation
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **MERCY**! The enemy was spared! (More currencies/drops, lower rare chance)`, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'gemstoneSwitchup') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.defDownChance) { defender.defMod -= ability.special.defDown; sm = ` 💎 -${ability.special.defDown} DEF!`; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'getDunkedKid') {
      let __pa = null;

      attacker._getDunkedActive = true;
      __pa = { success: true, message: `**${attacker.name}** readies **Get Dunked Kid**! Waiting for enemy to attack...`, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'glitchedBlasters') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      if (Math.random() < ability.special.reflectChance) { defender._reflectNext = true; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} ${defender._reflectNext ? 'Enemy\'s next attack may backfire!' : ''}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'glitchedDustedBones') {
      let __pa = null;

      const minHits = ability.special.minHits || 2;
      const maxHits = ability.special.maxHits || 5;
      const hits = Math.floor(Math.random() * (maxHits - minHits + 1)) + minHits;
      let total = 0;
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(attacker, ability, defender);
        defender.takeDamage(d.totalDamage);
        total += d.totalDamage;
        if (!defender.isAlive) break;
      }
      let boneZoneMsg = '';
      if (Math.random() < (ability.special.boneZoneChance || 0.05)) {
        defender.takeDamage(ability.special.glitchedDmg || 10);
        total += ability.special.glitchedDmg || 10;
        boneZoneMsg = ` 🦴 **Bone Zone summoned!** +${ability.special.glitchedDmg || 10} Glitched DMG!`;
      }
      const kr = defender.addStatus('karma'); const k = defender.statusEffects.find(s => s.name === 'Karma'); if (k) k.turnsLeft = ability.special.krDuration || 2;
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! ${hits} hits — **${total}** total damage!${boneZoneMsg} ☯️ **Karma** for ${ability.special.krDuration || 2} turns!`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'glitchyBones') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.missChance) { defender._missNextAttack = true; sm = ' Enemy will **miss** their next attack!'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'godsNecromaniac') {
      let __pa = null;

      const necroMoves = [
        { boss: 'toriel', name: 'Ember rain..', dmg: 14, type: 'Fire', emoji: '🔥', apply: (e) => { const h = e.addStatus('hellfire'); const hf = e.statusEffects.find(st => st.name === 'Hellfire'); if (hf) hf.turnsLeft = 1; if (!e._emberAtkDropped) { e.atkMod -= 2; e._emberAtkDropped = true; } return ' **Hellfire (1 turn)** + enemy **-2 ATK**!'; } },
        { boss: 'papyrus', name: 'Special Attack.?', dmg: 18, type: 'Bone', emoji: '🦴', apply: (e) => { const b = e.addStatus('blueSoul'); const bs = e.statusEffects.find(st => st.name === 'Blue Soul'); if (bs) bs.turnsLeft = 3; e.addStatus('stun'); return ' **Blue Soul (3 turns)** + **Stunned (1 turn)**!'; } },
        { boss: 'undyne', name: 'Spear Helix', dmg: 25, type: 'Melee', emoji: '🔱', apply: (e) => { const b = e.addStatus('bleed'); const bl = e.statusEffects.find(st => st.name === 'Bleed'); if (bl) bl.turnsLeft = 1; return ' **Bleed (1 turn per hit)**!'; } },
        { boss: 'mettaton_neo', name: 'Showstopper', dmg: 20, type: 'Shock', emoji: '⚡', apply: (e) => { const el = e.addStatus('electrified'); const ef = e.statusEffects.find(st => st.name === 'Electrified'); if (ef) ef.turnsLeft = 3; return ' **Shocked (3 turns)**!'; } },
        { boss: 'asgore', name: 'A Kings Greeting', dmg: 24, type: 'Fire', emoji: '👑', apply: (e) => { const b = e.addStatus('burn'); const bn = e.statusEffects.find(st => st.name === 'Burn'); if (bn) bn.turnsLeft = 1; const h = e.addStatus('hellfire'); const hf = e.statusEffects.find(st => st.name === 'Hellfire'); if (hf) hf.turnsLeft = 1; return ' **Burn + Hellfire (1 turn per hit)**!'; } },
      ];
      const idx = attacker._necroIndex || 0;
      if (idx >= necroMoves.length) {
        __pa = { success: false, message: `**God's Necromaniac** has channeled all 5 boss abilities already!`, damage: 0 };
        ability.currentUses++; return { success: false, message: (__pa && __pa.message) || 'Move failed!' };
      }
      const mv = necroMoves[idx];
      attacker._necroIndex = idx + 1;
      // UPDATE 32 BUG FIX: Ember rain..'s -2 ATK is per-USE, not per-hit.
      defender._emberAtkDropped = false;
      const kills = (attacker._bossKills || {})[mv.boss] || 0;
      const bonusHits = kills >= 1 ? Math.floor(Math.log10(kills)) : 0;
      const hits = 1 + bonusHits;
      let total = 0; let sm = '';
      for (let i = 0; i < hits; i++) {
        const dr = defender.takeDamage(mv.dmg); total += dr.damage;
        sm = mv.apply(defender);
        if (!defender.isAlive) break;
      }
      __pa = { success: true, abilityType: mv.type, message: `**${attacker.name}** used **God's Necromaniac**! ${mv.emoji} **${mv.name}** (#${idx + 1}) hits ${hits}x for **${total}** total damage!${sm}${bonusHits > 0 ? ` *(+${bonusHits} hits from ${kills} ${mv.boss} kills)*` : ''}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'grandHarvest') {
      let __pa = null;

      if (!this.isMarkedForDeath(defender)) {
        __pa = { success: false, message: '**The Grand Harvest** can only be used when the enemy is **Marked** (5 Death\'s Touch stacks)!' };
        ability.currentUses++; return { success: false, message: (__pa && __pa.message) || 'Move failed!' };
      }
      // --- UPDATE 30: Grand Harvest pierces 50% DEF + lifesteals 15% of damage dealt ---
      const _hvPierce = Math.floor(defender.def * (ability.special.defPiercePercent || 0.50));
      defender.defMod -= _hvPierce;
      const d = this.calculateDamage(attacker, ability, defender);
      defender.defMod += _hvPierce;
      // Apply 1.5x from Marked
      const finalDmg = Math.floor(d.totalDamage * 1.5);
      const result = defender.takeDamage(finalDmg);
      const _hvLifesteal = attacker.heal(Math.floor(finalDmg * (ability.special.lifestealPercent || 0.15)));
      // Consume all stacks + set cooldown
      defender._deathTouchStacks = 0;
      attacker._deathTouchCooldown = 1;
      const killed = !defender.isAlive;
      let extras = '';
      if (killed) { const healed = attacker.heal(Math.floor(attacker.maxHp * (ability.special.healOnKillPercent || 0.10))); extras = ` 💀 **DEATH!** Healed **${healed} HP**!`; }
      else { const recoil = Math.floor(attacker.currentHp * (ability.special.recoilOnNoKillPercent || 0.20)); attacker.currentHp = Math.max(1, attacker.currentHp - recoil); extras = ` ⚠️ Missed kill — **${recoil} HP** recoil!`; }
      const _hvLifeMsg = _hvLifesteal > 0 ? ` 🩸 Lifesteal **+${_hvLifesteal} HP**!` : '';
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** unleashes **${ability.name}** ${emoji}! **${finalDmg}** damage (1.5x Marked, 50% DEF pierced)!${_hvLifeMsg}${extras} All Death's Touch stacks consumed.`, damage: finalDmg };
      if (killed) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'gravityShift') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      if (Math.random() < ability.special.failChance) { defender._nextMoveFails = true; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} Enemy may be disoriented!`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'gravityWell') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let bsMsg = '';
      if (Math.random() < (ability.special.blueSoulChance || 0.25)) {
        defender._passiveDisabledTurns = 1;
        defender._missChanceBonus = (defender._missChanceBonus || 0) + (ability.special.missAmount || 0.1);
        defender._missChanceBonusTurns = 1;
        bsMsg = ' **Blue Soul!** Passive disabled, +10% miss next turn.';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${bsMsg}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'gunBeam') {
      let __pa = null;

      const pierceAmt = ability.special.pierceAmount || 0.20;
      const reduction = Math.floor(defender.def * pierceAmt);
      defender.defMod -= reduction;
      const d = this.calculateDamage(attacker, ability, defender);
      defender.defMod += reduction;
      defender.takeDamage(d.totalDamage);
      if (attacker.passive?.type === 'coreOverload' && hasPassiveUnlocked(attacker.level) && !attacker._coreDisabled) {
        attacker._coreCharge = (attacker._coreCharge || 0) + 1;
        if (attacker._coreCharge >= 3) { attacker._coreOverloadSurge = true; attacker._coreCharge = 0; }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} *(${Math.round(pierceAmt * 100)}% DEF pierced!)*`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'gunFinalFlash') {
      let __pa = null;

      let d = this.calculateDamage(attacker, ability, defender);
      let dmg = d.totalDamage;
      let pierceMsg = '';
      if (Math.random() < (ability.special.pierceChance || 0.4)) {
        // PvE: ignore 10% def
        const ignoreDef = Math.floor((defender.def || 0) * (ability.special.defIgnore || 0.1));
        dmg += ignoreDef;
        pierceMsg = ` **Pierced! (+${ignoreDef} ignoring ${Math.round((ability.special.defIgnore || 0.1) * 100)}% DEF)**`;
      }
      defender.takeDamage(dmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${pierceMsg}`, damage: dmg };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'handCannon') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.pushChance || 0.25)) {
        defender.addStatus('flinch');
        const so = defender.addStatus('soaked');
        const s = defender.statusEffects.find(st => st.name === 'Soaked'); if (s) s.turnsLeft = ability.special.accDownDuration || 2;
        sm = ' 🌊 **Pushed back!** Enemy flinches next turn and is **Soaked** (-10% accuracy, 2 turns)!';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'harpoonGun') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.chainChance || 0.30)) {
        defender.addStatus('stun');
        defender._harpoonTrapTurns = ability.special.trapDuration || 2; // no dodge/switch (relevant in PvP)
        sm = ' ⚓ **Chained!** Enemy stunned 1 turn and cannot dodge or switch for 2 turns!';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'hatTrick') {
      let __pa = null;

      const roll = Math.floor(Math.random() * 4); let msg = ''; let dmg = 0;
      if (roll === 0) { attacker.currentHp = Math.max(0, attacker.currentHp - 20); msg = '🔫 A gun shoots the fedora — **20 self-damage!**'; }
      else if (roll === 1) { dmg = 50; defender.takeDamage(50); defender.addStatus('stun'); msg = '🎩 The hat explodes — **50 damage** and **Stun!**'; }
      else if (roll === 2) { msg = '...nothing happens. Because it would be funny.'; }
      else { let t = 0; for (let i = 0; i < 7; i++) { defender.takeDamage(5); t += 5; if (Math.random() < 0.75) this._applyCrystallize(defender, 5, ability.special.crystallizeDuration); if (!defender.isAlive) break; } dmg = t; msg = `💎 7 crystals fling out — **${t} damage** + Crystallize!`; }
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **Hat Trick** ✨! ${msg}`, damage: dmg };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'healPrayer') {
      let __pa = null;

      __pa = { success: true, requiresPicker: 'healPrayer', message: `**${attacker.name}** prepares to heal...`, damage: 0 };
      return { success: false, message: (__pa && __pa.message) || 'Move failed!' };
    
    }

    if (ability.special?.type === 'hellBlaster') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      const burnSr = defender.addStatus('burn'); if (burnSr) sm += ' **Burn applied!**';
      const poisonSr = defender.addStatus('poison'); if (poisonSr) sm += ' **Poison applied!**';
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'hellRush') {
      let __pa = null;

      const hits = Math.floor(Math.random() * (ability.special.maxHits - ability.special.minHits + 1)) + ability.special.minHits;
      let total = 0, landed = 0, sm = '';
      for (let i = 0; i < hits; i++) { const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage; landed++; if (Math.random() < ability.special.defDownChance) defender.defMod -= 1; if (!defender.isAlive) break; }
      if (landed >= 3) { attacker.critBoost = (attacker.critBoost || 0) + 0.10; sm += ' ✨ *(next move +10% crit)*'; }
      if (Math.random() < ability.special.bleedChance) { defender.addStatus('bleed'); const bl = defender.statusEffects.find(st => st.name === 'Bleed'); if (bl) bl.turnsLeft = ability.special.bleedDuration; sm += ' 🔴 **Bleed!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! ${landed} hits for **${total}**!${sm}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'hellfireFinale') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let endMsg = '';
      if (!defender.isAlive) {
        const heal = ability.special.healOnKill || 20;
        attacker.hp = Math.min(attacker.maxHp || attacker.hp, attacker.hp + heal);
        endMsg = ` Restored **${heal} HP** for the kill!`;
      } else {
        const burnKey = (ability.special.guaranteedBurnDuration || 2) >= 3 ? 'burn3' : 'burn';
        const sr = defender.addStatus(burnKey); if (sr) endMsg = ' **Burn applied!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${endMsg}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'iceShock') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender);
      const ignoreDef = Math.floor((defender.def || 0) * (ability.special.defIgnore || 0.05));
      const dmg = d.totalDamage + ignoreDef;
      defender.takeDamage(dmg);
      defender._cantFlee = true;
      // Trigger "It's so cold" passive if Noelle Snowgrave
      if (attacker.passive?.type === 'itsSoCold' && hasPassiveUnlocked(attacker.level)) {
        attacker.atkMod += (attacker.passive.atkGain || 1);
        attacker.defMod += (attacker.passive.defGain || 1);
        attacker.heal(attacker.passive.healAmount || 15);
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''} (ignored ${Math.round((ability.special.defIgnore || 0.05) * 100)}% DEF)`, damage: dmg };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'ignitionAttack') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (hasPassiveUnlocked(attacker.level)) {
        const burnChance = (attacker.passive?.baseChance || 0.2) + 0.2 * (attacker.level - 1);
        if (Math.random() < burnChance) {
          const burnKey = attacker.level >= 5 ? 'burn3' : 'burn';
          defender.addStatus(burnKey);
          sm = attacker.level >= 5 ? ' **HELLFIRE!**' : ' **Burn!**';
        }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'infectedGasterBlasters') {
      let __pa = null;

      const emoji = TYPES[ability.type]?.emoji || '';
      if (Math.random() < (ability.special.missChance || 0.5)) {
        __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! ... **It missed!**`, damage: 0 };
        if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
        if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
      }
      const d = this.calculateDamage(attacker, ability, defender);
      defender.takeDamage(d.totalDamage);
      let extras = '';
      if (Math.random() < (ability.special.rustChance || 0.25)) {
        const sr = defender.addStatus('rust');
        if (sr) extras = ' **Rust applied!**';
      }
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'inkEffect') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      const inkExists = defender.statusEffects.find(s => s.name === 'Ink');
      if (!inkExists) defender.statusEffects.push({ name: 'Ink', emoji: '🖌️', damagePerTurn: 6, turnsLeft: 2 });
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage! **Ink** applied!${d.isCrit ? ' **CRIT!**' : ''}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'inventoryFeast') {
      let __pa = null;

      const before = attacker.currentHp;
      attacker.currentHp = Math.min(attacker.maxHp, attacker.currentHp + ability.special.healAmount);
      attacker.statusEffects = attacker.statusEffects.filter(s => !['Bleed', 'Burn', 'Poison'].includes(s.name));
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** 🌭! Healed **${attacker.currentHp - before} HP** and cleared damage-over-time effects.`, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'inverseGravity') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let dMsg = '';
      if (Math.random() < (ability.special.debuffChance || 0.25)) {
        defender._critDebuff = (defender._critDebuff || 0) + (ability.special.critDebuff || 0.2);
        defender._critDebuffTurns = 1;
        defender._accuracyDebuff = Math.max(defender._accuracyDebuff || 0, ability.special.accDebuff || 0.2);
        defender._accuracyDebuffTurns = Math.max(defender._accuracyDebuffTurns || 0, 1);
        dMsg = ' Enemy -20% Crit & Accuracy next turn!';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${dMsg}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'judgementCut') {
      let __pa = null;

      const fullHp = defender.hp >= (defender.maxHp || defender.hp);
      const lowHp = defender.hp <= (defender.maxHp || defender.hp) * 0.2;
      let abilityCopy = { ...ability };
      if (fullHp || lowHp) { abilityCopy.damageMin = Math.floor(ability.damageMin * 1.5); abilityCopy.damageMax = Math.floor(ability.damageMax * 1.5); }
      const d = this.calculateDamage(attacker, abilityCopy, defender); defender.takeDamage(d.totalDamage);
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${(fullHp || lowHp) ? ' *(1.5x boosted!)*' : ''}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'justiceWillRemain') {
      let __pa = null;

      const hits = ability.special.hits || 2;
      let total = 0; let bleedApplied = false; let karmaApplied = false;
      for (let i = 0; i < hits; i++) {
        if (!defender.isAlive) break;
        const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage;
        if (!bleedApplied && Math.random() < (ability.special.bleedChance || 0.45)) { defender.addStatus('bleed'); bleedApplied = true; }
        if (!karmaApplied && Math.random() < (ability.special.karmaChance || 0.45)) { defender.addStatus('karma'); karmaApplied = true; }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! ${hits} hits for **${total}** total!${bleedApplied ? ' **Bleed!**' : ''}${karmaApplied ? ' **Karma!**' : ''}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'ketchupBlaster') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.blindChance || 0.10)) { defender.addStatus('flinch'); sm = ' 🍅 **Blinded** — enemy can\'t attack next turn!'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'knifeBarrage') {
      let __pa = null;

      const minH = ability.special.minHits || 3; const maxH = ability.special.maxHits || 7;
      const hits = Math.floor(Math.random() * (maxH - minH + 1)) + minH;
      let total = 0; let crits = 0;
      for (let i = 0; i < hits; i++) {
        if (!defender.isAlive) break;
        const critRoll = Math.random() < (ability.special.critChance || 0.20);
        const d = this.calculateDamage(attacker, { ...ability, _forceCrit: critRoll }, defender);
        const dmg = critRoll ? Math.floor(d.totalDamage * 1.5) : d.totalDamage;
        defender.takeDamage(dmg); total += dmg; if (critRoll) crits++;
      }
      let sm = crits > 0 ? ` ${crits} CRIT(s)!` : '';
      if (hits >= (ability.special.stunThreshold || 5) && Math.random() < (ability.special.stunChance || 0.20)) { defender.addStatus('stun'); sm += ' **Stunned!**'; }
      if (attacker.passive?.type === 'lethalExchange') { attacker._lethalMeleeHit = true; attacker._lethalMagicBoost = attacker.passive.magicBoost || 1.2; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! ${hits} hits for **${total}** total damage!${sm}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'knifeComboInf') {
      let __pa = null;

      let hits, hitDmgMin, hitDmgMax;
      // Check if CHARGED is active
      if (attacker._chargedActive) {
        hits = Math.floor(Math.random() * ((attacker._chargedKnifeHitsMax || 5) - (attacker._chargedKnifeHitsMin || 4) + 1)) + (attacker._chargedKnifeHitsMin || 4);
        hitDmgMin = hitDmgMax = attacker._chargedKnifeDmg || 15;
      } else {
        hits = Math.floor(Math.random() * ((ability.special.maxHits || 4) - (ability.special.minHits || 2) + 1)) + (ability.special.minHits || 2);
        hitDmgMin = ability.damageMin; hitDmgMax = ability.damageMax;
      }
      let total = 0;
      for (let i = 0; i < hits; i++) {
        const dmg = Math.floor(Math.random() * (hitDmgMax - hitDmgMin + 1)) + hitDmgMin;
        const fakeAbility = { ...ability, damageMin: dmg, damageMax: dmg };
        const d = this.calculateDamage(attacker, fakeAbility, defender);
        defender.takeDamage(d.totalDamage);
        total += d.totalDamage;
        if (!defender.isAlive) break;
      }
      let bleedMsg = '';
      if (hits >= (ability.special.bleedThreshold || 4) || attacker._chargedActive) {
        defender.addStatus('bleed');
        const b = defender.statusEffects.find(s => s.name === 'Bleed');
        const bleedDur = attacker._chargedActive ? (attacker._chargedBleedDuration || 3) : (ability.special.bleedDuration || 2);
        if (b) b.turnsLeft = bleedDur;
        bleedMsg = ` 🩸 **Bleed** for ${bleedDur} turns!`;
      }
      const chargedNote = attacker._chargedActive ? ' ⚡ **CHARGED!**' : '';
      attacker._chargedActive = false;
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}!${chargedNote} ${hits} hits — **${total}** total damage!${bleedMsg}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'knifeRushdown') {
      let __pa = null;

      const minH = ability.special.minHits || 2; const maxH = ability.special.maxHits || 6;
      const hits = Math.floor(Math.random() * (maxH - minH + 1)) + minH;
      let total = 0; let lastDmg = 0;
      for (let i = 0; i < hits; i++) {
        if (!defender.isAlive) break;
        let abilityCopy = { ...ability };
        if (i === hits - 1 && hits > (ability.special.bonusThreshold || 3)) {
          const bonusHits = hits - (ability.special.bonusThreshold || 3);
          abilityCopy.damageMin = ability.damageMin + bonusHits * (ability.special.bonusPerHit || 3);
          abilityCopy.damageMax = ability.damageMax + bonusHits * (ability.special.bonusPerHit || 3);
        }
        const d = this.calculateDamage(attacker, abilityCopy, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage; lastDmg = d.totalDamage;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! ${hits} hits for **${total}** damage!`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'krisSlash') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender);
      let dmg = d.totalDamage;
      let bonusMsg = '';
      if (attacker.currentHp > attacker.maxHp * (ability.special.hpThreshold || 0.5)) {
        dmg += (ability.special.bonusDmg || 5);
        bonusMsg = ` (+${ability.special.bonusDmg || 5} bonus — high HP!)`;
      }
      defender.takeDamage(dmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${bonusMsg}`, damage: dmg };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'largeSchizoBlaster') {
      let __pa = null;

      if (!attacker._largeSchizoCharging) {
        attacker._largeSchizoCharging = true;
        __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** begins charging **${ability.name}**... ⚡`, damage: 0 };
        if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
      }
      attacker._largeSchizoCharging = false;
      const { d, psycho } = this._psychoDmg(attacker, ability, defender); let dmg = d.totalDamage; let sm = '';
      if (psycho) {
        if (Math.random() < ability.special.psychoBonusChance) { dmg = Math.floor(dmg * ability.special.psychoBonusMult); sm += ' 🌀 **+25% damage!**'; }
        const s = defender.addStatus('schizo'); const so = defender.statusEffects.find(st => st.name === 'Schizo'); if (so) so.turnsLeft = ability.special.schizoDuration; if (s) sm += ' **Schizo!**';
      } else {
        const s = defender.addStatus('karma'); const ka = defender.statusEffects.find(st => st.name === 'Karma'); if (ka) ka.turnsLeft = ability.special.karmaDuration; if (s) sm += ' ☯️ **Karma!**';
        if (Math.random() < ability.special.normalNegateChance) { attacker._negateNextPct = 0.25; sm += ' *(will negate 25% of next attack)*'; }
      }
      defender.takeDamage(dmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** fires **${ability.name}** ${emoji}!${psycho ? ' *(Psycho Mode)*' : ''} **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: dmg };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'lethalDeal') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender);
      let dmg = d.totalDamage;
      let bonusMsg = '';
      if (defender.currentHp <= defender.maxHp * 0.4) {
        dmg = Math.floor(dmg * 1.25);
        bonusMsg = ' (1.25x — enemy below 40%!)';
      }
      defender.takeDamage(dmg);
      let msg = `**${attacker.name}** used **A Lethal Deal**! **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${bonusMsg}`;
      if (!defender.isAlive) {
        const stacks = (attacker._lethalDealStacks || 0);
        if (stacks < 2) {
          attacker._lethalDealStacks = stacks + 1;
          attacker.atkMod = (attacker.atkMod || 0) + 2;
          msg += ` **Enemy KO! +2 ATK (rest of battle, ${attacker._lethalDealStacks}/2 stacks)**`;
        }
        __pa = { success: true, abilityType: ability.type, message: msg, damage: dmg };
        if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
      }
      __pa = { success: true, abilityType: ability.type, message: msg, damage: dmg };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'lethalGoopBlasters') {
      let __pa = null;

      if (!attacker._lethalGoopCharging) {
        attacker._lethalGoopCharging = true; attacker.defMod += (ability.special.selfDebuff?.def || -2); attacker._lethalGoopDebuff = ability.special.selfDebuff?.def || -2;
        __pa = { success: true, message: `**${attacker.name}** is charging **Lethal Goop Blasters**... DEF -${Math.abs(attacker._lethalGoopDebuff)}!`, damage: 0 };
        if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
      }
      attacker._lethalGoopCharging = false; attacker.defMod -= (attacker._lethalGoopDebuff || -2); attacker._lethalGoopDebuff = 0;
      const d = this.calculateDamage(attacker, ability, defender);
      let total = d.totalDamage;
      if ((attacker.currentHp / attacker.maxHp) < (ability.special.lowHpThreshold || 0.5)) total += (ability.special.lowHpBonus || 5);
      defender.takeDamage(total); let sm = '';
      if (Math.random() < (ability.special.karmaChance || 0.40)) { const sr = defender.addStatus('karma'); if (sr) sm = ' **Karma!**'; }
      if (attacker.passive?.type === 'lethalExchange') { attacker._lethalMagicBoost = attacker.passive.magicBoost || 1.2; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** releases **Lethal Goop Blasters**! **${total}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'lightSaberSlash') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender);
      // Apply aura farm multiplier
      let finalDmg = d.totalDamage;
      if (attacker._auraFarmActive) { finalDmg = Math.floor(finalDmg * (attacker.passive?.multiplier || 1.5)); attacker._auraFarmActive = false; }
      defender.takeDamage(finalDmg);
      let extras = '';
      if (Math.random() < (ability.special.bleedChance || 0.25)) { defender.addStatus('bleed'); extras += ' **Bleed!**'; }
      if (Math.random() < (ability.special.burnChance || 0.25)) { defender.addStatus('burn'); extras += ' **Burn!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${finalDmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: finalDmg };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'maximumExtraction') {
      let __pa = null;

      const turnBonus = Math.min(ability.special.maxBonus || 10, (this.turnNumber || 0) * (ability.special.bonusPerTurn || 2));
      const d = this.calculateDamage(attacker, ability, defender);
      const totalDmg = d.totalDamage + turnBonus;
      defender.takeDamage(totalDmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      let msg = `**${attacker.name}** used **${ability.name}** ${emoji}! **${totalDmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}`;
      if (turnBonus > 0) msg += ` (+${turnBonus} from ${this.turnNumber} turns elapsed)`;
      // On kill: restore all uses for other abilities
      if (!defender.isAlive) {
        attacker.abilities.forEach((a, i) => {
          if (a.special?.type !== 'maximumExtraction') a.currentUses = a.maxUses;
        });
        msg += ' **Enemy defeated! All other ability uses restored!**';
        __pa = { success: true, abilityType: ability.type, message: msg, damage: totalDmg };
        if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
      }
      __pa = { success: true, abilityType: ability.type, message: msg, damage: totalDmg };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'meltdownFlash') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let burnMsg = '';
      if (Math.random() < (ability.special.burnChance || 0.4)) {
        const burnKey = (ability.special.burnDuration || 3) >= 3 ? 'burn3' : 'burn';
        const sr = defender.addStatus(burnKey); if (sr) burnMsg = ' **Burn applied!**';
      }
      attacker._coreDisabled = ability.special.disableTurns || 2;
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${burnMsg} Core Overload disabled 2 turns!`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'memories') {
      let __pa = null;

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
      if (attacker._memoriesUses[chosen.key] <= 0) {
        __pa = { success: false, message: `**${chosen.name}** has no more appearances left!`, damage: 0 };
        ability.currentUses++; return { success: false, message: (__pa && __pa.message) || 'Move failed!' };
      }
      attacker._memoriesUses[chosen.key]--;
      const hits = chosen.hits || Math.floor(Math.random() * ((chosen.hitsMax || 1) - (chosen.hitsMin || 1) + 1)) + (chosen.hitsMin || 1);
      let total = 0, sm = '';
      for (let i = 0; i < hits; i++) {
        const dmg = Math.floor(Math.random() * (chosen.damageMax - chosen.damageMin + 1)) + chosen.damageMin;
        const dr = defender.takeDamage(dmg); total += dr.damage;
      }
      if (chosen.burnChance && Math.random() < chosen.burnChance) { defender.addStatus('burn'); sm += ' **Burn!**'; }
      if (chosen.electrifiedChance && Math.random() < chosen.electrifiedChance) { defender.addStatus('electrified'); sm += ' **Electrified!**'; }
      const usesLeft = attacker._memoriesUses[chosen.key];
      __pa = { success: true, abilityType: chosen.type, message: `**${attacker.name}** used **Memories.**! ${chosen.emoji} **${chosen.name}** appears and attacks! **${total}** total damage! *(${chosen.name} uses left: ${usesLeft})*${sm}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'memoriesDodge') {
      let __pa = null;

      const sr = defender.addStatus('memoriesDodge');
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `💭 **${attacker.name}** used **${ability.name}** ${emoji}! Enemy attacks **disabled for 1 round!**`, damage: 0 };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'meteorCataclysm') {
      let __pa = null;

      const alreadyBurned = defender.hasStatus('Burn') || defender.hasStatus('Hellfire');
      let pierceReduce = 0;
      if (alreadyBurned && ability.special.defPierce) {
        pierceReduce = Math.floor(defender.def * ability.special.defPierce);
        if (pierceReduce > 0) defender.defMod -= pierceReduce;
      }
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      if (pierceReduce > 0) defender.defMod += pierceReduce;
      let sm = '';
      const br = defender.addStatus('burn'); if (br) sm += ' **Burn applied!**';
      if (alreadyBurned) {
        defender.addStatus('flinch');
        ability.cooldownLeft = (ability.special.flinchCooldown || 2) + 1;
        sm += ' ☄️ The burning target **flinches** (pierced 10% DEF)!';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'multiDebuffPlayer') {
      let __pa = null;

      defender.atkMod += ability.special.enemyAtk;
      defender.defMod += ability.special.enemyDef;
      __pa = { success: true, message: `**${attacker.name}** used **${ability.name}**! Enemy ATK ${ability.special.enemyAtk}, DEF ${ability.special.enemyDef}!`, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'myCrew') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      if (!defender._crewTurns || defender._crewTurns <= 0) {
        defender._crewTurns = ability.special.duration;
        defender._crewDmg = ability.special.damagePerTurn;
      }
      __pa = { success: true, message: `**${attacker.name}** used **My Crew!** The crew arrives! **${d.totalDamage}** damage! Enemy takes **${ability.special.damagePerTurn}** dmg/turn for ${ability.special.duration} turns!`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'myStrongestAttack') {
      let __pa = null;

      const hpRatio = attacker.hp / (attacker.maxHp || attacker.hp);
      if (hpRatio > (ability.special.hpThreshold || 0.05)) {
        __pa = { success: false, message: `**${ability.name}** can only be used below 5% HP!` };
        return { success: false, message: (__pa && __pa.message) || 'Move failed!' };
      }
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      defender._myStrongestActive = true; // signals end-of-turn poison + hellfire ticks
      defender.addStatus('stun');
      defender.defMod = (defender.defMod || 0) - (ability.special.defReducePermanent || 2);
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} Enemy **Stunned**, -2 DEF permanent, Poison + Hellfire end of turn!`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'negativeApple') {
      let __pa = null;

      attacker.heal(ability.special.healAmount || 50);
      defender.takeDamage(ability.damageMax || 25);
      __pa = { success: true, message: `**${attacker.name}** ate a **Negative Apple**! Healed **${ability.special.healAmount || 50} HP**, enemy takes **${ability.damageMax || 25}** damage!`, damage: ability.damageMax || 25 };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'neonSlash') {
      let __pa = null;

      const { d, psycho } = this._psychoDmg(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (psycho) {
        const s = defender.addStatus('schizo'); const so = defender.statusEffects.find(st => st.name === 'Schizo'); if (so) so.turnsLeft = ability.special.schizoDuration; if (s) sm += ' 🌀 **Schizo!**';
        if (Math.random() < ability.special.psychoAtkDownChance) { defender.atkMod -= ability.special.psychoAtkDown; sm += ` -${ability.special.psychoAtkDown} ATK!`; }
      } else {
        const s = defender.addStatus('karma'); const ka = defender.statusEffects.find(st => st.name === 'Karma'); if (ka) ka.turnsLeft = ability.special.karmaDuration; if (s) sm += ' ☯️ **Karma!**';
        if (Math.random() < ability.special.normalDefDownChance) { defender.defMod -= ability.special.normalDefDown; sm += ` -${ability.special.normalDefDown} DEF!`; }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}!${psycho ? ' *(Psycho Mode)*' : ''} **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'nightmareBarrage') {
      let __pa = null;

      // Disabled while shield is active
      if (attacker._tentacleShieldHp > 0) {
        __pa = { success: false, message: `**${ability.name}** is disabled while **Tentacle Shield** is active!` };
        return { success: false, message: (__pa && __pa.message) || 'Move failed!' };
      }
      let hits, hitDmgMin, hitDmgMax;
      if (attacker._enragedActivated) {
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
        const d = this.calculateDamage(attacker, fakeAbility, defender);
        defender.takeDamage(d.totalDamage);
        total += d.totalDamage;
        if (!defender.isAlive) break;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! ${hits} hits — **${total}** total damage!${attacker._enragedActivated ? ' 🌑 **ENRAGED!**' : ''}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'nightmareSlam') {
      let __pa = null;

      let min = ability.damageMin, max = ability.damageMax;
      if (attacker._enragedActivated) {
        min = ability.special.enragedMin || 55;
        max = ability.special.enragedMax || 60;
      }
      const baseDmg = Math.floor(Math.random() * (max - min + 1)) + min;
      const customAbility = { ...ability, damageMin: baseDmg, damageMax: baseDmg };
      const d = this.calculateDamage(attacker, customAbility, defender);
      defender.takeDamage(d.totalDamage);
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${attacker._enragedActivated ? ' 🌑 **ENRAGED!**' : ''}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'noMoreMercy') {
      let __pa = null;
      const hpPct = attacker.currentHp / attacker.maxHp;

      if (hpPct > ability.special.hpThreshold) {
        __pa = { success: false, message: `**No More Mercy** can only be used at 20% HP or below!` };
        ability.currentUses++; ability.cooldownLeft = 0; attacker._usedAbilityThisTurn = false; attacker._attackedThisTurn = false; return { success: false, message: (__pa && __pa.message) || 'Move failed!' };
      }
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      const applied = [];
      const pool = ['karma', 'electrified', 'blueSoul', 'blindness', 'bleed', 'stun'];
      // Shuffle pool and pick guaranteed 2 unique statuses
      const shuffled = pool.sort(() => Math.random() - 0.5);
      for (let i = 0; i < 2; i++) { defender.addStatus(shuffled[i]); applied.push(shuffled[i]); }
      // 15% chance for each additional
      let i = 2;
      while (i < shuffled.length && Math.random() < 0.15) { defender.addStatus(shuffled[i]); applied.push(shuffled[i]); i++; }
      __pa = { success: true, message: `**${attacker.name}** used **No More Mercy**! **${d.totalDamage}** damage! Applied: **${applied.join(', ')}**!`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'noelleHealPrayer') {
      let __pa = null;

      __pa = { success: true, requiresPicker: 'noelleHealPrayer', message: `**${attacker.name}** prepares to heal...`, damage: 0 };
      return { success: false, message: (__pa && __pa.message) || 'Move failed!' };
    
    }

    if (ability.special?.type === 'normal') {
      let __pa = null;

      // Just normal damage, cooldown already handled at top
    
    }

    if (ability.special?.type === 'nuhUh') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      attacker._nuhUhActive = true;
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **NUH UH!!!!!!**! **${d.totalDamage}** damage! Waiting to counter...`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'oceanCannonballs') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let total = d.totalDamage; let sm = '';
      const br = defender.addStatus('burn'); if (br) sm += ' **Burn!**';
      if (Math.random() < (ability.special.stunChance || 0.15)) { const st = defender.addStatus('stun'); if (st) sm += ' **Stunned!**'; }
      if ((defender._crewTurns || 0) > 0 && Math.random() < (ability.special.crewExtraChance || 0.30) && defender.isAlive) {
        const d2 = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d2.totalDamage); total += d2.totalDamage;
        sm += ` ⚓ A crewmate fires their own cannonball — **${d2.totalDamage}** extra damage!`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${total}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'octoBlasters') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let extras = '';
      if (Math.random() < (ability.special.poisonChance || 0.2)) { const sr = defender.addStatus('poison'); if (sr) extras += ' **Poisoned!**'; }
      if (Math.random() < (ability.special.boundChance || 0.1)) { const sr = defender.addStatus('bound'); if (sr) { extras += ' **Bound!**'; attacker._nextAttackGuaranteed = true; } }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'offGuardBlast') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < 0.1) { defender.addStatus('orangeSoul'); sm += ' **Orange Soul!**'; }
      if (Math.random() < 0.2) { defender.addStatus('poison'); sm += ' **Poisoned!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'oneLefHeal') {
      let __pa = null;

      attacker.maxHp = Math.max(1, attacker.maxHp - (ability.special.maxHpLoss || 5));
      attacker.currentHp = Math.min(attacker.maxHp, attacker.currentHp);
      const healed = attacker.heal(ability.special.healAmount || 30);
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **ONE LEFT.**! Healed **${healed} HP** using DETERMINATION. Max HP -${ability.special.maxHpLoss || 5} (now ${attacker.maxHp}).`, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'orangeSoul') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.chance) { defender.addStatus('orangeSoul'); sm = ' **Orange Soul** applied!'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'outerNova') {
      let __pa = null;

      if (Math.random() < (ability.special.missChance || 0.6)) {
        const emoji = TYPES[ability.type]?.emoji || '';
        __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** unleashed **OUTER TECHNIQUE: NOVA** ${emoji}... but **MISSED!**`, damage: 0 };
        if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
      }
      const dmg = ability.damageMin || 100;
      defender.takeDamage(dmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** unleashes **OUTER TECHNIQUE: NOVA** ${emoji}! **${dmg}** cosmic damage!`, damage: dmg };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'pelletCircle') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender);
      let total = d.totalDamage;
      if (defender._isBlocking) {
        total = Math.max(1, Math.floor(total * (ability.special.blockBypassMult || 0.5)));
      }
      defender.takeDamage(total);
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${total}** damage!${d.isCrit ? ' **CRIT!**' : ''}${defender._isBlocking ? ' *(Front pellets blocked!)*' : ''}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'perfectSave') {
      let __pa = null;

      if (!attacker._perfectSaveState) {
        attacker._perfectSaveState = { atkMod: attacker.atkMod, defMod: attacker.defMod };
        __pa = { success: true, message: `**${attacker.name}** used **PERFECT SAVE** ⭐! Current stats saved (ATK mod: ${attacker.atkMod >= 0 ? '+' : ''}${attacker.atkMod}, DEF mod: ${attacker.defMod >= 0 ? '+' : ''}${attacker.defMod}). Reuse to restore and heal **${ability.special.healAmount || 30} HP**!`, damage: 0 };
      } else {
        const saved = attacker._perfectSaveState;
        attacker.atkMod = saved.atkMod;
        attacker.defMod = saved.defMod;
        const healed = attacker.heal(ability.special.healAmount || 30);
        attacker._perfectSaveState = null;
        __pa = { success: true, message: `**${attacker.name}** used **PERFECT SAVE** ⭐! Stats restored! Healed **${healed} HP**! (${attacker.currentHp}/${attacker.maxHp})`, damage: 0 };
      }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'perry') {
      attacker._perryActive = true;
      attacker._perryRecoverThreshold = ability.special.recoverThreshold || 150;
      log.push(`**${attacker.name}** used **${ability.name}**! 🛡️ Reflecting the next attack — if it deals more than ${attacker._perryRecoverThreshold} damage, recovery for 1 turn.`);
      this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    }

    if (ability.special?.type === 'pewPew') {
      let __pa = null;

      if ((attacker._ammo || 0) < (ability.special.ammoCost || 1)) {
        ability.currentUses++;
        __pa = { success: false, message: `**Pew Pew** needs ${ability.special.ammoCost || 1} ammo! (Currently: ${attacker._ammo || 0})`, damage: 0 };
        if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
      }
      attacker._ammo -= (ability.special.ammoCost || 1);
      const minH = ability.special.minHits || 2, maxH = ability.special.maxHits || 4;
      const hits = Math.floor(Math.random() * (maxH - minH + 1)) + minH;
      let total = 0;
      const enemyMissBonus = (defender._missChanceBonus || 0) + (attacker._cloverAtkRetaliation ? 0.1 : 0);
      const accLowered = enemyMissBonus > 0;
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(attacker, ability, defender);
        total += d.totalDamage; defender.takeDamage(d.totalDamage);
        if (!defender.isAlive) break;
      }
      let extras = '';
      if (accLowered) {
        attacker.atkMod += 2; extras = ' **Accuracy was lowered — +2 ATK to Clover!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! ${hits} hits — **${total}** total! Ammo: ${attacker._ammo}${extras}`, damage: total };
      if (attacker._ammo <= 0 && !attacker._reloadingTurns) {
        attacker._reloadingTurns = 2;
      }
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'portalPillar') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.karmaChance) { defender.addStatus('karma'); sm += ' **Karma!**'; }
      if (Math.random() < ability.special.stunChance) { defender.addStatus('stun'); sm += ' **Stunned!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'positiveApple') {
      let __pa = null;

      attacker._positiveAppleTurns = ability.special.duration || 4;
      attacker._positiveAppleHeal = ability.special.healPerTurn || 15;
      attacker.heal(attacker._positiveAppleHeal);
      __pa = { success: true, message: `**${attacker.name}** ate a **Positive Apple**! Heals ${attacker._positiveAppleHeal} HP this turn and every turn for ${ability.special.duration || 4} turns!`, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'psychoticBlaster') {
      let __pa = null;

      const { d, psycho } = this._psychoDmg(attacker, ability, defender); let dmg = d.totalDamage; let sm = '';
      if (psycho) {
        if (Math.random() < ability.special.psychoBonusChance) { dmg = Math.floor(dmg * ability.special.psychoBonusMult); sm += ' 🌀 **+15% damage!**'; }
        const s = defender.addStatus('schizo'); const so = defender.statusEffects.find(st => st.name === 'Schizo'); if (so) so.turnsLeft = ability.special.schizoDuration; if (s) sm += ' **Schizo!**';
      } else {
        if (Math.random() < ability.special.normalNegateChance) { dmg = Math.floor(dmg * 0.90); sm += ' ☯️ *(10% negated)*'; }
        const s = defender.addStatus('karma'); const ka = defender.statusEffects.find(st => st.name === 'Karma'); if (ka) ka.turnsLeft = ability.special.karmaDuration; if (s) sm += ' **Karma!**';
      }
      defender.takeDamage(dmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}!${psycho ? ' *(Psycho Mode)*' : ''} **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: dmg };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'rainOverflow') {
      let __pa = null;

      const perInterval = ability.special.perInterval || 8;
      const perBonus = ability.special.perBonus || 16;
      const maxBonus = ability.special.maxBonus || 96;
      const intervals = Math.floor(this.turnNumber / perInterval);
      const bonus = Math.min(intervals * perBonus, maxBonus);
      const baseDmg = 10; // UPDATE 17 buff — base 0 -> 10 so it's not dead on turn 1
      const totalDmg = baseDmg + bonus;
      defender.takeDamage(totalDmg);
      // Apply Stun twice (= 2 turns of stun)
      const sr1 = defender.addStatus('stun');
      const stun = defender.statusEffects.find(s => s.name === 'Stun');
      if (stun) stun.turnsLeft = 2; // 2 stun applications = 2 turns
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${totalDmg}** damage! *(base ${baseDmg} + ${bonus} from ${this.turnNumber} turns elapsed)* 💫 **Stunned for 2 turns!**`, damage: totalDmg };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'rainfallBones') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender);
      defender.takeDamage(d.totalDamage);
      attacker._rainfallBonesArmed = true; // attacker hits this turn? karma them
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} 🌧️ *If hit next turn, attacker will be inflicted with Karma!*`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'rainingTacos') {
      let __pa = null;

      attacker._rainingTacosAtkLock = ability.special.atkLockTurns;
      attacker._rainingTacosHeal = ability.special.healDuration;
      attacker._rainingTacosHealAmt = ability.special.healPerTurn;
      __pa = { success: true, message: `**${attacker.name}** used **${ability.name}**! ATK locked for ${ability.special.atkLockTurns} turns, healing **${ability.special.healPerTurn} HP/turn** for ${ability.special.healDuration} turns!`, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'rapidShot') {
      let __pa = null;

      // --- UPDATE 22 BUG FIX: 0 bullets is falsy — only init when undefined, otherwise reload never triggered ---
      if (attacker._bullets === undefined) attacker._bullets = attacker.passive?.type === 'theFinalChamber' ? (attacker.passive.maxShots || 6) : 6;
      // --- UPDATE 22 BUG FIX: 6th shot (last bullet) stuns 1 turn + guaranteed crit ---
      const isFinalShot = attacker.passive?.type === 'theFinalChamber' && hasPassiveUnlocked(attacker.level) && attacker._bullets === 1;
      if (isFinalShot) attacker.critBoost = 999;
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      if (isFinalShot) { attacker.critBoost = 0; defender.addStatus('stun'); }
      let total = d.totalDamage; let sm = isFinalShot ? ' 🔫 **THE FINAL CHAMBER!** Guaranteed crit + enemy **Stunned**!' : '';
      if (d.isCrit) {
        const followUp = Math.floor(d.totalDamage * (ability.special.critFollowUpPct || 0.5));
        defender.takeDamage(followUp); total += followUp;
        defender.addStatus('bleed'); sm += ` **CRIT!** Follow-up shot for **${followUp}**! **Bleed** applied!`;
      }
      attacker._bullets = Math.max(0, (attacker._bullets || 6) - 1);
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${total}** damage!${sm} (Bullets: ${attacker._bullets}/6)`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'rkKnifeThrust') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender);
      let finalDmg = d.totalDamage;
      if (attacker._rkMarkedIndex === attacker.abilities.indexOf(ability)) {
        attacker.atkMod += 2; attacker.defMod += 2; finalDmg += 12;
        attacker._rkMarkedBuff = 1; attacker._rkMarkedIndex = -1;
        if (!R.rkMarkUsed) R.rkMarkUsed = `⚔️ **MARKED move used!** +2 ATK, +2 DEF for 1 turn, +12 bonus damage!`;
      }
      defender.takeDamage(finalDmg);
      attacker._rkKnifeThrustLastTurn = true; attacker._rkSwordThrowLastTurn = false;
      let extras = '';
      if (Math.random() < (ability.special.blindChance || 0.35)) { defender.addStatus('blindness'); extras += ' **Blinded!**'; }
      if (Math.random() < (ability.special.forceSwitchChance || 0.10) && this.isPvP) {
        defender._forceSwitchNextTurn = true; extras += ' **Force switch triggered!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${finalDmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: finalDmg };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'rkRealityCut') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender);
      let finalDmg = d.totalDamage;
      if (attacker._rkMarkedIndex === attacker.abilities.indexOf(ability)) {
        attacker.atkMod += 2; attacker.defMod += 2; finalDmg += 12;
        attacker._rkMarkedBuff = 1; attacker._rkMarkedIndex = -1;
        if (!R.rkMarkUsed) R.rkMarkUsed = `⚔️ **MARKED move used!** +2 ATK, +2 DEF for 1 turn, +12 bonus damage!`;
      }
      defender.takeDamage(finalDmg);
      // Drain 3 uses from a random ability
      const validAbilities = defender.abilities.filter(a => a.currentUses > 0);
      let drainMsg = '';
      if (validAbilities.length > 0) {
        const target = validAbilities[Math.floor(Math.random() * validAbilities.length)];
        const drained = Math.min(target.currentUses, ability.special.usesDrain || 3);
        target.currentUses -= drained;
        drainMsg = ` 🌑 **Reality Cut** drained **${drained} uses** from **${target.name}**!`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${finalDmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${drainMsg}`, damage: finalDmg };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'rkShield') {
      attacker._rkShieldActive = true;
      log.push(`**${attacker.name}** raises their **Shield**! If the opponent attacks, they will be **Stunned**!`);
      this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    }

    if (ability.special?.type === 'rkStarStorm') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender);
      let finalDmg = d.totalDamage;
      if (attacker._rkMarkedIndex === attacker.abilities.indexOf(ability)) {
        attacker.atkMod += 2; attacker.defMod += 2; finalDmg += 12;
        attacker._rkMarkedBuff = 1; attacker._rkMarkedIndex = -1;
        if (!R.rkMarkUsed) R.rkMarkUsed = `⚔️ **MARKED move used!** +2 ATK, +2 DEF for 1 turn, +12 bonus damage!`;
      }
      defender.takeDamage(finalDmg);
      const stacks = ability.special.starShardsStacks || 2;
      defender._starShardsStacks = (defender._starShardsStacks || 0) + stacks;
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${finalDmg}** damage!${d.isCrit ? ' **CRIT!**' : ''} 🌟 Applied **${stacks} Star Shards** stacks! (Total: ${defender._starShardsStacks})`, damage: finalDmg };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'rkSwordThrow') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender);
      let finalDmg = d.totalDamage;
      // +15 if previous turn was Knife Thrust
      if (attacker._rkKnifeThrustLastTurn) { finalDmg += 15; attacker._rkKnifeThrustLastTurn = false; }
      // Check if this is the marked move
      if (attacker._rkMarkedIndex === attacker.abilities.indexOf(ability)) {
        attacker.atkMod += 2; attacker.defMod += 2; finalDmg += 12;
        attacker._rkMarkedBuff = 1; attacker._rkMarkedIndex = -1;
        if (!R.rkMarkUsed) R.rkMarkUsed = `⚔️ **MARKED move used!** +2 ATK, +2 DEF for 1 turn, +12 bonus damage!`;
      }
      defender.takeDamage(finalDmg);
      attacker._rkSwordThrowLastTurn = true;
      let extras = '';
      if (Math.random() < (ability.special.bleedChance || 0.40)) { defender.addStatus('bleed'); extras += ' **Bleed!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${finalDmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: finalDmg };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'rudeBuster') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender);
      let dmg = d.totalDamage;
      let bonusMsg = '';
      if (Math.random() < (ability.special.bonusChance || 0.1)) {
        const opts = ability.special.bonusOptions || [30, 28, 20, 13, 11, 10, 7];
        const bonus = opts[Math.floor(Math.random() * opts.length)];
        dmg += bonus;
        bonusMsg = ` (+${bonus} bonus!)`;
      }
      defender.takeDamage(dmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${dmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${bonusMsg}`, damage: dmg };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'sacrificesMustBeMade') {
      let __pa = null;

      const baseBosses = ['toriel', 'papyrus', 'undyne', 'mettaton_neo', 'asgore'];
      if (!false || !baseBosses.includes(null)) {
        __pa = { success: false, message: `**Sacrifices must be made..** is only usable against **Toriel, Papyrus, Undyne, Mettaton NEO or Asgore**!`, damage: 0 };
        ability.currentUses++; return { success: false, message: (__pa && __pa.message) || 'Move failed!' };
      }
      const kills = (attacker._bossKills || {})[null] || 0;
      if (kills < 100) {
        __pa = { success: false, message: `**Sacrifices must be made..** requires at least **100 kills** on this boss! (You have **${kills}**)`, damage: 0 };
        ability.currentUses++; return { success: false, message: (__pa && __pa.message) || 'Move failed!' };
      }
      let awarded = 2;
      if (kills >= 1000) awarded = 6 + 2 * Math.floor((kills - 1000) / 500);
      else if (kills >= 500) awarded = 3;
      defender.currentHp = 0;
      this._noChanceDrops = true;
      this._extraBossKills = awarded - 1; // index.js adds 1 normally; these are the extras
      __pa = { success: true, message: `✝️ *"It's not wrong if they agreed to it, right..?"*\n\n**${attacker.name}** used **Sacrifices must be made..** — **${defender.name}** is instantly slain! No drops are awarded, but **${awarded} boss kills** are recorded!`, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'savePointAnchor') {
      let __pa = null;

      if (!attacker._damageReduction) attacker._damageReduction = 0;
      attacker._damageReduction = ability.special.reduction;
      attacker._damageReductionTurns = ability.special.duration;
      __pa = { success: true, message: `**${attacker.name}** used **${ability.name}**! Damage reduced by ${Math.round(ability.special.reduction*100)}% for ${ability.special.duration} turns!`, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'saveScreenSlash') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.glitchedChance) { defender.addStatus('glitched'); sm = ' **Glitched!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'scaryKR') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      defender.addStatus('scaryKR');
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage! **Scary KR** applied for ${ability.special.duration} turns!`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'scytheSweep') {
      let __pa = null;

      const hits = Math.floor(Math.random() * (ability.special.maxHits - ability.special.minHits + 1)) + ability.special.minHits;
      let total = 0;
      for (let i = 0; i < hits; i++) {
        if (!defender.isAlive) break;
        const d = this.calculateDamage(attacker, ability, defender);
        defender.takeDamage(d.totalDamage); total += d.totalDamage;
      }
      // Stack death touch equal to number of hits
      for (let i = 0; i < hits; i++) this.applyFearOfDeath(attacker, defender);
      const stacks = defender._deathTouchStacks || 0;
      const emoji = TYPES[ability.type]?.emoji || '';
      const markedMsg = this.isMarkedForDeath(defender) ? ' ☠️ **Enemy is MARKED!**' : '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! ${hits} hit${hits > 1 ? 's' : ''} for **${total}** damage! 💀 Death's Touch: **${stacks}/5** stacks!${markedMsg}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'sharpBoneZone') {
      let __pa = null;

      if (!defender.statusEffects.find(s => s.id === 'sharpBoneZone')) {
        defender.statusEffects.push({ id: 'sharpBoneZone', name: 'Sharp Bone Zone', emoji: '🦴', damagePerTurn: ability.special.damagePerTurn, turnsLeft: ability.special.duration });
      }
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** set up **Sharp Bone Zone**! Enemy takes **${ability.special.damagePerTurn}** dmg/turn for ${ability.special.duration} turns.`, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'shockwaveCanon') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let dMsg = '';
      if (Math.random() < (ability.special.disableChance || 0.2) && defender.abilities && defender.abilities.length > 0) {
        const idx = Math.floor(Math.random() * defender.abilities.length);
        if (!defender._disabledAbilities) defender._disabledAbilities = {};
        defender._disabledAbilities[idx] = ability.special.disableDuration || 2;
        dMsg = ` Disabled **${defender.abilities[idx].name}** for ${ability.special.disableDuration || 2} turns!`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${dMsg}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'singularity') {
      let __pa = null;

      const dur = (ability.special.duration || 2) + 1; // +1 because endTurn decrements same turn
      attacker._singularityTurns = dur;
      attacker._singularityStored = 0;
      defender._singularityTurns = dur;
      defender._singularityStored = 0;
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** activated **SINGULARITY** ${emoji}! Both fighters are absorbed... after 2 turns, 70% of damage stored explodes!`, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'sinnersRain') {
      let __pa = null;

      const hits = Math.floor(Math.random() * (ability.special.maxHits - ability.special.minHits + 1)) + ability.special.minHits;
      let total = 0, sm = '';
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage;
        if (Math.random() < (ability.special.regretChance || 0.10)) {
          const sr = defender.addStatus('regret');
          const rg = defender.statusEffects.find(st => st.name === 'Regret');
          if (rg) rg.turnsLeft = ability.special.regretDuration || 2;
          if (sr && !sm.includes('Regret')) sm += ' 😔 **Regret applied!**';
        }
        if (!defender.isAlive) break;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! ${hits} hits for **${total}** total damage!${sm}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'slashBarrage') {
      let __pa = null;

      const minH = ability.special.minHits || 2, maxH = ability.special.maxHits || 5;
      const hits = Math.floor(Math.random() * (maxH - minH + 1)) + minH;
      let total = 0; let isFifthCrit = false; let bleedMsg = '';
      for (let i = 0; i < hits; i++) {
        const d = this.calculateDamage(attacker, ability, defender);
        let hitDmg = d.totalDamage;
        if (i === 4 && hits === 5) {
          // Force crit
          hitDmg = Math.floor(hitDmg * 1.5);
          isFifthCrit = true;
        }
        total += hitDmg;
        defender.takeDamage(hitDmg);
        if (!defender.isAlive) break;
      }
      if (hits === 5) {
        const sr = defender.addStatus('bleed'); if (sr) { sr.turnsLeft = 2; bleedMsg = ' **Bleed (2 turns)!**'; }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! Hit **${hits}** times for **${total}** total!${isFifthCrit ? ' **5th HIT CRIT!**' : ''}${bleedMsg}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'sleepMist') {
      let __pa = null;

      attacker._sleepMistUses = (attacker._sleepMistUses || 0) + 1;
      let msg;
      if (attacker._sleepMistUses > (ability.special.threshold || 5)) {
        const sr = defender.addStatus('sleep'); if (sr) sr.turnsLeft = 2;
        msg = `**${attacker.name}** used **Sleep Mist**! Enemy fell **Asleep for 2 turns!**`;
        attacker._sleepMistUses = 0;
      } else {
        defender._missChanceBonus = (defender._missChanceBonus || 0) + 0.2;
        defender._missChanceBonusTurns = 1;
        msg = `**${attacker.name}** used **Sleep Mist**! Enemy accuracy -20% next turn. (${attacker._sleepMistUses}/${(ability.special.threshold || 5) + 1} until Sleep)`;
      }
      __pa = { success: true, abilityType: ability.type, message: msg, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'smokyCounter') {
      let __pa = null;

      attacker._smokyCounter = ability.special.counterDamage || 30;
      // Hazy stack ignoring cooldown
      defender._hazyStacks = Math.min((defender._hazyStacks || 0) + 1, 5);
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** activated **${ability.name}** ${emoji}! Will dodge & counter for ${ability.special.counterDamage || 30} dmg next turn! +1 Hazy stack!`, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'sorrowTears') {
      let __pa = null;

      const defBoost = ability.special.defBoost || 2;
      const accRed = ability.special.accReduction || 0.25;
      const dur = ability.special.duration || 2;
      attacker.defMod += defBoost;
      if (!attacker._sorrowTearsDefTurns) attacker._sorrowTearsDefTurns = 0;
      attacker._sorrowTearsDefTurns += dur;
      attacker._sorrowTearsDefAmount = (attacker._sorrowTearsDefAmount || 0) + defBoost;
      defender._missChanceBonus = (defender._missChanceBonus || 0) + accRed;
      defender._missChanceBonusTurns = (defender._missChanceBonusTurns || 0) + dur;
      __pa = { success: true, message: `**${attacker.name}** used **${ability.name}**! 💧 +${defBoost} DEF for ${dur} turns! Enemy accuracy **-${Math.round(accRed * 100)}%** for ${dur} turns!`, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'soulInfusedBlast') {
      let __pa = null;

      if (attacker._soulBlastUsedOnThisEnemy) {
        __pa = { success: false, message: '**Soul Infused Blast** can only be used **ONCE per enemy!**' };
        ability.currentUses++; return { success: false, message: (__pa && __pa.message) || 'Move failed!' };
      }
      attacker._soulBlastUsedOnThisEnemy = true;
      defender.takeDamage(120);
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** channels all soul energy into **${ability.name}** ${emoji}! **120** fixed damage!`, damage: 120 };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'soulReaper') {
      let __pa = null;

      const stacks = defender._deathTouchStacks || 0;
      const d = this.calculateDamage(attacker, ability, defender);
      defender.takeDamage(d.totalDamage);
      this.applyFearOfDeath(attacker, defender);
      let healMsg = '';
      if (stacks > 0) {
        const healAmt = stacks * (ability.special.healPerStack || 5);
        attacker.heal(healAmt);
        healMsg = ` Healed **${healAmt} HP** (${stacks} stacks × ${ability.special.healPerStack || 5})!`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${healMsg} Stacks: **${defender._deathTouchStacks || 0}/5**`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'soulSlam') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let extras = '';
      if (Math.random() < (ability.special.flinchChance || 0.20)) { const sr = defender.addStatus('flinch'); if (sr) extras = ' **Flinched!**'; }
      const stacks = defender._hazyStacks || 0;
      if (stacks >= (ability.special.capStacks || 5) && ability.special.forceSwitchOnCap && this.isPvP) {
        // In PvP, force switch handled by caller via flag
        defender._forceSwitchNextTurn = true;
        extras += ' Enemy is forced to switch next turn!';
      }
      this.applySmokeScreenPassive(attacker, defender);
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'soulTrait') {
      let __pa = null;

      const traits = ['Bravery', 'Integrity', 'Patience', 'Perseverance'];
      const picked = traits[Math.floor(Math.random() * traits.length)];
      let msg = `**${attacker.name}** channeled **${picked}**! `;
      if (picked === 'Bravery') { attacker._damageBoostNext = 1.35; msg += 'Next attack deals 35% more damage!'; }
      else if (picked === 'Integrity') { defender._missNextAttack = true; msg += 'Enemy has 10% miss chance next attack!'; }
      else if (picked === 'Patience') { defender.addStatus('stun'); msg += 'Enemy stunned!'; }
      else if (picked === 'Perseverance') { attacker._blockNextHit = true; msg += 'Next hit against you is blocked!'; }
      __pa = { success: true, message: msg, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'spearImpale') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < 0.3) {
        const s = Math.random() < 0.5 ? 'bleed' : 'flinch';
        defender.addStatus(s); sm = ` **${s.charAt(0).toUpperCase() + s.slice(1)}!**`;
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'specialAttack') {
      let __pa = null;

        if (Math.random() < ability.special.failChance) {
          defender.defMod += ability.special.defBoostOnFail;
          ability.cooldownLeft = (ability.special.cooldown || 3) + 1;
          return { ability: ability.name, abilityType: ability.type, message: `**${defender.name}** used **${ability.name}**... but it **failed**! +${ability.special.defBoostOnFail} DEF instead.`, damage: 0 };
        }
      
    }

    if (ability.special?.type === 'spineColumn') {
      let __pa = null;

      let finalDmg = 60;
      if (attacker._auraFarmActive) { finalDmg = Math.floor(finalDmg * (attacker.passive?.multiplier || 1.5)); attacker._auraFarmActive = false; }
      defender.takeDamage(finalDmg);
      defender.addStatus('bleed');
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${finalDmg}** fixed damage! **Bleed applied!**`, damage: finalDmg };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'spotlightGB') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      attacker._spotlightTurns = ability.special.accuracyTurns || 2;
      let stunMsg = '';
      if (Math.random() < (ability.special.stunChance || 0.3)) { const sr = defender.addStatus('stun'); if (sr) stunMsg = ' **Stunned!**'; }
      // Magic move builds Core Charge
      if (attacker.passive?.type === 'coreOverload' && hasPassiveUnlocked(attacker.level) && !attacker._coreDisabled) {
        attacker._coreCharge = (attacker._coreCharge || 0) + 1;
        if (attacker._coreCharge >= 3) { attacker._coreOverloadSurge = true; attacker._coreCharge = 0; }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} 100% accuracy for 2 turns!${stunMsg}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'starDevastation') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let total = d.totalDamage; let splitMsg = '';
      if (Math.random() < (ability.special.splitChance || 0.3) && defender.isAlive) {
        const splitDmg = Math.max(1, Math.floor(d.totalDamage * (ability.special.splitMultiplier || 0.5)));
        defender.takeDamage(splitDmg); total += splitDmg; splitMsg = ` Star split for an extra **${splitDmg}** dmg!`;
      }
      // --- UPDATE 22: 10% chance to inflict Star Shards for 2 turns ---
      if (ability.special.starShardsChance && Math.random() < ability.special.starShardsChance && defender.isAlive) {
        defender._starShardsStacks = (defender._starShardsStacks || 0) + 1;
        defender._starShardsTurns = ability.special.starShardsDuration || 2;
        splitMsg += ' 🌟 **Star Shards inflicted!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${total}** damage!${d.isCrit ? ' **CRIT!**' : ''}${splitMsg}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'starRain') {
      if (attacker._starRainUsed) {
        return { success: false, message: `**${ability.name}** can only be used **ONCE per battle!**` };
      }
      const dmg = ability.damageMin || 125;
      defender.takeDamage(dmg);
      attacker._starRainUsed = true;
      const emoji = TYPES[ability.type]?.emoji || '';
      log.push(`**${attacker.name}** calls down **STAR RAIN** ${emoji}! ⭐ **${dmg}** stellar damage!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    if (ability.special?.type === 'stolenMagic') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      const choices = ['toriel', 'papyrus', 'undyne', 'mettaton', 'asgore'];
      const pick = choices[Math.floor(Math.random() * choices.length)];
      let stealMsg = '';
      if (pick === 'toriel') { const sr = defender.addStatus('burn'); if (sr) stealMsg = ' Stole from Toriel — **Burn applied!**'; }
      else if (pick === 'papyrus') { const sr = defender.addStatus('blueSoul'); if (sr) stealMsg = ' Stole from Papyrus — **Blue Soul applied!**'; }
      else if (pick === 'undyne') { attacker.critBoost = (attacker.critBoost || 0) + 0.25; stealMsg = ' Stole from Undyne — **+25% crit chance next turn!**'; }
      else if (pick === 'mettaton') { const extra = Math.floor(d.totalDamage * 0.5); defender.takeDamage(extra); stealMsg = ` Stole from Mettaton — pierced for **+${extra}** dmg!`; }
      else if (pick === 'asgore') { defender._skipNextTurn = true; stealMsg = ' Stole from Asgore — enemy **skips next turn!**'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${stealMsg}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'stolenNeoTech') {
      let __pa = null;

      if (Math.random() < (ability.special.failChance || 0.25)) {
        const selfDmg = ability.special.selfDamage || 25;
        attacker.hp = Math.max(1, attacker.hp - selfDmg);
        const emoji = TYPES[ability.type]?.emoji || '';
        __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** tried **${ability.name}** ${emoji}! It backfired — took **${selfDmg}** self damage!`, damage: 0 };
        if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
      }
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'strangulation') {
      let __pa = null;

      let total = 0; let sm = '';
      for (let i = 0; i < ability.special.hits; i++) {
        if (!defender.isAlive) break;
        const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage;
        if (Math.random() < ability.special.debuffChance) {
          defender.atkMod -= 1; defender.defMod -= 1;
          defender._chokedStacks = (defender._chokedStacks || 0) + 1;
          defender._chokedTurns = (defender._chokedStacks || 0);
          sm += ` **Choked!** (-1 DEF, stacks: ${defender._chokedStacks})`;
        }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${total}** total damage!${sm}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'stringSlam') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < ability.special.stunChance) { defender.addStatus('stun'); sm += ' **Stunned!**'; }
      if (Math.random() < ability.special.weakenChance) { defender._weakenedNext = true; sm += ' Enemy\'s next move weakened!'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'sunBurn') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let burnMsg = '';
      if (Math.random() < (ability.special.hellfireChance || 0.33)) {
        const sr = defender.addStatus('hellfire');
        if (sr) burnMsg = ' **HELLFIRE applied!**';
        // --- UPDATE 22: Hellfire landing destroys enemy DEF and grants Outerdust DEF ---
        if (sr && ability.special.hellfireDefDestroy) {
          defender.defMod -= ability.special.hellfireDefDestroy;
          attacker.defMod += (ability.special.selfDefGain || 0);
          burnMsg += ` Enemy **-${ability.special.hellfireDefDestroy} DEF**, ${attacker.name} **+${ability.special.selfDefGain || 0} DEF**!`;
        }
      } else {
        const burnKey = (ability.special.burnDuration || 2) >= 3 ? 'burn3' : 'burn';
        const sr = defender.addStatus(burnKey);
        if (sr) burnMsg = ' **Burn applied!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${burnMsg}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'systemSabotage') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let lockMsg = '';
      if (Math.random() < (ability.special.lockChance || 0.5)) {
        defender._sabotageLock = 1; // 1 turn
        lockMsg = ' **System sabotaged!** Damaging/healing moves locked next turn!';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${lockMsg}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'telekineticSlam') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      const low = (attacker.currentHp / attacker.maxHp) < 0.40;
      let sm = '';
      if (Math.random() < ability.special.blueSoulChance) { defender.addStatus('blueSoul'); const bs = defender.statusEffects.find(st => st.name === 'Blue Soul'); if (bs) bs.turnsLeft = ability.special.blueSoulDuration; sm += ' 💙 **Blue Soul!**'; }
      const stunChance = low ? ability.special.lowStunChance : ability.special.stunChance;
      if (Math.random() < stunChance) { defender.addStatus('stun'); sm += ' **Stun!**'; if (low) { defender.addStatus('boneZone'); const bz = defender.statusEffects.find(st => st.name === 'Bone Zone'); if (bz) bz.turnsLeft = 2; sm += ' 🦴 **Bone Zone!**'; } }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'tentacleShield') {
      let __pa = null;

      attacker._tentacleShieldHp = ability.special.shieldAmount || 90;
      __pa = { success: true, message: `**${attacker.name}** used **${ability.name}**! 🛡️ **+${ability.special.shieldAmount || 90} Shield HP**! Tentacle Barrage disabled until shield breaks!`, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'theContract') {
      let __pa = null;

      const minTurn = ability.special.minTurn || 3;
      if ((this.turnNumber || 0) < minTurn) {
        __pa = { success: false, message: `**${ability.name}** can only be used after turn ${minTurn}!` };
        return { success: false, message: (__pa && __pa.message) || 'Move failed!' };
      }
      defender._contractRecoilTurns = ability.special.duration || 2;
      defender._contractRecoilPercent = ability.special.recoilPercent || 0.15;
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** activated **${ability.name}** ${emoji}! For ${ability.special.duration || 2} turns, enemy attacks deal 15% recoil!`, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'theCross') {
      let __pa = null;

      attacker._blessingTurns = ability.special.blessingDuration || 2;
      attacker.addStatus('blessing');
      __pa = { success: true, message: `**${attacker.name}** used **The Cross**! 🙏 **Blessing** for ${attacker._blessingTurns} turns — negates 30% of damage taken and heals for the negated amount!`, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'theFinalBargain') {
      let __pa = null;

      if (this.turnNumber < (ability.special.minTurn || 4)) { __pa = { success: false, message: `**The Final Bargain** can only be used after turn ${ability.special.minTurn || 4}!` }; return { success: false, message: (__pa && __pa.message) || 'Move failed!' }; }
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      const killed = !defender.isAlive;
      const selfDmg = killed ? (ability.special.killSelfDmg || 10) : (ability.special.selfDmg || 20);
      attacker.currentHp = Math.max(1, attacker.currentHp - selfDmg);
      let sm = ` (Self: ${selfDmg} dmg)`;
      if (killed) { attacker.atkMod += (ability.special.killAtkBoost || 2); sm += ` 💀 **The deal is done!** +${ability.special.killAtkBoost || 2} ATK! No cooldown!`; }
      else { ability.cooldownLeft = ability.special.cooldown || 2; }
      if (attacker.passive?.type === 'lethalExchange') { attacker._lethalMeleeHit = true; attacker._lethalMagicBoost = attacker.passive.magicBoost || 1.2; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **The Final Bargain**! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (killed) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'theOneInControl') {
      let __pa = null;

      let total = 0; let hits = 0;
      for (let i = 0; i < ability.special.hits; i++) {
        if (!defender.isAlive) break;
        if (Math.random() < ability.special.hitChance) {
          const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage; hits++;
          defender._retributionStacks = (defender._retributionStacks || 0) + 1;
          defender._krStacks = (defender._krStacks || 0) + 1;
        }
      }
      const krDmg = defender._krStacks || 0;
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **The One in Control**! ${hits} hits landed for **${total}** damage! KR: **${krDmg}** stacks (deals ${krDmg} dmg next turn, then disappears).`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'tommyGunBurst') {
      let __pa = null;

      const minH = ability.special.minHits || 2; const maxH = ability.special.maxHits || 6;
      const hits = Math.floor(Math.random() * (maxH - minH + 1)) + minH;
      let total = 0; let bleedApplied = false;
      for (let i = 0; i < hits; i++) {
        if (!defender.isAlive) break;
        const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage;
        if (!bleedApplied && Math.random() < (ability.special.bleedPerHit || 0.05)) { const sr = defender.addStatus('bleed'); if (sr) bleedApplied = true; }
      }
      let weakenMsg = '';
      if (hits >= (ability.special.weakenThreshold || 4)) { defender._tommyGunWeaken = 0.10; weakenMsg = ' Enemy\'s next move deals 10% less!'; }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! ${hits} hits for **${total}** damage!${bleedApplied ? ' **Bleed!**' : ''}${weakenMsg}`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'trioBlasters') {
      let __pa = null;

      let total = 0, msg = `**${attacker.name}** used **${ability.name}**!`, karmaApplied = false;
      for (let i = 0; i < 3; i++) {
        const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage); total += d.totalDamage;
        msg += ` Hit ${i+1}: **${d.totalDamage}**${d.isCrit ? ' (CRIT)' : ''}!`;
        if (!defender.isAlive) break;
      }
      if (Math.random() < ability.special.karmaChance) { defender.addStatus('karma'); msg += ' **Karma** applied!'; }
      __pa = { success: true, message: msg, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'trueGenocide') {
      let __pa = null;

      const low = (attacker.currentHp / attacker.maxHp) < 0.40;
      if (low) attacker.critBoost = (attacker.critBoost || 0) + ability.special.lowCritBonus;
      const d = this.calculateDamage(attacker, ability, defender);
      if (low) attacker.critBoost = Math.max(0, (attacker.critBoost || 0) - ability.special.lowCritBonus);
      const hpLost = attacker.maxHp - attacker.currentHp;
      const bonus = Math.min(ability.special.maxBonus, Math.floor(hpLost / ability.special.perHpLost) * ability.special.bonusPer);
      const dmg = d.totalDamage + bonus;
      defender.takeDamage(dmg);
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${dmg}** damage!${bonus > 0 ? ` (+${bonus} from lost HP)` : ''}${d.isCrit ? ' **CRIT!**' : ''}`, damage: dmg };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'trulyDustedBeing') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender);
      defender.takeDamage(d.totalDamage);
      let bonusMsg = '';
      let stunDur = ability.special.normalStunDuration || 1;
      let totalDmg = d.totalDamage;
      if (Math.random() < (ability.special.doubleSwingChance || 0.05)) {
        const bonus = ability.special.doubleSwingBonusDmg || 10;
        defender.takeDamage(bonus);
        totalDmg += bonus;
        stunDur = ability.special.doubleSwingStunDuration || 2;
        bonusMsg = ` 🌀 **Double swing!** +${bonus} damage!`;
      }
      defender.addStatus('stun');
      const s = defender.statusEffects.find(s => s.name === 'Stun');
      if (s) s.turnsLeft = stunDur;
      const gr = defender.addStatus('glitched'); const g = defender.statusEffects.find(s => s.name === 'Glitched'); if (g) g.turnsLeft = ability.special.glitchedDuration || 1;
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${totalDmg}** damage!${d.isCrit ? ' **CRIT!**' : ''}${bonusMsg} 💫 **Stunned** for ${stunDur} turn(s)! 🔀 **Glitched**!`, damage: totalDmg };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'tsBlueSoul') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let sm = '';
      if (Math.random() < (ability.special.chance || 0.25)) {
        if ((defender._tsBlueSoulTurns || 0) > 0) sm = ' *(Blue Soul already active — cannot stack)*';
        else if ((defender._tsBlueSoulLockout || 0) > 0) sm = ' *(Blue Soul can\'t be re-applied right after it ends)*';
        else {
          defender._tsBlueSoulTurns = ability.special.duration || 2;
          defender._tsDisabledPassive = defender.passive;
          defender.passive = null;
          sm = ' 💙 **Blue Soul** — enemy passive disabled for 2 turns!';
        }
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${sm}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'tsunami') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      attacker.defMod += ability.special.selfDef;
      defender.defMod += ability.special.enemyDef;
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **TSUNAMI** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} Both sides -2 DEF!`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'unseenSentence') {
      let __pa = null;

      const hpPct = attacker.currentHp / attacker.maxHp;
      if (hpPct > ability.special.hpThreshold) {
        __pa = { success: false, message: `**The Unseen Sentence** can only be used below 15% HP!` };
        ability.currentUses++; ability.cooldownLeft = 0; attacker._usedAbilityThisTurn = false; attacker._attackedThisTurn = false; return { success: false, message: (__pa && __pa.message) || 'Move failed!' };
      }
      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      defender.addStatus('stun');
      defender.atkMod -= 2; // permanent ATK reduction
      __pa = { success: true, message: `**${attacker.name}** used **${ability.name}**! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} **Stunned!** Enemy ATK permanently -2!`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'vengefulRend') {
      let __pa = null;

      const roll = Math.random();
      let abilityCopy = { ...ability };
      let bonusMsg = '';
      if (roll < 1/3) {
        // Burn
        const d = this.calculateDamage(attacker, abilityCopy, defender); defender.takeDamage(d.totalDamage);
        const sr = defender.addStatus('burn'); if (sr) bonusMsg = ' **Burn!**';
        const emoji = TYPES[ability.type]?.emoji || '';
        __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${bonusMsg}`, damage: d.totalDamage };
      } else if (roll < 2/3) {
        // Stun
        const d = this.calculateDamage(attacker, abilityCopy, defender); defender.takeDamage(d.totalDamage);
        const sr = defender.addStatus('stun'); if (sr) bonusMsg = ' **Stunned!**';
        const emoji = TYPES[ability.type]?.emoji || '';
        __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${bonusMsg}`, damage: d.totalDamage };
      } else {
        // Boosted damage only (1.25x)
        abilityCopy.damageMin = Math.floor(ability.damageMin * 1.25);
        abilityCopy.damageMax = Math.floor(ability.damageMax * 1.25);
        const d = this.calculateDamage(attacker, abilityCopy, defender); defender.takeDamage(d.totalDamage);
        const emoji = TYPES[ability.type]?.emoji || '';
        __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''} *(Boosted!)*`, damage: d.totalDamage };
      }
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'vineOvergrowth') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let extras = '';
      if (Math.random() < (ability.special.stunChance || 0.2)) {
        // 2-turn stun
        const sr = defender.addStatus('stun'); if (sr) {
          const eff = defender.statusEffects.find(s => s.id === 'stun');
          if (eff) eff.turnsLeft = ability.special.stunDuration || 2;
          extras += ' **Stunned 2 turns!**';
        }
      }
      if (Math.random() < (ability.special.bleedChance || 0.3)) {
        const sr = defender.addStatus('bleed'); if (sr) extras += ' **Bleed!**';
      }
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${extras}`, damage: d.totalDamage };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'voidsHell') {
      let __pa = null;

      const d = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d.totalDamage);
      let total = d.totalDamage; let sm = '';
      if (Math.random() < (ability.special.doubleChance || 0.30)) { const d2 = this.calculateDamage(attacker, ability, defender); defender.takeDamage(d2.totalDamage); total += d2.totalDamage; sm = ' **Gaster slams twice!**'; }
      defender.addStatus('blindness');
      const emoji = TYPES[ability.type]?.emoji || '';
      __pa = { success: true, abilityType: ability.type, message: `**${attacker.name}** used **${ability.name}** ${emoji}! **${total}** damage!${sm} **Blindness!**`, damage: total };
      if (!defender.isAlive) { if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() }; }
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    if (ability.special?.type === 'zaWarudo') {
      let __pa = null;

      defender.skipNextTurn = true;
      if (defender.isCharging) { defender.isCharging = false; defender.chargedAbility = null; }
      __pa = { success: true, message: `**${attacker.name}** used **ZA WARUDO!** Time stops! Enemy's next turn is skipped!`, damage: 0 };
      if (__pa) log.push(__pa.message); this.postTurn(attacker, defender, log); return { success: true, log, battleEnd: this.checkEnd() };
    
    }

    // NORMAL DAMAGE
    const d = this.calculateDamage(attacker, ability, defender);

    // --- Miss check for normal fallthrough (blindness/concussion on attacker) ---
    if (ability.damageMax > 0) {
      const miss = attacker.consumeAttackMiss();
      if (miss) {
        const missMsg = miss.source === 'blindness' ? '**Blindness** caused the attack to miss!' : 'the attack missed!';
        log.push(`**${attacker.name}** used **${ability.name}**... but ${missMsg}`);
        this.postTurn(attacker, defender, log);
        return { success: true, log, battleEnd: this.checkEnd() };
      }
    }

    // Check dodge
    if (defender.dodgeNextAttack && !defender._noDodge) {
      defender.dodgeNextAttack = false;
      log.push(`**${attacker.name}** used **${ability.name}**... **${defender.name}** dodged!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // Foresight (FT!Sans) — 20% dodge
    if (defender.passive?.type === 'foresight' && hasPassiveUnlocked(defender.level) && Math.random() < defender.passive.chance) {
      log.push(`**${attacker.name}** used **${ability.name}**... **${defender.name}** saw it coming! (**Foresight** dodged!)`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // Ink Trail (Shanghaivania) — 20% miss
    if (defender._inkTrailActive && Math.random() < 0.2) {
      log.push(`**${attacker.name}** used **${ability.name}**... 🎨 **Ink Trail** blurred their vision — missed!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // UV Swap Sans parry — 20% chance to take 70% dmg and reflect 30%
    if (defender.passive?.type === 'uvParry' && hasPassiveUnlocked(defender.level) && Math.random() < defender.passive.chance) {
      const reduced = Math.floor(d.totalDamage * 0.7);
      const reflect = Math.floor(d.totalDamage * 0.3);
      defender.takeDamage(reduced);
      attacker.takeDamage(reflect);
      log.push(`**${attacker.name}** used **${ability.name}**... **${defender.name}** parried! (**Locked tf in**) Took **${reduced}**, reflected **${reflect}**!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // Check passive dodge (UPDATE 32: _noDodge holders never dodge)
    if (!defender._noDodge && defender.passive?.type === 'dodge' && hasPassiveUnlocked(defender.level) && Math.random() < defender.passive.chance) {
      log.push(`**${attacker.name}** used **${ability.name}**... **${defender.name}** dodged! (**${defender.passive.name}**)`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // Check parry
    if (defender.parrying) {
      const reflectMult = getTypeMultiplier('Weapon', attacker.type);
      const reflectDmg = Math.max(1, Math.floor(d.totalDamage * reflectMult));
      attacker.takeDamage(reflectDmg);
      defender.parrying = false;
      log.push(`**${attacker.name}** attacked... **${defender.name}** parried! **${reflectDmg}** reflected!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // Omniversal Prodigy (Avenge Sans) — parry incoming attacks, counter 30%, chance to stun
    if (defender.passive?.type === 'omniversalProdigy' && hasPassiveUnlocked(defender.level) && ability.damageMax > 0 && Math.random() < defender.passive.parryChance) {
      const _opTypeMult = getTypeMultiplier(ability.type, defender.type);
      const _opRaw = (ability.damageMin + ability.damageMax) / 2;
      const _opEst = ((_opRaw * (attacker.atk * _opTypeMult)) / defender.def);
      const _opReflect = Math.floor(_opEst * (defender.passive.counterPercent || 0.30));
      let _opMsg = '';
      if (_opReflect > 0) { attacker.takeDamage(_opReflect); _opMsg += ` Countered for **${_opReflect}**!`; }
      if (Math.random() < (defender.passive.counterStunChance || 0.30)) { const sr = attacker.addStatus('stun'); if (sr) _opMsg += ' **Stunned!**'; }
      log.push(`**${attacker.name}** used **${ability.name}**... ⚔️ **Omniversal Prodigy** parried the attack!${_opMsg}`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    // Bone Wall counter (set by Shattered BoneWall on the defender's previous turn)
    if (attacker._boneWallCounter && ability.damageMax > 0) {
      const c = attacker._boneWallCounter; attacker._boneWallCounter = 0;
      attacker.takeDamage(c);
      log.push(`🦴 **Bone Wall** counter — ${attacker.name} takes **${c}** recoil!`);
    }
    // Bone Shards recoil — attacker using Melee/Weapon takes recoil
    if (attacker._boneShardsTurns > 0 && (ability.type === 'Melee' || ability.type === 'Weapon')) {
      const r = attacker._boneShardsRecoil || 0;
      attacker.takeDamage(r);
      log.push(`🦴 **Bone Shards** recoil — ${attacker.name} takes **${r}** damage!`);
    }
    // Magic recoil (Avenge Sword Beam)
    if (attacker._magicRecoilNext && ability.type === 'Magic') {
      const r = attacker._magicRecoilNext; attacker._magicRecoilNext = 0;
      attacker.takeDamage(r);
      log.push(`✨ **Magic recoil** — ${attacker.name} takes **${r}** damage!`);
    }

    // Omni Deflect (Weak Avenge Sans) — counter on Melee
    if (defender._omniDeflectActive && ability.type === 'Melee' && ability.damageMax > 0) {
      const counter = (defender._omniDeflectBase || 0) + d.totalDamage;
      attacker.takeDamage(counter);
      defender._omniDeflectActive = false; defender._omniDeflectTriggered = true;
      log.push(`⚔️ **Omni Deflect!** ${defender.name} parried! Counter-strike for **${counter}** damage!`);
      this.postTurn(attacker, defender, log);
      return { success: true, log, battleEnd: this.checkEnd() };
    }

    defender.takeDamage(d.totalDamage);
    // Will to Avenge — gain Spite stack on damage
    if (defender.passive?.type === 'willToAvenge' && d.totalDamage > 0) {
      defender._spiteStacks = Math.min(10, (defender._spiteStacks || 0) + 1);
    }
    let te = ''; if (d.typeMult > 1.5) te = ' **Super effective!**'; else if (d.typeMult < 0.75) te = ' *Not very effective...*';
    let sm = '';
    if (ability.special?.type === 'poison' && Math.random() < ability.special.chance) { defender.addStatus('poison'); sm += ' **Poisoned!**'; }
    if (ability.special?.type === 'karma' && Math.random() < (ability.special.chance || 1.0)) {
      const sr = defender.addStatus('karma');
      const k = defender.statusEffects?.find(s => s.name === 'Karma');
      if (k && ability.special.duration) k.turnsLeft = ability.special.duration;
      if (sr) sm += ` ☯️ **Karma** applied for ${ability.special.duration || 2} turn(s)!`;
    }
    if (ability.special?.type === 'flashBlast' && Math.random() < (ability.special.chance || 0.35)) {
      if (Math.random() < 0.5) { defender.addStatus('poison'); sm += ' **Poisoned!**'; }
      else { defender.addStatus('blueSoul'); sm += ' **Blue Soul applied!**'; }
    }
    if (ability.special?.type === 'bleed' && Math.random() < (ability.special.chance || 0)) { defender.addStatus('bleed'); sm += ' **Bleed!**'; }
    if (ability.special?.type === 'stun' && Math.random() < (ability.special.chance || 0)) { defender.addStatus('stun'); sm += ' **Stunned!**'; }
    if (ability.special?.type === 'multiHit') {
      const hits = Math.floor(Math.random() * ((ability.special.maxHits||1) - (ability.special.minHits||1) + 1)) + (ability.special.minHits||1);
      let total = d.totalDamage;
      for (let i = 1; i < hits; i++) { const h = this.calculateDamage(attacker, ability, defender); defender.takeDamage(h.totalDamage); total += h.totalDamage; }
      if (ability.special.poisonChance && Math.random() < ability.special.poisonChance) { defender.addStatus('poison'); sm += ' **Poisoned!**'; }
      if (ability.special.stunChance && Math.random() < ability.special.stunChance) { defender.addStatus('stun'); sm += ' **Stunned!**'; }
      if (ability.special.karmaChance && Math.random() < ability.special.karmaChance) { defender.addStatus('karma'); sm += ' **Karma!**'; }
      sm = ` ${hits} hits, **${total}** total!${sm}`;
    }
    const emoji = TYPES[ability.type]?.emoji || '';
    log.push(`**${attacker.name}** used **${ability.name}** ${emoji}! **${d.totalDamage}** damage!${d.isCrit ? ' **CRIT!**' : ''}${te}${sm}`);

    // Counter magic passive
    if (defender.passive?.type === 'counterMagic' && hasPassiveUnlocked(defender.level) && ability.type === 'Magic') {
      attacker.atkMod -= defender.passive.atkReduction;
      attacker.defMod -= defender.passive.defReduction;
      log.push(`**${defender.passive.name}** activated! ${attacker.name} -${defender.passive.atkReduction} ATK, -${defender.passive.defReduction} DEF!`);
    }

    attacker.critBoost = 0;
    this.postTurn(attacker, defender, log);
    return { success: true, log, battleEnd: this.checkEnd() };
  }

  releaseCharged(playerId) {
    const attacker = this.getAttacker();
    if (!attacker.isCharging || attacker.chargedAbility === null) return null;
    attacker.isCharging = false;
    const i = attacker.chargedAbility;
    attacker.chargedAbility = null;
    attacker.isReleasing = true;
    const result = this.executeAbility(playerId, i);
    attacker.isReleasing = false;
    return result;
  }

  postTurn(attacker, defender, log) {
    // --- SCAMTON EVENT: Power Points — 10% of damage dealt this turn (effects excluded) ---
    if (attacker.hasPP && attacker.hasPP() && (attacker._ppDamageThisTurn || 0) > 0) {
      const gained = attacker.gainPP((attacker._ppDamageThisTurn) * (attacker.passive.ratio || 0.10));
      if (gained > 0) log.push(`⚡ **${attacker.name}** gained **+${gained} PP** (${attacker._pp}/${attacker.maxPP})`);
    }
    attacker._ppDamageThisTurn = 0;
    // A guard armed on a PREVIOUS turn has already had its chance — drop it now.
    if (attacker._rewrittenGuard && attacker._rewrittenGuardArmedTurn !== undefined && attacker._rewrittenGuardArmedTurn !== this.turnNumber) {
      if (attacker._rewrittenGuardAbsorbed > 0) log.push(`🛡️ **${attacker.name}** tanked **${attacker._rewrittenGuardAbsorbed}** damage with **${attacker._rewrittenGuard.label}**!${attacker._rewrittenGuardPPGain ? ` **+${attacker._rewrittenGuardPPGain} PP**` : ''}`);
      attacker._rewrittenGuard = null; attacker._rewrittenGuardAbsorbed = 0; attacker._rewrittenGuardPPGain = 0;
    } else if (attacker._rewrittenGuard) {
      attacker._rewrittenGuardArmedTurn = this.turnNumber;
    }
    // --- UPDATE 31: Papyrus/? Blue Bones trap — the trapped fighter attacked, so they get Goop ---
    if (attacker._papQBlueBoneTrap > 0 && attacker._attackedThisTurn) {
      const _src = attacker._papQBlueBoneSource;
      const _st = attacker._applyGoop(attacker, attacker._papQBlueBoneTrap, _src);
      attacker._papQBlueBoneTrap = 0;
      log.push(`🫠 **Blue Bones** trigger — **${attacker.name}** is covered in **Goop**! (**${_st}** stacks)`);
    }
    // --- UPDATE 31: Unnamed Kindness "Block" — resolve reflect + stun against the attacker ---
    if (defender._kindnessReflectPending) {
      const _kp = defender._kindnessReflectPending; defender._kindnessReflectPending = null;
      if (_kp.reflect > 0) {
        attacker.takeDamage(_kp.reflect);
        log.push(`🛡️ **Block!** ${defender.name} reflects **${_kp.reflect}** damage back!`);
        if (_kp.stun && attacker.addStatus('stun')) log.push(`💫 **${attacker.name} is stunned!**`);
      }
    }
    // --- UPDATE 31: Goop is removed when the Melting one dies ---
    for (const _f of [attacker, defender]) {
      if (!_f.isAlive && (_f.passive?.type === 'itHurtsPap' || _f.passive?.type === 'itHurts')) {
        _f._clearGoopFrom(_f === attacker ? defender : attacker, _f.id);
      }
    }
    // UPDATE 30: Toxin — switch-back timer
    { const _isP1 = this.team1.includes(attacker); const _key = _isP1 ? '_toxinSwap1' : '_toxinSwap2'; const _sw = this[_key];
      if (_sw) { if (_sw.justCast) { _sw.justCast = false; } else { _sw.returnTurns--; if (_sw.returnTurns <= 0) { const _ti = _sw.toxinIndex; const _team = _isP1 ? this.team1 : this.team2; if (_team[_ti] && _team[_ti].isAlive) { if (_isP1) this.active1 = _ti; else this.active2 = _ti; log.push('Toxin returns to the field!'); } this[_key] = null; } } } }
    // Batch 2: per-turn passives (ported from PvE engine)
    this.applyPvPTurnPassives(attacker, defender, log);
    // Status effects
    // --- UPDATE 32: Doki Meter — skipping your turn grants +1 Doki ---
    if (attacker.passive?.type === 'dokiMeter' && hasPassiveUnlocked(attacker.level) && !attacker._usedAbilityThisTurn) {
      attacker._doki = (attacker._doki || 0) + (attacker.passive.skipDoki || 1);
      log.push(`🩷 **Doki Meter** — ${attacker.name} skipped and gained **+1 Doki**! (${attacker._doki}/${attacker.passive.threshold || 5})`);
    }
    // --- UPDATE 32: Superb Karaoke — tick the window, restore the victim's passive ---
    for (const _kf of [attacker, defender]) {
      if (_kf._karaokeAbsorbTurns > 0) {
        _kf._karaokeAbsorbTurns--;
        if (_kf._karaokeAbsorbTurns <= 0) {
          if (_kf._karaokePassiveStash !== undefined) { _kf.passive = _kf._karaokePassiveStash; _kf._karaokePassiveStash = undefined; }
          _kf._karaokeAbsorber = null;
          log.push(`🎤 **Superb Karaoke** ends — ${_kf.name}'s passive returns.`);
        }
      }
    }
    const atkActionStatus = attacker._usedAbilityThisTurn ? attacker.processActionStatusEffects(attacker._attackedThisTurn) : [];
    atkActionStatus.forEach(s => { if (s.damage) log.push(`**${attacker.name}** takes **${s.damage}** ${s.name} damage!`); });
    attacker._usedAbilityThisTurn = false;
    attacker._attackedThisTurn = false;
    const atkStatus = attacker.processStatusEffects();
    atkStatus.forEach(s => { if (s.damage) log.push(`**${attacker.name}** takes **${s.damage}** ${s.name} damage!`); });
    // NOTE: Do NOT tick the defender's status effects here. In combat.js each fighter's
    // statuses tick on their OWN turn. Ticking the defender here consumes a freshly-applied
    // Stun/Flinch/Frozen (and DoTs) before the defender ever gets a turn — which is why stuns
    // never landed in PvP. The defender's statuses tick when they become the attacker next turn.

    // Tick temp debuffs (Fracture Strike etc)
    this.tickTempDebuffs(attacker);
    this.tickTempDebuffs(defender);

    // Tick BLOCKED counter
    if (attacker._blockedActive > 0) attacker._blockedActive--;

    // Passives
    if (hasPassiveUnlocked(attacker.level) && attacker.passive?.type === 'atkBoost') attacker.passiveAtkAccumulated += attacker.passive.amount;
    if (hasPassiveUnlocked(attacker.level) && attacker.passive?.type === 'murderPassive') {
      if (!attacker._lastTurnCount) attacker._lastTurnCount = 0;
      if (attacker.turnCount > attacker._lastTurnCount) {
        attacker._lastTurnCount = attacker.turnCount;
        attacker.passiveAtkAccumulated = Math.max(-(attacker.passive.maxBonus), attacker.passiveAtkAccumulated - attacker.passive.lossPerAttack);
      }
    }

    // Cooldowns
    attacker.tickCooldowns();

    // --- SINGULARITY release (PvP) ---
    // combat.js decrements this timer + detonates in its own turn loop, which PvP
    // never runs. Without this, _singularityTurns stays > 0 forever and Fighter.takeDamage
    // absorbs ALL incoming damage indefinitely (the "Outerdust immortality" bug).
    if (attacker._singularityTurns > 0 || defender._singularityTurns > 0) {
      if (attacker._singularityTurns > 0) attacker._singularityTurns--;
      if (defender._singularityTurns > 0) defender._singularityTurns--;
      if (attacker._singularityTurns <= 0 && defender._singularityTurns <= 0) {
        const stored = (attacker._singularityStored || 0) + (defender._singularityStored || 0);
        const dmg = Math.floor(stored * 0.7);
        attacker.currentHp = Math.max(0, attacker.currentHp - dmg);
        defender.currentHp = Math.max(0, defender.currentHp - dmg);
        log.push(`🌌 **SINGULARITY** collapses! Both fighters take **${dmg}** stored damage!`);
        attacker._singularityStored = 0; defender._singularityStored = 0;
        attacker._singularityTurns = 0; defender._singularityTurns = 0;
      }
    }

    // Dying Will (CATASTROPHE!FELL) — loses ATK/DEF every 2 turns
    if (attacker.isAlive && attacker.passive?.type === 'dyingWill' && attacker.passive.alwaysActive) {
      if (!attacker._dyingWillTurn) attacker._dyingWillTurn = 0;
      attacker._dyingWillTurn++;
      if (attacker._dyingWillTurn % (attacker.passive.interval || 2) === 0) {
        const atkDrop = attacker.passive.atkLoss || 3;
        const defDrop = attacker.passive.defLoss || 2;
        if (attacker.atk > 0) attacker.atkMod = Math.max(-attacker.baseAtk, attacker.atkMod - atkDrop);
        if (attacker.def > 0) attacker.defMod = Math.max(-attacker.baseDef, attacker.defMod - defDrop);
        log.push(`🔥 **Dying Will** burns **${attacker.name}**! -${atkDrop} ATK, -${defDrop} DEF!`);
      }
    }

    // The King Will. (StoryShift! Sans) — 15% ATK debuff on defender per turn
    if (hasPassiveUnlocked(attacker.level) && attacker.passive?.type === 'theKingWill') {
      if (Math.random() < attacker.passive.chance) { defender.atkMod -= 1; log.push(`👑 **The King Will.** — ${defender.name} ATK -1!`); }
    }

    // Rose's Assistant (C!Insanity Weak) — heal per turn
    if (hasPassiveUnlocked(attacker.level) && attacker.passive?.type === 'rosesAssistant') {
      const h = attacker.heal(attacker.passive.healAmount);
      if (h > 0) log.push(`🌹 **Rose's Assistant** — ${attacker.name} healed **${h} HP**!`);
    }
    // Rose's Support (C!Insanity) — heal per turn + 10% +1 DEF
    if (hasPassiveUnlocked(attacker.level) && attacker.passive?.type === 'rosesSupport') {
      const h = attacker.heal(attacker.passive.healAmount);
      let msg = h > 0 ? `🌹 **Rose's Support** — ${attacker.name} healed **${h} HP**!` : '';
      if (Math.random() < attacker.passive.defChance) { attacker.defMod += 1; msg += ` +1 DEF!`; }
      if (msg) log.push(msg);
    }
    // Will to Avenge (Weak Avenge Sans) — recompute crit boost from HP loss
    if (hasPassiveUnlocked(attacker.level) && attacker.passive?.type === 'willToAvenge') {
      const hpLostPct = 1 - (attacker.currentHp / attacker.maxHp);
      attacker.critBoost = Math.floor(hpLostPct * 10) * 0.05;
    }

    // --- UPDATE 12 TICKERS ---
    // Bone Shards
    for (const f of [attacker, defender]) {
      if (f._boneShardsTurns > 0) {
        f._boneShardsTurns--;
        if (f._boneShardsTurns <= 0) { f._boneShardsRecoil = 0; log.push(`🦴 **Bone Shards** on ${f.name} faded!`); }
      }
    }
    // Roar lockout
    for (const f of [attacker, defender]) {
      if (f._roarLockoutTurns > 0) f._roarLockoutTurns--;
    }
    // Universal Cut
    for (const f of [attacker, defender]) {
      if (f._universalCutTurns > 0) f._universalCutTurns--;
    }
    // Dazed
    for (const f of [attacker, defender]) {
      if (f._dazedTurns > 0) f._dazedTurns--;
    }
    // Disabled abilities
    for (const f of [attacker, defender]) {
      for (const a of f.abilities) {
        if (a._disabledTurns > 0) a._disabledTurns--;
      }
    }
    // Weak Avenge Bones temp ATK debuff revert
    for (const f of [attacker, defender]) {
      if (f._tempAtkRevertTurns > 0) {
        f._tempAtkRevertTurns--;
        if (f._tempAtkRevertTurns <= 0 && f._tempAtkRevertAmount) {
          f.atkMod += f._tempAtkRevertAmount;
          f._tempAtkRevertAmount = 0;
        }
      }
    }
    // Insanity threshold recompute
    for (const f of [attacker, defender]) {
      if (f._insanityStacks > 0) this._pvpCheckInsanity(null, f, log);
    }
    // Omni Deflect — if no Melee was used against attacker last turn, +1 DEF
    if (attacker._omniDeflectActive && !attacker._omniDeflectTriggered) {
      attacker.defMod += (attacker._omniDeflectDefGain || 1);
      log.push(`⚔️ No Melee was used. ${attacker.name} gained **+${attacker._omniDeflectDefGain || 1} DEF**!`);
    }
    attacker._omniDeflectActive = false; attacker._omniDeflectTriggered = false;

    // Manic Fixation (Dustrust Sans) — +2 ATK on kill
    if (!defender.isAlive && attacker.passive?.type === 'manicFixation') {
      attacker.passiveAtkAccumulated = (attacker.passiveAtkAccumulated || 0) + attacker.passive.atkPerKill;
      log.push(`💀 **Manic Fixation** — ${attacker.name} gains +${attacker.passive.atkPerKill} ATK permanently!`);
    }

    // Parasitic Desires (True Fresh) — +50 HP regen + 1 DEF on kill
    if (!defender.isAlive && attacker.passive?.type === 'parasiticDesires') {
      const h = attacker.heal(50); attacker.defMod += 1;
      log.push(`🦠 **Parasitic Desires** — ${attacker.name} regains ${h} HP and +1 DEF!`);
    }

    // Proper Burial (IDUTSHANE) — PvP only: skip next turn, heal 50 HP, +1 ATK, +2 DEF
    if (!defender.isAlive && attacker.passive?.type === 'properBurial') {
      const h = attacker.heal(50); attacker.atkMod += 1; attacker.defMod += 2; attacker.skipNextTurn = true;
      log.push(`⚰️ **Proper Burial** — ${attacker.name} heals ${h} HP, gains +1 ATK and +2 DEF, but will skip their next turn.`);
    }

    // Losing His Mind (Final Insanity) — heal 2x defender's [INSANITY] stacks when attacker hits
    if (attacker.passive?.type === 'losingHisMind' && (defender._insanityStacks || 0) > 0 && attacker._lastAbilityWasDamaging) {
      const heStacks = defender._insanityStacks;
      const healed = attacker.heal(heStacks * 2);
      if (healed > 0) log.push(`🧠 **Losing His Mind** — ${attacker.name} heals **${healed} HP** (2x ${heStacks} [INSANITY] stack(s))!`);
    }
    attacker._lastAbilityWasDamaging = false;

    // Patience Knives tick
    if (defender._patienceKnives) {
      const pk = defender._patienceKnives;
      defender.currentHp = Math.max(0, defender.currentHp - pk.damagePerTurn);
      pk.turnsLeft--;
      log.push(`🟣 **Patience Knives** — ${pk.damagePerTurn} damage to ${defender.name}! (${pk.turnsLeft} turn(s) left)`);
      if (pk.turnsLeft <= 0) {
        defender.currentHp = Math.max(0, defender.currentHp - pk.explodeDmg);
        log.push(`💥 **Patience Knives EXPLODE!** ${pk.explodeDmg} damage to ${defender.name}!`);
        defender._patienceKnives = null;
      }
    }

    // Ink Trail tick
    for (const f of [attacker, defender]) {
      if (f._inkTrailActive) {
        f._inkTrailTurns--;
        if (f._inkTrailTurns <= 0) { f._inkTrailActive = false; log.push(`🎨 **Ink Trail** on ${f.name} faded!`); }
      }
    }

    // Determination stage tick
    for (const f of [attacker, defender]) {
      if (f._determinationTurns > 0) {
        f._determinationTurns--;
        if (f._determinationTurns <= 0) {
          const stage = f._determinationStage || 1;
          f.atkMod -= stage * 2; f.defMod -= stage * 2; f._determinationStage = 0;
          log.push(`🔴 **Determination** boost on ${f.name} expired!`);
        }
      }
    }

    // Timeline Star tick
    if (attacker.savedStateTurnsLeft > 0) {
      const shouldRestore = attacker.tickTimeline();
      if (shouldRestore) { attacker.restoreState(); log.push(`**${attacker.name}**'s stats restored by **Timeline Star**!`); }
    }

    // Still Determined (Geno Sans) — survive at 0 HP for 1-2 more turns (checked before autoSwitch)
    for (const f of [attacker, defender]) {
      let justRevived = false;
      if (f.passive?.type === 'stillDetermined' && !f._stillDeterminedUsed && f.currentHp <= 0) {
        f._stillDeterminedUsed = true;
        f._stillDeterminedTurns = Math.random() < 0.1 ? 2 : 1;
        f.currentHp = 1;
        justRevived = true;
        log.push(`💾 **Still Determined!** ${f.name} clings on for ${f._stillDeterminedTurns} more turn(s)!`);
      }
      if (f._stillDeterminedTurns > 0 && !justRevived) {
        f._stillDeterminedTurns--;
        if (f._stillDeterminedTurns <= 0 && f.currentHp <= 1) f.currentHp = 0;
      }
    }

    // Auto-switch dead characters
    this.autoSwitch(log);

    // Parry only lasts through the opponent's next resolved action
    if (defender.parrying) defender.parrying = false;

    // Switch turn
    this.switchTurn();
  }

  // ===== Ported PvE helper methods (for parity in special handlers) =====
  applySmokeScreenPassive(attacker, defender) {
    if (attacker.passive?.type !== 'smokeScreen') return;
    if (!hasPassiveUnlocked(attacker.level)) return;
    if (attacker._smokeScreenCooldown > 0) return;
    if (Math.random() < 0.5) {
      defender._hazyStacks = Math.min((defender._hazyStacks || 0) + 1, 5);
      attacker._smokeScreenCooldown = 1;
      if (defender._hazyStacks === 5 && !defender._hazyCapTimer) defender._hazyCapTimer = 2;
    }
  }

  applyMadnessStack(attacker, amount = 1) {
    if (attacker.passive?.type !== 'sadisticPersistence') return;
    if (!hasPassiveUnlocked(attacker.level)) return;
    const before = attacker._madnessStacks || 0;
    const after = Math.min(before + amount, 10);
    attacker._madnessStacks = after;
    const beforePairs = Math.floor(before / 2), afterPairs = Math.floor(after / 2);
    const newPairs = afterPairs - beforePairs;
    if (newPairs > 0) { attacker.atkMod = (attacker.atkMod || 0) + 2 * newPairs; attacker.defMod = (attacker.defMod || 0) - 1 * newPairs; }
  }

  applyFearOfDeath(attacker, target) {
    if (attacker.passive?.type !== 'fearOfDeath') return null;
    if (!hasPassiveUnlocked(attacker.level)) return null;
    if (attacker._deathTouchCooldown > 0) return null;
    target._deathTouchStacks = Math.min((target._deathTouchStacks || 0) + 1, attacker.passive.maxStacks || 5);
    return target._deathTouchStacks;
  }

  isMarkedForDeath(target) { return (target._deathTouchStacks || 0) >= 5; }

  _applyCrystallize(target, dmg, duration) {
    const add = Math.max(1, Math.floor(dmg * 0.4));
    const existing = target.statusEffects.find(s => s.name === 'Crystallize');
    if (existing) { existing.damagePerTurn += add; existing.turnsLeft = Math.max(existing.turnsLeft, duration); }
    else { target.statusEffects.push({ name: 'Crystallize', emoji: '💎', damagePerTurn: add, turnsLeft: duration }); }
  }

  _psychoDmg(attacker, ability, defender) {
    const psycho = !!attacker._psychoMode;
    const oMin = ability.damageMin, oMax = ability.damageMax;
    if (psycho && ability.special.psychoMin != null) { ability.damageMin = ability.special.psychoMin; ability.damageMax = ability.special.psychoMax; }
    const d = this.calculateDamage(attacker, ability, defender);
    ability.damageMin = oMin; ability.damageMax = oMax;
    return { d, psycho };
  }

  tickTempDebuffs(fighter) {
    if (!fighter._tempDebuffs) return;
    fighter._tempDebuffs = fighter._tempDebuffs.filter(td => {
      if (td.turnsLeft <= 1) {
        if (td.stat === 'atk') fighter.atkMod -= td.amount;
        if (td.stat === 'def') fighter.defMod -= td.amount;
        return false;
      }
      td.turnsLeft--;
      return true;
    });
  }

  autoSwitch(log) {
    if (!this.p1.isAlive && this.alive1 > 0) {
      const next = this.team1.findIndex((f, i) => f.isAlive && i !== this.active1);
      if (next !== -1) { this.active1 = next; log.push(`**${this.p1.name}** steps in for Player 1!`); }
    }
    if (!this.p2.isAlive && this.alive2 > 0) {
      const next = this.team2.findIndex((f, i) => f.isAlive && i !== this.active2);
      if (next !== -1) { this.active2 = next; log.push(`**${this.p2.name}** steps in for Player 2!`); }
    }
  }

  checkEnd() {
    if (this.alive1 === 0) { this.isOver = true; this.winner = this.player2Id; return { winner: this.player2Id, loserId: this.player1Id }; }
    if (this.alive2 === 0) { this.isOver = true; this.winner = this.player1Id; return { winner: this.player1Id, loserId: this.player2Id }; }
    return null;
  }

  getState(forPlayerId) {
    const isP1 = forPlayerId === this.player1Id;
    const myFighter = isP1 ? this.p1 : this.p2;
    const enemyFighter = isP1 ? this.p2 : this.p1;
    const myAlive = isP1 ? this.alive1 : this.alive2;
    const myTotal = isP1 ? this.team1.length : this.team2.length;
    const enemyAlive = isP1 ? this.alive2 : this.alive1;
    const enemyTotal = isP1 ? this.team2.length : this.team1.length;

    return {
      player: {
        name: myFighter.name + (myFighter.shiny ? ' ✦' : ''),
        type: myFighter.type, level: myFighter.level, hp: myFighter.currentHp, maxHp: myFighter.maxHp,
        atk: myFighter.atk, def: myFighter.def,
        statusEffects: myFighter.statusEffects.map(s => `${s.emoji} ${s.name} (${s.turnsLeft})`),
        isCharging: myFighter.isCharging,
        abilities: myFighter.abilities.map((a, i) => ({
          index: i, name: a.name, type: a.type, typeEmoji: TYPES[a.type]?.emoji || '',
          uses: a.currentUses, maxUses: a.maxUses, cooldownLeft: a.cooldownLeft || 0,
        })),
      },
      enemy: {
        name: enemyFighter.name + (enemyFighter.shiny ? ' ✦' : ''),
        type: enemyFighter.type, hp: enemyFighter.currentHp, maxHp: enemyFighter.maxHp,
        atk: enemyFighter.atk, def: enemyFighter.def,
        statusEffects: enemyFighter.statusEffects.map(s => `${s.emoji} ${s.name} (${s.turnsLeft})`),
      },
      teamAlive: myAlive, teamTotal: myTotal,
      enemyAlive, enemyTotal,
      turnNumber: this.turnNumber,
      isMyTurn: this.currentTurn === forPlayerId,
    };
  }
}

module.exports = { PvPBattle };