// ============================================================
// jevil.js — RELIC MODULE (Jevil's Scythe / Jevil's Tail)
//
// The "??????" questline was removed; Jevil is now a normal /boss.
// This module survives ONLY to keep the two relics equippable for
// players who already own them. The relics are no longer obtainable.
//
// One relic slot per character, stored on character.equipped.
// Routed from /use via select menus (customId jevil_equip_<item>).
// ============================================================

const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const playerDB = require('./database');
const { CHARACTERS } = require('./gameData');

// ---------- helpers ----------
function saveState(userId) {
  // ensurePlayer returns the live object; mutating + any playerDB write persists.
  // Force a save via a no-op add.
  playerDB.addSoulEssence(userId, 0);
}
function row(...b) { return new ActionRowBuilder().addComponents(...b); }

const RELIC_META = {
  jevils_scythe: { name: "Jevil's Scythe", emoji: '🪓' },
  jevils_tail: { name: "Jevil's Tail", emoji: '🌀' },
  // --- SCAMTON EVENT: shares the same one-relic-per-character slot ---
  big_shot_bow_tie: { name: 'Big Shot Bow Tie', emoji: '🎀' },
};
function relicPickerFor(userId, itemId) {
  const meta = RELIC_META[itemId];
  if (!meta) return null;
  const chars = playerDB.getCharacters(userId);
  if (chars.length === 0) return { error: 'You have no characters to equip it to.' };
  const opts = chars.slice(0, 25).map(c => {
    const d = CHARACTERS[c.character_id];
    const held = c.equipped && RELIC_META[c.equipped] ? ` [holding ${RELIC_META[c.equipped].emoji}]` : '';
    return { label: `[${c.id}] ${d?.name || c.character_id}${held}`.slice(0, 100), value: String(c.id) };
  });
  return {
    content: `${meta.emoji} Equip **${meta.name}** to which character? *(A character can only hold one relic — equipping swaps out any current one.)*`,
    components: [row(new StringSelectMenuBuilder().setCustomId(`jevil_equip_${itemId}`).setPlaceholder('Choose a character...').addOptions(opts))],
    ephemeral: true,
  };
}
function unequipPicker(userId) {
  const chars = playerDB.getCharacters(userId).filter(c => c.equipped && RELIC_META[c.equipped]);
  if (chars.length === 0) return { error: 'None of your characters have a relic equipped.' };
  const opts = chars.slice(0, 25).map(c => {
    const d = CHARACTERS[c.character_id];
    return { label: `[${c.id}] ${d?.name || c.character_id} — ${RELIC_META[c.equipped].name}`.slice(0, 100), value: String(c.id) };
  });
  return {
    content: '🧷 Unequip a relic from which character?',
    components: [row(new StringSelectMenuBuilder().setCustomId('jevil_unequip').setPlaceholder('Choose a character...').addOptions(opts))],
    ephemeral: true,
  };
}
async function handleJevilSelect(interaction) {
  const userId = interaction.user.id;
  const cid = interaction.customId;
  const p = playerDB.ensurePlayer(userId);

  if (cid.startsWith('jevil_equip_')) {
    const itemId = cid.replace('jevil_equip_', '');
    const meta = RELIC_META[itemId];
    if (!meta) return interaction.update({ content: 'Unknown relic.', components: [] });
    if (!playerDB.hasItem(userId, itemId, 1)) return interaction.update({ content: `You no longer have **${meta.name}**.`, components: [] });
    const charId = parseInt(interaction.values[0]);
    const ch = p.characters.find(c => c.id === charId);
    if (!ch) return interaction.update({ content: 'Character not found.', components: [] });
    // Swap out any relic the character is already holding
    let swapMsg = '';
    if (ch.equipped && RELIC_META[ch.equipped]) {
      playerDB.addItem(userId, ch.equipped, 1);
      swapMsg = ` (returned **${RELIC_META[ch.equipped].name}** to your inventory)`;
    }
    playerDB.removeItem(userId, itemId, 1);
    ch.equipped = itemId;
    saveState(userId);
    const d = CHARACTERS[ch.character_id];
    return interaction.update({ content: `${meta.emoji} Equipped **${meta.name}** to **${d?.name || ch.character_id}** (ID ${ch.id})${swapMsg}.`, components: [] });
  }

  if (cid === 'jevil_unequip') {
    const charId = parseInt(interaction.values[0]);
    const ch = p.characters.find(c => c.id === charId);
    if (!ch || !ch.equipped || !RELIC_META[ch.equipped]) return interaction.update({ content: 'Nothing to unequip.', components: [] });
    const relic = ch.equipped;
    playerDB.addItem(userId, relic, 1);
    ch.equipped = null;
    saveState(userId);
    const d = CHARACTERS[ch.character_id];
    return interaction.update({ content: `🧷 Unequipped **${RELIC_META[relic].name}** from **${d?.name || ch.character_id}** — it\'s back in your inventory.`, components: [] });
  }
  return null;
}

module.exports = {
  handleJevilSelect,
  relicPickerFor,
  unequipPicker,
  RELIC_META,
};
