const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const { TOKEN, CLIENT_ID, GUILD_ID } = require('./config');

const commands = [
  new SlashCommandBuilder().setName('start').setDescription('Start your adventure and get your starter Sans!'),
  new SlashCommandBuilder().setName('encounter').setDescription('Fight a random AI enemy!')
    .addStringOption(o => o.setName('difficulty').setDescription('Choose difficulty').setRequired(true)
      .addChoices(
        { name: '🟢 Easy (Ruins)', value: 'easy' },
        { name: '🔵 Medium (Snowdin)', value: 'medium' },
        { name: '🟠 Hard (Hotlands)', value: 'hard' },
        { name: '🔴 Very Hard (Core)', value: 'veryHard' },
        { name: '💀 Bad Time (Surface)', value: 'badTime' },
      )),
  new SlashCommandBuilder().setName('inventory').setDescription('Check your inventory and currencies.'),
  new SlashCommandBuilder().setName('characters').setDescription('View all your characters.'),
  new SlashCommandBuilder().setName('team').setDescription('View your battle team.'),
  new SlashCommandBuilder().setName('setteam').setDescription('Set a character to a team slot.')
    .addIntegerOption(o => o.setName('slot').setDescription('Team slot (1-6)').setRequired(true).setMinValue(1).setMaxValue(6))
    .addIntegerOption(o => o.setName('character_id').setDescription('Character ID from /characters').setRequired(false)),
  new SlashCommandBuilder().setName('craftmenu').setDescription('View crafting recipes.'),
  new SlashCommandBuilder().setName('fusemenu').setDescription('View fusion recipes.'),
  new SlashCommandBuilder().setName('craft').setDescription('Craft an item.')
    .addStringOption(o => o.setName('recipe').setDescription('What to craft (type to search)').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('use').setDescription('Use an item. Search by typing the item or character name.')
    .addStringOption(o => o.setName('item').setDescription('What to use (type to search)').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('gacha').setDescription('Pull the gacha for random loot! Costs 4000 Determination.'),
  new SlashCommandBuilder().setName('sellvalues').setDescription('View the Determination sell value of every item.'),
  new SlashCommandBuilder().setName('boss').setDescription('Challenge a boss!')
    .addStringOption(o => o.setName('boss').setDescription('Which boss to fight').setRequired(true).addChoices(
      { name: 'Toriel (Ruins)', value: 'toriel' },
      { name: 'Papyrus (Snowdin)', value: 'papyrus' },
      { name: 'Undyne (Waterfall)', value: 'undyne' },
      { name: 'W.D. Gaster', value: 'wd_gaster' },
      { name: 'Time Paradox', value: 'time_paradox_boss' },
      { name: 'Asgore', value: 'asgore' },
      { name: 'Mafia Sans', value: 'mafia_sans_boss' },
      { name: 'Mettaton NEO', value: 'mettaton_neo' },
      { name: 'Omega Flowey', value: 'omega_flowey' },
      { name: 'Bad Time Sans', value: 'bad_time_sans' },
      { name: 'Sans?', value: 'sans_question' },
      { name: 'Nightmare Sans', value: 'nightmare_sans_boss' },
      { name: 'FatalError!Sans', value: 'fatalerror_sans_boss' },
      { name: 'The Roaring Knight', value: 'roaring_knight_boss' },
      { name: 'Pesti Sans', value: 'pesti_sans_boss' },
      { name: 'Jevil, The Lousy Devil', value: 'jevil' },
      { name: 'SCAMPTON [[THE GREAT]] (Event)', value: 'scamton_the_great' },
      { name: 'M87 (Galactic Event — Galactic Ticket)', value: 'm87_boss' },
      { name: 'Fallen Stars (Galactic Event — Galactic Ticket)', value: 'fallen_stars_boss' },
    )),
  new SlashCommandBuilder().setName('superboss').setDescription('Challenge a SUPERBOSS! (Requires Event Boss Ticket, 20 min cooldown on win)')
    .addStringOption(o => o.setName('boss').setDescription('Which superboss to fight').setRequired(true).addChoices(
      { name: 'HIM (Gaster)', value: 'him_boss' },
    )),
  new SlashCommandBuilder().setName('sacrifice').setDescription('Sacrifice a character for a transformation or item.')
    .addStringOption(o => o.setName('target').setDescription('What to sacrifice for').setRequired(true).addChoices(
      { name: 'DUSTBEEF BUT IN SNOWS (sacrifice Snowdin Dust, Lv5 Papyrus on team, 1.1k DT)', value: 'dustbeef' },
      { name: "Broken Soul Shard (sacrifice Dust!Tale: [Evan's])", value: 'evans_dust' },
      { name: 'Enlightened Sans (sacrifice Judgement Hall Dust Sans)', value: 'enlightened_sans' },
      { name: 'my memories!! (sacrifice Enlightened Judgement Hall Dust Sans)', value: 'my_memories' },
    )),
  new SlashCommandBuilder().setName('exile').setDescription('Remove a character from your collection permanently.')
    .addIntegerOption(o => o.setName('character_id').setDescription('Character ID to exile').setRequired(true)),
  new SlashCommandBuilder().setName('saveteam').setDescription('Save your current team under a name for quick loading later.')
    .addStringOption(o => o.setName('name').setDescription('Name for this saved team (max 20 chars)').setRequired(true)),
  new SlashCommandBuilder().setName('loadteam').setDescription('Load a previously saved team.')
    .addStringOption(o => o.setName('name').setDescription('Name of the saved team to load').setRequired(true)),
  new SlashCommandBuilder().setName('profile').setDescription('View your profile.'),
  new SlashCommandBuilder().setName('help').setDescription('View all commands.'),
  new SlashCommandBuilder().setName('charinfo').setDescription('View detailed info about a character type.')
    .addStringOption(o => o.setName('character').setDescription('Character to view').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('challenge').setDescription('Join the global ranked queue — auto-matches you with anyone else searching!').setDMPermission(true),
  new SlashCommandBuilder().setName('pvpnotify').setDescription('Get a DM when someone searches for a ranked match. Off by default.')
    .addStringOption(o => o.setName('state').setDescription('Turn notifications on or off').setRequired(false)
      .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }))
    .setDMPermission(true),
  new SlashCommandBuilder().setName('matchlog').setDescription('(Admin) View recent ranked matches & flag repeat pairings.').setDMPermission(false),
  new SlashCommandBuilder().setName('rank').setDescription('View your PvP rank and Shadow Crystals.'),
  new SlashCommandBuilder().setName('givecharacter').setDescription('(Admin) Give a character to any Discord user ID.')
    .addStringOption(o => o.setName('user_id').setDescription('Discord user ID to give to').setRequired(true))
    .addStringOption(o => o.setName('character').setDescription('Character name to give').setRequired(true).setAutocomplete(true))
    .addBooleanOption(o => o.setName('shiny').setDescription('Make it shiny?').setRequired(false)),
  new SlashCommandBuilder().setName('endseason').setDescription('(Mod) End the ranked season: reward the top 3 and close ranked.'),
  new SlashCommandBuilder().setName('startseason').setDescription('(Mod) Start the next ranked season: reset everyone to placements and reopen crystals.'),

  new SlashCommandBuilder().setName('shop').setDescription('Negativetale\'s Shop.')
    .addSubcommand(sub => sub.setName('browse').setDescription('Browse all items for sale.'))
    .addSubcommand(sub => sub.setName('buy').setDescription('Buy an item from the shop.')
      .addStringOption(o => o.setName('item').setDescription('Item to buy').setRequired(true).addChoices(
        { name: 'Monster Soul (200 DT)', value: 'monster_soul' },
        { name: 'Tier 1 Monster Soul (350 DT)', value: 'tier1_monster_soul' },
        { name: 'Tier 2 Monster Soul (600 DT)', value: 'tier2_monster_soul' },
        { name: 'Tier 3 Monster Soul (1000 DT)', value: 'tier3_monster_soul' },
        { name: 'Star Piece (1200 DT)', value: 'star_piece' },
        { name: 'Event Boss Ticket (2000 DT)', value: 'event_boss_ticket' },
        { name: 'Galactic Ticket (5000 DT + 500 SE)', value: 'galactic_ticket' },
        { name: 'Negativetale Sans (10000 DT)', value: 'negativetale_sans' },
        { name: 'Hardmode Essence (25000 DT)', value: 'hardmode_essence' },
        { name: 'ChromaKey Piece A (19970 DT)', value: 'chromakey_piece_a' },
      ))
      .addIntegerOption(o => o.setName('amount').setDescription('How many to buy (bulk buy, max 99)').setRequired(false).setMinValue(1).setMaxValue(99))),
  new SlashCommandBuilder().setName('convert').setDescription('Convert DT Vials to Determination. (1 DT Vial = 25 Determination)')
    .addIntegerOption(o => o.setName('amount').setDescription('How many DT Vials to convert').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('lock').setDescription('Lock a character so it can\'t be exiled or evolved.')
    .addIntegerOption(o => o.setName('character_id').setDescription('Character ID to lock').setRequired(true)),
  new SlashCommandBuilder().setName('unlock').setDescription('Unlock a previously locked character.')
    .addIntegerOption(o => o.setName('character_id').setDescription('Character ID to unlock').setRequired(true)),
  new SlashCommandBuilder().setName('achievements').setDescription('View and claim your achievements.'),
  new SlashCommandBuilder().setName('endbattle').setDescription('Force-end a stuck battle. No rewards.'),
  new SlashCommandBuilder().setName('scavenge').setDescription('Send a character to scavenge for items. Costs 1000 Soul Essence.'),
  new SlashCommandBuilder().setName('sell').setDescription('Sell an item for Determination (3.5x value).')
    .addStringOption(o => o.setName('item').setDescription('Item to sell').setRequired(true).setAutocomplete(true))
    .addIntegerOption(o => o.setName('amount').setDescription('How many to sell').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('giveboosterreward').setDescription('(Mod) Manually send booster reward DM to a user.')
    .addUserOption(o => o.setName('player').setDescription('Player to send reward to').setRequired(true)),
  new SlashCommandBuilder().setName('giveitem').setDescription('(Mod) Give items to a player.')
    .addUserOption(o => o.setName('player').setDescription('Player').setRequired(true))
    .addStringOption(o => o.setName('item').setDescription('Item to give').setRequired(true).setAutocomplete(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(false).setMinValue(1)),
  new SlashCommandBuilder().setName('removeitem').setDescription('(Mod) Remove items from a player.')
    .addUserOption(o => o.setName('player').setDescription('Player').setRequired(true))
    .addStringOption(o => o.setName('item').setDescription('Item to remove').setRequired(true).setAutocomplete(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(false).setMinValue(1)),
  new SlashCommandBuilder().setName('resetdata').setDescription('(Mod) Reset a player\'s data.')
    .addUserOption(o => o.setName('player').setDescription('Player to reset').setRequired(true)),
  new SlashCommandBuilder().setName('wipedata').setDescription('(Mod) Globally wipe ALL data for a Discord user ID.')
    .addStringOption(o => o.setName('user_id').setDescription('Discord user ID to wipe').setRequired(true)),
  new SlashCommandBuilder().setName('resetrank').setDescription('(Mod) Reset a user\'s rank (forces new placements) by user ID.')
    .addStringOption(o => o.setName('user_id').setDescription('Discord user ID to reset rank').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason shown to the player in their DM').setRequired(false)),
  new SlashCommandBuilder().setName('fuse').setDescription('Fuse characters together to create a new one.')
    .addIntegerOption(o => o.setName('fuse1').setDescription('First fuser character ID').setRequired(true))
    .addIntegerOption(o => o.setName('fuse2').setDescription('Second fuser character ID').setRequired(true))
    .addIntegerOption(o => o.setName('base').setDescription('Base character ID (Ainavolagem only — not needed for Time Paradox)').setRequired(false))
    .addIntegerOption(o => o.setName('fuse3').setDescription('Third fuser (optional)').setRequired(false))
    .addIntegerOption(o => o.setName('fuse4').setDescription('Fourth fuser (optional)').setRequired(false))
    .addIntegerOption(o => o.setName('fuse5').setDescription('Fifth fuser (optional)').setRequired(false)),
  new SlashCommandBuilder().setName('giveallchars').setDescription('(Admin) Give all characters to a player.')
    .addUserOption(o => o.setName('player').setDescription('Player to give to').setRequired(true)),
  new SlashCommandBuilder().setName('removeallchars').setDescription('(Admin) Remove all characters from a player.')
    .addUserOption(o => o.setName('player').setDescription('Player to remove from').setRequired(true)),
  new SlashCommandBuilder().setName('claim').setDescription('Claim your one-time data loss compensation package!'),
  new SlashCommandBuilder().setName('redeem').setDescription('Redeem a Compensation Token for ANY character of your choice.')
    .addStringOption(o => o.setName('character').setDescription('Character to redeem (type to search)').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('teamabilities').setDescription('View all team abilities, their required characters, and what they do.'),
  new SlashCommandBuilder().setName('charsynergies').setDescription('View all character synergies, their required characters, and what they do.'),
  new SlashCommandBuilder().setName('story').setDescription('Enter UMT Story Mode (playable in your DMs).').setDMPermission(true),
  new SlashCommandBuilder().setName('leaderboard').setDescription('View leaderboards.')
    .addStringOption(o => o.setName('type').setDescription('Which leaderboard').setRequired(true).addChoices(
      { name: 'Most Damage Dealt', value: 'damage' },
      { name: 'Richest (Determination)', value: 'determination' },
      { name: 'PvP Rank', value: 'pvp' },
    )),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  try {
    console.log('Registering commands...');
    if (GUILD_ID && GUILD_ID !== 'YOUR_GUILD_ID_HERE') {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log('Guild commands registered!');
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Global commands registered!');
    }
  } catch (e) { console.error('Error:', e); }
})();
