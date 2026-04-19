'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(path.join(DB_DIR, 'bot.db'));

// Enable WAL for better concurrency
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    discord_id   TEXT PRIMARY KEY,
    player_id    TEXT NOT NULL UNIQUE,
    nickname     TEXT,
    state        INTEGER,
    registered_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS state_roles (
    state        INTEGER PRIMARY KEY,
    role_id      TEXT NOT NULL
  );
`);

// ----- Player queries -----

const stmts = {
  getPlayerByDiscord:  db.prepare('SELECT * FROM players WHERE discord_id = ?'),
  getPlayerByPlayerId: db.prepare('SELECT * FROM players WHERE player_id = ?'),
  getAllPlayers:       db.prepare('SELECT * FROM players'),
  upsertPlayer:        db.prepare(`
    INSERT INTO players (discord_id, player_id, nickname, state)
    VALUES (@discord_id, @player_id, @nickname, @state)
    ON CONFLICT(discord_id) DO UPDATE SET
      player_id  = excluded.player_id,
      nickname   = excluded.nickname,
      state      = excluded.state
  `),
  updatePlayerState:   db.prepare('UPDATE players SET state = ?, nickname = ? WHERE discord_id = ?'),

  // State-role mapping
  getRoleForState:     db.prepare('SELECT role_id FROM state_roles WHERE state = ?'),
  setRoleForState:     db.prepare(`
    INSERT INTO state_roles (state, role_id) VALUES (?, ?)
    ON CONFLICT(state) DO UPDATE SET role_id = excluded.role_id
  `),
  getAllStateRoles:     db.prepare('SELECT * FROM state_roles'),
};

module.exports = {
  db,

  getPlayerByDiscord:  (discordId)          => stmts.getPlayerByDiscord.get(discordId),
  getPlayerByPlayerId: (playerId)            => stmts.getPlayerByPlayerId.get(playerId),
  getAllPlayers:        ()                   => stmts.getAllPlayers.all(),
  upsertPlayer:        (row)                => stmts.upsertPlayer.run(row),
  updatePlayerState:   (discordId, state, nickname) => stmts.updatePlayerState.run(state, nickname, discordId),

  getRoleForState:     (state)              => stmts.getRoleForState.get(state)?.role_id ?? null,
  setRoleForState:     (state, roleId)      => stmts.setRoleForState.run(state, roleId),
  getAllStateRoles:     ()                  => stmts.getAllStateRoles.all(),
};
