'use strict';

const { EmbedBuilder } = require('discord.js');
const db                  = require('./database');
const { fetchPlayer }     = require('./wosApi');
const { assignStateRole } = require('./roleManager');

const TIMEOUT_MS   = 5 * 60 * 1000; // 5 minutes total window
const MAX_ATTEMPTS = 3;              // max wrong-input retries before giving up

/**
 * Handle a new guild member joining.
 * Delegates to runRegistrationFlow which is also used by /register.
 *
 * @param {import('discord.js').GuildMember} member
 */
async function handleMemberJoin(member) {
  // If already registered, re-assign the correct role silently
  const existing = db.getPlayerByDiscord(member.id);
  if (existing) {
    await assignStateRole(member, existing.state).catch(err =>
      console.warn(`[join] Could not reassign role for ${member.user.tag}: ${err.message}`)
    );
    return;
  }

  await runRegistrationFlow(member, { isNewMember: true });
}

/**
 * Full DM-based registration flow, shared between GuildMemberAdd and /register.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {object} opts
 * @param {boolean} [opts.isNewMember=false]  - true when triggered by join event (affects welcome text)
 * @param {import('discord.js').ChatInputCommandInteraction} [opts.interaction] - set when triggered by /register
 */
async function runRegistrationFlow(member, { isNewMember = false, interaction = null } = {}) {
  // Open a DM
  let dm;
  try {
    dm = await member.user.createDM();
  } catch {
    console.warn(`[register] Cannot DM ${member.user.tag} — DMs may be closed.`);
    if (interaction) {
      await interaction.editReply({
        content: '❌ Ik kan je geen DM sturen. Zet je DMs aan en probeer opnieuw.',
      }).catch(() => {});
    }
    return;
  }

  // If triggered by /register, tell them to check their DMs
  if (interaction) {
    await interaction.editReply({
      content: '📨 Ik heb je een DM gestuurd! Volg de instructies daar om je te registreren.',
    }).catch(() => {});
  }

  // Ask for player ID
  const title = isNewMember
    ? '🏔️ Welkom bij de Dutch Whiteout Survival server!'
    : '🏔️ WOS Registratie';

  const askEmbed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(title)
    .setDescription(
      'Om je de juiste rol te geven, hebben we je **WOS speler-ID** nodig.\n\n' +
      'Je kunt je speler-ID vinden in het spel onder **Profiel → Kopieer ID**.\n\n' +
      '**Stuur je speler-ID als antwoord op dit bericht.** (je hebt 5 minuten de tijd)'
    )
    .setFooter({ text: `Server: ${member.guild.name}` });

  try {
    await dm.send({ embeds: [askEmbed] });
  } catch {
    console.warn(`[register] Failed to send DM to ${member.user.tag}`);
    return;
  }

  // Collect player ID with real-time feedback on bad input
  const playerId = await collectPlayerId(dm, member);

  if (!playerId) {
    // Timeout or too many bad attempts — message already sent inside collectPlayerId
    return;
  }

  // Look up via API
  await dm.send('⏳ Je speler-ID wordt opgezocht…').catch(() => {});

  let playerData;
  try {
    playerData = await fetchPlayer(playerId);
  } catch (err) {
    if (err.code === 'RATE_LIMIT') {
      await dm.send('❌ De API-limiet is bereikt. Probeer het later opnieuw of vraag een beheerder om hulp.').catch(() => {});
      return;
    }
    console.error(`[register] fetchPlayer failed for ${member.user.tag}:`, err);
    await dm.send('❌ Er is een onverwachte fout opgetreden. Probeer het later opnieuw of neem contact op met een beheerder.').catch(() => {});
    return;
  }

  if (!playerData) {
    await dm.send(
      `❌ Speler-ID \`${playerId}\` niet gevonden. Controleer je ID en neem contact op met een beheerder.`
    ).catch(() => {});
    return;
  }

  // Validate the state (kid) from the API response
  const state = playerData.kid;
  if (typeof state !== 'number' || !Number.isInteger(state) || state < 0) {
    console.error(`[register] Invalid kid value from API for player ${playerId}:`, state);
    await dm.send('❌ Je spelersgegevens zijn ongeldig (onbekende staat). Neem contact op met een beheerder.').catch(() => {});
    return;
  }

  const nickname = playerData.nickname ?? 'Onbekend';

  // Check if this player_id is already claimed by a different Discord account
  const claimedBy = db.getPlayerByPlayerId(playerId);
  if (claimedBy && claimedBy.discord_id !== member.id) {
    await dm.send(
      `❌ Speler-ID \`${playerId}\` is al gekoppeld aan een ander Discord-account. ` +
      `Neem contact op met een beheerder als dit niet klopt.`
    ).catch(() => {});
    return;
  }

  // Save to DB
  db.upsertPlayer({
    discord_id: member.id,
    player_id:  playerId,
    nickname,
    state,
  });

  // Assign role
  try {
    await assignStateRole(member, state);
  } catch (err) {
    console.error(`[register] Role assignment failed for ${member.user.tag}:`, err.message);
    await dm.send('⚠️ Je ID is opgeslagen, maar het toewijzen van je rol is mislukt. Neem contact op met een beheerder.').catch(() => {});
    return;
  }

  // Confirm
  const confirmEmbed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('✅ Geregistreerd!')
    .setDescription(
      `Welkom, **${nickname}**!\n\n` +
      `🗺️ Staat: **${state}**\n` +
      `Je hebt nu de bijbehorende rol ontvangen. Veel plezier op de server!`
    );

  await dm.send({ embeds: [confirmEmbed] }).catch(() => {});
}

/**
 * Interactively collect a valid numeric player ID from the user in the DM channel.
 * Gives real-time feedback on invalid input. Returns null on timeout or too many failures.
 *
 * @param {import('discord.js').DMChannel} dm
 * @param {import('discord.js').GuildMember} member
 * @returns {Promise<string|null>} The validated player ID string, or null
 */
async function collectPlayerId(dm, member) {
  const deadline = Date.now() + TIMEOUT_MS;
  let attempts = 0;

  return new Promise(resolve => {
    const collector = dm.createMessageCollector({
      filter: m => m.author.id === member.id,
      time:   TIMEOUT_MS,
    });

    collector.on('collect', async msg => {
      const input = msg.content.trim();

      if (/^\d{1,12}$/.test(input)) {
        collector.stop('valid');
        resolve(input);
        return;
      }

      attempts++;
      const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));

      if (attempts >= MAX_ATTEMPTS) {
        collector.stop('toomany');
        await dm.send('❌ Te veel ongeldige pogingen. Neem contact op met een beheerder om je te registreren.').catch(() => {});
        resolve(null);
        return;
      }

      await dm.send(
        `⚠️ \`${input}\` is geen geldig speler-ID. Stuur alleen cijfers (bijv. \`46765089\`). ` +
        `Nog ${MAX_ATTEMPTS - attempts} poging(en) over — ${remaining}s resterend.`
      ).catch(() => {});
    });

    collector.on('end', (_, reason) => {
      if (reason === 'valid' || reason === 'toomany') return;
      dm.send('⏰ Tijdslimiet verlopen. Neem contact op met een beheerder als je hulp nodig hebt.').catch(() => {});
      resolve(null);
    });
  });
}

module.exports = { handleMemberJoin, runRegistrationFlow };
