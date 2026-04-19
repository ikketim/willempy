'use strict';

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Events,
} = require('discord.js');

const { handleMemberJoin }              = require('./memberJoin');
const { regenColorsCommand, refreshDataCommand } = require('./adminCommands');
const { scheduleDailyRefresh }          = require('./scheduler');

// ── Validate env ──────────────────────────────────────────────────────────────

if (!process.env.TOKEN) {
  console.error('ERROR: TOKEN is not set in .env');
  process.exit(1);
}

// ── Create client ─────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const commands = [regenColorsCommand, refreshDataCommand];

// ── Register slash commands on ready ─────────────────────────────────────────

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  const commandData = commands.map(cmd => cmd.data.toJSON());

  for (const guild of c.guilds.cache.values()) {
    try {
      // Pre-fetch roles into cache so roleManager cache lookups work immediately
      await guild.roles.fetch();

      await rest.put(
        Routes.applicationGuildCommands(c.user.id, guild.id),
        { body: commandData }
      );
      console.log(`[commands] Registered slash commands for guild: ${guild.name}`);

      scheduleDailyRefresh(client, guild.id);

    } catch (err) {
      console.error(`[commands] Failed for guild ${guild.name}:`, err.message);
    }
  }
});

// Also register commands and schedule refresh when bot joins a new guild after startup
client.on(Events.GuildCreate, async (guild) => {
  try {
    await guild.roles.fetch();
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    const commandData = commands.map(cmd => cmd.data.toJSON());
    await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commandData });
    scheduleDailyRefresh(client, guild.id);
    console.log(`[GuildCreate] Joined new guild: ${guild.name}`);
  } catch (err) {
    console.error(`[GuildCreate] Setup failed for ${guild.name}:`, err.message);
  }
});

// ── New member joins ──────────────────────────────────────────────────────────

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await handleMemberJoin(member);
  } catch (err) {
    console.error(`[memberJoin] Unhandled error for ${member.user.tag}:`, err);
  }
});

// ── Slash command interactions ────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = commands.find(c => c.data.name === interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`[interaction] Error in /${interaction.commandName}:`, err);
    const reply = { content: '❌ Er is een fout opgetreden.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
});

// ── Login ─────────────────────────────────────────────────────────────────────

client.login(process.env.TOKEN).catch(err => {
  console.error('Fatal: could not log in to Discord:', err.message);
  process.exit(1);
});
