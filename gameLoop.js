'use strict';
const { generateAssets } = require('./rooms');

// ─── Constants ────────────────────────────────────────────────────────────────
const RACCOON_SPEED      = 2.5;   // units per 100ms tick (25 units/sec)
const VEHICLE_SPEED      = 1.675; // 67% of raccoon speed
const RACCOON_SIZE       = 2;     // width and height in coordinate units
const MAX_TICK_MOVE      = 5;     // max units a player may move between ticks (validation)
const TAG_COOLDOWN_MS    = 3000;
const FRENZY_COOLDOWN_MS = 1000;
const FRENZY_THRESHOLD   = 10;   // seconds remaining when frenzy starts
const ROUND_DURATION     = 30;   // seconds
const TICK_MS            = 100;
const BOT_TARGET_RADIUS  = 15;   // units — how close a bot must be to target an asset
const BOT_DIR_TICKS      = 20;   // ticks between random direction changes (~2 seconds)

// ─── Pure logic ───────────────────────────────────────────────────────────────

/** Axis-aligned bounding box overlap check. Touching edges do NOT count. */
function overlaps(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x ||
           a.y + a.h <= b.y || b.y + b.h <= a.y);
}

/**
 * Attempt to tag `asset` for `player`. Mutates asset on success.
 * @param {object} asset
 * @param {object} player  — { id, color }
 * @param {boolean} frenzy — true when timeLeft <= FRENZY_THRESHOLD
 */
function tryTag(asset, player, frenzy) {
  const now = Date.now();
  if (now < asset.cooldownUntil) return;   // on cooldown
  if (asset.ownerId === player.id) return; // already owns it
  asset.ownerId      = player.id;
  asset.ownerColor   = player.color;
  asset.cooldownUntil = now + (frenzy ? FRENZY_COOLDOWN_MS : TAG_COOLDOWN_MS);
}

/**
 * Build the gameOver message payload (no WS side-effects).
 * @param {object} room — { mode, players: Map, assets: Array }
 * @returns {object}
 */
function buildGameOverPayload(room) {
  const assetCounts = {};
  for (const p of room.players.values()) assetCounts[p.id] = 0;
  for (const asset of room.assets) {
    if (asset.ownerId && assetCounts[asset.ownerId] !== undefined) {
      assetCounts[asset.ownerId]++;
    }
  }

  const scores = Array.from(room.players.values())
    .map(p => ({
      id: p.id, name: p.name, color: p.color,
      teamId: p.teamId ?? null,
      assetCount: assetCounts[p.id] || 0,
    }))
    .sort((a, b) => b.assetCount - a.assetCount);

  if (room.mode === 'teams') {
    const teamScores = { 0: 0, 1: 0 };
    for (const p of room.players.values()) {
      if (p.teamId === 0 || p.teamId === 1) teamScores[p.teamId] += assetCounts[p.id] || 0;
    }
    const winTeam = teamScores[0] >= teamScores[1] ? 0 : 1;
    return {
      type: 'gameOver', scores, teamScores,
      winner: String(winTeam),
      winnerLabel: winTeam === 0 ? 'Orange' : 'Blue',
    };
  }

  return {
    type: 'gameOver', scores,
    winner:      scores[0]?.id ?? '',
    winnerLabel: scores[0]?.name ?? '',
  };
}

module.exports = { overlaps, tryTag, buildGameOverPayload, RACCOON_SIZE, RACCOON_SPEED, TICK_MS };
