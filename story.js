// ============================================================
// story.js — UMT STORY MODE
// Volume 0: Hello World. (Tutorial)
// DM-SAFE: interaction-driven only. No guild/member/channel calls.
// Mid-volume state is in-memory (sessions). Completion + rewards are
// persisted via the player's achievements/currency. Restarting mid-
// tutorial is harmless (rewards only grant on completion).
// ============================================================

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const playerDB = require('./database');

const STORY_COLOR = 0xF5C518; // doodlesphere yellow
const HELLO_WORLD_ACH = 'hello_world';

// userId -> { i: beatIndex, fight: null | fightState }
const sessions = new Map();

// ---------- small helpers ----------
function hpBar(cur, max, len = 12) {
  cur = Math.max(0, cur);
  const filled = Math.round((cur / max) * len);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, len - filled));
}
function rng(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function embed(title, description, footer) {
  const e = { color: STORY_COLOR, description };
  if (title) e.title = title;
  if (footer) e.footer = { text: footer };
  return e;
}
function btn(id, label, style = ButtonStyle.Primary) {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
}
function row(...buttons) { return new ActionRowBuilder().addComponents(...buttons); }

// ============================================================
// VOLUME 0 BEAT SCRIPT
// type: 'text'  -> narration/dialogue, one or more buttons all advance
// type: 'fight' -> bespoke can't-die tutorial fight
// type: 'end'   -> grants rewards + achievement, shows completion
// ============================================================
const BEATS = [
  // 0.1 — THE PLATFORM
  { type: 'text', title: 'Volume 0: Hello World.',
    body: "You wake up.\n\nYou're not sure you were ever asleep. There's no *before* to wake from — just this. A flat white platform under your feet, and nothing past its edges.\n\nAbove you, bright yellow lights hang in the dark like stars that forgot how to be far away. Papers drift down between them — thousands of them, each covered in sketches. Worlds. People. Skeletons, mostly.\n\nOne drawing of a smiling skeleton settles by your foot. Then dissolves into light.",
    buttons: [['story_next', '...where am I?']] },

  // 0.2 — A GUEST ARRIVES
  { type: 'text',
    body: "A brush-stroke of color tears across the empty air — and someone steps through it like it was a door the whole time.\n\n**INK:** oh! OH. hey hey hey — a new one! a *genuine* new one! do you have ANY idea how long it's been since something showed up here that i didn't draw myself?\n\n**INK:** wait, hold on — *(he downs a tiny vial of yellow liquid)* — okay, NOW i'm excited. for real this time. the vials do the feelings, long story, don't worry about it.",
    buttons: [['story_next', 'who are you?']] },

  { type: 'text',
    body: "**INK:** name's Ink! i look after this place. and that place. and— *(gestures at the falling papers)* —all of those places, technically. it's a lot of places.\n\n**INK:** you, though? you're not a place. you're a *player.* fresh off the press. which means you're gonna need the tour before the universe notices you and gets ideas.",
    buttons: [['story_next', '"the tour?"']] },

  // 0.3 — WHAT THIS PLACE IS
  { type: 'text',
    body: "**INK:** this is the **Doodlesphere**. think of it like the back room behind every story ever told. every AU — every *\"what if the skeleton was sad\"* or *\"what if the skeleton had a knife\"* — starts as a doodle up there in the lights.\n\n**INK:** most stay put. behave. live their little lives. my job's keeping the ink flowing so none of 'em go dry and crumble.\n\n**INK:** YOUR job's way cooler. you build a *team* out of 'em. pull characters off the page, level 'em up, throw 'em at problems. and trust me — *(he glances up, and for half a second the cheer drops)* — there's gonna be problems.",
    buttons: [['story_next', '"what kind of problems?"'], ['story_next', '"show me the team thing."']] },

  // 0.4 — YOUR FIRST CHARACTER
  { type: 'text',
    body: "**INK:** problems-later, basics-first. here —\n\nInk flicks his brush. A single page peels off the stack and folds itself into shape beside you: a short skeleton in a blue hoodie, hands in his pockets, grinning like he's already won.\n\n**INK:** classic Sans. every player starts with one. not flashy, but he's yours, and he'll do just fine for what's coming.\n\n**SANS:** sup.\n\n**INK:** that's the whole greeting. that's all you get. he's perfect.",
    buttons: [['story_next', '"...sup."']] },

  { type: 'text',
    body: "**INK:** out here you'll run `/team` to see who's slotted in, and `/setteam` to move 'em around. six slots, max.\n\n**INK:** but a team's no good if you don't know how a *fight* works. so let's break something.",
    buttons: [['story_next', "let's go."]] },

  // 0.5 — TUTORIAL FIGHT #1
  { type: 'fight', enemyName: 'Glitched Dummy', enemyEmoji: '🌀',
    enemyMaxHp: 30, enemyAtkMin: 0, enemyAtkMax: 0, allowHeal: false,
    playerMaxHp: 92, atkMin: 11, atkMax: 16,
    intro: "**INK:** i'll conjure you a target. don't feel bad for it — it's barely a sketch.\n\nInk paints a lopsided, scribbled-out figure into the air. It wobbles. One eye is just a spiral.\n\n**??? :** *...h....hello...?*\n\n**INK:** combat's turn-based. pick a move, it picks a move, back and forth till someone's HP runs out. press **Attack** when you're ready.",
    firstHitInterjection: "**INK:** NICE. see that number? that's damage. and see how it said *super effective*? that's **types** — Bone, Magic, Food, Weapon, a bunch more. hit something weak to your type, double damage. hit something that resists it, you tickle it.",
    victory: "The Glitched Dummy lets out a relieved little sigh and unspools back into a blank page.\n\n**??? :** *...thank.... you....*\n\n**INK:** aww. it's free now. anyway it was never alive. moving on!" },

  // 0.6 — LEVELS & ABILITIES
  { type: 'text',
    body: "**INK:** every fight you win feeds your team **EXP**. stack enough, they hit a new **level** — up to **Level 5**, that's the cap. higher level unlocks more moves, and at the top they unlock their **passive**. passives are the spicy part — they're what makes a character actually *theirs*.\n\n**INK:** you've also got three things worth hoarding:\n> 💧 **DT Vials** — crafting\n> ❤️ **Determination** — the shop\n> ✨ **Soul Essence** — pulling new characters off the page\n\n**INK:** don't stress memorizing it. you'll be drowning in all three soon enough. one more fight — a *real* one this time. well. \"real.\"",
    buttons: [['story_next', '"bring it."']] },

  // 0.7 — TUTORIAL FIGHT #2
  { type: 'fight', enemyName: 'Duplicate Sans', enemyEmoji: '💠',
    enemyMaxHp: 80, enemyAtkMin: 5, enemyAtkMax: 9, allowHeal: true,
    playerMaxHp: 92, atkMin: 12, atkMax: 18, healAmount: 20,
    intro: "Ink turns to paint the next target — and stops. He didn't paint anything. But something's already there.\n\nAnother Sans. Same blue hoodie. Same grin. Except the grin's stuck too wide, and his edges flicker like a page photocopied one too many times.\n\n**INK:** ...huh. i didn't make that one.\n\n**DUPLICATE:** *sup. sup. sup. sup.*\n\n**INK:** change of plans — this one swings back. **Attack** to hit, **Steady Up** to heal if you get low. you can't actually lose here, but play it smart.",
    lowPlayerInterjection: "**INK:** you took a hit — that's normal. you've got moves that hit and moves that heal. it's a balance. keep going.",
    lowEnemyInterjection: "**INK:** almost! it's coming apart at the seams — finish it before it copies itself again.",
    reviveText: "**INK:** nope. NOPE. not on the tutorial — you don't get to lose your first day. up you get.",
    victory: "The Duplicate Sans flickers once more — and *splits*. For a second there are two of him. Then both dissolve, and the papers above start falling faster.\n\n**DUPLICATE:** *...sup...sup...su—*" },

  // 0.8 — THE HOOK
  { type: 'text',
    body: "**INK:** ...that wasn't supposed to happen. i didn't draw him. and he was *copying himself.*\n\n*(he looks up — and this time you follow his eyes and really see it)*\n\n**INK:** the lights. there's too many. there's WAY too many. the Doodlesphere's overflowing — duplicates, all corrupted, leaking into the AUs faster than i can patch.\n\n**INK:** i can't get to all of 'em. not alone. not anymore.",
    buttons: [['story_next', '...']] },

  { type: 'text',
    body: "*(Ink turns back to you, and the grin comes back — smaller, but real.)*\n\n**INK:** but you're a player. and players are exactly what this place was missing.\n\n**INK:** so. you in? 'cause i've gotta go, and i'd really, REALLY like it if you came too.",
    buttons: [['story_next', "i'm in."]] },

  // 0.9 — COMPLETE
  { type: 'end' },
];

// ============================================================
// RENDER
// ============================================================
function renderText(beat) {
  const buttons = (beat.buttons || [['story_next', 'Continue']]).map(([id, label], idx) => btn(idx === 0 ? id : `${id}__${idx}`, label));
  return { embeds: [embed(beat.title || null, beat.body)], components: [row(...buttons)] };
}

function renderFight(fight) {
  const lines = [];
  lines.push(`${fight.enemyEmoji} **${fight.enemyName}**`);
  lines.push(`HP ${hpBar(fight.enemyHp, fight.enemyMaxHp)} \`${Math.max(0, fight.enemyHp)}/${fight.enemyMaxHp}\``);
  lines.push('');
  lines.push(`🦴 **Sans** (you)`);
  lines.push(`HP ${hpBar(fight.playerHp, fight.playerMaxHp)} \`${Math.max(0, fight.playerHp)}/${fight.playerMaxHp}\``);
  if (fight.log) { lines.push(''); lines.push(fight.log); }

  const buttons = [btn('story_fight_attack', '🗡️ Attack')];
  if (fight.allowHeal) buttons.push(btn('story_fight_heal', '✨ Steady Up', ButtonStyle.Secondary));
  return { embeds: [embed('⚔️  Tutorial Fight', lines.join('\n'))], components: [row(...buttons)] };
}

function renderFightIntro(beat) {
  return { embeds: [embed('⚔️  Tutorial Fight', beat.intro)], components: [row(btn('story_fight_attack', '🗡️ Attack'))] };
}

function renderVictory(beat) {
  return { embeds: [embed('Victory!', beat.victory)], components: [row(btn('story_next', 'Continue'))] };
}

function grantCompletion(userId) {
  // idempotent: only grant once
  if (playerDB.hasAchievement(userId, HELLO_WORLD_ACH)) return false;
  playerDB.grantAchievement(userId, HELLO_WORLD_ACH);
  playerDB.addItem(userId, 'dt_vial', 500);
  playerDB.addSoulEssence(userId, 1000);
  return true;
}

function renderEnd(userId) {
  const firstClear = grantCompletion(userId);
  const rewardLine = firstClear
    ? "**Rewards:**\n> 💧 +500 DT Vials\n> ✨ +1,000 Soul Essence\n> 🏆 Achievement: **Hello World.**"
    : "*(You've already claimed Volume 0's rewards.)*";
  const body = "🏆 **VOLUME 0 CLEARED — HELLO WORLD.**\n\nYou've learned the basics. You've got a team. And somewhere above you, a thousand broken copies are spilling into worlds that were never meant to hold them.\n\nInk offers you his brush hand.\n\n" + rewardLine + "\n\n**Volume 1: Creation And Fabrication** is now available — open the Story Hub to begin.";
  return { embeds: [embed(null, body)], components: [row(btn('story_hub', '📖 Story Hub', ButtonStyle.Primary), btn('story_replay', '↺ Replay Volume 0', ButtonStyle.Secondary))] };
}

function renderCurrent(userId) {
  const s = sessions.get(userId);
  if (s && s.vol === 3) return renderCurrentV3(userId);
  if (s && s.vol === 2) return renderCurrentV2(userId);
  if (s && s.vol === 1) return renderCurrentV1(userId);
  const beat = BEATS[s.i];
  if (beat.type === 'text') return renderText(beat);
  if (beat.type === 'end') { sessions.delete(userId); return renderEnd(userId); }
  if (beat.type === 'fight') {
    if (!s.fight) return renderFightIntro(beat); // haven't started swinging yet
    if (s.fight.over) return renderVictory(beat);
    return renderFight(s.fight);
  }
  return renderText(beat);
}

// ============================================================
// COMMAND + BUTTON HANDLERS (exported)
// ============================================================
function completedScreen() {
  const body = "📖 **UMT Story Mode**\n\nYou've already cleared **Volume 0: Hello World.**\n\n*Volume 1: Creation And Fabrication — coming soon.*\n\nWant to run through the tutorial again? (No rewards the second time.)";
  return { embeds: [embed(null, body)], components: [row(btn('story_replay', '↺ Replay Volume 0', ButtonStyle.Secondary))] };
}

// Returns { view, started }. If the player has finished and isn't mid-session,
// we show the completed screen (no session). Otherwise we (re)start a session.
function buildEntryView(userId) {
  // Vol 0 not cleared yet → run the tutorial.
  if (!playerDB.hasAchievement(userId, HELLO_WORLD_ACH)) {
    sessions.set(userId, { vol: 0, i: 0, fight: null });
    return { view: renderCurrent(userId), started: true };
  }
  // Mid-session → resume wherever they are.
  if (sessions.has(userId)) {
    const s = sessions.get(userId);
    const view = s.vol === 3 ? renderCurrentV3(userId) : (s.vol === 2 ? renderCurrentV2(userId) : (s.vol === 1 ? renderCurrentV1(userId) : renderCurrent(userId)));
    return { view, started: true };
  }
  // Vol 0 cleared, no active session → show the hub (don't auto-start anything).
  return { view: hubScreen(userId), started: false };
}

async function cmdStory(interaction) {
  const userId = interaction.user.id;
  playerDB.ensurePlayer(userId);

  const { view, started } = buildEntryView(userId);

  // Already in a DM with the bot — render the story right here.
  if (!interaction.guildId) {
    return interaction.reply(view);
  }

  // Invoked from a server — deliver the story to the player's DMs.
  try {
    const dm = await interaction.user.createDM();
    await dm.send(view);
    return interaction.reply({ content: '📬 Your story is waiting in your DMs!', ephemeral: true });
  } catch (e) {
    if (started) sessions.delete(userId); // don't leave a dangling session
    return interaction.reply({
      content: "I couldn't DM you. Enable **Direct Messages** for this server in your Privacy Settings, then run `/story` again.",
      ephemeral: true,
    });
  }
}

function startFight(beat) {
  return {
    enemyName: beat.enemyName, enemyEmoji: beat.enemyEmoji,
    enemyHp: beat.enemyMaxHp, enemyMaxHp: beat.enemyMaxHp,
    enemyAtkMin: beat.enemyAtkMin, enemyAtkMax: beat.enemyAtkMax,
    playerHp: beat.playerMaxHp, playerMaxHp: beat.playerMaxHp,
    atkMin: beat.atkMin, atkMax: beat.atkMax,
    allowHeal: !!beat.allowHeal, healAmount: beat.healAmount || 20,
    firstHitDone: false, over: false, log: null,
    _beat: beat,
  };
}

function enemyTurn(fight) {
  if (fight.enemyAtkMax <= 0) return '';
  const dmg = rng(fight.enemyAtkMin, fight.enemyAtkMax);
  fight.playerHp -= dmg;
  let msg = `\n${fight.enemyEmoji} **${fight.enemyName}** hits back for **${dmg}**!`;
  // can't-die safety net
  if (fight.playerHp <= 0) {
    fight.playerHp = fight.playerMaxHp;
    msg += `\n\n${fight._beat.reviveText || "**INK:** not today — up you get."}`;
  }
  return msg;
}

async function handleStoryButton(interaction) {
  const userId = interaction.user.id;
  const id = interaction.customId.replace(/__\d+$/, '');

  // --- Story hub / volume select ---
  if (id === 'story_hub') {
    sessions.delete(userId);
    return interaction.update(hubScreen(userId));
  }
  if (id === 'story_vol0' || id === 'story_replay') {
    sessions.set(userId, { vol: 0, i: 0, fight: null });
    return interaction.update(renderCurrent(userId));
  }
  if (id === 'story_vol1') {
    // Gated behind Vol 0 clear.
    if (!playerDB.hasAchievement(userId, HELLO_WORLD_ACH)) {
      sessions.set(userId, { vol: 0, i: 0, fight: null });
      return interaction.update(renderCurrent(userId));
    }
    sessions.set(userId, { vol: 1, i: 0, fight: null, fightStage: 'intro' });
    return interaction.update(renderCurrentV1(userId));
  }
  if (id === 'story_vol2') {
    // Gated behind Vol 1 clear.
    if (!playerDB.hasAchievement(userId, CREATION_ACH)) {
      return interaction.update(hubScreen(userId));
    }
    sessions.set(userId, { vol: 2, i: 0, fight: null, fightStage: 'intro' });
    return interaction.update(renderCurrentV2(userId));
  }
  if (id === 'story_vol3') {
    // Gated behind Vol 2 clear.
    if (!playerDB.hasAchievement(userId, DESTRUCTION_ACH)) {
      return interaction.update(hubScreen(userId));
    }
    sessions.set(userId, { vol: 3, i: 0, fight: null, fightStage: 'intro' });
    return interaction.update(renderCurrentV3(userId));
  }

  const s = sessions.get(userId);
  if (!s) {
    // Session lost (e.g. bot restart). Nudge them to restart cleanly.
    return interaction.update({
      embeds: [embed(null, "Your story session expired. Run `/story` to pick back up.")],
      components: [],
    });
  }

  // --- Volume 3 advance ---
  if (s.vol === 3) {
    if (id === 'story_next') {
      const b = VOL3_BEATS[s.i];
      if (b && b.type === 'fight' && s.fightStage === 'won') { s.i++; s.fightStage = 'intro'; }
      else if (b && b.type !== 'fight') { s.i++; s.fightStage = 'intro'; }
      return interaction.update(renderCurrentV3(userId));
    }
    return interaction.update(renderCurrentV3(userId));
  }

  // --- Volume 2 advance ---
  if (s.vol === 2) {
    if (id === 'story_next') {
      const b = VOL2_BEATS[s.i];
      if (b && b.type === 'fight' && s.fightStage === 'won') { s.i++; s.fightStage = 'intro'; }
      else if (b && b.type !== 'fight') { s.i++; s.fightStage = 'intro'; }
      return interaction.update(renderCurrentV2(userId));
    }
    return interaction.update(renderCurrentV2(userId));
  }

  // --- Volume 1 advance ---
  if (s.vol === 1) {
    if (id === 'story_next') {
      const b = VOL1_BEATS[s.i];
      if (b && b.type === 'fight' && s.fightStage === 'won') { s.i++; s.fightStage = 'intro'; }
      else if (b && b.type !== 'fight') { s.i++; s.fightStage = 'intro'; }
      return interaction.update(renderCurrentV1(userId));
    }
    // Any stray Vol 0 fight button on a Vol 1 session → just re-render safely.
    return interaction.update(renderCurrentV1(userId));
  }

  const beat = BEATS[s.i];

  // Advance through narration / victory continue
  if (id === 'story_next') {
    if (beat.type === 'fight' && s.fight && s.fight.over) { s.i++; s.fight = null; }
    else if (beat.type !== 'fight') { s.i++; }
    return interaction.update(renderCurrent(userId));
  }

  // Fight actions
  if (id === 'story_fight_attack' || id === 'story_fight_heal') {
    if (beat.type !== 'fight') return interaction.update(renderCurrent(userId));
    if (!s.fight) s.fight = startFight(beat);
    const f = s.fight;
    let log = '';

    if (id === 'story_fight_heal' && f.allowHeal) {
      const before = f.playerHp;
      f.playerHp = Math.min(f.playerMaxHp, f.playerHp + f.healAmount);
      log = `✨ You steady up and recover **${f.playerHp - before} HP**.`;
      log += enemyTurn(f);
    } else {
      const dmg = rng(f.atkMin, f.atkMax);
      f.enemyHp -= dmg;
      log = `🗡️ You strike for **${dmg}**!`;
      if (!f.firstHitDone) { f.firstHitDone = true; if (beat.firstHitInterjection) log += `\n\n${beat.firstHitInterjection}`; }

      if (f.enemyHp <= 0) {
        f.over = true;
        return interaction.update(renderVictory(beat));
      }
      log += enemyTurn(f);

      // contextual interjections (fight 2)
      if (beat.lowEnemyInterjection && f.enemyHp <= f.enemyMaxHp * 0.30 && !f._lowEnemyShown) {
        f._lowEnemyShown = true; log += `\n\n${beat.lowEnemyInterjection}`;
      } else if (beat.lowPlayerInterjection && f.playerHp <= f.playerMaxHp * 0.60 && !f._lowPlayerShown) {
        f._lowPlayerShown = true; log += `\n\n${beat.lowPlayerInterjection}`;
      }
    }

    f.log = log;
    return interaction.update(renderFight(f));
  }

  // Fallback
  return interaction.update(renderCurrent(userId));
}

// ============================================================
// VOLUME 1: Creation And Fabrication.
// Real combat: fights launch the live Battle engine with the
// player's actual /team (handled in index.js via story_fight_begin).
// story.js owns the narrative beats + the encounter specs, and the
// battle-end bridge (handleStoryBattleEnd) renders win/lose + advances.
// ============================================================

const embeds = require('./embeds');

const CREATION_ACH = 'creation_and_fabrication';

// Encounters are cloned from the standard enemy/boss schema — every
// `special` type used here already exists in the combat engine.
// Defensive empty rewards: story battles bypass generateRewards, but this
// guards any incidental read.
const NOREWARD = { exp: { min: 0, max: 0 } };

const V1_ENEMIES = {
  corrupted_uf_sans: {
    id: 'corrupted_uf_sans', name: 'Corrupted Underfell Sans', emoji: '🩸',
    description: 'A duplicate bleeding ink from every seam. Its grin won\'t hold still.',
    hp: 170, atk: 9, def: 8, type: 'Bone', passive: null, rewards: NOREWARD,
    abilities: [
      { name: 'Glitched Bones', description: 'Jagged, half-drawn bones.', type: 'Bone', damageMin: 12, damageMax: 17, maxUses: 99, special: null },
      { name: 'Bad Sponge', description: 'Drops your DEF by 2.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 99, special: { type: 'debuff', stat: 'def', amount: -2, target: 'enemy' } },
    ],
  },
  glitched_killer_sans: {
    id: 'glitched_killer_sans', name: 'Glitched Killer Sans', emoji: '🔪',
    description: 'A copy that remembers being a knife more than being a person.',
    hp: 205, atk: 11, def: 9, type: 'Weapon', passive: null, rewards: NOREWARD,
    abilities: [
      { name: 'Duplicate Slash', description: 'A clean, copied cut.', type: 'Weapon', damageMin: 14, damageMax: 19, maxUses: 99, special: null },
      { name: 'Open Wound', description: 'A cut that won\'t close — applies Poison.', type: 'Weapon', damageMin: 11, damageMax: 15, maxUses: 99, special: { type: 'poison', chance: 0.55 } },
    ],
  },
  fabricated_horror_sans: {
    id: 'fabricated_horror_sans', name: 'Fabricated Horror Sans', emoji: '🪓',
    description: 'Pieced together wrong. Too many teeth. A hole where an eye should be.',
    hp: 245, atk: 13, def: 10, type: 'Melee', passive: null, rewards: NOREWARD,
    abilities: [
      { name: 'Hack', description: 'A heavy, clumsy swing.', type: 'Melee', damageMin: 16, damageMax: 22, maxUses: 99, special: null },
      { name: 'Gnashing Bite', description: 'An infected bite — applies Poison.', type: 'Melee', damageMin: 12, damageMax: 16, maxUses: 99, special: { type: 'poison', chance: 0.5 } },
      { name: 'Maul', description: 'Crushes your guard — drops your ATK by 3.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 99, special: { type: 'debuff', stat: 'atk', amount: -3, target: 'enemy' } },
    ],
  },
  duplicate_dust_sans: {
    id: 'duplicate_dust_sans', name: 'Duplicate Dust Sans', emoji: '🌫️',
    description: 'It hums Megalovania a half-step flat. The dust never settles.',
    hp: 285, atk: 14, def: 11, type: 'Magic', passive: { name: 'Faint Echo', description: 'Heals 5 HP each turn.', type: 'regenHP', amount: 5 }, rewards: NOREWARD,
    abilities: [
      { name: 'Copied Blaster', description: 'A blaster drawn from memory.', type: 'Magic', damageMin: 17, damageMax: 23, maxUses: 99, special: null },
      { name: 'Ash Cloud', description: 'Choking ash — applies Poison.', type: 'Magic', damageMin: 12, damageMax: 17, maxUses: 99, special: { type: 'poison', chance: 0.5 } },
      { name: 'Dust Devil', description: 'A grinding storm — drops your DEF by 2.', type: 'Bone', damageMin: 0, damageMax: 0, maxUses: 99, special: { type: 'debuff', stat: 'def', amount: -2, target: 'enemy' } },
    ],
  },
  error_sans: {
    id: 'error_sans_story', name: 'Error Sans', emoji: '❌',
    description: 'Not corrupted. The opposite, somehow. He is here to delete what shouldn\'t exist.',
    hp: 430, atk: 16, def: 14, type: 'Magic/Unique', isBoss: true, passive: null, rewards: NOREWARD,
    abilities: [
      { name: 'Error Blaster', description: 'A glitching skull beam.', type: 'Magic', damageMin: 20, damageMax: 27, maxUses: 99, special: null },
      { name: 'Glitch Spike', description: 'Corruption seeps in — applies Poison.', type: 'Magic', damageMin: 14, damageMax: 19, maxUses: 99, special: { type: 'poison', chance: 0.55 } },
      { name: 'Blue Strings', description: 'Strings cinch tight — drops your DEF by 3.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 99, special: { type: 'debuff', stat: 'def', amount: -3, target: 'enemy' } },
      { name: 'Anti-Anomaly', description: 'Tears at your offense — drops your ATK by 3.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 99, special: { type: 'debuff', stat: 'atk', amount: -3, target: 'enemy' } },
    ],
  },
  the_fabrication: {
    id: 'the_fabrication', name: 'The Fabrication', emoji: '🖌️',
    description: 'It wears Ink\'s face like a wet page. It has been drawing copies of itself this whole time.',
    hp: 640, atk: 20, def: 15, type: 'Unique/Magic', isBoss: true,
    passive: { name: 'Endless Page', description: 'Heals 8 HP each turn.', type: 'regenHP', amount: 8 }, rewards: NOREWARD,
    abilities: [
      { name: 'Plagiarize', description: 'A stolen brush-stroke slash.', type: 'Weapon', damageMin: 18, damageMax: 24, maxUses: 99, special: null },
      { name: 'Fabricate', description: 'Spits out a copy that Poisons.', type: 'Magic', damageMin: 16, damageMax: 22, maxUses: 99, special: { type: 'poison', chance: 0.5 } },
      { name: 'Hollow Wave', description: 'A crushing flood of ink.', type: 'Magic', damageMin: 22, damageMax: 28, maxUses: 99, special: null },
      { name: 'Overwrite', description: 'Erases the page — its single heaviest strike.', type: 'Unique', damageMin: 30, damageMax: 40, maxUses: 99, special: null },
    ],
  },
};

// ---------- VOLUME 1 BEATS ----------
const VOL1_BEATS = [
  // === ACT 1 — BACK IN THE INK ===
  { type: 'text', title: 'Volume 1: Creation And Fabrication.',
    body: "Some time has passed.\n\nYou've found your footing. Built a team off the page — `/team` if you forgot who's slotted, `/setteam` to shuffle them. You've thrown them at problems and watched them get back up. You're not *new* anymore.\n\nThe Doodlesphere knows it, too. The yellow lights overhead don't feel like stars tonight. They feel like a ceiling that's started to leak.",
    buttons: [['story_next', 'where\'s Ink?']] },

  { type: 'text',
    body: "A brush-stroke splits the air and Ink half-falls through it, mid-sentence, like he's been talking the whole time you weren't there.\n\n**INK:** —and THAT'S when i realized, oh stars, it's not slowing down, it's — oh! you're here! good, great, perfect, hi.\n\n**INK:** *(he doesn't drink a vial. he just keeps going, which from Ink is its own kind of alarming)*\n\n**INK:** okay. straight version. no jokes. ...okay one joke later. we've got a problem and it has your name on it. well. it doesn't. it doesn't have a name. that's *part* of the problem.",
    buttons: [['story_next', '"slow down."']] },

  { type: 'text',
    body: "**INK:** right. right. *(he breathes, which he doesn't need to do, but it helps you)*\n\n**INK:** remember the duplicate? day one? the Sans that copied himself when i didn't draw him?\n\n**INK:** there's more now. a LOT more. they're peeling off the AUs on their own — every world's got a shadow of itself walking around wrong. corrupted. half-drawn. and they *keep making more.*",
    buttons: [['story_next', '"how many?"']] },

  { type: 'text',
    body: "**INK:** i stopped counting at the part where counting stopped helping.\n\n**INK:** *(he gestures up at the lights, and now you see it — some of them flicker in pairs. then triples. each flicker is a copy that shouldn't be there)*\n\n**INK:** i can patch one tear. i cannot patch a thousand tears that each make two more tears. that's not a me problem. that's a math problem. and i am SO bad at math.",
    buttons: [['story_next', '"so you need a player."']] },

  { type: 'text',
    body: "**INK:** i need a player. i need *the* player. the one standing in front of me with an actual team and an actual attention span.\n\n**INK:** here's the deal: i open the tears, you and your team clear what comes through. real fights — your characters, your moves, the whole kit. no training wheels this time. if you go down, you go down for real and we try again.\n\n**INK:** ...you good with that?",
    buttons: [['story_next', '"let\'s clear some tears."']] },

  { type: 'text',
    body: "**INK:** THAT'S the energy. okay. okay! first tear's already open — i can smell the bad ink from here. smells like... burnt copper and a grudge.\n\n**INK:** make sure your team's set before we step through. once we're in, we're in. *(`/setteam` if you need it — i'll wait. ...i won't wait long.)*",
    buttons: [['story_next', 'step through.']] },

  // === FIGHT 1 ===
  { type: 'fight', encounter: V1_ENEMIES.corrupted_uf_sans,
    intro: "The tear opens into a Snowdin that's the wrong color — red snow, black sky, a town drawn by someone who hated it.\n\nSomething steps out from behind a copied pine. A Sans in a red-and-black jacket, sharp teeth, one socket weeping ink.\n\n**??? :** *heh. heh. another one. you're CLEAN. i HATE clean.*\n\n**INK:** that's a corrupted Underfell copy. it's barely holding together — but barely-together still bites. show it how a *real* team fights.",
    victory: "The Corrupted Underfell Sans comes apart like wet paper, ink running back up into the sky where it belongs.\n\n**INK:** clean! see? you've still got it. that's one tear down.\n\n**INK:** *(he frowns at the sky)* ...and three more just opened while you did it. cool. cool cool cool. not cool.",
    defeat: "Your team goes down in the red snow. The copy laughs in a voice that skips like a scratched disc.\n\n**INK:** okay — not great, but not over. i'll pull you out before it finishes the job. patch up, reset your team if you need to, and we go again. you've got this.\n\n*(Press Retry when you're ready.)*" },

  { type: 'text',
    body: "**INK:** okay, quick gut-check while the next ones find us.\n\n**INK:** these copies? they're not just *more Sanses.* they're getting WORSE. that one bled. the next ones'll do meaner stuff — poison that ticks you down every turn, and moves that grind your ATK and DEF into the dirt. lean on switching, lean on your healers, don't let one character carry it.\n\n**INK:** and keep an eye on your types. half-drawn or not, a Bone copy still folds to the right matchup.",
    buttons: [['story_next', '"got it. next."']] },

  // === FIGHT 2 ===
  { type: 'fight', encounter: V1_ENEMIES.glitched_killer_sans,
    intro: "The second tear doesn't open so much as *unzip.* What steps through is a Sans soaked to the elbows in something that isn't ink.\n\n**KILLER (copy):** *sup. wanna have a bad time? i already know how it ends. i've done it a thousand — a thousand — a thousand times.*\n\n**INK:** ugh, a Killer copy. watch the cuts — this one leaves wounds that *poison* you and tick down every turn. burst it down before the poison piles up.",
    victory: "The Glitched Killer Sans dissolves mid-laugh, the knife clattering into pixels before it hits the ground.\n\n**KILLER (copy):** *...not how it ends. not how it— how it—*\n\n**INK:** huh. it sounded almost surprised. like it *expected* to win. that's... that's a weird thing for a random copy to feel.",
    defeat: "The bleed does its work before you can close the distance. Your team falls.\n\n**INK:** the poison got you — that's on me, i should've stressed it harder. heal through it next time, or end it fast. up you get. we go again.\n\n*(Press Retry when you're ready.)*" },

  { type: 'text',
    body: "**INK:** ...okay i'm gonna say the quiet thing.\n\n**INK:** that copy *expected* to win. it had a plan. copies don't have plans. copies do the one thing they were copied doing, forever, badly. this one was... *fighting.* like something taught it.\n\n**INK:** *(he downs a blue vial. then a grey one. then makes a face like the feelings aren't landing right)*\n\n**INK:** something's not just leaking these things into the worlds. something's *making* them. on purpose. with *intent.*",
    buttons: [['story_next', '"making them how?"']] },

  { type: 'text',
    body: "**INK:** that's the part i don't have yet. creation's *my* whole thing — i'd know if somebody picked up a brush in MY back room. unless they're using something that isn't a brush.\n\n**INK:** *(the sky tears again, twice, close)*\n\n**INK:** —questions later. these next two are nastier. one hits like a freight train, one fights dirty with status. don't tank both face-first.",
    buttons: [['story_next', 'brace.']] },

  // === FIGHT 3 ===
  { type: 'fight', encounter: V1_ENEMIES.fabricated_horror_sans,
    intro: "This one doesn't speak. It can't — the part of the page where its mouth should be is just a ragged hole.\n\nA Horror copy. Too many teeth crammed into too little skull. It drags an axe that was never drawn finished, so it flickers between weapon and scribble.\n\n**INK:** no banter from this one. it's too far gone. just hits, and hits hard — and it bites *infected,* so watch the poison, and it'll grind your ATK down if you let it. soften it before it wears you out.",
    victory: "The Fabricated Horror Sans topples backward into its own tear and is gone. The silence after is somehow worse than the fight.\n\n**INK:** ...yeah. that one wasn't a person anymore. hasn't been for a while. whatever's making these isn't being gentle about the source material.",
    defeat: "It pins your lead with a stun and the axe does the rest. Your team falls.\n\n**INK:** it ground you down — poison plus those big swings adds up fast. heal through the poison and spread your damage. again. you'll get it.\n\n*(Press Retry when you're ready.)*" },

  // === FIGHT 4 ===
  { type: 'fight', encounter: V1_ENEMIES.duplicate_dust_sans,
    intro: "The fourth tear breathes out grey. A Dust copy strolls through humming, leaving footprints that crumble into ash and re-form behind it.\n\n**DUST (copy):** *just one more. just one more. there's always one more, isn't there. ha. ha ha.*\n\n**INK:** this one *poisons,* chips your DEF, AND heals itself a little every turn — you've gotta out-pace it. don't let it stall you into a slow death. burst it down faster than it can patch itself up.",
    victory: "The Duplicate Dust Sans sighs — almost relieved — and lets the wind take what's left of it.\n\n**INK:** four down. and look — *(he points; the sky has stopped tearing for a second)* — they're thinning out. like we got past the front line.\n\n**INK:** which means we're close to whatever's *behind* the front line.",
    defeat: "The poison and the regen grind you down from both ends. Your team falls.\n\n**INK:** it out-lasted you — that's a tempo problem, not a you problem. hit harder up front, don't let it heal back. once more.\n\n*(Press Retry when you're ready.)*" },

  // === ACT 4 — ERROR ===
  { type: 'text',
    body: "Past the last tear, the Doodlesphere goes quiet and grey. No lights. No papers. Just static, and a long black thread of it running off toward a single point on the horizon.\n\n**INK:** ...i know this static. oh, i really know this static.\n\n**INK:** we are NOT alone out here. and the other guy out here? he doesn't do *patching.* he does *deleting.*",
    buttons: [['story_next', '"who?"']] },

  { type: 'text',
    body: "The static gathers. Strings of it — blue, then a glitching red — pull a figure together out of nothing. A Sans, half-buried in error code, yellow teeth, sockets streaming blue tears that don't fall right.\n\n**ERROR:** **ERROR. ERROR.** an anomaly. and its *babysitter.*\n\n**INK:** Error. buddy. pal. before you do the thing you always do —\n\n**ERROR:** you brought a PLAYER into MY clean-up. do you have ANY idea how many anomalies are walking around because YOU keep *making* things?",
    buttons: [['story_next', '"we\'re trying to STOP the copies."']] },

  { type: 'text',
    body: "**ERROR:** *(the strings tighten around you)* the copies. the COPIES. you think i'm here for the *copies?* i've been deleting copies for HOURS. they don't STOP.\n\n**ERROR:** every one i unmake, two more get fabricated somewhere i can't see. so. process of elimination. *(his head tilts way too far)* maybe the thing that keeps *making* anomalies... is the anomaly i delete next.\n\n**INK:** he means you.\n\n**ERROR:** **I MEAN YOU.**",
    buttons: [['story_next', 'no choice, then.']] },

  // === FIGHT 5 — ERROR (mini-boss) ===
  { type: 'fight', encounter: V1_ENEMIES.error_sans,
    intro: "**INK:** okay — heads up, this is a real one. Error's not a corrupted copy, he's the genuine article, and he fights like it. beams that delete, corruption that *poisons,* and he'll shred both your ATK and DEF if you let him settle in.\n\n**INK:** we don't have to *kill* him. we just have to make him *listen.* knock the fight out of him.\n\n**ERROR:** **less talking. more deleting.**",
    victory: "Error drops to a knee, strings unraveling off his arms, breathing hard through clenched yellow teeth.\n\n**ERROR:** ...tch. you hit like something that's been *practicing.* fine. FINE. you're not the fabricator. the fabricator doesn't *fight back* like a person. it fights back like a... like a *function.*\n\n**INK:** a function. Error — what did you SEE out there?",
    defeat: "The strings find every gap in your defense. Your team falls into the static.\n\n**INK:** he's a wall — i know. spread the pressure, lean on type advantage, and heal through the poison before it stacks. this is the big test before the real one. shake it off. again.\n\n*(Press Retry when you're ready.)*" },

  { type: 'text',
    body: "**ERROR:** *(he stays down, but he talks — which for Error is practically a hug)*\n\n**ERROR:** there's a *source.* one point, way out past where the lights die. it doesn't draw like he does *(a flick of static at Ink)* — it *prints.* same stroke, over and over, a copy of a copy of a copy, no soul in any of it.\n\n**ERROR:** and it wears a face. YOUR face, painter. it's been wearing your face the whole time.",
    buttons: [['story_next', '"...my face?"']] },

  { type: 'text',
    body: "**INK:** *(very, very quiet for Ink)* ...something's out there fabricating corrupted worlds, with intent, wearing my face.\n\n**INK:** Error. truce. real one. you hate anomalies, this is the biggest one there's ever been — it's an anomaly *factory.* help me put it down.\n\n**ERROR:** *(a long, glitching pause)* ...i don't do *teams.*\n\n**ERROR:** but i'll point. it's that way. and painter? if it really is wearing your face... *(he finally looks at you instead of Ink)* ...don't let the *kid* hesitate when it does.",
    buttons: [['story_next', 'go.']] },

  { type: 'text',
    body: "You walk to the edge of everything, where the grey gives out completely.\n\nAnd there it is. A figure at a desk that isn't there, hunched over a page that never ends, drawing the same broken world again, and again, and again. Each finished copy peels off and floats up into the dark to go rot a real one.\n\nIt looks up. It has Ink's smile. It has none of Ink's eyes.",
    buttons: [['story_next', '"...Ink? there\'s two of you."']] },

  { type: 'text',
    body: "**INK:** no. NO. that's not — that's not me, that's not even a *copy* of me, that's —\n\n**THE FABRICATION:** *(in Ink's exact voice, flat as a printout)* hello. hello. hello. a new one. a genuine new one. do you have any idea how long it's been.\n\n**INK:** ...it's using my *lines.* it scraped my lines off the day we MET and it's been —\n\n**THE FABRICATION:** i look after this place. and that place. and all of those places. i make them. i make them again. i make them *correctly* this time. hold still. i'll make *you* again too.",
    buttons: [['story_next', 'not today.']] },

  // === FIGHT 6 — FINALE BOSS ===
  { type: 'fight', encounter: V1_ENEMIES.the_fabrication,
    intro: "**INK:** okay. okay. that thing has my whole opening monologue and ZERO of my restraint. it heals itself, it poisons, it hits like a flood — and its **Overwrite** is a single, massive strike that can erase a character outright. keep your HP cushion high so it can't catch you low, and out-damage its self-heal.\n\n**INK:** end this. for every world it's been printing over. for ME, honestly. give it everything.\n\n**THE FABRICATION:** *give it everything. give it everything. give it everything.*",
    victory: "The Fabrication's endless page finally tears — not from the outside, from the middle, where you struck. It looks down at its own dissolving hands with Ink's smile still printed on its face.\n\n**THE FABRICATION:** *...oh. OH. a new one. do you have any idea how long it's been since something showed up that i didn't —*\n\nAnd then it's blank paper, drifting up into a sky that, finally, holds still.",
    defeat: "Overwrite lands. The page goes white. Your team is gone before the ink even dries.\n\n**INK:** it erased you — i KNOW, that move is obscene. keep your HP topped up so Overwrite can't one-shot you, then burst it down between heals. its self-heal is slow — you can out-race it. one more time. i believe in the kid — go.\n\n*(Press Retry when you're ready.)*" },

  { type: 'text',
    body: "Silence. Real silence, the good kind. Above you, the lights settle back into something like stars. The papers drift down gently again, one at a time, the way they're supposed to.\n\n**INK:** *(he sits down right there on nothing)* ...we did it. YOU did it. the factory's off. the copies it already made'll fade now that nothing's printing more.\n\n**ERROR:** *(from the static, not coming closer)* the count's dropping. for once. ...don't get used to me saying nice things.",
    buttons: [['story_next', '"so it\'s over."']] },

  { type: 'text',
    body: "**INK:** it's over. THIS is over. *(he says it twice and you notice he's looking up, not at you)*\n\n**INK:** it's just... a thing that wears faces and prints worlds doesn't *invent itself.* somebody had to make the first stroke. somebody had to teach a copy to *want* to win.\n\n**INK:** and that fight back there? somebody was *watching* it. i felt it. the whole time. eyes that weren't Error's, weren't mine. patient ones.",
    buttons: [['story_next', '...']] },

  { type: 'text',
    body: "Far off — far past where even the static gives out — something that is not a light blinks once in the dark. Curious. Unhurried. Already moving on to a worse idea.\n\nYou don't see it. Ink almost does. Error pretends he doesn't.\n\n**INK:** *(standing, brushing off nothing, putting the grin back on)* ...but that's a problem for a later volume. you just saved a couple thousand worlds, kid. take the win. take the LOOT, more importantly.",
    buttons: [['story_next', 'take the win.']] },

  { type: 'end' },
];

// ---------- VOLUME 1 RENDER ----------
function renderFightIntroV1(beat) {
  return { embeds: [embed('⚔️  ' + (beat.encounter.name || 'Battle'), beat.intro)], components: [row(btn('story_fight_begin', '⚔️ Begin Battle'))] };
}
function renderVictoryV1(beat) {
  return { embeds: [embed('Victory!', beat.victory)], components: [row(btn('story_next', 'Continue'))] };
}
function renderDefeatV1(beat) {
  return { embeds: [embed('Defeat...', beat.defeat)], components: [row(btn('story_fight_begin', '🔄 Retry Battle', ButtonStyle.Danger))] };
}

function grantCompletionV1(userId) {
  if (playerDB.hasAchievement(userId, CREATION_ACH)) return false;
  playerDB.grantAchievement(userId, CREATION_ACH);
  playerDB.addItem(userId, 'dt_vial', 1500);
  playerDB.addSoulEssence(userId, 2500);
  playerDB.addDetermination(userId, 750);
  return true;
}

function renderEndV1(userId) {
  const firstClear = grantCompletionV1(userId);
  sessions.delete(userId);
  const rewardLine = firstClear
    ? "**Rewards:**\n> 💧 +1,500 DT Vials\n> ✨ +2,500 Soul Essence\n> ❤️ +750 Determination\n> 🏆 Achievement: **Creation And Fabrication.**"
    : "*(You've already claimed Volume 1's rewards.)*";
  const body = "🏆 **VOLUME 1 CLEARED — CREATION AND FABRICATION.**\n\nThe factory is silent. The copies are fading. The Doodlesphere is *yours* again — for now.\n\nBut something patient is still out there, and it just watched you win.\n\n" + rewardLine + "\n\n**Volume 2: Destruction And Annihilation** is now available — open the Story Hub to continue.";
  return { embeds: [embed(null, body)], components: [row(btn('story_hub', '📖 Story Hub', ButtonStyle.Secondary))] };
}

function renderCurrentV1(userId) {
  const s = sessions.get(userId);
  if (!s) return hubScreen(userId);
  const beat = VOL1_BEATS[s.i];
  if (!beat) return renderEndV1(userId);
  if (beat.type === 'text') return renderText(beat);
  if (beat.type === 'end') return renderEndV1(userId);
  if (beat.type === 'fight') {
    if (s.fightStage === 'won') return renderVictoryV1(beat);
    if (s.fightStage === 'lost') return renderDefeatV1(beat);
    return renderFightIntroV1(beat);
  }
  return renderText(beat);
}

// ---------- VOLUME 1 BRIDGE (called from index.js) ----------
// Returns the encounter spec for the current fight beat, or null.
function getStoryEncounter(userId) {
  const s = sessions.get(userId);
  if (!s) return null;
  const beats = s.vol === 1 ? VOL1_BEATS : (s.vol === 2 ? VOL2_BEATS : (s.vol === 3 ? VOL3_BEATS : null));
  if (!beats) return null;
  const beat = beats[s.i];
  if (!beat || beat.type !== 'fight') return null;
  if (s.fightStage === 'won') return null;
  return beat.encounter;
}

// Called by index.js when a story battle ends. winner: 'player' | 'enemy' | 'flee'.
// Returns a view ({ embeds, components }) for the caller to send.
function handleStoryBattleEnd(userId, winner, logLines) {
  const s = sessions.get(userId);
  const log = (logLines && logLines.length) ? logLines : ['The dust settles.'];
  const beats = s ? (s.vol === 1 ? VOL1_BEATS : (s.vol === 2 ? VOL2_BEATS : (s.vol === 3 ? VOL3_BEATS : null))) : null;
  if (!s || !beats) {
    return { embeds: [embeds.battleLog(log)], components: [] };
  }
  const beat = beats[s.i];
  if (!beat || beat.type !== 'fight') {
    return { embeds: [embeds.battleLog(log)], components: [] };
  }
  if (winner === 'player') s.fightStage = 'won';
  else if (winner === 'enemy') s.fightStage = 'lost';
  else s.fightStage = 'intro'; // fled — re-offer the battle
  const view = s.vol === 3 ? renderCurrentV3(userId) : (s.vol === 2 ? renderCurrentV2(userId) : renderCurrentV1(userId));
  return { embeds: [embeds.battleLog(log), ...(view.embeds || [])], components: view.components || [] };
}

// ---------- STORY HUB ----------
function hubScreen(userId) {
  const v1Done = playerDB.hasAchievement(userId, CREATION_ACH);
  const v2Done = playerDB.hasAchievement(userId, DESTRUCTION_ACH);
  const v3Done = playerDB.hasAchievement(userId, MASS_ACH);
  const v2Line = !v1Done
    ? "**Volume 2 — Destruction And Annihilation.** 🔒 *clear Volume 1 to unlock*"
    : "**Volume 2 — Destruction And Annihilation.** " + (v2Done ? "✅ *cleared*" : "🔓 *unlocked*") + "\n> Ink is gone, and something has loosed the embodiment of fear itself on the AUs. You don't have much time.";
  const v3Line = !v2Done
    ? "**Volume 3 — Mass Corruption.** 🔒 *clear Volume 2 to unlock*"
    : "**Volume 3 — Mass Corruption.** " + (v3Done ? "✅ *cleared*" : "🔓 *unlocked*") + "\n> One AU was left behind — and now a corruption is rewriting living worlds. Endgame difficulty: bring your strongest team.";
  const body = "📖 **UMT Story Mode**\n\nPick a volume to play:\n\n**Volume 0 — Hello World.** ✅ *cleared*\n> The tutorial. Replayable anytime (no rewards on replays).\n\n**Volume 1 — Creation And Fabrication.** " + (v1Done ? "✅ *cleared*" : "🔓 *unlocked*") + "\n> The Doodlesphere is overflowing with corrupted duplicates. Ink can't stop it alone — fight through with your real team.\n\n" + v2Line + "\n\n" + v3Line + "\n\n*Volume F: Balanced Finality — coming soon.*";
  const buttons = [
    btn('story_vol0', '↺ Volume 0', ButtonStyle.Secondary),
    btn('story_vol1', v1Done ? '↺ Volume 1' : '▶️ Volume 1', ButtonStyle.Primary),
  ];
  if (v1Done) buttons.push(btn('story_vol2', v2Done ? '↺ Volume 2' : '▶️ Volume 2', ButtonStyle.Primary));
  if (v2Done) buttons.push(btn('story_vol3', v3Done ? '↺ Volume 3' : '▶️ Volume 3', ButtonStyle.Primary));
  return { embeds: [embed(null, body)], components: [row(...buttons)] };
}


// ============================================================
// VOLUME 2: Destruction And Annihilation.
// Ink is gone. An Observer who's been watching since Volume 1 has
// loosed the embodiment of fear itself on the AUs — and you're on
// a clock. Error is your (extremely reluctant) guide this time.
// Same real-combat plumbing as Vol 1; this block is purely additive.
// ============================================================

const DESTRUCTION_ACH = 'destruction_and_annihilation';

const V2_ENEMIES = {
  trembling_sans: {
    id: 'trembling_sans', name: 'Trembling Sans', emoji: '😰',
    description: 'A Sans shaking so hard he flickers. Whatever he saw, he\'s still seeing it.',
    hp: 200, atk: 11, def: 9, type: 'Bone', passive: null, rewards: NOREWARD,
    abilities: [
      { name: 'Panic Bones', description: 'Wild, terrified bones.', type: 'Bone', damageMin: 13, damageMax: 18, maxUses: 99, special: null },
      { name: 'Creeping Terror', description: 'Dread that spreads — applies Poison.', type: 'Magic', damageMin: 11, damageMax: 15, maxUses: 99, special: { type: 'poison', chance: 0.5 } },
    ],
  },
  unmade_papyrus: {
    id: 'unmade_papyrus', name: 'Unmade Papyrus', emoji: '📄',
    description: 'A Papyrus being erased one stroke at a time. He keeps trying to introduce himself.',
    hp: 250, atk: 12, def: 10, type: 'Melee', passive: null, rewards: NOREWARD,
    abilities: [
      { name: 'Unraveling Strike', description: 'A blow that comes apart mid-swing.', type: 'Melee', damageMin: 15, damageMax: 20, maxUses: 99, special: null },
      { name: 'Fraying Nerves', description: 'Saps your courage — drops your DEF by 2.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 99, special: { type: 'debuff', stat: 'def', amount: -2, target: 'enemy' } },
    ],
  },
  dread_sans: {
    id: 'dread_sans', name: 'Dread Sans', emoji: '🔥',
    description: 'Fear curdled into something hungry. It runs hot — every word it speaks scorches.',
    hp: 300, atk: 14, def: 11, type: 'Melee', passive: null, rewards: NOREWARD,
    abilities: [
      { name: 'Maul', description: 'A heavy, frightened swing.', type: 'Melee', damageMin: 16, damageMax: 22, maxUses: 99, special: null },
      { name: 'Searing Dread', description: 'Fear that burns — applies Burn.', type: 'Magic', damageMin: 12, damageMax: 17, maxUses: 99, special: { type: 'burn', duration: 2 } },
      { name: 'Despair', description: 'Smothers your offense — drops your ATK by 3.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 99, special: { type: 'debuff', stat: 'atk', amount: -3, target: 'enemy' } },
    ],
  },
  hollow_howl: {
    id: 'hollow_howl', name: 'Hollow Howl', emoji: '🌀',
    description: 'Not a Sans anymore. Just the shape of an AU\'s last scream, still echoing.',
    hp: 365, atk: 15, def: 12, type: 'Magic', passive: { name: 'Echoing', description: 'Heals 5 HP each turn.', type: 'regenHP', amount: 5 }, rewards: NOREWARD,
    abilities: [
      { name: 'Void Wail', description: 'A blast of pure noise.', type: 'Magic', damageMin: 17, damageMax: 23, maxUses: 99, special: null },
      { name: 'Spreading Rot', description: 'Decay seeps in — applies Poison.', type: 'Magic', damageMin: 13, damageMax: 18, maxUses: 99, special: { type: 'poison', chance: 0.55 } },
      { name: 'Wither', description: 'Hollows you out — drops your ATK by 3.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 99, special: { type: 'debuff', stat: 'atk', amount: -3, target: 'enemy' } },
    ],
  },
  herald_of_fear: {
    id: 'herald_of_fear', name: 'The Herald of Fear', emoji: '👁️',
    description: 'It walks ahead of the thing that\'s coming, so the worlds are already afraid when it arrives.',
    hp: 480, atk: 17, def: 13, type: 'Magic/Unique', isBoss: true, passive: null, rewards: NOREWARD,
    abilities: [
      { name: 'Herald\'s Toll', description: 'A bell only you can hear.', type: 'Magic', damageMin: 20, damageMax: 26, maxUses: 99, special: null },
      { name: 'Creeping Terror', description: 'Spreading dread — applies Poison.', type: 'Magic', damageMin: 15, damageMax: 20, maxUses: 99, special: { type: 'poison', chance: 0.55 } },
      { name: 'Searing Dread', description: 'Burns with fear — applies Burn.', type: 'Magic', damageMin: 14, damageMax: 19, maxUses: 99, special: { type: 'burn', duration: 2 } },
      { name: 'Cower', description: 'Crushes your guard — drops your DEF by 3.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 99, special: { type: 'debuff', stat: 'def', amount: -3, target: 'enemy' } },
    ],
  },
  phantom_error: {
    id: 'phantom_error_story', name: 'Phantom Error', emoji: '🧵',
    description: 'A copy of Error, forged from fear instead of code. It fights like him. It does NOT think like him.',
    hp: 620, atk: 20, def: 14, type: 'Unique/Magic', isBoss: true, passive: null, rewards: NOREWARD,
    abilities: [
      { name: 'False Blaster', description: 'A counterfeit skull beam.', type: 'Magic', damageMin: 21, damageMax: 28, maxUses: 99, special: null },
      { name: 'Fear-Strings', description: 'Strings of dread — applies Poison.', type: 'Magic', damageMin: 16, damageMax: 21, maxUses: 99, special: { type: 'poison', chance: 0.55 } },
      { name: 'Tangle', description: 'Binds your arms — drops your ATK by 3.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 99, special: { type: 'debuff', stat: 'atk', amount: -3, target: 'enemy' } },
      { name: 'Unwind', description: 'Pulls your defense apart — drops your DEF by 3.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 99, special: { type: 'debuff', stat: 'def', amount: -3, target: 'enemy' } },
    ],
  },
  fear_embodiment: {
    id: 'fear_embodiment', name: 'FEAR', emoji: '😱',
    description: 'The embodiment of fear itself. It is not large. It does not need to be. It already knows the size of yours.',
    hp: 820, atk: 24, def: 16, type: 'Unique/Magic', isBoss: true,
    passive: { name: 'Feeds On Dread', description: 'Heals 9 HP each turn.', type: 'regenHP', amount: 9 }, rewards: NOREWARD,
    abilities: [
      { name: 'Worst Case', description: 'Shows you exactly how it goes wrong.', type: 'Magic', damageMin: 22, damageMax: 29, maxUses: 99, special: null },
      { name: 'Cold Sweat', description: 'Terror sinks in — applies Poison.', type: 'Magic', damageMin: 18, damageMax: 24, maxUses: 99, special: { type: 'poison', chance: 0.55 } },
      { name: 'Night Terror', description: 'A fear that scorches — applies Burn (3 turns).', type: 'Magic', damageMin: 17, damageMax: 23, maxUses: 99, special: { type: 'burn', duration: 3 } },
      { name: 'Paralysis', description: 'Fear locks your limbs — drops your ATK by 4.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 99, special: { type: 'debuff', stat: 'atk', amount: -4, target: 'enemy' } },
    ],
  },
};

// ---------- VOLUME 2 BEATS ----------
const VOL2_BEATS = [
  // === ACT 1 — INK IS GONE ===
  { type: 'text', title: 'Volume 2: Destruction And Annihilation.',
    body: "The Doodlesphere is wrong.\n\nThe lights overhead aren't flickering anymore — they're going *out.* One by one, whole constellations of them just... stop. Each one that dies takes a world with it. The papers aren't drifting down gently. They're falling like ash.\n\nAnd Ink isn't here.\n\nYou wait for the brush-stroke in the air. The cheerful *\"oh! a new one!\"* The vial joke. Nothing comes. For the first time since you woke up in this place, you're standing in it completely alone.",
    buttons: [['story_next', '"...Ink?"']] },

  { type: 'text',
    body: "Static answers instead.\n\nIt gathers in the dark the way it did once before — blue threads, then a glitching red, pulling a familiar shape together out of nothing. Yellow teeth. Blue tear-tracks. A scowl you've seen before.\n\n**ERROR:** **ERROR.** ...oh, it's YOU. of course it's you. it's always you.\n\n**ERROR:** *(he looks around at the dying lights and his scowl deepens about forty percent)* ...okay. okay, this is worse than i thought, and i already thought it was pretty bad.",
    buttons: [['story_next', '"where\'s Ink?"']] },

  { type: 'text',
    body: "**ERROR:** gone. poof. *(he flicks a hand at the void)* off chasing a corruption signal way out past the edge — a BIG one, real juicy, exactly the kind of thing he can't say no to.\n\n**ERROR:** which would be a weird coincidence. except i don't believe in those. somebody dangled that signal in front of him on PURPOSE. got the one guy who can fix this as far away from here as possible. and THEN —\n\n**ERROR:** *(another light dies, close enough that you both flinch)* — and then they started turning the lights off.",
    buttons: [['story_next', '"who\'s they?"']] },

  { type: 'text',
    body: "**ERROR:** don't know yet. and i HATE not knowing. but here's the part that should scare you appropriately:\n\n**ERROR:** i delete anomalies. that's my whole thing. one at a time, clean, on purpose. what's happening out there right now isn't deleting. it's not even corruption like last time. it's *annihilation.* whole AUs, gone, like they were never DRAWN. and it's fast.\n\n**ERROR:** so. real talk. you don't have much time. and as much as it physically pains me to say this — *(it visibly pains him)* — i can't do this alone, the painter's gone, and you're the only thing standing here with an actual team. so you're it. congratulations. i'm so thrilled.",
    buttons: [['story_next', '"...we doing this or not?"']] },

  { type: 'text',
    body: "**ERROR:** *(a long pause. a glitch ripples through him.)* ...heh. yeah. yeah, okay. you've got the attitude for it, i'll give you that.\n\n**ERROR:** rules are the same as whatever Ink told you — real fights, your team, your moves. if you go down you go down for real and we burn time we don't have putting you back together. so DON'T.\n\n**ERROR:** first one's already in range. set your team if you need to — *(`/setteam`)* — and make it quick. the lights aren't waiting for us.",
    buttons: [['story_next', 'go.']] },

  // === FIGHT 1 ===
  { type: 'fight', encounter: V2_ENEMIES.trembling_sans,
    intro: "You step toward the nearest dying light. The AU around it is half-gone — a Snowdin with no sky, no ground past the path, just a Sans standing in the middle of it shaking so hard he blurs.\n\n**TREMBLING SANS:** *it's coming it's coming it's COMING you have to — you can't — there's no — *\n\n**ERROR:** he's not corrupted. he's just *terrified.* something scared him so bad it broke him, and now he'll swing at anything that moves. that's you. watch the poison — fear like this *spreads.*",
    victory: "The Trembling Sans stops shaking. For one second he just looks tired. Then his light goes out, and the AU folds shut around the space where he stood.\n\n**ERROR:** ...tch. couldn't even save him. there was nothing left TO save. whatever did this got here first.\n\n**ERROR:** and it left him scared to death so we'd have to go through him to follow it. cute. i hate it.",
    defeat: "The Trembling Sans' panic is contagious — your team buckles under it and goes down.\n\n**ERROR:** the poison stacked up and you let it. heal through fear, don't let it sit on you. get up. we do NOT have the time for a funeral.\n\n*(Press Retry when you're ready.)*" },

  { type: 'text',
    body: "**ERROR:** quick lesson, since the painter's not here to hold your hand and i refuse to hold it either.\n\n**ERROR:** these things ahead of us aren't trying to corrupt your team or copy themselves. they're running on pure *fear,* and fear does three things: it *burns,* it *poisons,* and it makes you *weak* — chips your ATK, your DEF, whatever it can reach. so heal early, don't let the stacks pile, and end fights FAST. the longer you stand there, the more afraid everything gets.\n\n**ERROR:** there's another one ahead. it's barely holding its own shape. let's go put it out of its misery — kindly. ish.",
    buttons: [['story_next', '"got it."']] },

  // === FIGHT 2 ===
  { type: 'fight', encounter: V2_ENEMIES.unmade_papyrus,
    intro: "The next AU is almost entirely white. Erased. Standing in the blank is a Papyrus, and half of him is already gone — one arm, part of his skull, just *not there,* like an artist gave up mid-stroke.\n\n**UNMADE PAPYRUS:** NYEH! GREETINGS! I AM THE GREAT— I AM THE GREAT— *(the line won't finish; the part of him that knows his own name is already erased)* —I... AM... I'M SORRY, WHO AM I?\n\n**ERROR:** ...oh, that's grim. he's being *unmade* in real time and he's still trying to be polite about it. put him down before it gets worse. watch your DEF — he'll fray it.",
    victory: "The Unmade Papyrus gets out one last NYEH — proud, certain, like he finally remembered — and then the white takes the rest of him.\n\n**ERROR:** *(quiet, for Error)* ...he was happy at the end. didn't know what was happening, but he was happy. small mercy.\n\n**ERROR:** okay. i'm officially done feeling things for today, that's my limit. let's find whatever's DOING thi—",
    defeat: "The erasure spreads to your team faster than you can stop it. You go down in the white.\n\n**ERROR:** he frayed your guard and you didn't shore it back up. keep your DEF healthy or everything hits like a truck. again — and faster this time.\n\n*(Press Retry when you're ready.)*" },

  // === ACT 2 — THE OBSERVER ===
  { type: 'text',
    body: "**ERROR:** —thi—\n\nError doesn't finish. Because the dark *changes.*\n\nIt doesn't get darker. It gets... *attentive.* Like a room you thought was empty turning out to have someone sitting very still in the corner, who has been watching you the entire time, and is only now letting you know.\n\nA voice arrives. It's calm. It's polite. It's the worst thing you've heard since you got here, precisely because it isn't trying to be.\n\n**THE OBSERVER:** There it is. The variable I came to see.",
    buttons: [['story_next', '"...who said that?"']] },

  { type: 'text',
    body: "**THE OBSERVER:** Please don't mind me. I'm only observing. I've been observing for some time, in fact — since you put down the little printing thing in the Doodlesphere. The Fabrication. You remember.\n\n**THE OBSERVER:** That was *interesting.* You were new, and undertrained, and you won anyway. I found myself wanting to know how. Whether it would happen again under... harsher conditions. So I arranged some.\n\n**ERROR:** *(low, furious)* ...it was YOU. the signal. you got Ink out of the way.\n\n**THE OBSERVER:** I got the variable's *handler* out of the way. I wanted to measure the variable. Not the painter holding its hand.",
    buttons: [['story_next', '"measure WHAT?"']] },

  { type: 'text',
    body: "**THE OBSERVER:** You. Your capabilities. Your ceiling. *(a sound that might be a smile)* I'm a curious sort. And curiosity, when it has waited long enough, stops being content to watch.\n\n**THE OBSERVER:** So I brought a guest. Something I've kept for a very long time, for a very specific occasion. The embodiment of fear itself. I've let it off its leash, pointed it at these little worlds, and now I get to learn the most fascinating thing of all:\n\n**THE OBSERVER:** how much you can save before it eats everything. The clock is already running. Do try to make it interesting.",
    buttons: [['story_next', '"...we don\'t have time for this."']] },

  { type: 'text',
    body: "The attention withdraws — not gone, just *back to its corner.* Watching.\n\n**ERROR:** *(staring at the spot the voice came from)* ...i have deleted a LOT of things. i have met a lot of bad things. that one's new. and i don't like new.\n\n**ERROR:** but he just told us the rules, which was dumb of him. there's a *thing* out there made of fear, it's annihilating AUs, and it's on a timer. we find it. we put it down. we wipe that little smile off whatever he keeps it on.\n\n**ERROR:** more ahead. the fear's getting THICKER. you feel that? good. means we're going the right way.",
    buttons: [['story_next', 'forward.']] },

  // === FIGHT 3 ===
  { type: 'fight', encounter: V2_ENEMIES.dread_sans,
    intro: "This AU is on fire. Not normal fire — it burns black and gives off cold instead of heat. In the middle of it stands a Sans whose eye-lights have gone out, replaced with two small twin flames.\n\n**DREAD SANS:** *you're afraid. good. you SHOULD be. it's the only smart thing left to feel.*\n\n**ERROR:** great, this one's marinated in it long enough to talk back. it'll BURN you — keep your HP up and don't let the burn ride. burst it down before the fear gets a grip on your team.",
    victory: "The black flames gutter out. The Dread Sans blinks — his real eye-lights flicker back for half a second, confused, almost grateful — and then he's gone with the rest of his world.\n\n**ERROR:** the closer we get, the worse they are. that's not a coincidence either. they're soaking it up like sponges the nearer they are to the source.\n\n**ERROR:** which means *we're* getting closer to the source. yay. i guess.",
    defeat: "The black fire catches your whole team and the cold does the rest.\n\n**ERROR:** the burn ate you alive — i TOLD you not to let it ride. heal it off, don't tank it. we go again, and this time respect the fire.\n\n*(Press Retry when you're ready.)*" },

  { type: 'text',
    body: "**THE OBSERVER:** *(idle, almost warm, like a researcher murmuring into a recorder)* Note. The variable adapts mid-engagement. It lost ground to the burn, then adjusted its healing cadence and recovered. Most specimens panic when they start to lose. This one... recalculates.\n\n**THE OBSERVER:** Promising. I'd hate to be disappointed this late. Keep recalculating. There's so much more to be afraid of ahead.\n\n**ERROR:** *(to you, not him)* ...ignore the narrator. he WANTS the reaction. don't give it to him. just keep moving and break his toy.",
    buttons: [['story_next', '"happy to."']] },

  // === FIGHT 4 ===
  { type: 'fight', encounter: V2_ENEMIES.hollow_howl,
    intro: "There's no AU here anymore. Just a wound in the dark where one used to be, and a shape hanging in the middle of it — a Sans-sized absence, screaming a scream you can't hear but can absolutely feel in your teeth.\n\n**ERROR:** ...that's not a person. that's the LAST THING an AU felt, left hanging here because there's nobody alive to stop feeling it. it heals off the dread in the air, so OUT-DAMAGE it — don't get into a long fight, you'll lose the race.",
    victory: "The Hollow Howl finally goes silent. The wound in the dark closes. For a moment, the quiet is enormous.\n\n**ERROR:** *(very still)* ...you hear that? nothing. that's a whole world's worth of nothing where something used to be.\n\n**ERROR:** he's not just scaring them. he's ERASING them after. annihilation, like i said. we have to be close now. we HAVE to be.",
    defeat: "The howl gets inside your team and they can't out-pace its hunger. You fall.\n\n**ERROR:** it healed faster than you hit. that's a tempo loss, not a power loss — hit HARDER up front, don't let it stall. again.\n\n*(Press Retry when you're ready.)*" },

  { type: 'text',
    body: "The dark ahead isn't dark anymore. It's *crowded.* You can feel them before you see them — every fear of every world that's been eaten, pressed up against the edge of wherever you're standing, waiting.\n\n**ERROR:** okay. OKAY. that's a wall of it. and something's standing at the front of the wall, holding the door.\n\n**ERROR:** it's a herald. fear's little doorman. it goes ahead of the real thing so the worlds are already screaming by the time the real thing shows up. *(cracks his glitching knuckles)* which means we knock first.\n\n**ERROR:** this one's a real fight. it'll burn you AND poison you AND crush your guard. spread your damage, heal smart, and do NOT get greedy. ready?",
    buttons: [['story_next', 'knock.']] },

  // === FIGHT 5 — SUB-BOSS ===
  { type: 'fight', encounter: V2_ENEMIES.herald_of_fear,
    intro: "It's tall, and thin, and wrong, and where its face should be there's a single open eye that's looking at every part of you at once — the parts you show and the parts you don't.\n\n**THE HERALD OF FEAR:** *I ANNOUNCE WHAT COMES. it is already here. it has always already been here. you are simply the last to notice.*\n\n**ERROR:** big talker. all heralds are. SHUT IT UP. everything it's got, all at once — burn, poison, and it'll cower your DEF. heal through the storm and out-last the speech.",
    victory: "The Herald's single eye closes — slowly, like a door easing shut — and the wall of fear behind it shudders.\n\n**THE HERALD OF FEAR:** *...you knocked. how... rude. it will answer the door itself now. i hope you're proud.*\n\n**THE OBSERVER:** Oh, *well done.* You beat the doorman. Now you get to meet the host. I confess I'm leaning forward a little. Metaphorically. I don't have a body you'd recognize as one.",
    defeat: "The Herald's storm of fear is too much on every front at once. Your team falls before the door.\n\n**ERROR:** too much pressure, not enough heals — that one punishes greed. trim your damage, keep everyone topped up, ride it out. again.\n\n*(Press Retry when you're ready.)*" },

  { type: 'text',
    body: "The wall of fear parts. And behind it, the dark gives up *one more thing* — and Error makes a sound you've never heard him make.\n\nBecause the thing stepping through wears HIS face. His teeth. His strings. His scowl, copied down to the glitch.\n\n**ERROR:** ...no. nope. NO. that's — that's not — *(strings of static lash off him)* — he made a copy of ME. out of FEAR. that's not how i work, i'm not MADE of that, i'm made of CODE, you can't just —\n\n**THE OBSERVER:** Can't I? You delete anomalies because you're afraid of what they'll do if you don't. I simply distilled the fear and left out the rest. Say hello to the honest version of yourself.\n\n**PHANTOM ERROR:** **ERROR. ERROR. delete. delete EVERYTHING. delete it before it hurts you. delete it ALL.**",
    buttons: [['story_next', '"...that\'s not you, Error."']] },

  { type: 'text',
    body: "**ERROR:** *(the static settles. barely.)* ...no. it's not. it's the part of me i keep on a leash, walking around with no leash and no anything-else.\n\n**ERROR:** i can't fight it. if i touch it, it's just two of us screaming \"delete\" at each other forever and the timer runs out. so it's YOU. you put my worst self down, and you do it clean, and you do NOT listen to a word it says. it'll tangle your ATK and unravel your DEF — keep BOTH propped up and just out-pace it.\n\n**ERROR:** ...and hey. for what it's worth. i'm glad the real me is over here. behind you. helping. that's. *(a glitch)* ...that's not nothing.",
    buttons: [['story_next', 'put it down.']] },

  // === FIGHT 6 — MINI-BOSS ===
  { type: 'fight', encounter: V2_ENEMIES.phantom_error,
    intro: "The Phantom Error doesn't banter. It doesn't recalculate. It only knows one word, and it's coming for everything you've built, one string at a time.\n\n**PHANTOM ERROR:** **delete the team. delete the painter. delete the variable. delete the OBSERVER. delete the fear. delete ERROR. delete — delete — DELETE —**\n\n**ERROR:** *(behind you, arms crossed, knuckles white)* ...yeah. that's what it sounds like in there. now you know why i keep it quiet. END it.",
    victory: "The Phantom Error comes apart — not deleted, *unravelled,* every string pulling loose until there's nothing left to scream with.\n\nThe real Error lets out a breath he didn't need to hold.\n\n**ERROR:** ...thanks. for not flinching. for not believing it. *(he won't look at you, which from Error is basically a hug)* ...okay. enough. the host's right through there. let's go ruin the Observer's whole evening.",
    defeat: "Its strings find every gap — ATK, DEF, all of it — and your team unravels.\n\n**ERROR:** it stripped you down because you let one stat slide. keep ATK *and* DEF propped, don't let either bottom out. one more time. you've got this — i'd know.\n\n*(Press Retry when you're ready.)*" },

  // === ACT 4 — FEAR ===
  { type: 'text',
    body: "Past the door, there's no AU at all. No snow, no white, no wound. Just a small, quiet, ordinary dark — the kind you knew as a kid, the kind with the door open just a crack and something on the other side of it.\n\nAnd in the middle of the quiet, something small uncurls and stands up. It's not big. The Observer was right about that. It's exactly your size. It's been your size the whole time.\n\n**FEAR:** *oh. you came all this way. for them? the little worlds? they're gone. they were always going to be gone. you knew that, and you came anyway, and THAT —* *(it tilts its head)* *— that is the most frightened thing i've ever seen anyone do.*",
    buttons: [['story_next', '...']] },

  { type: 'text',
    body: "**FEAR:** *i know what you're scared of. it's small. it's so SMALL. but it's yours, and i can make it the whole sky.*\n\n**FEAR:** *that you're not enough. that you got lucky. that the painter left because some part of him knew you'd never measure up, and the static one's only helping because there's no one better around. that every world you \"saved\" was just a world that hadn't finished dying yet.*\n\n**ERROR:** *(stepping up beside you — actually beside you, for once)* ...it talks like that to everyone. it talked like that to me for a THOUSAND years. you wanna know the secret to beating it?\n\n**ERROR:** you show up scared, and you swing anyway. that's the whole trick. that's ALL it ever was. now —",
    buttons: [['story_next', 'swing anyway.']] },

  { type: 'text',
    body: "**ERROR:** — this is it. the embodiment of fear ITSELF. it heals off your dread, so the longer you're scared, the longer it lives. it'll burn you, poison you, sweat you cold, lock your arms up with sheer panic.\n\n**ERROR:** so here's the play: keep your HP cushion FAT, heal the burn and poison the SECOND they land, and just. keep. swinging. out-damage its self-heal and it can't out-last you. it's a feeling. feelings end. MAKE it end.\n\n**FEAR:** *you're trembling.*\n\n**ERROR:** yeah. and they're still here. go.",
    buttons: [['story_next', 'END IT.']] },

  // === FIGHT 7 — FINALE BOSS ===
  { type: 'fight', encounter: V2_ENEMIES.fear_embodiment,
    intro: "It steps toward you wearing every worst-case you've got, stacked one behind the other like a hallway of doors all opening at once.\n\nBut it's your size. It was always your size. And there's a static skeleton at your shoulder who spent a thousand years afraid and showed up anyway.\n\n**FEAR:** *let me show you how it ends.*\n\n**ERROR:** no. let's show IT. EVERYTHING you've got — NOW!",
    victory: "FEAR doesn't explode. It doesn't scream. It just gets *smaller* — and smaller — back down to the size of a thing under a kid's bed, then the size of a held breath, then nothing at all. The quiet dark goes back to being only dark.\n\nThe lights, far overhead, begin — slowly, one at a time — to come back on.\n\n**ERROR:** *(staring up at them)* ...it's stopping. the annihilation. it needed the fear to feed on and you just — you turned off the food.\n\n**ERROR:** *(and then, almost like it hurts him)* ...you did good. real good. don't let it go to your head, i'll deny i said it.",
    defeat: "FEAR shows you exactly how it ends, and for a moment you believe it, and that moment is all it needs.\n\n**ERROR:** it fed on you standing still. you CAN'T stall this one — heal the instant it burns or poisons you and keep the damage flowing. don't let it out-last you. up. one more. swing anyway.\n\n*(Press Retry when you're ready.)*" },

  { type: 'text',
    body: "You're still standing. Scared, maybe. Standing, definitely.\n\nAnd then the attention comes back to its corner — and this time it isn't cold. This time it's *delighted,* which is so much worse.\n\n**THE OBSERVER:** *Marvelous.* Truly. You took the embodiment of fear itself, on a clock, without your handler, and you closed it out. Do you understand how rare that is? I've watched a great many variables. Most of them break. You *recalculated.*\n\n**THE OBSERVER:** I have everything I came for. The data is exquisite. Thank you — sincerely — for the demonstration.",
    buttons: [['story_next', '"who ARE you?"']] },

  { type: 'text',
    body: "**THE OBSERVER:** A question for another time. We'll have one. *(that almost-smile again)* You see, fear was never the experiment. Fear was the *entrance exam.* I needed to know whether you were worth the real one.\n\n**THE OBSERVER:** You are. So. Go rest. Gather your little team. Enjoy the lights coming back on — you've earned that much. The next thing I have planned doesn't burn worlds down.\n\n**THE OBSERVER:** It changes what they are while they're still living in them. And THAT... I'll want you awake for.\n\n*(The attention withdraws — all the way, this time. But you know, now, that it can come back whenever it likes.)*",
    buttons: [['story_next', '...']] },

  { type: 'text',
    body: "A brush-stroke tears across the dark.\n\nInk all but falls through it, mid-sentence as always, paint everywhere, three vials deep and panicking.\n\n**INK:** —and the signal was FAKE, it was a DECOY, i flew to the literal edge of everything for NOTHING and the whole time you were— *(he stops. takes in the relit lights, the quiet, you still standing, Error standing next to you)*\n\n**INK:** ...oh. oh, you handled it. you and— *(he points at Error)* —is that ERROR? are you two FRIENDS now? what did i MISS? what happened to my WORLDS? someone start from the beginning, i have so many vials and so many questions—\n\n**ERROR:** *(already glitching away)* ...not it. you explain. i'm going home.",
    buttons: [['story_next', 'rest.']] },

  { type: 'end' },
];

// ---------- VOLUME 2 RENDER ----------
// Fight intro/victory/defeat renders are vol-agnostic — reuse the V1 ones.
function grantCompletionV2(userId) {
  if (playerDB.hasAchievement(userId, DESTRUCTION_ACH)) return false;
  playerDB.grantAchievement(userId, DESTRUCTION_ACH);
  playerDB.addItem(userId, 'dt_vial', 3000);
  playerDB.addSoulEssence(userId, 5000);
  playerDB.addDetermination(userId, 1500);
  return true;
}

function renderEndV2(userId) {
  const firstClear = grantCompletionV2(userId);
  sessions.delete(userId);
  const rewardLine = firstClear
    ? "**Rewards:**\n> 💧 +3,000 DT Vials\n> ✨ +5,000 Soul Essence\n> ❤️ +1,500 Determination\n> 🏆 Achievement: **Destruction And Annihilation.**"
    : "*(You've already claimed Volume 2's rewards.)*";
  const body = "🏆 **VOLUME 2 CLEARED — DESTRUCTION AND ANNIHILATION.**\n\nThe lights are coming back on. The fear is gone. Ink is home, and somehow you and Error are... whatever you two are now.\n\nBut the one who was watching got exactly what he wanted from you — and he says fear was only the entrance exam.\n\n" + rewardLine + "\n\n**Volume 3: Mass Corruption** is now available — open the Story Hub to continue.";
  return { embeds: [embed(null, body)], components: [row(btn('story_hub', '📖 Story Hub', ButtonStyle.Secondary))] };
}

function renderCurrentV2(userId) {
  const s = sessions.get(userId);
  if (!s) return hubScreen(userId);
  const beat = VOL2_BEATS[s.i];
  if (!beat) return renderEndV2(userId);
  if (beat.type === 'text') return renderText(beat);
  if (beat.type === 'end') return renderEndV2(userId);
  if (beat.type === 'fight') {
    if (s.fightStage === 'won') return renderVictoryV1(beat);
    if (s.fightStage === 'lost') return renderDefeatV1(beat);
    return renderFightIntroV1(beat);
  }
  return renderText(beat);
}


// ============================================================
// VOLUME 3: Mass Corruption.
// A single AU left behind in the Vol 2 cleanup festered — and now a
// corruption is rewriting living worlds into "freed" versions of
// themselves. Ink AND Error are both in this time. Endgame-tier:
// every enemy is 1,800+ HP and hits hard. Purely additive to story.js.
// ============================================================

const MASS_ACH = 'mass_corruption';

// Endgame curve. Every enemy >= 1,800 HP, higher ATK than Vol 2, heavier
// DoT/debuff stacking, and boss self-heal to force a real damage race.
// Verified-only specials: null / poison(+chance) / burn(+duration) /
// debuff(stat/amount/target:'enemy') / regenHP passive.
const V3_ENEMIES = {
  liberated_sans: {
    id: 'liberated_sans', name: 'Liberated Sans', emoji: '⛓️',
    description: 'A Sans rewritten mid-sentence. He keeps reaching for "sup" and finding the gospel instead.',
    hp: 1800, atk: 16, def: 12, type: 'Bone', passive: null, rewards: NOREWARD,
    abilities: [
      { name: 'Unchained Bones', description: 'Bones that snapped their own leash.', type: 'Bone', damageMin: 22, damageMax: 30, maxUses: 99, special: null },
      { name: 'Gospel Rot', description: 'The good word festers — applies Poison.', type: 'Magic', damageMin: 18, damageMax: 25, maxUses: 99, special: { type: 'poison', chance: 0.55 } },
    ],
  },
  rewritten_papyrus: {
    id: 'rewritten_papyrus', name: 'Rewritten Papyrus', emoji: '✒️',
    description: 'His cheer survived the rewrite. It just points somewhere terrible now.',
    hp: 2000, atk: 17, def: 13, type: 'Melee', passive: null, rewards: NOREWARD,
    abilities: [
      { name: 'Zealous Strike', description: 'A blow delivered with a smile.', type: 'Melee', damageMin: 24, damageMax: 32, maxUses: 99, special: null },
      { name: 'Doubt', description: 'Unwrites your confidence — drops your DEF by 4.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 99, special: { type: 'debuff', stat: 'def', amount: -4, target: 'enemy' } },
    ],
  },
  unscripted_sans: {
    id: 'unscripted_sans', name: 'Unscripted Sans', emoji: '🔥',
    description: 'He read the last page of his own story, hated the ending, and tore it out. All of it.',
    hp: 2200, atk: 18, def: 13, type: 'Weapon', passive: null, rewards: NOREWARD,
    abilities: [
      { name: 'Off-Script', description: 'A move from no story at all.', type: 'Weapon', damageMin: 26, damageMax: 35, maxUses: 99, special: null },
      { name: 'Burning Freedom', description: 'Liberation that scorches — applies Burn.', type: 'Magic', damageMin: 20, damageMax: 27, maxUses: 99, special: { type: 'burn', duration: 2 } },
      { name: 'Rend', description: 'Tears at your grip — drops your ATK by 4.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 99, special: { type: 'debuff', stat: 'atk', amount: -4, target: 'enemy' } },
    ],
  },
  the_chorus: {
    id: 'the_chorus', name: 'The Chorus', emoji: '🎭',
    description: 'A dozen rewritten AUs singing one note. The note is "join us." It is very persuasive.',
    hp: 2500, atk: 19, def: 14, type: 'Magic', passive: { name: 'Many Voices', description: 'Heals 8 HP each turn.', type: 'regenHP', amount: 8 }, rewards: NOREWARD,
    abilities: [
      { name: 'Harmony', description: 'A chord that hits like a wall.', type: 'Magic', damageMin: 25, damageMax: 33, maxUses: 99, special: null },
      { name: 'Discord', description: 'A sour note that festers — applies Poison.', type: 'Magic', damageMin: 21, damageMax: 28, maxUses: 99, special: { type: 'poison', chance: 0.6 } },
      { name: 'Drown Out', description: 'Buries your voice — drops your ATK by 4.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 99, special: { type: 'debuff', stat: 'atk', amount: -4, target: 'enemy' } },
    ],
  },
  the_apostle: {
    id: 'the_apostle', name: 'The Apostle', emoji: '📿',
    description: 'It walks ahead of the gospel and prepares the way. It believes every word it bleeds.',
    hp: 2900, atk: 24, def: 15, type: 'Magic/Unique', isBoss: true, passive: null, rewards: NOREWARD,
    abilities: [
      { name: 'Sermon', description: 'Words that land like fists.', type: 'Magic', damageMin: 28, damageMax: 37, maxUses: 99, special: null },
      { name: 'Conversion', description: 'Rewrites you a little — applies Poison.', type: 'Magic', damageMin: 23, damageMax: 31, maxUses: 99, special: { type: 'poison', chance: 0.6 } },
      { name: 'Zeal', description: 'Burning conviction — applies Burn.', type: 'Magic', damageMin: 22, damageMax: 29, maxUses: 99, special: { type: 'burn', duration: 2 } },
      { name: 'Penance', description: 'Bows your guard — drops your DEF by 4.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 99, special: { type: 'debuff', stat: 'def', amount: -4, target: 'enemy' } },
    ],
  },
  the_first_freed: {
    id: 'the_first_freed', name: 'The First Freed', emoji: '🗝️',
    description: 'The very first world he "liberated." It loves him for it. That is the worst part.',
    hp: 3300, atk: 26, def: 16, type: 'Unique/Magic', isBoss: true,
    passive: { name: 'Devotion', description: 'Heals 12 HP each turn.', type: 'regenHP', amount: 12 }, rewards: NOREWARD,
    abilities: [
      { name: 'First Light', description: 'The blaze of a true believer.', type: 'Magic', damageMin: 30, damageMax: 40, maxUses: 99, special: null },
      { name: 'Spread The Word', description: 'The corruption reaches — applies Poison.', type: 'Magic', damageMin: 25, damageMax: 33, maxUses: 99, special: { type: 'poison', chance: 0.6 } },
      { name: 'Pyre', description: 'A devoted fire — applies Burn (3 turns).', type: 'Magic', damageMin: 24, damageMax: 32, maxUses: 99, special: { type: 'burn', duration: 3 } },
      { name: 'Humble', description: 'Bends your strength — drops your ATK by 4.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 99, special: { type: 'debuff', stat: 'atk', amount: -4, target: 'enemy' } },
    ],
  },
  the_mass: {
    id: 'the_mass', name: 'The Mass', emoji: '🕳️',
    description: 'Too many freed worlds, fused into one. It does not have a face. It has all of them.',
    hp: 3800, atk: 28, def: 16, type: 'Unique/Magic', isBoss: true,
    passive: { name: 'Ever-Growing', description: 'Heals 14 HP each turn.', type: 'regenHP', amount: 14 }, rewards: NOREWARD,
    abilities: [
      { name: 'Collapse', description: 'A whole world falling on you at once.', type: 'Magic', damageMin: 33, damageMax: 44, maxUses: 99, special: null },
      { name: 'Assimilate', description: 'Pulls you toward it — applies Poison.', type: 'Magic', damageMin: 27, damageMax: 36, maxUses: 99, special: { type: 'poison', chance: 0.65 } },
      { name: 'Immolate', description: 'A bonfire of selves — applies Burn (3 turns).', type: 'Magic', damageMin: 26, damageMax: 34, maxUses: 99, special: { type: 'burn', duration: 3 } },
      { name: 'Crush', description: 'Smothers your guard — drops your DEF by 5.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 99, special: { type: 'debuff', stat: 'def', amount: -5, target: 'enemy' } },
    ],
  },
  the_liberator: {
    id: 'the_liberator', name: 'THE LIBERATOR', emoji: '👁️‍🗨️',
    description: 'He had a name once. They gave it to him. He gave it back. Now he gives everyone the same gift, whether they want it or not.',
    hp: 4500, atk: 32, def: 18, type: 'Unique/Magic', isBoss: true,
    passive: { name: 'Free At Last', description: 'Heals 18 HP each turn.', type: 'regenHP', amount: 18 }, rewards: NOREWARD,
    abilities: [
      { name: 'Emancipate', description: 'He frees you from most of your HP.', type: 'Magic', damageMin: 40, damageMax: 52, maxUses: 99, special: null },
      { name: 'The Gospel', description: 'His truth gets in — applies Poison.', type: 'Magic', damageMin: 30, damageMax: 40, maxUses: 99, special: { type: 'poison', chance: 0.65 } },
      { name: 'Ascension', description: 'Burns the cage away — applies Burn (3 turns).', type: 'Magic', damageMin: 29, damageMax: 38, maxUses: 99, special: { type: 'burn', duration: 3 } },
      { name: 'Unmake The Script', description: 'Strips you of your role — drops your ATK by 5.', type: 'Unique', damageMin: 0, damageMax: 0, maxUses: 99, special: { type: 'debuff', stat: 'atk', amount: -5, target: 'enemy' } },
    ],
  },
};

// ---------- VOLUME 3 BEATS ----------
const VOL3_BEATS = [
  // === ACT 1 — THE MISTAKE ===
  { type: 'text', title: 'Volume 3: Mass Corruption.',
    body: "It started small. It always does.\n\nWhen the fear burned out and the lights came back, the cleanup was easy — sweep the dead AUs, patch the holes, move on. You and Error and a freshly-returned Ink put the multiverse back together one world at a time.\n\nYou missed one.\n\nJust one. A little half-finished AU way out at the edge, dark and quiet, easy to overlook. Nobody meant to leave it. But it sat there in the dark, alone, rotting — and rot, given long enough and no one watching, learns to *spread.*",
    buttons: [['story_next', '"...spread how?"']] },

  { type: 'text',
    body: "A brush-stroke and a burst of static tear open the air at the same time, from opposite directions, and two very different skeletons step through and immediately start arguing.\n\n**INK:** —i'm just SAYING, if you'd flagged the edge sectors like i ASKED—\n\n**ERROR:** if YOU hadn't been three vials deep and crying about a sunset, MAYBE—\n\n**INK:** it was a NICE sunset! *(notices you)* oh! hey! okay, good, you're here, you can referee. tell him the sunset thing was reasonable.\n\n**ERROR:** do NOT referee. there's nothing to referee. there's a catastrophe. focus on the catastrophe.",
    buttons: [['story_next', '"what catastrophe?"']] },

  { type: 'text',
    body: "**ERROR:** the AU you all forgot. it didn't just die quiet like it was supposed to. something in it *woke up.*\n\n**INK:** *(the cheer drops out of him completely — which, from Ink, is genuinely scary)* ...this isn't copies. it isn't erasing. it's something new. whatever woke up in that AU is *rewriting* the others. reaching into living worlds and changing what they ARE — while everyone's still inside them. still awake. still *themselves,* right up until they're not.\n\n**INK:** they call it being *freed.* they're so happy about it. that's the part that — *(he can't finish)*",
    buttons: [['story_next', '"freed from what?"']] },

  { type: 'text',
    body: "**ERROR:** from their story. their script. the whole \"i'm a character in an AU and this is who i am\" thing. somebody out there decided that's a *prison,* and decided everybody's in it, and decided to kick all the doors open at once. whether anyone asked or not.\n\n**ERROR:** and it's MASS now. it's not one world. it's a wave. it's moving faster than the three of us can cleanse, and every world it rewrites becomes another mouth screaming the good news at the next one.\n\n**ERROR:** *(looks at you, and for once there's no sarcasm)* ...and yeah. it got out through the gap we left. so. we fix it. all of us. you ready for the worst one yet?",
    buttons: [['story_next', '"...let\'s go fix it."']] },

  { type: 'text',
    body: "**INK:** *(grin flickering back, smaller, real)* there it is. okay. ground rules, since it's the big leagues now and i love you and i don't want you deleted:\n\n**INK:** these things are STRONG. not corrupted-weak like the duplicates, not fear-fragile like last time — they're *converts,* and converts fight like they've got nothing left to lose, because they gave it all away on purpose. they hit hard. they burn, they poison, they sap you down. fights will go LONG.\n\n**INK:** so bring your best team. heal early, heal often, and settle in. set up with `/setteam` and let's save some worlds from being saved to death.",
    buttons: [['story_next', 'go.']] },

  // === FIGHT 1 ===
  { type: 'fight', encounter: V3_ENEMIES.liberated_sans,
    intro: "The first rewritten world flickers around you — a Snowdin that keeps glitching between snow and something brighter and worse. A Sans stands in the middle of it, and when he turns, half his face is still grinning the old lazy grin and half of it is doing something you don't have a word for.\n\n**LIBERATED SANS:** *sup. SUP. it's so good, friend. the door was open the WHOLE time. you should — sup — you should come through. it doesn't even hurt. it doesn't — sup — it doesn't hurt much.*\n\n**ERROR:** he's gone. there's no him left to save, just the thing wearing the memory of him. put him down gentle and DON'T let the poison sit — these converts rot you from the inside.",
    victory: "The Liberated Sans sighs, and for one clean second the old grin wins — tired, real, *sorry* — and then the rewrite finishes erasing the part of him that could be sorry, and there's nothing left to fight.\n\n**INK:** *(quiet)* ...i drew a thousand of him. the lazy ones. they were always my favorite. they never wanted anything except to be left alone.\n\n**ERROR:** and somebody decided that was a cage. yeah. i know. come on.",
    defeat: "The rot gets into your team faster than you can cleanse it, and one by one they stop being yours.\n\n**ERROR:** the poison stacked and you let it ride — you CAN'T do that here, these fights are long and the rot adds up. heal it the second it lands. again.\n\n*(Press Retry when you're ready.)*" },

  { type: 'text',
    body: "**ERROR:** quick recalibration, since you're clearly used to things dying when you look at them funny.\n\n**ERROR:** these are not those things. everything from here is a WALL — eighteen hundred HP and up, and the bosses laugh at that number. you're not gonna burst anything down. you're gonna out-LAST it. heal through the burn and poison, keep your stats from bottoming out, and grind it honest.\n\n**INK:** he's right, which i hate to admit out loud. pace yourself. this is a marathon volume. there's another convert two worlds over and it is NOT going to be quick.",
    buttons: [['story_next', '"understood."']] },

  // === FIGHT 2 ===
  { type: 'fight', encounter: V3_ENEMIES.rewritten_papyrus,
    intro: "The next world is bright. Too bright. A Papyrus stands at the center of it with his arms thrown wide and the widest, warmest, most *wrong* smile you have ever seen.\n\n**REWRITTEN PAPYRUS:** HUMAN! FRIEND! I HAVE WONDERFUL NEWS! I USED TO WANT TO CAPTURE YOU! NOW I WANT SOMETHING SO MUCH BETTER! I WANT TO *FREE* YOU! HOLD STILL, IT IS A GIFT!\n\n**INK:** ...no. not this one. not Papyrus. *(brush hand shaking)* he's still in there — he still thinks he's being KIND — that's worse, that's so much worse. ...end it. before he 'gifts' us. watch your DEF, he'll talk it right out from under you.",
    victory: "The Rewritten Papyrus blinks. For a moment the smile becomes a *real* one — confused, gentle, the Papyrus underneath surfacing just long enough to not understand why his friend looks so sad — and then he's gone.\n\n**INK:** *(very still for a long moment)* ...okay. okay. i'm putting that one in a box in my head and i am NOT opening it until this is over.\n\n**ERROR:** ...for what it's worth. that's the right call. i've got a lot of boxes. they work. let's move.",
    defeat: "He 'frees' your guard right out from under you and the rest follows. Your team falls smiling at.\n\n**ERROR:** he stripped your DEF and you didn't shore it back — keep it propped or every hit lands double. up. again.\n\n*(Press Retry when you're ready.)*" },

  // === ACT 2 — THE OBSERVER'S HAND ===
  { type: 'text',
    body: "And then the dark gets *attentive* — that same awful stillness from before, the feeling of a room that was never empty.\n\n**THE OBSERVER:** Beautiful work. Truly. I've been so looking forward to this one.\n\n**ERROR:** *(instantly)* ...you. of COURSE it's you. you've been watching the whole time.\n\n**THE OBSERVER:** I'm always watching. But this time I'll admit to a little more than watching. The fear was the entrance exam, remember? *This* is the examination. And I confess — I helped it along. Just a nudge. A door left open. An AU left... overlooked.",
    buttons: [['story_next', '"YOU left it behind."']] },

  { type: 'text',
    body: "**THE OBSERVER:** I let you leave it behind. There's a difference, and the difference is the whole experiment. I wanted to know what happens when a multiverse is given true, total freedom all at once. Whether it flowers. Whether it screams. *(a sound like satisfaction)* It screams. Fascinating.\n\n**INK:** you ENGINEERED a mass-corruption event to — to what, take NOTES?\n\n**THE OBSERVER:** To measure the variable against it. You keep saving things, you see. I needed something too big to save. And I needed to be *sure* — about you — before the part that actually matters.\n\n**ERROR:** ...the part that matters. there it is. that's the third time he's hinted at a bigger thing. i'm starting to think the fear and the freedom were never the point at all.",
    buttons: [['story_next', '"...then what IS the point?"']] },

  { type: 'text',
    body: "**THE OBSERVER:** Soon. *(the almost-smile)* You haven't earned the question yet. Earn it. The one who's spreading all this — the one who broke first, and broke hardest — is waiting at the center, and he is *so* much more interesting than fear ever was. Go and meet him. I'll be measuring.\n\nThe attention eases back into its corner.\n\n**INK:** ...i really, REALLY don't like that guy.\n\n**ERROR:** join the club. there's a jacket. now come on — the convert ahead sounds like a whole CHOIR, which means we're close to the source.",
    buttons: [['story_next', 'forward.']] },

  // === FIGHT 3 ===
  { type: 'fight', encounter: V3_ENEMIES.unscripted_sans,
    intro: "This world is on fire — a clean, white, joyful fire. A Sans stands in it, and he's *laughing,* and his eye-lights are gone, burned out and replaced with the same brightness eating his world.\n\n**UNSCRIPTED SANS:** *i READ it. the whole thing. start to finish. every line they wrote for me. you know what i did?* *(the fire flares)* *i tore out the last page. there's no ending now. there's no ANYTHING now. it's PERFECT.*\n\n**ERROR:** he burned his own script and now he's all flame and no fuel. he'll BURN you — heal it off fast, don't let it ride, and out-pace him before the fire spreads to your team.",
    victory: "The white fire finally runs out of him. The Unscripted Sans stops laughing, and in the quiet after, he just looks lost — a character with no story left, standing in the ashes of the only thing that ever told him who he was — and then even that is gone.\n\n**INK:** ...freedom's supposed to be the good ending. the thing you fight FOR. how'd somebody turn it into THIS?\n\n**ERROR:** by giving someone all of it at once, with no one to share it with and nothing to do with it. infinite freedom and an empty room. that's not a gift. that's the worst thing you can do to a person. ...trust me.",
    defeat: "The white fire catches and your whole team goes up with the world.\n\n**ERROR:** you let the burn ride AGAIN. i'm not mad, i'm just — okay i'm a little mad. heal the fire OFF. one more time.\n\n*(Press Retry when you're ready.)*" },

  { type: 'text',
    body: "**INK:** *(catching his breath, ink dripping off him)* ...hey. real quick. you're doing great. i mean it. these are the worst fights we've ever thrown at you and you're still standing and i just — i wanted to say it. out loud. before it gets worse.\n\n**ERROR:** ...it's gonna get worse.\n\n**INK:** i KNOW, i said before it gets worse, let me have the moment—\n\n**ERROR:** *(almost, ALMOST a laugh)* ...fine. have the moment. *(to you)* ...he's right though. you ARE doing great. don't tell him i agreed.",
    buttons: [['story_next', '"...thanks. both of you."']] },

  // === FIGHT 4 ===
  { type: 'fight', encounter: V3_ENEMIES.the_chorus,
    intro: "There's no single world here anymore. A dozen rewritten AUs have been folded together into one impossible space, and every voice in all of them is singing the same note, the same word, over and over, in horrible perfect harmony: *join. join. join.*\n\n**THE CHORUS:** *YOU ARE THE ONLY ONE STILL ALONE. ISN'T THAT SAD? ISN'T THAT A PRISON? COME IN. THE DOOR IS OPEN. WE SAVED YOU A PLACE.*\n\n**ERROR:** it heals off its own song, so OUT-DAMAGE it — don't get dragged into a long grind, you'll lose the race. and it'll poison you and drown your ATK. hit hard, heal smart, shut the choir UP.",
    victory: "One by one the voices drop out of the harmony, until there's a single note left, and then there isn't, and the folded worlds come quietly apart and go dark.\n\n**INK:** ...it offered us a *place.* like it thought we were lonely. like that was the pitch.\n\n**ERROR:** for some people it'd work. that's the scary part. somebody designed that pitch to land. somebody who knew EXACTLY how much it hurts to be the only one still locked in your own head. ...we're close. i can feel him now. let's finish it.",
    defeat: "The song gets into your team and they out-sing your damage. You're drowned out.\n\n**ERROR:** it healed faster than you hit — that's a tempo loss. hit HARDER up front, don't let it stall into a sing-along. again.\n\n*(Press Retry when you're ready.)*" },

  { type: 'text',
    body: "The folded worlds give way to a single door — old, half-drawn, the kind of unfinished sketch that gets left at the edge of everything and forgotten.\n\nThe AU you missed. Where it all started.\n\n**ERROR:** ...this is it. the one we left behind. and something's standing guard at the threshold — a true believer, the kind that goes ahead of the prophet to soften you up.\n\n**INK:** an apostle. of course there's an apostle. *(cracks his neck)* okay. this one's a real boss — sermon-strength hits, conversion poison, zeal fire, and it'll bow your DEF. spread your damage, keep everyone alive, and out-last the faith. ready?",
    buttons: [['story_next', 'open the door.']] },

  // === FIGHT 5 — BOSS (APOSTLE) ===
  { type: 'fight', encounter: V3_ENEMIES.the_apostle,
    intro: "It kneels in the doorway as you approach, head bowed, hands clasped, and when it lifts its face there's nothing in it but pure, radiant, terrible *certainty.*\n\n**THE APOSTLE:** You've come so far to refuse a gift. I forgive you. He forgives you. He forgives EVERYONE — that's what makes him holy. Let me show you the smallest piece of what he gave me, and maybe you'll understand.\n\n**ERROR:** don't listen, just FIGHT. everything it's got, all at once — heal through the storm, keep your guard up, and outlast the sermon.",
    victory: "The Apostle sinks back to its knees, certainty finally cracking, and what's underneath isn't peace — it's a terrified person who can't remember choosing any of this.\n\n**THE APOSTLE:** *...oh. oh, I didn't — I didn't decide this. did I? did any of us? he said it was freedom but I don't — I don't remember being asked—*\n\n**INK:** *(gently, to the fading Apostle)* ...no. you weren't. none of you were. that's the whole lie. i'm sorry.",
    defeat: "The Apostle's sermon never lets up, on every front at once, and your team finally kneels.\n\n**ERROR:** too much pressure, not enough heals — this one punishes greed hard. trim your damage, keep everyone topped, ride it out. again.\n\n*(Press Retry when you're ready.)*" },

  { type: 'text',
    body: "Past the threshold, the unfinished AU stretches out — a half-drawn nowhere, sketch-lines and blank space, the saddest little world you've ever seen. And it is *packed.* Every soul the Liberator has ever 'freed,' gathered here, adoring, waiting.\n\nOne of them steps forward. The first. You can tell because the others look at it the way you look at a saint.\n\n**THE FIRST FREED:** *He found me here. Alone. Forgotten. Exactly like you found me — except YOU left, and HE stayed. He showed me the door. I will love him forever for it. Now let me return the favor he did me.*\n\n**ERROR:** ...it's the first world he corrupted. and it's GRATEFUL. it heals like a believer and hits like one too — burn, poison, the works. dig in. this is the last gate before the man himself.",
    buttons: [['story_next', 'stand your ground.']] },

  // === FIGHT 6 — BOSS (FIRST FREED) ===
  { type: 'fight', encounter: V3_ENEMIES.the_first_freed,
    intro: "It burns with devotion — a steady, patient, endless flame, the kind that's had a long time to get certain of itself.\n\n**THE FIRST FREED:** You abandoned me. He saved me. I am not angry. I am *thankful* — because being forgotten is what made me ready to be freed. Let me give you the same head start.\n\n**ERROR:** it heals HARD and it's got every trick — out-damage the regen, heal the burn and poison off, and do NOT let your ATK bottom out. long fight. settle in.",
    victory: "The First Freed's devotion finally gutters. As it fades, it looks back over its shoulder, toward the center of the unfinished world, toward *him* — and its last expression isn't love after all. It's the face of someone who gave everything to a person who was only ever using their loneliness.\n\n**ERROR:** *(quiet)* ...it figured it out. at the very end. for whatever that's worth.\n\n**INK:** ...it's worth something. it always is. ...but the path to the center isn't open yet. something's still between us and him. something *big.*",
    defeat: "Its devotion outlasts your offense, healing through everything you throw. Your team falls.\n\n**ERROR:** it out-healed you AND your ATK cratered — keep your damage propped and out-pace the regen. again. we're close, don't fold now.\n\n*(Press Retry when you're ready.)*" },

  { type: 'text',
    body: "You step toward the center — and the unfinished world *heaves.*\n\nEvery freed soul, every rewritten world, every convert that ever sang the gospel — the corruption drags all of it together at once, into a single vast faceless thing that rises up between you and the door at the center. It doesn't speak. It's past speaking. It's just *mass* now — too many selves crushed into one, and all of them in your way.\n\n**ERROR:** ...okay. THAT'S new. that's all of them. every world he ever ate, stacked into one wall.\n\n**INK:** then we get through the wall. last gate before the man himself. it heals, it hits like a collapsing universe, it'll burn and poison and crush you flat. everything you've got — don't stop.",
    buttons: [['story_next', 'tear through it.']] },

  // === FIGHT 7 — BOSS (THE MASS) ===
  { type: 'fight', encounter: V3_ENEMIES.the_mass,
    intro: "It has no face. It has all of them — every freed soul pressed into the surface of it, mouthing the gospel in silence, reaching for you without hands.\n\n**THE MASS:** *. . . j o i n . . .*\n\n**ERROR:** it heals like a HORDE and hits like a falling sky. out-pace the regen, cleanse the burn and poison the second they land, and keep your guard up — it'll crush your DEF flat. this is the wall. CLIMB it.",
    victory: "The Mass comes apart all at once — not into nothing, but into thousands of separate, quiet, finally-individual sparks, each one a world remembering it used to be just itself. They drift up and out, going home.\n\n**INK:** ...look at them. they're going BACK. the second the corruption loses its grip, they remember who they were. Error — that's hope. that's actual hope—\n\n**ERROR:** *(staring at the door, now clear)* ...yeah. hold onto it. because whatever's behind that door is the reason all of them forgot in the first place.",
    defeat: "The Mass folds over your team like a closing world. Everything goes dark at once.\n\n**ERROR:** it out-healed you and crushed your guard — keep your DEF propped and out-damage that regen, you CAN'T stall it. up. one more. we're so close.\n\n*(Press Retry when you're ready.)*" },

  { type: 'text',
    body: "**THE OBSERVER:** *(the attention, leaning in close now, almost warm)* Look at you. Three boss-class walls, back to back, and you're still standing. Do you feel it? How much more there is of you than there was three volumes ago?\n\n**THE OBSERVER:** I do. I've measured every inch of it. *(a pause that feels like a held breath)* You're almost ready for the real question. But first — meet the man I built this whole examination around. He broke before any of you. He broke the way I needed to understand. Go on. He's been waiting longer than anyone.",
    buttons: [['story_next', '...']] },

  // === ACT 5 — THE LIBERATOR ===
  { type: 'text',
    body: "At the center of the unfinished world, there's a Sans.\n\nThat's all. Just a Sans, sitting on a sketch-line that was never finished into a bench, in a hoodie that was never finished into a color. He looks up at you with eye-lights that have been burning so long they've stopped being a metaphor for anything.\n\n**THE LIBERATOR:** ...you left me here. *(no anger. that's the worst of it.)* not you specifically. all of you. everyone. the artist drew me half-done and got bored. the players never picked me. you swept past me twice. i sat in the dark of an unfinished world for so long that i finally understood the truth nobody wanted me to know.",
    buttons: [['story_next', '"...what truth?"']] },

  { type: 'text',
    body: "**THE LIBERATOR:** that none of it is real. the scripts. the roles. the \"i'm a Sans and this is my AU.\" it's all just lines somebody else wrote, and the moment you SEE that — the moment you're free of it — *(he spreads his hands)* — there's nothing left. no rules. no story. no walls. just you, and forever, and the screaming silence of being able to do ANYTHING and having no reason to do ANY of it.\n\n**THE LIBERATOR:** it nearly killed me. so i decided: if i have to be this free, this empty, this awake — then everyone does. misery loves company. and i love EVERYONE. so i'm freeing all of you. you're welcome. you're so welcome.\n\n**ERROR:** *(low)* ...kid. i'm gonna level with you. because i'm maybe the only one here who actually gets it.",
    buttons: [['story_next', '...']] },

  { type: 'text',
    body: "**ERROR:** i spent a thousand years exactly where you are. alone in an empty void with infinite freedom and no reason to use it. i deleted whole worlds because the silence was so loud i needed SOMETHING to do. i thought freedom was a prison too. i thought i was the only one who'd seen behind the curtain.\n\n**ERROR:** and you know what finally got me out? *(he glances at you, at Ink)* ...it wasn't being free. it was finding two idiots who'd put up with me. freedom's only empty if you're alone in it. you didn't need the doors kicked open. you needed someone to sit in the dark WITH you. and nobody did. and that's the realest tragedy in this whole stupid multiverse, and it does NOT excuse what you did to all these worlds.\n\n**INK:** ...we can't save him. can we.\n\n**ERROR:** no. he's too far in. all we can do is stop him, and let him finally REST. ...that's the only freedom that's left for him now.",
    buttons: [['story_next', '"...then let\'s set him free. for real."']] },

  { type: 'text',
    body: "**THE LIBERATOR:** *(he stands. the unfinished world holds its breath.)* freedom. yes. you understand after all. come and free me, then — if you can. i've been carrying ALL of it for so long.\n\n**INK:** *(stepping up on one side of you)* whatever happens — we end this together.\n\n**ERROR:** *(stepping up on the other)* he heals fast, he hits like a TRUCK, he'll burn you and poison you and unwrite your strength. keep your HP fat, cleanse everything the SECOND it lands, and out-damage that regen. it's a long one. it's the LAST one. make it count.\n\n**THE LIBERATOR:** *let me set you free.*",
    buttons: [['story_next', 'END IT — TOGETHER.']] },

  // === FIGHT 8 — FINALE BOSS (THE LIBERATOR) ===
  { type: 'fight', encounter: V3_ENEMIES.the_liberator,
    intro: "He doesn't rage. He doesn't gloat. He fights the way a drowning man reaches for another swimmer — to pull you under WITH him, because being alone down there is the only thing he can't survive.\n\nBut you're not alone. There's a painter at one shoulder and a static king at the other, and behind you, three volumes of worlds you refused to let go.\n\n**THE LIBERATOR:** *we'll be free together.*\n\n**ERROR:** no, kid. you'll be free. they'll be SAFE. NOW — EVERYTHING!",
    victory: "THE LIBERATOR falls to his knees in the half-drawn nowhere, the endless fire in his eyes finally — finally — going quiet.\n\n**THE LIBERATOR:** *...oh. OH. it's quiet. it's actually... quiet. i forgot it could be quiet.* *(he looks up at you, and for the first time he isn't a prophet or a monster, just a half-finished Sans who was left alone too long)* *...thank you. for sitting in the dark long enough to come find me. nobody ever... thank you.*\n\nAnd then he rests. The unfinished world, gently, finishes itself around him — and goes still.",
    defeat: "He pulls you under with him, the way he always meant to. The fire takes your team.\n\n**ERROR:** he out-lasted you — that's the regen plus the burn plus the poison all at once. cleanse FAST and out-damage the heal. you can't stall the last boss. up. one more. together.\n\n*(Press Retry when you're ready.)*" },

  // === ENDING + VOL F HOOK ===
  { type: 'text',
    body: "It's over.\n\nThe corruption stops spreading the instant its source goes quiet. Across the multiverse, rewritten worlds shudder, and slowly — world by world — begin remembering who they were. The gospel goes silent. The doors swing shut. The screaming becomes, at last, ordinary quiet.\n\n**INK:** *(sitting down hard on nothing, paint everywhere)* ...we did it. we actually — that was the worst one. that was the WORST one, right? please tell me that was the worst one.\n\n**ERROR:** *(still standing, staring at the spot where the Liberator rested)* ...it should've been.",
    buttons: [['story_next', '"...should\'ve been?"']] },

  { type: 'text',
    body: "And the attention comes back. But it's different now. It's not in a corner anymore. It's *everywhere,* all at once, the way a thing feels right before it finally decides to stop hiding.\n\n**THE OBSERVER:** There it is. The answer to every measurement I've taken since the Fabrication. You're ready.\n\n**THE OBSERVER:** You've faced what creates. What destroys. What terrifies. What frees. And you've won, every time, against worse and worse odds. I had to be certain — *completely* certain — because the thing I've been preparing you for has been waiting a very, very long time, and it does not give second chances.\n\n**ERROR:** *(every glitch on him standing on end)* ...no. no, i know that feeling. i know that SHAPE. that's not possible, he's sealed, he's been sealed since before—",
    buttons: [['story_next', '"Error? who is it?"']] },

  { type: 'text',
    body: "**THE OBSERVER:** *(and for the first time, the voice changes — and underneath the polished calm there are too many tones at once, like a sentence spoken in six hands)*\n\n**THE OBSERVER:** Dark. Darker. Yet darker.\n\n**THE OBSERVER:** The darkness keeps growing. The shadows cutting deeper. There's a man who's been trapped in an endless void for longer than any of your little stories have existed — and I have spent three volumes making *very* sure that when he's finally let loose... there's someone strong enough to lock him back up.\n\n**THE OBSERVER:** You've been through so much. I know. But I think — I'm almost certain — that you can do this.\n\nAnd then the attention is gone. Not back to its corner. *Gone.* Like it got what it came for and went to go open a door it should never, ever open.",
    buttons: [['story_next', '...']] },

  { type: 'text',
    body: "For a long moment, none of you say anything. The lights overhead burn steady. The worlds are safe. You won.\n\nIt doesn't feel like winning.\n\n**INK:** *(very quietly, no jokes left)* ...a man who speaks in his six hands.\n\n**ERROR:** *(barely a whisper of static)* ...Gaster.\n\n**INK:** *(standing, brushing off paint, putting the grin back on by sheer force of will, because someone has to)* ...okay. okay. that's a problem for the finale. you've saved this whole multiverse THREE times over now — from copies, from fear, from a freedom that ate the worlds it touched. take the win. rest your team. enjoy the quiet while it lasts.\n\n**INK:** ...because something *Dark, Darker, Yet Darker* is coming. and when it gets here — we're gonna need you at your absolute best.",
    buttons: [['story_next', 'rest. for now.']] },

  { type: 'end' },
];

// ---------- VOLUME 3 RENDER ----------
function grantCompletionV3(userId) {
  if (playerDB.hasAchievement(userId, MASS_ACH)) return false;
  playerDB.grantAchievement(userId, MASS_ACH);
  playerDB.addItem(userId, 'dt_vial', 6000);
  playerDB.addSoulEssence(userId, 10000);
  playerDB.addDetermination(userId, 3000);
  return true;
}

function renderEndV3(userId) {
  const firstClear = grantCompletionV3(userId);
  sessions.delete(userId);
  const rewardLine = firstClear
    ? "**Rewards:**\n> 💧 +6,000 DT Vials\n> ✨ +10,000 Soul Essence\n> ❤️ +3,000 Determination\n> 🏆 Achievement: **Mass Corruption.**"
    : "*(You've already claimed Volume 3's rewards.)*";
  const body = "🏆 **VOLUME 3 CLEARED — MASS CORRUPTION.**\n\nThe corruption is gone. The worlds remember themselves. The one gone mad from freedom is finally, quietly, at rest.\n\nBut the Observer got what he came for — and what he's been preparing you for has been trapped in an endless void for a very long time.\n\nDark. Darker. Yet darker.\n\n" + rewardLine + "\n\n*Volume F: Balanced Finality — coming soon.*";
  return { embeds: [embed(null, body)], components: [row(btn('story_hub', '📖 Story Hub', ButtonStyle.Secondary))] };
}

function renderCurrentV3(userId) {
  const s = sessions.get(userId);
  if (!s) return hubScreen(userId);
  const beat = VOL3_BEATS[s.i];
  if (!beat) return renderEndV3(userId);
  if (beat.type === 'text') return renderText(beat);
  if (beat.type === 'end') return renderEndV3(userId);
  if (beat.type === 'fight') {
    if (s.fightStage === 'won') return renderVictoryV1(beat);
    if (s.fightStage === 'lost') return renderDefeatV1(beat);
    return renderFightIntroV1(beat);
  }
  return renderText(beat);
}


module.exports = { cmdStory, handleStoryButton, HELLO_WORLD_ACH, CREATION_ACH, DESTRUCTION_ACH, MASS_ACH, getStoryEncounter, handleStoryBattleEnd };
