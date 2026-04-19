'use strict';

const crypto = require('crypto');
const db     = require('./database');

/**
 * Derive a deterministic hex color from a state number.
 * Uses the first 6 hex digits of MD5(state string).
 */
function stateColor(state) {
  return parseInt(
    crypto.createHash('md5').update(String(state)).digest('hex').slice(0, 6),
    16
  );
}

// In-process lock: tracks states currently being created so concurrent joins
// for the same new state don't both call guild.roles.create() simultaneously.
// Maps state (number) → Promise<Role>
const creationInProgress = new Map();

/**
 * Find an existing Discord role for this state, or create one.
 * Stores the mapping in the DB so it survives restarts.
 * Uses a per-state creation lock to prevent duplicate roles under concurrent joins.
 *
 * @param {import('discord.js').Guild} guild
 * @param {number} state
 * @returns {Promise<import('discord.js').Role>}
 */
async function getOrCreateStateRole(guild, state) {
  // 1. Check DB mapping first
  const storedRoleId = db.getRoleForState(state);
  if (storedRoleId) {
    const existing = guild.roles.cache.get(storedRoleId)
                  ?? await guild.roles.fetch(storedRoleId).catch(() => null);
    if (existing) return existing;
    // Role was deleted from Discord — fall through and recreate
  }

  // 2. Check if a role with this name already exists in the guild cache
  const roleName = String(state);
  const byName   = guild.roles.cache.find(r => r.name === roleName);
  if (byName) {
    db.setRoleForState(state, byName.id);
    return byName;
  }

  // 3. If another call is already creating this role, wait for it
  if (creationInProgress.has(state)) {
    return creationInProgress.get(state);
  }

  // 4. Create the role, holding the lock for the duration
  const creationPromise = (async () => {
    // Re-check after acquiring "lock" — another awaited call may have finished
    const recheck = guild.roles.cache.find(r => r.name === roleName);
    if (recheck) {
      db.setRoleForState(state, recheck.id);
      return recheck;
    }

    const color = stateColor(state);
    const role  = await guild.roles.create({
      name:   roleName,
      color,
      reason: 'WOS Dutch Bot — auto-created state role',
    });

    db.setRoleForState(state, role.id);
    console.log(`[roles] Created role "${roleName}" (${role.id}) color #${color.toString(16).padStart(6, '0')}`);
    return role;
  })();

  creationInProgress.set(state, creationPromise);

  try {
    return await creationPromise;
  } finally {
    creationInProgress.delete(state);
  }
}

/**
 * Remove all tracked state roles from a member, then assign the correct one.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {number} state
 * @returns {Promise<void>}
 */
async function assignStateRole(member, state) {
  const guild = member.guild;

  // Collect all tracked state role IDs from DB
  const allTracked = new Set(db.getAllStateRoles().map(r => r.role_id));

  // Remove any existing state roles from the member
  const toRemove = member.roles.cache.filter(r => allTracked.has(r.id));
  for (const [, role] of toRemove) {
    await member.roles.remove(role).catch(err =>
      console.warn(`[roles] Could not remove role ${role.name} from ${member.user.tag}: ${err.message}`)
    );
  }

  // Assign the correct role
  const role = await getOrCreateStateRole(guild, state);
  await member.roles.add(role);
  console.log(`[roles] Assigned state ${state} to ${member.user.tag}`);
}

/**
 * Regenerate MD5 colors for all state roles tracked in the DB.
 *
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<{updated: number, skipped: number}>}
 */
async function regenAllColors(guild) {
  const rows  = db.getAllStateRoles();
  let updated = 0;
  let skipped = 0;

  for (const { state, role_id } of rows) {
    const role = guild.roles.cache.get(role_id)
              ?? await guild.roles.fetch(role_id).catch(() => null);

    if (!role) { skipped++; continue; }

    const color     = stateColor(state);
    const setResult = await role.setColor(color, 'WOS Dutch Bot — regen colors').catch(err => {
      console.warn(`[roles] Could not set color on ${role.name}: ${err.message}`);
      return null;
    });

    if (setResult === null) {
      skipped++;
    } else {
      updated++;
    }
  }

  return { updated, skipped };
}

module.exports = { getOrCreateStateRole, assignStateRole, regenAllColors, stateColor };
