'use strict';

const { generateAssets } = require('./rooms');
const WebSocket = require('ws');

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

// ─── Stateful game loop ───────────────────────────────────────────────────────

function initGameState(room) {
  room.assets   = generateAssets(room.players.size);
  room.timeLeft = ROUND_DURATION;
  room.frenzy   = false;
  for (const player of room.players.values()) {
    player.x = 10 + Math.random() * 80;
    player.y = 10 + Math.random() * 80;
    player.pendingX = player.x;
    player.pendingY = player.y;
    if (player.isBot) {
      const angle = Math.random() * Math.PI * 2;
      player.botDx = Math.cos(angle);
      player.botDy = Math.sin(angle);
      player.botDirTimer = Math.floor(Math.random() * BOT_DIR_TICKS);
    }
  }
}

function applyPlayerMoves(room) {
  for (const player of room.players.values()) {
    if (player.isBot || player.pendingX === undefined) continue;
    const dx   = player.pendingX - player.x;
    const dy   = player.pendingY - player.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > MAX_TICK_MOVE) continue; // reject — too far (cheat or extreme lag)

    const nx = Math.max(0, Math.min(100 - RACCOON_SIZE, player.pendingX));
    const ny = Math.max(0, Math.min(100 - RACCOON_SIZE, player.pendingY));
    const box = { x: nx, y: ny, w: RACCOON_SIZE, h: RACCOON_SIZE };

    let blocked = false;
    for (const asset of room.assets) {
      if (!asset.moving && overlaps(box, asset)) {
        tryTag(asset, player, room.frenzy);
        blocked = true;
      }
    }
    if (!blocked) { player.x = nx; player.y = ny; }
  }
}

function moveBots(room) {
  for (const player of room.players.values()) {
    if (!player.isBot) continue;
    player.botDirTimer = (player.botDirTimer || 0) - 1;

    // Find nearest enemy/unowned asset within BOT_TARGET_RADIUS
    const cx = player.x + RACCOON_SIZE / 2;
    const cy = player.y + RACCOON_SIZE / 2;
    let target = null, minDist = BOT_TARGET_RADIUS;
    for (const asset of room.assets) {
      if (asset.ownerId === player.id) continue;
      const acx = asset.x + asset.w / 2;
      const acy = asset.y + asset.h / 2;
      const d   = Math.sqrt((acx - cx) ** 2 + (acy - cy) ** 2);
      if (d < minDist) { minDist = d; target = asset; }
    }

    if (target) {
      const acx  = target.x + target.w / 2;
      const acy  = target.y + target.h / 2;
      const dist = Math.sqrt((acx - cx) ** 2 + (acy - cy) ** 2);
      player.botDx = (acx - cx) / dist;
      player.botDy = (acy - cy) / dist;
      player.botDirTimer = BOT_DIR_TICKS;
    } else if (player.botDirTimer <= 0) {
      const angle = Math.random() * Math.PI * 2;
      player.botDx = Math.cos(angle);
      player.botDy = Math.sin(angle);
      player.botDirTimer = BOT_DIR_TICKS;
    }

    const nx  = Math.max(0, Math.min(100 - RACCOON_SIZE, player.x + player.botDx * RACCOON_SPEED));
    const ny  = Math.max(0, Math.min(100 - RACCOON_SIZE, player.y + player.botDy * RACCOON_SPEED));
    const box = { x: nx, y: ny, w: RACCOON_SIZE, h: RACCOON_SIZE };

    let blocked = false;
    for (const asset of room.assets) {
      if (!asset.moving && overlaps(box, asset)) {
        tryTag(asset, player, room.frenzy);
        blocked = true;
      }
    }
    if (!blocked) { player.x = nx; player.y = ny; }
    else {
      const angle = Math.random() * Math.PI * 2;
      player.botDx = Math.cos(angle);
      player.botDy = Math.sin(angle);
      player.botDirTimer = BOT_DIR_TICKS;
    }
  }
}

function moveVehicles(room) {
  for (const asset of room.assets) {
    if (!asset.moving) continue;
    asset.x += asset.vx;
    asset.y += asset.vy;

    // Bounce off map edges
    if (asset.x <= 0 || asset.x + asset.w >= 100) {
      asset.vx *= -1;
      asset.x   = Math.max(0, Math.min(100 - asset.w, asset.x));
    }
    if (asset.y <= 0 || asset.y + asset.h >= 100) {
      asset.vy *= -1;
      asset.y   = Math.max(0, Math.min(100 - asset.h, asset.y));
    }

    // Check if any raccoon overlaps this vehicle (bounding box only — no block)
    for (const player of room.players.values()) {
      const raccoonBox = { x: player.x, y: player.y, w: RACCOON_SIZE, h: RACCOON_SIZE };
      if (overlaps(raccoonBox, asset)) tryTag(asset, player, room.frenzy);
    }
  }
}

function broadcastAll(room, msgObj) {
  const data = JSON.stringify(msgObj);
  for (const player of room.players.values()) {
    if (player.ws && player.ws.readyState === WebSocket.OPEN) player.ws.send(data);
  }
}

function serializeGameState(room) {
  return {
    type: 'gameState',
    players: Array.from(room.players.values()).map(p => ({
      id: p.id, name: p.name, color: p.color,
      x: p.x, y: p.y,
      teamId: p.teamId ?? null,
      isBot:  p.isBot  ?? false,
    })),
    assets:   room.assets,
    timeLeft: room.timeLeft,
    frenzy:   room.frenzy,
  };
}

function startGameLoop(room) {
  initGameState(room);
  let tickCount = 0;
  room.gameInterval = setInterval(() => {
    tickCount++;
    room.timeLeft = Math.max(0, ROUND_DURATION - (tickCount * TICK_MS / 1000));
    room.frenzy   = room.timeLeft <= FRENZY_THRESHOLD;

    moveBots(room);
    applyPlayerMoves(room);
    moveVehicles(room);

    broadcastAll(room, serializeGameState(room));

    if (room.timeLeft <= 0) {
      stopGameLoop(room);
      broadcastAll(room, buildGameOverPayload(room));
      room.state = 'waiting';
    }
  }, TICK_MS);
}

function stopGameLoop(room) {
  if (room.gameInterval) {
    clearInterval(room.gameInterval);
    room.gameInterval = null;
  }
}

module.exports = {
  overlaps, tryTag, buildGameOverPayload,
  startGameLoop, stopGameLoop,
  RACCOON_SIZE, RACCOON_SPEED, TICK_MS,
};
