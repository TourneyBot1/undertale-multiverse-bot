const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { TYPES, CHARACTERS, ITEMS, RECIPES, getLevelFromExp, getExpForNextLevel, getAvailableMoveCount, hasPassiveUnlocked, getTypeEmoji } = require('./gameData');

const COLORS = { bone: 0xE0E0E0, magic: 0xFFD700, food: 0xFF6B6B, weapon: 0x4FC3F7, unique: 0xFFA726, melee: 0xCD7F32, fire: 0xFF5722, shock: 0xFFEB3B, frost: 0x80DEEA, galactic: 0x9C27B0, victory: 0x4CAF50, defeat: 0xF44336, info: 0x7C4DFF, warning: 0xFFC107, neutral: 0x546E7A };
function getTypeColor(type) { return COLORS[type?.split('/')[0]?.trim()?.toLowerCase()] || COLORS.neutral; }
function hpBar(c, m, l = 10) { const f = Math.round((c / m) * l); return `\`${'█'.repeat(f)}${'░'.repeat(l - f)}\` ${c}/${m}`; }

const embeds = {
  battleState(state) {
    const p = state.player, e = state.enemy;
    if (state.neo) {
      return new EmbedBuilder().setColor(0xff0033).setTitle(`[[NEO]] — SEQUENCE ${state.neo.round}/3`)
        .setDescription(`Hit **1** through **${state.neo.count}** in order. **${state.neo.timer} seconds.**\nProgress: **${state.neo.progress}/${state.neo.count}**\nFail and everyone takes **${state.neo.round >= 3 ? 40 : 30}** damage.`)
        .addFields(state.playerTeamBars ? [{ name: 'Your Party', value: state.playerTeamBars }] : []);
    }
    if (state.cards) {
      return new EmbedBuilder().setColor(0x9b59b6).setTitle('CARDS OF [[FATE]]')
        .setDescription(`*[PICK A [[Card]], ANY [[KAARD]]!]*\nOne card only. **${state.cards.timerSeconds} seconds** — or fate picks for you.`);
    }
    return new EmbedBuilder().setColor(getTypeColor(p.type)).setTitle(`Battle - Turn ${state.turnNumber}`)
      .addFields(
        { name: `${getTypeEmoji(p.type)} ${p.name} Lv.${p.level}`, value: [`HP: ${hpBar(p.hp, p.maxHp)}`, `ATK: ${p.atk} | DEF: ${p.def}`, (p.pp !== null && p.pp !== undefined) ? `⚡ PP: **${p.pp}**/${p.maxPP}` : '', p.statusEffects.length > 0 ? `Status: ${p.statusEffects.join(', ')}` : '', p.isCharging ? '**CHARGING...**' : '', `Team: ${state.teamAlive}/${state.teamTotal}`].filter(Boolean).join('\n'), inline: true },
        { name: `${getTypeEmoji(e.type)} ${e.name}`, value: [`HP: ${hpBar(e.hp, e.maxHp)}`, `ATK: ${e.atk} | DEF: ${e.def}`, e.statusEffects.length > 0 ? `Status: ${e.statusEffects.join(', ')}` : ''].filter(Boolean).join('\n'), inline: true }
      );
  },
  abilityButtons(state) {
    // --- SCAMTON EVENT: THE TRUE POWER OF [[NEO]] — the UI is erased and replaced ---
    if (state.neo) {
      const rows = [];
      let row = new ActionRowBuilder();
      state.neo.layout.forEach((v, i) => {
        if (i > 0 && i % 5 === 0) { rows.push(row); row = new ActionRowBuilder(); }
        const pressed = v <= state.neo.progress;
        row.addComponents(new ButtonBuilder().setCustomId(`neo_${v}`).setLabel(String(v)).setStyle(pressed ? ButtonStyle.Success : ButtonStyle.Danger).setDisabled(pressed));
      });
      rows.push(row);
      return rows;
    }
    // --- SCAMTON EVENT: CARDS OF [[FATE]] ---
    if (state.cards) {
      const row = new ActionRowBuilder();
      state.cards.suits.forEach((suit, i) => {
        row.addComponents(new ButtonBuilder().setCustomId(`card_${i}`).setLabel(suit).setStyle(ButtonStyle.Secondary));
      });
      return [row];
    }
    const abs = state.player.abilities, level = state.player.level || 1, mc = getAvailableMoveCount(level, state.player.id), rows = [];
    const row = new ActionRowBuilder();
    abs.forEach((a, i) => {
      const locked = i >= mc, noUses = a.uses <= 0, onCd = (a.cooldownLeft || 0) > 0;
      // --- SCAMTON EVENT: Power Points cost on the button ---
      const ppCost = a.ppCost || 0;
      const noPP = ppCost > 0 && (state.player.pp || 0) < ppCost;
      let label = locked ? `${a.name} (Locked)` : onCd ? `${a.name} (CD:${a.cooldownLeft})` : `${a.name} ${a.typeEmoji} (${a.uses}/${a.maxUses})${ppCost ? ` ⚡${ppCost}` : ''}`;
      row.addComponents(new ButtonBuilder().setCustomId(`ability_${i}`).setLabel(label.slice(0, 80)).setStyle(locked || noUses || onCd || noPP ? ButtonStyle.Secondary : ButtonStyle.Primary).setDisabled(locked || noUses || onCd || noPP));
    });
    rows.push(row);
    const utilRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('switch_char').setLabel('Switch').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('skip_turn').setLabel('Skip Turn').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('run_away').setLabel('Run').setStyle(ButtonStyle.Danger)
    );
    if (state.isBoss) {
      const taOnCd = state.teamAbilityCooldown > 0;
      utilRow.addComponents(new ButtonBuilder().setCustomId('team_ability').setLabel(taOnCd ? `Team Ability (CD:${state.teamAbilityCooldown})` : 'Team Ability ⚡').setStyle(ButtonStyle.Primary).setDisabled(taOnCd));
    }
    rows.push(utilRow);
    return rows;
  },
  switchMenu(team, activeIndex) {
    const options = team.map((m, i) => {
      const cd = CHARACTERS[m.character_id]; if (!cd) return null;
      const lv = getLevelFromExp(m.exp || 0);
      return { label: `${cd.name} Lv.${lv}${m.shiny ? ' ✦' : ''}${i === activeIndex ? ' (Active)' : ''}`, description: `${cd.type} | HP: ${cd.hp} | ATK: ${cd.atk} | DEF: ${cd.def}`, value: `switch_${i}` };
    }).filter(Boolean);
    return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('switch_select').setPlaceholder('Choose character...').addOptions(options));
  },
  battleLog(lines) { return new EmbedBuilder().setColor(COLORS.neutral).setDescription(lines.join('\n')); },
  victory(enemyName, rewards, expAmt, expResults) {
    const rt = rewards.length > 0 ? rewards.map(r => `${r.emoji} **${r.name}** x${r.amount}`).join('\n') : '*No loot...*';
    let et = `+${expAmt} EXP to all team members`;
    if (expResults?.length > 0) et += '\n' + expResults.join('\n');
    return new EmbedBuilder().setColor(COLORS.victory).setTitle('Victory!').setDescription(`You defeated **${enemyName}**!`)
      .addFields({ name: 'Rewards', value: rt }, { name: 'Experience', value: et });
  },
  defeat(name) { return new EmbedBuilder().setColor(COLORS.defeat).setTitle('Defeat...').setDescription(`All your characters were defeated by **${name}**...`); },
  profile(user, player, charCount, teamSize, bossKills = 0) {
    return new EmbedBuilder().setColor(COLORS.info).setTitle(`${user.username}'s Profile`).setThumbnail(user.displayAvatarURL())
      .addFields({ name: 'Determination', value: `${player.determination}`, inline: true }, { name: 'Soul Essence', value: `${player.soul_essence}`, inline: true }, { name: 'Characters', value: `${charCount}`, inline: true }, { name: 'Team', value: `${teamSize}/6`, inline: true }, { name: 'Boss Kills', value: `${bossKills}`, inline: true });
  },
  inventory(player, items) {
    const lines = items.length > 0 ? items.map(i => { const d = ITEMS[i.item_id]; return `${d?.emoji || ''} **${d?.name || i.item_id}** x${i.amount}`; }) : ['*Empty...*'];
    // Split into chunks under 1024 chars
    const chunks = [];
    let current = '';
    for (const line of lines) {
      if ((current + '\n' + line).length > 1024) { chunks.push(current); current = line; }
      else current = current ? current + '\n' + line : line;
    }
    if (current) chunks.push(current);
    const fields = chunks.map((c, i) => ({ name: i === 0 ? 'Items' : '\u200b', value: c }));
    return new EmbedBuilder().setColor(COLORS.info).setTitle('Inventory')
      .addFields({ name: 'Determination', value: `${player.determination}`, inline: true }, { name: 'Soul Essence', value: `${player.soul_essence}`, inline: true }, { name: '\u200b', value: '\u200b', inline: true }, ...fields);
  },
  characterList(chars) {
    if (chars.length === 0) return new EmbedBuilder().setColor(COLORS.warning).setDescription('No characters! Use `/start`.');
    const cl = chars.map(c => {
      const d = CHARACTERS[c.character_id]; if (!d) return null;
      const lv = getLevelFromExp(c.exp || 0), ne = getExpForNextLevel(lv);
      const es = ne ? `${c.exp || 0}/${ne}` : `${c.exp || 0} (MAX)`;
      const sh = c.shiny ? ' **✦ SHINY**' : '';
      return `**[${c.id}]** ${getTypeEmoji(d.type)} **${d.name}** Lv.${lv}${sh} — HP: ${d.hp}${c.shiny ? '+0' : ''} | ATK: ${d.atk}${c.shiny ? '+2' : ''} | DEF: ${d.def}${c.shiny ? '+2' : ''} | EXP: ${es}`;
    }).filter(Boolean).join('\n');
    return new EmbedBuilder().setColor(COLORS.info).setTitle('Your Characters').setDescription(cl).setFooter({ text: 'Use /setteam <slot> <id> | Use /exile <id> to remove' });
  },
  teamDisplay(team) {
    if (team.length === 0) return new EmbedBuilder().setColor(COLORS.warning).setDescription('Team empty! Use `/setteam`.');
    const tl = team.map(t => {
      const d = CHARACTERS[t.character_id]; if (!d) return `Slot ${t.slot}: Unknown`;
      const lv = getLevelFromExp(t.exp || 0); const sh = t.shiny ? ' ✦' : '';
      return `**Slot ${t.slot}:** ${getTypeEmoji(d.type)} **${d.name}${sh}** Lv.${lv} — HP: ${d.hp} | ATK: ${d.atk} | DEF: ${d.def}`;
    }).join('\n');
    return new EmbedBuilder().setColor(COLORS.info).setTitle('Your Team').setDescription(tl).setFooter({ text: `${team.length}/6 slots` });
  },
  craftMenu() {
    const entries = Object.values(RECIPES).map(r => {
      const ing = Object.entries(r.ingredients).map(([id, amt]) => id === 'soul_essence' ? `Soul Essence x${amt}` : id === 'determination' ? `Determination x${amt}` : `${ITEMS[id]?.name || id} x${amt}`).join(' + ');
      return `**${r.name}**\n${r.description}\nCost: ${ing}`;
    });
    const fields = [];
    let buf = '';
    for (const e of entries) {
      const piece = e.length > 1024 ? e.slice(0, 1021) + '...' : e;
      if (buf && (buf.length + 2 + piece.length) > 1024) { fields.push(buf); buf = piece; }
      else { buf = buf ? buf + '\n\n' + piece : piece; }
    }
    if (buf) fields.push(buf);
    return new EmbedBuilder().setColor(COLORS.info).setTitle('Crafting Menu').setFooter({ text: '/craft <recipe>' })
      .addFields(fields.map((v, i) => ({ name: i === 0 ? 'Recipes' : '\u200b', value: v })));
  },
  fuseMenu() {
    const recipes = [
      {
        name: '🕰️ Time Paradox',
        description: 'Fuse Ainavol + agem with a Broken Clock to create the master of time.',
        cost: 'Ainavol + agem + 🕰️ Broken Clock (inventory)',
        usage: '/fuse fuse1:<ainavol_id> fuse2:<agem_id>',
      },
      {
        name: '⏳ Ainavolagem',
        description: 'Fuse Waterfall Dust Sans with Ainavol + agem into a unified timeline.',
        cost: 'Waterfall Dust Sans + Ainavol + agem',
        usage: '/fuse base:<wf_dust_id> fuse1:<ainavol_id> fuse2:<agem_id>',
      },
      {
        name: '💙 UV Swap Sans',
        description: 'Sacrifice 3 Underswap Sanses and an Underswap Papyrus with a Blue Bone to awaken UV Swap Sans.',
        cost: '3x Underswap Sans + 1x Underswap Papyrus + 🦴 Blue Bone (inventory)',
        usage: '/fuse fuse1:<us_sans> fuse2:<us_sans> fuse3:<us_sans> fuse4:<us_papyrus>',
      },
      {
        name: '🪓 C!Insanity (middle form)',
        description: 'Use the Axe of a Thousand Souls on Weak C!Insanity.',
        cost: 'Weak C!Insanity + 🪓 Axe of a Thousand Souls + 2,500 DT + 5,000 Soul Essence + 1,000 DT Vials',
        usage: '/fuse base:<weak_cinsanity_id>',
      },
      {
        name: '⚔️ Avenge Sans',
        description: 'Use the Blade of the Omniverse on Weak Avenge Sans (requires C!Insanity on team).',
        cost: 'Weak Avenge Sans + ⚔️ Blade of the Omniverse + 6,000 DT + 12,000 SE + 3 Integrity Souls + Any C!Insanity on team',
        usage: '/fuse base:<weak_avenge_id>',
      },
      {
        name: '🪓 Final Insanity',
        description: 'Use the Axe of a Hundred Thousand Souls on C!Insanity (requires Avenge Sans on team).',
        cost: 'C!Insanity + 🪓 Axe of a Hundred Thousand Souls + 10,000 DT + 20,000 SE + 5,000 DT Vials + 💚 Shattered Kindness Soul + Avenge Sans on team',
        usage: '/fuse base:<cinsanity_id>',
      },
      {
        name: '📜 Call of the Void Sans',
        description: 'Merge Lv5 Sans, Lv5 Papyrus, and Lv5 W.D. Gaster using the Void Tablet.',
        cost: 'Lv5 Sans + Lv5 Papyrus + Lv5 W.D. Gaster + 📜 Void Tablet (inventory)',
        usage: '/fuse base:<sans_id> fuse1:<papyrus_id> fuse2:<gaster_id>',
      },
      {
        name: '🔥 CATASTROPHE!FELL',
        description: 'Combust Underfell Sans with Ainavol, agem, and Ainavolagem into a dying inferno.',
        cost: 'Underfell Sans + Ainavol + agem + Ainavolagem',
        usage: '/fuse base:<underfell_id> fuse1:<ainavol_id> fuse2:<agem_id> fuse3:<ainavolagem_id>',
      },
      {
        name: '🧠 RK!Swap Papyrus',
        description: 'Recalled Knowledge. Last Breath Sans fuses with Underswap Papyrus, Underswap Sans, and W.D. Gaster.',
        cost: 'Last Breath Sans + Underswap Papyrus + Underswap Sans + W.D. Gaster',
        usage: '/fuse base:<last_breath_id> fuse1:<us_pap_id> fuse2:<us_sans_id> fuse3:<gaster_id>',
      },
      {
        name: '🧠 RK!Storyshift Chara',
        description: 'Recalled Knowledge. Storyshift Chara fuses with Last Breath Sans and W.D. Gaster.',
        cost: 'Storyshift Chara + Last Breath Sans + W.D. Gaster',
        usage: '/fuse base:<storyshift_chara_id> fuse1:<last_breath_id> fuse2:<gaster_id>',
      },
      {
        name: '🤝 TS!Sans/Crossbones',
        description: 'A new soul born from a Team Switch. Underswap Sans + Underswap Papyrus + Ketchup Gun.',
        cost: 'Underswap Sans + Underswap Papyrus + 🔫 Ketchup Gun (inventory)',
        usage: '/fuse base:<us_sans_id> fuse1:<us_pap_id>',
      },
      {
        name: '🤝 TS!Papyrus',
        description: 'A new Papyrus born from a Team Switch. TS!Sans + Underswap Papyrus + Cigarette Pack.',
        cost: 'TS!Sans + Underswap Papyrus + 🚬 Cigarette Pack (inventory)',
        usage: '/fuse base:<ts_sans_id> fuse1:<us_pap_id>',
      },
    ];
    const rl = recipes.map(r => `**${r.name}**\n${r.description}\nCost: ${r.cost}\nUsage: \`${r.usage}\``).join('\n\n');
    return new EmbedBuilder().setColor(COLORS.info).setTitle('Fusion Recipes').setDescription(rl);
  },
  help() {
    return new EmbedBuilder().setColor(COLORS.info).setTitle('Undertale Sans Bot - Help')
      .addFields(
        { name: '🚀 Start', value: '`/start` - Get your starter Sans' },
        { name: '⚔️ Battle', value: '`/encounter` - Fight a random enemy\n`/boss` - Fight a boss\n`/challenge` - PvP another player' },
        { name: '👥 Collection', value: '`/characters` - View all your characters\n`/charinfo` - View character details\n`/team` - View your team\n`/setteam` - Set team slot (max 6)\n`/exile` - Remove a character permanently' },
        { name: '🎒 Items', value: '`/inventory` - Check items & currencies\n`/craftmenu` - View crafting recipes\n`/craft` - Craft an item\n`/use` - Use an item' },
        { name: '🛒 Shop', value: '`/shop browse` - Browse items for sale\n`/shop buy <item>` - Buy an item with Determination' },
        { name: '💰 Economy', value: '`/convert <amount>` - Convert DT Vials to Determination (10:1)' },
        { name: '🏆 Achievements', value: '`/achievements` - View and track your achievements' },
        { name: '📋 Other', value: '`/profile` - View your stats\n`/leaderboard` - View leaderboards\n`/endbattle` - Force-end a stuck battle' },
        { name: '⚔️ Battle Tips', value: 'Skip Turn: 10% dodge chance\nSwitch: Change active character\nRun: Flee from battle' },
        { name: '📈 Levels', value: 'Lv1: 2 moves | Lv2: 3 moves (20 EXP) | Lv3: (50 EXP) | Lv4: passive (120 EXP) | Lv5: max (250 EXP)' },
        { name: '🔰 Types', value: '🦴 Bone > ✨ Magic > 🌭 Food > ⭐ Unique > 🗡️ Weapon > 🦴 Bone\n👊 Melee > ✨ Magic, resists 🦴 Bone' },
        { name: '💬 Community', value: 'Join the official server: https://discord.gg/fDutC9gtQG\n🌐 Website: https://umtbot.com' },
      );
  },
  welcome(user) {
    return new EmbedBuilder().setColor(COLORS.info).setTitle('Welcome to the Underground!')
      .setDescription(`Hey **${user.username}**! You received 🦴 **Sans**!\n\nUse \`/encounter\` to fight and \`/help\` for commands.`).setThumbnail(user.displayAvatarURL());
  },
  serverWelcome() {
    return new EmbedBuilder().setColor(COLORS.info).setTitle('💀 Thanks for adding UMT Bot!')
      .setDescription([
        'A turn-based Undertale RPG — collect 100+ Sans AUs, build a team, and battle bosses, craft, fuse, and fight other players.',
        '',
        '**Get started:**',
        '`/start` — claim your first Sans',
        '`/help` — see every command',
        '`/encounter` — jump into your first fight',
        '',
        '**Join the community:** https://discord.gg/fDutC9gtQG',
        '🌐 https://umtbot.com',
      ].join('\n'));
  },
  alreadyStarted() { return new EmbedBuilder().setColor(COLORS.warning).setTitle('Already Started').setDescription('Use `/encounter` to fight or `/help` for commands.'); },

  charInfo(cd) {
    const typeEmoji = getTypeEmoji(cd.type);
    const passiveText = cd.passive ? `**${cd.passive.name}** — ${cd.passive.description}` : 'None';
    const abilityStrings = cd.abilities.map((a, i) => {
      const abilityEmoji = getTypeEmoji(a.type);
      // --- UPDATE 15: honor displayDamage override (e.g. Chara ERASE flavor) ---
      const dmg = a.displayDamage || (a.damageMax > 0 ? `${a.damageMin}-${a.damageMax}` : 'N/A');
      const special = a.description || '';
      return `**${i + 1}. ${a.name}** ${abilityEmoji} (${a.type})\nDamage: ${dmg} | Uses: ${a.maxUses}\n${special}`;
    });
    // Discord caps each embed field value at 1024 chars. Pack abilities into
    // as many <=1024 fields as needed (Fallen Priest's 5 moves overflow one field).
    const abilityFields = [];
    let abilBuf = '';
    for (const s of abilityStrings) {
      const piece = s.length > 1024 ? s.slice(0, 1021) + '...' : s;
      if (abilBuf && (abilBuf.length + 2 + piece.length) > 1024) { abilityFields.push(abilBuf); abilBuf = piece; }
      else { abilBuf = abilBuf ? abilBuf + '\n\n' + piece : piece; }
    }
    if (abilBuf) abilityFields.push(abilBuf);

    // Level unlocks: honor per-character moveUnlocks + passive unlock level (e.g. Fallen Priest).
    // Characters without these fields fall back to the original generic list (unchanged).
    const passiveLevel = cd.passive?.unlockLevel || 4;
    let levelInfo;
    if (cd.moveUnlocks) {
      const EXP = [0, 20, 50, 120, 250];
      const lines = [];
      for (let L = 1; L <= 5; L++) {
        const cur = cd.moveUnlocks[L] || 2;
        if (L === 1) { lines.push(`Lv1: Moves 1-${cur}`); continue; }
        const prev = cd.moveUnlocks[L - 1] || 2;
        const parts = [];
        if (cur > prev) parts.push(cur - prev === 1 ? `Unlock move ${cur}` : `Unlock moves ${prev + 1}-${cur}`);
        if (L === passiveLevel) parts.push('passive');
        if (L === 5) parts.push('MAX');
        const head = parts.length ? parts.join(' + ') + ' ' : '';
        lines.push(`Lv${L}: ${head}(${EXP[L - 1]} EXP)`);
      }
      levelInfo = lines.join('\n');
    } else {
      levelInfo = [
        'Lv1: Moves 1-2',
        'Lv2: Unlock move 3 (20 EXP)',
        'Lv3: (50 EXP)',
        'Lv4: Unlock passive + move 4 (120 EXP)',
        'Lv5: MAX (250 EXP)',
      ].join('\n');
    }

    // --- UPDATE 15: honor hideStats (Core Frisk) ---
    const statsLine = cd.hideStats
      ? `HP: ??? | ATK: ??? | DEF: ???\nType: ???`
      : `HP: ${cd.hp} | ATK: ${cd.atk} | DEF: ${cd.def}\nType: ${cd.type}`;

    const fields = [
      { name: 'Stats', value: statsLine, inline: false },
      { name: `Passive (Unlocks Lv${passiveLevel})`, value: passiveText, inline: false },
    ];
    abilityFields.forEach((v, i) => fields.push({ name: i === 0 ? 'Abilities' : '\u200b', value: v, inline: false }));
    fields.push({ name: 'Level Unlocks', value: levelInfo, inline: false });
    fields.push({ name: '📥 How to Obtain', value: (cd.obtainment && cd.obtainment.length <= 1024) ? cd.obtainment : (cd.obtainment ? cd.obtainment.slice(0, 1021) + '...' : '*Not currently obtainable through normal play (special event / admin grant).*'), inline: false });

    return new EmbedBuilder()
      .setColor(getTypeColor(cd.type))
      .setTitle(`${typeEmoji} ${cd.name}`)
      .setDescription(cd.description)
      .addFields(fields);
  },

  // PvP embeds
  pvpBattleState(pvpBattle, forPlayerId) {
    const state = pvpBattle.getState(forPlayerId);
    const p = state.player, e = state.enemy;
    return new EmbedBuilder().setColor(state.isMyTurn ? 0x4CAF50 : 0xF44336)
      .setTitle(`PvP Battle - Turn ${state.turnNumber}${state.isMyTurn ? ' (Your Turn)' : ''}`)
      .addFields(
        { name: `${getTypeEmoji(p.type)} ${p.name} Lv.${p.level}`, value: [`HP: ${hpBar(p.hp, p.maxHp)}`, `ATK: ${p.atk} | DEF: ${p.def}`, p.statusEffects.length > 0 ? `Status: ${p.statusEffects.join(', ')}` : '', `Team: ${state.teamAlive}/${state.teamTotal}`].filter(Boolean).join('\n'), inline: true },
        { name: `${getTypeEmoji(e.type)} ${e.name}`, value: [`HP: ${hpBar(e.hp, e.maxHp)}`, `ATK: ${e.atk} | DEF: ${e.def}`, e.statusEffects.length > 0 ? `Status: ${e.statusEffects.join(', ')}` : '', `Team: ${state.enemyAlive}/${state.enemyTotal}`].filter(Boolean).join('\n'), inline: true }
      );
  },

  pvpButtons(state, forPlayerId) {
    const abs = state.player.abilities, level = state.player.level || 1, mc = getAvailableMoveCount(level, state.player.id), rows = [];
    const row = new ActionRowBuilder();
    abs.forEach((a, i) => {
      const locked = i >= mc, noUses = a.uses <= 0, onCd = (a.cooldownLeft || 0) > 0;
      let label = locked ? `${a.name} (Locked)` : onCd ? `${a.name} (CD:${a.cooldownLeft})` : `${a.name} ${a.typeEmoji} (${a.uses}/${a.maxUses})`;
      row.addComponents(new ButtonBuilder().setCustomId(`pvp_ability_${i}`).setLabel(label).setStyle(locked || noUses || onCd ? ButtonStyle.Secondary : ButtonStyle.Primary).setDisabled(locked || noUses || onCd));
    });
    rows.push(row);
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('pvp_switch').setLabel('Switch').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('pvp_forfeit').setLabel('Forfeit').setStyle(ButtonStyle.Danger)
    ));
    return rows;
  },

  pvpSwitchMenu(team, activeIndex) {
    const options = team.map((m, i) => {
      const cd = CHARACTERS[m.character_id]; if (!cd) return null;
      const lv = getLevelFromExp(m.exp || 0);
      return { label: `${cd.name} Lv.${lv}${m.shiny ? ' ✦' : ''}${i === activeIndex ? ' (Active)' : ''}`, description: `${cd.type}`, value: `switch_${i}` };
    }).filter(Boolean);
    return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('pvp_switch_select').setPlaceholder('Choose character...').addOptions(options));
  },

  pvpVictory(rr) {
    const ranked = require('./ranked');
    // --- UPDATE 32: offseason matches award nothing ---
    if (rr.unranked) {
      return new EmbedBuilder().setColor(COLORS.victory).setTitle('PvP Battle Over!')
        .setDescription(`🏆 <@${rr.winnerId}> defeated <@${rr.loserId}>!\n\n*Unranked match — the season is over, so no Shadow Crystals were awarded.*`);
    }
    const fmtSide = (id, o) => {
      if (o.placement) {
        if (o.placement.justPlaced) {
          return `<@${id}> finished placements (${o.placement.wins}/5) → **${ranked.labelFor(o.placement.startIndex)}**!`;
        }
        return `<@${id}> — Placement **${o.placement.games}/5** (${o.placement.wins} W so far)`;
      }
      const sign = o.delta >= 0 ? '+' : '';
      let line = `<@${id}> — **${ranked.labelFor(o.after.index)}** • ${o.after.crystals} SC (${sign}${o.delta})`;
      if (o.promoted) line += ' 🔼 **PROMOTED!**';
      if (o.demoted) line += ' 🔻 **DEMOTED!**';
      return line;
    };
    return new EmbedBuilder().setColor(COLORS.victory).setTitle('PvP Battle Over!')
      .setDescription(`🏆 <@${rr.winnerId}> defeated <@${rr.loserId}>!\n\n${fmtSide(rr.winnerId, rr.winner)}\n${fmtSide(rr.loserId, rr.loser)}`);
  },
  rankCard(user, r, season) {
    const ranked = require('./ranked');
    const color = ranked.colorFor(r.index, r.placed);
    const embed = new EmbedBuilder().setColor(color).setTitle(`${user.username}'s Rank`).setThumbnail(user.displayAvatarURL());
    // --- UPDATE 32: offseason ---
    if (season && season.seasonActive === false) {
      const sn = season.seasonNumber || 1;
      const standing = r.placed
        ? `Your Season ${sn} finish: **${ranked.labelFor(r.index)}** • ${r.crystals} SC`
        : `You didn't finish placements in Season ${sn}, so you ended **Unranked**.`;
      embed.setDescription(`🏁 **Season ${sn} is over.**\n${standing}\n\n\`/challenge\` is still open, but matches are **unranked** — no Shadow Crystals until Season ${sn + 1} starts.`);
      return embed;
    }
    if (!r.placed) {
      embed.setDescription(`**Unranked**\nPlacements: **${r.placementGames}/5** completed (${r.placementWins} W)\nFinish your placement matches with \`/challenge\` to earn a rank!`);
      return embed;
    }
    if (r.index >= ranked.MAX_INDEX) {
      const rate = ranked.scPerMatch(r.index);
      embed.setDescription(`**True Determination**\n💠 Shadow Crystals: **${r.crystals}**\n**+${rate} / -${rate} SC** per match\nNo division cap — grind as high as you can to climb the leaderboard!`);
      return embed;
    }
    const rate = ranked.scPerMatch(r.index);
    const filled = Math.max(0, Math.min(10, Math.round(r.crystals / 10)));
    const bar = '▰'.repeat(filled) + '▱'.repeat(10 - filled);
    embed.setDescription(`**${ranked.labelFor(r.index)}**\n\`${bar}\` **${r.crystals}/100** SC\n**+${rate} / -${rate} SC** per match\nReach 100 to promote!`);
    return embed;
  },
};
module.exports = embeds;
