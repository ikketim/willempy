'use strict';

const crypto = require('crypto');
const fetch  = require('node-fetch');

const SECRET      = 'tB87#kPtkxqOS2';
const PLAYER_URL  = 'https://wos-giftcode-api.centurygame.com/api/player';
const PLAYER_URL2 = 'https://gof-report-api-formal.centurygame.com/api/player';
const ORIGIN      = 'https://wos-giftcode.centurygame.com';
const TIMEOUT_MS  = 12000;

/** Build the signed POST body for a player lookup */
function buildPayload(playerId) {
  const time = Date.now();
  const raw  = `fid=${playerId}&time=${time}`;
  const sign = crypto.createHash('md5').update(raw + SECRET).digest('hex');
  return `sign=${sign}&${raw}`;
}

/** Minimal browser-like headers to avoid bot detection */
function headers() {
  return {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept':       'application/json, text/plain, */*',
    'Origin':        ORIGIN,
    'Referer':      `${ORIGIN}/`,
    'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  };
}

/**
 * Wraps fetch with a real timeout using AbortController.
 * node-fetch v2 silently ignores the `timeout` option, so we implement
 * it here via AbortController to prevent requests hanging indefinitely.
 */
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch player data from the WOS giftcode API.
 * Returns the player data object on success, or null if the player does not exist / API errors.
 * Throws on rate-limit (caller should back off).
 *
 * Returned object (relevant fields):
 *   { fid, nickname, kid, stove_lv, avatar_image, ... }
 *   kid  = the state / server number of the player
 */
async function fetchPlayer(playerId) {
  const urls = [PLAYER_URL, PLAYER_URL2];

  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url, {
        method:  'POST',
        headers: headers(),
        body:    buildPayload(playerId),
      });

      if (res.status === 429) throw Object.assign(new Error('RATE_LIMIT'), { code: 'RATE_LIMIT' });
      if (!res.ok) {
        console.warn(`[api] ${url} returned HTTP ${res.status} — trying next`);
        continue;
      }

      const json = await res.json();

      // Player does not exist
      if (json.err_code === 40004 || json.err_code === 40001 ||
          (json.msg && /not exist/i.test(json.msg))) {
        return null;
      }

      if (json.code === 0 && json.data) return json.data;

      // Unexpected response body — log and try next URL
      console.warn(`[api] Unexpected response from ${url}:`, JSON.stringify(json).slice(0, 200));

    } catch (err) {
      if (err.code === 'RATE_LIMIT') throw err;
      if (err.name === 'AbortError') {
        console.warn(`[api] ${url} timed out after ${TIMEOUT_MS}ms`);
      } else {
        console.warn(`[api] Network error on ${url}:`, err.message);
      }
      // Try next URL
    }
  }

  return null; // both URLs failed
}

module.exports = { fetchPlayer };
