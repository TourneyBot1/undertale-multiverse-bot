console.log('--- whois starting ---');

const { Client, GatewayIntentBits } = require('discord.js');
const { TOKEN } = require('./config');

const ID = process.argv[2];
console.log('ID argument:', ID);
console.log('Token loaded:', TOKEN ? `yes (${TOKEN.length} chars)` : 'NO — TOKEN IS EMPTY');

if (!ID) { console.log('No ID passed. Usage: node whois.js <userid>'); process.exit(1); }

process.on('unhandledRejection', e => { console.log('UNHANDLED:', e.message); process.exit(1); });
process.on('uncaughtException', e => { console.log('CRASH:', e.message); process.exit(1); });

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log('Logged in as', client.user.tag);
  try {
    const u = await client.users.fetch(ID, { force: true });
    console.log('=====================');
    console.log('Username :', u.username);
    console.log('Display  :', u.globalName || '(none)');
    console.log('Avatar   :', u.displayAvatarURL());
    console.log('=====================');
  } catch (e) {
    console.log('Fetch failed:', e.message);
  }
  client.destroy();
  process.exit(0);
});

client.login(TOKEN).catch(e => { console.log('LOGIN FAILED:', e.message); process.exit(1); });

setTimeout(() => { console.log('Timed out after 15s — never connected.'); process.exit(1); }, 15000);