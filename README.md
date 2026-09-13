# ⚔️ Undertale Multiverse Bot

A feature-rich Discord bot inspired by the Undertale universe. Battle as iconic Sans variants, fight bosses, collect characters, and compete with others in PvP!

> Currently on **Update 34** — actively developed and maintained.

## ✨ Features

- **135 collectible characters** across Undertale AUs, each with unique movesets and passives
- **Turn-based combat** with types, status effects, charge abilities, and synergies
- **22 bosses** including superbosses and limited event bosses
- **Ranked PvP** — global cross-server matchmaking, 28 divisions from Bronze 1 to True Determination
- **Gacha, crafting, and fusions** — 151 items and 26 recipes
- **Story Mode** played through DMs
- **21 achievements** with character and item rewards
- **Events** — rotating limited-time bosses and exclusive characters

## 🕹️ Play Your Way

Whether you are here to relax or to climb, there is a path for you:

- **Casual player** — collect characters, pull the gacha, craft and fuse, clear bosses at your own pace, and play through Story Mode in your DMs.
- **Competitive player** — build your best team, queue up in Ranked PvP, climb the divisions, and fight for a spot in the playoffs.

> 🏆 **Season 4 Playoffs are coming soon!** Grind your rank now and secure your seat.

## 🎮 Core Commands

| Command | What it does |
|---|---|
| `/start` | Begin your journey |
| `/team` | Manage your 6-character team |
| `/boss` | Challenge a boss |
| `/challenge` | Join the global ranked queue (works in DMs) |
| `/rank` | View your ranked division and crystals |
| `/pvpnotify` | Get a DM when someone is searching for a match |
| `/gacha` | Pull for random characters and loot |
| `/craft` | Craft items and characters |
| `/shop` | Buy items with Determination and Soul Essence |
| `/obtain` | Look up how to get any character |

## 🚀 Setup

**Requirements:** Node.js 18+

```bash
git clone https://github.com/TourneyBot1/undertale-multiverse-bot.git
cd undertale-multiverse-bot
npm install
```

Copy `config.example.js` to `config.js` and fill in your credentials:

```js
module.exports = {
  TOKEN: 'your-bot-token',
  CLIENT_ID: 'your-application-id',
  GUILD_ID: 'your-server-id',
};
```

Register the slash commands, then start the bot:

```bash
node deploy-commands.js
npm start
```

Only re-run `deploy-commands.js` when slash commands change. Otherwise `npm start` is enough.

## 📁 Project Structure

```
index.js            Command handlers and interaction routing
gameData.js         All characters, bosses, items, recipes, shop
combat.js           PvE combat engine
pvp.js              PvP combat engine
ranked.js           Ranked ladder, divisions, crystal math
embeds.js           Discord embed UI
database.js         Flat-file JSON persistence with atomic saves
story.js            Story Mode
deploy-commands.js  Slash command registration
```

Player data lives in `data/players.json`, written atomically with rolling backups. Both `config.js` and `data/` are gitignored and must never be committed.

## 👑 Team

- **Founder:** Mazin
- **Co-Owner:** spicyking1

Join the community server: [discord.gg/fDutC9gtQG](https://discord.gg/fDutC9gtQG)

## 🔗 Links

- **Website:** [umtbot.com](https://umtbot.com)
- **Community:** [discord.gg/fDutC9gtQG](https://discord.gg/fDutC9gtQG)

---

*Undertale is a trademark of Toby Fox. This is an unofficial fan project.*
