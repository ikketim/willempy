'use strict';

const cron               = require('node-cron');
const db                 = require('./database');
const { fetchPlayer }    = require('./wosApi');
const { assignStateRole } = require('./roleManager');

const DELAY_MS = 2000; // 2 s between API calls — stays within 30 req/min per endpoint

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Guard against concurrent refresh runs (e.g. /refresh-data fired while daily job runs)
let refreshRunning = false;

/**
 * Pull every registered player from the API, detect state changes,
 * and update Discord roles accordingly.
 *
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @returns {Promise<{checked: number, updated: number, failed: number, skipped: boolean}>}
 */
async function refreshAllPlayers(client, guildId) {
  if (refreshRunning) {
    console.warn('[refresh] Already running — skipping this invocation.');
    return { checked: 0, updated: 0, failed: 0, skipped: true };
  }

  refreshRunning = true;
  try {
    return await _doRefresh(client, guildId);
  } finally {
    refreshRunning = false;
  }
}

async function _doRefresh(client, guildId) {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    console.error('[refresh] Guild not found:', guildId);
    return { checked: 0, updated: 0, failed: 0, skipped: false };
  }

  const players = db.getAllPlayers();
  let checked = 0, updated = 0, failed = 0;

  console.log(`[refresh] Starting refresh for ${players.length} players…`);

  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    try {
      const data = await fetchPlayer(player.player_id);
      checked++;

      if (!data) {
        console.warn(`[refresh] No data for player_id ${player.player_id} (discord: ${player.discord_id})`);
        failed++;
        await sleep(DELAY_MS);
        continue;
      }

      const newState = data.kid;

      if (newState !== player.state) {
        console.log(`[refresh] State change for ${player.discord_id}: ${player.state} → ${newState}`);

        // Update DB first so the new state persists even if Discord role update fails
        db.updatePlayerState(player.discord_id, newState, data.nickname || player.nickname);

        // Update Discord role
        const member = await guild.members.fetch(player.discord_id).catch(() => null);
        if (member) {
          await assignStateRole(member, newState);
          updated++;
        } else {
          console.warn(`[refresh] Member ${player.discord_id} not found in guild — DB updated, role skipped`);
        }
      }

    } catch (err) {
      if (err.code === 'RATE_LIMIT') {
        console.warn('[refresh] Rate limited — waiting 60 s…');
        await sleep(60_000);
        i--; // retry the same player
        continue;
      }
      console.error(`[refresh] Error processing player ${player.player_id}:`, err.message);
      failed++;
    }

    await sleep(DELAY_MS);
  }

  console.log(`[refresh] Done. checked=${checked} updated=${updated} failed=${failed}`);
  return { checked, updated, failed, skipped: false };
}

/**
 * Schedule the daily midnight UTC job.
 *
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 */
function scheduleDailyRefresh(client, guildId) {
  cron.schedule('0 0 * * *', async () => {
    console.log('[refresh] Midnight UTC — running daily refresh…');
    await refreshAllPlayers(client, guildId);
  }, { timezone: 'UTC' });

  console.log('[refresh] Daily refresh scheduled at 00:00 UTC');
}

module.exports = { refreshAllPlayers, scheduleDailyRefresh };
