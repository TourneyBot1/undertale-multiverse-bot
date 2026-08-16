const { Client, GatewayIntentBits, PermissionsBitField, ChannelType } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.login(require('./config.js').TOKEN);

const sleep = ms => new Promise(r => setTimeout(r, ms));

client.once('ready', async () => {
  const guilds = [...client.guilds.cache.values()].sort((a, b) => b.memberCount - a.memberCount);
  const total = guilds.reduce((a, g) => a + g.memberCount, 0);
  console.log('Servers (' + guilds.length + ') | Total users: ' + total);

  for (const g of guilds) {
    let link = 'NO INVITE PERM';
    try {
      const me = g.members.me ?? await g.members.fetchMe();
      const ch = g.channels.cache.find(c =>
        c.type === ChannelType.GuildText &&
        c.permissionsFor(me).has(PermissionsBitField.Flags.CreateInstantInvite)
      );
      if (ch) {
        const inv = await ch.createInvite({ maxAge: 0, maxUses: 0, unique: false, reason: 'Dev audit' });
        link = inv.url;
      }
    } catch (e) {
      link = 'ERROR: ' + e.message;
    }
    console.log('- ' + g.name + ' | ' + g.id + ' | ' + g.memberCount + ' | ' + link);
    await sleep(400);
  }
  process.exit(0);
});