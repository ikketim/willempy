'use strict';

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { regenAllColors }       = require('./roleManager');
const { refreshAllPlayers }    = require('./scheduler');
const { runRegistrationFlow }  = require('./memberJoin');
const db                       = require('./database');

// Discord interaction tokens expire after 15 minutes.
// For safety we stop using editReply after 13 minutes and fall back to a channel message.
const INTERACTION_SAFE_MS = 13 * 60 * 1000;

/**
 * Check whether the interaction author is an admin.
 * Uses the ADMIN_ROLE_ID env var, or falls back to Administrator permission.
 */
function isAdmin(interaction) {
  const adminRoleId = process.env.ADMIN_ROLE_ID;
  if (adminRoleId && interaction.member.roles.cache.has(adminRoleId)) return true;
  if (interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) return true;
  return false;
}

// ── /register ────────────────────────────────────────────────────────────────

const registerCommand = {
  data: new SlashCommandBuilder()
    .setName('register')
    .setDescription('Koppel je WOS speler-ID aan je Discord-account'),

  async execute(interaction) {
    // Check if already registered
    const existing = db.getPlayerByDiscord(interaction.user.id);
    if (existing) {
      const embed = new EmbedBuilder()
        .setColor(0xf39c12)
        .setTitle('ℹ️ Al geregistreerd')
        .setDescription(
          `Je bent al geregistreerd als **${existing.nickname}** (ID: \`${existing.player_id}\`).\n\n` +
          `🗺️ Staat: **${existing.state}**\n\n` +
          `Wil je een ander speler-ID koppelen? Neem contact op met een beheerder.`
        );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // Defer reply — the actual flow happens in DM
    await interaction.deferReply({ ephemeral: true });

    try {
      // runRegistrationFlow sends a DM and updates the deferred reply
      await runRegistrationFlow(interaction.member, {
        isNewMember: false,
        interaction,
      });
    } catch (err) {
      console.error('[register] Unexpected error:', err);
      await interaction.editReply({
        content: '❌ Er is een onverwachte fout opgetreden. Probeer het later opnieuw.',
      }).catch(() => {});
    }
  },
};

// ── /regen-colors ────────────────────────────────────────────────────────────

const regenColorsCommand = {
  data: new SlashCommandBuilder()
    .setName('regen-colors')
    .setDescription('[Admin] Herbereken MD5-kleuren voor alle staatrollen'),

  async execute(interaction) {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Je hebt geen toestemming voor dit commando.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const { updated, skipped } = await regenAllColors(interaction.guild);

      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('🎨 Kleuren Hergenereerd')
        .setDescription(
          `MD5-kleuren zijn bijgewerkt voor alle staatrollen.\n\n` +
          `✅ Bijgewerkt: **${updated}**\n` +
          `⚠️ Overgeslagen: **${skipped}**`
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[regen-colors]', err);
      await interaction.editReply({ content: `❌ Fout: ${err.message}` }).catch(() => {});
    }
  },
};

// ── /refresh-data ─────────────────────────────────────────────────────────────

const refreshDataCommand = {
  data: new SlashCommandBuilder()
    .setName('refresh-data')
    .setDescription('[Admin] Haal spelersdata op en update rollen bij wijzigingen'),

  async execute(interaction) {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '❌ Je hebt geen toestemming voor dit commando.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const progressEmbed = new EmbedBuilder()
      .setColor(0xf39c12)
      .setTitle('🔄 Data wordt vernieuwd…')
      .setDescription('Alle spelersprofielen worden opgehaald. Dit kan even duren.\n\nAls het lang duurt, verschijnt het resultaat als bericht in dit kanaal.')
      .setTimestamp();

    await interaction.editReply({ embeds: [progressEmbed] });

    const startedAt = Date.now();

    try {
      const result = await refreshAllPlayers(
        interaction.client,
        interaction.guild.id
      );

      if (result.skipped) {
        await safeEditReply(interaction, startedAt, {
          content: '⚠️ Een vernieuwopdracht is al bezig. Wacht tot die klaar is en probeer het opnieuw.',
          embeds: [],
        });
        return;
      }

      const { checked, updated, failed } = result;
      const resultEmbed = new EmbedBuilder()
        .setColor(failed > 0 ? 0xe74c3c : 0x2ecc71)
        .setTitle('✅ Vernieuwen Voltooid')
        .setDescription(
          `Spelersdata is bijgewerkt.\n\n` +
          `🔍 Gecontroleerd: **${checked}**\n` +
          `🔄 Bijgewerkt: **${updated}**\n` +
          `❌ Mislukt: **${failed}**`
        )
        .setTimestamp();

      await safeEditReply(interaction, startedAt, { embeds: [resultEmbed] });
    } catch (err) {
      console.error('[refresh-data]', err);
      await safeEditReply(interaction, startedAt, {
        content: `❌ Fout: ${err.message}`,
        embeds: [],
      }).catch(() => {});
    }
  },
};

/**
 * Attempt to editReply if still within the safe window, otherwise fall back to channel message.
 */
async function safeEditReply(interaction, startedAt, payload) {
  const elapsed = Date.now() - startedAt;
  if (elapsed < INTERACTION_SAFE_MS) {
    await interaction.editReply(payload).catch(err => {
      console.warn('[refresh-data] editReply failed, falling back to channel message:', err.message);
      return sendFallbackMessage(interaction, payload);
    });
  } else {
    await sendFallbackMessage(interaction, payload);
  }
}

async function sendFallbackMessage(interaction, payload) {
  try {
    await interaction.channel.send({
      content: (payload.content ?? '') + '\n*(Resultaat via kanaalsbericht omdat de interactie verliep.)*',
      embeds: payload.embeds ?? [],
    });
  } catch (err) {
    console.error('[refresh-data] Fallback channel message also failed:', err.message);
  }
}

module.exports = { registerCommand, regenColorsCommand, refreshDataCommand };
