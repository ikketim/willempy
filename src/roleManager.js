'use strict';

const crypto = require('crypto');
const db     = require('./database');

/** Regex matching a pure state role name: 1–4 digits, nothing else */
const STATE_ROLE_RE = /^\d{1,4}$/;

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

/**
 * Update a member's server nickname to prefix it with [state].
 * Rules:
 *  - If nickname already starts with [anything], replace that bracket prefix.
 *  - Otherwise prepend [state] to the current display name.
 * Discord server nicknames are capped at 32 characters; we truncate if needed.
 * Silently skips if the bot lacks permission (e.g. server owner).
 *
 * @param {import('discord.js').GuildMember} member
 * @param {number} state
 */
async function updateNickname(member, state) {
  const prefix      = `[${state}]`;
  const displayName = member.nickname ?? member.user.username;

  // Strip any existing [*] prefix (greedy up to the closing bracket)
  const stripped = displayName.replace(/^\[.*?\]/, '').trimStart();

  // Build new nickname, truncate to Discord's 32-char limit
  const newNick = `${prefix}${stripped}`.slice(0, 32);

  // No change needed
  if (member.nickname === newNick) return;

  await member.setNickname(newNick, 'WOS Dutch Bot — state prefix').catch(err =>
    console.warn(`[nick] Could not set nickname for ${member.user.tag}: ${err.message}`)
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
 * Remove all state roles from a member (both DB-tracked AND any role whose
 * name is purely 1–4 digits), then assign the correct state role, and
 * update the member's nickname with a [state] prefix.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {number} state
 * @returns {Promise<void>}
 */
async function assignStateRole(member, state) {
  const guild = member.guild;

  // Build the set of role IDs to remove:
  //   - All DB-tracked state role IDs
  //   - Any role the member currently has whose name matches /^\d{1,4}$/
  //     (catches pre-existing number roles not yet in the DB)
  const allTracked = new Set(db.getAllStateRoles().map(r => r.role_id));

  const toRemove = member.roles.cache.filter(r =>
    allTracked.has(r.id) || STATE_ROLE_RE.test(r.name)
  );

  for (const [, role] of toRemove) {
    await member.roles.remove(role).catch(err =>
      console.warn(`[roles] Could not remove role ${role.name} from ${member.user.tag}: ${err.message}`)
    );
  }

  // Assign the correct role
  const role = await getOrCreateStateRole(guild, state);
  await member.roles.add(role);
  console.log(`[roles] Assigned state ${state} to ${member.user.tag}`);

  // Update nickname: [state]CurrentName
  await updateNickname(member, state);
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

module.exports = { getOrCreateStateRole, assignStateRole, regenAllColors, stateColor, updateNickname };
