'use strict';

const { generateAssets, TEAM_COLORS } = require('./rooms');
const WebSocket = require('ws');

// ─── Constants ────────────────────────────────────────────────────────────────
const RACCOON_SPEED      = 1.8;   // units per 100ms tick (18 units/sec) — bots
const VEHICLE_SPEED      = 1.2;   // 67% of raccoon speed
const RACCOON_SIZE       = 2;     // width and height in coordinate units
const MAX_TICK_MOVE      = 5;     // max units a player may move between ticks (validation)
const TAG_COOLDOWN_MS    = 3000;
const FRENZY_COOLDOWN_MS = 1000;
const FRENZY_THRESHOLD   = 10;   // seconds remaining when frenzy starts
const ROUND_DURATION     = 30;   // seconds
const TICK_MS            = 100;
const TRAIN_SPEED         = 1.8;  // units per tick — same as raccoon speed
const DOCKED_TICKS_MIN    = 50;   // 5 s (min on-screen dwell)
const DOCKED_TICKS_MAX    = 100;  // 10 s (max on-screen dwell)
const OFFSCREEN_TICKS_MIN = 50;   // 5 s (min off-screen wait)
const OFFSCREEN_TICKS_MAX = 200;  // 20 s (max off-screen wait)
const OFFSCREEN_OFFSET    = -60;  // how far left of dockedX to park (units)
const TRAIN_IDS = ['train-engine', 'train-car-1', 'train-car-2', 'train-car-3', 'train-car-4', 'train-car-5', 'train-car-6'];

function randDockedTicks()    { return DOCKED_TICKS_MIN    + Math.floor(Math.random() * (DOCKED_TICKS_MAX    - DOCKED_TICKS_MIN    + 1)); }
function randOffscreenTicks() { return OFFSCREEN_TICKS_MIN + Math.floor(Math.random() * (OFFSCREEN_TICKS_MAX - OFFSCREEN_TICKS_MIN + 1)); }
const BOT_DIR_TICKS      = 20;   // ticks between random direction changes (wander fallback)

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
  if (asset.type === 'trough') return;     // non-taggable obstacle
  const now = Date.now();
  if (now < asset.cooldownUntil) return;   // on cooldown
  if (asset.ownerId === player.id) return; // already owns it
  asset.ownerId      = player.id;
  asset.ownerColor   = player.displayColor ?? player.color;
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

/** Returns the 5 train assets in fixed order, or fewer if some are missing. */
function getTrainAssets(assets) {
  const byId = new Map(assets.map(a => [a.id, a]));
  return TRAIN_IDS.map(id => byId.get(id)).filter(Boolean);
}

/**
 * Advance the train cycle by one tick. Mutates train asset x-positions and trainState.
 * @param {object[]} assets   — room.assets array
 * @param {object}   trainState — { phase, ticksLeft, dockedX }
 */
function tickTrainState(assets, trainState) {
  const trains = getTrainAssets(assets);
  if (trains.length < TRAIN_IDS.length) return;

  if (trainState.phase === 'docked') {
    if (--trainState.ticksLeft <= 0) {
      trainState.phase = 'departing';
    }

  } else if (trainState.phase === 'departing') {
    for (const a of trains) a.x -= TRAIN_SPEED;
    const last = trains[trains.length - 1]; // rightmost car
    if (last.x + last.w < 0) {
      // Fully off-screen — park all assets and start randomised offscreen timer
      for (let i = 0; i < trains.length; i++) {
        trains[i].x = trainState.dockedX[i] + OFFSCREEN_OFFSET;
      }
      trainState.phase     = 'offscreen';
      trainState.ticksLeft = randOffscreenTicks();
    }

  } else if (trainState.phase === 'offscreen') {
    if (--trainState.ticksLeft <= 0) {
      trainState.phase = 'arriving';
    }

  } else if (trainState.phase === 'arriving') {
    for (const a of trains) a.x += TRAIN_SPEED;
    if (trains[0].x >= trainState.dockedX[0]) {
      // Snap to docked positions and restart randomised docked timer
      for (let i = 0; i < trains.length; i++) {
        trains[i].x = trainState.dockedX[i];
      }
      trainState.phase     = 'docked';
      trainState.ticksLeft = randDockedTicks();
    }
  }
}

// ─── Stateful game loop ───────────────────────────────────────────────────────

function findClearSpawn(assets) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const x = 10 + Math.random() * 80;
    const y = 10 + Math.random() * 80;
    const box = { x, y, w: RACCOON_SIZE, h: RACCOON_SIZE };
    if (!assets.some(a => !a.moving && overlaps(box, a))) return { x, y };
  }
  return { x: 10 + Math.random() * 80, y: 10 + Math.random() * 80 };
}

function initGameState(room) {
  room.assets   = generateAssets(room.players.size);
  room.timeLeft = ROUND_DURATION;
  room.frenzy   = false;
  const dockedX = [2, 9, 14, 19, 24, 29, 34];
  room.trainState = {
    phase:    'offscreen',
    ticksLeft: randOffscreenTicks(),
    dockedX,
  };
  // Move trains to their off-screen starting position
  const startTrains = getTrainAssets(room.assets);
  for (let i = 0; i < startTrains.length; i++) {
    startTrains[i].x = dockedX[i] + OFFSCREEN_OFFSET;
  }
  for (const player of room.players.values()) {
    const spawn = findClearSpawn(room.assets);
    player.x = spawn.x;
    player.y = spawn.y;
    player.pendingX = player.x;
    player.pendingY = player.y;
    player.displayColor = (room.mode === 'teams' && (player.teamId === 0 || player.teamId === 1))
      ? TEAM_COLORS[player.teamId]
      : player.color;
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

    const desiredX = Math.max(0, Math.min(100 - RACCOON_SIZE, player.pendingX));
    const desiredY = Math.max(0, Math.min(100 - RACCOON_SIZE, player.pendingY));

    // Axis-separated collision — slide along asset edges instead of freezing.
    // Try X first with current Y, then Y with the resolved X. Tag still fires
    // on every attempted overlap.
    const tryXBox = { x: desiredX, y: player.y, w: RACCOON_SIZE, h: RACCOON_SIZE };
    let blockedX = false;
    for (const asset of room.assets) {
      if (overlaps(tryXBox, asset)) {
        tryTag(asset, player, room.frenzy);
        blockedX = true;
      }
    }
    if (!blockedX) player.x = desiredX;

    const tryYBox = { x: player.x, y: desiredY, w: RACCOON_SIZE, h: RACCOON_SIZE };
    let blockedY = false;
    for (const asset of room.assets) {
      if (overlaps(tryYBox, asset)) {
        tryTag(asset, player, room.frenzy);
        blockedY = true;
      }
    }
    if (!blockedY) player.y = desiredY;
  }
}

/**
 * Pick the best asset for a bot to chase.
 * Priority: unowned (+150) > enemy-owned (+75), minus distance. Skips
 * self-owned and teammate-owned (teams mode). No distance cutoff.
 */
function getBotTarget(player, room) {
  const cx = player.x + RACCOON_SIZE / 2;
  const cy = player.y + RACCOON_SIZE / 2;
  let bestTarget = null, bestScore = -Infinity;

  for (const asset of room.assets) {
    if (asset.type === 'trough') continue;
    if (asset.x + asset.w < 0) continue;   // off-screen — don't chase
    if (asset.ownerId === player.id) continue;

    // In teams mode, skip assets already owned by a teammate
    if (room.mode === 'teams' && asset.ownerId && player.teamId !== null) {
      const owner = room.players.get(asset.ownerId);
      if (owner && owner.teamId === player.teamId) continue;
    }

    const acx = asset.x + asset.w / 2;
    const acy = asset.y + asset.h / 2;
    const dist = Math.sqrt((acx - cx) ** 2 + (acy - cy) ** 2);

    // Unowned is best, enemy-owned is second. Distance subtracts from both.
    // On a 100×100 map (max dist ~141), a bot will steal if the enemy asset
    // is 75+ units closer than the nearest unowned asset.
    const priority = asset.ownerId ? 75 : 150;

    // Cooperative penalty: if a teammate is already closer to this asset,
    // reduce its score so this bot spreads out to something else instead.
    let coveredPenalty = 0;
    if (room.mode === 'teams' && player.teamId !== null) {
      for (const teammate of room.players.values()) {
        if (teammate.id === player.id) continue;
        if (teammate.teamId !== player.teamId) continue;
        const tcx = teammate.x + RACCOON_SIZE / 2;
        const tcy = teammate.y + RACCOON_SIZE / 2;
        const teammateDist = Math.sqrt((acx - tcx) ** 2 + (acy - tcy) ** 2);
        if (teammateDist < dist) { coveredPenalty = 100; break; }
      }
    }

    const score = priority - dist - coveredPenalty;

    if (score > bestScore) { bestScore = score; bestTarget = asset; }
  }

  return bestTarget;
}

function moveBots(room) {
  for (const player of room.players.values()) {
    if (!player.isBot) continue;
    player.botDirTimer = (player.botDirTimer || 0) - 1;

    const target = getBotTarget(player, room);

    if (target) {
      const cx   = player.x + RACCOON_SIZE / 2;
      const cy   = player.y + RACCOON_SIZE / 2;
      const acx  = target.x + target.w / 2;
      const acy  = target.y + target.h / 2;
      const dist = Math.sqrt((acx - cx) ** 2 + (acy - cy) ** 2);
      player.botDx = (acx - cx) / dist;
      player.botDy = (acy - cy) / dist;
    } else if (player.botDirTimer <= 0) {
      // No target anywhere — wander randomly
      const angle = Math.random() * Math.PI * 2;
      player.botDx = Math.cos(angle);
      player.botDy = Math.sin(angle);
      player.botDirTimer = BOT_DIR_TICKS;
    }

    // Axis-separated movement — bots slide along obstacle edges instead of freezing
    const nx = Math.max(0, Math.min(100 - RACCOON_SIZE, player.x + player.botDx * RACCOON_SPEED));
    const ny = Math.max(0, Math.min(100 - RACCOON_SIZE, player.y + player.botDy * RACCOON_SPEED));

    let blockedX = false;
    for (const asset of room.assets) {
      if (overlaps({ x: nx, y: player.y, w: RACCOON_SIZE, h: RACCOON_SIZE }, asset)) {
        tryTag(asset, player, room.frenzy);
        blockedX = true;
      }
    }
    if (!blockedX) player.x = nx;

    let blockedY = false;
    for (const asset of room.assets) {
      if (overlaps({ x: player.x, y: ny, w: RACCOON_SIZE, h: RACCOON_SIZE }, asset)) {
        tryTag(asset, player, room.frenzy);
        blockedY = true;
      }
    }
    if (!blockedY) player.y = ny;

    // Fully stuck — pick a new random direction to escape
    if (blockedX && blockedY) {
      const angle = Math.random() * Math.PI * 2;
      player.botDx = Math.cos(angle);
      player.botDy = Math.sin(angle);
      player.botDirTimer = BOT_DIR_TICKS;
    }
  }
}

/**
 * After the train moves (arriving/departing), push any overlapping player
 * below the train's bottom edge so they don't get stuck inside it.
 */
function pushPlayersFromTrain(room) {
  const trains = getTrainAssets(room.assets);
  for (const player of room.players.values()) {
    for (const train of trains) {
      if (train.x + train.w < 0) continue; // fully off-screen, skip
      const pBox = { x: player.x, y: player.y, w: RACCOON_SIZE, h: RACCOON_SIZE };
      if (!overlaps(pBox, train)) continue;
      player.y = Math.min(100 - RACCOON_SIZE, train.y + train.h);
      player.pendingY = player.y;
    }
  }
}

/**
 * After vehicles move, push any overlapping player out in the vehicle's direction of travel.
 */
function pushPlayersFromVehicles(room) {
  for (const asset of room.assets) {
    if (!asset.moving) continue;
    for (const player of room.players.values()) {
      const pBox = { x: player.x, y: player.y, w: RACCOON_SIZE, h: RACCOON_SIZE };
      if (!overlaps(pBox, asset)) continue;
      if (Math.abs(asset.vx) >= Math.abs(asset.vy)) {
        const newX = asset.vx >= 0
          ? Math.min(100 - RACCOON_SIZE, asset.x + asset.w)
          : Math.max(0, asset.x - RACCOON_SIZE);
        player.x = newX;
        player.pendingX = newX;
      } else {
        const newY = asset.vy >= 0
          ? Math.min(100 - RACCOON_SIZE, asset.y + asset.h)
          : Math.max(0, asset.y - RACCOON_SIZE);
        player.y = newY;
        player.pendingY = newY;
      }
    }
  }
}

/** True if (nx,ny) overlaps a STATIC asset (moving vehicles are ignored to prevent deadlock). */
function blockedByStatic(asset, nx, ny, room) {
  const box = { x: nx, y: ny, w: asset.w, h: asset.h };
  for (const other of room.assets) {
    if (other === asset || other.moving) continue;
    if (overlaps(box, other)) return true;
  }
  return false;
}

/** True if (nx,ny) overlaps another MOVING vehicle. */
function blockedByMover(asset, nx, ny, room) {
  const box = { x: nx, y: ny, w: asset.w, h: asset.h };
  for (const other of room.assets) {
    if (other === asset || !other.moving) continue;
    if (overlaps(box, other)) return true;
  }
  return false;
}

function moveVehicles(room) {
  for (const asset of room.assets) {
    if (!asset.moving) continue;

    if (!asset.route || asset.route.length < 2) {
      // Legacy bounce fallback
      asset.x += asset.vx;
      asset.y += asset.vy;
      if (asset.x <= 0 || asset.x + asset.w >= 100) {
        asset.vx *= -1;
        asset.x = Math.max(0, Math.min(100 - asset.w, asset.x));
      }
      if (asset.y <= 0 || asset.y + asset.h >= 100) {
        asset.vy *= -1;
        asset.y = Math.max(0, Math.min(100 - asset.h, asset.y));
      }
    } else {
      const target = asset.route[asset.routeIdx];
      const dx = target.x - asset.x;
      const dy = target.y - asset.y;

      if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) {
        // Reached waypoint — snap and advance
        asset.x = target.x;
        asset.y = target.y;
        asset.routeIdx = (asset.routeIdx + 1) % asset.route.length;
      } else {
        // Primary step: dominant axis toward waypoint (cardinal only)
        let mx = 0, my = 0;
        if (Math.abs(dx) >= Math.abs(dy)) {
          mx = Math.sign(dx) * Math.min(VEHICLE_SPEED, Math.abs(dx));
        } else {
          my = Math.sign(dy) * Math.min(VEHICLE_SPEED, Math.abs(dy));
        }

        const staticAhead = blockedByStatic(asset, asset.x + mx, asset.y + my, room);
        const moverAhead  = !staticAhead && blockedByMover(asset, asset.x + mx, asset.y + my, room);

        if (!staticAhead && !moverAhead) {
          // Path clear — move normally
          asset.x += mx;
          asset.y += my;
          asset.vx = mx !== 0 ? Math.sign(mx) * VEHICLE_SPEED : 0;
          asset.vy = my !== 0 ? Math.sign(my) * VEHICLE_SPEED : 0;
          asset.yieldTicks = 0;
          asset.stuckTicks = 0;
        } else if (moverAhead) {
          // Another vehicle ahead — yield briefly then push through
          asset.yieldTicks = (asset.yieldTicks || 0) + 1;
          if (asset.yieldTicks > 3) {
            asset.x += mx;
            asset.y += my;
            asset.vx = mx !== 0 ? Math.sign(mx) * VEHICLE_SPEED : 0;
            asset.vy = my !== 0 ? Math.sign(my) * VEHICLE_SPEED : 0;
            asset.yieldTicks = 0;
          }
        } else {
          // Static obstacle — try perpendicular detour
          const pa = mx !== 0 ? { x: 0, y:  VEHICLE_SPEED } : { x:  VEHICLE_SPEED, y: 0 };
          const pb = mx !== 0 ? { x: 0, y: -VEHICLE_SPEED } : { x: -VEHICLE_SPEED, y: 0 };
          const da = Math.hypot(target.x - (asset.x + pa.x), target.y - (asset.y + pa.y));
          const db = Math.hypot(target.x - (asset.x + pb.x), target.y - (asset.y + pb.y));
          let detoured = false;
          for (const p of da <= db ? [pa, pb] : [pb, pa]) {
            if (!blockedByStatic(asset, asset.x + p.x, asset.y + p.y, room)) {
              asset.x += p.x;
              asset.y += p.y;
              asset.vx = p.x !== 0 ? Math.sign(p.x) * VEHICLE_SPEED : 0;
              asset.vy = p.y !== 0 ? Math.sign(p.y) * VEHICLE_SPEED : 0;
              asset.stuckTicks = 0;
              detoured = true;
              break;
            }
          }
          if (!detoured) {
            // All directions blocked — count ticks and skip waypoint as last resort
            asset.stuckTicks = (asset.stuckTicks || 0) + 1;
            if (asset.stuckTicks > 10) {
              asset.routeIdx = (asset.routeIdx + 1) % asset.route.length;
              asset.stuckTicks = 0;
            }
          }
        }

        asset.x = Math.max(0, Math.min(100 - asset.w, asset.x));
        asset.y = Math.max(0, Math.min(100 - asset.h, asset.y));
      }
    }

    // Tag any overlapping raccoon
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
    pushPlayersFromVehicles(room);
    tickTrainState(room.assets, room.trainState);
    pushPlayersFromTrain(room);

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
  tickTrainState, getTrainAssets, pushPlayersFromTrain, pushPlayersFromVehicles,
  RACCOON_SIZE, RACCOON_SPEED, TICK_MS,
  TRAIN_SPEED,
  DOCKED_TICKS_MIN, DOCKED_TICKS_MAX,
  OFFSCREEN_TICKS_MIN, OFFSCREEN_TICKS_MAX,
};
