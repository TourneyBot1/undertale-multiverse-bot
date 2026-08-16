const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const { TOKEN } = require('./config');
const { CHARACTERS, ENEMIES, BOSSES, ITEMS, RECIPES, ADMINS, MOD_ROLE, PVP_GUILD_ID, PVP_GLOBAL, getLevelFromExp, getExpForNextLevel, getAvailableMoveCount, hasPassiveUnlocked, pickRandomEnemy, SHINY_CHANCE, SHINY_BONUS, getTypeEmoji, SHOP_ITEMS, SHOP_DIALOGS, SHOP_REQUIRED_BOSS_CLEARS, ACHIEVEMENTS, GACHA_TABLE, SYNERGIES } = require('./gameData');
const { Battle } = require('./combat');
const playerDB = require('./database');
const embeds = require('./embeds');
const story = require('./story');
const jevil = require('./jevil');

process.on('unhandledRejection', err => console.error('UNHANDLED REJECTION:', err));
process.on('uncaughtException', err => console.error('UNCAUGHT EXCEPTION:', err));

// UPDATE 34: DirectMessages + Partials.Channel are REQUIRED for DM support.
// Without Partials.Channel, discord.js never caches the DM channel, so
// Message#edit() hits a null .channel and throws - battle boards sent to a DM
// would freeze on "Starting ranked battle..." forever.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
});
const activeBattles = new Map();
const pvpChallenges = new Map();
const activePvP = new Map();
// --- Global ranked matchmaking queue (cross-server, auto-start, no consent) ---
const pvpQueue = []; // entries: { userId, username, channelId, message, guildId, enqueuedAt }
const pvpLastOpponent = new Map(); // userId -> last opponent userId (anti-rematch)
// UPDATE 34: how long a player must stay in the queue before Cancel Search works.
const PVP_CANCEL_LOCKOUT_MS = 5000;
const superbossCooldowns = new Map(); // UPDATE 20: in-memory client-side superboss cooldowns (userId -> timestamp)
const lastInteractionTime = new Map(); // anti-macro tracking
const interactionHistory = new Map(); // rhythm tracking
const macroWarnings = new Map(); // warning system
const pendingShinyPurchase = new Map(); // shiny star pending confirmation
const LOG_CHANNEL_ID = '1493160373724119122';

function buildTeamData(team, userId) {
  return team.map(t => {
    const cd = CHARACTERS[t.character_id]; if (!cd) return null;
    const level = getLevelFromExp(t.exp || 0);
    let hp = cd.hp, atk = cd.atk;
    if (cd.scalesWithLevel && level > 1) {
      hp = Math.min(cd.maxHp || 999, cd.hp + (cd.hpPerLevel || 0) * (level - 1));
      atk = Math.min(cd.maxAtk || 999, cd.atk + (cd.atkPerLevel || 0) * (level - 1));
    }
    const data = { ...cd, hp, atk, level, exp: t.exp || 0, dbId: t.character_row_id, shiny: t.shiny };
    // --- ?????? (Jevil): carry the equipped relic into combat (jevils_scythe / jevils_tail) ---
    if (userId) { const raw = playerDB.getCharacterById(t.character_row_id, userId); if (raw && raw.equipped) data.equipped = raw.equipped; }
    // --- UPDATE 32: Season Champion shiny (+6/+6 instead of +2/+2) ---
    if (t.seasonChampion) data.seasonChampion = true;
    else if (userId) { const raw2 = playerDB.getCharacterById(t.character_row_id, userId); if (raw2 && raw2.seasonChampion) data.seasonChampion = true; }
    // --- UPDATE 22: Fallen Priest needs per-boss kill counts for his passive + moves ---
    if (cd.id === 'fallen_priest' && userId) {
      data.bossKills = {};
      for (const bid of ['toriel', 'papyrus', 'undyne', 'mettaton_neo', 'asgore']) {
        data.bossKills[bid] = playerDB.getKillCount(userId, bid);
      }
    }
    return data;
  }).filter(Boolean);
}

async function sendMacroLog(userId, username, reason, warned = false) {
  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (channel) {
      const msg = warned
        ? `⚠️ **Macro Warning** — <@${userId}> (${username})\nReason: **${reason}**\nThis is their first offense — battle continues but they have been warned.`
        : `🚨 **Macro Stopped** — <@${userId}> (${username})\nReason: **${reason}**\nBattle ended. No rewards given.`;
      await channel.send(msg);
    }
  } catch (e) { console.error('Failed to send macro log:', e); }
}

function checkMacro(userId, username) {
  const now = Date.now();
  const last = lastInteractionTime.get(userId) || 0;
  const elapsed = now - last;
  lastInteractionTime.set(userId, now);

  // Physically impossible speed — under 100ms (no human can click this fast repeatedly)
  if (elapsed > 0 && elapsed < 100) {
    const warnings = macroWarnings.get(userId) || 0;
    if (warnings === 0) {
      macroWarnings.set(userId, 1);
      sendMacroLog(userId, username, `Clicked impossibly fast (${elapsed}ms between clicks)`, true);
      return false; // warn but don't stop
    } else {
      macroWarnings.delete(userId);
      sendMacroLog(userId, username, `Clicked impossibly fast again (${elapsed}ms) after prior warning`);
      return true; // stop battle
    }
  }

  // Rhythm check — only flag if EXTREMELY consistent over 8 clicks (variance < 50ms)
  if (!interactionHistory.has(userId)) interactionHistory.set(userId, []);
  const history = interactionHistory.get(userId);
  if (elapsed > 0) history.push(elapsed);
  if (history.length > 10) history.shift();

  if (history.length >= 8) {
    const recent = history.slice(-8);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((sum, t) => sum + Math.abs(t - avg), 0) / recent.length;
    // Only flag if variance is under 50ms AND average interval is under 1200ms
    // This catches bots with near-perfect timing but won't affect fast humans
    if (variance < 50 && avg < 1200) {
      const warnings = macroWarnings.get(userId) || 0;
      if (warnings === 0) {
        macroWarnings.set(userId, 1);
        sendMacroLog(userId, username, `Suspiciously perfect click rhythm (avg ${Math.round(avg)}ms, variance only ${Math.round(variance)}ms over 8 clicks)`, true);
        interactionHistory.set(userId, []); // reset history after warning
        return false; // warn but don't stop
      } else {
        macroWarnings.delete(userId);
        interactionHistory.set(userId, []);
        sendMacroLog(userId, username, `Continued perfect rhythm after warning (avg ${Math.round(avg)}ms, variance ${Math.round(variance)}ms)`);
        return true; // stop battle
      }
    }
  }

  return false;
}


// =====================================================================
// SCAMPTON [[THE GREAT]] — event support
// =====================================================================
const SCAMTON_PIECES = ['chromakey_piece_a', 'chromakey_piece_b', 'chromakey_piece_c'];
const SCAMTON_PRE_DIALOG = [
  '*"...HELLO, HELLO [[LITTLE WORM]]."*\n*"WHAT BRINGS YOU ON SUCH A LATE [[SATURDAY]] NIGHT?"*\n*"DONTCHA GOT [[Skool]] KID!?"*',
  '**-So, what\'s your deal?**\n\n*"...WHAT? YOU WANNA ASK ME WHAT MY [[DEAL]] IS!?!?"*\n*"HAEHAEHAEHAEHAHAHAHAHAHA!!!"*\n*"WHY SHOULD I TELL YOU [[$#%@]] WHAT MY DEAL IS!?!-"*',
  '**-I don\'t mean to cut you off, but I found this...**\n**-It\'s glowing towards this place, and the moment you came, it started vibrating erratically, you related to it by any cha-**\n\n*"HOLY [[GUAC]], ITS THE [[KEY]] TO [[FREEDOM]]!!!"*\n*"KID, HAND IT OVER, AND I\'LL GIVE YOU A [[BIG]], [[BIG]], [[[MASSIVE REWARD]]]!!"*',
  '**-...Hmmm, I don\'t see why not...**\n**-But wait, why are you locked up?**\n\n*"THE OL [[FOOLS OF APRIL]] HATED THE TERM FUN..."*\n\n**-Mkay, I\'ll bust you out I suppose...**\n\n*You used the ChromaKey pieces.*\n*You entered the cell...*',
  '**-...Kinda empty...**\n\n*"[[Good]] [[GREAT]] [[AMAZING!!!]]"*\n*"I COULDN\'T GIVE LESS OF A [[BULLSH-]]"*\n\n**"Can I go home now."**\n**-Now until you tell me my prize.**\n**-These things look hella rare after all... I doubt it would have been easy finding these things on purpose.**',
  '*"...[[Prize]]?"*\n*"YOU, [[SCAMP]], WANT A [[PRIZE]]!?!?"*\n*"WHY THE HELL SHOULD I GIVE IT TO YOU!?!?"*\n*"YOU\'RE A [[CLOWN AROUND TOWN]], WITH AN EVEN BIGGER [[CLOWN HEAD]]!!"*\n\n**-Then I ain\'t moving, nimrod.**',
  '*"YOU WONT MOVE??? SO [[BEE]] IT!!"*\n\n*A railroad, along with a ride, bust you up in the air.*\n*As you fell, you felt your inventory shifting.*\n*You felt your team change.*\n\n**-What the hell!?!?**\n\n*"YOU\'RE IN MY [[HOUSE]] NOW [[BUCKO]], SO IT\'S [[MY ROUXLS]]!!"*\n*"AND NOW, LET THE RIDE BEGIN!!!!!"*',
];
const SCAMTON_POST_DIALOG =
  '*"HAHAHAHAHA! WHAT [[PEAKNESS]]!!"*\n' +
  '*"THAT WAS THE MOST IVE EVER HAD SINCE I WAS [[LOCKED UP LIKE A HAMSTER]]!!!"*\n\n' +
  '**-Great, now can I have my thing?**\n\n' +
  '*"[[FOOL]], IF YOU HADN\'T [[MUSHED]] ME TO THE [[-DERGROUND]], I WOULD BE SO [[WASHED.]]"*\n' +
  '*"[[Fine]] [[FINE]] [[[FINE]]]!!!!"*\n' +
  '*"I\'LL GIVE YOU YOUR [[PRECIUS]] REWARD."*\n' +
  '*"BUT [[MARK MY WORDS WITH YOUR BRIGHTEST MARKER]]!!"*\n' +
  '*"I will return."*';

function scamtonMissingPieces(userId) {
  return SCAMTON_PIECES.filter(p => !playerDB.hasItem(userId, p, 1));
}

// Clears a pending minigame countdown.
function clearMinigameTimer(battle) {
  if (battle && battle._mgTimer) { clearTimeout(battle._mgTimer); battle._mgTimer = null; }
}

// Starts the countdown for whichever minigame is currently armed.
function armMinigameTimer(battle, message, userId) {
  clearMinigameTimer(battle);
  if (!message) return;
  const seconds = battle._neoMinigame ? battle._neoMinigame.timer
    : (battle._pendingCards ? battle._pendingCards.timerSeconds : 0);
  if (!seconds) return;
  battle._mgTimer = setTimeout(async () => {
    try {
      if (activeBattles.get(userId) !== battle) return;
      const logLines = [];
      if (battle._neoMinigame) {
        logLines.push('⏰ **TOO SLOW!**');
        const f = battle.neoFail();
        if (f?.message) logLines.push(f.message);
        if (f?.wiped) {
          activeBattles.delete(userId);
          await message.edit({ content: null, embeds: [embeds.battleLog(logLines.concat(['**You have been defeated by SCAMPTON [[THE GREAT]].**']))], components: [] });
          return;
        }
      } else if (battle._pendingCards) {
        const c = battle.resolveCardsOfFate(null);
        if (c?.message) logLines.push(c.message);
        if (battle.playerTeam.every(f => !f.isAlive)) {
          activeBattles.delete(userId);
          await message.edit({ content: null, embeds: [embeds.battleLog(logLines.concat(['**You have been defeated.**']))], components: [] });
          return;
        }
        if (!battle.activePlayer.isAlive) {
          const nx = battle.playerTeam.findIndex(f => f.isAlive);
          if (nx >= 0) { battle.switchCharacter(nx); logLines.push(`**${battle.activePlayer.name}** steps in!`); }
        }
      } else { return; }
      const st = battle.getBattleState();
      await message.edit({ content: null, embeds: [embeds.battleLog(logLines), embeds.battleState(st)], components: embeds.abilityButtons(st) });
      if (battle._neoMinigame || battle._pendingCards) armMinigameTimer(battle, message, userId);
    } catch (err) { console.error('Scampton minigame timer error:', err); }
  }, seconds * 1000);
}

function grantAchievementIfNew(userId, achievementId) {
  if (playerDB.hasAchievement(userId, achievementId)) return null;
  const ach = ACHIEVEMENTS[achievementId];
  if (!ach) return null;
  playerDB.grantAchievement(userId, achievementId);
  awardChromaKeyCIfEligible(userId);
  return ach;
}

// --- SCAMPTON EVENT: ChromaKey Piece C — granted once at 10+ completed achievements ---
function awardChromaKeyCIfEligible(userId) {
  if (playerDB.hasItem(userId, 'chromakey_piece_c', 1)) return false;
  const achs = playerDB.getAchievements(userId) || {};
  const done = Object.values(achs).filter(Boolean).length;
  if (done < 10) return false;
  playerDB.addItem(userId, 'chromakey_piece_c', 1);
  return true;
}

client.once('ready', () => {
  console.log(`\n💀 Undertale Sans Bot is ONLINE! Logged in as: ${client.user.tag} | Servers: ${client.guilds.cache.size}\n`);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) await handleCommand(interaction);
    else if (interaction.isButton()) await handleButton(interaction);
    else if (interaction.isStringSelectMenu()) await handleSelectMenu(interaction);
    else if (interaction.isAutocomplete()) await handleAutocomplete(interaction);
  } catch (error) {
    console.error('Error:', error);
    try {
      const r = { content: 'Something went wrong!', ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(r).catch(() => {});
      else if (typeof interaction.reply === 'function') await interaction.reply(r).catch(() => {});
    } catch (_) { /* swallow error handler crash */ }
  }
});

// --- UPDATE 24: Welcome message when the bot is added to a new server ---
client.on('guildCreate', async (guild) => {
  try {
    const { ChannelType, PermissionsBitField } = require('discord.js');
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    const canSend = (ch) => ch && ch.permissionsFor(me)?.has(PermissionsBitField.Flags.SendMessages);
    let channel = (guild.systemChannel && canSend(guild.systemChannel)) ? guild.systemChannel : null;
    if (!channel) channel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && canSend(c));
    if (channel) await channel.send({ embeds: [embeds.serverWelcome()] });
  } catch (e) {
    console.error('guildCreate welcome failed:', e?.message || e);
  }
});

// --- UPDATE 18: Server Boost rewards ---
const BOOSTER_ROLE_ID = '1494732351563890850';
const BOOSTER_CHARACTERS = [
  { id: 'dustrust_sans', label: 'Dustrust Sans', emoji: '🌫️' },
  { id: 'c_insanity_weak', label: 'C!Insanity (Weak)', emoji: '🩸' },
  { id: 'weak_avenge_sans', label: 'Weak Avenge Sans', emoji: '🔪' },
];

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    const wasBoosting = !!oldMember.premiumSince;
    const isBoosting = !!newMember.premiumSince;

    // Boost started
    if (!wasBoosting && isBoosting) {
      const buttons = BOOSTER_CHARACTERS.map(c =>
        new ButtonBuilder().setCustomId(`booster_pick_${c.id}`).setLabel(c.label).setEmoji(c.emoji).setStyle(ButtonStyle.Primary)
      );
      const row = new ActionRowBuilder().addComponents(buttons);
      try {
        const dm = await newMember.createDM();
        await dm.send({
          content: `Yoo thank you so much for boosting. Pick any character from the gacha:`,
          components: [row],
        });
      } catch (e) { console.error(`[Booster] Couldn't DM ${newMember.user.tag}:`, e.message); }
    }

    // Boost ended
    if (wasBoosting && !isBoosting) {
      const removed = playerDB.removeBoosterCharacters(newMember.id);
      if (removed.length > 0) {
        try {
          const dm = await newMember.createDM();
          const names = removed.map(id => CHARACTERS[id]?.name || id).join(', ');
          await dm.send({ content: `Your boost ended — your booster reward character(s) have been removed: **${names}**. Thanks for the boost while it lasted!` });
        } catch (e) { console.error(`[Booster] Couldn't DM ${newMember.user.tag} about removal:`, e.message); }
      }
    }
  } catch (e) { console.error('[guildMemberUpdate] error:', e); }
});
// ---------------------------------------

async function handleAutocomplete(interaction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const commandName = interaction.commandName;

  if (commandName === 'redeem') {
    const { CHARACTERS } = require('./gameData');
    const REDEEM_BLOCKED = ['admin_char', 'female_killer_sans', 'fallen_priest', 'mad_mew_mew'];
    const allChars = Object.values(CHARACTERS).filter(c => !REDEEM_BLOCKED.includes(c.id) && !c.isEventChar).map(c => ({ name: c.name, value: c.id }));
    const filtered = allChars.filter(c => c.name.toLowerCase().includes(focused)).slice(0, 25);
    return interaction.respond(filtered);
  }

  if (commandName === 'charinfo' || commandName === 'givecharacter') {
    const { CHARACTERS } = require('./gameData');
    const allChars = Object.values(CHARACTERS).map(c => ({ name: c.name, value: c.id }));
    const filtered = allChars.filter(c => c.name.toLowerCase().includes(focused)).slice(0, 25);
    return interaction.respond(filtered);
  }

  if (commandName === 'use') {
    const allUseOptions = USE_PAGES.flatMap(page => page.items.map(item => ({
      name: item.label,
      value: item.action,
    })));
    const filtered = allUseOptions.filter(o => o.name.toLowerCase().includes(focused)).slice(0, 25);
    return interaction.respond(filtered);
  }

  if (commandName === 'craft') {
    const { RECIPES } = require('./gameData');
    const opts = Object.values(RECIPES).map(r => ({ name: String(r.name).slice(0, 100), value: r.id }));
    const filtered = opts.filter(o => o.name.toLowerCase().includes(focused)).slice(0, 25);
    return interaction.respond(filtered);
  }

  // sell, giveitem, removeitem — item autocomplete
  const { ITEMS } = require('./gameData');
  const allItems = [
    { name: 'Determination (currency)', value: 'determination' },
    { name: 'Soul Essence (currency)', value: 'soul_essence' },
    ...Object.values(ITEMS).map(item => ({ name: item.name, value: item.id }))
  ];
  const filtered = allItems.filter(i => i.name.toLowerCase().includes(focused)).slice(0, 25);
  await interaction.respond(filtered);
}

async function handleCommand(interaction) {
  switch (interaction.commandName) {
    case 'start': return cmdStart(interaction);
    case 'encounter': return cmdEncounter(interaction);
    case 'inventory': return cmdInventory(interaction);
    case 'characters': return cmdCharacters(interaction);
    case 'team': return cmdTeam(interaction);
    case 'setteam': return cmdSetTeam(interaction);
    case 'craftmenu': return cmdCraftMenu(interaction);
    case 'craft': return cmdCraft(interaction);
    case 'fusemenu': return cmdFuseMenu(interaction);
    case 'use': return cmdUse(interaction);
    case 'profile': return cmdProfile(interaction);
    case 'help': return cmdHelp(interaction);
    case 'exile': return cmdExile(interaction);
    case 'fuse': return cmdFuse(interaction);
    case 'givecharacter': return cmdGiveCharacter(interaction);
    case 'giveallchars': return cmdGiveAllChars(interaction);
    case 'removeallchars': return cmdRemoveAllChars(interaction);
    case 'challenge': return cmdChallenge(interaction);
    case 'pvpnotify': return cmdPvpNotify(interaction);
    case 'matchlog': return cmdMatchlog(interaction);
    case 'rank': return cmdRank(interaction);
    case 'endseason': return cmdEndSeason(interaction);
    case 'startseason': return cmdStartSeason(interaction);
    case 'boss': return cmdBoss(interaction);
    case 'superboss': return cmdSuperboss(interaction);
    case 'sacrifice': return cmdSacrifice(interaction);
    case 'saveteam': return cmdSaveTeam(interaction);
    case 'loadteam': return cmdLoadTeam(interaction);
    case 'charinfo': return cmdCharInfo(interaction);
    case 'shop': return cmdShop(interaction);
    case 'convert': return cmdConvert(interaction);
    case 'achievements': return cmdAchievements(interaction);
    case 'endbattle': return cmdEndBattle(interaction);
    case 'lock': return cmdLock(interaction);
    case 'unlock': return cmdUnlock(interaction);
    case 'scavenge': return cmdScavenge(interaction);
    case 'sell': return cmdSell(interaction);
    case 'sellvalues': return cmdSellValues(interaction);
    case 'gacha': return cmdGacha(interaction);
    case 'giveboosterreward': return cmdGiveBoosterReward(interaction);
    case 'giveitem': return cmdGiveItem(interaction);
    case 'removeitem': return cmdRemoveItem(interaction);
    case 'resetdata': return cmdResetData(interaction);
    case 'wipedata': return cmdWipeData(interaction);
    case 'resetrank': return cmdResetRank(interaction);
    case 'leaderboard': return cmdLeaderboard(interaction);
    case 'claim': return cmdClaim(interaction);
    case 'redeem': return cmdRedeem(interaction);
    case 'teamabilities': return cmdTeamAbilities(interaction);
    case 'charsynergies': return cmdCharSynergies(interaction);
    case 'story': return story.cmdStory(interaction);
  }
}

async function cmdStart(interaction) {
  const userId = interaction.user.id;
  if (playerDB.getPlayer(userId)) return interaction.reply({ embeds: [embeds.alreadyStarted()], ephemeral: true });
  playerDB.ensurePlayer(userId);
  // Achievement: Just the Beginning
  const jotb = grantAchievementIfNew(userId, 'just_the_beginning');
  if (jotb) {
    playerDB.addItem(userId, 'dt_vial', jotb.reward.dtVial);
  }
  return interaction.reply({ embeds: [embeds.welcome(interaction.user)] });
}

async function cmdEncounter(interaction) {
  const userId = interaction.user.id;
  playerDB.ensurePlayer(userId);
  if (activeBattles.has(userId)) return interaction.reply({ content: 'You\'re already in a battle!', ephemeral: true });
  const team = playerDB.getTeam(userId);
  if (team.length === 0) return interaction.reply({ content: 'Your team is empty! Use `/setteam` first.', ephemeral: true });

  const teamData = buildTeamData(team, userId);
  if (teamData.length === 0) return interaction.reply({ content: 'Error loading team.', ephemeral: true });

  const difficulty = interaction.options.getString('difficulty') || 'medium';

  // New players only get normal Snowman until they've crafted a Monster Soul
  const inventory = playerDB.getInventory(userId);
  const chars = playerDB.getCharacters(userId);
  const hasOnlySans = chars.every(c => c.character_id === 'sans');
  const hasCraftedMonsterSoul = inventory.some(i => i.item_id === 'monster_soul') || !hasOnlySans;

  let enemyData;
  if (!hasCraftedMonsterSoul && hasOnlySans) {
    enemyData = ENEMIES.snowman;
  } else {
    enemyData = pickRandomEnemy(difficulty);
  }

  const difficultyLabels = { easy: '🟢 Easy (Ruins)', medium: '🔵 Medium (Snowdin)', hard: '🟠 Hard (Hotlands)', veryHard: '🔴 Very Hard (Core)', badTime: '💀 Bad Time (Surface)' };
  const miniBossTag = enemyData.isMiniBoss ? ' ⚠️ **MINI BOSS!**' : '';

  const battle = new Battle(teamData, enemyData, userId);
  battle.enemyId = enemyData.id;
  battle.teamDbIds = teamData.map(t => t.dbId);
  activeBattles.set(userId, battle);

  const state = battle.getBattleState();
  return interaction.reply({ content: `**[${difficultyLabels[difficulty]}]** A wild **${enemyData.name}** appeared!${miniBossTag}`, embeds: [embeds.battleState(state)], components: embeds.abilityButtons(state) });
}

async function cmdInventory(interaction) {
  const userId = interaction.user.id; playerDB.ensurePlayer(userId);
  return interaction.reply({ embeds: [embeds.inventory(playerDB.getPlayer(userId), playerDB.getInventory(userId))] });
}

async function cmdCharacters(interaction) {
  await interaction.deferReply();
  const userId = interaction.user.id; playerDB.ensurePlayer(userId);
  const chars = playerDB.getCharacters(userId);
  if (chars.length === 0) return interaction.editReply({ embeds: [embeds.characterList([])] });

  const FUSABLE = new Set(['ainavol', 'agem', 'waterfall_dust_sans', 'underswap_sans', 'underswap_papyrus', 'c_insanity_weak', 'c_insanity', 'weak_avenge_sans', 'underfell_sans', 'ainavolagem', 'asgore', 'last_breath_sans', 'storyshift_chara', 'ts_sans', 'call_of_the_void_sans', 'sans', 'geno_sans', 'judgement_hall_dust_sans', 'killer_sans', 'no_more_deals_chara', 'wd_gaster']);
  const lines = chars.map(c => {
    const d = CHARACTERS[c.character_id]; if (!d) return null;
    const lv = getLevelFromExp(c.exp || 0), ne = getExpForNextLevel(lv);
    const es = ne ? `${c.exp || 0}/${ne}` : `${c.exp || 0} (MAX)`;
    const sh = c.shiny ? ' **✦**' : '';
    const lock = c.locked ? ' 🔒' : '';
    const fuse = FUSABLE.has(c.character_id) ? ' ⚡' : '';
    return `**[${c.id}]** **${d.name}** Lv.${lv}${sh}${lock}${fuse} | EXP: ${es}`;
  }).filter(Boolean);

  if (lines.length === 0) return interaction.editReply({ content: 'No valid characters found.' });

  // Split into pages of max 3800 chars each (one embed per page, sent as separate messages)
  const pages = [];
  let current = '';
  for (const line of lines) {
    const next = current ? current + '\n' + line : line;
    if (next.length > 3800) { pages.push(current); current = line; }
    else { current = next; }
  }
  if (current) pages.push(current);

  const { EmbedBuilder } = require('discord.js');
  const footer = `Use /setteam <slot> <id> | /exile <id> to remove | /lock <id> to lock | ⚡ = fusable (/fusemenu)`;

  // Send first page as editReply, remaining as followUp (each a separate message)
  for (let i = 0; i < pages.length; i++) {
    const embed = new EmbedBuilder()
      .setColor(0x7C4DFF)
      .setTitle(i === 0 ? `Your Characters (${chars.length} total)` : `Your Characters (continued)`)
      .setDescription(pages[i])
      .setFooter({ text: `${footer}${pages.length > 1 ? ` | Page ${i+1}/${pages.length}` : ''}` });
    if (i === 0) await interaction.editReply({ embeds: [embed] });
    else await interaction.followUp({ embeds: [embed] });
  }
}

async function cmdTeam(interaction) {
  const userId = interaction.user.id; playerDB.ensurePlayer(userId);
  const savedTeams = playerDB.getSavedTeams(userId);
  const savedTeamNames = Object.keys(savedTeams);
  let savedTeamMsg = '';
  if (savedTeamNames.length > 0) {
    savedTeamMsg = `\n\n💾 **Saved Teams:** ${savedTeamNames.map(n => `\`${n}\``).join(', ')}\nUse \`/loadteam [name]\` to load one.`;
  } else {
    savedTeamMsg = `\n\n💾 *No saved teams yet. Use \`/saveteam [name]\` to save your current team.*`;
  }
  const embed = embeds.teamDisplay(playerDB.getTeam(userId));
  embed.description = (embed.description || '') + savedTeamMsg;
  return interaction.reply({ embeds: [embed] });
}

async function cmdSetTeam(interaction) {
  const userId = interaction.user.id; playerDB.ensurePlayer(userId);
  const slot = interaction.options.getInteger('slot');
  if (slot > 6) return interaction.reply({ content: 'Max team size is 6!', ephemeral: true });
  const charRowId = interaction.options.getInteger('character_id');

  // If no character_id provided, show character list
  if (!charRowId) {
    const chars = playerDB.getCharacters(userId);
    if (chars.length === 0) return interaction.reply({ content: 'You have no characters!', ephemeral: true });
    const list = chars.map(c => {
      const cd = CHARACTERS[c.character_id]; if (!cd) return null;
      const lv = getLevelFromExp(c.exp || 0);
      const lock = c.locked ? ' 🔒' : '';
      return `**[${c.id}]** ${cd.name} Lv.${lv}${c.shiny ? ' ✦' : ''}${lock}`;
    }).filter(Boolean).join('\n');
    return interaction.reply({ content: `Your characters (use ID with /setteam):\n${list}`, ephemeral: true });
  }

  const char = playerDB.getCharacterById(charRowId, userId);
  if (!char) return interaction.reply({ content: 'You don\'t own that character! Check `/characters`.', ephemeral: true });
  // --- UPDATE 22: Event characters — max 1 of the same event character per team ---
  const cdCheck = CHARACTERS[char.character_id];
  if (cdCheck?.isEventChar) {
    const team = playerDB.getTeam(userId);
    const dupe = team.find(t => t.character_id === char.character_id && t.character_row_id !== charRowId && t.slot !== slot);
    if (dupe) return interaction.reply({ content: `❌ **${cdCheck.name}** is an **event character** — you can only have **1** of the same event character on your team!`, ephemeral: true });
    // --- UPDATE 30: max 3 event characters per team ---
    const eventCount = team.filter(t => { const tc = CHARACTERS[t.character_id]; return tc?.isEventChar && t.slot !== slot; }).length;
    if (eventCount >= 3) return interaction.reply({ content: `❌ Teams are limited to **3 event characters** — you already have 3 equipped!`, ephemeral: true });
  }
  playerDB.setTeamSlot(userId, slot, charRowId);
  const cd = CHARACTERS[char.character_id];
  return interaction.reply({ content: `Set **${cd?.name || char.character_id}** to team slot **${slot}**!` });
}

async function cmdCraftMenu(interaction) { return interaction.reply({ embeds: [embeds.craftMenu()] }); }
async function cmdFuseMenu(interaction) { return interaction.reply({ embeds: [embeds.fuseMenu()] }); }

async function cmdCraft(interaction) {
  const userId = interaction.user.id; playerDB.ensurePlayer(userId);
  const recipeId = interaction.options.getString('recipe');
  const recipe = RECIPES[recipeId];
  if (!recipe) return interaction.reply({ content: 'Unknown recipe!', ephemeral: true });
  for (const [itemId, amount] of Object.entries(recipe.ingredients)) {
    if (itemId === 'soul_essence') {
      if (playerDB.getPlayer(userId).soul_essence < amount) return interaction.reply({ content: `Not enough **Soul Essence**! Need ${amount}, have ${playerDB.getPlayer(userId).soul_essence}.`, ephemeral: true });
      continue;
    }
    // --- UPDATE 22 BUG FIX: Determination is a currency, not an inventory item (Void Tablet / Positive Apple / TRUE Negative Essence / Dark Cross recipes) ---
    if (itemId === 'determination') {
      if ((playerDB.getPlayer(userId).determination || 0) < amount) return interaction.reply({ content: `Not enough **Determination**! Need ${amount.toLocaleString()}, have ${(playerDB.getPlayer(userId).determination || 0).toLocaleString()}.`, ephemeral: true });
      continue;
    }
    if (!playerDB.hasItem(userId, itemId, amount)) {
      const cur = playerDB.getItem(userId, itemId);
      return interaction.reply({ content: `Not enough **${ITEMS[itemId]?.name || itemId}**! Need ${amount}, have ${cur?.amount || 0}.`, ephemeral: true });
    }
  }
  for (const [itemId, amount] of Object.entries(recipe.ingredients)) {
    if (itemId === 'soul_essence') playerDB.addSoulEssence(userId, -amount);
    else if (itemId === 'determination') playerDB.addDetermination(userId, -amount);
    else playerDB.removeItem(userId, itemId, amount);
  }
  if (recipe.result.type === 'item') {
    playerDB.addItem(userId, recipe.result.itemId, 1);
    return interaction.reply({ content: `Crafted **${recipe.name}**! It's in your inventory. Use \`/use\` to use it.` });
  }
  // --- UPDATE 24: probabilistic character craft (e.g. Psychopathtale Sans / Neon Sword) ---
  if (recipe.result.type === 'character') {
    const chance = recipe.successChance ?? 1;
    if (Math.random() >= chance) {
      let refundMsg = '';
      if (recipe.refundOnFail) {
        for (const [it, amt] of Object.entries(recipe.refundOnFail)) playerDB.addItem(userId, it, amt);
        refundMsg = ` Your **${Object.entries(recipe.refundOnFail).map(([it, amt]) => `${amt}x ${ITEMS[it]?.name || it}`).join(', ')}** were returned.`;
      }
      return interaction.reply({ content: `💥 The forging of **${recipe.name}** **failed**! *(${Math.round(chance * 100)}% success chance)*${refundMsg} The rest was consumed — you'll need to grind again.` });
    }
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, recipe.result.charId, 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `⚡ **Success!** The Neon Sword is forged and you obtain ${shiny ? '**✦ SHINY ✦** ' : ''}**${CHARACTERS[recipe.result.charId]?.name || recipe.result.charId}**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }
  return interaction.reply({ content: 'Crafted!' });
}

function buildShinyStarPage(nonShiny, page) {
  const { StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
  const pageSize = 25;
  const totalPages = Math.ceil(nonShiny.length / pageSize);
  const slice = nonShiny.slice(page * pageSize, (page + 1) * pageSize);
  const options = slice.map(c => {
    const cd = CHARACTERS[c.character_id];
    const lv = getLevelFromExp(c.exp || 0);
    return { label: `[ID: ${c.id}] ${cd?.name || c.character_id} Lv.${lv}`, description: `HP: ${cd?.hp} | ATK: ${cd?.atk} | DEF: ${cd?.def}`, value: `shinystar_${c.id}` };
  });
  const rows = [];
  rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('shinystar_select').setPlaceholder(`Choose a character... (Page ${page + 1}/${totalPages})`).addOptions(options)
  ));
  const navButtons = [];
  if (page > 0) navButtons.push(new ButtonBuilder().setCustomId(`shinystar_prev_${page}`).setLabel('◀ Previous').setStyle(ButtonStyle.Secondary));
  if (page < totalPages - 1) navButtons.push(new ButtonBuilder().setCustomId(`shinystar_next_${page}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary));
  if (navButtons.length > 0) rows.push(new ActionRowBuilder().addComponents(...navButtons));
  return { content: `✨ **Shiny Star** — Choose a character to make shiny! (Page ${page + 1}/${totalPages}, ${nonShiny.length} eligible)`, components: rows };
}

function rollShiny() { return Math.random() < SHINY_CHANCE; }

// --- /use PAGINATED SYSTEM ---
const USE_PAGES = [
  {
    title: '📦 Basic Souls',
    items: [
      { action: 'monster_soul', label: 'Monster Soul → Sans', emoji: '💀' },
      { action: 'tier1_on_nothing', label: 'T1 Soul (alone) → Underswap Sans', emoji: '🔥' },
      { action: 'tier1_on_sans', label: 'T1 Soul on Sans → Fell/Outer (50/50)', emoji: '🔥' },
      { action: 'tier2_on_sans', label: 'T2 Soul on Sans → Ocean/Fresh/Hard (1/3)', emoji: '💎' },
      { action: 'tier2_on_swap', label: 'T2 Soul on Underswap Sans → Swapswap (+120 SE)', emoji: '💎' },
    ],
  },
  {
    title: '🌌 Galactic Event',
    items: [
      { action: 'galactic_blackhole_use', label: 'Blackhole on Lv5 Outertale Sans → M87', emoji: '🕳️' },
      { action: 'galactic_star_shard_use', label: 'Star Shard on Lv5 Outertale Sans → Fallen Stars', emoji: '🌟' },
      { action: 'galactic_sirius_use', label: 'Sirius on Lv5 Outertale Sans → Galaxy Sans', emoji: '⭐' },
      { action: 'galactic_phoenix_a_use', label: 'Phoenix A on Lv5 Outertale Sans → The Outering One', emoji: '🔥' },
    ],
  },
  {
    title: '🔥 Boss Drop Items',
    items: [
      { action: 'stolen_flames', label: 'Stolen Flames on Sans → Ruins Dust Sans', emoji: '🔥' },
      { action: 'papyrus_scarf', label: "Papyrus' Scarf on Ruins Dust → Snowdin Dust", emoji: '🧣' },
      { action: 'spear_use', label: 'Spear on Snowdin Dust → Waterfall Dust', emoji: '🔱' },
      { action: 'head_dog_use', label: 'Head Dog on Lv5 Sans → Horror Sans (+150 SE)', emoji: '🐶' },
      { action: 'reaper_chara_use', label: 'Hate Scythe on Chara (Reaper Sans on team) → Reaper Chara', emoji: '🌑' },
    ],
  },
  {
    title: '✨ Advanced Obtainments',
    items: [
      { action: 'save_star', label: 'Save Star on Lv3+ Sans → Killer Sans', emoji: '💫' },
      { action: 'his_guidance', label: 'His Guidance on Lv5 Sans → Last Breath Sans', emoji: '👁️' },
      { action: 'gasters_hands', label: "Gaster's Hands → W.D. Gaster", emoji: '🖐️' },
      { action: 'echo_flowers', label: 'Echo Flowers (with Sans on team) → Star Sans', emoji: '🌸' },
      { action: 'dt_injector_skull', label: 'DT Injector + Skull on Sans → Insanity Sans', emoji: '💉' },
    ],
  },
  {
    title: '🎨 Rare & Scavenge Items',
    items: [
      { action: 'papyrus_skull_use', label: "Papyrus' Skull (alone) → Papyrus", emoji: '💀' },
      { action: 'save_star_menu', label: 'Save Star Menu on Lv5 Sans → Geno Sans (+400 SE)', emoji: '💾' },
      { action: 'orange_jacket', label: 'Orange Jacket on Underswap Sans → US Papyrus (+500 SE)', emoji: '🧡' },
      { action: 'ink_brush', label: 'Ink Brush + 6 T3 Souls on Lv5 Sans → Ink Sans', emoji: '🖌️' },
      { action: 'error_sans_use', label: '2 Glitched Strings + Geno Sans → Error Sans (+6666 SE)', emoji: '🧵' },
    ],
  },
  {
    title: '⚡ Tier 3 & Special',
    items: [
      { action: 'tier3_on_sans', label: 'T3 Soul on Sans → Ainavol/Agem (+500 DT +1000 SE)', emoji: '💎' },
      { action: 'murder_sans_use', label: 'T3 Soul (murder path) → Murder!Sans', emoji: '🔪' },
      { action: 'shiny_star', label: 'Shiny Star → Make a character shiny', emoji: '🌠' },
    ],
  },
  {
    title: '🆕 Update 11 Items',
    items: [
      { action: 'time_orb_use', label: 'Time Orb on Sans → FT!Sans (+10k SE +2.5k DT)', emoji: '🔵' },
      { action: 'parasite_use', label: 'Parasite on Fresh Sans → True Fresh!Sans', emoji: '🦠' },
      { action: 'crown_use', label: 'Crown of the King on Sans → StoryShift! Sans', emoji: '👑' },
      { action: 'cat_food_use', label: 'Cat Food → Sansfield', emoji: '🐱' },
      { action: 'shanghaivania_use', label: 'Paint Vials x7 + Ink Brush x2 on Ink Sans → Shanghaivania Ink Sans (+20k SE +3 T3 Souls)', emoji: '🎨' },
    ],
  },
  {
    title: '🎩 Update 13 — Mafiatale & Outerdust',
    items: [
      { action: 'mafiatale_use', label: 'Tommy Gun + Mafia Hat + Cigarette Pack on Lv5 Sans → Mafiatale Sans', emoji: '🎩' },
      { action: 'outerdust_use', label: 'Cosmic Dust + Stolen Monster Magic → Outerdust Sans (3 Lv5 Outers + Lv5 JHall Dust)', emoji: '🌌' },
    ],
  },
  {
    title: '💀 Update 13 — Dust Evolutions',
    items: [
      { action: 'jhall_dust_use', label: 'Use Stolen Monster Magic on Core Dust → Judgement Hall Dust Sans (Lv5 + 1k SE)', emoji: '⚔️' },
      { action: 'hotlands_dust_use', label: 'Neo Cannon on Waterfall Dust → Hotlands Dust Sans', emoji: '💥' },
      { action: 'core_dust_use', label: 'Empty Gun on Hotlands Dust → Core Dust Sans', emoji: '🔫' },
    ],
  },
  {
    title: '🧥 Update 13 — Charas & Coats',
    items: [
      { action: 'storyshift_chara_use', label: 'Green Coat → Storyshift Chara (+2.5k SE + Real Knife)', emoji: '🧥' },
      { action: 'storyfell_chara_use', label: 'Crimson Coat → Storyfell Chara (3 Lv5 Underfell Sans on team)', emoji: '🩸' },
    ],
  },
  {
    title: '🌌 Update 13 — Void & Hardmode',
    items: [
      { action: 'cotv_fuse_use', label: 'Void Tablet → Call of the Void Sans (use /fuse)', emoji: '📜' },
      { action: 'swapfell_papyrus_use', label: 'Purple Jacket → Swapfell Papyrus (+US Sans + US Pap on team + 2.5k SE)', emoji: '💜' },
      { action: 'hardmode_sans_use', label: 'Hardmode Essence on Lv5 Sans → Hardmode Sans (+10k SE)', emoji: '🩵' },
      { action: 'dustfell_sans_use', label: 'Dusty Fur Hood + Chains on Lv5 JHall Dust → Dustfell Sans (Lv5 Underfell on team + 25 kills each)', emoji: '⛓️' },
    ],
  },
  {
    title: '🆕 Update 14/15 — New Obtainments',
    items: [
      { action: 'inevitability_use', label: 'Inevitability on Lv5 Sans → Tears in the Rain Sans (+8750 DT +11890 SE)', emoji: '❗' },
      { action: 'dustswap_papyrus_use', label: 'Cigarette Pack + Stolen Monster Magic (need Lv5 JHall Dust on team) → Dustswap Papyrus', emoji: '🚬' },
      { action: 'dustshift_use', label: '10 Real Knife + 20 Vines (need Lv5 Dustswap Papyrus + Lv5 JHall Dust on team) → Dustshift', emoji: '🔪' },
      { action: 'flame_eye_use', label: 'Flame Eye + 3 Lv5 JHall Dust → Flame Eye character (-20k DT -10k SE)', emoji: '👁️‍🗨️' },
    ],
  },
  {
    title: '✨ Update 15 — Humans & Deltarune',
    items: [
      { action: 'determination_soul_use', label: 'Determination Soul → Frisk', emoji: '❤️' },
      { action: 'real_knife_use_15', label: 'Real Knife on Frisk → Chara', emoji: '🔪' },
      { action: 'lethal_deal_use_15', label: 'Lethal Deal on Chara → No More Deals Chara (16.66%)', emoji: '🃏' },
      { action: 'portable_core_use', label: 'Portable CORE on Frisk → Core Frisk', emoji: '🔷' },
      { action: 'kris_sword_use', label: 'Kris\' Sword → Kris', emoji: '⚔️' },
      { action: 'susies_axe_use', label: 'Susie\'s Axe → Susie', emoji: '🪓' },
      { action: 'comically_long_blunt_use', label: 'Comically Long Blunt → Ralsei', emoji: '🚬' },
      { action: 'empowered_kindness_use', label: 'Empowered Kindness Soul → Rose', emoji: '💚' },
      { action: 'clover_use', label: 'Empty Gun + Cowboy Hat → Clover', emoji: '🤠' },
      { action: 'frosty_antlers_use', label: 'Frosty Antlers → Noelle', emoji: '🦌' },
      { action: 'thorn_ring_use', label: 'Thorn Ring on Lv2 Noelle (+Lv2 Kris in party) → Snowgrave Noelle', emoji: '💍' },
      { action: 'eye_item_use', label: '👀 → Torgore Dreemurr', emoji: '👀' },
      { action: 'vhs_tape_use', label: 'VHS Tape on Sans → Sans?', emoji: '📼' },
      { action: 'stolen_slash_use', label: 'Stolen Slash on Sans? → YOUR FAULT (25%)', emoji: '🗡️' },
      { action: 'admin_perms_use', label: 'Administrator Permissions on YOUR FAULT → YOUR INNER TORMENT (66.66%)', emoji: '🔑' },
    ],
  },
  {
    title: '🆕 Update 17 — Dream/Nightmare & Fatal',
    items: [
      { action: 'positive_apple_use', label: 'Positive Apple + Positive Staff on Lv5 Sans → Dream Sans (+25k SE)', emoji: '🍏' },
      { action: 'true_negative_essence_use', label: 'TRUE Negative Essence on Sans → Nightmare Sans (+Killer/Horror/JHall Dust on team)', emoji: '🟪' },
      { action: 'afterdust_use', label: 'Glitched Star → AfterDust!Sans (use /fuse: 2 Lv5 Geno + Lv5 JHall Dust + Lv5 Sans)', emoji: '💀' },
      { action: 'influenced_killer_use', label: '2 Killer\'s Soul → Influenced Killer Sans (use /fuse: Killer Sans + No More Deals Chara)', emoji: '🔪' },
    ],
  },
  {
    title: '✨ Update 18 — New Characters',
    items: [
      { action: 'strange_flower_use', label: 'Strange Flower (crafted) on Lv5 Sans → Possession Sans', emoji: '🌸' },
      { action: 'sudden_changes_use', label: '15 A Gun + 10 Coffee Mug + 10000 DT on Mafiatale Sans → Sudden Changes', emoji: '☕' },
      { action: 'lethal_deal_use', label: '5 Lethal Deal + 2 T3 Soul + 1800 SE + 30 DT Vials on Killer Sans → Lethal Deal', emoji: '🃏' },
    ],
  },
  {
    title: '⚔️ Update 19 — New Characters',
    items: [
      { action: 'reapers_scythe_use', label: "Reaper's Scythe on Sans (Avenge Sans in party + 50 BT Sans kills) → Reaper Sans", emoji: '💀' },
      { action: 'green_sans_use', label: 'Lightsaber + Happy Meal + Whatsapp Logo on Sans → Green Sans', emoji: '📱' },
      { action: 'seraphim_use', label: 'Seraphim Soul (crafted) on yourself → Seraphim', emoji: '✨' },
      { action: 'black_knife_use', label: 'Black Knife (crafted) on Nothing + 6500 DT + 12500 SE → The Roaring Knight', emoji: '🗡️' },
    ],
  },
  {
    title: '🌠 Update 20 — Rust, Pasta & False Saviors',
    items: [
      { action: 'pesti_sans_use', label: 'Rusted Metal Pipe on Sans → Pesti Sans', emoji: '🪈' },
      { action: 'pesto_sans_use', label: 'Pesto Sauce on Pesti Sans → Pesto Sans', emoji: '🌿' },
      { action: 'negatale_sans_use', label: 'Tier 3 Monster Soul on Sans → Negatale Sans', emoji: '🦴' },
      { action: 'evans_dust_use', label: 'my memories!! on Lv5 JHall Dust → Dust!Tale: [Evan\'s] (Event)', emoji: '💭' },
      { action: 'fake_hyperdust_use', label: 'Hyper\'s Soul on Lv5 Evan\'s Dust → Fake!HyperDust (Event)', emoji: '👻' },
      { action: 'fake_dustdust_use', label: 'Hatred. on Fake!HyperDust → Fake!DustDust (Event)', emoji: '💢' },
      { action: 'finale_fuse_info', label: 'Finale For The Bonely One → use /fuse (Lv5 Sans + Ainavol + agem + 2x Lv3 Ainavolagem + 10 Juice)', emoji: '💀' },
    ],
  },
  {
    title: '🕯️ The Enlightened Questline (My Memories)',
    items: [
      { action: 'enlightened_ruins_use', label: 'Stolen Flames on Enlightened Sans → Enlightened Ruins Dust (kill Toriel w/ Enlightened Sans)', emoji: '🔥' },
      { action: 'enlightened_snowdin_use', label: "Papyrus' Scarf on Enl. Ruins Dust → Enl. Snowdin Dust (kill Papyrus w/ Enl. Ruins)", emoji: '🧣' },
      { action: 'enlightened_waterfall_use', label: 'Spear on Enl. Snowdin Dust → Enl. Waterfall Dust (kill Undyne w/ Enl. Snowdin)', emoji: '🔱' },
      { action: 'enlightened_hotlands_use', label: 'Neo Cannon on Enl. Waterfall Dust → Enl. Hotlands Dust (kill Mettaton NEO w/ Enl. Waterfall)', emoji: '💥' },
      { action: 'enlightened_core_use', label: 'Empty Gun on Enl. Hotlands Dust → Enl. Core Dust (kill Mettaton NEO w/ Enl. Hotlands)', emoji: '🔫' },
      { action: 'enlightened_jhall_use', label: 'Stolen Monster Magic + 1k SE on Lv5 Enl. Core Dust → Enl. JHall Dust (kill Asgore w/ Enl. Core)', emoji: '⚖️' },
    ],
  },
  {
    title: '✝️ Update 22 — The Fallen Priest',
    items: [
      { action: 'dark_cross_use', label: 'The Dark Cross on Sans → Fallen Priest', emoji: '🖤' },
    ],
  },
  {
    title: '🔩 Update 31 — Karma, Rebar & the Melting',
    items: [
      { action: 'karma_sans_use', label: '5 Karma Vials on a Lv5 Last Breath Sans → Karma!Sans', emoji: '☯️' },
      { action: 'rebar_insanity_use', label: '5 Rebars on a C!Insanity → REBAR!Insanity', emoji: '🔩' },
      { action: 'unnamed_kindness_use', label: 'Rebar + 2 Empowered Kindness Souls on Rose → Unnamed Kindness', emoji: '✨' },
      { action: 'papyrus_q_use', label: 'DT Injector on Papyrus → Papyrus/? (10%, needs 66,666 DT + 66,666 SE + Amalgamate Essence)', emoji: '🫠' },
      { action: 'hardmode_insanity_use', label: 'Hardmode Essence + 10 DT Injectors on Sans (JHall Dust on team) → Hardmode Insanity (+15k SE)', emoji: '🩸' },
    ],
  },
  {
    title: '🌀 ?????? — Jevil Relics',
    items: [
      { action: 'use_rewritten_ticket', label: 'Rewritten Ticket — claim a character', emoji: '🎫' },
      { action: 'equip_big_shot_bow_tie', label: 'Equip Big Shot Bow Tie to a character', emoji: '🎀' },
      { action: 'equip_jevils_scythe', label: "Equip Jevil's Scythe to a character", emoji: '🪓' },
      { action: 'equip_jevils_tail', label: "Equip Jevil's Tail to a character", emoji: '🌀' },
      { action: 'unequip_relic', label: 'Unequip a relic from a character', emoji: '🧷' },
    ],
  },
];

function buildUsePage(page) {
  const p = USE_PAGES[page];
  const options = p.items.map(item => ({
    label: item.label.slice(0, 100),
    value: item.action,
    emoji: item.emoji,
  }));
  const select = new StringSelectMenuBuilder()
    .setCustomId(`use_select_${page}`)
    .setPlaceholder('Choose what to use...')
    .addOptions(options);
  const row = new ActionRowBuilder().addComponents(select);
  const navBtns = [
    new ButtonBuilder().setCustomId(`use_prev_${page}`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`use_next_${page}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page === USE_PAGES.length - 1),
  ];
  const navRow = new ActionRowBuilder().addComponents(navBtns);
  const embed = {
    color: 0x2b2d31,
    title: `📖 /use — ${p.title}`,
    description: p.items.map(i => `${i.emoji} **${i.label}**`).join('\n'),
    footer: { text: `Page ${page + 1}/${USE_PAGES.length} — Select an item from the dropdown to use it.` },
  };
  return { embeds: [embed], components: [row, navRow] };
}

async function cmdUse(interaction) {
  const userId = interaction.user.id; playerDB.ensurePlayer(userId);
  const action = interaction.options.getString('item');
  if (!action) return interaction.reply({ content: 'Please search for an item to use!', ephemeral: true });

  // --- UPDATE 34 GALACTIC EVENT: convert a Lv5 Outertale Sans into a galactic character ---
  // Blackhole -> M87 | Star Shard -> Fallen Stars | Sirius -> Galaxy Sans | Phoenix A -> The Outering One
  {
    const GALACTIC_CONVERSIONS = {
      galactic_blackhole_use: { item: 'blackhole', itemName: 'Blackhole', emoji: '\u{1F573}\uFE0F', result: 'm87', resultName: 'M87', flavor: 'The void opens, and something steps out...' },
      galactic_star_shard_use: { item: 'star_shard', itemName: 'Star Shard', emoji: '\u{1F31F}', result: 'fallen_stars_char', resultName: 'Fallen Stars', flavor: 'The star shard splits, and the cosmic dust answers...' },
      galactic_sirius_use: { item: 'sirius', itemName: 'Sirius', emoji: '\u2B50', result: 'galaxy_sans', resultName: 'Galaxy Sans', flavor: 'A star field wraps itself around him...' },
      galactic_phoenix_a_use: { item: 'phoenix_a', itemName: 'Phoenix A', emoji: '\u{1F525}', result: 'the_outering_one', resultName: 'The Outering One', flavor: '"i alone...am the outering one."' },
    };
    const conv = GALACTIC_CONVERSIONS[action];
    if (conv) {
      if (!playerDB.hasItem(userId, conv.item, 1)) return interaction.reply({ content: `You don't have a **${conv.emoji} ${conv.itemName}**! It drops from the Galactic Event bosses.`, ephemeral: true });
      const team = playerDB.getTeam(userId);
      // getTeam() does not carry the `locked` flag, so read the raw row for it -
      // otherwise a locked character could be silently consumed.
      const outers = team.map(t => ({ ...t, lv: getLevelFromExp(t.exp || 0) }))
        .filter(t => t.character_id === 'outertale_sans' && t.lv >= 5)
        .filter(t => !(playerDB.getCharacterById(t.character_row_id, userId) || {}).locked);
      if (outers.length < 1) return interaction.reply({ content: 'You need an unlocked **Lv5 Outertale Sans** on your team! *(Use `/unlock` first if yours is locked.)*', ephemeral: true });
      playerDB.removeItem(userId, conv.item, 1);
      playerDB.removeCharacter(userId, outers[0].character_row_id);
      const shiny = rollShiny();
      const nc = playerDB.addCharacter(userId, conv.result, 0, shiny);
      const ts = playerDB.getTeamSize(userId);
      if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
      return interaction.reply({ content: `${conv.flavor}\n\nYour Outertale Sans becomes ${shiny ? '**\u2726 SHINY \u2726** ' : ''}**${conv.resultName}**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
    }
  }

  // --- ?????? (Jevil): equip / unequip relics ---
  // --- SCAMPTON EVENT: Rewritten Ticket ---
  if (action === 'use_rewritten_ticket') {
    if (!playerDB.hasItem(userId, 'rewritten_ticket', 1)) return interaction.reply({ content: "You don't have a **🎫 Rewritten Ticket**!", ephemeral: true });
    return interaction.reply({
      content: '🎫 **Select your character.**',
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('rwt_asriel_rewritten').setLabel('Asriel (Rewritten)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('rwt_noelle_rewritten').setLabel('Noelle (Rewritten)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('rwt_charkis').setLabel('Charkis').setStyle(ButtonStyle.Primary),
      )],
      ephemeral: true,
    });
  }
  // --- SCAMPTON EVENT: Big Shot Bow Tie relic ---
  if (action === 'equip_big_shot_bow_tie') {
    if (!playerDB.hasItem(userId, 'big_shot_bow_tie', 1)) return interaction.reply({ content: "You don't have the **🎀 Big Shot Bow Tie**!", ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    if (chars.length === 0) return interaction.reply({ content: 'You have no characters to equip it to.', ephemeral: true });
    const opts = chars.slice(0, 25).map(c => {
      const d = CHARACTERS[c.character_id];
      return { label: `[${c.id}] ${d?.name || c.character_id}${c.equipped ? ' [holding a relic]' : ''}`.slice(0, 100), value: String(c.id) };
    });
    return interaction.reply({
      content: '🎀 Equip the **Big Shot Bow Tie** to which character? *(A character can only hold one relic — equipping swaps out any current one.)*',
      components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('bowtie_equip').setPlaceholder('Choose a character...').addOptions(opts))],
      ephemeral: true,
    });
  }
  if (action === 'equip_jevils_scythe' || action === 'equip_jevils_tail') {
    const itemId = action.replace('equip_', '');
    if (!playerDB.hasItem(userId, itemId, 1)) return interaction.reply({ content: `You don't have **${jevil.RELIC_META[itemId].name}**!`, ephemeral: true });
    const picker = jevil.relicPickerFor(userId, itemId);
    if (!picker || picker.error) return interaction.reply({ content: picker?.error || 'Could not open the relic menu.', ephemeral: true });
    return interaction.reply(picker);
  }
  if (action === 'unequip_relic') {
    const picker = jevil.unequipPicker(userId);
    if (!picker || picker.error) return interaction.reply({ content: picker?.error || 'Nothing to unequip.', ephemeral: true });
    return interaction.reply(picker);
  }

  if (action === 'monster_soul') {
    if (!playerDB.hasItem(userId, 'monster_soul', 1)) return interaction.reply({ content: 'You don\'t have a **Monster Soul**!', ephemeral: true });
    playerDB.removeItem(userId, 'monster_soul', 1);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `You used a **Monster Soul**!\n\nYou received a ${shiny ? '**✦ SHINY ✦** ' : ''}**Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
  }

  if (action === 'tier1_on_sans') {
    if (!playerDB.hasItem(userId, 'tier1_monster_soul', 1)) return interaction.reply({ content: 'You don\'t have a **Tier 1 Monster Soul**!', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const sans = chars.filter(c => c.character_id === 'sans');
    if (sans.length === 0) return interaction.reply({ content: 'You don\'t have any **Sans**!', ephemeral: true });
    const targetSans = sans.find(c => !c.locked);
    if (!targetSans) return interaction.reply({ content: '🔒 All your Sans are locked! Use `/unlock` first.', ephemeral: true });
    playerDB.removeItem(userId, 'tier1_monster_soul', 1);
    playerDB.removeCharacter(userId, targetSans.id);
    const pool = ['underfell_sans', 'outertale_sans'];
    const result = pool[Math.floor(Math.random() * pool.length)];
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, result, 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    const cd = CHARACTERS[result];
    return interaction.reply({ content: `The Monster Soul transforms...\n\nYour Sans changed into ${shiny ? '**✦ SHINY ✦** ' : ''}**${cd.name}**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
  }

  // T2 Monster Soul on Sans -> Oceantale Sans, Fresh Sans, or Hardtale Sans (1/3 each)
  if (action === 'tier2_on_sans') {
    if (!playerDB.hasItem(userId, 'tier2_monster_soul', 1)) return interaction.reply({ content: 'You don\'t have a **Tier 2 Monster Soul**!', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const sans = chars.filter(c => c.character_id === 'sans');
    if (sans.length === 0) return interaction.reply({ content: 'You don\'t have any **Sans**!', ephemeral: true });
    const targetSans = sans.find(c => !c.locked);
    if (!targetSans) return interaction.reply({ content: '🔒 All your Sans are locked! Use `/unlock` first.', ephemeral: true });
    playerDB.removeItem(userId, 'tier2_monster_soul', 1);
    playerDB.removeCharacter(userId, targetSans.id);
    const pool = ['oceantale_sans', 'fresh_sans', 'hardtale_sans'];
    const result = pool[Math.floor(Math.random() * pool.length)];
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, result, 0, shiny);
    const ts2 = playerDB.getTeamSize(userId);
    if (ts2 < 6) playerDB.setTeamSlot(userId, ts2 + 1, nc.id);
    const cd = CHARACTERS[result];
    return interaction.reply({ content: `The Tier 2 Monster Soul surges through Sans...\n\nYour Sans transformed into ${shiny ? '**✦ SHINY ✦** ' : ''}**${cd.name}**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
  }

  if (action === 'tier1_on_nothing') {
    if (!playerDB.hasItem(userId, 'tier1_monster_soul', 1)) return interaction.reply({ content: 'You don\'t have a **Tier 1 Monster Soul**!', ephemeral: true });
    playerDB.removeItem(userId, 'tier1_monster_soul', 1);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'underswap_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The Monster Soul releases its energy...\n\nYou received ${shiny ? '**✦ SHINY ✦** ' : ''}**Underswap Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
  }

  if (action === 'save_star') {
    if (!playerDB.hasItem(userId, 'save_star', 1)) return interaction.reply({ content: 'You don\'t have a **Save Star**!', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const eligible = chars.filter(c => c.character_id === 'sans' && getLevelFromExp(c.exp || 0) >= 3);
    if (eligible.length === 0) return interaction.reply({ content: 'You need a **Level 3+ Sans**!', ephemeral: true });
    const targetSans = eligible.find(c => !c.locked);
    if (!targetSans) return interaction.reply({ content: '🔒 All your Level 3+ Sans are locked! Use `/unlock` first.', ephemeral: true });
    playerDB.removeItem(userId, 'save_star', 1);
    playerDB.removeCharacter(userId, targetSans.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'killer_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The Save Star pierces through the timeline...\n\nYour Sans transformed into ${shiny ? '**✦ SHINY ✦** ' : ''}**Killer Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
  }

  if (action === 'tier2_on_swap') {
    if (!playerDB.hasItem(userId, 'tier2_monster_soul', 1)) return interaction.reply({ content: 'You don\'t have a **Tier 2 Monster Soul**!', ephemeral: true });
    const player = playerDB.getPlayer(userId);
    if (player.soul_essence < 120) return interaction.reply({ content: `Not enough **Soul Essence**! Need 120, have ${player.soul_essence}.`, ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const swaps = chars.filter(c => c.character_id === 'underswap_sans');
    if (swaps.length === 0) return interaction.reply({ content: 'You don\'t have an **Underswap Sans**!', ephemeral: true });
    const targetSwap = swaps.find(c => !c.locked);
    if (!targetSwap) return interaction.reply({ content: '🔒 All your Underswap Sans are locked! Use `/unlock` first.', ephemeral: true });
    playerDB.removeItem(userId, 'tier2_monster_soul', 1);
    playerDB.addSoulEssence(userId, -120);
    playerDB.removeCharacter(userId, targetSwap.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'swapswap_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The Tier 2 Monster Soul merges with Underswap Sans...\n\nYou received ${shiny ? '**✦ SHINY ✦** ' : ''}**Swapswap Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
  }

  // Stolen Flames on Sans -> Ruins Dust Sans
  if (action === 'stolen_flames') {
    if (!playerDB.hasItem(userId, 'stolen_flames', 1)) return interaction.reply({ content: 'You don\'t have **Stolen Flames**! Beat Toriel boss to get one.', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const sans = chars.filter(c => c.character_id === 'sans');
    if (sans.length === 0) return interaction.reply({ content: 'You don\'t have any **Sans**!', ephemeral: true });
    const targetSans = sans.find(c => !c.locked);
    if (!targetSans) return interaction.reply({ content: '🔒 All your Sans are locked! Use `/unlock` first.', ephemeral: true });
    playerDB.removeItem(userId, 'stolen_flames', 1);
    playerDB.removeCharacter(userId, targetSans.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'ruins_dust_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The Stolen Flames engulf Sans...\n\nYour Sans transformed into ${shiny ? '**✦ SHINY ✦** ' : ''}**Ruins Dust Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
  }

  // Papyrus Scarf on Ruins Dust Sans -> Snowdin Dust Sans
  if (action === 'papyrus_scarf') {
    if (!playerDB.hasItem(userId, 'papyrus_scarf', 1)) return interaction.reply({ content: 'You don\'t have **Papyrus\' Scarf**!', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const ruins = chars.filter(c => c.character_id === 'ruins_dust_sans');
    if (ruins.length === 0) return interaction.reply({ content: 'You don\'t have a **Ruins Dust Sans**!', ephemeral: true });
    const targetRuins = ruins.find(c => !c.locked);
    if (!targetRuins) return interaction.reply({ content: '🔒 All your Ruins Dust Sans are locked! Use `/unlock` first.', ephemeral: true });
    playerDB.removeItem(userId, 'papyrus_scarf', 1);
    playerDB.removeCharacter(userId, targetRuins.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'snowdin_dust_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `Papyrus' Scarf wraps around Ruins Dust Sans...\n\nTransformed into ${shiny ? '**✦ SHINY ✦** ' : ''}**Snowdin Dust Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
  }

  // Spear on Snowdin Dust Sans -> Waterfall Dust Sans
  if (action === 'spear_use') {
    if (!playerDB.hasItem(userId, 'spear', 1)) return interaction.reply({ content: "You don't have a **Spear**! Beat Undyne to get one.", ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const snowdin = chars.filter(c => c.character_id === 'snowdin_dust_sans');
    if (snowdin.length === 0) return interaction.reply({ content: "You don't have a **Snowdin Dust Sans**!", ephemeral: true });
    const targetSnowdin = snowdin.find(c => !c.locked);
    if (!targetSnowdin) return interaction.reply({ content: '🔒 All your Snowdin Dust Sans are locked! Use `/unlock` first.', ephemeral: true });
    playerDB.removeItem(userId, 'spear', 1);
    playerDB.removeCharacter(userId, targetSnowdin.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'waterfall_dust_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The Spear merges with Snowdin Dust Sans...\n\nTransformed into ${shiny ? '**✦ SHINY ✦** ' : ''}**Dust Sans (Waterfall)**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
  }

  // Head Dog on Level 5 Sans -> Horror Sans
  if (action === 'head_dog_use') {
    if (!playerDB.hasItem(userId, 'head_dog', 1)) return interaction.reply({ content: "You don't have a **Head Dog**!", ephemeral: true });
    const player = playerDB.getPlayer(userId);
    if ((player.soul_essence || 0) < 150) return interaction.reply({ content: `Not enough **Soul Essence**! Need 150, have ${player.soul_essence || 0}.`, ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const lv5sans = chars.filter(c => c.character_id === 'sans' && getLevelFromExp(c.exp || 0) >= 5);
    if (lv5sans.length === 0) return interaction.reply({ content: "You need a **Level 5 Sans**!", ephemeral: true });
    const targetSans = lv5sans.find(c => !c.locked);
    if (!targetSans) return interaction.reply({ content: '🔒 All your Level 5 Sans are locked! Use `/unlock` first.', ephemeral: true });
    playerDB.removeItem(userId, 'head_dog', 1);
    playerDB.addSoulEssence(userId, -150);
    playerDB.removeCharacter(userId, targetSans.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'horror_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The Head Dog attaches itself to Sans...\n\nYour Sans became ${shiny ? '**✦ SHINY ✦** ' : ''}**Horror Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
  }

  if (action === 'reaper_chara_use') {
    if (!playerDB.hasItem(userId, 'hate_scythe', 1)) return interaction.reply({ content: "You don't have a **Hate Scythe**!", ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const charaList = chars.filter(c => c.character_id === 'chara' && !c.locked);
    if (charaList.length === 0) return interaction.reply({ content: 'You need an unlocked **Chara**! (Locked ones must be `/unlock`ed first.)', ephemeral: true });
    const team = playerDB.getTeam(userId);
    const reaperOnTeam = team.some(t => t.character_id === 'reaper_sans');
    if (!reaperOnTeam) return interaction.reply({ content: 'You must have **Reaper Sans** on your team to do this!', ephemeral: true });
    const targetChara = charaList[0];
    playerDB.removeItem(userId, 'hate_scythe', 1);
    playerDB.removeCharacter(userId, targetChara.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'reaper_chara', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"...THE RULES DON'T REALLY APPLY ANYMORE."*\n\nChara takes up the Hate Scythe and becomes ${shiny ? '**✦ SHINY ✦** ' : ''}**Reaper Chara**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Shiny Star — show paginated character picker
  if (action === 'shiny_star') {
    if (!playerDB.hasItem(userId, 'shiny_star', 1)) return interaction.reply({ content: 'You don\'t have a **Shiny Star**!', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const nonShiny = chars.filter(c => !c.shiny && !CHARACTERS[c.character_id]?.refuseShiny && CHARACTERS[c.character_id]?.canBeShiny !== false);
    if (nonShiny.length === 0) return interaction.reply({ content: '❌ All your eligible characters are already shiny!', ephemeral: true });
    return interaction.reply({ ...buildShinyStarPage(nonShiny, 0), ephemeral: true });
  }

  // His Guidance on Level 5 Sans -> Last Breath Sans
  if (action === 'his_guidance') {
    if (!playerDB.hasItem(userId, 'his_guidance', 1)) return interaction.reply({ content: 'You don\'t have **His Guidance**! Beat W.D. Gaster to get one.', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const lv5sans = chars.filter(c => c.character_id === 'sans' && getLevelFromExp(c.exp || 0) >= 5);
    if (lv5sans.length === 0) return interaction.reply({ content: 'You need a **Level 5 Sans**!', ephemeral: true });
    const targetSans = lv5sans.find(c => !c.locked);
    if (!targetSans) return interaction.reply({ content: '🔒 All your Level 5 Sans are locked! Use `/unlock` first.', ephemeral: true });
    playerDB.removeItem(userId, 'his_guidance', 1);
    playerDB.removeCharacter(userId, targetSans.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'last_breath_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `His Guidance reaches into Sans...\n\nYour Sans became ${shiny ? '**✦ SHINY ✦** ' : ''}**Last Breath Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
  }

  // Gaster's Hands -> W.D. Gaster character
  if (action === 'gasters_hands') {
    if (!playerDB.hasItem(userId, 'gasters_hands', 1)) return interaction.reply({ content: 'You don\'t have **Gaster\'s Hands**! Beat W.D. Gaster to get one.', ephemeral: true });
    playerDB.removeItem(userId, 'gasters_hands', 1);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'wd_gaster', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The hands reach out from the void...\n\nYou received ${shiny ? '**✦ SHINY ✦** ' : ''}**W.D. Gaster**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
  }

  // Echo Flowers on Sans (with Sans on team) -> [ * sans encounter] character
  if (action === 'echo_flowers' || action === 'echo_flowers_sans') {
    // Check if user has Papyrus char on team — Revenge Papyrus obtainment
    const chars = playerDB.getCharacters(userId);
    const papyrusChar = chars.find(c => c.character_id === 'papyrus_char');
    const hasGastersHands = playerDB.hasItem(userId, 'gasters_hands', 1);
    const p = playerDB.getPlayer(userId);
    if (papyrusChar && hasGastersHands && p.soul_essence >= 500) {
      // Revenge Papyrus obtainment
      if (papyrusChar.locked) return interaction.reply({ content: '🔒 Your **Papyrus** is locked! Use `/unlock` first.', ephemeral: true });
      playerDB.removeItem(userId, 'echo_flowers', 1);
      playerDB.removeItem(userId, 'gasters_hands', 1);
      playerDB.addSoulEssence(userId, -500);
      playerDB.removeCharacter(userId, papyrusChar.id);
      const shiny = rollShiny();
      const nc = playerDB.addCharacter(userId, 'revenge_papyrus', 0, shiny);
      const ts = playerDB.getTeamSize(userId);
      if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
      return interaction.reply({ content: `*"there is only justice."*\n\nYour **Papyrus** was consumed alongside the flowers and the hands...\n\nYou received ${shiny ? '**✦ SHINY ✦** ' : ''}**Revenge Papyrus**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
    }
    // Normal echo flowers — Sans encounter
    if (!playerDB.hasItem(userId, 'echo_flowers', 1)) return interaction.reply({ content: 'You don\'t have **Echo Flowers**!', ephemeral: true });
    const team = playerDB.getTeam(userId);
    const hasSans = team.some(t => t.character_id === 'sans');
    if (!hasSans) return interaction.reply({ content: 'You need **Sans** on your team to use Echo Flowers!', ephemeral: true });
    playerDB.removeItem(userId, 'echo_flowers', 1);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'star_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The flowers echo a familiar voice...\n\nYou received ${shiny ? '**✦ SHINY ✦** ' : ''}**[ * sans encounter]**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
  }

  // DT Injector + Papyrus' Skull on Sans -> Insanity Sans
  if (action === 'dt_injector_skull') {
    if (!playerDB.hasItem(userId, 'dt_injector', 1)) return interaction.reply({ content: 'You don\'t have a **DT Injector**! Beat W.D. Gaster to get one.', ephemeral: true });
    if (!playerDB.hasItem(userId, 'papyrus_skull', 1)) return interaction.reply({ content: 'You don\'t have **Papyrus\' Skull**! Beat Papyrus to get one.', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const sans = chars.filter(c => c.character_id === 'sans');
    if (sans.length === 0) return interaction.reply({ content: 'You don\'t have any **Sans**!', ephemeral: true });
    const targetSans = sans.find(c => !c.locked);
    if (!targetSans) return interaction.reply({ content: '🔒 All your Sans are locked! Use `/unlock` first.', ephemeral: true });
    playerDB.removeItem(userId, 'dt_injector', 1);
    playerDB.removeItem(userId, 'papyrus_skull', 1);
    playerDB.removeCharacter(userId, targetSans.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'insanity_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The Determination floods into Sans' fractured mind...\n\nYour Sans became ${shiny ? '**✦ SHINY ✦** ' : ''}**Insanity Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
  }

  // Papyrus' Skull on nothing -> Papyrus character
  if (action === 'papyrus_skull_use') {
    if (!playerDB.hasItem(userId, 'papyrus_skull', 1)) return interaction.reply({ content: 'You don\'t have a **Papyrus\' Skull**! Beat Papyrus to get one.', ephemeral: true });
    playerDB.removeItem(userId, 'papyrus_skull', 1);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'papyrus_char', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The skull glows with a familiar energy...\n\nYou received ${shiny ? '**✦ SHINY ✦** ' : ''}**Papyrus**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
  }

  // Save Star Menu on Lv5 Sans + 400 SE -> Geno Sans
  if (action === 'save_star_menu') {
    if (!playerDB.hasItem(userId, 'save_star_menu', 1)) return interaction.reply({ content: 'You don\'t have a **Save Star Menu**! Get one from `/scavenge`.', ephemeral: true });
    const player = playerDB.getPlayer(userId);
    if ((player.soul_essence || 0) < 400) return interaction.reply({ content: `Not enough **Soul Essence**! Need 400, have ${player.soul_essence || 0}.`, ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const lv5sans = chars.filter(c => c.character_id === 'sans' && !c.locked && getLevelFromExp(c.exp || 0) >= 5);
    if (lv5sans.length === 0) return interaction.reply({ content: 'You need an unlocked **Level 5 Sans**!', ephemeral: true });
    playerDB.removeItem(userId, 'save_star_menu', 1);
    playerDB.addSoulEssence(userId, -400);
    playerDB.removeCharacter(userId, lv5sans[0].id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'geno_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The Save Star Menu flickers...\n\nYour Sans became ${shiny ? '**✦ SHINY ✦** ' : ''}**Geno Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
  }

  // Orange Jacket on Underswap Sans + 500 SE (with Underswap Sans on team) -> Underswap Papyrus
  if (action === 'orange_jacket') {
    if (!playerDB.hasItem(userId, 'orange_jacket', 1)) return interaction.reply({ content: 'You don\'t have an **Orange Jacket**! Beat Papyrus to get one.', ephemeral: true });
    const player = playerDB.getPlayer(userId);
    if ((player.soul_essence || 0) < 500) return interaction.reply({ content: `Not enough **Soul Essence**! Need 500, have ${player.soul_essence || 0}.`, ephemeral: true });
    const team = playerDB.getTeam(userId);
    const hasSwapOnTeam = team.some(t => t.character_id === 'underswap_sans');
    if (!hasSwapOnTeam) return interaction.reply({ content: 'You need **Underswap Sans** on your team!', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const swap = chars.find(c => c.character_id === 'underswap_sans' && !c.locked);
    if (!swap) return interaction.reply({ content: 'You need an unlocked **Underswap Sans**!', ephemeral: true });
    playerDB.removeItem(userId, 'orange_jacket', 1);
    playerDB.addSoulEssence(userId, -500);
    playerDB.removeCharacter(userId, swap.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'underswap_papyrus', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The Orange Jacket wraps around Underswap Sans...\n\nTransformed into ${shiny ? '**✦ SHINY ✦** ' : ''}**Underswap Papyrus**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
  }

  // Ink Brush + 6 Tier 3 Monster Souls on Lv5 Sans -> Ink Sans
  if (action === 'ink_brush') {
    if (!playerDB.hasItem(userId, 'ink_brush', 1)) return interaction.reply({ content: 'You don\'t have an **Ink Brush**! Beat W.D. Gaster to get one.', ephemeral: true });
    if (!playerDB.hasItem(userId, 'tier3_monster_soul', 6)) return interaction.reply({ content: `Not enough **Tier 3 Monster Souls**! Need 6, have ${playerDB.getItem(userId, 'tier3_monster_soul').amount || 0}.`, ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const lv5sans = chars.filter(c => c.character_id === 'sans' && !c.locked && getLevelFromExp(c.exp || 0) >= 5);
    if (lv5sans.length === 0) return interaction.reply({ content: 'You need an unlocked **Level 5 Sans**!', ephemeral: true });
    playerDB.removeItem(userId, 'ink_brush', 1);
    playerDB.removeItem(userId, 'tier3_monster_soul', 6);
    playerDB.removeCharacter(userId, lv5sans[0].id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'ink_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The Ink Brush and souls fuse with Sans...\n\nYour Sans became ${shiny ? '**✦ SHINY ✦** ' : ''}**Ink Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
  }

  // T3 Monster Soul on Sans + 500 DT + 1000 SE -> 50/50 Ainavol or Agem
  if (action === 'tier3_on_sans') {
    if (!playerDB.hasItem(userId, 'tier3_monster_soul', 1)) return interaction.reply({ content: 'You don\'t have a **Tier 3 Monster Soul**!', ephemeral: true });
    const player = playerDB.getPlayer(userId);
    if ((player.determination || 0) < 500) return interaction.reply({ content: `Not enough **Determination**! Need 500, have ${player.determination || 0}.`, ephemeral: true });
    if ((player.soul_essence || 0) < 1000) return interaction.reply({ content: `Not enough **Soul Essence**! Need 1000, have ${player.soul_essence || 0}.`, ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const sans = chars.find(c => c.character_id === 'sans' && !c.locked);
    if (!sans) return interaction.reply({ content: 'You need an unlocked **Sans**!', ephemeral: true });
    playerDB.removeItem(userId, 'tier3_monster_soul', 1);
    playerDB.addDetermination(userId, -500);
    playerDB.addSoulEssence(userId, -1000);
    playerDB.removeCharacter(userId, sans.id);
    const result = Math.random() < 0.5 ? 'ainavol' : 'agem';
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, result, 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    const cd = CHARACTERS[result];
    return interaction.reply({ content: `The Tier 3 Monster Soul tears through the timeline...\n\nYour Sans became ${shiny ? '**✦ SHINY ✦** ' : ''}**${cd.name}**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
  }

  // 2 Glitched Strings + Geno Sans + 6666 SE -> Error Sans
  if (action === 'error_sans_use') {
    if (!playerDB.hasItem(userId, 'glitched_strings', 2)) return interaction.reply({ content: `Not enough **Glitched Strings**! Need 2, have ${playerDB.getItem(userId, 'glitched_strings').amount || 0}.`, ephemeral: true });
    const player = playerDB.getPlayer(userId);
    if ((player.soul_essence || 0) < 6666) return interaction.reply({ content: `Not enough **Soul Essence**! Need 6666, have ${player.soul_essence || 0}.`, ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const geno = chars.find(c => c.character_id === 'geno_sans' && !c.locked);
    if (!geno) return interaction.reply({ content: 'You need an unlocked **Geno Sans**!', ephemeral: true });
    playerDB.removeItem(userId, 'glitched_strings', 2);
    playerDB.addSoulEssence(userId, -6666);
    playerDB.removeCharacter(userId, geno.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'error_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The Glitched Strings corrupt Geno Sans...\n\nYour Geno Sans became ${shiny ? '**✦ SHINY ✦** ' : ''}**Error Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
  }

  // T3 Monster Soul on Sans murder path -> Murder Sans (requires sin counter)
  if (action === 'murder_sans_use') {
    if (!playerDB.hasItem(userId, 'tier3_monster_soul', 1)) return interaction.reply({ content: 'You don\'t have a **Tier 3 Monster Soul**!', ephemeral: true });
    const player = playerDB.getPlayer(userId);
    if (!(player.murderReady)) return interaction.reply({ content: 'The soul won\'t respond... *You feel your sins crawling up on your back.* Kill more enemies with Sans first.', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const sans = chars.find(c => c.character_id === 'sans' && !c.locked);
    if (!sans) return interaction.reply({ content: 'You need an unlocked **Sans**!', ephemeral: true });
    playerDB.removeItem(userId, 'tier3_monster_soul', 1);
    playerDB.removeCharacter(userId, sans.id);
    playerDB.setMurderReady(userId, false);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'murder_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"heh..."*\n\nYour Sans snapped. They became ${shiny ? '**✦ SHINY ✦** ' : ''}**Murder!Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
  }

  // Car Battery -> a forced grin. character (REMOVED in Update 12)
  if (action === 'car_battery_use') {
    return interaction.reply({ content: 'The **🔋 Car Battery** can no longer be used. The "a forced grin." event has ended. Existing owners keep their character.', ephemeral: true });
  }

  // Time Orb on Sans + 10,000 SE + 2,500 DT -> FT!Sans
  if (action === 'time_orb_use') {
    if (!playerDB.hasItem(userId, 'time_orb', 1)) return interaction.reply({ content: 'You don\'t have a **🔵 Time Orb**! Beat Time Paradox boss to get one (5% chance).', ephemeral: true });
    const player = playerDB.getPlayer(userId);
    if ((player.soul_essence || 0) < 10000) return interaction.reply({ content: `Not enough **Soul Essence**! Need 10,000, have ${(player.soul_essence || 0).toLocaleString()}.`, ephemeral: true });
    if ((player.determination || 0) < 2500) return interaction.reply({ content: `Not enough **Determination**! Need 2,500, have ${(player.determination || 0).toLocaleString()}.`, ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const sans = chars.find(c => c.character_id === 'sans' && !c.locked);
    if (!sans) return interaction.reply({ content: 'You need an unlocked **Sans**!', ephemeral: true });
    playerDB.removeItem(userId, 'time_orb', 1);
    playerDB.addSoulEssence(userId, -10000);
    playerDB.addDetermination(userId, -2500);
    playerDB.removeCharacter(userId, sans.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'ft_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The Time Orb pulses with temporal energy...\n\n*MY MEMORIES!*\n\nYour Sans became ${shiny ? '**✦ SHINY ✦** ' : ''}**FT!Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
  }

  // Parasite on Fresh Sans -> True Fresh!Sans
  if (action === 'parasite_use') {
    if (!playerDB.hasItem(userId, 'parasite', 1)) return interaction.reply({ content: 'You don\'t have a **🦠 Parasite**! Get one from `/scavenge` (3% chance).', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const fresh = chars.find(c => c.character_id === 'fresh_sans' && !c.locked);
    if (!fresh) return interaction.reply({ content: 'You need an unlocked **Fresh Sans**!', ephemeral: true });
    playerDB.removeItem(userId, 'parasite', 1);
    playerDB.removeCharacter(userId, fresh.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'true_fresh_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"THE PARTY HAS ONLY NOW STARTED!"*\n\nThe parasite takes over Fresh Sans...\n\nYou received ${shiny ? '**✦ SHINY ✦** ' : ''}**True Fresh!Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
  }

  // Crown of the King on Sans -> StoryShift! Sans
  if (action === 'crown_use') {
    if (!playerDB.hasItem(userId, 'crown_of_the_king', 1)) return interaction.reply({ content: 'You don\'t have the **👑 Crown of the King**! Beat Asgore boss (2% drop).', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const sans = chars.find(c => c.character_id === 'sans' && !c.locked);
    if (!sans) return interaction.reply({ content: 'You need an unlocked **Sans**!', ephemeral: true });
    playerDB.removeItem(userId, 'crown_of_the_king', 1);
    playerDB.removeCharacter(userId, sans.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'storyshift_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"I'm breaking every bone in your body."*\n\nThe Crown of the King descends upon Sans...\n\nYour Sans became ${shiny ? '**✦ SHINY ✦** ' : ''}**StoryShift! Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
  }

  // --- UPDATE 22: The Dark Cross on Sans -> Fallen Priest ---
  if (action === 'dark_cross_use') {
    if (!playerDB.hasItem(userId, 'the_dark_cross', 1)) return interaction.reply({ content: 'You don\'t have **🖤 The Dark Cross**! Craft it from A Cross + Their Dying Wishes + 5 Stolen Monster Magic + 7,000 DT Vials + 260,000 Determination.', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const sans = chars.find(c => c.character_id === 'sans' && !c.locked);
    if (!sans) return interaction.reply({ content: 'You need an unlocked **Sans**!', ephemeral: true });
    playerDB.removeItem(userId, 'the_dark_cross', 1);
    playerDB.removeCharacter(userId, sans.id);
    const nc = playerDB.addCharacter(userId, 'fallen_priest', 0, false); // cannot be shiny
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"Their sins shall be forgiven.. But yours shall not."*\n\nThe Dark Cross consumes your Sans...\n\nYou received the **✝️ Fallen Priest**!\nIt has found its place in character ID **${nc.id}**.` });
  }

  // Cat Food -> Sansfield
  if (action === 'cat_food_use') {
    if (!playerDB.hasItem(userId, 'cat_food', 1)) return interaction.reply({ content: 'You don\'t have **🐱 Cat Food**! Get it from the Gacha (Legendary).', ephemeral: true });
    playerDB.removeItem(userId, 'cat_food', 1);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'sansfield', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"I hate Mondays."*\n\nThe Cat Food summons a familiar presence...\n\nYou received ${shiny ? '**✦ SHINY ✦** ' : ''}**Sansfield**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nIt has found its place in character ID **${nc.id}**.` });
  }

  if (action === 'shanghaivania_use') {
    const chars = playerDB.getCharacters(userId);
    const inkSans = chars.find(c => c.character_id === 'ink_sans');
    if (!inkSans) return interaction.reply({ content: 'You need **Ink Sans** in your collection!', ephemeral: true });
    if (inkSans.locked) return interaction.reply({ content: `🔒 Your Ink Sans (ID: ${inkSans.id}) is locked! Use \`/unlock\` first.`, ephemeral: true });
    if (!playerDB.hasItem(userId, 'paint_vials', 7)) return interaction.reply({ content: 'You need **7x 🎨 Paint Vials**!', ephemeral: true });
    if (!playerDB.hasItem(userId, 'ink_brush', 2)) return interaction.reply({ content: 'You need **2x 🖌️ Ink Brushes**!', ephemeral: true });
    const p = playerDB.getPlayer(userId);
    if ((p.soul_essence || 0) < 20000) return interaction.reply({ content: `You need **20,000 Soul Essence**! You have **${(p.soul_essence || 0).toLocaleString()}**.`, ephemeral: true });
    const t3souls = playerDB.getItem(userId, 'tier3_monster_soul').amount;
    if (t3souls < 3) return interaction.reply({ content: `You need **3x Tier 3 Monster Souls**! You have **${t3souls}**.`, ephemeral: true });
    // Check team requirements: Error Sans, Lv5 Sans, Lv5 Fell
    const team = playerDB.getTeam(userId);
    const hasError = team.some(c => c.character_id === 'error_sans');
    const hasLv5Sans = team.some(c => c.character_id === 'sans' && getLevelFromExp(c.exp || 0) >= 5);
    const hasLv5Fell = team.some(c => c.character_id === 'underfell_sans' && getLevelFromExp(c.exp || 0) >= 5);
    if (!hasError) return interaction.reply({ content: 'You need **Error Sans** on your team!', ephemeral: true });
    if (!hasLv5Sans) return interaction.reply({ content: 'You need a **Level 5 Sans** on your team!', ephemeral: true });
    if (!hasLv5Fell) return interaction.reply({ content: 'You need a **Level 5 Underfell Sans** on your team!', ephemeral: true });
    // Consume everything
    playerDB.removeCharacter(userId, inkSans.id);
    playerDB.removeItem(userId, 'paint_vials', 7);
    playerDB.removeItem(userId, 'ink_brush', 2);
    playerDB.removeItem(userId, 'tier3_monster_soul', 3);
    playerDB.addSoulEssence(userId, -20000);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'shanghaivania_ink_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"You killed me that quickly? I see... you're just like Error. Fine. If you want a monster, I'll show you what I'm capable of. Let's get serious."*\n\nInk Sans transforms into ${shiny ? '**✦ SHINY ✦** ' : ''}**Shanghaivania Ink Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // ============================================================
  // === UPDATE 13 USE HANDLERS ===
  // ============================================================

  // Mafiatale Sans: Tommy Gun + Mafia Hat + Cigarette Pack on Lv5 Sans
  if (action === 'mafiatale_use') {
    if (!playerDB.hasItem(userId, 'tommy_gun', 1)) return interaction.reply({ content: 'You need a **Tommy Gun** (craft from 10x A Gun...?).', ephemeral: true });
    if (!playerDB.hasItem(userId, 'mafia_hat', 1)) return interaction.reply({ content: 'You need a **Mafia Hat** (drop from Mafia Sans).', ephemeral: true });
    if (!playerDB.hasItem(userId, 'cigarette_pack', 1)) return interaction.reply({ content: 'You need a **Cigarette Pack** (Epic Gacha drop).', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const lv5Sans = chars.filter(c => c.character_id === 'sans' && getLevelFromExp(c.exp || 0) >= 5 && !c.locked);
    if (lv5Sans.length === 0) return interaction.reply({ content: 'You need an unlocked **Lv5 Sans**!', ephemeral: true });
    const target = lv5Sans[0];
    playerDB.removeItem(userId, 'tommy_gun', 1);
    playerDB.removeItem(userId, 'mafia_hat', 1);
    playerDB.removeItem(userId, 'cigarette_pack', 1);
    playerDB.removeCharacter(userId, target.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'mafiatale_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"Capisce? Don't make me whack you, kid."*\n\nYour Sans transformed into ${shiny ? '**✦ SHINY ✦** ' : ''}**Mafiatale Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Outerdust Sans: 1 Cosmic Dust + 1 Stolen Monster Magic, requires 3 Lv5 Outertale + 1 Lv5 JHall Dust on team
  if (action === 'outerdust_use') {
    if (!playerDB.hasItem(userId, 'cosmic_dust', 1)) return interaction.reply({ content: 'You need a **Cosmic Dust** (6% drop from W.D. Gaster).', ephemeral: true });
    if (!playerDB.hasItem(userId, 'stolen_monster_magic', 1)) return interaction.reply({ content: 'You need **Stolen Monster Magic** (craft from all boss drops).', ephemeral: true });
    const team = playerDB.getTeam(userId);
    const teamFull = team.map(t => ({ ...t, lv: getLevelFromExp(t.exp || 0) }));
    const outers = teamFull.filter(t => t.character_id === 'outertale_sans' && t.lv >= 5);
    const jhalls = teamFull.filter(t => t.character_id === 'judgement_hall_dust_sans' && t.lv >= 5);
    if (outers.length < 3) return interaction.reply({ content: `You need **3 Lv5 Outertale Sans** on your team! (You have ${outers.length})`, ephemeral: true });
    if (jhalls.length < 1) return interaction.reply({ content: `You need **1 Lv5 Judgement Hall Dust Sans** on your team!`, ephemeral: true });
    playerDB.removeItem(userId, 'cosmic_dust', 1);
    playerDB.removeItem(userId, 'stolen_monster_magic', 1);
    // Consume the 3 Outers and 1 JHall
    for (let i = 0; i < 3; i++) playerDB.removeCharacter(userId, outers[i].character_row_id);
    playerDB.removeCharacter(userId, jhalls[0].character_row_id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'outerdust_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The cosmic dust scatters across the stars...\n\nThe four Sanses fuse into ${shiny ? '**✦ SHINY ✦** ' : ''}**Outerdust Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Judgement Hall Dust Sans: Stolen Monster Magic on Lv5 Waterfall Dust + 1k SE
  if (action === 'jhall_dust_use') {
    if (!playerDB.hasItem(userId, 'stolen_monster_magic', 1)) return interaction.reply({ content: 'You need **Stolen Monster Magic** (craft from all boss drops).', ephemeral: true });
    const player = playerDB.getPlayer(userId);
    if ((player.soul_essence || 0) < 1000) return interaction.reply({ content: 'You need **1,000 Soul Essence**!', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const cdust = chars.filter(c => c.character_id === 'core_dust_sans' && getLevelFromExp(c.exp || 0) >= 5 && !c.locked);
    if (cdust.length === 0) return interaction.reply({ content: 'You need an unlocked **Lv5 Core Dust Sans**!', ephemeral: true });
    const target = cdust[0];
    playerDB.removeItem(userId, 'stolen_monster_magic', 1);
    playerDB.addSoulEssence(userId, -1000);
    playerDB.removeCharacter(userId, target.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'judgement_hall_dust_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"Do you think... that even the worst person can change? Heh, little late for that."*\n\nYour Core Dust ascended to ${shiny ? '**✦ SHINY ✦** ' : ''}**Judgement Hall Dust Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Hotlands Dust Sans: Neo Cannon on Waterfall Dust
  if (action === 'hotlands_dust_use') {
    if (!playerDB.hasItem(userId, 'neo_cannon', 1)) return interaction.reply({ content: 'You need a **Neo Cannon** (1/3 drop from Mettaton NEO).', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const wdust = chars.filter(c => c.character_id === 'waterfall_dust_sans' && !c.locked);
    if (wdust.length === 0) return interaction.reply({ content: 'You need an unlocked **Waterfall Dust Sans**!', ephemeral: true });
    const target = wdust[0];
    playerDB.removeItem(userId, 'neo_cannon', 1);
    playerDB.removeCharacter(userId, target.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'hotlands_dust_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The mechanical power of the Underground awakens...\n\nYour Waterfall Dust became ${shiny ? '**✦ SHINY ✦** ' : ''}**Hotlands Dust Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Core Dust Sans: Empty Gun on Hotlands Dust
  if (action === 'core_dust_use') {
    if (!playerDB.hasItem(userId, 'empty_gun', 1)) return interaction.reply({ content: 'You need an **Empty Gun** (1/5 drop from Mettaton NEO).', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const hdust = chars.filter(c => c.character_id === 'hotlands_dust_sans' && !c.locked);
    if (hdust.length === 0) return interaction.reply({ content: 'You need an unlocked **Hotlands Dust Sans**!', ephemeral: true });
    const target = hdust[0];
    playerDB.removeItem(userId, 'empty_gun', 1);
    playerDB.removeCharacter(userId, target.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'core_dust_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The CORE pulses with radiation...\n\nYour Hotlands Dust transformed into ${shiny ? '**✦ SHINY ✦** ' : ''}**Core Dust Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Storyshift Chara: Green Coat + 2500 SE + Real Knife
  if (action === 'storyshift_chara_use') {
    if (!playerDB.hasItem(userId, 'green_coat', 1)) return interaction.reply({ content: 'You need a **Green Coat** (craft from Orange Jacket + T3 Soul).', ephemeral: true });
    if (!playerDB.hasItem(userId, 'real_knife', 1)) return interaction.reply({ content: 'You need a **Real Knife** (1/99 drop from any boss).', ephemeral: true });
    const player = playerDB.getPlayer(userId);
    if ((player.soul_essence || 0) < 2500) return interaction.reply({ content: 'You need **2,500 Soul Essence**!', ephemeral: true });
    playerDB.removeItem(userId, 'green_coat', 1);
    playerDB.removeItem(userId, 'real_knife', 1);
    playerDB.addSoulEssence(userId, -2500);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'storyshift_chara', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The green coat falls into place...\n\nYou received ${shiny ? '**✦ SHINY ✦** ' : ''}**Storyshift Chara**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Storyfell Chara: Crimson Coat, requires 3 Lv5 Underfell Sans on team
  if (action === 'storyfell_chara_use') {
    if (!playerDB.hasItem(userId, 'crimson_coat', 1)) return interaction.reply({ content: 'You need a **Crimson Coat** (craft from Vines + Green Coat + 3 Real Knives + 6k SE).', ephemeral: true });
    const team = playerDB.getTeam(userId);
    const teamFull = team.map(t => ({ ...t, lv: getLevelFromExp(t.exp || 0) }));
    const ufs = teamFull.filter(t => t.character_id === 'underfell_sans' && t.lv >= 5);
    if (ufs.length < 3) return interaction.reply({ content: `You need **3 Lv5 Underfell Sans** on your team! (You have ${ufs.length})`, ephemeral: true });
    playerDB.removeItem(userId, 'crimson_coat', 1);
    for (let i = 0; i < 3; i++) playerDB.removeCharacter(userId, ufs[i].character_row_id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'storyfell_chara', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The crimson coat drips with finality...\n\nYou received ${shiny ? '**✦ SHINY ✦** ' : ''}**Storyfell Chara**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Call of the Void hint (real handling in /fuse)
  if (action === 'cotv_fuse_use') {
    return interaction.reply({ content: 'Call of the Void Sans is obtained via `/fuse`. Use the **Void Tablet** in the fuse menu (requires Lv5 Sans + Lv5 Papyrus + Lv5 W.D. Gaster on team).', ephemeral: true });
  }

  // Swapfell Papyrus: Purple Jacket + US Sans on team + US Pap on team + 2500 SE
  if (action === 'swapfell_papyrus_use') {
    if (!playerDB.hasItem(userId, 'purple_jacket', 1)) return interaction.reply({ content: 'You need a **Purple Jacket** (craft from Orange Jacket + Cigarette Pack).', ephemeral: true });
    const player = playerDB.getPlayer(userId);
    if ((player.soul_essence || 0) < 2500) return interaction.reply({ content: 'You need **2,500 Soul Essence**!', ephemeral: true });
    const team = playerDB.getTeam(userId);
    const hasUSSans = team.some(t => t.character_id === 'underswap_sans');
    const hasUSPap = team.some(t => t.character_id === 'underswap_papyrus');
    if (!hasUSSans || !hasUSPap) return interaction.reply({ content: 'You need both **Underswap Sans** AND **Underswap Papyrus** on your team!', ephemeral: true });
    playerDB.removeItem(userId, 'purple_jacket', 1);
    playerDB.addSoulEssence(userId, -2500);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'swapfell_papyrus', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The smoke drifts in lazy circles...\n\nYou received ${shiny ? '**✦ SHINY ✦** ' : ''}**Swapfell Papyrus**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // ===================== UPDATE 31 OBTAINMENTS =====================
  // Karma!Sans: 5 Karma Vials on a Lv5 Last Breath Sans
  if (action === 'karma_sans_use') {
    if (!playerDB.hasItem(userId, 'karma_vial', 5)) return interaction.reply({ content: 'You need **5 Karma Vials** (craft 10 DT Injectors into 1 Karma Vial).', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const lb = chars.filter(c => c.character_id === 'last_breath_sans' && getLevelFromExp(c.exp || 0) >= 5 && !c.locked);
    if (lb.length === 0) return interaction.reply({ content: 'You need an unlocked **Lv5 Last Breath Sans**!', ephemeral: true });
    const target = lb[0];
    playerDB.removeItem(userId, 'karma_vial', 5);
    playerDB.removeCharacter(userId, target.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'karma_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"good karma heals me, while bad karma cooks your fucking hp up, kiddo."*\n\nYour Last Breath Sans drank it all and became **${shiny ? '✦ SHINY ✦ ' : ''}Karma!Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // REBAR!Insanity: 5 Rebars on a C!Insanity
  if (action === 'rebar_insanity_use') {
    if (!playerDB.hasItem(userId, 'rebar', 5)) return interaction.reply({ content: 'You need **5 Rebars** (10% drop from **HIM**, the superboss).', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const ci = chars.filter(c => c.character_id === 'c_insanity' && !c.locked);
    if (ci.length === 0) return interaction.reply({ content: 'You need an unlocked **C!Insanity**!', ephemeral: true });
    const target = ci[0];
    playerDB.removeItem(userId, 'rebar', 5);
    playerDB.removeCharacter(userId, target.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'rebar_insanity', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `Steel in hand, steel in bone.\n\nYour C!Insanity became **${shiny ? '✦ SHINY ✦ ' : ''}REBAR!Insanity**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Unnamed Kindness: Rebar + 2 Empowered Kindness Souls on Rose
  if (action === 'unnamed_kindness_use') {
    if (!playerDB.hasItem(userId, 'rebar', 1)) return interaction.reply({ content: 'You need a **Rebar** (10% drop from **HIM**).', ephemeral: true });
    if (!playerDB.hasItem(userId, 'empowered_kindness_soul', 2)) return interaction.reply({ content: 'You need **2 Empowered Kindness Souls**!', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const rose = chars.filter(c => c.character_id === 'rose' && !c.locked);
    if (rose.length === 0) return interaction.reply({ content: 'You need an unlocked **Rose**!', ephemeral: true });
    const target = rose[0];
    playerDB.removeItem(userId, 'rebar', 1);
    playerDB.removeItem(userId, 'empowered_kindness_soul', 2);
    playerDB.removeCharacter(userId, target.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'unnamed_kindness', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `A kindness that never gave its name.\n\nRose became **${shiny ? '✦ SHINY ✦ ' : ''}Unnamed Kindness**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Papyrus/?: DT Injector on Papyrus — 66,666 DT + 66,666 SE + Amalgamate Essence, 10% success
  if (action === 'papyrus_q_use') {
    if (!playerDB.hasItem(userId, 'dt_injector', 1)) return interaction.reply({ content: 'You need a **DT Injector**.', ephemeral: true });
    if (!playerDB.hasItem(userId, 'amalgamate_essence', 1)) return interaction.reply({ content: 'You need an **Amalgamate Essence** (10% drop from **AMALGAMATE**).', ephemeral: true });
    const player = playerDB.getPlayer(userId);
    if ((player.determination || 0) < 66666) return interaction.reply({ content: 'You need **66,666 Determination**!', ephemeral: true });
    if ((player.soul_essence || 0) < 66666) return interaction.reply({ content: 'You need **66,666 Soul Essence**!', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const paps = chars.filter(c => c.character_id === 'papyrus_char' && !c.locked);
    if (paps.length === 0) return interaction.reply({ content: 'You need an unlocked **Papyrus**!', ephemeral: true });
    const target = paps[0];
    playerDB.removeItem(userId, 'dt_injector', 1);
    playerDB.removeItem(userId, 'amalgamate_essence', 1);
    playerDB.removeCharacter(userId, target.id);
    if (Math.random() >= 0.10) {
      return interaction.reply({ content: `You inject the Determination... and **Papyrus melts away into nothing.**\n\n*The attempt failed. Your Papyrus is gone.*` });
    }
    playerDB.addDetermination(userId, -66666);
    playerDB.addSoulEssence(userId, -66666);
    const nc = playerDB.addCharacter(userId, 'papyrus_q', 0, false);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*h̷ ̶h̷e̶l̷p̸ ̶m̵e̷/̸s̴a̵n̷s̶*\n\nSomething answered. You now have **Papyrus/?**.\nCharacter ID: **${nc.id}**.` });
  }

  // Hardmode Insanity: Hardmode Essence + 10 DT Injectors + 15k SE on Sans, JHall Dust on team
  if (action === 'hardmode_insanity_use') {
    if (!playerDB.hasItem(userId, 'hardmode_essence', 1)) return interaction.reply({ content: 'You need **Hardmode Essence** (Negativetale\'s Shop, 25,000 Det).', ephemeral: true });
    if (!playerDB.hasItem(userId, 'dt_injector', 10)) return interaction.reply({ content: 'You need **10 DT Injectors**!', ephemeral: true });
    const player = playerDB.getPlayer(userId);
    if ((player.soul_essence || 0) < 15000) return interaction.reply({ content: 'You need **15,000 Soul Essence**!', ephemeral: true });
    const team = playerDB.getTeam(userId) || [];
    const hasJHall = team.some(c => c && c.character_id === 'judgement_hall_dust_sans');
    if (!hasJHall) return interaction.reply({ content: 'You need a **Judgement Hall Dust Sans** on your team!', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const sanses = chars.filter(c => c.character_id === 'sans' && !c.locked);
    if (sanses.length === 0) return interaction.reply({ content: 'You need an unlocked **Sans**!', ephemeral: true });
    const target = sanses[0];
    playerDB.removeItem(userId, 'hardmode_essence', 1);
    playerDB.removeItem(userId, 'dt_injector', 10);
    playerDB.addSoulEssence(userId, -15000);
    playerDB.removeCharacter(userId, target.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'hardmode_insanity', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"It never ends... it never stops... so why should I?"*\n\nYour Sans became **${shiny ? '✦ SHINY ✦ ' : ''}Hardmode Insanity**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }
  // ===================== END UPDATE 31 OBTAINMENTS =====================

  // Hardmode Sans: Hardmode Essence on Lv5 Sans + 10k SE
  if (action === 'hardmode_sans_use') {
    if (!playerDB.hasItem(userId, 'hardmode_essence', 1)) return interaction.reply({ content: 'You need **Hardmode Essence** (Negativetale\'s Shop, 25,000 Det).', ephemeral: true });
    const player = playerDB.getPlayer(userId);
    if ((player.soul_essence || 0) < 10000) return interaction.reply({ content: 'You need **10,000 Soul Essence**!', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const lv5Sans = chars.filter(c => c.character_id === 'sans' && getLevelFromExp(c.exp || 0) >= 5 && !c.locked);
    if (lv5Sans.length === 0) return interaction.reply({ content: 'You need an unlocked **Lv5 Sans**!', ephemeral: true });
    const target = lv5Sans[0];
    playerDB.removeItem(userId, 'hardmode_essence', 1);
    playerDB.addSoulEssence(userId, -10000);
    playerDB.removeCharacter(userId, target.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'hardmode_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"You deserve no mercy."*\n\nYour Sans embraced **${shiny ? '✦ SHINY ✦ ' : ''}Hardmode**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Dustfell Sans: Dusty Fur Hood + Chains on Lv5 JHall Dust, Lv5 Underfell Sans on team, 25 kills each
  if (action === 'dustfell_sans_use') {
    if (!playerDB.hasItem(userId, 'dusty_fur_hood', 1)) return interaction.reply({ content: 'You need a **Dusty Fur Hood** (5% Rare Gacha drop).', ephemeral: true });
    if (!playerDB.hasItem(userId, 'chains', 1)) return interaction.reply({ content: 'You need **Chains** (10% drop from /scavenge).', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const jhalls = chars.filter(c => c.character_id === 'judgement_hall_dust_sans' && getLevelFromExp(c.exp || 0) >= 5 && !c.locked);
    if (jhalls.length === 0) return interaction.reply({ content: 'You need an unlocked **Lv5 Judgement Hall Dust Sans**!', ephemeral: true });
    const team = playerDB.getTeam(userId);
    const teamFull = team.map(t => ({ ...t, lv: getLevelFromExp(t.exp || 0) }));
    const hasUFLv5 = teamFull.some(t => t.character_id === 'underfell_sans' && t.lv >= 5);
    if (!hasUFLv5) return interaction.reply({ content: 'You need a **Lv5 Underfell Sans** on your team!', ephemeral: true });
    // Kill count check: 25 each on JHall Dust and Underfell Sans
    const killsJ = playerDB.getKillCount(userId, 'judgement_hall_dust_sans') || 0;
    const killsU = playerDB.getKillCount(userId, 'underfell_sans') || 0;
    if (killsJ < 25 || killsU < 25) return interaction.reply({ content: `You need **25 kills** with each of: Judgement Hall Dust Sans (${killsJ}/25) AND Underfell Sans (${killsU}/25).`, ephemeral: true });
    const target = jhalls[0];
    playerDB.removeItem(userId, 'dusty_fur_hood', 1);
    playerDB.removeItem(userId, 'chains', 1);
    playerDB.removeCharacter(userId, target.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'dustfell_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"Smells like ashes doesn't it kid?"*\n\nYour JHall Dust descended into ${shiny ? '**✦ SHINY ✦** ' : ''}**Dustfell Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // ============================================================
  // === END UPDATE 13 USE HANDLERS ===
  // ============================================================

  // ============================================================
  // === UPDATE 14/15 PRE-EXISTING USE HANDLERS (from U15 FINAL) ===
  // ============================================================

  if (action === 'inevitability_use') {
    if (!playerDB.hasItem(userId, 'inevitability', 1)) return interaction.reply({ content: 'You need an **Inevitability** (craft it first).', ephemeral: true });
    const p = playerDB.getPlayer(userId);
    const requiredDT = 8750;
    if ((p?.determination || 0) < requiredDT) return interaction.reply({ content: `You need **${requiredDT} Determination**! You have ${(p?.determination||0)}.`, ephemeral: true });
    if ((p?.soul_essence || 0) < 11890) return interaction.reply({ content: `You need **11890 Soul Essence**! You have ${p?.soul_essence||0}. (It will be wasted.)`, ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const sans = chars.find(c => c.character_id === 'sans' && getLevelFromExp(c.exp || 0) >= 5 && !c.locked);
    if (!sans) return interaction.reply({ content: 'You need an unlocked **Lv5 Sans**!', ephemeral: true });
    playerDB.removeItem(userId, 'inevitability', 1);
    p.determination -= requiredDT;
    p.soul_essence -= 11890;
    playerDB.removeCharacter(userId, sans.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'tears_in_the_rain_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `Your Sans became ${shiny ? '**✦ SHINY ✦** ' : ''}**Tears in the Rain Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  if (action === 'dustswap_papyrus_use') {
    if (!playerDB.hasItem(userId, 'cigarette_pack', 1)) return interaction.reply({ content: 'You need a **Cigarette Pack**.', ephemeral: true });
    if (!playerDB.hasItem(userId, 'stolen_monster_magic', 1)) return interaction.reply({ content: 'You need **Stolen Monster Magic** (craft it).', ephemeral: true });
    const team = playerDB.getTeam(userId);
    const hasJHall = team.some(t => t.character_id === 'judgement_hall_dust_sans' && getLevelFromExp(t.exp || 0) >= 5);
    if (!hasJHall) return interaction.reply({ content: 'You need a **Lv5 Judgement Hall Dust Sans** on your team!', ephemeral: true });
    playerDB.removeItem(userId, 'cigarette_pack', 1);
    playerDB.removeItem(userId, 'stolen_monster_magic', 1);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'dustswap_papyrus', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `You received ${shiny ? '**✦ SHINY ✦** ' : ''}**Dustswap Papyrus**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  if (action === 'dustshift_use') {
    if (!playerDB.hasItem(userId, 'real_knife', 10)) return interaction.reply({ content: 'You need **10 Real Knives**.', ephemeral: true });
    if (!playerDB.hasItem(userId, 'vines', 20)) return interaction.reply({ content: 'You need **20 Vines**.', ephemeral: true });
    const team = playerDB.getTeam(userId);
    const hasDsP = team.some(t => t.character_id === 'dustswap_papyrus' && getLevelFromExp(t.exp || 0) >= 5);
    const hasJHall = team.some(t => t.character_id === 'judgement_hall_dust_sans' && getLevelFromExp(t.exp || 0) >= 5);
    if (!hasDsP) return interaction.reply({ content: 'You need a **Lv5 Dustswap Papyrus** on your team!', ephemeral: true });
    if (!hasJHall) return interaction.reply({ content: 'You need a **Lv5 Judgement Hall Dust Sans** on your team!', ephemeral: true });
    playerDB.removeItem(userId, 'real_knife', 10);
    playerDB.removeItem(userId, 'vines', 20);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'dustshift', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `You received ${shiny ? '**✦ SHINY ✦** ' : ''}**Dustshift**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  if (action === 'flame_eye_use') {
    if (!playerDB.hasItem(userId, 'flame_eye_item', 1)) return interaction.reply({ content: 'You need the **Flame Eye** item (earn via BROKEN LIMITS achievement).', ephemeral: true });
    const p = playerDB.getPlayer(userId);
    if ((p?.determination || 0) < 20000) return interaction.reply({ content: `You need **20000 Determination**! You have ${(p?.determination||0)}.`, ephemeral: true });
    if ((p?.soul_essence || 0) < 10000) return interaction.reply({ content: `You need **10000 Soul Essence**! You have ${p?.soul_essence||0}.`, ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const jhalls = chars.filter(c => c.character_id === 'judgement_hall_dust_sans' && getLevelFromExp(c.exp || 0) >= 5 && !c.locked);
    if (jhalls.length < 3) return interaction.reply({ content: `You need **3 unlocked Lv5 Judgement Hall Dust Sans**! You have ${jhalls.length}.`, ephemeral: true });
    playerDB.removeItem(userId, 'flame_eye_item', 1);
    p.determination -= 20000;
    p.soul_essence -= 10000;
    for (let i = 0; i < 3; i++) playerDB.removeCharacter(userId, jhalls[i].id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'flame_eye', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"The limit is broken..."*\n\nThree JHall Dusts merged into ${shiny ? '**✦ SHINY ✦** ' : ''}**Flame Eye**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // ============================================================
  // === END UPDATE 14/15 PRE-EXISTING USE HANDLERS ===

  // ============================================================
  // === UPDATE 15 USE HANDLERS ===
  // ============================================================

  // Determination Soul → Frisk (guaranteed)
  if (action === 'determination_soul_use') {
    if (!playerDB.hasItem(userId, 'determination_soul', 1)) return interaction.reply({ content: 'You don\'t have a **Determination Soul**! Craft one with 7 DT Souls.', ephemeral: true });
    playerDB.removeItem(userId, 'determination_soul', 1);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'frisk', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `Your soul filled with **DETERMINATION**...\n\nYou received a ${shiny ? '**✦ SHINY ✦** ' : ''}**Frisk**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Real Knife on Frisk → Chara (1/1 — Real Knife always works on Frisk per spec)
  if (action === 'real_knife_use_15') {
    if (!playerDB.hasItem(userId, 'real_knife', 1)) return interaction.reply({ content: 'You don\'t have a **Real Knife**! It\'s a 1/99 drop from any boss/encounter.', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const friskChar = chars.find(c => c.character_id === 'frisk' && !c.locked);
    if (!friskChar) return interaction.reply({ content: 'You need an unlocked **Frisk** to use the Real Knife on!', ephemeral: true });
    playerDB.removeItem(userId, 'real_knife', 1);
    playerDB.removeCharacter(userId, friskChar.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'chara', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"hee hee hee i am chara the evils"*\n\nYour Frisk became ${shiny ? '**✦ SHINY ✦** ' : ''}**Chara**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Lethal Deal on Chara → No More Deals Chara (16.66%, refunds Chara on fail)
  if (action === 'lethal_deal_use_15') {
    if (!playerDB.hasItem(userId, 'lethal_deal', 1)) return interaction.reply({ content: 'You don\'t have a **Lethal Deal**! Get one from `/scavenge`.', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const charaChar = chars.find(c => c.character_id === 'chara' && !c.locked);
    if (!charaChar) return interaction.reply({ content: 'You need an unlocked **Chara**!', ephemeral: true });
    playerDB.removeItem(userId, 'lethal_deal', 1);
    if (Math.random() < 0.1666) {
      playerDB.removeCharacter(userId, charaChar.id);
      const shiny = rollShiny();
      const nc = playerDB.addCharacter(userId, 'no_more_deals_chara', 0, shiny);
      const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
      return interaction.reply({ content: `*The deal becomes lethal...*\n\nYour Chara became ${shiny ? '**✦ SHINY ✦** ' : ''}**No More Deals Chara**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
    } else {
      return interaction.reply({ content: `The Lethal Deal didn't take... but your **Chara** was refunded.` });
    }
  }

  // Portable CORE on Frisk → Core Frisk
  if (action === 'portable_core_use') {
    if (!playerDB.hasItem(userId, 'portable_core', 1)) return interaction.reply({ content: 'You don\'t have a **Portable CORE**! Craft one first.', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const friskChar = chars.find(c => c.character_id === 'frisk' && !c.locked);
    if (!friskChar) return interaction.reply({ content: 'You need an unlocked **Frisk**!', ephemeral: true });
    playerDB.removeItem(userId, 'portable_core', 1);
    playerDB.removeCharacter(userId, friskChar.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'core_frisk', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `Lost in the CORE...\n\nYour Frisk became ${shiny ? '**✦ SHINY ✦** ' : ''}**Core Frisk**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Kris' Sword → Kris
  if (action === 'kris_sword_use') {
    if (!playerDB.hasItem(userId, 'kris_sword', 1)) return interaction.reply({ content: 'You don\'t have **Kris\' Sword**! Get one from Epic Gacha (7%).', ephemeral: true });
    playerDB.removeItem(userId, 'kris_sword', 1);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'kris', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"Don't forget. You're the one with the controller."*\n\nYou received ${shiny ? '**✦ SHINY ✦** ' : ''}**Kris**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Susie's Axe → Susie
  if (action === 'susies_axe_use') {
    if (!playerDB.hasItem(userId, 'susies_axe', 1)) return interaction.reply({ content: 'You don\'t have **Susie\'s Axe**! Get one from Epic Gacha (7%).', ephemeral: true });
    playerDB.removeItem(userId, 'susies_axe', 1);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'susie', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"I'll take the lead."*\n\nYou received ${shiny ? '**✦ SHINY ✦** ' : ''}**Susie**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Comically Long Blunt → Ralsei
  if (action === 'comically_long_blunt_use') {
    if (!playerDB.hasItem(userId, 'comically_long_blunt', 1)) return interaction.reply({ content: 'You don\'t have a **Comically Long Blunt**! Get one from Epic Gacha (7%).', ephemeral: true });
    playerDB.removeItem(userId, 'comically_long_blunt', 1);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'ralsei', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `Hands you a fluffy boy...\n\nYou received ${shiny ? '**✦ SHINY ✦** ' : ''}**Ralsei**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Empowered Kindness Soul → Rose
  if (action === 'empowered_kindness_use') {
    if (!playerDB.hasItem(userId, 'empowered_kindness_soul', 1)) return interaction.reply({ content: 'You don\'t have an **Empowered Kindness Soul**! Craft one (requires C!Insanity form in team).', ephemeral: true });
    playerDB.removeItem(userId, 'empowered_kindness_soul', 1);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'rose', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `wgat.\n\nYou received ${shiny ? '**✦ SHINY ✦** ' : ''}**Rose**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Empty Gun + Cowboy Hat → Clover
  if (action === 'clover_use') {
    if (!playerDB.hasItem(userId, 'empty_gun', 1) || !playerDB.hasItem(userId, 'cowboy_hat', 1)) {
      return interaction.reply({ content: 'You need both an **Empty Gun** AND a **Cowboy Hat**!', ephemeral: true });
    }
    playerDB.removeItem(userId, 'empty_gun', 1);
    playerDB.removeItem(userId, 'cowboy_hat', 1);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'clover', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*A justice-themed cowboy emerges...*\n\nYou received ${shiny ? '**✦ SHINY ✦** ' : ''}**Clover**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Frosty Antlers → Noelle
  if (action === 'frosty_antlers_use') {
    if (!playerDB.hasItem(userId, 'frosty_antlers', 1)) return interaction.reply({ content: 'You don\'t have **Frosty Antlers**! Get them from Epic Gacha (7%).', ephemeral: true });
    playerDB.removeItem(userId, 'frosty_antlers', 1);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'noelle', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*A timid deer with frost-touched antlers...*\n\nYou received ${shiny ? '**✦ SHINY ✦** ' : ''}**Noelle**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Thorn Ring → Noelle (Snowgrave) — needs Lv2 Noelle + Lv2 Kris in party
  if (action === 'thorn_ring_use') {
    if (!playerDB.hasItem(userId, 'thorn_ring', 1)) return interaction.reply({ content: 'You don\'t have a **Thorn Ring**! Craft one with 25 Thorns.', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const noelleChar = chars.find(c => c.character_id === 'noelle' && !c.locked && getLevelFromExp(c.exp || 0) >= 2);
    if (!noelleChar) return interaction.reply({ content: 'You need an unlocked **Lv2+ Noelle**!', ephemeral: true });
    const team = playerDB.getTeam(userId);
    const teamChars = team.map(id => chars.find(c => c.id === id)).filter(Boolean);
    const krisOnTeam = teamChars.find(c => c.character_id === 'kris' && getLevelFromExp(c.exp || 0) >= 2);
    if (!krisOnTeam) return interaction.reply({ content: 'You need a **Lv2+ Kris** on your team!', ephemeral: true });
    playerDB.removeItem(userId, 'thorn_ring', 1);
    playerDB.removeCharacter(userId, noelleChar.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'noelle_snowgrave', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"That's not... the... ThornRing, is it...?"*\n\nYour Noelle became ${shiny ? '**✦ SHINY ✦** ' : ''}**Noelle (Snowgrave)**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // 👀 → Togore Dreemurr
  if (action === 'eye_item_use') {
    if (!playerDB.hasItem(userId, 'eye_item', 1)) return interaction.reply({ content: 'You don\'t have **👀**! Get it from Legendary Gacha (10%).', ephemeral: true });
    playerDB.removeItem(userId, 'eye_item', 1);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'togore_dreemurr', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*Togoretastic!*\n\nYou received ${shiny ? '**✦ SHINY ✦** ' : ''}**Torgore Dreemurr**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // VHS Tape on Sans → Sans?
  if (action === 'vhs_tape_use') {
    if (!playerDB.hasItem(userId, 'vhs_tape', 1)) return interaction.reply({ content: 'You don\'t have a **VHS Tape**! Beat the Sans? boss to get one.', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const sans = chars.find(c => c.character_id === 'sans' && !c.locked);
    if (!sans) return interaction.reply({ content: 'You need an unlocked **Sans**!', ephemeral: true });
    playerDB.removeItem(userId, 'vhs_tape', 1);
    playerDB.removeCharacter(userId, sans.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'sans_question', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*Something's off about this Sans...*\n\nYour Sans became ${shiny ? '**✦ SHINY ✦** ' : ''}**Sans?**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Stolen Slash on Sans? → YOUR FAULT (25%)
  if (action === 'stolen_slash_use') {
    if (!playerDB.hasItem(userId, 'stolen_slash', 1)) return interaction.reply({ content: 'You don\'t have **Stolen Slash**! Get one from Sans? boss (25%).', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const sansQ = chars.find(c => c.character_id === 'sans_question' && !c.locked);
    if (!sansQ) return interaction.reply({ content: 'You need an unlocked **Sans?**!', ephemeral: true });
    playerDB.removeItem(userId, 'stolen_slash', 1);
    if (Math.random() < 0.25) {
      playerDB.removeCharacter(userId, sansQ.id);
      const shiny = rollShiny();
      const nc = playerDB.addCharacter(userId, 'your_fault', 0, shiny);
      const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
      return interaction.reply({ content: `*Something corrupts...*\n\nYour Sans? became ${shiny ? '**✦ SHINY ✦** ' : ''}**YOUR FAULT**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
    } else {
      return interaction.reply({ content: `The Stolen Slash didn't corrupt enough... your **Sans?** is still here.` });
    }
  }

  // Administrator Permissions on YOUR FAULT → YOUR INNER TORMENT (66.66%)
  if (action === 'admin_perms_use') {
    if (!playerDB.hasItem(userId, 'administrator_permissions', 1)) return interaction.reply({ content: 'You don\'t have **Administrator Permissions**! Get them from Sans? boss (6.66%).', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const yf = chars.find(c => c.character_id === 'your_fault' && !c.locked);
    if (!yf) return interaction.reply({ content: 'You need an unlocked **YOUR FAULT**!', ephemeral: true });
    playerDB.removeItem(userId, 'administrator_permissions', 1);
    if (Math.random() < 0.6666) {
      playerDB.removeCharacter(userId, yf.id);
      const shiny = rollShiny();
      const nc = playerDB.addCharacter(userId, 'your_inner_torment', 0, shiny);
      const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
      return interaction.reply({ content: `*STOP HIDING BEHIND THAT VESSEL.*\n\nYour YOUR FAULT became ${shiny ? '**✦ SHINY ✦** ' : ''}**YOUR INNER TORMENT**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
    } else {
      return interaction.reply({ content: `The Admin Permissions didn't take... your **YOUR FAULT** is still here.` });
    }
  }

  // ============================================================
  // === END UPDATE 15 USE HANDLERS ===
  // ============================================================

  // ============================================================
  // === UPDATE 17 USE HANDLERS ===
  // ============================================================

  // Positive Apple + Positive Staff on Lv5 Sans → Dream Sans (+25k SE)
  if (action === 'positive_apple_use') {
    if (!playerDB.hasItem(userId, 'positive_apple', 1)) return interaction.reply({ content: 'You don\'t have a **Positive Apple**! Craft one from Corrupt Apple + Positive Essence + 20k DT.', ephemeral: true });
    if (!playerDB.hasItem(userId, 'positive_staff', 1)) return interaction.reply({ content: 'You also need a **Positive Staff**! Get one from /scavenge (1/20).', ephemeral: true });
    const p = playerDB.getPlayer(userId);
    if ((p.soul_essence || 0) < 25000) return interaction.reply({ content: `Need **25,000 Soul Essence**! You have ${p.soul_essence || 0}.`, ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const sans = chars.find(c => c.character_id === 'sans' && !c.locked && getLevelFromExp(c.exp) >= 5);
    if (!sans) return interaction.reply({ content: 'You need an unlocked **Lv5 Sans**!', ephemeral: true });
    playerDB.removeItem(userId, 'positive_apple', 1);
    playerDB.removeItem(userId, 'positive_staff', 1);
    playerDB.addSoulEssence(userId, -25000);
    playerDB.removeCharacter(userId, sans.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'dream_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*The guardian of positive...*\n\nYour Sans became ${shiny ? '**✦ SHINY ✦** ' : ''}**Dream Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // TRUE Negative Essence on Sans → Nightmare Sans (needs Killer/Horror/JHall Dust on team)
  if (action === 'true_negative_essence_use') {
    if (!playerDB.hasItem(userId, 'true_negative_essence', 1)) return interaction.reply({ content: 'You don\'t have **TRUE Negative Essence**! Craft from 6 Negative Essence + 2 Killer\'s Soul + 1 Corrupt Apple + 35k DT.', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const sans = chars.find(c => c.character_id === 'sans' && !c.locked);
    if (!sans) return interaction.reply({ content: 'You need an unlocked **Sans**!', ephemeral: true });
    const team = playerDB.getTeam(userId);
    const teamCharIds = team.map(t => t.character_id);
    const hasRequired = teamCharIds.includes('killer_sans') || teamCharIds.includes('horror_sans') || teamCharIds.includes('judgement_hall_dust_sans');
    if (!hasRequired) return interaction.reply({ content: 'You need **Killer Sans**, **Horror Sans**, or **JHall Dust Sans** on your team!', ephemeral: true });
    playerDB.removeItem(userId, 'true_negative_essence', 1);
    playerDB.removeCharacter(userId, sans.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'nightmare_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*The guardian of negative...*\n\nYour Sans became ${shiny ? '**✦ SHINY ✦** ' : ''}**Nightmare Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // AfterDust info — redirect to /fuse
  if (action === 'afterdust_use') {
    return interaction.reply({ content: '🔀 **AfterDust!Sans** is a fusion!\n\nUse `/fuse` with:\n• 2 **Lv5 Geno Sans**\n• 1 **Lv5 Judgement Hall Dust Sans**\n• 1 **Lv5 Sans**\n• 1 **Glitched Star** (from FatalError boss or /scavenge)', ephemeral: true });
  }

  // Influenced Killer info — redirect to /fuse
  if (action === 'influenced_killer_use') {
    return interaction.reply({ content: '🔪 **Influenced Killer Sans** is a fusion!\n\nUse `/fuse` with:\n• 1 **Killer Sans**\n• 1 **No More Deals Chara**\n• 2 **Killer\'s Soul** (from Nightmare boss)', ephemeral: true });
  }

  // ============================================================
  // === UPDATE 18: NEW CHARACTER OBTAINMENT HANDLERS ===
  // ============================================================

  // Possession Sans — Strange Flower on Lv5 Sans
  if (action === 'strange_flower_use') {
    if (!playerDB.hasItem(userId, 'strange_flower', 1)) return interaction.reply({ content: 'You need a **Strange Flower**! Craft it from 25 Vines, 15 Thorns, 10 Hatred, 5 The Flower, 1 Save Star.', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const sans = chars.find(c => c.character_id === 'sans' && getLevelFromExp(c.exp || 0) >= 5 && !c.locked);
    if (!sans) return interaction.reply({ content: 'You need an unlocked **Lv5 Sans**!', ephemeral: true });
    playerDB.removeItem(userId, 'strange_flower', 1);
    playerDB.removeCharacter(userId, sans.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'possession_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*The strange flower wraps itself around Sans...*\n\nYour Sans became ${shiny ? '**✦ SHINY ✦** ' : ''}**Possession Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Sudden Changes — 15 A Gun + 10 Coffee Mug + 10000 DT on a Mafiatale Sans
  if (action === 'sudden_changes_use') {
    if (!playerDB.hasItem(userId, 'a_gun', 15)) return interaction.reply({ content: 'You need **15 A Gun...?** items! Get them from `/scavenge`.', ephemeral: true });
    if (!playerDB.hasItem(userId, 'coffee_mug', 10)) return interaction.reply({ content: 'You need **10 Coffee Mugs**! Get them from `/scavenge` (20% chance).', ephemeral: true });
    const p = playerDB.getPlayer(userId);
    if ((p.determination || 0) < 10000) return interaction.reply({ content: `You need **10,000 Determination**! You have ${(p.determination || 0).toLocaleString()}.`, ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    // --- UPDATE 20 BUG FIX: only requires an unlocked Mafiatale Sans (no shiny / no second Mafia required) ---
    const mafia = chars.find(c => c.character_id === 'mafiatale_sans' && !c.locked);
    if (!mafia) return interaction.reply({ content: 'You need an unlocked **Mafiatale Sans**!', ephemeral: true });
    playerDB.removeItem(userId, 'a_gun', 15);
    playerDB.removeItem(userId, 'coffee_mug', 10);
    playerDB.addDetermination(userId, -10000);
    const wasShiny = mafia.shiny;
    playerDB.removeCharacter(userId, mafia.id);
    const shiny = wasShiny || rollShiny();
    const nc = playerDB.addCharacter(userId, 'sudden_changes', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*The final chamber clicks...*\n\nYour Mafiatale Sans became ${shiny ? '**✦ SHINY ✦** ' : ''}**Sudden Changes**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Lethal Deal — 5 Lethal Deal item + 2 T3 Soul + 1800 SE + 30 DT Vials on Killer Sans
  if (action === 'lethal_deal_use') {
    if (!playerDB.hasItem(userId, 'lethal_deal', 5)) return interaction.reply({ content: 'You need **5 Lethal Deal** items! Get them from `/scavenge`.', ephemeral: true });
    if (!playerDB.hasItem(userId, 'tier3_monster_soul', 2)) return interaction.reply({ content: 'You need **2 Tier 3 Monster Souls**!', ephemeral: true });
    if (!playerDB.hasItem(userId, 'dt_vial', 30)) return interaction.reply({ content: 'You need **30 DT Vials**!', ephemeral: true });
    const p2 = playerDB.getPlayer(userId);
    if ((p2.soul_essence || 0) < 1800) return interaction.reply({ content: `You need **1,800 Soul Essence**! You have ${p2.soul_essence || 0}.`, ephemeral: true });
    const chars2 = playerDB.getCharacters(userId);
    const killer = chars2.find(c => c.character_id === 'killer_sans' && !c.locked);
    if (!killer) return interaction.reply({ content: 'You need an unlocked **Killer Sans**!', ephemeral: true });
    playerDB.removeItem(userId, 'lethal_deal', 5);
    playerDB.removeItem(userId, 'tier3_monster_soul', 2);
    playerDB.removeItem(userId, 'dt_vial', 30);
    playerDB.addSoulEssence(userId, -1800);
    playerDB.removeCharacter(userId, killer.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'lethal_deal_char', 0, shiny);
    const ts2 = playerDB.getTeamSize(userId); if (ts2 < 6) playerDB.setTeamSlot(userId, ts2 + 1, nc.id);
    return interaction.reply({ content: `*"The deal has been done."*\n\nYour Killer Sans became ${shiny ? '**✦ SHINY ✦** ' : ''}**Lethal Deal**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // --- UPDATE 19 /use HANDLERS ---
  if (action === 'reapers_scythe_use') {
    if (!playerDB.hasItem(userId, 'reapers_scythe', 1)) return interaction.reply({ content: "You need a **💀 Reaper's Scythe**! Craft it from 5 Scythes + 30 Papyrus' Skulls + 15 Integrity Souls + 25,000 SE.", ephemeral: true });
    const pRS = playerDB.getPlayer(userId);
    const teamRS = playerDB.getTeam(userId);
    const hasAvenge = teamRS.some(t => t.character_id === 'avenge_sans');
    if (!hasAvenge) return interaction.reply({ content: '❌ You need **Avenge Sans** in your party!', ephemeral: true });
    const btKills = playerDB.getKillCount(userId, 'bad_time_sans');
    if (btKills < 50) return interaction.reply({ content: `❌ You need **50 Bad Time Sans boss kills**! You have **${btKills}**.`, ephemeral: true });
    const charsRS = playerDB.getCharacters(userId);
    const sans = charsRS.find(c => c.character_id === 'sans' && !c.locked);
    if (!sans) return interaction.reply({ content: '❌ You need an unlocked **Sans**!', ephemeral: true });
    playerDB.removeItem(userId, 'reapers_scythe', 1);
    playerDB.removeCharacter(userId, sans.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'reaper_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"All it takes is one touch, then you're dead."*\n\nYour Sans became ${shiny ? '**✦ SHINY ✦** ' : ''}**Reaper Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  if (action === 'green_sans_use') {
    if (!playerDB.hasItem(userId, 'lightsaber', 1)) return interaction.reply({ content: '❌ You need a **⚔️ Lightsaber**! Get one from `/scavenge` (7% chance).', ephemeral: true });
    if (!playerDB.hasItem(userId, 'happy_meal', 1)) return interaction.reply({ content: '❌ You need a **🍔 Happy Meal**! Craft it from all food items.', ephemeral: true });
    if (!playerDB.hasItem(userId, 'whatsapp_logo', 1)) return interaction.reply({ content: '❌ You need a **📱 Whatsapp Logo**! Get one from Epic Gacha (25% chance).', ephemeral: true });
    const charsGS = playerDB.getCharacters(userId);
    const sans = charsGS.find(c => c.character_id === 'sans' && !c.locked);
    if (!sans) return interaction.reply({ content: '❌ You need an unlocked **Sans**!', ephemeral: true });
    playerDB.removeItem(userId, 'lightsaber', 1);
    playerDB.removeItem(userId, 'happy_meal', 1);
    playerDB.removeItem(userId, 'whatsapp_logo', 1);
    playerDB.removeCharacter(userId, sans.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'green_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*oh hello freddy fazbear*\n\nYour Sans became ${shiny ? '**✦ SHINY ✦** ' : ''}**Green Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  if (action === 'seraphim_use') {
    if (!playerDB.hasItem(userId, 'seraphim_soul', 1)) return interaction.reply({ content: '❌ You need a **✨ Seraphim Soul**! Craft it from all 5 human soul weapons + Loaded Gun.', ephemeral: true });
    playerDB.removeItem(userId, 'seraphim_soul', 1);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'seraphim', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"A vessel that fused with the souls."*\n\nYou obtained ${shiny ? '**✦ SHINY ✦** ' : ''}**Seraphim**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  if (action === 'black_knife_use') {
    if (!playerDB.hasItem(userId, 'black_knife', 1)) return interaction.reply({ content: '❌ You need a **🗡️ Black Knife**! Craft it from 10 Black Shards + 3 Shadow Crystals + 1 Real Knife.', ephemeral: true });
    const pBK = playerDB.getPlayer(userId);
    if ((pBK.determination || 0) < 6500) return interaction.reply({ content: `❌ You need **6,500 Determination**! You have **${pBK.determination || 0}**.`, ephemeral: true });
    if ((pBK.soul_essence || 0) < 12500) return interaction.reply({ content: `❌ You need **12,500 Soul Essence**! You have **${pBK.soul_essence || 0}**. (SE is consumed)`, ephemeral: true });
    playerDB.removeItem(userId, 'black_knife', 1);
    playerDB.addDetermination(userId, -6500);
    playerDB.addSoulEssence(userId, -12500);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'roaring_knight', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"The Black Knife still shone, even in the dark."*\n\nObtained ${shiny ? '**✦ SHINY ✦** ' : ''}**The Roaring Knight**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.\n\n*It has found its place at character ID [rk_id].*` });
  }

  // --- UPDATE 20 OBTAINMENT HANDLERS ---

  if (action === 'finale_fuse_info') {
    return interaction.reply({ content: '💀 **Finale For The Bonely One** is a fusion!\n\nUse `/fuse` with:\n• Base: **Lv5 Sans**\n• **Ainavol**\n• **agem**\n• **2x Lv3+ Ainavolagem**\n• **10x Juice that gives you eyes** (in inventory, from /scavenge)', ephemeral: true });
  }

  // Pesti Sans: Rusted Metal Pipe on Sans
  if (action === 'pesti_sans_use') {
    if (!playerDB.hasItem(userId, 'rusted_metal_pipe', 1)) return interaction.reply({ content: 'You need a **🪈 Rusted Metal Pipe** (25% drop from the Pesti Sans superboss).', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const sans = chars.filter(c => c.character_id === 'sans' && !c.locked);
    if (sans.length === 0) return interaction.reply({ content: 'You need an unlocked **Sans**!', ephemeral: true });
    const target = sans[0];
    playerDB.removeItem(userId, 'rusted_metal_pipe', 1);
    playerDB.removeCharacter(userId, target.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'pesti_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"We all rust someday."*\n\nYour Sans corroded into ${shiny ? '**✦ SHINY ✦** ' : ''}**Pesti Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Pesto Sans: Pesto Sauce on Pesti Sans
  if (action === 'pesto_sans_use') {
    if (!playerDB.hasItem(userId, 'pesto_sauce', 1)) return interaction.reply({ content: 'You need **🌿 Pesto Sauce** (10% drop from the Papyrus boss).', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const pesti = chars.filter(c => c.character_id === 'pesti_sans' && !c.locked);
    if (pesti.length === 0) return interaction.reply({ content: 'You need an unlocked **Pesti Sans**!', ephemeral: true });
    const target = pesti[0];
    playerDB.removeItem(userId, 'pesto_sauce', 1);
    playerDB.removeCharacter(userId, target.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'pesto_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*Hmm this Pesto taste good.*\n\nYour Pesti Sans became ${shiny ? '**✦ SHINY ✦** ' : ''}**Pesto Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Negatale Sans: Tier 3 Monster Soul on Sans
  if (action === 'negatale_sans_use') {
    if (!playerDB.hasItem(userId, 'tier3_monster_soul', 1)) return interaction.reply({ content: 'You need a **💎 Tier 3 Monster Soul** (from the shop).', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const sans = chars.filter(c => c.character_id === 'sans' && !c.locked);
    if (sans.length === 0) return interaction.reply({ content: 'You need an unlocked **Sans**!', ephemeral: true });
    const target = sans[0];
    playerDB.removeItem(userId, 'tier3_monster_soul', 1);
    playerDB.removeCharacter(userId, target.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'negatale_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"Love for humans."*\n\nYour Sans became ${shiny ? '**✦ SHINY ✦** ' : ''}**Negatale Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Evan's Dust: my memories!! on Lv5 JHall Dust Sans (False Saviors Event)
  if (action === 'evans_dust_use') {
    if (!playerDB.hasItem(userId, 'my_memories_item', 1)) return interaction.reply({ content: 'You need **💭 my memories!!** (False Saviors Event).', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const jhall = chars.filter(c => c.character_id === 'judgement_hall_dust_sans' && getLevelFromExp(c.exp || 0) >= 5 && !c.locked);
    if (jhall.length === 0) return interaction.reply({ content: 'You need an unlocked **Lv5 Judgement Hall Dust Sans**!', ephemeral: true });
    const target = jhall[0];
    playerDB.removeItem(userId, 'my_memories_item', 1);
    playerDB.removeCharacter(userId, target.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'evans_dust', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"i forgor."*\n\nYour JHall Dust remembered everything and became ${shiny ? '**✦ SHINY ✦** ' : ''}**Dust!Tale: [Evan's]**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Fake!HyperDust: Hyper's Soul on Lv5 Evan's Dust (False Saviors Event)
  if (action === 'fake_hyperdust_use') {
    if (!playerDB.hasItem(userId, 'hypers_soul', 1)) return interaction.reply({ content: 'You need **👻 Hyper\'s Soul** (0.1% drop from killing any boss).', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const evans = chars.filter(c => c.character_id === 'evans_dust' && getLevelFromExp(c.exp || 0) >= 5 && !c.locked);
    if (evans.length === 0) return interaction.reply({ content: 'You need an unlocked **Lv5 Dust!Tale: [Evan\'s]**!', ephemeral: true });
    const target = evans[0];
    playerDB.removeItem(userId, 'hypers_soul', 1);
    playerDB.removeCharacter(userId, target.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'fake_hyperdust', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"faaaaake."*\n\nYour Evan's Dust twisted into ${shiny ? '**✦ SHINY ✦** ' : ''}**Fake!HyperDust**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Fake!DustDust: Hatred on Fake!HyperDust (False Saviors Event)
  if (action === 'fake_dustdust_use') {
    if (!playerDB.hasItem(userId, 'hatred', 1)) return interaction.reply({ content: 'You need **Hatred.** to use on Fake!HyperDust.', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const fhd = chars.filter(c => c.character_id === 'fake_hyperdust' && !c.locked);
    if (fhd.length === 0) return interaction.reply({ content: 'You need an unlocked **Fake!HyperDust**!', ephemeral: true });
    const target = fhd[0];
    playerDB.removeItem(userId, 'hatred', 1);
    playerDB.removeCharacter(userId, target.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'fake_dustdust', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"what."*\n\nHatred consumed your Fake!HyperDust — it became ${shiny ? '**✦ SHINY ✦** ' : ''}**Fake!DustDust**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // --- UPDATE 20: ENLIGHTENED QUESTLINE EVOLUTION STEPS ---
  // Each step requires the matching boss to have been killed with the matching Enlightened dust active.

  // Step 2: Stolen Flames on Enlightened Sans → Enlightened Ruins Dust (must have killed Toriel with Enlightened Sans)
  if (action === 'enlightened_ruins_use') {
    if (playerDB.getBossKillByChar(userId, 'toriel') !== 'enlightened_sans') return interaction.reply({ content: 'You must deal the **final blow to Toriel** with **Enlightened Sans** as your active character first!', ephemeral: true });
    if (!playerDB.hasItem(userId, 'stolen_flames', 1)) return interaction.reply({ content: 'You need **Stolen Flames** (from Toriel)!', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const es = chars.find(c => c.character_id === 'enlightened_sans' && !c.locked);
    if (!es) return interaction.reply({ content: 'You need an unlocked **Enlightened Sans**!', ephemeral: true });
    playerDB.removeItem(userId, 'stolen_flames', 1);
    playerDB.removeCharacter(userId, es.id);
    playerDB.clearBossKillByChar(userId, 'toriel');
    const nc = playerDB.addCharacter(userId, 'enlightened_ruins_dust_sans', 0, false);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The Stolen Flames engulf Enlightened Sans...\n\nTransformed into **Enlightened Ruins Dust Sans**!\nCharacter ID: **${nc.id}**.` });
  }

  // Step 3: Papyrus' Scarf on Enlightened Ruins Dust → Enlightened Snowdin Dust (must have killed Papyrus with Enlightened Ruins Dust)
  if (action === 'enlightened_snowdin_use') {
    if (playerDB.getBossKillByChar(userId, 'papyrus') !== 'enlightened_ruins_dust_sans') return interaction.reply({ content: 'You must deal the **final blow to Papyrus** with **Enlightened Ruins Dust Sans** active first!', ephemeral: true });
    if (!playerDB.hasItem(userId, 'papyrus_scarf', 1)) return interaction.reply({ content: "You need **Papyrus' Scarf** (from Papyrus)!", ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const er = chars.find(c => c.character_id === 'enlightened_ruins_dust_sans' && !c.locked);
    if (!er) return interaction.reply({ content: 'You need an unlocked **Enlightened Ruins Dust Sans**!', ephemeral: true });
    playerDB.removeItem(userId, 'papyrus_scarf', 1);
    playerDB.removeCharacter(userId, er.id);
    playerDB.clearBossKillByChar(userId, 'papyrus');
    const nc = playerDB.addCharacter(userId, 'enlightened_snowdin_dust_sans', 0, false);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `Papyrus' Scarf wraps around Enlightened Ruins Dust...\n\nTransformed into **Enlightened Snowdin Dust Sans**!\nCharacter ID: **${nc.id}**.` });
  }

  // Step 4: Spear on Enlightened Snowdin Dust → Enlightened Waterfall Dust (must have killed Undyne with Enlightened Snowdin Dust)
  if (action === 'enlightened_waterfall_use') {
    if (playerDB.getBossKillByChar(userId, 'undyne') !== 'enlightened_snowdin_dust_sans') return interaction.reply({ content: 'You must deal the **final blow to Undyne** with **Enlightened Snowdin Dust Sans** active first!', ephemeral: true });
    if (!playerDB.hasItem(userId, 'spear', 1)) return interaction.reply({ content: 'You need a **Spear** (from Undyne)!', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const es = chars.find(c => c.character_id === 'enlightened_snowdin_dust_sans' && !c.locked);
    if (!es) return interaction.reply({ content: 'You need an unlocked **Enlightened Snowdin Dust Sans**!', ephemeral: true });
    playerDB.removeItem(userId, 'spear', 1);
    playerDB.removeCharacter(userId, es.id);
    playerDB.clearBossKillByChar(userId, 'undyne');
    const nc = playerDB.addCharacter(userId, 'enlightened_waterfall_dust_sans', 0, false);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The Spear merges with Enlightened Snowdin Dust...\n\nTransformed into **Enlightened Waterfall Dust Sans**!\nCharacter ID: **${nc.id}**.` });
  }

  // Step 5: Neo Cannon on Enlightened Waterfall Dust → Enlightened Hotlands Dust (must have killed Mettaton NEO with Enlightened Waterfall Dust)
  if (action === 'enlightened_hotlands_use') {
    if (playerDB.getBossKillByChar(userId, 'mettaton_neo') !== 'enlightened_waterfall_dust_sans') return interaction.reply({ content: 'You must deal the **final blow to Mettaton NEO** with **Enlightened Waterfall Dust Sans** active first!', ephemeral: true });
    if (!playerDB.hasItem(userId, 'neo_cannon', 1)) return interaction.reply({ content: 'You need a **Neo Cannon** (from Mettaton NEO)!', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const ew = chars.find(c => c.character_id === 'enlightened_waterfall_dust_sans' && !c.locked);
    if (!ew) return interaction.reply({ content: 'You need an unlocked **Enlightened Waterfall Dust Sans**!', ephemeral: true });
    playerDB.removeItem(userId, 'neo_cannon', 1);
    playerDB.removeCharacter(userId, ew.id);
    playerDB.clearBossKillByChar(userId, 'mettaton_neo');
    const nc = playerDB.addCharacter(userId, 'enlightened_hotlands_dust_sans', 0, false);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The mechanical power awakens...\n\nYour Enlightened Waterfall Dust became **Enlightened Hotlands Dust Sans**!\nCharacter ID: **${nc.id}**.` });
  }

  // Step 6: Empty Gun on Enlightened Hotlands Dust → Enlightened Core Dust (must have killed Mettaton NEO with Enlightened Hotlands Dust)
  if (action === 'enlightened_core_use') {
    if (playerDB.getBossKillByChar(userId, 'mettaton_neo') !== 'enlightened_hotlands_dust_sans') return interaction.reply({ content: 'You must deal the **final blow to Mettaton NEO** with **Enlightened Hotlands Dust Sans** active first!', ephemeral: true });
    if (!playerDB.hasItem(userId, 'empty_gun', 1)) return interaction.reply({ content: 'You need an **Empty Gun** (from Mettaton NEO)!', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const eh = chars.find(c => c.character_id === 'enlightened_hotlands_dust_sans' && !c.locked);
    if (!eh) return interaction.reply({ content: 'You need an unlocked **Enlightened Hotlands Dust Sans**!', ephemeral: true });
    playerDB.removeItem(userId, 'empty_gun', 1);
    playerDB.removeCharacter(userId, eh.id);
    playerDB.clearBossKillByChar(userId, 'mettaton_neo');
    const nc = playerDB.addCharacter(userId, 'enlightened_core_dust_sans', 0, false);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The CORE pulses...\n\nYour Enlightened Hotlands Dust transformed into **Enlightened Core Dust Sans**!\nCharacter ID: **${nc.id}**.` });
  }

  // Step 7: Stolen Monster Magic + 1k SE on Lv5 Enlightened Core Dust → Enlightened JHall Dust (must have killed Asgore with Enlightened Core Dust)
  if (action === 'enlightened_jhall_use') {
    if (playerDB.getBossKillByChar(userId, 'asgore') !== 'enlightened_core_dust_sans') return interaction.reply({ content: 'You must deal the **final blow to Asgore** with **Enlightened Core Dust Sans** active first!', ephemeral: true });
    if (!playerDB.hasItem(userId, 'stolen_monster_magic', 1)) return interaction.reply({ content: 'You need **Stolen Monster Magic** (craft from all boss drops)!', ephemeral: true });
    const player = playerDB.getPlayer(userId);
    if ((player.soul_essence || 0) < 1000) return interaction.reply({ content: 'You need **1,000 Soul Essence**!', ephemeral: true });
    const chars = playerDB.getCharacters(userId);
    const ec = chars.find(c => c.character_id === 'enlightened_core_dust_sans' && getLevelFromExp(c.exp || 0) >= 5 && !c.locked);
    if (!ec) return interaction.reply({ content: 'You need an unlocked **Lv5 Enlightened Core Dust Sans**!', ephemeral: true });
    playerDB.removeItem(userId, 'stolen_monster_magic', 1);
    playerDB.addSoulEssence(userId, -1000);
    playerDB.removeCharacter(userId, ec.id);
    playerDB.clearBossKillByChar(userId, 'asgore');
    const nc = playerDB.addCharacter(userId, 'enlightened_judgement_hall_dust_sans', 0, false);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*The final judgement, enlightened.*\n\nYour Enlightened Core Dust ascended to **Enlightened Judgement Hall Dust Sans**!\nCharacter ID: **${nc.id}**.\n\n*Now sacrifice it with /sacrifice to obtain your memories...*` });
  }

  return interaction.reply({ content: "That item can't be used this way.", ephemeral: true });
}

// --- UPDATE 19: /saveteam and /loadteam ---
async function cmdSaveTeam(interaction) {
  const userId = interaction.user.id; playerDB.ensurePlayer(userId);
  const name = interaction.options.getString('name').slice(0, 20).trim();
  if (!name) return interaction.reply({ content: '❌ Team name cannot be empty!', ephemeral: true });
  const team = playerDB.getTeam(userId);
  if (team.length === 0) return interaction.reply({ content: '❌ Your team is empty! Set a team first with `/setteam`.', ephemeral: true });
  const result = playerDB.saveTeam(userId, name);
  if (!result.success) return interaction.reply({ content: `❌ ${result.reason}`, ephemeral: true });
  const teamNames = team.map(t => CHARACTERS[t.character_id]?.name || t.character_id).join(', ');
  return interaction.reply({ content: `✅ Saved team **"${name}"** with: ${teamNames}\n\nLoad it anytime with \`/loadteam ${name}\``, ephemeral: true });
}

async function cmdLoadTeam(interaction) {
  const userId = interaction.user.id; playerDB.ensurePlayer(userId);
  const name = interaction.options.getString('name').trim();
  const result = playerDB.loadTeam(userId, name);
  if (!result.success) return interaction.reply({ content: `❌ ${result.reason}`, ephemeral: true });
  const team = playerDB.getTeam(userId);
  const teamNames = team.map(t => CHARACTERS[t.character_id]?.name || t.character_id).join(', ');
  const missingMsg = result.missing > 0 ? `\n⚠️ **${result.missing}** character(s) from the saved team no longer exist and were skipped.` : '';
  return interaction.reply({ content: `✅ Loaded team **"${name}"** (${result.loaded} characters): ${teamNames}${missingMsg}`, ephemeral: true });
}

// --- STORY MODE: launch a real battle for the current story fight beat ---
async function cmdStoryBattleBegin(interaction) {
  const userId = interaction.user.id;
  playerDB.ensurePlayer(userId);

  const enc = story.getStoryEncounter(userId);
  if (!enc) return interaction.reply({ content: 'There\'s no story battle to start right now. Run `/story`.', ephemeral: true });

  if (activeBattles.has(userId)) return interaction.reply({ content: 'You\'re already in a battle!', ephemeral: true });

  const team = playerDB.getTeam(userId);
  if (team.length === 0) return interaction.reply({ content: 'Your team is empty! Use `/setteam` first, then press Begin Battle again.', ephemeral: true });

  const teamData = buildTeamData(team, userId);
  if (teamData.length === 0) return interaction.reply({ content: 'Error loading team.', ephemeral: true });

  const battle = new Battle(teamData, enc, userId);
  battle.enemyId = enc.id;
  if (enc.isBoss) battle.isBoss = true;
  battle.storyContext = { vol: 1 };
  battle.teamDbIds = teamData.map(t => t.dbId);
  activeBattles.set(userId, battle);

  const state = battle.getBattleState();
  const tag = enc.isBoss ? '☠️ **STORY BOSS!**' : '⚔️ **Story Battle**';
  return interaction.update({ content: `${tag} **${enc.name}** stands in your way!`, embeds: [embeds.battleState(state)], components: embeds.abilityButtons(state) });
}

// --- /boss ---
async function cmdBoss(interaction) {
  const userId = interaction.user.id;
  playerDB.ensurePlayer(userId);
  if (activeBattles.has(userId)) return interaction.reply({ content: 'You\'re already in a battle!', ephemeral: true });

  const team = playerDB.getTeam(userId);
  if (team.length === 0) return interaction.reply({ content: 'Your team is empty! Use `/setteam` first.', ephemeral: true });

  const bossId = interaction.options.getString('boss');
  const bossData = BOSSES[bossId];
  if (!bossData) return interaction.reply({ content: 'Unknown boss!', ephemeral: true });

  // --- SCAMPTON EVENT: all 3 ChromaKey Pieces required (kept, never consumed) ---
  if (bossId === 'scamton_the_great') {
    const missing = scamtonMissingPieces(userId);
    if (missing.length > 0) {
      const names = missing.map(m => `${ITEMS[m].emoji} **${ITEMS[m].name}**`).join(', ');
      return interaction.reply({ content: `🔒 The cell won't open. You still need: ${names}.\n*ChromaKey Pieces are permanent — you only ever need them once.*`, ephemeral: true });
    }
  }

  // UPDATE 34 GALACTIC EVENT: the two galactic bosses take a Galactic Ticket
  // instead of an Event Boss Ticket. Every other event boss is unchanged.
  if (bossData.isGalacticEvent) {
    if (!playerDB.hasItem(userId, 'galactic_ticket', 1)) return interaction.reply({ content: 'You need a **🌌 Galactic Ticket** to fight this boss! Buy one from `/shop` (5,000 Determination + 500 Soul Essence).', ephemeral: true });
    playerDB.removeItem(userId, 'galactic_ticket', 1);
  } else if (bossData.isEvent) {
    if (!playerDB.hasItem(userId, 'event_boss_ticket', 1)) return interaction.reply({ content: 'You need an **🎟️ Event Boss Ticket** to fight this boss! Buy one from `/shop`.', ephemeral: true });
    playerDB.removeItem(userId, 'event_boss_ticket', 1);
  }

  // --- SCAMPTON EVENT: your team is taken from you and replaced ---
  let teamData;
  if (bossData.fixedParty) {
    teamData = bossData.fixedParty.map((cid, i) => ({ ...CHARACTERS[cid], level: 5, exp: 999999, shiny: false, equipped: null, dbId: `fixed_${cid}_${i}` }));
  } else {
    teamData = buildTeamData(team, userId);
  }
  if (teamData.length === 0) return interaction.reply({ content: 'Error loading team.', ephemeral: true });

  const battle = new Battle(teamData, bossData, userId);
  battle.enemyId = bossId;
  battle.isBoss = true;
  battle.teamDbIds = bossData.fixedParty ? [] : teamData.map(t => t.dbId);
  activeBattles.set(userId, battle);

  // --- SCAMPTON EVENT: pre-fight dialog before the first turn ---
  if (bossId === 'scamton_the_great') {
    battle.scamtonDialog = 0;
    return interaction.reply({
      embeds: [{ color: 0xff0033, title: 'SCAMPTON [[THE GREAT]]', description: SCAMTON_PRE_DIALOG[0] }],
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('scamton_dialog').setLabel('Continue').setStyle(ButtonStyle.Primary))],
    });
  }

  const state = battle.getBattleState();
  return interaction.reply({ content: `**BOSS BATTLE!** **${bossData.name}** appears!`, embeds: [embeds.battleState(state)], components: embeds.abilityButtons(state) });
}

// --- UPDATE 20: /superboss ---
async function cmdSuperboss(interaction) {
  const userId = interaction.user.id;
  playerDB.ensurePlayer(userId);
  if (activeBattles.has(userId)) return interaction.reply({ content: 'You\'re already in a battle!', ephemeral: true });

  const team = playerDB.getTeam(userId);
  if (team.length === 0) return interaction.reply({ content: 'Your team is empty! Use `/setteam` first.', ephemeral: true });

  const bossId = interaction.options.getString('boss');
  const bossData = BOSSES[bossId];
  if (!bossData || !bossData.isSuperboss) return interaction.reply({ content: 'Unknown superboss!', ephemeral: true });

  // --- 20 minute client-side cooldown (only set on WIN) ---
  const COOLDOWN_MS = 20 * 60 * 1000;
  const last = superbossCooldowns.get(userId) || 0;
  const now = Date.now();
  if (now - last < COOLDOWN_MS) {
    const remaining = Math.ceil((COOLDOWN_MS - (now - last)) / 60000);
    return interaction.reply({ content: `⏳ The superboss is recovering from your last victory! Try again in **~${remaining} minute(s)**.`, ephemeral: true });
  }

  // Requires an Event Boss Ticket
  if (!playerDB.hasItem(userId, 'event_boss_ticket', 1)) return interaction.reply({ content: 'You need an **🎟️ Event Boss Ticket** to fight a superboss! Buy one from `/shop`.', ephemeral: true });
  playerDB.removeItem(userId, 'event_boss_ticket', 1);

  const teamData = buildTeamData(team, userId);
  if (teamData.length === 0) return interaction.reply({ content: 'Error loading team.', ephemeral: true });

  const battle = new Battle(teamData, bossData, userId);
  battle.enemyId = bossId;
  battle.isBoss = true;
  battle.isSuperboss = true;
  battle.teamDbIds = teamData.map(t => t.dbId);
  activeBattles.set(userId, battle);

  const state = battle.getBattleState();
  return interaction.reply({ content: `**☠️ SUPERBOSS BATTLE! ☠️** **${bossData.name}** descends... prepare for your imminent DOOM!`, embeds: [embeds.battleState(state)], components: embeds.abilityButtons(state) });
}

// --- UPDATE 20: /sacrifice ---
async function cmdSacrifice(interaction) {
  const userId = interaction.user.id;
  playerDB.ensurePlayer(userId);
  const target = interaction.options.getString('target');

  // DUSTBEEF BUT IN SNOWS: /sacrifice on Snowdin Dust Sans (Lv5 Papyrus on team, costs 1.1k DT). Papyrus becomes Snowbelief.
  if (target === 'dustbeef') {
    const chars = playerDB.getCharacters(userId);
    const snowdin = chars.find(c => c.character_id === 'snowdin_dust_sans' && !c.locked);
    if (!snowdin) return interaction.reply({ content: 'You need an unlocked **Snowdin Dust Sans** to sacrifice!', ephemeral: true });
    const team = playerDB.getTeam(userId);
    const pap = team.find(t => t.character_id === 'papyrus_char' && getLevelFromExp(t.exp || 0) >= 5);
    if (!pap) return interaction.reply({ content: 'You need a **Lv5 Papyrus** on your team!', ephemeral: true });
    const p = playerDB.getPlayer(userId);
    if ((p.determination || 0) < 1100) return interaction.reply({ content: `You need **1,100 Determination**! You have ${(p.determination || 0).toLocaleString()}.`, ephemeral: true });
    playerDB.addDetermination(userId, -1100);
    playerDB.removeCharacter(userId, snowdin.id);
    // Papyrus becomes Snowbelief
    playerDB.removeCharacter(userId, pap.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'dustbeef_but_in_snows', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"he seems shocked by something."*\n\nYou sacrificed **Snowdin Dust Sans** on the snow. Your Papyrus became **Snowbelief**, and from the snow rose ${shiny ? '**✦ SHINY ✦** ' : ''}**DUSTBEEF BUT IN SNOWS**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // EVAN'S DUST sacrifice → Broken Soul Shard (False Saviors Event)
  if (target === 'evans_dust') {
    const chars = playerDB.getCharacters(userId);
    const evans = chars.find(c => c.character_id === 'evans_dust' && !c.locked);
    if (!evans) return interaction.reply({ content: 'You need an unlocked **Dust!Tale: [Evan\'s]** to sacrifice!', ephemeral: true });
    playerDB.removeCharacter(userId, evans.id);
    playerDB.addItem(userId, 'broken_soul_shard', 1);
    return interaction.reply({ content: `*The dust scatters...*\n\nYou sacrificed **Dust!Tale: [Evan's]** and received a **💔 Broken Soul Shard**.` });
  }

  // --- UPDATE 20: ENLIGHTENED QUESTLINE ---
  // Step 1: sacrifice normal JHall Dust → Enlightened Sans (the "reset")
  if (target === 'enlightened_sans') {
    const chars = playerDB.getCharacters(userId);
    const jhall = chars.find(c => c.character_id === 'judgement_hall_dust_sans' && !c.locked);
    if (!jhall) return interaction.reply({ content: 'You need an unlocked **Judgement Hall Dust Sans** to sacrifice!', ephemeral: true });
    playerDB.removeCharacter(userId, jhall.id);
    const nc = playerDB.addCharacter(userId, 'enlightened_sans', 0, false); // never shiny
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*Everything resets...*\n\nYou sacrificed **Judgement Hall Dust Sans**. From the reset rose **Enlightened Sans**.\nCharacter ID: **${nc.id}**.\n\n*The journey to remember begins again.*` });
  }

  // Final step: sacrifice Enlightened JHall Dust → my memories!! item
  if (target === 'my_memories') {
    const chars = playerDB.getCharacters(userId);
    const ejhall = chars.find(c => c.character_id === 'enlightened_judgement_hall_dust_sans' && !c.locked);
    if (!ejhall) return interaction.reply({ content: 'You need an unlocked **Enlightened Judgement Hall Dust Sans** to sacrifice!', ephemeral: true });
    playerDB.removeCharacter(userId, ejhall.id);
    playerDB.addItem(userId, 'my_memories_item', 1);
    return interaction.reply({ content: `*Once and for all, the dust settles.*\n\nYou sacrificed **Enlightened Judgement Hall Dust Sans** and finally obtained **💭 my memories!!**\n\n*Now you remember.*` });
  }

  return interaction.reply({ content: 'Unknown sacrifice target.', ephemeral: true });
}

async function cmdFuse(interaction) {
  const userId = interaction.user.id; playerDB.ensurePlayer(userId);
  const baseId = interaction.options.getInteger('base');
  const fuserIds = [
    interaction.options.getInteger('fuse1'),
    interaction.options.getInteger('fuse2'),
    interaction.options.getInteger('fuse3'),
    interaction.options.getInteger('fuse4'),
    interaction.options.getInteger('fuse5'),
  ].filter(Boolean);

  const chars = playerDB.getCharacters(userId);
  const getChar = (id) => chars.find(c => c.id === id);
  const fuserChars = fuserIds.map(id => getChar(id)).filter(Boolean);
  const fuserHasChar = (charId) => fuserChars.some(c => c.character_id === charId);

  // --- UPDATE 31 — SIXBONES: fuse Papyrus/? with Sans after beating Bad Time Sans using Papyrus/? ---
  if (!baseId && fuserHasChar('papyrus_q') && fuserHasChar('sans')) {
    if (playerDB.getBossKillByChar(userId, 'bad_time_sans') !== 'papyrus_q') {
      return interaction.reply({ content: 'You must deal the **final blow to Bad Time Sans** with **Papyrus/?** as your active character first!', ephemeral: true });
    }
    const pq = fuserChars.find(c => c.character_id === 'papyrus_q');
    const sn = fuserChars.find(c => c.character_id === 'sans');
    if (pq.locked || sn.locked) return interaction.reply({ content: 'Both fusers must be **unlocked**!', ephemeral: true });
    playerDB.removeCharacter(userId, pq.id);
    playerDB.removeCharacter(userId, sn.id);
    playerDB.clearBossKillByChar(userId, 'bad_time_sans');
    const nc = playerDB.addCharacter(userId, 'sixbones', 0, false);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*six of them. all of them hurt.*\n\n**Papyrus/?** and **Sans** collapse into each other. You obtained **S̷I̸X̶B̷O̶N̵E̸S̷**!\nCharacter ID: **${nc.id}**.` });
  }

  // --- TIME PARADOX: no base needed, just Ainavol + Agem + Broken Clock in inventory ---
  if (!baseId && fuserHasChar('ainavol') && fuserHasChar('agem')) {
    if (!playerDB.hasItem(userId, 'broken_clock', 1)) {
      return interaction.reply({ content: 'You need a **🕰️ Broken Clock** in your inventory to fuse Time Paradox!', ephemeral: true });
    }
    const ainavol = fuserChars.find(c => c.character_id === 'ainavol');
    const agem = fuserChars.find(c => c.character_id === 'agem');
    if (ainavol.locked) return interaction.reply({ content: '🔒 Your **Ainavol** is locked!', ephemeral: true });
    if (agem.locked) return interaction.reply({ content: '🔒 Your **agem** is locked!', ephemeral: true });
    playerDB.removeItem(userId, 'broken_clock', 1);
    playerDB.removeCharacter(userId, ainavol.id);
    playerDB.removeCharacter(userId, agem.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'time_paradox', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `The Broken Clock fractures reality...\n\n**Ainavol** and **agem** fused with the clock into ${shiny ? '**✦ SHINY ✦** ' : ''}**Time Paradox**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // --- UV SWAP SANS: no base needed, 3x Underswap Sans + 1x Underswap Papyrus + Blue Bone ---
  if (!baseId) {
    const swapSansFusers = fuserChars.filter(c => c.character_id === 'underswap_sans');
    const underswapPapFuser = fuserChars.find(c => c.character_id === 'underswap_papyrus');
    if (swapSansFusers.length >= 3 && underswapPapFuser) {
      if (!playerDB.hasItem(userId, 'blue_bone', 1)) {
        return interaction.reply({ content: 'You need a **🦴 Blue Bone** in your inventory to fuse UV Swap Sans! Get one from the Legendary Gacha.', ephemeral: true });
      }
      for (const c of swapSansFusers) { if (c.locked) return interaction.reply({ content: `🔒 Underswap Sans [ID: ${c.id}] is locked! Use \`/unlock\` first.`, ephemeral: true }); }
      if (underswapPapFuser.locked) return interaction.reply({ content: `🔒 Your Underswap Papyrus is locked! Use \`/unlock\` first.`, ephemeral: true });
      for (let i = 0; i < 3; i++) playerDB.removeCharacter(userId, swapSansFusers[i].id);
      playerDB.removeCharacter(userId, underswapPapFuser.id);
      playerDB.removeItem(userId, 'blue_bone', 1);
      const shiny = rollShiny();
      const nc = playerDB.addCharacter(userId, 'uv_swap_sans', 0, shiny);
      const ts = playerDB.getTeamSize(userId);
      if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
      return interaction.reply({ content: `*"I'll make sure to get that cocky smile off your face."*\n\n**3x Underswap Sans** and **Underswap Papyrus** fused with the Blue Bone into ${shiny ? '**✦ SHINY ✦** ' : ''}**UV Swap Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
    }
    // --- UPDATE 17: INFLUENCED KILLER — Killer Sans + No More Deals Chara + 2 Killer's Soul ---
    const killer17 = fuserChars.find(c => c.character_id === 'killer_sans');
    const nmd17 = fuserChars.find(c => c.character_id === 'no_more_deals_chara');
    if (killer17 && nmd17) {
      if (!playerDB.hasItem(userId, 'killers_soul', 2)) return interaction.reply({ content: 'You need **2x Killer\'s Soul** in your inventory to fuse Influenced Killer Sans!', ephemeral: true });
      if (killer17.locked) return interaction.reply({ content: '🔒 Your **Killer Sans** is locked!', ephemeral: true });
      if (nmd17.locked) return interaction.reply({ content: '🔒 Your **No More Deals Chara** is locked!', ephemeral: true });
      playerDB.removeCharacter(userId, killer17.id);
      playerDB.removeCharacter(userId, nmd17.id);
      playerDB.removeItem(userId, 'killers_soul', 2);
      const shiny = rollShiny();
      const nc = playerDB.addCharacter(userId, 'influenced_killer_sans', 0, shiny);
      const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
      return interaction.reply({ content: `*An upgraded version of Killer Sans...*\n\n**Killer Sans** and **No More Deals Chara** fused with **2x Killer's Soul** into ${shiny ? '**✦ SHINY ✦** ' : ''}**Influenced Killer Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
    }
    // --- UPDATE 30: LOWTIERFELL!SANS — 3x Lv5 Underfell Sans + 3 Chains + 1 Save Star ---
    const ufFusers = fuserChars.filter(c => c.character_id === 'underfell_sans');
    if (ufFusers.length >= 3) {
      const lv5 = ufFusers.filter(c => getLevelFromExp(c.exp || 0) >= 5);
      if (lv5.length < 3) return interaction.reply({ content: 'You need **3x Underfell Sans at Level 5** to fuse LowTierFell!Sans!', ephemeral: true });
      if (!playerDB.hasItem(userId, 'chains', 3)) return interaction.reply({ content: 'You need **3x ⛓️ Chains** to fuse LowTierFell!Sans!', ephemeral: true });
      if (!playerDB.hasItem(userId, 'save_star', 1)) return interaction.reply({ content: 'You need **1x 💫 Save Star** to fuse LowTierFell!Sans!', ephemeral: true });
      for (const c of lv5.slice(0, 3)) { if (c.locked) return interaction.reply({ content: `🔒 Underfell Sans [ID: ${c.id}] is locked! Use \`/unlock\` first.`, ephemeral: true }); }
      for (let i = 0; i < 3; i++) playerDB.removeCharacter(userId, lv5[i].id);
      playerDB.removeItem(userId, 'chains', 3);
      playerDB.removeItem(userId, 'save_star', 1);
      const shiny = rollShiny();
      const nc = playerDB.addCharacter(userId, 'lowtierfell_sans', 0, shiny);
      const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
      return interaction.reply({ content: `*"your life, IS NOTHING! you serve ZERO PURPOSE!"*\n\n**3x Lv5 Underfell Sans** fused with **3 Chains** and a **Save Star** into ${shiny ? '**✦ SHINY ✦** ' : ''}**LowTierFell!Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
    }
    // --- UPDATE 30: STORYSPIN SANS — Sans + Chara + Baseball Bat (20% success, else all destroyed) ---
    const ssSans = fuserChars.find(c => c.character_id === 'sans');
    const ssChara = fuserChars.find(c => c.character_id === 'chara');
    if (ssSans && ssChara) {
      if (!playerDB.hasItem(userId, 'baseball_bat', 1)) return interaction.reply({ content: 'You need a **🏏 Baseball Bat** to attempt the Storyspin Sans fusion!', ephemeral: true });
      if (ssSans.locked) return interaction.reply({ content: '🔒 Your **Sans** is locked! Use `/unlock` first.', ephemeral: true });
      if (ssChara.locked) return interaction.reply({ content: '🔒 Your **Chara** is locked! Use `/unlock` first.', ephemeral: true });
      playerDB.removeCharacter(userId, ssSans.id);
      playerDB.removeCharacter(userId, ssChara.id);
      playerDB.removeItem(userId, 'baseball_bat', 1);
      if (Math.random() < 0.20) {
        const shiny = rollShiny();
        const nc = playerDB.addCharacter(userId, 'storyspin_sans', 0, shiny);
        const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
        return interaction.reply({ content: `*"Now I'm the one in control."*\n\n🎯 The fuse **SUCCEEDED** (20%)! **Sans** + **Chara** + **Baseball Bat** became ${shiny ? '**✦ SHINY ✦** ' : ''}**Storyspin Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
      }
      return interaction.reply({ content: `💥 The Storyspin fuse **FAILED** (80% chance)! **Sans**, **Chara**, and the **Baseball Bat** were all destroyed...` });
    }
    return interaction.reply({ content: 'No valid baseless fusion recipe found!\n\n• **Time Paradox**: Ainavol + agem + Broken Clock\n• **UV Swap Sans**: 3x Underswap Sans + 1x Underswap Papyrus + Blue Bone\n• **Influenced Killer Sans**: Killer Sans + No More Deals Chara + 2x Killer\'s Soul', ephemeral: true });
  }

  // --- AINAVOLAGEM: base = waterfall_dust_sans, fusers = ainavol + agem ---
  const baseChar = getChar(baseId);
  if (!baseChar) return interaction.reply({ content: `You don't own a character with ID **${baseId}**!`, ephemeral: true });
  if (baseChar.locked) return interaction.reply({ content: `🔒 Character ID **${baseId}** is locked! Use \`/unlock\` first.`, ephemeral: true });

  if (baseChar.character_id === 'waterfall_dust_sans' && fuserHasChar('ainavol') && fuserHasChar('agem')) {
    const ainavol = fuserChars.find(c => c.character_id === 'ainavol');
    const agem = fuserChars.find(c => c.character_id === 'agem');
    if (ainavol.locked) return interaction.reply({ content: '🔒 Your **Ainavol** is locked!', ephemeral: true });
    if (agem.locked) return interaction.reply({ content: '🔒 Your **agem** is locked!', ephemeral: true });
    playerDB.removeCharacter(userId, baseChar.id);
    playerDB.removeCharacter(userId, ainavol.id);
    playerDB.removeCharacter(userId, agem.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'ainavolagem', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `Two timelines collide into one...\n\n**Waterfall Dust Sans**, **Ainavol**, and **agem** fused into ${shiny ? '**✦ SHINY ✦** ' : ''}**Ainavolagem**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // --- UPDATE 14: CATASTROPHE!FELL — base = underfell_sans, fusers = ainavol + agem + ainavolagem ---
  if (baseChar.character_id === 'underfell_sans' && fuserHasChar('ainavol') && fuserHasChar('agem') && fuserHasChar('ainavolagem')) {
    const ainavol = fuserChars.find(c => c.character_id === 'ainavol');
    const agem = fuserChars.find(c => c.character_id === 'agem');
    const ainavolagem = fuserChars.find(c => c.character_id === 'ainavolagem');
    if (ainavol.locked) return interaction.reply({ content: '🔒 Your **Ainavol** is locked!', ephemeral: true });
    if (agem.locked) return interaction.reply({ content: '🔒 Your **agem** is locked!', ephemeral: true });
    if (ainavolagem.locked) return interaction.reply({ content: '🔒 Your **Ainavolagem** is locked!', ephemeral: true });
    playerDB.removeCharacter(userId, baseChar.id);
    playerDB.removeCharacter(userId, ainavol.id);
    playerDB.removeCharacter(userId, agem.id);
    playerDB.removeCharacter(userId, ainavolagem.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'catastrophe_fell', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"If I'm dying here... YOU ARE COMING WITH ME!"*\n\n**Underfell Sans**, **Ainavol**, **agem**, and **Ainavolagem** combust into ${shiny ? '**✦ SHINY ✦** ' : ''}**CATASTROPHE!FELL**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // --- UPDATE 20: FINALE FOR THE BONELY ONE (FFTBO) ---
  // base = Lv5 Sans, fusers = ainavol + agem + 2x Lv3+ Ainavolagem, + 10 Juice that gives you eyes
  if (baseChar.character_id === 'sans' && fuserHasChar('ainavol') && fuserHasChar('agem')) {
    const ainavolagems = fuserChars.filter(c => c.character_id === 'ainavolagem' && getLevelFromExp(c.exp || 0) >= 3);
    if (ainavolagems.length >= 2) {
      if (getLevelFromExp(baseChar.exp || 0) < 5) return interaction.reply({ content: 'The base **Sans** must be **Lv5** for Finale For The Bonely One!', ephemeral: true });
      if (!playerDB.hasItem(userId, 'juice_eyes', 10)) return interaction.reply({ content: 'You need **10x 👁️ Juice that gives you eyes** in your inventory to fuse Finale For The Bonely One! Get them from `/scavenge`.', ephemeral: true });
      const ainavol = fuserChars.find(c => c.character_id === 'ainavol');
      const agem = fuserChars.find(c => c.character_id === 'agem');
      if (ainavol.locked) return interaction.reply({ content: '🔒 Your **Ainavol** is locked!', ephemeral: true });
      if (agem.locked) return interaction.reply({ content: '🔒 Your **agem** is locked!', ephemeral: true });
      for (const c of ainavolagems.slice(0, 2)) { if (c.locked) return interaction.reply({ content: `🔒 Ainavolagem [ID: ${c.id}] is locked! Use \`/unlock\` first.`, ephemeral: true }); }
      playerDB.removeCharacter(userId, baseChar.id);
      playerDB.removeCharacter(userId, ainavol.id);
      playerDB.removeCharacter(userId, agem.id);
      playerDB.removeCharacter(userId, ainavolagems[0].id);
      playerDB.removeCharacter(userId, ainavolagems[1].id);
      playerDB.removeItem(userId, 'juice_eyes', 10);
      const shiny = rollShiny();
      const nc = playerDB.addCharacter(userId, 'finale_for_the_bonely_one', 0, shiny);
      const ts = playerDB.getTeamSize(userId);
      if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
      return interaction.reply({ content: `*"this will be my finale for the- wait, IM NOT MY V3 HELP WHY DO I HAVE MORE THAN 2 EYES AAAAAAAAA-"*\n\n**Sans**, **Ainavol**, **agem**, and **2x Ainavolagem** fused with **10 Juice that gives you eyes** into ${shiny ? '**✦ SHINY ✦** ' : ''}**Finale For The Bonely One**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
    }
  }

  // --- UV SWAP SANS: 3x Underswap Sans + 1x Underswap Papyrus + Blue Bone in inventory ---
  const swapSansFusers = fuserChars.filter(c => c.character_id === 'underswap_sans');
  const underswapPapFuser = fuserChars.find(c => c.character_id === 'underswap_papyrus');
  if (swapSansFusers.length >= 3 && underswapPapFuser) {
    if (!playerDB.hasItem(userId, 'blue_bone', 1)) {
      return interaction.reply({ content: 'You need a **🦴 Blue Bone** in your inventory to fuse UV Swap Sans! Get one from the Legendary Gacha.', ephemeral: true });
    }
    for (const c of swapSansFusers) { if (c.locked) return interaction.reply({ content: `🔒 Underswap Sans [ID: ${c.id}] is locked! Use \`/unlock\` first.`, ephemeral: true }); }
    if (underswapPapFuser.locked) return interaction.reply({ content: `🔒 Your Underswap Papyrus is locked! Use \`/unlock\` first.`, ephemeral: true });
    // Consume 3 Swap Sanses, 1 Underswap Papyrus, 1 Blue Bone
    for (let i = 0; i < 3; i++) playerDB.removeCharacter(userId, swapSansFusers[i].id);
    playerDB.removeCharacter(userId, underswapPapFuser.id);
    playerDB.removeItem(userId, 'blue_bone', 1);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'uv_swap_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"I'll make sure to get that cocky smile off your face."*\n\n**3x Underswap Sans** and **Underswap Papyrus** fused with the Blue Bone into ${shiny ? '**✦ SHINY ✦** ' : ''}**UV Swap Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // --- C!INSAITY: base = c_insanity_weak, requires Axe of a Thousand Souls + 2,500 DT + 5,000 SE + 1,000 DT Vials ---
  if (baseChar.character_id === 'c_insanity_weak') {
    if (!playerDB.hasItem(userId, 'axe_thousand_souls', 1)) return interaction.reply({ content: 'You need an **🪓 Axe of a Thousand Souls** to fuse C!Insanity!', ephemeral: true });
    const player = playerDB.getPlayer(userId);
    if ((player.determination || 0) < 2500) return interaction.reply({ content: `Not enough **Determination**! Need 2,500, have ${(player.determination || 0).toLocaleString()}.`, ephemeral: true });
    if ((player.soul_essence || 0) < 5000) return interaction.reply({ content: `Not enough **Soul Essence**! Need 5,000, have ${(player.soul_essence || 0).toLocaleString()}.`, ephemeral: true });
    if (!playerDB.hasItem(userId, 'dt_vial', 1000)) return interaction.reply({ content: `Not enough **DT Vials**! Need 1,000.`, ephemeral: true });
    playerDB.removeCharacter(userId, baseChar.id);
    playerDB.removeItem(userId, 'axe_thousand_souls', 1);
    playerDB.removeItem(userId, 'dt_vial', 1000);
    playerDB.addDetermination(userId, -2500);
    playerDB.addSoulEssence(userId, -5000);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'c_insanity', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"You touch Rose, and I'll split your head in two, human!"*\n\nThe Axe of a Thousand Souls fuses with Weak C!Insanity into ${shiny ? '**✦ SHINY ✦** ' : ''}**C!Insanity**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // --- UPDATE 30: PAPYRUS BELIEF — base Papyrus + 100 Papyrus Scarfs + 20 Papyrus Skulls + 5 Sans Jackets ---
  if (baseChar.character_id === 'papyrus') {
    if (!playerDB.hasItem(userId, 'papyrus_scarf', 100)) return interaction.reply({ content: 'You need **100 🧣 Papyrus Scarfs** to fuse Papyrus Belief!', ephemeral: true });
    if (!playerDB.hasItem(userId, 'papyrus_skull', 20)) return interaction.reply({ content: 'You need **20 💀 Papyrus Skulls** to fuse Papyrus Belief!', ephemeral: true });
    if (!playerDB.hasItem(userId, 'sans_jacket', 5)) return interaction.reply({ content: 'You need **5 🧥 Sans Jackets** to fuse Papyrus Belief!', ephemeral: true });
    playerDB.removeCharacter(userId, baseChar.id);
    playerDB.removeItem(userId, 'papyrus_scarf', 100);
    playerDB.removeItem(userId, 'papyrus_skull', 20);
    playerDB.removeItem(userId, 'sans_jacket', 5);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'papyrus_belief', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"...through Different Means! Wish me good luck!!"*\n\n**Papyrus** settled the feud and became ${shiny ? '**✦ SHINY ✦** ' : ''}**Papyrus Belief**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // --- AVENGE SANS: base = weak_avenge_sans, requires Blade + 6k DT + 12k SE + 3 Integrity Souls + C!Insanity on team ---
  if (baseChar.character_id === 'weak_avenge_sans') {
    if (!playerDB.hasItem(userId, 'blade_omniverse', 1)) return interaction.reply({ content: 'You need a **⚔️ Blade of the Omniverse** to fuse Avenge Sans!', ephemeral: true });
    if (!playerDB.hasItem(userId, 'integrity_soul', 3)) return interaction.reply({ content: 'You need **3 💙 Integrity Souls** to fuse Avenge Sans!', ephemeral: true });
    const player = playerDB.getPlayer(userId);
    if ((player.determination || 0) < 6000) return interaction.reply({ content: `Not enough **Determination**! Need 6,000, have ${(player.determination || 0).toLocaleString()}.`, ephemeral: true });
    if ((player.soul_essence || 0) < 12000) return interaction.reply({ content: `Not enough **Soul Essence**! Need 12,000, have ${(player.soul_essence || 0).toLocaleString()}.`, ephemeral: true });
    // Check for any form of C!Insanity on team
    const team = playerDB.getTeam(userId);
    const hasCInsanity = team.some(t => t.character_id === 'c_insanity_weak' || t.character_id === 'c_insanity' || t.character_id === 'final_insanity');
    if (!hasCInsanity) return interaction.reply({ content: 'You need **any form of C!Insanity** on your team to fuse Avenge Sans!', ephemeral: true });
    playerDB.removeCharacter(userId, baseChar.id);
    playerDB.removeItem(userId, 'blade_omniverse', 1);
    playerDB.removeItem(userId, 'integrity_soul', 3);
    playerDB.addDetermination(userId, -6000);
    playerDB.addSoulEssence(userId, -12000);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'avenge_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"Awwww what's the matter now? What, you gonna cry?"*\n\nThe Blade of the Omniverse awakens Weak Avenge into ${shiny ? '**✦ SHINY ✦** ' : ''}**Avenge Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // --- FINAL INSANITY: base = c_insanity, requires Axe of a Hundred Thousand + 10k DT + 20k SE + 5k DT Vials + Shattered Kindness + Avenge Sans on team ---
  if (baseChar.character_id === 'c_insanity') {
    if (!playerDB.hasItem(userId, 'axe_hundred_thousand_souls', 1)) return interaction.reply({ content: 'You need an **🪓 Axe of a Hundred Thousand Souls** to fuse Final Insanity!', ephemeral: true });
    if (!playerDB.hasItem(userId, 'shattered_kindness_soul', 1)) return interaction.reply({ content: 'You need a **💚 Shattered Kindness Soul** to fuse Final Insanity!', ephemeral: true });
    const player = playerDB.getPlayer(userId);
    if ((player.determination || 0) < 10000) return interaction.reply({ content: `Not enough **Determination**! Need 10,000, have ${(player.determination || 0).toLocaleString()}.`, ephemeral: true });
    if ((player.soul_essence || 0) < 20000) return interaction.reply({ content: `Not enough **Soul Essence**! Need 20,000, have ${(player.soul_essence || 0).toLocaleString()}.`, ephemeral: true });
    if (!playerDB.hasItem(userId, 'dt_vial', 5000)) return interaction.reply({ content: `Not enough **DT Vials**! Need 5,000.`, ephemeral: true });
    // Check for Avenge Sans on team
    const team = playerDB.getTeam(userId);
    if (!team.some(t => t.character_id === 'avenge_sans')) return interaction.reply({ content: 'You need **Avenge Sans** on your team to fuse Final Insanity!', ephemeral: true });
    playerDB.removeCharacter(userId, baseChar.id);
    playerDB.removeItem(userId, 'axe_hundred_thousand_souls', 1);
    playerDB.removeItem(userId, 'shattered_kindness_soul', 1);
    playerDB.removeItem(userId, 'dt_vial', 5000);
    playerDB.addDetermination(userId, -10000);
    playerDB.addSoulEssence(userId, -20000);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'final_insanity', 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"NO! ROSE! WHAT HAVE YOU DONE?!"*\n\nThe Axe of a Hundred Thousand Souls and the Shattered Kindness Soul fuse with C!Insanity into ${shiny ? '**✦ SHINY ✦** ' : ''}**Final Insanity**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // --- UPDATE 14 FIX: CALL OF THE VOID SANS — accepts any slot for base/fusers
  {
    const allCotvChars = [...fuserChars, ...(baseChar ? [baseChar] : [])];
    const sansF = allCotvChars.find(c => c.character_id === 'sans' && getLevelFromExp(c.exp || 0) >= 5);
    const papF = allCotvChars.find(c => (c.character_id === 'papyrus' || c.character_id === 'papyrus_char') && getLevelFromExp(c.exp || 0) >= 5);
    const gasterF = allCotvChars.find(c => c.character_id === 'wd_gaster' && getLevelFromExp(c.exp || 0) >= 5);
    if (sansF && papF && gasterF) {
      if (!playerDB.hasItem(userId, 'void_tablet', 1)) {
        return interaction.reply({ content: 'You need a \u{1F4DC} Void Tablet in your inventory to fuse Call of the Void Sans!', ephemeral: true });
      }
      if (sansF.locked || papF.locked || gasterF.locked) {
        return interaction.reply({ content: '\uD83D\uDD12 One of the required characters is locked! Use `/unlock` first.', ephemeral: true });
      }
      playerDB.removeCharacter(userId, sansF.id);
      playerDB.removeCharacter(userId, papF.id);
      playerDB.removeCharacter(userId, gasterF.id);
      playerDB.removeItem(userId, 'void_tablet', 1);
      const shiny = rollShiny();
      const nc = playerDB.addCharacter(userId, 'call_of_the_void_sans', 0, shiny);
      const ts = playerDB.getTeamSize(userId);
      if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
      return interaction.reply({ content: `*"i'm not letting you go any further. no matter what it takes."*\n\nThe void tablet shatters as Sans, Papyrus, and Gaster merge into ${shiny ? '**\u2736 SHINY \u2736** ' : ''}**Call of the Void Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
    }
  }

  // --- UPDATE 15: SIX HUMAN BEERS — no base needed, fuse 6 Juice + 1 of each Human Soul (item-only fusion) ---
  if (!baseId && fuserChars.length === 0) {
    const requiredItems = {
      juice_eyes: 6,
      patience_human_soul: 1, bravery_human_soul: 1, integrity_human_soul: 1,
      perseverance_human_soul: 1, kindness_human_soul: 1, justice_human_soul: 1,
    };
    const hasAll = Object.entries(requiredItems).every(([id, n]) => playerDB.hasItem(userId, id, n));
    if (hasAll) {
      for (const [id, n] of Object.entries(requiredItems)) playerDB.removeItem(userId, id, n);
      playerDB.addItem(userId, 'six_human_beers', 1);
      return interaction.reply({ content: `*The Six Human Beers materialize...*\n\nYou received **🍻 The Six Human Beers**! Use it on Asgore for a 77.77% chance to get **Asgore Dreemurr**.` });
    }
  }

  // --- UPDATE 15: ASGORE DREEMURR — use Six Human Beers item on Asgore (treated as fusion since item is consumed and base char becomes new char) ---
  if (baseChar && baseChar.character_id === 'asgore') {
    if (!playerDB.hasItem(userId, 'six_human_beers', 1)) {
      // fall-through, not the right fusion
    } else {
      if (baseChar.locked) return interaction.reply({ content: '🔒 Your **Asgore** is locked!', ephemeral: true });
      playerDB.removeItem(userId, 'six_human_beers', 1);
      if (Math.random() < 0.7777) {
        playerDB.removeCharacter(userId, baseChar.id);
        const shiny = rollShiny();
        const nc = playerDB.addCharacter(userId, 'asgore_dreemurr', 0, shiny);
        const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
        return interaction.reply({ content: `*The King has had a few too many...*\n\nYour Asgore became ${shiny ? '**✦ SHINY ✦** ' : ''}**Asgore Dreemurr**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
      } else {
        return interaction.reply({ content: `The Six Human Beers spilled... your **Asgore** stays sober.` });
      }
    }
  }

  // ============================================================
  // === UPDATE 14/15 FUSIONS ===
  // ============================================================

  // Oceantale Papyrus — base = Oceantale Sans, fuser = Papyrus + 10 Tier 3 Monster Souls
  if (baseChar && baseChar.character_id === 'oceantale_sans' && fuserHasChar('papyrus_char') && playerDB.hasItem(userId, 'tier3_monster_soul', 10)) {
    const pap = fuserChars.find(c => c.character_id === 'papyrus_char');
    if (baseChar.locked) return interaction.reply({ content: '🔒 Your **Oceantale Sans** is locked!', ephemeral: true });
    if (pap.locked) return interaction.reply({ content: '🔒 Your **Papyrus** is locked!', ephemeral: true });
    playerDB.removeCharacter(userId, baseChar.id);
    playerDB.removeCharacter(userId, pap.id);
    playerDB.removeItem(userId, 'tier3_monster_soul', 10);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'oceantale_papyrus', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*NYEH HEH HEH! ALL ABOARD!*\n\n**Oceantale Sans**, **Papyrus**, and **10 Tier 3 Monster Souls** fuse into ${shiny ? '**✦ SHINY ✦** ' : ''}**Oceantale Papyrus**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // Dusttale Endgoal — base = Judgement Hall Dust Sans + 10 Real Knife + 10 Heart Locket + 1 Stolen Inventory Bag
  if (baseChar && baseChar.character_id === 'judgement_hall_dust_sans' && playerDB.hasItem(userId, 'real_knife', 10) && playerDB.hasItem(userId, 'heart_locket', 10) && playerDB.hasItem(userId, 'stolen_inventory_bag', 1)) {
    if (baseChar.locked) return interaction.reply({ content: '🔒 Your **Judgement Hall Dust Sans** is locked!', ephemeral: true });
    playerDB.removeCharacter(userId, baseChar.id);
    playerDB.removeItem(userId, 'real_knife', 10);
    playerDB.removeItem(userId, 'heart_locket', 10);
    playerDB.removeItem(userId, 'stolen_inventory_bag', 1);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'dusttale_endgoal', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"He's reached his ENDGOAL..."*\n\nThe knives, lockets, and stolen bag fuse Dust Sans into ${shiny ? '**✦ SHINY ✦** ' : ''}**Dusttale Endgoal: A Flawless Genocide**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // RK!Swap Papyrus — base = Last Breath, fusers = Underswap Papyrus + Underswap Sans + W.D. Gaster
  if (baseChar && baseChar.character_id === 'last_breath_sans' && fuserHasChar('underswap_papyrus') && fuserHasChar('underswap_sans') && fuserHasChar('wd_gaster')) {
    const usPap = fuserChars.find(c => c.character_id === 'underswap_papyrus');
    const usSans = fuserChars.find(c => c.character_id === 'underswap_sans');
    const gaster = fuserChars.find(c => c.character_id === 'wd_gaster');
    if (baseChar.locked) return interaction.reply({ content: '🔒 Your **Last Breath Sans** is locked!', ephemeral: true });
    if (usPap.locked) return interaction.reply({ content: '🔒 Your **Underswap Papyrus** is locked!', ephemeral: true });
    if (usSans.locked) return interaction.reply({ content: '🔒 Your **Underswap Sans** is locked!', ephemeral: true });
    if (gaster.locked) return interaction.reply({ content: '🔒 Your **W.D. Gaster** is locked!', ephemeral: true });
    playerDB.removeCharacter(userId, baseChar.id);
    playerDB.removeCharacter(userId, usPap.id);
    playerDB.removeCharacter(userId, usSans.id);
    playerDB.removeCharacter(userId, gaster.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'rk_swap_papyrus', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `Recalled Knowledge floods in...\n\nFour souls combine into ${shiny ? '**✦ SHINY ✦** ' : ''}**RK!Swap Papyrus**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // RK!Storyshift Chara — base = Storyshift Chara, fusers = Last Breath + W.D. Gaster
  if (baseChar && baseChar.character_id === 'storyshift_chara' && fuserHasChar('last_breath_sans') && fuserHasChar('wd_gaster')) {
    const lb = fuserChars.find(c => c.character_id === 'last_breath_sans');
    const gaster = fuserChars.find(c => c.character_id === 'wd_gaster');
    if (baseChar.locked) return interaction.reply({ content: '🔒 Your **Storyshift Chara** is locked!', ephemeral: true });
    if (lb.locked) return interaction.reply({ content: '🔒 Your **Last Breath Sans** is locked!', ephemeral: true });
    if (gaster.locked) return interaction.reply({ content: '🔒 Your **W.D. Gaster** is locked!', ephemeral: true });
    playerDB.removeCharacter(userId, baseChar.id);
    playerDB.removeCharacter(userId, lb.id);
    playerDB.removeCharacter(userId, gaster.id);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'rk_storyshift_chara', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `They remember every cut...\n\nThree souls fuse into ${shiny ? '**✦ SHINY ✦** ' : ''}**RK!Storyshift Chara**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // TS!Sans/Crossbones — base = Underswap Sans, fusers = Underswap Papyrus + Ketchup Gun item
  if (baseChar && baseChar.character_id === 'underswap_sans' && fuserHasChar('underswap_papyrus') && playerDB.hasItem(userId, 'ketchup_gun', 1)) {
    const usPap = fuserChars.find(c => c.character_id === 'underswap_papyrus');
    if (baseChar.locked) return interaction.reply({ content: '🔒 Your **Underswap Sans** is locked!', ephemeral: true });
    if (usPap.locked) return interaction.reply({ content: '🔒 Your **Underswap Papyrus** is locked!', ephemeral: true });
    playerDB.removeCharacter(userId, baseChar.id);
    playerDB.removeCharacter(userId, usPap.id);
    playerDB.removeItem(userId, 'ketchup_gun', 1);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'ts_sans', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*KEE HEE HEE!*\n\n**Underswap Sans**, **Underswap Papyrus**, and **Ketchup Gun** fuse into ${shiny ? '**✦ SHINY ✦** ' : ''}**TS!Sans/Crossbones**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // TS!Papyrus — base = TS!Sans, fusers = Underswap Papyrus + Cigarette Pack item
  if (baseChar && baseChar.character_id === 'ts_sans' && fuserHasChar('underswap_papyrus') && playerDB.hasItem(userId, 'cigarette_pack', 1)) {
    const usPap = fuserChars.find(c => c.character_id === 'underswap_papyrus');
    if (baseChar.locked) return interaction.reply({ content: '🔒 Your **TS!Sans** is locked!', ephemeral: true });
    if (usPap.locked) return interaction.reply({ content: '🔒 Your **Underswap Papyrus** is locked!', ephemeral: true });
    playerDB.removeCharacter(userId, baseChar.id);
    playerDB.removeCharacter(userId, usPap.id);
    playerDB.removeItem(userId, 'cigarette_pack', 1);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'ts_papyrus', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `**TS!Sans**, **Underswap Papyrus**, and a **Cigarette Pack** fuse into ${shiny ? '**✦ SHINY ✦** ' : ''}**TS!Papyrus**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // --- UPDATE 18: one left. — base = call_of_the_void_sans, 2x Lv5 Sans + 2x Lv5 Gaster as fusers, 3 Determination Souls + 2 Save Stars in inventory ---
  if (baseChar.character_id === 'call_of_the_void_sans') {
    const lv5SansFusers = fuserChars.filter(c => c.character_id === 'sans' && getLevelFromExp(c.exp || 0) >= 5);
    const lv5GasterFusers = fuserChars.filter(c => c.character_id === 'wd_gaster' && getLevelFromExp(c.exp || 0) >= 5);
    if (lv5SansFusers.length < 2) return interaction.reply({ content: 'You need **2 Lv5 Sans** as fusers!', ephemeral: true });
    if (lv5GasterFusers.length < 2) return interaction.reply({ content: 'You need **2 Lv5 W.D. Gaster** as fusers!', ephemeral: true });
    if (!playerDB.hasItem(userId, 'determination_soul', 3)) return interaction.reply({ content: 'You need **3 Determination Souls** in your inventory!', ephemeral: true });
    if (!playerDB.hasItem(userId, 'save_star', 2)) return interaction.reply({ content: 'You need **2 Save Stars** in your inventory!', ephemeral: true });
    for (const c of [...lv5SansFusers.slice(0, 2), ...lv5GasterFusers.slice(0, 2)]) {
      if (c.locked) return interaction.reply({ content: `🔒 **${CHARACTERS[c.character_id]?.name || c.character_id}** [ID: ${c.id}] is locked! Use \`/unlock\` first.`, ephemeral: true });
    }
    if (baseChar.locked) return interaction.reply({ content: `🔒 Your **Call of the Void Sans** is locked! Use \`/unlock\` first.`, ephemeral: true });
    playerDB.removeCharacter(userId, baseChar.id);
    playerDB.removeCharacter(userId, lv5SansFusers[0].id);
    playerDB.removeCharacter(userId, lv5SansFusers[1].id);
    playerDB.removeCharacter(userId, lv5GasterFusers[0].id);
    playerDB.removeCharacter(userId, lv5GasterFusers[1].id);
    playerDB.removeItem(userId, 'determination_soul', 3);
    playerDB.removeItem(userId, 'save_star', 2);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, 'one_left', 0, shiny);
    const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    return interaction.reply({ content: `*"heh heh heh..you're gonna have ONE HELL of a bad time, kiddo."*\n\nThe souls converge...\n\n${shiny ? '**✦ SHINY ✦** ' : ''}**one left.** has been born!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
  }

  // --- UPDATE 17: AFTERDUST — base = sans (Lv5), fusers = 2x Lv5 Geno + 1x Lv5 JHall Dust, needs Glitched Star ---
  if (baseChar.character_id === 'sans') {
    const genos = fuserChars.filter(c => c.character_id === 'geno_sans' && getLevelFromExp(c.exp || 0) >= 5);
    const jhall = fuserChars.find(c => c.character_id === 'judgement_hall_dust_sans' && getLevelFromExp(c.exp || 0) >= 5);
    if (genos.length >= 2 && jhall) {
      if (!playerDB.hasItem(userId, 'glitched_star', 1)) return interaction.reply({ content: 'You need a **💫 Glitched Star** to fuse AfterDust!Sans! Get one from FatalError!Sans boss (5%) or /scavenge (3%).', ephemeral: true });
      if (getLevelFromExp(baseChar.exp) < 5) return interaction.reply({ content: 'Your **Sans** must be **Lv5**!', ephemeral: true });
      if (baseChar.locked) return interaction.reply({ content: '🔒 Your **Sans** is locked!', ephemeral: true });
      for (const c of [...genos.slice(0, 2), jhall]) { if (c.locked) return interaction.reply({ content: `🔒 **${CHARACTERS[c.character_id]?.name}** [ID: ${c.id}] is locked!`, ephemeral: true }); }
      playerDB.removeCharacter(userId, baseChar.id);
      playerDB.removeCharacter(userId, genos[0].id);
      playerDB.removeCharacter(userId, genos[1].id);
      playerDB.removeCharacter(userId, jhall.id);
      playerDB.removeItem(userId, 'glitched_star', 1);
      const shiny = rollShiny();
      const nc = playerDB.addCharacter(userId, 'afterdust_sans', 0, shiny);
      const ts = playerDB.getTeamSize(userId); if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
      return interaction.reply({ content: `*"I shall watch over these useless timelines..."*\n\n**Sans**, **2x Geno Sans**, **JHall Dust Sans**, and a **Glitched Star** fused into ${shiny ? '**✦ SHINY ✦** ' : ''}**AfterDust!Sans**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.` });
    }
  }

  return interaction.reply({ content: 'No valid fusion recipe found! Check your characters and items.', ephemeral: true });
}

async function cmdExile(interaction) {
  const userId = interaction.user.id; playerDB.ensurePlayer(userId);
  const charId = interaction.options.getInteger('character_id');
  const char = playerDB.getCharacterById(charId, userId);
  if (!char) return interaction.reply({ content: 'You don\'t own that character!', ephemeral: true });
  if (char.locked) return interaction.reply({ content: '🔒 That character is **locked**! Use `/unlock` first.', ephemeral: true });
  const cd = CHARACTERS[char.character_id];
  playerDB.removeCharacter(userId, charId);
  return interaction.reply({ content: `You exiled **${cd?.name || char.character_id}** [ID: ${charId}]. They're gone forever.` });
}

async function cmdCharInfo(interaction) {
  const charId = interaction.options.getString('character');
  const cd = CHARACTERS[charId];
  if (!cd) return interaction.reply({ content: 'Unknown character!', ephemeral: true });
  return interaction.reply({ embeds: [embeds.charInfo(cd)] });
}

async function cmdGiveCharacter(interaction) {
  const userId = interaction.user.id;
  if (!ADMINS.includes(userId)) return interaction.reply({ content: 'You don\'t have permission!', ephemeral: true });
  // --- UPDATE 32: targets by raw Discord user ID so it works across every server ---
  const targetId = (interaction.options.getString('user_id') || '').trim();
  if (!/^\d{15,25}$/.test(targetId)) return interaction.reply({ content: 'Invalid Discord user ID. Paste the numeric ID.', ephemeral: true });
  const charId = interaction.options.getString('character');
  if (!CHARACTERS[charId]) return interaction.reply({ content: 'Unknown character!', ephemeral: true });
  playerDB.ensurePlayer(targetId);
  const shiny = interaction.options.getBoolean('shiny') || false;
  const nc = playerDB.addCharacter(targetId, charId, 0, shiny);
  const cd = CHARACTERS[charId];
  return interaction.reply({ content: `Gave ${shiny ? '**✦ SHINY ✦** ' : ''}**${cd.name}** to <@${targetId}> (\`${targetId}\`)! [ID: ${nc.id}]` });
}

async function cmdGiveAllChars(interaction) {
  const userId = interaction.user.id;
  if (userId !== '1290690841857495122') return interaction.reply({ content: 'You don\'t have permission!', ephemeral: true });
  const target = interaction.options.getUser('player');
  playerDB.ensurePlayer(target.id);
  const skip = ['admin_char', 'female_killer_sans', 'mad_mew_mew']; // skip test/exclusive chars
  const given = [];
  for (const charId of Object.keys(CHARACTERS)) {
    if (skip.includes(charId)) continue;
    const nc = playerDB.addCharacter(target.id, charId, 0, false);
    given.push(CHARACTERS[charId].name);
  }
  const nameList = given.join(', ');
  return interaction.reply({ content: `Gave **${given.length} characters** to **${target.username}**:\n${nameList}`.slice(0, 1990) });
}

async function cmdRemoveAllChars(interaction) {
  const userId = interaction.user.id;
  if (userId !== '1290690841857495122') return interaction.reply({ content: 'You don\'t have permission!', ephemeral: true });
  const target = interaction.options.getUser('player');
  playerDB.ensurePlayer(target.id);
  const chars = playerDB.getCharacters(target.id);
  if (chars.length === 0) return interaction.reply({ content: `**${target.username}** has no characters to remove.`, ephemeral: true });
  for (const c of chars) playerDB.removeCharacter(target.id, c.id);
  playerDB.clearTeam(target.id);
  return interaction.reply({ content: `Removed all **${chars.length} characters** from **${target.username}** and cleared their team.` });
}

// --- RANKED PvP resolution ---
// Applies one player's match outcome. `self`/`opp` are PRE-MATCH snapshots so
// both sides compute deltas against each other's original standing (order-independent).
function applyRankedOutcome(playerId, self, opp, didWin) {
  const ranked = require('./ranked');
  const R = { placed: self.placed, placementGames: self.placementGames, placementWins: self.placementWins, index: self.index, crystals: self.crystals };
  const out = {};
  if (!R.placed) {
    R.placementGames += 1;
    if (didWin) R.placementWins += 1;
    if (R.placementGames >= 5) {
      R.placed = true;
      R.index = ranked.placementStartIndex(R.placementWins);
      R.crystals = 0;
      out.placement = { justPlaced: true, wins: R.placementWins, startIndex: R.index };
    } else {
      out.placement = { justPlaced: false, wins: R.placementWins, games: R.placementGames };
    }
    playerDB.setRanked(playerId, R);
    return out;
  }
  // SEASON 2: flat rate from the player's OWN rank; opponent standing (placed
  // or still in placements) no longer changes the swing.
  const delta = ranked.computeDelta(R.index, didWin);
  const applied = ranked.applyDelta({ index: R.index, crystals: R.crystals }, delta);
  out.before = { index: self.index, crystals: self.crystals };
  out.after = { index: applied.index, crystals: applied.crystals };
  out.delta = delta;
  out.promoted = applied.promoted;
  out.demoted = applied.demoted;
  R.index = applied.index; R.crystals = applied.crystals;
  playerDB.setRanked(playerId, R);
  return out;
}

function resolveRanked(winnerId, loserId) {
  playerDB.ensurePlayer(winnerId); playerDB.ensurePlayer(loserId);
  playerDB.addPvPWin(winnerId);
  playerDB.addPvPLoss(loserId);
  // --- UPDATE 32: offseason — matches still count as wins/losses, but no crystals or rank movement ---
  if (!playerDB.isSeasonActive()) {
    return { winnerId, loserId, unranked: true, winner: { unranked: true }, loser: { unranked: true } };
  }
  const wSnap = { ...playerDB.getRanked(winnerId) };
  const lSnap = { ...playerDB.getRanked(loserId) };
  const winner = applyRankedOutcome(winnerId, wSnap, lSnap, true);
  const loser = applyRankedOutcome(loserId, lSnap, wSnap, false);
  return { winnerId, loserId, winner, loser };
}

// Ranked: no duplicate characters allowed on a team. Returns the duplicated
// character's display name, or null if the team is clean.
function findDuplicateCharacter(team) {
  const seen = new Set();
  for (const t of team) {
    if (seen.has(t.character_id)) return CHARACTERS[t.character_id]?.name || t.character_id;
    seen.add(t.character_id);
  }
  return null;
}

// --- TEMPORARY: characters banned from ranked (pending rework). Remove IDs here to re-allow. ---
const RANKED_BANNED_IDS = new Set(['nightmare_sans']);
function findBannedCharacter(team) {
  for (const t of team) {
    if (RANKED_BANNED_IDS.has(t.character_id)) return CHARACTERS[t.character_id]?.name || t.character_id;
  }
  return null;
}

// --- PvP per-turn timer (5 min). If a player doesn't act, their turn auto-skips. ---
const PVP_TURN_TIMEOUT_MS = 5 * 60 * 1000;
const PVP_QUEUE_TIMEOUT_MS = 2 * 60 * 1000;
const MATCHLOG_PATH = './data/pvp_matchlog.json';

// --- UPDATE 34: /challenge DM notifier ---------------------------------------
// Opt-in list of user ids who want a DM when someone starts searching for a
// ranked match. OFF by default: a user only appears here after /pvpnotify on.
const PVPNOTIFY_PATH = './data/pvpnotify.json';
// Discord rate-limits direct messages, so sends go out in small parallel
// batches rather than one huge burst.
const PVPNOTIFY_BATCH_SIZE = 5;
const PVPNOTIFY_BATCH_DELAY_MS = 1000;

function loadNotifyList() {
  try {
    const arr = JSON.parse(fs.readFileSync(PVPNOTIFY_PATH, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function saveNotifyList(arr) {
  try {
    const tmp = PVPNOTIFY_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr));
    fs.renameSync(tmp, PVPNOTIFY_PATH);
  } catch (e) { console.error('saveNotifyList error:', e); }
}

function isNotifyOn(userId) { return loadNotifyList().includes(userId); }

function setNotify(userId, on) {
  const arr = loadNotifyList();
  const has = arr.includes(userId);
  if (on && !has) arr.push(userId);
  else if (!on && has) arr.splice(arr.indexOf(userId), 1);
  else return false; // no change
  saveNotifyList(arr);
  return true;
}

// Who receives a notification: everyone opted in with a FULL 6-character team,
// except the searcher themselves. Deliberately does NOT skip players who are
// mid-battle or already queued - the notification always goes out.
function notifyRecipients(searcherId) {
  const opted = loadNotifyList();
  return opted.filter(id => {
    if (id === searcherId) return false;
    try { return playerDB.getTeamSize(id) === 6; } catch (e) { return false; }
  });
}

// DM every eligible opted-in player that a ranked search has started.
// Aborts as soon as the searcher is matched or cancels, so nobody is pinged
// about a queue slot that no longer exists.
async function broadcastQueueNotice(searcherId, searcherName) {
  const targets = notifyRecipients(searcherId);
  if (!targets.length) return;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pvp_notify_join').setLabel('Join Queue').setEmoji('\u2694\uFE0F').setStyle(ButtonStyle.Success),
  );
  const content = `\u2694\uFE0F **${searcherName}** is searching for a ranked match!\nHit the button below or run \`/challenge\` to face them.\n\n-# Turn these off any time with \`/pvpnotify state:off\``;

  let sent = 0;
  for (let i = 0; i < targets.length; i += PVPNOTIFY_BATCH_SIZE) {
    const batch = targets.slice(i, i + PVPNOTIFY_BATCH_SIZE);
    const results = await Promise.all(batch.map(async id => {
      try {
        const user = await client.users.fetch(id);
        await user.send({ content, components: [row] });
        return 1;
      } catch (e) { return 0; } // DMs closed or user unreachable
    }));
    sent += results.reduce((a, b) => a + b, 0);
    if (i + PVPNOTIFY_BATCH_SIZE < targets.length) await new Promise(r => setTimeout(r, PVPNOTIFY_BATCH_DELAY_MS));
  }
  console.log(`[pvpnotify] notified ${sent}/${targets.length} player(s) for ${searcherName}`);
}
// Live spectator feed — every ranked match is mirrored here for alt-farm monitoring.
const MONITOR_CHANNEL_ID = '1522259645174120498'; // guild 1522259573925351525

function clearPvPTurnTimer(pvpBattle) {
  if (pvpBattle && pvpBattle._turnTimer) { clearTimeout(pvpBattle._turnTimer); pvpBattle._turnTimer = null; }
}

function startPvPTurnTimer(pvpBattle) {
  clearPvPTurnTimer(pvpBattle);
  if (!pvpBattle) return;
  const turnOwner = pvpBattle.currentTurn;
  pvpBattle._turnTimer = setTimeout(() => handlePvPTurnTimeout(pvpBattle, turnOwner), PVP_TURN_TIMEOUT_MS);
}

function pvpMsgFor(pvpBattle, pid) { return pvpBattle._msgs ? pvpBattle._msgs[pid] : null; }

// Re-render BOTH players' battle boards (cross-server safe). Buttons only on the active player's side.
async function renderPvP(pvpBattle, logLines) {
  const logEmbed = embeds.battleLog(logLines || []);
  const cur = pvpBattle.currentTurn;
  for (const pid of [pvpBattle.player1Id, pvpBattle.player2Id]) {
    const msg = pvpMsgFor(pvpBattle, pid);
    if (!msg) continue;
    const isTurn = pid === cur;
    const state = pvpBattle.getState(pid);
    try {
      await msg.edit({
        content: isTurn ? `🟢 **Your turn!**` : `⏳ Waiting for your opponent...`,
        embeds: [logEmbed, embeds.pvpBattleState(pvpBattle, pid)],
        components: isTurn ? embeds.pvpButtons(state, pid) : [],
      });
    } catch (e) {
      // Previously swallowed silently, which left the board stuck on the
      // "Match found!" message with no clue as to why.
      console.error(`renderPvP: failed to update board for ${pid}:`, e?.message || e);
    }
  }
  await sendMonitor(pvpBattle, logLines, null);
}

// Neutral spectator embed of a live match (for the monitor channel).
function buildMonitorEmbed(pvpBattle, logLines, finalResult) {
  const s = pvpBattle.getState(pvpBattle.player1Id);
  const names = pvpBattle._names || {};
  const guilds = pvpBattle._guilds || {};
  const p1 = names[pvpBattle.player1Id] || pvpBattle.player1Id;
  const p2 = names[pvpBattle.player2Id] || pvpBattle.player2Id;
  const sameServer = guilds[pvpBattle.player1Id] && guilds[pvpBattle.player1Id] === guilds[pvpBattle.player2Id];
  const embed = new EmbedBuilder().setColor(finalResult ? 0x95A5A6 : (sameServer ? 0xE74C3C : 0x1ABC9C));
  if (finalResult) {
    embed.setTitle('🏁 Ranked Match Ended' + (sameServer ? ' ⚠️ SAME SERVER' : ''))
      .setDescription(`**${names[finalResult.winnerId] || finalResult.winnerId}** ✅ beat **${names[finalResult.loserId] || finalResult.loserId}**`);
  } else {
    embed.setTitle('🛰️ Live Ranked Match' + (sameServer ? ' ⚠️ SAME SERVER' : ''))
      .setDescription(`**${p1}** vs **${p2}** — Turn ${s.turnNumber}, <@${pvpBattle.currentTurn}> to move`)
      .addFields(
        { name: `${p1}`, value: `${s.player.name} — ${s.player.hp}/${s.player.maxHp} HP\nTeam: ${s.teamAlive}/${s.teamTotal}`, inline: true },
        { name: `${p2}`, value: `${s.enemy.name} — ${s.enemy.hp}/${s.enemy.maxHp} HP\nTeam: ${s.enemyAlive}/${s.enemyTotal}`, inline: true },
      );
  }
  if (logLines && logLines.length) embed.addFields({ name: 'Last action', value: (logLines.slice(-4).join('\n') || '—').slice(0, 1000) });
  embed.addFields({ name: 'Servers', value: `P1: \`${guilds[pvpBattle.player1Id] || '?'}\` | P2: \`${guilds[pvpBattle.player2Id] || '?'}\`` });
  if (sameServer) embed.setFooter({ text: '⚠️ Both players queued from the same server — possible alt-farm' });
  return embed;
}

// Post/update the spectator message in the monitor channel.
async function sendMonitor(pvpBattle, logLines, finalResult) {
  try {
    const ch = await client.channels.fetch(MONITOR_CHANNEL_ID).catch(() => null);
    if (!ch) return;
    const embed = buildMonitorEmbed(pvpBattle, logLines, finalResult);
    if (pvpBattle._monitorMsg) await pvpBattle._monitorMsg.edit({ embeds: [embed] }).catch(() => {});
    else pvpBattle._monitorMsg = await ch.send({ embeds: [embed] }).catch(() => null);
  } catch (e) { console.error('monitor error:', e); }
}

// End a match: apply ranked result, edit both boards, log the match. Called exactly once per battle.
async function endPvP(pvpBattle, winnerId, loserId, logLines, headline) {
  // FIX (Update 34): re-entry guard. Without this, a double-click or a turn
  // timeout landing at the same moment as a finishing blow could run
  // resolveRanked() twice and apply the crystal swing twice.
  if (pvpBattle._ended) return;
  pvpBattle._ended = true;
  clearPvPTurnTimer(pvpBattle);
  activePvP.delete(pvpBattle.player1Id);
  activePvP.delete(pvpBattle.player2Id);
  const rr = resolveRanked(winnerId, loserId);
  logMatch(pvpBattle, winnerId, loserId);
  const logEmbed = embeds.battleLog(logLines || []);
  const winEmbed = embeds.pvpVictory(rr);
  for (const pid of [pvpBattle.player1Id, pvpBattle.player2Id]) {
    const msg = pvpMsgFor(pvpBattle, pid);
    if (!msg) continue;
    await msg.edit({ content: headline || null, embeds: [logEmbed, winEmbed], components: [] }).catch(e => console.error(`endPvP: failed to update board for ${pid}:`, e?.message || e));
  }
  await sendMonitor(pvpBattle, logLines, { winnerId, loserId });
}

async function handlePvPTurnTimeout(pvpBattle, expectedTurnOwner) {
  try {
    pvpBattle._turnTimer = null;
    if (!activePvP.has(pvpBattle.player1Id) && !activePvP.has(pvpBattle.player2Id)) return;
    if (pvpBattle.currentTurn !== expectedTurnOwner) return;
    const result = pvpBattle.skipTurn();
    if (result.battleEnd) return endPvP(pvpBattle, result.battleEnd.winner, result.battleEnd.loserId, result.log);
    await renderPvP(pvpBattle, result.log);
    startPvPTurnTimer(pvpBattle);
  } catch (e) {
    console.error('PvP turn timeout error:', e);
  }
}

// --- Match log (admin alt-farm monitoring). Writes to its own file, NOT database.js ---
function logMatch(pvpBattle, winnerId, loserId) {
  try {
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(MATCHLOG_PATH, 'utf8')); } catch (e) {}
    if (!Array.isArray(arr)) arr = [];
    const names = pvpBattle._names || {};
    const guilds = pvpBattle._guilds || {};
    arr.push({ t: Date.now(), w: winnerId, l: loserId, wn: names[winnerId] || winnerId, ln: names[loserId] || loserId, wg: guilds[winnerId] || null, lg: guilds[loserId] || null });
    if (arr.length > 500) arr = arr.slice(arr.length - 500);
    fs.writeFileSync(MATCHLOG_PATH, JSON.stringify(arr));
  } catch (e) { console.error('logMatch error:', e); }
}

// --- Matchmaking queue helpers ---
function inQueue(userId) { return pvpQueue.some(e => e.userId === userId); }
function removeFromQueue(userId) { const i = pvpQueue.findIndex(e => e.userId === userId); if (i >= 0) pvpQueue.splice(i, 1); }

// Find a valid waiting opponent (team still legal, not already busy). Prefers a non-rematch.
function dequeueValidOpponent(userId) {
  // FIX (Update 34): iterate a SNAPSHOT, not live indices. removeFromQueue()
  // splices pvpQueue, which shifted every later index mid-loop and made valid
  // waiting opponents get skipped - two people could sit in the queue at the
  // same time and never match.
  const snapshot = pvpQueue.slice().sort((x, y) => {
    const lx = pvpLastOpponent.get(userId) === x.userId ? 1 : 0;
    const ly = pvpLastOpponent.get(userId) === y.userId ? 1 : 0;
    return lx - ly; // non-last-opponent first
  });
  for (const e of snapshot) {
    if (!e || e.userId === userId) continue;
    if (!inQueue(e.userId)) continue; // already pruned earlier in this loop
    if (activePvP.has(e.userId) || activeBattles.has(e.userId)) { removeFromQueue(e.userId); continue; }
    const t = playerDB.getTeam(e.userId);
    if (t.length === 0 || findDuplicateCharacter(t) || findBannedCharacter(t)) { removeFromQueue(e.userId); e.message?.edit({ content: '\u26a0\ufe0f You were removed from the queue \u2014 your team is no longer valid for ranked.', components: [] }).catch(() => {}); continue; }
    return e;
  }
  return null;
}

async function startPvPMatch(a, b) {
  const team1Data = buildTeamData(playerDB.getTeam(a.userId), a.userId);
  const team2Data = buildTeamData(playerDB.getTeam(b.userId), b.userId);
  const { PvPBattle } = require('./pvp');
  const pvpBattle = new PvPBattle(team1Data, team2Data, a.userId, b.userId);
  activePvP.set(a.userId, pvpBattle);
  activePvP.set(b.userId, pvpBattle);
  pvpBattle._msgs = { [a.userId]: a.message, [b.userId]: b.message };
  pvpBattle._names = { [a.userId]: a.username, [b.userId]: b.username };
  pvpBattle._guilds = { [a.userId]: a.guildId, [b.userId]: b.guildId };
  pvpLastOpponent.set(a.userId, b.userId);
  pvpLastOpponent.set(b.userId, a.userId);
  try {
    await renderPvP(pvpBattle, [`⚔️ Ranked match found — **${a.username}** vs **${b.username}**!`]);
  } catch (e) {
    console.error('startPvPMatch: renderPvP threw:', e);
  }
  startPvPTurnTimer(pvpBattle);
}


async function cmdChallenge(interaction) { return joinRankedQueue(interaction); }

// UPDATE 34: shared by /challenge and the "Join Queue" DM notification button.
// Playable from DMs — PVP_GLOBAL is on, so there is no guild requirement.
async function joinRankedQueue(interaction, opts = {}) {
  const announce = opts.announce !== false;
  const userId = interaction.user.id;
  const seasonOn = playerDB.isSeasonActive(); // UPDATE 32
  if (interaction.inGuild() && !PVP_GLOBAL && interaction.guildId !== PVP_GUILD_ID) return interaction.reply({ content: 'Ranked PvP can only be played in the official UMT server! Join here: https://discord.gg/fDutC9gtQG', ephemeral: true });
  if (activeBattles.has(userId)) return interaction.reply({ content: 'You\'re already in a battle!', ephemeral: true });
  if (activePvP.has(userId)) return interaction.reply({ content: 'You\'re already in a ranked match!', ephemeral: true });
  if (inQueue(userId)) return interaction.reply({ content: 'You\'re already searching for a match — hit **Cancel Search** to leave the queue.', ephemeral: true });

  playerDB.ensurePlayer(userId);
  const team1 = playerDB.getTeam(userId);
  if (team1.length === 0) return interaction.reply({ content: 'Your team is empty!', ephemeral: true });
  const dupSelf = findDuplicateCharacter(team1);
  if (dupSelf) return interaction.reply({ content: `You can't do ranked with duplicate characters! You have 2+ **${dupSelf}** on your team — swap one out first.`, ephemeral: true });
  const banSelf = findBannedCharacter(team1);
  if (banSelf) return interaction.reply({ content: `**${banSelf}** is currently **banned from ranked** (pending a rework). Swap it off your team first.`, ephemeral: true });

  // UPDATE 34: fire the DM alert the INSTANT the command is used, before we even
  // look for an opponent. Fire-and-forget so it never delays the reply.
  if (announce) broadcastQueueNotice(userId, interaction.user.username).catch(e => console.error('broadcastQueueNotice error:', e));

  // Try to find a waiting opponent in the GLOBAL queue
  const opp = dequeueValidOpponent(userId);
  if (opp) {
    removeFromQueue(opp.userId);
    await interaction.reply({ content: seasonOn ? '⚔️ **Match found!** Starting ranked battle...' : '⚔️ **Match found!** Starting **unranked** battle — the season is over, so no Shadow Crystals are on the line.' });
    const selfMsg = await interaction.fetchReply();
    const selfEntry = { userId, username: interaction.user.username, message: selfMsg, channelId: interaction.channelId, guildId: interaction.guildId || 'DM' };
    return startPvPMatch(selfEntry, opp);
  }

  // No opponent — join the queue with a Cancel button
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pvp_queue_cancel').setLabel('Cancel Search').setStyle(ButtonStyle.Danger),
  );
  await interaction.reply({ content: (seasonOn
    ? '🔍 **Searching for a ranked opponent...**'
    : '🔍 **Searching for an unranked opponent...**\n*The ranked season has ended — matches are casual until the next season starts.*'
  ) + '\nYou\'ll be matched with anyone else using `/challenge` across all servers. (Up to 2 minutes.)', components: [row] });
  const msg = await interaction.fetchReply();
  const enqueuedAt = Date.now();
  pvpQueue.push({ userId, username: interaction.user.username, message: msg, channelId: interaction.channelId, guildId: interaction.guildId || 'DM', enqueuedAt });

  setTimeout(() => {
    const e = pvpQueue.find(q => q.userId === userId);
    if (e && e.enqueuedAt === enqueuedAt) {
      removeFromQueue(userId);
      msg.edit({ content: '⌛ No opponent found in time. Search cancelled — try `/challenge` again!', components: [] }).catch(() => {});
    }
  }, PVP_QUEUE_TIMEOUT_MS);
}

// UPDATE 34: toggle ranked search DM notifications. Off by default.
async function cmdPvpNotify(interaction) {
  const userId = interaction.user.id;
  playerDB.ensurePlayer(userId);
  const state = interaction.options.getString('state');

  if (!state) {
    const on = isNotifyOn(userId);
    return interaction.reply({ content: `\uD83D\uDD14 Ranked search notifications are currently **${on ? 'ON' : 'OFF'}**.\nUse \`/pvpnotify state:${on ? 'off' : 'on'}\` to change it.`, ephemeral: true });
  }

  const want = state === 'on';
  const changed = setNotify(userId, want);
  if (!changed) return interaction.reply({ content: `\uD83D\uDD14 Notifications are already **${want ? 'ON' : 'OFF'}**.`, ephemeral: true });

  if (want) {
    const full = playerDB.getTeamSize(userId) === 6;
    return interaction.reply({ content: `\u2705 Ranked search notifications are now **ON**. You'll get a DM whenever someone starts searching with \`/challenge\`.${full ? '' : '\n\n\u26A0\uFE0F Heads up: notifications only go to players with a **full 6-character team**. Fill yours out with `/team` to start receiving them.'}\n\n-# Turn them off any time with \`/pvpnotify state:off\``, ephemeral: true });
  }
  return interaction.reply({ content: '\uD83D\uDD15 Ranked search notifications are now **OFF**.', ephemeral: true });
}

async function cmdMatchlog(interaction) {
  if (!hasModeRole(interaction)) return interaction.reply({ content: 'No permission!', ephemeral: true });
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(MATCHLOG_PATH, 'utf8')); } catch (e) {}
  if (!Array.isArray(arr) || arr.length === 0) return interaction.reply({ content: 'No ranked matches logged yet.', ephemeral: true });

  const recent = arr.slice(-15).reverse();
  const lines = recent.map(m => {
    const when = `<t:${Math.floor(m.t / 1000)}:R>`;
    const cross = (!m.wg || !m.lg || m.wg === 'DM' || m.lg === 'DM' || m.wg !== m.lg) ? '' : ' ⚠️same-server';
    return `**${m.wn}** ✅ beat **${m.ln}** — ${when}${cross}`;
  });

  // Flag pairs that met 3+ times in the log (alt-farm signal)
  const pairCount = {};
  for (const m of arr) { const key = [m.w, m.l].sort().join('|'); pairCount[key] = (pairCount[key] || 0) + 1; }
  const flagged = Object.entries(pairCount).filter(([, c]) => c >= 3)
    .map(([key, c]) => { const [x, y] = key.split('|'); const nm = arr.find(m => (m.w === x && m.l === y) || (m.w === y && m.l === x)); return `• ${nm ? (nm.w === x ? nm.wn : nm.ln) : x} ↔ ${nm ? (nm.w === y ? nm.wn : nm.ln) : y} — **${c}** matches`; });

  const embed = new EmbedBuilder().setColor(0x9B59B6).setTitle('🛡️ Ranked Match Log').setDescription(lines.join('\n'));
  if (flagged.length) embed.addFields({ name: '⚠️ Frequent pairings (possible alt-farm)', value: flagged.slice(0, 10).join('\n') });
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function cmdProfile(interaction) {
  const userId = interaction.user.id; playerDB.ensurePlayer(userId);
  const p = playerDB.getPlayer(userId); const c = playerDB.getCharacters(userId); const ts = playerDB.getTeamSize(userId);
  const bossKills = Object.keys(BOSSES).reduce((sum, bid) => sum + (playerDB.getKillCount(userId, bid) || 0), 0);
  return interaction.reply({ embeds: [embeds.profile(interaction.user, p, c.length, ts, bossKills)] });
}

async function cmdHelp(interaction) { return interaction.reply({ embeds: [embeds.help()] }); }

// --- UPDATE 22: /claim — one-time data loss compensation ---
async function cmdClaim(interaction) {
  const userId = interaction.user.id;
  const p = playerDB.ensurePlayer(userId);
  if (p.compClaimed) return interaction.reply({ content: '🎁 You\'ve already claimed your compensation package!', ephemeral: true });
  // Soft gate: at least 1 boss clear OR any character above Lv1
  const hasBossClear = (p.bossClears || 0) >= 1;
  const hasLeveledChar = (p.characters || []).some(c => getLevelFromExp(c.exp || 0) >= 2);
  if (!hasBossClear && !hasLeveledChar) {
    return interaction.reply({ content: '🎁 The compensation package unlocks once you\'ve defeated **1 boss** or leveled any character to **Lv2**. Go fight something first!', ephemeral: true });
  }
  p.compClaimed = true;
  // Currencies
  playerDB.addDetermination(userId, 50000);
  playerDB.addSoulEssence(userId, 2000);
  playerDB.addItem(userId, 'dt_vial', 5000);
  playerDB.addItem(userId, 'dt_soul', 50);
  // Souls
  playerDB.addItem(userId, 'tier1_monster_soul', 25);
  playerDB.addItem(userId, 'tier2_monster_soul', 10);
  playerDB.addItem(userId, 'tier3_monster_soul', 15);
  // Utility
  playerDB.addItem(userId, 'event_boss_ticket', 10);
  playerDB.addItem(userId, 'shiny_star', 5);
  playerDB.addItem(userId, 'save_star', 3);
  // Fusion-gate items
  playerDB.addItem(userId, 'asgores_trident', 2);
  playerDB.addItem(userId, 'crown_of_the_king', 1);
  playerDB.addItem(userId, 'spear', 2);
  playerDB.addItem(userId, 'papyrus_scarf', 3);
  playerDB.addItem(userId, 'gasters_hands', 3);
  playerDB.addItem(userId, 'his_guidance', 3);
  playerDB.addItem(userId, 'stolen_flames', 2);
  playerDB.addItem(userId, 'real_knife', 3);
  // The big one
  playerDB.addItem(userId, 'compensation_token', 1);
  const embed = {
    color: 0xffd700,
    title: '🎁 Compensation Package Claimed!',
    description: 'We\'re deeply sorry about the data loss. Here\'s a heavy compensation to help you rebuild:\n\n'
      + '💪 **50,000 Determination**\n🧪 **5,000 DT Vials**\n💜 **2,000 Soul Essence**\n💗 **50 DT Souls**\n'
      + '🔥 **25 Tier 1** / 💎 **10 Tier 2** / 💎 **15 Tier 3 Monster Souls**\n'
      + '🎟️ **10 Event Boss Tickets** | 🌠 **5 Shiny Stars** | 💫 **3 Save Stars**\n'
      + '🔱 **2 Asgore\'s Tridents** | 👑 **1 Crown of the King** | 🔱 **2 Spears** | 🧣 **3 Papyrus\' Scarves**\n'
      + '🖐️ **3 Gaster\'s Hands** | 👁️ **3 His Guidance** | 🔥 **2 Stolen Flames** | 🔪 **3 Real Knives**\n\n'
      + '🎫 **1 COMPENSATION TOKEN** — use `/redeem` to claim **ANY character of your choice**, free!',
    footer: { text: 'One claim per player. Thank you for sticking with us. — UMT' },
  };
  return interaction.reply({ embeds: [embed] });
}

// --- UPDATE 22: /redeem — exchange a Compensation Token for any character ---
async function cmdRedeem(interaction) {
  const userId = interaction.user.id; playerDB.ensurePlayer(userId);
  const charId = interaction.options.getString('character');
  if (!playerDB.hasItem(userId, 'compensation_token', 1)) return interaction.reply({ content: 'You don\'t have a **🎫 Compensation Token**! Use `/claim` first.', ephemeral: true });
  const cd = CHARACTERS[charId];
  const REDEEM_BLOCKED = ['admin_char', 'female_killer_sans', 'fallen_priest', 'mad_mew_mew'];
  if (!cd || REDEEM_BLOCKED.includes(charId) || cd.isEventChar) return interaction.reply({ content: 'That character can\'t be redeemed! Use the autocomplete to pick a valid one.', ephemeral: true });
  playerDB.removeItem(userId, 'compensation_token', 1);
  const shiny = cd.canBeShiny === false || cd.refuseShiny ? false : rollShiny();
  const nc = playerDB.addCharacter(userId, charId, 0, shiny);
  const ts = playerDB.getTeamSize(userId);
  if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
  return interaction.reply({ content: `🎫 Token redeemed!\n\nYou received ${shiny ? '**✦ SHINY ✦** ' : ''}**${cd.name}**!${shiny ? ' (+2 ATK, +2 DEF)' : ''}\nCharacter ID: **${nc.id}**.\n\n*Welcome back. — UMT*` });
}

// --- UPDATE 31: /charsynergies — list all character synergies ---
async function cmdCharSynergies(interaction) {
  const nameOf = (id) => CHARACTERS[id]?.name || id;
  const lines = Object.values(SYNERGIES).map(syn => {
    const sources = (syn.sourceIds || [syn.sourceId]).map(nameOf).join(' / ');
    const becomes = syn.becomes ? `\n> Becomes: **${nameOf(syn.becomes)}**` : '';
    return `${syn.emoji || '🔗'} **${syn.name}**\n> Character: **${sources}**\n> Requires: **${nameOf(syn.requires)}** on the team${becomes}\n> ${syn.description}`;
  });
  const embed = {
    color: 0xb388ff,
    title: '🔗 Character Synergies',
    description: lines.join('\n\n') || '*No synergies exist yet.*',
    footer: { text: 'Only ONE synergy can be active at a time. With duplicates, only the first character in your team order is affected. Separated characters instantly return to their normal moves and passive.' },
  };
  return interaction.reply({ embeds: [embed] });
}

// --- UPDATE 22: /teamabilities — list all team abilities ---
async function cmdTeamAbilities(interaction) {
  const entries = Object.values(CHARACTERS).filter(c => c.teamAbility);
  const lines = entries.map(c => {
    const ta = c.teamAbility;
    const req = CHARACTERS[ta.requiresCharacter]?.name || ta.requiresCharacter || 'None';
    return `⚡ **${ta.name}** — *${c.name}*\n> Requires: **${req}** on the team\n> ${ta.description}`;
  });
  const embed = {
    color: 0x00b0f4,
    title: '⚡ Team Abilities',
    description: lines.join('\n\n') || '*No team abilities exist yet.*',
    footer: { text: 'Team abilities are used with the Team Ability button during boss battles.' },
  };
  return interaction.reply({ embeds: [embed] });
}

// ============================================
// BUTTON HANDLERS
// ============================================
async function handleButton(interaction, overrideCustomId = null) {
  const userId = interaction.user.id;
  const customId = overrideCustomId || interaction.customId;

  // --- STORY MODE (DM-safe): route all story_* buttons to the story module ---
  if (customId === 'story_fight_begin') return cmdStoryBattleBegin(interaction);
  if (customId.startsWith('story_')) return story.handleStoryButton(interaction);

  // --- UPDATE 32: End Season confirmation ---
  if (customId.startsWith('endseason_')) return handleEndSeasonButton(interaction);
  if (customId.startsWith('startseason_')) return handleStartSeasonButton(interaction);

  // --- UPDATE 18: Booster character pick ---
  if (customId.startsWith('booster_pick_')) {
    const pickedId = customId.replace('booster_pick_', '');
    const valid = BOOSTER_CHARACTERS.find(c => c.id === pickedId);
    if (!valid) return interaction.reply({ content: 'Invalid character.', ephemeral: true });
    if (playerDB.hasBoosterClaim(userId)) {
      return interaction.update({ content: 'You\'ve already claimed your booster reward!', components: [] });
    }
    const newChar = playerDB.addBoosterCharacter(userId, pickedId);
    return interaction.update({
      content: `✅ You picked **${valid.label}**! It has been added to your roster as character ID **${newChar.id}**.\n\n*Note: this character will be removed if you stop boosting.*`,
      components: [],
    });
  }
  // ------------------------------------------

  if (customId.startsWith('shinystar_prev_') || customId.startsWith('shinystar_next_')) {
    const parts = customId.split('_');
    const dir = parts[1]; // prev or next
    const currentPage = parseInt(parts[2]);
    const newPage = dir === 'next' ? currentPage + 1 : currentPage - 1;
    const chars = playerDB.getCharacters(userId);
    const nonShiny = chars.filter(c => !c.shiny);
    return interaction.update(buildShinyStarPage(nonShiny, newPage));
  }

  // PvP accept/decline
  if (customId.startsWith('pvp_accept_') || customId.startsWith('pvp_decline_')) {
    // Ranked is now a global auto-matchmaking queue — old challenge buttons are retired.
    return interaction.update({ content: '⚔️ Ranked PvP is now a global queue! Just run `/challenge` and you\'ll be auto-matched with anyone else searching.', components: [], embeds: [] }).catch(() => interaction.reply({ content: 'Ranked PvP is now a global queue — run `/challenge` to auto-match!', ephemeral: true }));
  }

  // PvP ability buttons
  // UPDATE 34: "Join Queue" button from a /pvpnotify DM
  if (customId === 'pvp_notify_join') {
    // announce:false - this player is RESPONDING to a notification. Re-broadcasting
    // here would make every click spam everyone again, cascading.
    return joinRankedQueue(interaction, { announce: false });
  }

  if (customId === 'pvp_queue_cancel') {
    if (!inQueue(userId)) return interaction.reply({ content: 'You\'re not in the queue.', ephemeral: true });
    // UPDATE 34: brief lockout so a search can't be started and instantly
    // cancelled - that spams the notifier and churns the queue.
    const entry = pvpQueue.find(e => e.userId === userId);
    const waited = entry ? Date.now() - entry.enqueuedAt : Infinity;
    if (waited < PVP_CANCEL_LOCKOUT_MS) {
      const left = Math.ceil((PVP_CANCEL_LOCKOUT_MS - waited) / 1000);
      return interaction.reply({ content: `⏳ Hang on \u2014 you can cancel your search in **${left}s**.`, ephemeral: true });
    }
    removeFromQueue(userId);
    return interaction.update({ content: '❌ Search cancelled.', components: [] });
  }

  if (customId.startsWith('pvp_ability_')) {
    const pvpBattle = activePvP.get(userId);
    if (!pvpBattle) return interaction.reply({ content: 'You\'re not in a PvP battle!', ephemeral: true });
    if (pvpBattle.currentTurn !== userId) return interaction.reply({ content: 'It\'s not your turn!', ephemeral: true });
    clearPvPTurnTimer(pvpBattle);

    const abilityIndex = parseInt(customId.split('_')[2]);
    const attacker = pvpBattle.getAttacker();

    let result;
    if (attacker.isCharging) {
      result = pvpBattle.releaseCharged(userId);
    } else {
      result = pvpBattle.executeAbility(userId, abilityIndex);
    }

    if (!result) { startPvPTurnTimer(pvpBattle); return interaction.reply({ content: 'Something went wrong!', ephemeral: true }); }
    if (!result.success) { startPvPTurnTimer(pvpBattle); return interaction.reply({ content: result.message, ephemeral: true }); }

    await interaction.deferUpdate().catch(() => {});
    if (result.battleEnd) return endPvP(pvpBattle, result.battleEnd.winner, result.battleEnd.loserId, result.log);
    await renderPvP(pvpBattle, result.log);
    startPvPTurnTimer(pvpBattle);
    return;
  }

  if (customId === 'pvp_switch') {
    const pvpBattle = activePvP.get(userId);
    if (!pvpBattle) return interaction.reply({ content: 'You\'re not in a PvP battle!', ephemeral: true });
    if (pvpBattle.currentTurn !== userId) return interaction.reply({ content: 'It\'s not your turn!', ephemeral: true });
    const isP1 = userId === pvpBattle.player1Id;
    const team = isP1 ? playerDB.getTeam(pvpBattle.player1Id) : playerDB.getTeam(pvpBattle.player2Id);
    const activeIdx = isP1 ? pvpBattle.active1 : pvpBattle.active2;
    return interaction.reply({ content: 'Choose a character:', components: [embeds.pvpSwitchMenu(team, activeIdx)], ephemeral: true });
  }

  if (customId === 'pvp_forfeit') {
    const pvpBattle = activePvP.get(userId);
    if (!pvpBattle) return interaction.reply({ content: 'You\'re not in a PvP battle!', ephemeral: true });
    clearPvPTurnTimer(pvpBattle);
    const winnerId = userId === pvpBattle.player1Id ? pvpBattle.player2Id : pvpBattle.player1Id;
    await interaction.deferUpdate().catch(() => {});
    return endPvP(pvpBattle, winnerId, userId, [`<@${userId}> forfeited!`], `🏳️ <@${userId}> forfeited — <@${winnerId}> wins!`);
  }

  // Battle buttons - check ownership
  const battle = activeBattles.get(userId);
  if (!battle) return interaction.reply({ content: 'You\'re not in a battle!', ephemeral: true });
  if (battle.ownerId !== userId) return interaction.reply({ content: 'This isn\'t your battle!', ephemeral: true });

  // --- SCAMPTON EVENT: Rewritten Ticket character claim ---
  if (customId.startsWith('rwt_')) {
    const charId = customId.slice(4);
    if (!['asriel_rewritten', 'noelle_rewritten', 'charkis'].includes(charId)) return interaction.reply({ content: 'Unknown character.', ephemeral: true });
    if (!playerDB.hasItem(userId, 'rewritten_ticket', 1)) return interaction.update({ content: 'You no longer have a **🎫 Rewritten Ticket**!', components: [] });
    playerDB.removeItem(userId, 'rewritten_ticket', 1);
    const shiny = rollShiny();
    const nc = playerDB.addCharacter(userId, charId, 0, shiny);
    const ts = playerDB.getTeamSize(userId);
    if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
    const cd = CHARACTERS[charId];
    return interaction.update({ content: `🎫 The ticket rewrites itself...\n\nYou obtained **${cd.name}** [ID: ${nc.id}]!${shiny ? ' It\'s **✦ SHINY ✦**! (+2 ATK, +2 DEF)' : ''}`, components: [] });
  }

  // --- SCAMPTON EVENT: pre-fight dialog ---
  if (customId === 'scamton_dialog') {
    const sb = activeBattles.get(userId);
    if (!sb) return interaction.reply({ content: 'That battle is over.', ephemeral: true });
    sb.scamtonDialog = (sb.scamtonDialog || 0) + 1;
    if (sb.scamtonDialog < SCAMTON_PRE_DIALOG.length) {
      return interaction.update({
        embeds: [{ color: 0xff0033, title: 'SCAMPTON [[THE GREAT]]', description: SCAMTON_PRE_DIALOG[sb.scamtonDialog] }],
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('scamton_dialog').setLabel('Continue').setStyle(ButtonStyle.Primary))],
      });
    }
    const st = sb.getBattleState();
    return interaction.update({ content: '**BOSS BATTLE!** **SCAMPTON [[THE GREAT]]** stands before you!', embeds: [embeds.battleState(st)], components: embeds.abilityButtons(st) });
  }

  // --- SCAMPTON EVENT: THE TRUE POWER OF [[NEO]] button sequence ---
  if (customId.startsWith('neo_')) {
    const nb = activeBattles.get(userId);
    if (!nb || !nb._neoMinigame) return interaction.reply({ content: 'There\'s no sequence running.', ephemeral: true });
    clearMinigameTimer(nb);
    const value = parseInt(customId.split('_')[1]);
    const res = nb.neoPress(value);
    const logLines = [];
    if (res?.message) logLines.push(res.message);
    if (res?.wiped) {
      activeBattles.delete(userId);
      return interaction.update({ content: null, embeds: [embeds.battleLog(logLines.concat(['**You have been defeated by SCAMPTON [[THE GREAT]].**']))], components: [] });
    }
    const st = nb.getBattleState();
    await interaction.update({ content: null, embeds: logLines.length ? [embeds.battleLog(logLines), embeds.battleState(st)] : [embeds.battleState(st)], components: embeds.abilityButtons(st) });
    if (nb._neoMinigame) armMinigameTimer(nb, interaction.message, userId);
    return;
  }

  // --- SCAMPTON EVENT: CARDS OF [[FATE]] ---
  if (customId.startsWith('card_')) {
    const cb = activeBattles.get(userId);
    if (!cb || !cb._pendingCards) return interaction.reply({ content: 'There are no cards on the table.', ephemeral: true });
    clearMinigameTimer(cb);
    const pick = parseInt(customId.split('_')[1]);
    const res = cb.resolveCardsOfFate(pick);
    const logLines = res?.message ? [res.message] : [];
    if (cb.playerTeam.every(f => !f.isAlive)) {
      activeBattles.delete(userId);
      return interaction.update({ content: null, embeds: [embeds.battleLog(logLines.concat(['**You have been defeated.**']))], components: [] });
    }
    if (!cb.activePlayer.isAlive) {
      const nx = cb.playerTeam.findIndex(f => f.isAlive);
      if (nx >= 0) { cb.switchCharacter(nx); logLines.push(`**${cb.activePlayer.name}** steps in!`); }
    }
    const st = cb.getBattleState();
    return interaction.update({ content: null, embeds: [embeds.battleLog(logLines), embeds.battleState(st)], components: embeds.abilityButtons(st) });
  }

  if (customId.startsWith('ability_')) {
    // Anti-macro check
    if (checkMacro(userId, interaction.user.username)) {
      activeBattles.delete(userId);
      return interaction.update({ content: '⚠️ Macro detected! Battle stopped. No rewards given.', embeds: [], components: [] });
    }
    const abilityIndex = parseInt(customId.split('_')[1]);
    // --- SCAMPTON EVENT: Motivate Up / Immunity Shield pick an ally first ---
    if (!battle.activePlayer.isCharging && (battle._ppTargetIndex === null || battle._ppTargetIndex === undefined)) {
      const _ab = battle.activePlayer.abilities[abilityIndex];
      const _sp = _ab?.special?.type;
      if (_sp === 'motivateUp' || _sp === 'immunityShield') {
        const _cost = _ab.special.ppCost || 0;
        if ((battle.activePlayer._pp || 0) < _cost) {
          return interaction.reply({ content: `⚡ **${_ab.name}** requires **${_cost} PP** — you have **${battle.activePlayer._pp || 0}**!`, ephemeral: true });
        }
        const _opts = battle.playerTeam.map((f, i) => ({ f, i })).filter(o => o.f.isAlive).slice(0, 25)
          .map(o => ({ label: `${o.f.name} (${o.f.currentHp}/${o.f.maxHp} HP)`.slice(0, 100), description: `ATK ${o.f.atk} | DEF ${o.f.def}`.slice(0, 100), value: `pptarget_${o.i}_${abilityIndex}` }));
        if (_opts.length === 0) return interaction.reply({ content: 'No living party members to target!', ephemeral: true });
        return interaction.update({
          content: `Choose a party member for **${_ab.name}**:`,
          embeds: [],
          components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('pp_target_select').setPlaceholder('Choose an ally...').addOptions(_opts))],
        });
      }
    }
    let results;
    if (battle.activePlayer.isCharging) results = battle.releaseChargedAbility();
    else results = battle.executePlayerAbility(abilityIndex);

    if (!results) return interaction.reply({ content: 'Something went wrong!', ephemeral: true });
    if (results.playerAction && !results.playerAction.success) return interaction.reply({ content: results.playerAction.message, ephemeral: true });

    // --- UPDATE 15: Picker UI (Frisk ITEM, Ralsei/Noelle Heal Prayer)
    if (results.playerAction?.requiresPicker) {
      const picker = results.playerAction.requiresPicker;
      battle._pendingPicker = picker;
      battle._pendingPickerAbility = parseInt(customId.split('_')[1]);
      if (picker === 'friskItem') {
        // Build food picker
        if (!battle.activePlayer._friskFoodInv) {
          battle.activePlayer._friskFoodInv = { monster_candy: 5, crab_apple: 3, spider_donut: 1, butterscotch_pie: 1 };
        }
        const inv = battle.activePlayer._friskFoodInv;
        const opts = [
          { id: 'monster_candy', label: `Monster Candy (20 HP) — ${inv.monster_candy} left`, emoji: '🍬', count: inv.monster_candy },
          { id: 'crab_apple', label: `Crab Apple (40 HP) — ${inv.crab_apple} left`, emoji: '🍎', count: inv.crab_apple },
          { id: 'spider_donut', label: `Spider Donut (30 HP) — ${inv.spider_donut} left`, emoji: '🍩', count: inv.spider_donut },
          { id: 'butterscotch_pie', label: `Butterscotch Pie (MAX HP) — ${inv.butterscotch_pie} left`, emoji: '🥧', count: inv.butterscotch_pie },
        ].filter(o => o.count > 0);
        if (opts.length === 0) {
          // Refund and end
          const ab = battle.activePlayer.abilities[battle._pendingPickerAbility]; if (ab) ab.currentUses++;
          return interaction.reply({ content: `Frisk has no food left to use!`, ephemeral: true });
        }
        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('frisk_food_pick').setPlaceholder('Choose food...').addOptions(opts.map(o => ({ label: o.label.slice(0, 100), value: o.id, emoji: o.emoji })))
        );
        return interaction.reply({ content: `${results.playerAction.message}\nWhat will Frisk eat?`, components: [row], ephemeral: true });
      }
      if (picker === 'healPrayer' || picker === 'noelleHealPrayer') {
        const team = battle.playerTeam;
        const opts = team.filter(t => t.isAlive && t.currentHp < t.maxHp).map((t, idx) => ({
          label: `${t.name} (${t.currentHp}/${t.maxHp} HP)`.slice(0, 100),
          value: `${idx}`,
          emoji: '🌿',
        }));
        opts.unshift({ label: `Self — ${battle.activePlayer.name} (${battle.activePlayer.currentHp}/${battle.activePlayer.maxHp})`.slice(0, 100), value: 'self', emoji: '✨' });
        if (opts.length === 0) {
          const ab = battle.activePlayer.abilities[battle._pendingPickerAbility]; if (ab) ab.currentUses++;
          return interaction.reply({ content: `No teammates need healing!`, ephemeral: true });
        }
        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId(`${picker}_target_pick`).setPlaceholder('Heal who?').addOptions(opts.slice(0, 25))
        );
        return interaction.reply({ content: `${results.playerAction.message}\nWho will receive the heal?`, components: [row], ephemeral: true });
      }
    }

    const logLines = [];
    if (results.playerAction?.message) logLines.push(results.playerAction.message);
    if (results.playerAction?.damage > 0 && battle.activePlayer.id !== 'admin_char') playerDB.addDamageDealt(userId, results.playerAction.damage);
    // --- UPDATE 13: Track consecutive misses for achievement ---
    if (results.playerAction?.success) {
      const isAttack = results.playerAction.damage !== undefined;
      const missed = isAttack && (results.playerAction.damage === 0) && (results.playerAction.message?.includes('missed') || results.playerAction.message?.includes('MISS'));
      if (missed) battle._consecutiveMisses = (battle._consecutiveMisses || 0) + 1;
      else if (isAttack) battle._consecutiveMisses = 0;
    }
    if (results.passiveProc) logLines.push(results.passiveProc);
    if (results.enemyAction?.message) logLines.push(results.enemyAction.message);
    results.statusTick?.forEach(s => logLines.push(`**${battle.activePlayer.name}** takes **${s.damage}** ${s.name} damage! (${s.turnsLeft} left)`));
    results.enemyStatusTick?.forEach(s => logLines.push(`**${battle.enemy.name}** takes **${s.damage}** ${s.name} damage! (${s.turnsLeft} left)`));
    if (results.timelineRestore) results.timelineRestore.forEach(msg => logLines.push(msg));
    if (results.boneVolleyTick) results.boneVolleyTick.forEach(msg => logLines.push(msg));
    if (results.timeSplitMsg) logLines.push(results.timeSplitMsg);
    if (results.fracturedMindProc) logLines.push(results.fracturedMindProc);
    if (results.kingWillProc) logLines.push(results.kingWillProc);
    if (results.kingsHesitationProc) logLines.push(results.kingsHesitationProc);
    if (results.errorPassiveProc) logLines.push(results.errorPassiveProc);
    if (results.phantomBrotherProc) logLines.push(results.phantomBrotherProc);
    if (results.update30Procs) results.update30Procs.forEach(m => logLines.push(m));
    if (results.battleBodyProc) logLines.push(results.battleBodyProc);
    if (results.soulEmbersProc) logLines.push(results.soulEmbersProc);
    if (results.stillDeterminedProc) logLines.push(results.stillDeterminedProc);
    if (results.gastersHelpProc) logLines.push(results.gastersHelpProc);
    if (results.burningDesireProc) logLines.push(results.burningDesireProc);
    if (results.inkTrailExpired) logLines.push(results.inkTrailExpired);
    if (results.rosesAssistantProc) logLines.push(results.rosesAssistantProc);
    if (results.rosesSupportProc) logLines.push(results.rosesSupportProc);
    if (results.losingHisMindHeal) logLines.push(results.losingHisMindHeal);
    if (results.braveryCounterProc) logLines.push(results.braveryCounterProc);
    if (results.vineRestrictionProc) logLines.push(results.vineRestrictionProc);
    if (results.finalChamberProc) logLines.push(results.finalChamberProc);
    if (results.blasterSentryProc) logLines.push(results.blasterSentryProc);
    if (results.oneLeftProc) logLines.push(results.oneLeftProc);
    if (results.krTickProc) logLines.push(results.krTickProc);
    if (results.insanityProc) logLines.push(results.insanityProc);
    if (results.insanityResetProc) logLines.push(results.insanityResetProc);
    if (results.omniDeflectFallback) logLines.push(results.omniDeflectFallback);
    if (results.boneShardsExpired) logLines.push(results.boneShardsExpired);
    // --- UPDATE 19: New battle log fields ---
    if (results.soulsHelpLog) results.soulsHelpLog.forEach(msg => logLines.push(msg));
    if (results.deathTouchTick) results.deathTouchTick.forEach(msg => logLines.push(msg));
    if (results.strifeWarning) logLines.push(results.strifeWarning);
    if (results.rkMarkNotice) logLines.push(results.rkMarkNotice);
    if (results.rkMarkUsed) logLines.push(results.rkMarkUsed);
    if (results.strifePurified) logLines.push(results.strifePurified);
    if (results.starShardsRecoil) logLines.push(results.starShardsRecoil);
    if (results.scytheProc) logLines.push(results.scytheProc);
    if (results.worldRevolving) logLines.push(results.worldRevolving);

    if (results.battleEnd) {
      // --- STORY MODE: hand a finished story battle back to story.js (win or loss) ---
      if (battle.storyContext && results.battleEnd.winner) {
        if (results.battleEnd.message) logLines.push(results.battleEnd.message);
        activeBattles.delete(userId);
        const sv = story.handleStoryBattleEnd(userId, results.battleEnd.winner, logLines);
        return interaction.update({ content: null, embeds: sv.embeds, components: sv.components });
      }
      if (results.battleEnd.autoSwitch) { logLines.push(results.battleEnd.message); }
      else if (results.battleEnd.winner === 'player') {
        logLines.push(results.battleEnd.message);
        // Get enemy/boss data
        const ed = battle.isBoss ? BOSSES[battle.enemyId] : ENEMIES[battle.enemyId];
        const rewards = battle.generateRewards(ed);
        // --- SCAMPTON EVENT: Big Shot Bow Tie — 1.5x Determination and Soul Essence from enemies ---
        const bowTieHeld = (battle.playerTeam || []).some(f => f.equipped === 'big_shot_bow_tie');
        if (bowTieHeld) { for (const r of rewards) { if (r.item === 'soul_essence') r.amount = Math.floor(r.amount * 1.5); } }
        // --- UPDATE 20: set superboss cooldown on WIN (client-side, 20 min) ---
        if (battle.isSuperboss) superbossCooldowns.set(userId, Date.now());

        // Handle boss-specific drops
        // --- UPDATE 22: Sacrifices must be made.. — record boss kills but skip ALL drops ---
        if (battle.isBoss && ed.rewards && battle._noChanceDrops) {
          playerDB.addBossClear(userId);
          if (battle.enemyId) playerDB.recordBossKillOrdered(userId, battle.enemyId);
          if (battle.enemyId && battle.activePlayer) playerDB.recordBossKillByChar(userId, battle.enemyId, battle.activePlayer.id);
        }
        if (battle.isBoss && ed.rewards && !battle._noChanceDrops) {
          // Track boss clear and grant Determination
          playerDB.addBossClear(userId);
          // --- UPDATE 13: Track ordered boss kills for Story of Undertale achievement ---
          if (battle.enemyId) playerDB.recordBossKillOrdered(userId, battle.enemyId);
          // --- UPDATE 20: Record which character dealt the final blow (Enlightened questline) ---
          if (battle.enemyId && battle.activePlayer) playerDB.recordBossKillByChar(userId, battle.enemyId, battle.activePlayer.id);
          // --- UPDATE 20: False Saviors Event — Hyper's Soul 0.1% drop from ANY boss ---
          if (Math.random() < 0.001) {
            playerDB.addItem(userId, 'hypers_soul', 1);
            rewards.push({ item: 'hypers_soul', amount: 1, name: "Hyper's Soul", emoji: '👻' });
          }
          // --- SCAMPTON EVENT: exclusive rewards ---
          if (battle.enemyId === 'scamton_the_great') {
            // Big Shot Bow Tie — one time only, ever
            const ownsTie = playerDB.hasItem(userId, 'big_shot_bow_tie', 1)
              || playerDB.getCharacters(userId).some(c => c.equipped === 'big_shot_bow_tie');
            if (!ownsTie) {
              playerDB.addItem(userId, 'big_shot_bow_tie', 1);
              rewards.push({ item: 'big_shot_bow_tie', amount: 1, name: 'Big Shot Bow Tie', emoji: '🎀' });
            }
            // 1 Rewritten Ticket, 10% chance of a second
            let tickets = 1;
            if (Math.random() < 0.10) tickets++;
            playerDB.addItem(userId, 'rewritten_ticket', tickets);
            rewards.push({ item: 'rewritten_ticket', amount: tickets, name: 'Rewritten Ticket', emoji: '🎫' });
          }
          if (ed.rewards.determination) {
            let det = Math.floor(Math.random() * (ed.rewards.determination.max - ed.rewards.determination.min + 1)) + ed.rewards.determination.min;
            if (bowTieHeld) det = Math.floor(det * 1.5);
            playerDB.addDetermination(userId, det);
            rewards.push({ item: 'determination', amount: det, name: 'Determination', emoji: '💪' });
          }
          if (ed.rewards.stolenFlames && Math.random() < ed.rewards.stolenFlames.chance) {
            playerDB.addItem(userId, 'stolen_flames', ed.rewards.stolenFlames.amount);
            rewards.push({ item: 'stolen_flames', amount: 1, name: 'Stolen Flames', emoji: '🔥' });
          }
          if (ed.rewards.blackhole && Math.random() < ed.rewards.blackhole.chance) {
            playerDB.addItem(userId, 'blackhole', ed.rewards.blackhole.amount);
            rewards.push({ item: 'blackhole', amount: 1, name: 'Blackhole', emoji: '🕳️' });
          }
          if (ed.rewards.papyrusScarf && Math.random() < ed.rewards.papyrusScarf.chance) {
            playerDB.addItem(userId, 'papyrus_scarf', ed.rewards.papyrusScarf.amount);
            rewards.push({ item: 'papyrus_scarf', amount: 1, name: "Papyrus' Scarf", emoji: '🧣' });
          }
          if (ed.rewards.orangeJacket && Math.random() < ed.rewards.orangeJacket.chance) {
            playerDB.addItem(userId, 'orange_jacket', ed.rewards.orangeJacket.amount);
            rewards.push({ item: 'orange_jacket', amount: 1, name: 'Orange Jacket', emoji: '🧡' });
          }
          if (ed.rewards.inkBrush && Math.random() < ed.rewards.inkBrush.chance) {
            playerDB.addItem(userId, 'ink_brush', ed.rewards.inkBrush.amount);
            rewards.push({ item: 'ink_brush', amount: 1, name: 'Ink Brush', emoji: '🖌️' });
          }
          if (ed.rewards.brokenClock && Math.random() < ed.rewards.brokenClock.chance) {
            playerDB.addItem(userId, 'broken_clock', ed.rewards.brokenClock.amount);
            rewards.push({ item: 'broken_clock', amount: 1, name: 'Broken Clock', emoji: '🕰️' });
          }
          if (ed.rewards.carBattery && Math.random() < ed.rewards.carBattery.chance) {
            playerDB.addItem(userId, 'car_battery', ed.rewards.carBattery.amount);
            rewards.push({ item: 'car_battery', amount: 1, name: 'Car Battery', emoji: '🔋' });
          }
          if (ed.rewards.brokenDtVial && Math.random() < ed.rewards.brokenDtVial.chance) {
            playerDB.addItem(userId, 'broken_dt_vial', ed.rewards.brokenDtVial.amount);
            rewards.push({ item: 'broken_dt_vial', amount: 1, name: 'Broken DT Vial', emoji: '🧪' });
          }
          if (ed.rewards.headDog && Math.random() < ed.rewards.headDog.chance) {
            playerDB.addItem(userId, 'head_dog', ed.rewards.headDog.amount);
            rewards.push({ item: 'head_dog', amount: 1, name: 'Head Dog', emoji: '🐶' });
          }
          if (ed.rewards.papyrusSkull && Math.random() < ed.rewards.papyrusSkull.chance) {
            playerDB.addItem(userId, 'papyrus_skull', ed.rewards.papyrusSkull.amount);
            rewards.push({ item: 'papyrus_skull', amount: 1, name: "Papyrus' Skull", emoji: '💀' });
          }
          if (ed.rewards.echoFlowers && Math.random() < ed.rewards.echoFlowers.chance) {
            playerDB.addItem(userId, 'echo_flowers', ed.rewards.echoFlowers.amount);
            rewards.push({ item: 'echo_flowers', amount: 1, name: 'Echo Flowers', emoji: '🌸' });
          }
          if (ed.rewards.theFlower && Math.random() < ed.rewards.theFlower.chance) {
            playerDB.addItem(userId, 'the_flower', ed.rewards.theFlower.amount);
            rewards.push({ item: 'the_flower', amount: 1, name: 'The Flower', emoji: '🌼' });
          }
          if (ed.rewards.gastersHands && Math.random() < ed.rewards.gastersHands.chance) {
            playerDB.addItem(userId, 'gasters_hands', ed.rewards.gastersHands.amount);
            rewards.push({ item: 'gasters_hands', amount: 1, name: "Gaster's Hands", emoji: '🖐️' });
          }
          if (ed.rewards.hisGuidance && Math.random() < ed.rewards.hisGuidance.chance) {
            playerDB.addItem(userId, 'his_guidance', ed.rewards.hisGuidance.amount);
            rewards.push({ item: 'his_guidance', amount: 1, name: 'His Guidance', emoji: '👁️' });
          }
          if (ed.rewards.dtInjector && Math.random() < ed.rewards.dtInjector.chance) {
            playerDB.addItem(userId, 'dt_injector', ed.rewards.dtInjector.amount);
            rewards.push({ item: 'dt_injector', amount: 1, name: 'DT Injector', emoji: '💉' });
          }
          if (ed.rewards.tier1MonsterSoul) {
            const amt = Math.floor(Math.random() * (ed.rewards.tier1MonsterSoul.max - ed.rewards.tier1MonsterSoul.min + 1)) + ed.rewards.tier1MonsterSoul.min;
            playerDB.addItem(userId, 'tier1_monster_soul', amt);
            rewards.push({ item: 'tier1_monster_soul', amount: amt, name: 'Tier 1 Monster Soul', emoji: '🔥' });
          }
          if (ed.rewards.tier2MonsterSoul && Math.random() < ed.rewards.tier2MonsterSoul.chance) {
            const amt = Math.floor(Math.random() * (ed.rewards.tier2MonsterSoul.max - ed.rewards.tier2MonsterSoul.min + 1)) + ed.rewards.tier2MonsterSoul.min;
            playerDB.addItem(userId, 'tier2_monster_soul', amt);
            rewards.push({ item: 'tier2_monster_soul', amount: amt, name: 'Tier 2 Monster Soul', emoji: '💎' });
          }
          if (ed.rewards.spear && Math.random() < ed.rewards.spear.chance) {
            playerDB.addItem(userId, 'spear', ed.rewards.spear.amount);
            rewards.push({ item: 'spear', amount: 1, name: 'Spear', emoji: '🔱' });
          }
          // --- UPDATE 13 boss drops ---
          if (ed.rewards.mafiaHat && Math.random() < ed.rewards.mafiaHat.chance) {
            playerDB.addItem(userId, 'mafia_hat', ed.rewards.mafiaHat.amount);
            rewards.push({ item: 'mafia_hat', amount: 1, name: 'Mafia Hat', emoji: '🎩' });
          }
          if (ed.rewards.neoCannon && Math.random() < ed.rewards.neoCannon.chance) {
            playerDB.addItem(userId, 'neo_cannon', ed.rewards.neoCannon.amount);
            rewards.push({ item: 'neo_cannon', amount: 1, name: 'Neo Cannon', emoji: '💥' });
          }
          if (ed.rewards.alphysTech && Math.random() < ed.rewards.alphysTech.chance) {
            playerDB.addItem(userId, 'alphys_tech', ed.rewards.alphysTech.amount);
            rewards.push({ item: 'alphys_tech', amount: 1, name: 'Alphys\' Tech', emoji: '🔧' });
          }
          if (ed.rewards.emptyGun && Math.random() < ed.rewards.emptyGun.chance) {
            playerDB.addItem(userId, 'empty_gun', ed.rewards.emptyGun.amount);
            rewards.push({ item: 'empty_gun', amount: 1, name: 'Empty Gun', emoji: '🔫' });
          }
          if (ed.rewards.cosmicDust && Math.random() < ed.rewards.cosmicDust.chance) {
            playerDB.addItem(userId, 'cosmic_dust', ed.rewards.cosmicDust.amount);
            rewards.push({ item: 'cosmic_dust', amount: 1, name: 'Cosmic Dust', emoji: '🌌' });
          }
          if (ed.rewards.vines && Math.random() < ed.rewards.vines.chance) {
            playerDB.addItem(userId, 'vines', ed.rewards.vines.amount);
            rewards.push({ item: 'vines', amount: 1, name: 'Vines', emoji: '🌿' });
          }
          // Omega Flowey: 1 guaranteed Human Soul, randomly chosen from 6
          if (ed.rewards.humanSoulRandom && Math.random() < ed.rewards.humanSoulRandom.chance) {
            const souls = ['patience', 'bravery', 'integrity', 'perseverance', 'kindness', 'justice'];
            const pick = souls[Math.floor(Math.random() * souls.length)];
            const itemId = pick + '_human_soul';
            const soulName = pick.charAt(0).toUpperCase() + pick.slice(1) + ' Human Soul';
            const emojiMap = { patience: '💙', bravery: '🧡', integrity: '💙', perseverance: '💜', kindness: '💚', justice: '💛' };
            playerDB.addItem(userId, itemId, ed.rewards.humanSoulRandom.amount);
            rewards.push({ item: itemId, amount: 1, name: soulName, emoji: emojiMap[pick] });
          }
          // Real Knife — 1/99 chance from ANY boss/encounter
          if (Math.random() < (1/99)) {
            playerDB.addItem(userId, 'real_knife', 1);
            rewards.push({ item: 'real_knife', amount: 1, name: 'Real Knife', emoji: '🔪' });
          }
          // --- UPDATE 17: Nightmare & FatalError boss drops ---
          if (ed.rewards.corruptApple && Math.random() < ed.rewards.corruptApple.chance) { playerDB.addItem(userId, 'corrupt_apple', ed.rewards.corruptApple.amount); rewards.push({ item: 'corrupt_apple', amount: 1, name: 'Corrupt Apple', emoji: '🍎' }); }
          if (ed.rewards.negativeEssence && Math.random() < ed.rewards.negativeEssence.chance) { playerDB.addItem(userId, 'negative_essence', ed.rewards.negativeEssence.amount); rewards.push({ item: 'negative_essence', amount: 1, name: 'Negative Essence', emoji: '🟣' }); }
          if (ed.rewards.killersSoul && Math.random() < ed.rewards.killersSoul.chance) { playerDB.addItem(userId, 'killers_soul', ed.rewards.killersSoul.amount); rewards.push({ item: 'killers_soul', amount: 1, name: "Killer's Soul", emoji: '🔪' }); }
          if (ed.rewards.corruption && Math.random() < ed.rewards.corruption.chance) { playerDB.addItem(userId, 'corruption', ed.rewards.corruption.amount); rewards.push({ item: 'corruption', amount: 1, name: 'Corruption', emoji: '🌑' }); }
          if (ed.rewards.fatalsBone && Math.random() < ed.rewards.fatalsBone.chance) { playerDB.addItem(userId, 'fatals_bone', ed.rewards.fatalsBone.amount); rewards.push({ item: 'fatals_bone', amount: 1, name: 'FATALS BONE', emoji: '🦴' }); }
          if (ed.rewards.glitchedStar && Math.random() < ed.rewards.glitchedStar.chance) { playerDB.addItem(userId, 'glitched_star', ed.rewards.glitchedStar.amount); rewards.push({ item: 'glitched_star', amount: 1, name: 'Glitched Star', emoji: '💫' }); }
          // --- UPDATE 17: Positive Essence universal drop (1/150 from any boss kill)
          if (Math.random() < (1/150)) { playerDB.addItem(userId, 'positive_essence', 1); rewards.push({ item: 'positive_essence', amount: 1, name: 'Positive Essence', emoji: '⭐' }); }
          // --- UPDATE 19: Roaring Knight boss drops ---
          if (ed.rewards.blackShard && Math.random() < (ed.rewards.blackShard.chance || 1.0)) {
            playerDB.addItem(userId, 'black_shard', ed.rewards.blackShard.amount || 1);
            rewards.push({ item: 'black_shard', amount: ed.rewards.blackShard.amount || 1, name: 'Black Shard', emoji: '🖤' });
          }
          if (ed.rewards.shadowCrystal && Math.random() < (ed.rewards.shadowCrystal.chance || 0.10)) {
            playerDB.addItem(userId, 'shadow_crystal', 1);
            rewards.push({ item: 'shadow_crystal', amount: 1, name: 'Shadow Crystal', emoji: '🔮' });
          }
          // expAllTeam: grant fixed EXP to every team member (Roaring Knight)
          if (ed.rewards.expAllTeam) {
            const bonusExp = ed.rewards.expAllTeam.amount || 100;
            playerDB.getTeam(userId).forEach(t => {
              playerDB.addExp(userId, t.character_row_id, bonusExp);
            });
            rewards.push({ item: 'exp_all', amount: bonusExp, name: `+${bonusExp} EXP (all team)`, emoji: '⭐' });
          }
          // --- UPDATE 19 BUG FIX: extraDrops from encounters (e.g. human soul enemies) ---
          if (ed.rewards.extraDrops && Array.isArray(ed.rewards.extraDrops)) {
            for (const drop of ed.rewards.extraDrops) {
              if (Math.random() < (drop.chance || 0)) {
                playerDB.addItem(userId, drop.item, 1);
                rewards.push({ item: drop.item, amount: 1, name: drop.name, emoji: drop.emoji });
              }
            }
          }
        }

        rewards.forEach(r => {
          if (r.item === 'soul_essence') playerDB.addSoulEssence(userId, r.amount);
          else if (r.item === 'exp_all') { /* handled above */ }
          // --- UPDATE 20 BUG FIX: VHS Tape, DT Soul, Umbrella, Sans Magic Eye, Ketchup Bottle, Stolen Slash, Administrator Permissions, and other items now properly added to inventory ---
          else if (!['stolen_flames','blackhole','papyrus_scarf','mafia_hat','neo_cannon','alphys_tech','empty_gun','cosmic_dust','vines','real_knife','corrupt_apple','negative_essence','killers_soul','corruption','fatals_bone','glitched_star','black_shard','shadow_crystal'].includes(r.item)) playerDB.addItem(userId, r.item, r.amount);
        });
        const expR = ed.rewards.exp; const expAmt = Math.floor(Math.random() * (expR.max - expR.min + 1)) + expR.min;
        const team = playerDB.getTeam(userId); const expResults = [];
        team.forEach(t => {
          const cd = CHARACTERS[t.character_id];
          const charExpAmt = cd?.doubleExp ? expAmt * 2 : expAmt;
          const before = t.exp || 0; const updated = playerDB.addExp(userId, t.character_row_id, charExpAmt);
          if (updated) { const ol = getLevelFromExp(before); const nl = getLevelFromExp(updated.exp); if (nl > ol) expResults.push(`**${cd?.name}** leveled up to **Level ${nl}**!`); }
        });
        // Kill count tracking + achievements
        if (battle.enemyId) playerDB.addKill(userId, battle.enemyId);
        // --- UPDATE 22: Sacrifices must be made.. — extra boss kills awarded ---
        if ((battle._extraBossKills || 0) > 0 && battle.enemyId) {
          for (let ki = 0; ki < battle._extraBossKills; ki++) playerDB.addKill(userId, battle.enemyId);
        }
        // Murder Sans sin counter — track kills with Sans on active slot
        if (battle.activePlayer?.name === 'Sans' || battle.playerTeam?.find(f => f.id === 'sans' && f.isAlive)) {
          const sinCount = playerDB.addMurderSin(userId);
          if (sinCount >= 50 && !playerDB.getPlayer(userId).murderReady) {
            playerDB.setMurderReady(userId, true);
          }
        }
        const achNotifs = [];
        // Big Hunter
        if (battle.enemyId === 'big_snowman') {
          const ach = grantAchievementIfNew(userId, 'big_hunter');
          if (ach) { playerDB.addItem(userId, 'dt_vial', ach.reward.dtVial); achNotifs.push(`🏆 Achievement: **${ach.name}**! (+${ach.reward.dtVial} DT Vials)`); }
        }
        // The Realest One Of All
        if (battle.enemyId === 'snowman_sans_costume') {
          const ach = grantAchievementIfNew(userId, 'the_realest');
          if (ach) { playerDB.addItem(userId, 'monster_soul', ach.reward.monster_soul); achNotifs.push(`🏆 Achievement: **${ach.name}**! (+1 Monster Soul)`); }
          // Confronting Yourself - only if team had exactly 1 Sans
          const teamChars = playerDB.getTeam(userId);
          const soloSans = teamChars.length === 1 && teamChars[0].character_id === 'sans';
          if (soloSans) {
            const ach2 = grantAchievementIfNew(userId, 'confronting_yourself');
            if (ach2) { playerDB.addItem(userId, 'monster_soul', ach2.reward.monster_soul); playerDB.addItem(userId, 'star_piece', ach2.reward.star_piece); achNotifs.push(`🏆 Achievement: **${ach2.name}**! (+2 Monster Souls, +2 Star Pieces)`); }
          }
        }
        // Snowman Massacre - 100 kills
        if (battle.enemyId === 'snowman') {
          const kills = playerDB.getKillCount(userId, 'snowman');
          if (kills >= 100) {
            const ach = grantAchievementIfNew(userId, 'snowman_massacre');
            if (ach) { playerDB.addItem(userId, 'dt_vial', ach.reward.dtVial); achNotifs.push(`🏆 Achievement: **${ach.name}**! (+10 DT Vials)`); }
          }
        }
        // Check shiny achievement
        const allChars = playerDB.getCharacters(userId);
        if (allChars.some(ch => ch.shiny)) {
          const ach = grantAchievementIfNew(userId, 'ooo_shiny');
          if (ach) { playerDB.addSoulEssence(userId, ach.reward.soulEssence); achNotifs.push(`🏆 Achievement: **${ach.name}**! (+40 Soul Essence)`); }
        }
        // Check full team achievement
        if (playerDB.getTeamSize(userId) >= 6) {
          const ach = grantAchievementIfNew(userId, 'you_cannot_beat_us');
          if (ach) { playerDB.addItem(userId, 'monster_soul', ach.reward.monster_soul); playerDB.addSoulEssence(userId, ach.reward.soulEssence); achNotifs.push(`🏆 Achievement: **${ach.name}**! (+1 Monster Soul, +35 Soul Essence)`); }
        }
        // Level 5 achievement
        expResults.forEach(msg => { if (msg.includes('Level 5')) {
          const ach = grantAchievementIfNew(userId, 'limit_reached');
          if (ach) { playerDB.addSoulEssence(userId, ach.reward.soulEssence); achNotifs.push(`🏆 Achievement: **${ach.name}**! (+25 Soul Essence)`); }
        }});
        // --- BUGFIX: BROKEN LIMITS was defined but never granted anywhere. ---
        // Condition (per achievement description): total EXP >= 5000 across all owned JHall Dust Sans.
        {
          const jhTotal = playerDB.getCharacters(userId)
            .filter(c => c.character_id === 'judgement_hall_dust_sans')
            .reduce((sum, c) => sum + (c.exp || 0), 0);
          if (jhTotal >= 5000) {
            const ach = grantAchievementIfNew(userId, 'broken_limits');
            if (ach) { playerDB.addItem(userId, 'flame_eye_item', ach.reward.flame_eye_item); achNotifs.push(`🏆 Achievement: **${ach.name}**! (+1 Flame Eye)`); }
          }
        }
        // ============================================================
        // === UPDATE 13 ACHIEVEMENTS ===
        // ============================================================
        // Story of Undertale — defeat Toriel→Papyrus→Undyne→Mettaton NEO→Asgore in order
        if (battle.isBoss && battle.enemyId === 'asgore') {
          const order = playerDB.getBossKillOrder(userId);
          const targets = ['toriel', 'papyrus', 'undyne', 'mettaton_neo', 'asgore'];
          // Walk through history, finding each target after the previous one's position
          let cursor = -1;
          let inOrder = true;
          for (const t of targets) {
            const found = order.indexOf(t, cursor + 1);
            if (found === -1) { inOrder = false; break; }
            cursor = found;
          }
          if (inOrder) {
            const ach = grantAchievementIfNew(userId, 'story_of_undertale');
            if (ach) { playerDB.addDtVials(userId, ach.reward.dtVial); achNotifs.push(`🏆 Achievement: **${ach.name}**! (+${ach.reward.dtVial} DT Vials)`); }
          }
          // --- UPDATE 22: Guess they can do something on their own afterall. — 5 base bosses in order with only 1 character left alive ---
          if (inOrder && battle.playerTeam.filter(f => f.isAlive).length === 1) {
            const ach22 = grantAchievementIfNew(userId, 'guess_they_can');
            if (ach22) {
              playerDB.addItem(userId, 'their_dying_wishes', 1);
              playerDB.addDtVials(userId, ach22.reward.dtVial);
              achNotifs.push(`🏆 Achievement: **${ach22.name}**! (+🕯️ **Their Dying Wishes**, +${ach22.reward.dtVial} DT Vials)`);
            }
          }
        }
        // This Truly was our Dusttale — own all 6 dust evolutions
        const ownedCharIds = playerDB.getCharacters(userId).map(c => c.character_id);
        const dustLine = ['ruins_dust_sans', 'snowdin_dust_sans', 'waterfall_dust_sans', 'hotlands_dust_sans', 'core_dust_sans', 'judgement_hall_dust_sans'];
        if (dustLine.every(d => ownedCharIds.includes(d))) {
          const ach = grantAchievementIfNew(userId, 'this_truly_was_our_dusttale');
          if (ach) { playerDB.addDtVials(userId, ach.reward.dtVial); achNotifs.push(`🏆 Achievement: **${ach.name}**! (+${ach.reward.dtVial} DT Vials)`); }
        }
        // Rejuvenation — beat Undyne or above with only Sans + Papyrus
        if (battle.isBoss && ['undyne', 'wd_gaster', 'time_paradox_boss', 'asgore', 'mafia_sans_boss', 'mettaton_neo', 'omega_flowey'].includes(battle.enemyId)) {
          const teamData = playerDB.getTeam(userId);
          const onlySansAndPap = teamData.length > 0 && teamData.every(t => t.character_id === 'sans' || t.character_id === 'papyrus');
          if (onlySansAndPap) {
            const ach = grantAchievementIfNew(userId, 'rejuvenation');
            if (ach) { playerDB.addDtVials(userId, ach.reward.dtVial); playerDB.addSoulEssence(userId, ach.reward.soulEssence); achNotifs.push(`🏆 Achievement: **${ach.name}**! (+${ach.reward.dtVial} DT Vials, +${ach.reward.soulEssence} SE)`); }
          }
        }
        // Dad's Assistance — natural shiny Last Breath Sans AND natural shiny Revenge Papyrus
        const fullChars = playerDB.getCharacters(userId);
        const hasNaturalShinyLB = fullChars.some(c => c.character_id === 'last_breath_sans' && c.naturalShiny);
        const hasNaturalShinyRP = fullChars.some(c => c.character_id === 'revenge_papyrus' && c.naturalShiny);
        if (hasNaturalShinyLB && hasNaturalShinyRP) {
          const ach = grantAchievementIfNew(userId, 'dads_assistance');
          if (ach) { playerDB.addDtVials(userId, ach.reward.dtVial); achNotifs.push(`🏆 Achievement: **${ach.name}**! (+${ach.reward.dtVial} DT Vials)`); }
        }
        // Remember son, Dying is gay — survived with active Last Breath Sans at ≤5% HP
        if (battle.activePlayer && battle.activePlayer.id === 'last_breath_sans') {
          const hpRatio = battle.activePlayer.currentHp / (battle.activePlayer.maxHp || 1);
          if (hpRatio > 0 && hpRatio <= 0.05) {
            const ach = grantAchievementIfNew(userId, 'remember_son');
            if (ach) { playerDB.addDtVials(userId, ach.reward.dtVial); achNotifs.push(`🏆 Achievement: **${ach.name}**! (+${ach.reward.dtVial} DT Vial)`); }
          }
        }
        // Truly Insane — full team of Insanity variants
        const insanityIds = ['insanity_sans', 'c_insanity_weak', 'c_insanity', 'final_insanity'];
        const teamData = playerDB.getTeam(userId);
        if (teamData.length === 6 && teamData.every(t => insanityIds.includes(t.character_id))) {
          const ach = grantAchievementIfNew(userId, 'truly_insane');
          if (ach) { playerDB.addDtVials(userId, ach.reward.dtVial); achNotifs.push(`🏆 Achievement: **${ach.name}**! (+${ach.reward.dtVial} DT Vials)`); }
        }
        // Crazed Vengance — own Final Insanity AND Avenge Sans
        if (ownedCharIds.includes('final_insanity') && ownedCharIds.includes('avenge_sans')) {
          const ach = grantAchievementIfNew(userId, 'crazed_vengance');
          if (ach) { playerDB.addDtVials(userId, ach.reward.dtVial); achNotifs.push(`🏆 Achievement: **${ach.name}**! (+${ach.reward.dtVial} DT Vials)`); }
        }
        // How Do I Keep Missing — 3+ consecutive misses (tracked on battle)
        if (battle._consecutiveMisses && battle._consecutiveMisses >= 3) {
          const ach = grantAchievementIfNew(userId, 'how_do_i_keep_missing');
          if (ach) { achNotifs.push(`🏆 Achievement: **${ach.name}**! (...nothing, congrats lol)`); }
        }
        // ============================================================
        // === UPDATE 19 ACHIEVEMENTS ===
        // ============================================================
        // We're Stronger Together — beat Roaring Knight with Kris, Susie, Ralsei all alive
        if (battle.enemyId === 'roaring_knight_boss') {
          const teamChars = playerDB.getTeam(userId);
          const teamIds = teamChars.map(t => t.character_id);
          const allAlive = battle.playerTeam.filter(f => f.isAlive).map(f => f.id);
          const hasKris = teamIds.includes('kris') && allAlive.includes('kris');
          const hasSusie = teamIds.includes('susie') && allAlive.includes('susie');
          const hasRalsei = teamIds.includes('ralsei') && allAlive.includes('ralsei');
          if (hasKris && hasSusie && hasRalsei) {
            const ach = grantAchievementIfNew(userId, 'were_stronger_together');
            if (ach) {
              playerDB.addDetermination(userId, ach.reward.determination);
              playerDB.addSoulEssence(userId, ach.reward.soulEssence);
              achNotifs.push(`🏆 Achievement: **${ach.name}**! (+250 Determination, +750 Soul Essence)`);
            }
          }
        }
        // ============================================================
        // === END UPDATE 19 ACHIEVEMENTS ===
        // ============================================================
        // ============================================================
        // === END UPDATE 13 ACHIEVEMENTS ===
        // ============================================================
        if (achNotifs.length) expResults.push(...achNotifs);

        activeBattles.delete(userId);
        const title = battle.isBoss ? `${ed.name} (Boss)` : ed.name;
        // --- SCAMPTON EVENT: closing dialog before the reward screen ---
        if (battle.enemyId === 'scamton_the_great') {
          return interaction.update({ content: null, embeds: [
            embeds.battleLog(logLines),
            { color: 0xff0033, title: 'SCAMPTON [[THE GREAT]] — DEFEATED', description: SCAMTON_POST_DIALOG },
            embeds.victory(title, rewards, expAmt, expResults),
          ], components: [] });
        }
        return interaction.update({ content: null, embeds: [embeds.battleLog(logLines), embeds.victory(title, rewards, expAmt, expResults)], components: [] });
      } else if (results.battleEnd.winner === 'enemy') {
        logLines.push(results.battleEnd.message); activeBattles.delete(userId);
        const ed = battle.isBoss ? BOSSES[battle.enemyId] : ENEMIES[battle.enemyId];
        return interaction.update({ content: null, embeds: [embeds.battleLog(logLines), embeds.defeat(ed.name)], components: [] });
      }
    }
    const state = battle.getBattleState();
    // --- SCAMPTON EVENT: a minigame just went live — start its countdown ---
    if (battle._neoMinigame || battle._pendingCards) {
      await interaction.update({ content: null, embeds: [embeds.battleLog(logLines), embeds.battleState(state)], components: embeds.abilityButtons(state) });
      armMinigameTimer(battle, interaction.message, userId);
      return;
    }
    return interaction.update({ content: null, embeds: [embeds.battleLog(logLines), embeds.battleState(state)], components: embeds.abilityButtons(state) });
  }

  if (customId === 'switch_char') {
    const team = playerDB.getTeam(userId);
    if (team.length <= 1) return interaction.reply({ content: 'Only one character on your team!', ephemeral: true });
    return interaction.reply({ content: 'Choose a character:', components: [embeds.switchMenu(team, battle.activePlayerIndex)], ephemeral: true });
  }

  if (customId === 'skip_turn') {
    // Skip turn: 10% chance to dodge next attack
    const dodgeRoll = Math.random() < 0.1;
    const player = battle.activePlayer;
    if (dodgeRoll) player.dodgeNextAttack = true;
    battle.turnNumber++; player.turnCount++;
    const logLines = [`**${player.name}** skips their turn!${dodgeRoll ? ' They prepare to **dodge** the next attack!' : ''}`];
    const enemyAction = battle.executeEnemyTurn();
    if (enemyAction?.message) logLines.push(enemyAction.message);
    battle.endTurn({ statusTick: [], enemyStatusTick: [], battleEnd: null }, player);
    const battleEnd = battle.checkBattleEnd();
    if (battleEnd && battleEnd.winner) {
      // --- STORY MODE bridge ---
      if (battle.storyContext) {
        if (battleEnd.message) logLines.push(battleEnd.message);
        activeBattles.delete(userId);
        const sv = story.handleStoryBattleEnd(userId, battleEnd.winner, logLines);
        return interaction.update({ content: null, embeds: sv.embeds, components: sv.components });
      }
      if (battleEnd.winner === 'enemy') {
        logLines.push(battleEnd.message); activeBattles.delete(userId);
        const ed = battle.isBoss ? BOSSES[battle.enemyId] : ENEMIES[battle.enemyId];
        return interaction.update({ content: null, embeds: [embeds.battleLog(logLines), embeds.defeat(ed.name)], components: [] });
      }
    }
    const state = battle.getBattleState();
    return interaction.update({ content: null, embeds: [embeds.battleLog(logLines), embeds.battleState(state)], components: embeds.abilityButtons(state) });
  }

  if (customId === 'team_ability') {
    if (!battle.isBoss) return interaction.reply({ content: 'Team Abilities are only available in boss fights!', ephemeral: true });
    if (battle.teamAbilityCooldown > 0) return interaction.reply({ content: `Team Ability on cooldown! (${battle.teamAbilityCooldown} turns)`, ephemeral: true });
    const team = playerDB.getTeam(userId);
    const teamIds = team.map(t => t.character_id);
    const logLines = [];
    let used = false;

    // NO EFFECT: WD Gaster + Last Breath Sans (LB must be active) OR WD Gaster + Revenge Papyrus
    const hasGaster = teamIds.includes('wd_gaster');
    const hasLB = teamIds.includes('last_breath_sans');
    const hasRevPap = teamIds.includes('revenge_papyrus');
    const lbIsActive = battle.activePlayer.id === 'last_breath_sans';
    const revPapIsActive = hasRevPap; // either can be active
    if (hasGaster && ((hasLB && lbIsActive) || hasRevPap)) {
      const target = battle.activePlayer;
      target._noEffectShield = true;
      target._noEffectShieldTurns = 3;
      target._noEffectShieldThreshold = 150;
      logLines.push(`🖐️ **W.D. Gaster** casts a shield around **${target.name}**! **NO EFFECT** — Shield blocks hits under 150 DMG for 3 turns!`);
      used = true;
    }

    // THE BIG BANG: Outertale Sans + M87
    if (!used) {
      const hasOuter = teamIds.includes('outertale_sans');
      const hasM87 = teamIds.includes('m87');
      if (hasOuter && hasM87) {
        const outerFighter = battle.playerTeam.find(f => f.id === 'outertale_sans');
        const m87Fighter = battle.playerTeam.find(f => f.id === 'm87');
        if (!outerFighter || !outerFighter.isAlive) return interaction.reply({ content: 'Outertale Sans is no longer alive — **The Big Bang** can\'t be used!', ephemeral: true });
        const dmg = Math.floor(Math.random() * (210 - 165 + 1)) + 165;
        battle.enemy.takeDamage(dmg);
        battle.enemy.addStatus('stun');
        battle.enemy.addStatus('stun'); // 2 turns
        outerFighter.currentHp = 0;
        if (m87Fighter) m87Fighter.takeDamage(120);
        logLines.push(`✨💥 **Outertale Sans** and **M87** conjure **THE BIG BANG**! **${dmg}** damage! Boss **Stunned** for 2 turns!`);
        logLines.push(`**Outertale Sans** unfortunately dies from the impact... **M87** takes **120** damage onto himself!`);
        used = true;
      }
    }

    // FOR THEM! (UV Swap Sans + Underswap Papyrus)
    if (!used) {
      const hasUVSwap = teamIds.includes('uv_swap_sans');
      const hasUSPap = teamIds.includes('underswap_papyrus');
      if (hasUVSwap && hasUSPap) {
        const uvFighter = battle.playerTeam.find(f => f.id === 'uv_swap_sans');
        const usPapFighter = battle.playerTeam.find(f => f.id === 'underswap_papyrus');
        if (uvFighter?._forThemUsed) return interaction.reply({ content: '**FOR THEM!** has already been used this battle!', ephemeral: true });
        if (!usPapFighter?.isAlive) return interaction.reply({ content: '**Underswap Papyrus** is no longer alive!', ephemeral: true });
        usPapFighter.currentHp = 0;
        uvFighter.heal(75);
        uvFighter.atkMod += 5; uvFighter.defMod -= 2;
        uvFighter._forThemUsed = true;
        logLines.push(`💙 **FOR THEM!** — **Underswap Papyrus** sacrifices themselves! **UV Swap Sans** heals **75 HP**, gains **+5 ATK**, loses **-2 DEF**!`);
        used = true;
      }
    }

    if (!used) return interaction.reply({ content: 'No valid Team Ability combination found! Check the requirements.', ephemeral: true });
    battle.teamAbilityCooldown = 5;
    battle.turnNumber++;
    const battleEnd = battle.checkBattleEnd();
    if (battleEnd?.winner === 'player') {
      // --- STORY MODE bridge ---
      if (battle.storyContext) {
        logLines.push(`**${battle.enemy.name}** has been defeated!`);
        activeBattles.delete(userId);
        const sv = story.handleStoryBattleEnd(userId, 'player', logLines);
        return interaction.update({ content: null, embeds: sv.embeds, components: sv.components });
      }
      logLines.push(`**${battle.enemy.name}** has been defeated!`);
      const ed = BOSSES[battle.enemyId];
      const rewards = battle.generateRewards(ed);
      // --- UPDATE 20: set superboss cooldown on WIN (client-side, 20 min) ---
      if (battle.isSuperboss) superbossCooldowns.set(userId, Date.now());
      if (battle.isBoss && ed.rewards) {
        playerDB.addBossClear(userId);
        // --- UPDATE 20: Record which character dealt the final blow (Enlightened questline) ---
        if (battle.enemyId && battle.activePlayer) playerDB.recordBossKillByChar(userId, battle.enemyId, battle.activePlayer.id);
        // --- UPDATE 20: False Saviors Event — Hyper's Soul 0.1% drop from ANY boss ---
        if (Math.random() < 0.001) { playerDB.addItem(userId, 'hypers_soul', 1); rewards.push({ item: 'hypers_soul', amount: 1, name: "Hyper's Soul", emoji: '👻' }); }
        if (ed.rewards.determination) { const det = Math.floor(Math.random() * (ed.rewards.determination.max - ed.rewards.determination.min + 1)) + ed.rewards.determination.min; playerDB.addDetermination(userId, det); rewards.push({ item: 'determination', amount: det, name: 'Determination', emoji: '💪' }); }
        if (ed.rewards.stolenFlames && Math.random() < ed.rewards.stolenFlames.chance) { playerDB.addItem(userId, 'stolen_flames', ed.rewards.stolenFlames.amount); rewards.push({ item: 'stolen_flames', amount: 1, name: 'Stolen Flames', emoji: '🔥' }); }
        if (ed.rewards.papyrusScarf && Math.random() < ed.rewards.papyrusScarf.chance) { playerDB.addItem(userId, 'papyrus_scarf', ed.rewards.papyrusScarf.amount); rewards.push({ item: 'papyrus_scarf', amount: 1, name: "Papyrus' Scarf", emoji: '🧣' }); }
        if (ed.rewards.orangeJacket && Math.random() < ed.rewards.orangeJacket.chance) { playerDB.addItem(userId, 'orange_jacket', ed.rewards.orangeJacket.amount); rewards.push({ item: 'orange_jacket', amount: 1, name: 'Orange Jacket', emoji: '🧡' }); }
        if (ed.rewards.headDog && Math.random() < ed.rewards.headDog.chance) { playerDB.addItem(userId, 'head_dog', ed.rewards.headDog.amount); rewards.push({ item: 'head_dog', amount: 1, name: 'Head Dog', emoji: '🐶' }); }
        if (ed.rewards.papyrusSkull && Math.random() < ed.rewards.papyrusSkull.chance) { playerDB.addItem(userId, 'papyrus_skull', ed.rewards.papyrusSkull.amount); rewards.push({ item: 'papyrus_skull', amount: 1, name: "Papyrus' Skull", emoji: '💀' }); }
        if (ed.rewards.echoFlowers && Math.random() < ed.rewards.echoFlowers.chance) { playerDB.addItem(userId, 'echo_flowers', ed.rewards.echoFlowers.amount); rewards.push({ item: 'echo_flowers', amount: 1, name: 'Echo Flowers', emoji: '🌸' }); }
        if (ed.rewards.theFlower && Math.random() < ed.rewards.theFlower.chance) { playerDB.addItem(userId, 'the_flower', ed.rewards.theFlower.amount); rewards.push({ item: 'the_flower', amount: 1, name: 'The Flower', emoji: '🌼' }); }
        if (ed.rewards.gastersHands && Math.random() < ed.rewards.gastersHands.chance) { playerDB.addItem(userId, 'gasters_hands', ed.rewards.gastersHands.amount); rewards.push({ item: 'gasters_hands', amount: 1, name: "Gaster's Hands", emoji: '🖐️' }); }
        if (ed.rewards.hisGuidance && Math.random() < ed.rewards.hisGuidance.chance) { playerDB.addItem(userId, 'his_guidance', ed.rewards.hisGuidance.amount); rewards.push({ item: 'his_guidance', amount: 1, name: 'His Guidance', emoji: '👁️' }); }
        if (ed.rewards.dtInjector && Math.random() < ed.rewards.dtInjector.chance) { playerDB.addItem(userId, 'dt_injector', ed.rewards.dtInjector.amount); rewards.push({ item: 'dt_injector', amount: 1, name: 'DT Injector', emoji: '💉' }); }
        if (ed.rewards.inkBrush && Math.random() < ed.rewards.inkBrush.chance) { playerDB.addItem(userId, 'ink_brush', ed.rewards.inkBrush.amount); rewards.push({ item: 'ink_brush', amount: 1, name: 'Ink Brush', emoji: '🖌️' }); }
        if (ed.rewards.brokenClock && Math.random() < ed.rewards.brokenClock.chance) { playerDB.addItem(userId, 'broken_clock', ed.rewards.brokenClock.amount); rewards.push({ item: 'broken_clock', amount: 1, name: 'Broken Clock', emoji: '🕰️' }); }
        if (ed.rewards.carBattery && Math.random() < ed.rewards.carBattery.chance) { playerDB.addItem(userId, 'car_battery', ed.rewards.carBattery.amount); rewards.push({ item: 'car_battery', amount: 1, name: 'Car Battery', emoji: '🔋' }); }
        if (ed.rewards.spear && Math.random() < ed.rewards.spear.chance) { playerDB.addItem(userId, 'spear', ed.rewards.spear.amount); rewards.push({ item: 'spear', amount: 1, name: 'Spear', emoji: '🔱' }); }
        if (ed.rewards.timeOrb && Math.random() < ed.rewards.timeOrb.chance) { playerDB.addItem(userId, 'time_orb', ed.rewards.timeOrb.amount); rewards.push({ item: 'time_orb', amount: 1, name: 'Time Orb', emoji: '🔵' }); }
        if (ed.rewards.agoresTrident && Math.random() < ed.rewards.agoresTrident.chance) { playerDB.addItem(userId, 'asgores_trident', ed.rewards.agoresTrident.amount); rewards.push({ item: 'asgores_trident', amount: 1, name: "Asgore's Trident", emoji: '🔱' }); }
        if (ed.rewards.crownOfTheKing && Math.random() < ed.rewards.crownOfTheKing.chance) { playerDB.addItem(userId, 'crown_of_the_king', ed.rewards.crownOfTheKing.amount); rewards.push({ item: 'crown_of_the_king', amount: 1, name: 'Crown of the King', emoji: '👑' }); }
        if (ed.rewards.tier3MonsterSoul && Math.random() < ed.rewards.tier3MonsterSoul.chance) { const amt = Math.floor(Math.random() * (ed.rewards.tier3MonsterSoul.max - ed.rewards.tier3MonsterSoul.min + 1)) + ed.rewards.tier3MonsterSoul.min; playerDB.addItem(userId, 'tier3_monster_soul', amt); rewards.push({ item: 'tier3_monster_soul', amount: amt, name: 'Tier 3 Monster Soul', emoji: '💎' }); }
        if (ed.rewards.tier1MonsterSoul) { const amt = Math.floor(Math.random() * (ed.rewards.tier1MonsterSoul.max - ed.rewards.tier1MonsterSoul.min + 1)) + ed.rewards.tier1MonsterSoul.min; playerDB.addItem(userId, 'tier1_monster_soul', amt); rewards.push({ item: 'tier1_monster_soul', amount: amt, name: 'Tier 1 Monster Soul', emoji: '🔥' }); }
        if (ed.rewards.tier2MonsterSoul && Math.random() < ed.rewards.tier2MonsterSoul.chance) { const amt = Math.floor(Math.random() * (ed.rewards.tier2MonsterSoul.max - ed.rewards.tier2MonsterSoul.min + 1)) + ed.rewards.tier2MonsterSoul.min; playerDB.addItem(userId, 'tier2_monster_soul', amt); rewards.push({ item: 'tier2_monster_soul', amount: amt, name: 'Tier 2 Monster Soul', emoji: '💎' }); }
        // --- UPDATE 19: RK boss drops + extraDrops fix ---
        if (ed.rewards.blackShard && Math.random() < (ed.rewards.blackShard.chance || 1.0)) { playerDB.addItem(userId, 'black_shard', ed.rewards.blackShard.amount || 1); rewards.push({ item: 'black_shard', amount: ed.rewards.blackShard.amount || 1, name: 'Black Shard', emoji: '🖤' }); }
        if (ed.rewards.shadowCrystal && Math.random() < (ed.rewards.shadowCrystal.chance || 0.10)) { playerDB.addItem(userId, 'shadow_crystal', 1); rewards.push({ item: 'shadow_crystal', amount: 1, name: 'Shadow Crystal', emoji: '🔮' }); }
        if (ed.rewards.expAllTeam) { const bonusExp2 = ed.rewards.expAllTeam.amount || 100; playerDB.getTeam(userId).forEach(t => playerDB.addExp(userId, t.character_row_id, bonusExp2)); rewards.push({ item: 'exp_all', amount: bonusExp2, name: `+${bonusExp2} EXP (all team)`, emoji: '⭐' }); }
        if (ed.rewards.extraDrops && Array.isArray(ed.rewards.extraDrops)) { for (const drop of ed.rewards.extraDrops) { if (Math.random() < (drop.chance || 0)) { playerDB.addItem(userId, drop.item, 1); rewards.push({ item: drop.item, amount: 1, name: drop.name, emoji: drop.emoji }); } } }
        if (Math.random() < (1/150)) { playerDB.addItem(userId, 'positive_essence', 1); rewards.push({ item: 'positive_essence', amount: 1, name: 'Positive Essence', emoji: '⭐' }); }
      }
      rewards.forEach(r => {
        if (r.item === 'soul_essence') playerDB.addSoulEssence(userId, r.amount);
        else if (r.item === 'exp_all') { /* handled above */ }
        // --- UPDATE 20 BUG FIX: VHS Tape, DT Soul, Umbrella, Sans Magic Eye, Ketchup Bottle, Stolen Slash, Administrator Permissions, and other items now properly added to inventory ---
        else if (!['stolen_flames','blackhole','papyrus_scarf','determination','mafia_hat','neo_cannon','alphys_tech','empty_gun','cosmic_dust','vines','real_knife','corrupt_apple','negative_essence','killers_soul','corruption','fatals_bone','glitched_star','black_shard','shadow_crystal'].includes(r.item)) playerDB.addItem(userId, r.item, r.amount);
      });
      const expR = ed.rewards.exp; const expAmt = Math.floor(Math.random() * (expR.max - expR.min + 1)) + expR.min;
      const teamDb = playerDB.getTeam(userId); const expResults = [];
      teamDb.forEach(t => { const cd = CHARACTERS[t.character_id]; const charExpAmt = cd?.doubleExp ? expAmt * 2 : expAmt; const before = t.exp || 0; const updated = playerDB.addExp(userId, t.character_row_id, charExpAmt); if (updated) { const ol = getLevelFromExp(before); const nl = getLevelFromExp(updated.exp); if (nl > ol) expResults.push(`**${cd?.name}** leveled up to **Level ${nl}**!`); } });
      if (battle.enemyId) playerDB.addKill(userId, battle.enemyId);
      activeBattles.delete(userId);
      const title = `${ed.name} (Boss)`;
      return interaction.update({ content: null, embeds: [embeds.battleLog(logLines), embeds.victory(title, rewards, expAmt, expResults)], components: [] });
    }
    const state = battle.getBattleState();
    return interaction.update({ content: null, embeds: [embeds.battleLog(logLines), embeds.battleState(state)], components: embeds.abilityButtons(state) });
  }

  if (customId === 'run_away') {
    // --- STORY MODE: fleeing a story battle returns to its intro so it can be retried ---
    if (battle.storyContext) {
      activeBattles.delete(userId);
      const sv = story.handleStoryBattleEnd(userId, 'flee', ['You slip back out of the tear.']);
      return interaction.update({ content: null, embeds: sv.embeds, components: sv.components });
    }
    activeBattles.delete(userId);
    return interaction.update({ content: 'You ran away!', embeds: [], components: [] });
  }

  // /use paginated navigation
  if (customId.startsWith('use_prev_') || customId.startsWith('use_next_')) {
    const parts = customId.split('_');
    const dir = parts[1]; // 'prev' or 'next'
    const currentPage = parseInt(parts[2]);
    const newPage = dir === 'next' ? currentPage + 1 : currentPage - 1;
    if (newPage < 0 || newPage >= USE_PAGES.length) return interaction.deferUpdate();
    return interaction.update(buildUsePage(newPage));
  }
}

async function handleSelectMenu(interaction) {
  const userId = interaction.user.id;

  // --- ?????? (Jevil) relic equip/unequip select menus ---
  // --- SCAMPTON EVENT: Big Shot Bow Tie equip ---
  if (interaction.customId === 'bowtie_equip') {
    if (!playerDB.hasItem(userId, 'big_shot_bow_tie', 1)) return interaction.update({ content: 'You no longer have the **🎀 Big Shot Bow Tie**!', components: [] });
    const p = playerDB.ensurePlayer(userId);
    const charId = parseInt(interaction.values[0]);
    const ch = p.characters.find(c => c.id === charId);
    if (!ch) return interaction.update({ content: 'Character not found.', components: [] });
    let swapMsg = '';
    if (ch.equipped) {
      playerDB.addItem(userId, ch.equipped, 1);
      swapMsg = ` (returned **${ITEMS[ch.equipped]?.name || ch.equipped}** to your inventory)`;
    }
    playerDB.removeItem(userId, 'big_shot_bow_tie', 1);
    ch.equipped = 'big_shot_bow_tie';
    playerDB.addSoulEssence(userId, 0);
    const d = CHARACTERS[ch.character_id];
    return interaction.update({ content: `🎀 Equipped the **Big Shot Bow Tie** to **${d?.name || ch.character_id}** (ID ${ch.id})${swapMsg}.\n*1.5x Determination and Soul Essence from enemies while held.*`, components: [] });
  }

  if (interaction.customId.startsWith('jevil_equip_') || interaction.customId === 'jevil_unequip') {
    return jevil.handleJevilSelect(interaction);
  }

  if (interaction.customId === 'shinystar_select') {
    const charId = parseInt(interaction.values[0].split('_')[1]);
    const p = playerDB.getPlayer(userId);
    if (!p) return interaction.reply({ content: 'Something went wrong!', ephemeral: true });
    const ch = p.characters.find(c => c.id === charId);
    if (!ch) return interaction.update({ content: 'Character not found!', components: [] });
    if (ch.shiny) return interaction.update({ content: 'That character is already shiny!', components: [] });
    // --- UPDATE 18: refuseShiny check (e.g. Nightmare Sans)
    const charDef = CHARACTERS[ch.character_id];
    if (charDef?.refuseShiny) return interaction.update({ content: `❌ **${charDef.name}** refuses the Shiny Star — *"the darkness overrules it."* Your Shiny Star was not consumed.`, components: [] });
    // --- UPDATE 20: Enlightened characters cannot be shiny (they're already enlightened)
    if (charDef?.canBeShiny === false) return interaction.update({ content: `❌ **${charDef.name}** cannot be made shiny — *it's already enlightened.* Your Shiny Star was not consumed.`, components: [] });

    // Check if from shop purchase (pending) or /use item
    const pending = pendingShinyPurchase.get(userId);
    if (pending && Date.now() - pending.timestamp < 300000) {
      pendingShinyPurchase.delete(userId);
      playerDB.addDetermination(userId, -pending.price);
    } else {
      if (!playerDB.hasItem(userId, 'shiny_star', 1)) return interaction.update({ content: '❌ You no longer have a Shiny Star!', components: [] });
      playerDB.removeItem(userId, 'shiny_star', 1);
    }

    ch.shiny = true;
    playerDB.addExp(userId, charId, 0);
    const cd = CHARACTERS[ch.character_id];
    return interaction.update({ content: `✨ The Shiny Star glows!\n\nYour **${cd?.name || ch.character_id}** [ID: ${charId}] is now **✦ SHINY ✦**! (+2 ATK, +2 DEF)`, components: [] });
  }

  const battle = activeBattles.get(userId);
  if (!battle) return interaction.reply({ content: 'You\'re not in a battle!', ephemeral: true });
  if (battle.ownerId !== userId) return interaction.reply({ content: 'Not your battle!', ephemeral: true });

  // --- SCAMPTON EVENT: ally picker for Motivate Up / Immunity Shield ---
  if (interaction.customId === 'pp_target_select') {
    const ppBattle = activeBattles.get(userId);
    if (!ppBattle) return interaction.reply({ content: 'You\'re not in a battle!', ephemeral: true });
    const parts = interaction.values[0].split('_');
    const targetIndex = parseInt(parts[1]);
    const abilityIndex = parseInt(parts[2]);
    ppBattle._ppTargetIndex = targetIndex;
    return handleButton(interaction, `ability_${abilityIndex}`);
  }

  if (interaction.customId === 'switch_select') {
    const index = parseInt(interaction.values[0].split('_')[1]);
    const result = battle.switchCharacter(index);
    if (!result.success) return interaction.reply({ content: result.message, ephemeral: true });
    const enemyAction = battle.executeEnemyTurn();
    const logLines = [result.message];
    if (enemyAction?.message) logLines.push(enemyAction.message);
    const state = battle.getBattleState();
    await interaction.update({ content: 'Switched!', components: [], embeds: [] });
    return interaction.followUp({ embeds: [embeds.battleLog(logLines), embeds.battleState(state)], components: embeds.abilityButtons(state) });
  }

  if (interaction.customId === 'pvp_switch_select') {
    const pvpBattle = activePvP.get(userId);
    if (!pvpBattle) return interaction.reply({ content: 'Not in a PvP battle!', ephemeral: true });
    if (pvpBattle.currentTurn !== userId) return interaction.reply({ content: 'Not your turn!', ephemeral: true });
    clearPvPTurnTimer(pvpBattle);
    const index = parseInt(interaction.values[0].split('_')[1]);
    const result = pvpBattle.switchCharacter(userId, index);
    if (!result.success) { startPvPTurnTimer(pvpBattle); return interaction.reply({ content: result.message, ephemeral: true }); }
    pvpBattle.switchTurn();
    await interaction.update({ content: '✅ Switched!', components: [], embeds: [] }).catch(() => {});
    await renderPvP(pvpBattle, [result.message]);
    startPvPTurnTimer(pvpBattle);
    return;
  }

  // --- UPDATE 15: Picker handlers ---
  if (interaction.customId === 'frisk_food_pick') {
    const pick = interaction.values[0];
    const player = battle.activePlayer;
    if (!player._friskFoodInv) player._friskFoodInv = { monster_candy: 5, crab_apple: 3, spider_donut: 1, butterscotch_pie: 1 };
    if ((player._friskFoodInv[pick] || 0) <= 0) return interaction.reply({ content: `No ${pick} left!`, ephemeral: true });
    player._friskFoodInv[pick]--;
    let healAmount = 0; let foodLabel = '';
    if (pick === 'monster_candy') { healAmount = 20; foodLabel = '🍬 Monster Candy'; }
    else if (pick === 'crab_apple') { healAmount = 40; foodLabel = '🍎 Crab Apple'; }
    else if (pick === 'spider_donut') { healAmount = 30; foodLabel = '🍩 Spider Donut'; }
    else if (pick === 'butterscotch_pie') { healAmount = player.maxHp; foodLabel = '🥧 Butterscotch Pie'; }
    const healed = player.heal(healAmount);
    // Now resolve enemy turn manually
    const R = { playerAction: { success: true, message: `**${player.name}** ate ${foodLabel}! Restored **${healed}** HP!`, damage: 0 }, enemyAction: null, statusTick: [], enemyStatusTick: [], battleEnd: null };
    R.enemyAction = battle.executeEnemyTurn();
    battle.endTurn(R, player);
    const logLines = [R.playerAction.message];
    if (R.enemyAction?.message) logLines.push(R.enemyAction.message);
    R.statusTick?.forEach(s => logLines.push(`**${player.name}** takes **${s.damage}** ${s.name} damage! (${s.turnsLeft} left)`));
    R.enemyStatusTick?.forEach(s => logLines.push(`**${battle.enemy.name}** takes **${s.damage}** ${s.name} damage! (${s.turnsLeft} left)`));
    if (R.battleEnd) {
      // --- STORY MODE bridge ---
      if (battle.storyContext) {
        activeBattles.delete(userId);
        const sv = story.handleStoryBattleEnd(userId, R.battleEnd.winner, logLines);
        await interaction.update({ content: null, components: [], embeds: [] });
        return interaction.followUp(sv);
      }
      activeBattles.delete(userId);
      await interaction.update({ content: 'Battle ended!', components: [], embeds: [] });
      return interaction.followUp({ embeds: [embeds.battleLog(logLines)] });
    }
    const state = battle.getBattleState();
    await interaction.update({ content: 'Food eaten!', components: [], embeds: [] });
    return interaction.followUp({ embeds: [embeds.battleLog(logLines), embeds.battleState(state)], components: embeds.abilityButtons(state) });
  }

  if (interaction.customId === 'healPrayer_target_pick' || interaction.customId === 'noelleHealPrayer_target_pick') {
    const pick = interaction.values[0];
    const isNoelle = interaction.customId === 'noelleHealPrayer_target_pick';
    const player = battle.activePlayer;
    let target;
    if (pick === 'self') target = player;
    else target = battle.playerTeam[parseInt(pick)];
    if (!target || !target.isAlive) return interaction.reply({ content: 'Invalid target!', ephemeral: true });
    let healAmount;
    if (isNoelle) {
      const baseHeal = 30, lowHpHeal = 40;
      healAmount = (player.currentHp <= player.maxHp * 0.25) ? lowHpHeal : baseHeal;
    } else {
      // Ralsei
      const isAlly = (target !== player);
      let base = isAlly ? 20 : 15;
      if (player.currentHp <= player.maxHp * 0.25) base += 10;
      healAmount = base;
    }
    const healed = target.heal(healAmount);
    const R = { playerAction: { success: true, message: `**${player.name}** healed **${target.name}** for **${healed}** HP!`, damage: 0 }, enemyAction: null, statusTick: [], enemyStatusTick: [], battleEnd: null };
    R.enemyAction = battle.executeEnemyTurn();
    battle.endTurn(R, player);
    const logLines = [R.playerAction.message];
    if (R.enemyAction?.message) logLines.push(R.enemyAction.message);
    R.statusTick?.forEach(s => logLines.push(`**${player.name}** takes **${s.damage}** ${s.name} damage! (${s.turnsLeft} left)`));
    R.enemyStatusTick?.forEach(s => logLines.push(`**${battle.enemy.name}** takes **${s.damage}** ${s.name} damage! (${s.turnsLeft} left)`));
    if (R.battleEnd) {
      // --- STORY MODE bridge ---
      if (battle.storyContext) {
        activeBattles.delete(userId);
        const sv = story.handleStoryBattleEnd(userId, R.battleEnd.winner, logLines);
        await interaction.update({ content: null, components: [], embeds: [] });
        return interaction.followUp(sv);
      }
      activeBattles.delete(userId);
      await interaction.update({ content: 'Battle ended!', components: [], embeds: [] });
      return interaction.followUp({ embeds: [embeds.battleLog(logLines)] });
    }
    const state = battle.getBattleState();
    await interaction.update({ content: 'Healed!', components: [], embeds: [] });
    return interaction.followUp({ embeds: [embeds.battleLog(logLines), embeds.battleState(state)], components: embeds.abilityButtons(state) });
  }
}


// --- /shop ---
async function cmdShop(interaction) {
  const userId = interaction.user.id;
  playerDB.ensurePlayer(userId);
  const bossClears = playerDB.getBossClears(userId);
  if (bossClears < SHOP_REQUIRED_BOSS_CLEARS) {
    return interaction.reply({ content: `🛒 **Negativetale's Shop** is locked! You need to defeat at least **${SHOP_REQUIRED_BOSS_CLEARS} boss** first to unlock it.`, ephemeral: true });
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'browse') {
    const player = playerDB.getPlayer(userId);
    const det = player.determination || 0;
    const dialog = SHOP_DIALOGS[Math.floor(Math.random() * SHOP_DIALOGS.length)];
    const itemList = SHOP_ITEMS.map(item => `**${item.emoji} ${item.name}** — ${item.price.toLocaleString()} Determination${item.priceSE ? ` **+ ${item.priceSE.toLocaleString()} Soul Essence**` : ''}\n> ${item.description}`).join('\n\n');
    const embed = {
      color: 0x1a1a2e,
      title: '🖤 Negativetale\'s Shop',
      description: `*"${dialog}"*\n\nYour Determination: **💪 ${det.toLocaleString()}**\nYour Soul Essence: **💜 ${(player.soul_essence || 0).toLocaleString()}**`,
      fields: [{ name: 'Items for Sale', value: itemList }],
      footer: { text: 'Use /shop buy <item> to purchase.' },
    };
    return interaction.reply({ embeds: [embed], components: [] });
  }

  if (sub === 'buy') {
    const itemId = interaction.options.getString('item');
    const amount = Math.min(interaction.options.getInteger('amount') || 1, 99);
    const shopItem = SHOP_ITEMS.find(i => i.id === itemId);
    if (!shopItem) return interaction.reply({ content: 'Unknown item!', ephemeral: true });

    const player = playerDB.getPlayer(userId);
    const det = player.determination || 0;
    const totalCost = shopItem.price * amount;

    if (det < totalCost) {
      return interaction.reply({ content: `❌ Not enough Determination! You need **${totalCost.toLocaleString()} 💪** (${amount}x ${shopItem.price.toLocaleString()}) but only have **${det.toLocaleString()} 💪**.`, ephemeral: true });
    }

    // UPDATE 34: dual-currency items (Galactic Ticket) also cost Soul Essence.
    const totalCostSE = (shopItem.priceSE || 0) * amount;
    if (totalCostSE > 0) {
      const se = player.soul_essence || 0;
      if (se < totalCostSE) {
        return interaction.reply({ content: `❌ Not enough Soul Essence! You need **${totalCostSE.toLocaleString()} 💜** (${amount}x ${shopItem.priceSE.toLocaleString()}) but only have **${se.toLocaleString()} 💜**.`, ephemeral: true });
      }
    }

    // Handle character purchase
    if (shopItem.isCharacter) {
      playerDB.addDetermination(userId, -totalCost);
      const shiny = rollShiny();
      const nc = playerDB.addCharacter(userId, shopItem.id, 0, shiny);
      const ts = playerDB.getTeamSize(userId);
      if (ts < 6) playerDB.setTeamSlot(userId, ts + 1, nc.id);
      const cd = CHARACTERS[shopItem.id];
      return interaction.reply({ content: `🖤 *"here, take it."*\n\nYou bought **${shopItem.emoji} ${shopItem.name}** for **${totalCost.toLocaleString()} Determination**!${shiny ? ' It\'s **✦ SHINY ✦**! (+2 ATK, +2 DEF)' : ''}\n💪 Remaining: **${(playerDB.getPlayer(userId).determination || 0).toLocaleString()}**` });
    }

    // Handle Shiny Star — let player choose which character to make shiny
    if (itemId === 'shiny_star') {
      const chars = playerDB.getCharacters(userId);
      const nonShiny = chars.filter(c => !c.shiny);
      if (nonShiny.length === 0) {
        return interaction.reply({ content: '❌ All your characters are already shiny!', ephemeral: true });
      }
      pendingShinyPurchase.set(userId, { price: totalCost, timestamp: Date.now() });
      return interaction.reply({ ...buildShinyStarPage(nonShiny, 0), ephemeral: true });
    }

    // Regular item purchase
    playerDB.addDetermination(userId, -totalCost);
    if (totalCostSE > 0) playerDB.addSoulEssence(userId, -totalCostSE);
    playerDB.addItem(userId, itemId, amount);
    const dialog = SHOP_DIALOGS[Math.floor(Math.random() * SHOP_DIALOGS.length)];
    return interaction.reply({ content: `🖤 *"${dialog}"*\n\nYou bought **${amount}x ${shopItem.emoji} ${shopItem.name}** for **${totalCost.toLocaleString()} Determination**${totalCostSE > 0 ? ` **+ ${totalCostSE.toLocaleString()} Soul Essence**` : ''}!\n💪 Remaining: **${(playerDB.getPlayer(userId).determination || 0).toLocaleString()}**${totalCostSE > 0 ? `\n💜 Remaining: **${(playerDB.getPlayer(userId).soul_essence || 0).toLocaleString()}**` : ''}` });
  }
}

// --- /convert ---
async function cmdConvert(interaction) {
  const userId = interaction.user.id;
  playerDB.ensurePlayer(userId);
  const amount = interaction.options.getInteger('amount');
  const result = playerDB.convertDtToDetermination(userId, amount);
  if (!result.success) return interaction.reply({ content: `❌ ${result.reason}`, ephemeral: true });
  return interaction.reply({ content: `🔄 Converted **${result.used} DT Vials** → **${result.det} Determination**!\n💪 Determination: **${(playerDB.getPlayer(userId).determination || 0).toLocaleString()}**` });
}

// --- /achievements ---
async function cmdAchievements(interaction) {
  const userId = interaction.user.id;
  playerDB.ensurePlayer(userId);
  const gotChromaKey = awardChromaKeyCIfEligible(userId);
  const playerAchs = playerDB.getAchievements(userId);
  const lines = Object.values(ACHIEVEMENTS).map(a => {
    const done = playerAchs[a.id] ? '✅' : '❌';
    return `${done} **${a.name}** — ${a.description}`;
  }).join('\n');
  const total = Object.keys(ACHIEVEMENTS).length;
  const done = Object.values(playerAchs).filter(Boolean).length;
  const embed = {
    color: 0xffde57,
    title: '🏆 Achievements',
    description: `**${done}/${total} completed**\n\n${lines}${gotChromaKey ? '\n\n🟦 **You earned a ChromaKey Piece C** for completing 10+ achievements!' : ''}`,
    footer: { text: 'Achievements are auto-claimed when earned.' },
  };
  return interaction.reply({ embeds: [embed] });
}

async function cmdLock(interaction) {
  const userId = interaction.user.id; playerDB.ensurePlayer(userId);
  const charId = interaction.options.getInteger('character_id');
  const char = playerDB.getCharacterById(charId, userId);
  if (!char) return interaction.reply({ content: 'You don\'t own that character!', ephemeral: true });
  if (char.locked) return interaction.reply({ content: `**[${charId}]** is already locked!`, ephemeral: true });
  playerDB.setCharacterLocked(userId, charId, true);
  const cd = CHARACTERS[char.character_id];
  return interaction.reply({ content: `🔒 **${cd?.name || char.character_id}** [ID: ${charId}] is now **locked**. It can't be exiled or used in evolutions.` });
}

async function cmdUnlock(interaction) {
  const userId = interaction.user.id; playerDB.ensurePlayer(userId);
  const charId = interaction.options.getInteger('character_id');
  const char = playerDB.getCharacterById(charId, userId);
  if (!char) return interaction.reply({ content: 'You don\'t own that character!', ephemeral: true });
  if (!char.locked) return interaction.reply({ content: `**[${charId}]** isn't locked!`, ephemeral: true });
  playerDB.setCharacterLocked(userId, charId, false);
  const cd = CHARACTERS[char.character_id];
  return interaction.reply({ content: `🔓 **${cd?.name || char.character_id}** [ID: ${charId}] is now **unlocked**.` });
}

async function cmdScavenge(interaction) {
  const userId = interaction.user.id; playerDB.ensurePlayer(userId);
  const player = playerDB.getPlayer(userId);
  if ((player.soul_essence || 0) < 1000) return interaction.reply({ content: `Not enough **Soul Essence**! Need 1000, have ${player.soul_essence || 0}.`, ephemeral: true });
  playerDB.addSoulEssence(userId, -1000);
  // Weighted drop table
  const table = [
    { id: 'tier2_monster_soul', name: 'Tier 2 Monster Soul', emoji: '💎', chance: 0.65 },
    { id: 'gasters_hands', name: "Gaster's Hands", emoji: '🖐️', chance: 0.02 },
    { id: 'glitched_strings', name: 'Glitched Strings', emoji: '🧵', chance: 0.15 },
    { id: 'save_star_menu', name: 'Save Star Menu', emoji: '💾', chance: 0.25 },
    { id: 'lethal_deal', name: 'Lethal Deal', emoji: '🃏', chance: 0.15 },
    { id: 'a_gun', name: 'A Gun...?', emoji: '🔫', chance: 0.06 },
    { id: 'paint_vials', name: 'Paint Vials', emoji: '🎨', chance: 0.15 },
    { id: 'hatred', name: 'Hatred.', emoji: '💢', chance: 0.05 },
    { id: 'juice_eyes', name: 'Juice that gives you eyes', emoji: '👁️', chance: 0.15 },
    { id: 'parasite', name: 'Parasite', emoji: '🦠', chance: 0.03 },
    { id: 'shattered_kindness_soul', name: 'Shattered Kindness Soul', emoji: '💚', chance: 0.05 },
    { id: 'integrity_soul', name: 'Integrity Soul', emoji: '💙', chance: 0.10 },
    { id: 'umbrella', name: 'Umbrella', emoji: '☂️', chance: 0.03 },
    { id: 'coffee_mug', name: 'Coffee Mug', emoji: '☕', chance: 0.20 },
    // --- UPDATE 17 SCAVENGE ITEMS ---
    { id: 'glitched_star', name: 'Glitched Star', emoji: '💫', chance: 0.03 },
    { id: 'positive_staff', name: 'Positive Staff', emoji: '🪄', chance: 0.05 },
    { id: 'positive_essence', name: 'Positive Essence', emoji: '⭐', chance: 0.00667 },
    // --- UPDATE 19 SCAVENGE ---
    { id: 'lightsaber', name: 'Lightsaber', emoji: '⚔️', chance: 0.07 },
    { id: 'monster_candy', name: 'Monster Candy', emoji: '🍬', chance: 0.20 },
    { id: 'spider_donut', name: 'Spider Donut', emoji: '🍩', chance: 0.15 },
    { id: 'butterscotch_pie', name: 'Butterscotch Pie', emoji: '🥧', chance: 0.10 },
    { id: 'crab_apple', name: 'Crab Apple', emoji: '🍎', chance: 0.15 },
  ];
  const drops = [];
  for (const item of table) {
    if (Math.random() < item.chance) {
      playerDB.addItem(userId, item.id, 1);
      drops.push(`${item.emoji} **${item.name}**`);
    }
  }
  if (drops.length === 0) return interaction.reply({ content: `You sent your character to scavenge (cost: 1000 Soul Essence)...\n\n*They came back empty handed.*` });
  return interaction.reply({ content: `You sent your character to scavenge (cost: 1000 Soul Essence)...\n\nThey returned with:\n${drops.join('\n')}` });
}

async function cmdSell(interaction) {
  const userId = interaction.user.id; playerDB.ensurePlayer(userId);
  const itemId = interaction.options.getString('item');
  const amount = Math.min(interaction.options.getInteger('amount') || 1, 10); // max 10 per sell
  const itemData = ITEMS[itemId];
  if (!itemData) return interaction.reply({ content: 'Unknown item!', ephemeral: true });
  // --- UPDATE 18: DT Vial cannot be sold ---
  if (itemId === 'dt_vial') return interaction.reply({ content: '❌ **DT Vials** can no longer be sold! Use `/convert` to turn them into Determination instead.', ephemeral: true });
  // Sell limit: 5 transactions per 2 hours
  const p = playerDB.getPlayer(userId);
  const now = Date.now();
  const windowMs = 2 * 60 * 60 * 1000;
  if (!p.sellLog) p.sellLog = [];
  p.sellLog = p.sellLog.filter(t => now - t < windowMs);
  if (p.sellLog.length >= 5) {
    const resetIn = Math.ceil((p.sellLog[0] + windowMs - now) / 60000);
    return interaction.reply({ content: `You've already sold **5 times** in the last 2 hours! Reset in **${resetIn} minutes**.`, ephemeral: true });
  }
  if (!playerDB.hasItem(userId, itemId, amount)) return interaction.reply({ content: `Not enough **${itemData.name}**!`, ephemeral: true });
  const prices = {
    tier1_monster_soul: 35, tier2_monster_soul: 60, tier3_monster_soul: 100,
    star_piece: 42, monster_soul: 20, save_star: 150, gasters_hands: 500,
    his_guidance: (1875 + 0.0001) / 3.5, dt_injector: 300, echo_flowers: 100, papyrus_skull: 140,
    spear: 200, papyrus_scarf: 200, head_dog: 200, blackhole: 350, stolen_flames: 200,
    glitched_strings: 200, save_star_menu: 250, lethal_deal: 150, a_gun: 200,
    paint_vials: 150, hatred: 175, juice_eyes: 150, orange_jacket: 250, ink_brush: 500,
    broken_clock: 400, the_flower: 600,
    // Update 11
    time_orb: 143, // raw price before *3.5 = 500 DT
    parasite: 57,  // ~200 DT
    crown_of_the_king: (2015 + 0.0001) / 3.5, // 2015 DT
    asgores_trident: 143, // ~500 DT
    cat_food: 200, // ~700 DT
    blue_bone: 200, // ~700 DT
    // --- UPDATE 12 ---
    axe_thousand_souls: 300,        // ~1050 DT
    axe_hundred_thousand_souls: 600, // ~2100 DT
    blade_omniverse: 400,           // ~1400 DT
    shattered_kindness_soul: 100,   // ~350 DT
    integrity_soul: 75,             // ~262 DT
    // --- UPDATE 13 ---
    mafia_hat: 200,                 // ~700 DT
    cigarette_pack: 100,            // ~350 DT
    cosmic_dust: 250,               // ~875 DT
    stolen_monster_magic: 300,      // ~1050 DT
    neo_cannon: 300,                // ~1050 DT
    alphys_tech: 200,               // ~700 DT
    empty_gun: 200,                 // ~700 DT
    green_coat: 150,                // ~525 DT
    crimson_coat: 400,              // ~1400 DT
    real_knife: 500,                // ~1750 DT
    void_tablet: 1000,              // ~3500 DT
    purple_jacket: 150,             // ~525 DT
    hardmode_essence: 400,          // ~1400 DT
    karma_vial: 450,                // ~1575 DT (UPDATE 31)
    rebar: 600,                     // ~2100 DT (UPDATE 31)
    amalgamate_essence: 350,        // ~1225 DT (UPDATE 31)
    dusty_fur_hood: 100,            // ~350 DT
    chains: 75,                     // ~262 DT
    vines: 100,                     // ~350 DT
    kindness_human_soul: 250,       // ~875 DT
    // --- UPDATE 15 ---
    dt_soul: 50,                    // ~175 DT
    umbrella: 75,                   // ~262 DT
    kris_sword: 150,                // ~525 DT
    susies_axe: 150,                // ~525 DT
    comically_long_blunt: 150,      // ~525 DT
    frosty_antlers: 150,            // ~525 DT
    cowboy_hat: 100,                // ~350 DT
    thorn_ring: 200,                // ~700 DT
    thorns: 20,                     // ~70 DT
    empowered_kindness_soul: 300,   // ~1050 DT
    portable_core: 500,             // ~1750 DT
    // --- UPDATE 17 ---
    negative_essence: 150,          // ~525 DT
    killers_soul: 300,              // ~1050 DT
    corrupt_apple: 400,             // ~1400 DT
    corruption: 100,                // ~350 DT
    fatals_bone: 200,               // ~700 DT
    glitched_star: 150,             // ~525 DT
    positive_staff: 100,            // ~350 DT
    positive_apple: 500,            // ~1750 DT
    true_negative_essence: 700,     // ~2450 DT
    // --- UPDATE 18 ---
    coffee_mug: 30, // ~105 DT
    burning_essence: 100, // ~350 DT
    strange_flower: 400, // ~1400 DT
    justice_human_soul: 250, // ~875 DT
    integrity_human_soul: 250,
    bravery_human_soul: 250,
    patience_human_soul: 250,
    perseverance_human_soul: 250,
    determination_soul: 500, // ~1750 DT
    // --- UPDATE 19 ---
    black_shard: 50,       // ~175 DT
    shadow_crystal: 200,   // ~700 DT
    lightsaber: 100,       // ~350 DT
    scythe: 75,            // ~262 DT
    loaded_gun: 100,       // ~350 DT
  };
  const unitPrice = Math.floor((prices[itemId] || 10) * 3.5);
  const total = unitPrice * amount;
  playerDB.removeItem(userId, itemId, amount);
  playerDB.addDetermination(userId, total);
  p.sellLog.push(now);
  const remaining = 5 - p.sellLog.length;
  return interaction.reply({ content: `Sold **${amount}x ${itemData.emoji} ${itemData.name}** for **${total.toLocaleString()} 💪 Determination**!\n*(${remaining} sell${remaining !== 1 ? 's' : ''} remaining for the next 2 hours)*` });
}

async function cmdSellValues(interaction) {
  const prices = {
    monster_soul: 20, tier1_monster_soul: 35, tier2_monster_soul: 60,
    tier3_monster_soul: 100, star_piece: 42, save_star: 150, gasters_hands: 500,
    his_guidance: (1875 + 0.0001) / 3.5, dt_injector: 300, echo_flowers: 100, papyrus_skull: 140,
    spear: 200, papyrus_scarf: 200, head_dog: 200, blackhole: 350, stolen_flames: 200,
    glitched_strings: 200, save_star_menu: 250, lethal_deal: 150, a_gun: 200,
    paint_vials: 150, hatred: 175, juice_eyes: 150, orange_jacket: 250, ink_brush: 500,
    broken_clock: 400, the_flower: 600,
    time_orb: 143, parasite: 57, crown_of_the_king: (2015 + 0.0001) / 3.5, asgores_trident: 143,
    cat_food: 200, blue_bone: 200,
    axe_thousand_souls: 300, axe_hundred_thousand_souls: 600, blade_omniverse: 400,
    shattered_kindness_soul: 100, integrity_soul: 75,
    mafia_hat: 200, cigarette_pack: 100, cosmic_dust: 250, stolen_monster_magic: 300,
    neo_cannon: 300, alphys_tech: 200, empty_gun: 200, green_coat: 150, crimson_coat: 400,
    real_knife: 500, void_tablet: 1000, purple_jacket: 150, hardmode_essence: 400,
    karma_vial: 450, rebar: 600, amalgamate_essence: 350,
    dusty_fur_hood: 100, chains: 75, vines: 100, kindness_human_soul: 250,
    dt_soul: 50, umbrella: 75, kris_sword: 150, susies_axe: 150, comically_long_blunt: 150,
    frosty_antlers: 150, cowboy_hat: 100, thorn_ring: 200, thorns: 20,
    empowered_kindness_soul: 300, portable_core: 500,
    negative_essence: 150, killers_soul: 300, corrupt_apple: 400, corruption: 100,
    fatals_bone: 200, glitched_star: 150, positive_staff: 100, positive_apple: 500,
    true_negative_essence: 700,
    // --- UPDATE 18 ---
    coffee_mug: 30, burning_essence: 100, strange_flower: 400,
    justice_human_soul: 250, integrity_human_soul: 250, bravery_human_soul: 250,
    patience_human_soul: 250, perseverance_human_soul: 250, determination_soul: 500,
    // --- UPDATE 19 ---
    black_shard: 50, shadow_crystal: 200, lightsaber: 100, scythe: 75, loaded_gun: 100,
  };
  const lines = Object.entries(prices).map(([id, raw]) => {
    const item = ITEMS[id]; if (!item) return null;
    const dt = Math.floor(raw * 3.5);
    return `${item.emoji} **${item.name}** — ${dt.toLocaleString()} 💪 DT`;
  }).filter(Boolean);
  const embed = {
    color: 0x2b2d31,
    title: '💱 Item Sell Values',
    description: lines.join('\n'),
    footer: { text: 'Prices shown are per 1 item. Max 10 items per sell, 5 sells per 2 hours.' },
  };
  return interaction.reply({ embeds: [embed] });
}

async function cmdGacha(interaction) {
  const userId = interaction.user.id; playerDB.ensurePlayer(userId);
  const player = playerDB.getPlayer(userId);
  const cost = GACHA_TABLE.cost;
  const det = player.determination || 0;
  if (det < cost) return interaction.reply({ content: `❌ Not enough Determination! You need **${cost.toLocaleString()} 💪** but only have **${det.toLocaleString()} 💪**.`, ephemeral: true });
  playerDB.addDetermination(userId, -cost);
  // --- UPDATE 13: Track gacha pull count ---
  const pullCount = playerDB.incGachaPulls(userId);

  // Roll tier
  let roll = Math.random(), tier = GACHA_TABLE.tiers[0];
  let cumulative = 0;
  for (const t of [...GACHA_TABLE.tiers].reverse()) {
    cumulative += t.chance;
    if (roll < cumulative) { tier = t; break; }
  }

  const gained = [];
  // Grant all base rewards for this tier
  for (const r of tier.rewards) {
    if (r.exclusiveChance !== undefined) continue; // handle separately below
    if (r.type === 'item') { playerDB.addItem(userId, r.id, r.amount); const item = ITEMS[r.id]; gained.push(`${item?.emoji || '📦'} **${item?.name || r.id}** x${r.amount}`); }
    else if (r.type === 'determination') { playerDB.addDetermination(userId, r.amount); gained.push(`💪 **${r.amount.toLocaleString()} Determination**`); }
    else if (r.type === 'dtVial') { playerDB.addItem(userId, 'dt_vial', r.amount); gained.push(`🧪 **DT Vial** x${r.amount}`); }
  }
  // Roll exclusive drops (only in legendary tier)
  for (const r of tier.rewards) {
    if (r.exclusiveChance === undefined) continue;
    if (Math.random() < r.exclusiveChance) {
      // --- UPDATE 22: A Cross dupe protection — owning A Cross/The Dark Cross/Fallen Priest grants 500 DT Vials instead ---
      if (r.id === 'a_cross') {
        const ownsCross = playerDB.hasItem(userId, 'a_cross', 1) || playerDB.hasItem(userId, 'the_dark_cross', 1) || playerDB.getCharacters(userId).some(c => c.character_id === 'fallen_priest');
        if (ownsCross) {
          playerDB.addDtVials(userId, 500);
          gained.push(`✝️ Rolled **A Cross** but you already walk the path of the Priest! Got 🧪 **500 DT Vials** instead!`);
          continue;
        }
      }
      if (r.type === 'item') { playerDB.addItem(userId, r.id, r.amount); const item = ITEMS[r.id]; gained.push(`✨ ${item?.emoji || '📦'} **${item?.name || r.id}** x${r.amount} *(Exclusive!)*`); }
      else if (r.type === 'character') {
        const cd = CHARACTERS[r.id];
        if (cd) {
          const existing = playerDB.getCharacters(userId).find(c => c.character_id === r.id);
          if (!existing) { const shiny = rollShiny(); playerDB.addCharacter(userId, r.id, 0, shiny); gained.push(`🌟 **${cd.name}**${shiny ? ' ✦ SHINY!' : ''} *(Gacha Exclusive!)*`); }
          else {
            // Dupe reward for Weak Avenge Sans and C!Insanity Weak
            if (r.id === 'c_insanity_weak') {
              playerDB.addItem(userId, 'axe_thousand_souls', 1);
              gained.push(`💫 Rolled **${cd.name}** but you already own them! Got 🪓 **Axe of a Thousand Souls** instead!`);
            } else if (r.id === 'weak_avenge_sans') {
              playerDB.addItem(userId, 'blade_omniverse', 1);
              gained.push(`💫 Rolled **${cd.name}** but you already own them! Got ⚔️ **Blade of the Omniverse** instead!`);
            } else {
              gained.push(`💫 Rolled **${cd.name}** but you already own them! (No duplicate)`);
            }
          }
        }
      }
    }
  }

  const embed = {
    color: tier.name === 'Legendary' ? 0xffd700 : tier.name === 'Epic' ? 0x9b59b6 : tier.name === 'Rare' ? 0x3498db : 0x95a5a6,
    title: `${tier.emoji} ${tier.name} Pull!`,
    description: `You spent **${cost.toLocaleString()} 💪 Determination** on the gacha!\n\n**You got:**\n${gained.join('\n')}`,
    footer: { text: `Remaining Determination: ${(playerDB.getPlayer(userId).determination || 0).toLocaleString()} 💪` },
  };
  // --- UPDATE 13: Lets Go Gambling achievement (100 gacha pulls) ---
  if (pullCount >= 100 && !playerDB.hasAchievement(userId, 'lets_go_gambling')) {
    const ach = grantAchievementIfNew(userId, 'lets_go_gambling');
    if (ach) {
      const reward = ach.reward.dtVialChance;
      let achMsg = '';
      if (Math.random() < reward.chance) {
        playerDB.addDtVials(userId, reward.amount);
        achMsg = `\n\n🏆 Achievement: **${ach.name}**! 🎰 You hit the jackpot! (+${reward.amount} DT Vials)`;
      } else {
        achMsg = `\n\n🏆 Achievement: **${ach.name}**! 🎰 ...you got nothing. Better luck next time!`;
      }
      embed.description += achMsg;
    }
  }
  return interaction.reply({ embeds: [embed] });
}

function hasModeRole(interaction) {
  return ADMINS.includes(interaction.user.id) ||
    interaction.member?.roles?.cache?.has(MOD_ROLE);
}

async function cmdGiveBoosterReward(interaction) {
  if (!hasModeRole(interaction)) return interaction.reply({ content: 'No permission!', ephemeral: true });
  const target = interaction.options.getUser('player');
  if (playerDB.hasBoosterClaim(target.id)) {
    return interaction.reply({ content: `**${target.username}** has already claimed their booster reward!`, ephemeral: true });
  }
  const buttons = BOOSTER_CHARACTERS.map(c =>
    new ButtonBuilder().setCustomId(`booster_pick_${c.id}`).setLabel(c.label).setEmoji(c.emoji).setStyle(ButtonStyle.Primary)
  );
  const row = new ActionRowBuilder().addComponents(buttons);
  try {
    const dm = await target.createDM();
    await dm.send({ content: `Yoo thank you so much for boosting. Pick any character from the gacha:`, components: [row] });
    return interaction.reply({ content: `✅ Sent booster reward DM to **${target.username}**!`, ephemeral: true });
  } catch (e) {
    return interaction.reply({ content: `❌ Couldn't DM **${target.username}** — they may have DMs disabled.`, ephemeral: true });
  }
}

async function cmdGiveItem(interaction) {
  if (!hasModeRole(interaction)) return interaction.reply({ content: 'No permission!', ephemeral: true });
  const target = interaction.options.getUser('player');
  const itemId = interaction.options.getString('item');
  const amount = interaction.options.getInteger('amount') || 1;
  playerDB.ensurePlayer(target.id);
  // Route currencies to their actual fields instead of inventory
  if (itemId === 'determination') {
    playerDB.addDetermination(target.id, amount);
    return interaction.reply({ content: `Gave **${amount.toLocaleString()} Determination** 💛 to **${target.username}**.` });
  }
  if (itemId === 'soul_essence') {
    playerDB.addSoulEssence(target.id, amount);
    return interaction.reply({ content: `Gave **${amount.toLocaleString()} Soul Essence** 🔵 to **${target.username}**.` });
  }
  if (!ITEMS[itemId]) return interaction.reply({ content: 'Unknown item!', ephemeral: true });
  playerDB.addItem(target.id, itemId, amount);
  return interaction.reply({ content: `Gave **${amount}x ${ITEMS[itemId].name}** to **${target.username}**.` });
}

async function cmdRemoveItem(interaction) {
  if (!hasModeRole(interaction)) return interaction.reply({ content: 'No permission!', ephemeral: true });
  const target = interaction.options.getUser('player');
  const itemId = interaction.options.getString('item');
  const amount = interaction.options.getInteger('amount') || 1;
  if (!ITEMS[itemId]) return interaction.reply({ content: 'Unknown item!', ephemeral: true });
  playerDB.ensurePlayer(target.id);
  const result = playerDB.removeItem(target.id, itemId, amount);
  if (!result) return interaction.reply({ content: `**${target.username}** doesn't have enough of that item!`, ephemeral: true });
  return interaction.reply({ content: `Removed **${amount}x ${ITEMS[itemId].name}** from **${target.username}**.` });
}

async function cmdResetData(interaction) {
  if (!hasModeRole(interaction)) return interaction.reply({ content: 'No permission!', ephemeral: true });
  const target = interaction.options.getUser('player');
  playerDB.resetPlayer(target.id);
  return interaction.reply({ content: `Reset all data for **${target.username}**.` });
}

// ===================== UPDATE 32: RANKED SEASON END =====================
const SEASON_REWARD_CHAR = 'mad_mew_mew';

async function cmdEndSeason(interaction) {
  if (!hasModeRole(interaction)) return interaction.reply({ content: 'No permission!', ephemeral: true });
  if (!playerDB.isSeasonActive()) {
    return interaction.reply({ content: `The season is already over — ranked is closed. Use \`/startseason\` to begin Season **${playerDB.getSeasonNumber() + 1}**.`, ephemeral: true });
  }
  const ranked = require('./ranked');
  const entries = playerDB.getRankedLeaderboard();
  if (entries.length === 0) {
    return interaction.reply({ content: 'No ranked players yet — there is no season to end.', ephemeral: true });
  }
  const top3 = entries.slice(0, 3);
  const medals = ['🥇', '🥈', '🥉'];
  const preview = top3.map((e, i) => `${medals[i]} <@${e.userId}> — **${ranked.labelFor(e.index)}** • ${e.crystals} SC`).join('\n');
  const total = playerDB.getAllUserIds().length;
  const cd = CHARACTERS[SEASON_REWARD_CHAR];

  const embed = new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle('⚠️ End Ranked Season?')
    .setDescription(
      `**Top 3 this season:**\n${preview}\n\n` +
      `They will receive **${cd?.name || SEASON_REWARD_CHAR}**.\n` +
      `🥇 1st place gets the **✦ SHINY ✦** version with **+6 ATK / +6 DEF**.\n\n` +
      `Ranked will then **close** — \`/challenge\` stays open but gives **no Shadow Crystals**.\n` +
      `Ranks stay frozen until you run \`/startseason\` (that's what resets all **${total}** players to placements).\n\n` +
      `**This cannot be undone.**`
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('endseason_confirm').setLabel('END SEASON').setStyle(ButtonStyle.Danger).setEmoji('🏁'),
    new ButtonBuilder().setCustomId('endseason_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  return interaction.reply({ embeds: [embed], components: [row] });
}

async function handleEndSeasonButton(interaction) {
  if (!hasModeRole(interaction)) return interaction.reply({ content: 'No permission!', ephemeral: true });
  if (interaction.customId === 'endseason_cancel') {
    return interaction.update({ content: 'Season end **cancelled**. Nothing was changed.', embeds: [], components: [] });
  }
  const ranked = require('./ranked');
  const entries = playerDB.getRankedLeaderboard();
  if (entries.length === 0) {
    return interaction.update({ content: 'No ranked players — nothing to do.', embeds: [], components: [] });
  }
  // Snapshot the top 3 BEFORE wiping anything.
  const top3 = entries.slice(0, 3).map(e => ({ userId: e.userId, label: ranked.labelFor(e.index), crystals: e.crystals }));
  const cd = CHARACTERS[SEASON_REWARD_CHAR];
  const medals = ['🥇', '🥈', '🥉'];
  const lines = [];
  for (let i = 0; i < top3.length; i++) {
    const isFirst = i === 0;
    const nc = playerDB.addCharacterFlagged(
      top3[i].userId, SEASON_REWARD_CHAR, isFirst,
      isFirst ? { seasonChampion: true } : {}
    );
    lines.push(`${medals[i]} <@${top3[i].userId}> — **${top3[i].label}** • ${top3[i].crystals} SC → ${isFirst ? '**✦ SHINY ✦** ' : ''}**${cd?.name || SEASON_REWARD_CHAR}** [ID: ${nc.id}]${isFirst ? ' *(+6 ATK / +6 DEF)*' : ''}`);
  }
  const seasonNum = playerDB.endSeason();
  const embed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle(`🏁 Ranked Season ${seasonNum} Has Ended!`)
    .setDescription(
      `**Season ${seasonNum} champions:**\n${lines.join('\n')}\n\n` +
      `🔓 Ranked is now **CLOSED**. \`/challenge\` still works, but matches are **unranked** — no Shadow Crystals, no promotions, no demotions.\n` +
      `Final standings stay frozen on \`/leaderboard type:pvp\` until Season ${seasonNum + 1} begins.`
    );
  return interaction.update({ content: '', embeds: [embed], components: [] });
}

async function cmdStartSeason(interaction) {
  if (!hasModeRole(interaction)) return interaction.reply({ content: 'No permission!', ephemeral: true });
  if (playerDB.isSeasonActive()) {
    return interaction.reply({ content: `Season **${playerDB.getSeasonNumber()}** is already running! Use \`/endseason\` first.`, ephemeral: true });
  }
  const total = playerDB.getAllUserIds().length;
  const next = playerDB.getSeasonNumber() + 1;
  const embed = new EmbedBuilder()
    .setColor(0x2ECC71)
    .setTitle(`⚠️ Start Ranked Season ${next}?`)
    .setDescription(
      `**${total}** players will be wiped back to **Unranked** and must redo their **5 placement matches**.\n` +
      `Last season's final standings will be erased.\n\n` +
      `**This cannot be undone.**`
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('startseason_confirm').setLabel('START SEASON').setStyle(ButtonStyle.Success).setEmoji('🚀'),
    new ButtonBuilder().setCustomId('startseason_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  return interaction.reply({ embeds: [embed], components: [row] });
}

async function handleStartSeasonButton(interaction) {
  if (!hasModeRole(interaction)) return interaction.reply({ content: 'No permission!', ephemeral: true });
  if (interaction.customId === 'startseason_cancel') {
    return interaction.update({ content: 'Cancelled. Nothing was changed.', embeds: [], components: [] });
  }
  if (playerDB.isSeasonActive()) {
    return interaction.update({ content: 'That season is already running.', embeds: [], components: [] });
  }
  const resetCount = playerDB.resetAllRanks();
  const seasonNum = playerDB.startSeason();
  const embed = new EmbedBuilder()
    .setColor(0x2ECC71)
    .setTitle(`🚀 Ranked Season ${seasonNum} Has Begun!`)
    .setDescription(
      `🔄 **${resetCount}** players reset to **Unranked**.\n` +
      `Everyone must complete **5 placement matches** with \`/challenge\` to earn a rank.\n\n` +
      `💠 Shadow Crystals are live again — good luck!`
    );
  return interaction.update({ content: '', embeds: [embed], components: [] });
}

async function cmdRank(interaction) {
  const userId = interaction.user.id;
  playerDB.ensurePlayer(userId);
  const r = playerDB.getRanked(userId);
  // UPDATE 32: pass season state so the card can show the offseason
  return interaction.reply({ embeds: [embeds.rankCard(interaction.user, r, { seasonActive: playerDB.isSeasonActive(), seasonNumber: playerDB.getSeasonNumber() })] });
}

async function cmdWipeData(interaction) {
  if (!hasModeRole(interaction)) return interaction.reply({ content: 'No permission!', ephemeral: true });
  const id = (interaction.options.getString('user_id') || '').trim();
  if (!/^\d{15,25}$/.test(id)) return interaction.reply({ content: 'Invalid Discord user ID. Paste the numeric ID.', ephemeral: true });
  playerDB.resetPlayer(id);
  return interaction.reply({ content: `Globally **wiped all data** for user ID \`${id}\`.` });
}

async function cmdResetRank(interaction) {
  if (!hasModeRole(interaction)) return interaction.reply({ content: 'No permission!', ephemeral: true });
  const id = (interaction.options.getString('user_id') || '').trim();
  if (!/^\d{15,25}$/.test(id)) return interaction.reply({ content: 'Invalid Discord user ID. Paste the numeric ID.', ephemeral: true });

  // UPDATE 34: capture the rank being wiped so the DM can tell them what they lost.
  const ranked = require('./ranked');
  const before = playerDB.getRanked(id);
  const wasPlaced = !!before.placed;
  const oldLabel = wasPlaced ? ranked.labelFor(before.index) : 'Unranked (in placements)';
  const reason = (interaction.options.getString('reason') || '').trim();

  playerDB.resetRank(id);

  // UPDATE 34: notify the player by DM so a reset is never silent.
  let dmNote = '';
  try {
    const user = await client.users.fetch(id);
    const embed = new EmbedBuilder()
      .setColor(0xE74C3C)
      .setTitle('\u26A0\uFE0F Your Ranked Rank Has Been Reset')
      .setDescription('A moderator has reset your ranked standing. You\'ll need to redo your **5 placement matches** to earn a rank again.')
      .addFields(
        { name: 'Previous Rank', value: oldLabel + (wasPlaced ? ` \u2014 ${before.crystals} SC` : ''), inline: true },
        { name: 'Current Status', value: 'Unranked \u2014 0/5 placements', inline: true },
        { name: 'Reason', value: reason || '*No reason provided.*' },
      )
      .setFooter({ text: 'Run /challenge to start your placement matches.' })
      .setTimestamp();
    await user.send({ embeds: [embed] });
    dmNote = '\n\u2705 They were notified by DM.';
  } catch (e) {
    dmNote = '\n\u26A0\uFE0F Could not DM them (DMs closed or user unreachable).';
  }

  return interaction.reply({ content: `**Reset rank** for user ID \`${id}\` (was **${oldLabel}**). They must redo their 5 placement matches.${reason ? `\n**Reason:** ${reason}` : ''}${dmNote}` });
}

async function cmdEndBattle(interaction) {
  const userId = interaction.user.id;
  if (activeBattles.has(userId)) {
    activeBattles.delete(userId);
    return interaction.reply({ content: 'Battle force-ended. No rewards given.' });
  }
  if (activePvP.has(userId)) {
    const pvp = activePvP.get(userId);
    activePvP.delete(pvp.player1Id);
    activePvP.delete(pvp.player2Id);
    return interaction.reply({ content: 'PvP battle force-ended.' });
  }
  return interaction.reply({ content: 'You\'re not in a battle!', ephemeral: true });
}

async function cmdLeaderboard(interaction) {
  const type = interaction.options.getString('type');
  if (type === 'pvp') {
    const ranked = require('./ranked');
    const entries = playerDB.getRankedLeaderboard();
    const seasonOn = playerDB.isSeasonActive(); // UPDATE 32
    const seasonNum = playerDB.getSeasonNumber();
    if (entries.length === 0) {
      return interaction.reply({ content: seasonOn
        ? 'No ranked players yet! Finish your placement matches with `/challenge` to appear here.'
        : `The ranked season is over and there are no standings to show. Ranked reopens when Season **${seasonNum + 1}** starts.` });
    }
    const lines = entries.slice(0, 10).map((e, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
      return `${medal} <@${e.userId}> — **${ranked.labelFor(e.index)}** • ${e.crystals} SC`;
    });
    const { EmbedBuilder } = require('discord.js');
    const embed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle(seasonOn ? '🏆 PvP Ranked Leaderboard' : `🏁 Season ${seasonNum} — Final Standings`)
      .setDescription(lines.join('\n'));
    if (!seasonOn) embed.setFooter({ text: `Season ${seasonNum} is over — /challenge is unranked until Season ${seasonNum + 1} begins.` });
    return interaction.reply({ embeds: [embed] });
  }
  const entries = playerDB.getLeaderboard(type);
  const titles = { damage: '💥 Most Damage Dealt', determination: '💰 Richest (Determination)' };
  const units = { damage: 'dmg', determination: 'DT' };
  if (entries.length === 0 || entries.every(e => e.value === 0)) {
    return interaction.reply({ content: 'No data yet! Play some battles to get on the leaderboard.' });
  }
  const lines = entries.filter(e => e.value > 0).map((e, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
    return `${medal} <@${e.userId}> — **${e.value.toLocaleString()}** ${units[type]}`;
  });
  const { EmbedBuilder } = require('discord.js');
  const embed = new EmbedBuilder().setColor(0xFFD700).setTitle(titles[type]).setDescription(lines.join('\n'));
  return interaction.reply({ embeds: [embed] });
}

client.login(TOKEN);