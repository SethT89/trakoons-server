'use strict';

// 24-letter pool — no I or O to avoid confusion with 1 and 0
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const MAX_PLAYERS = 10;
const MIN_PLAYERS_TO_START = 2;

const PLAYER_COLORS = [
  '#FF6B35', '#E63946', '#2EC4B6', '#FF9F1C',
  '#C77DFF', '#4CC9F0', '#F72585', '#4ADE80',
  '#FB8500', '#7209B7',
];

// Team colors: team 0 = orange, team 1 = sky blue
const TEAM_COLORS = { 0: '#FF6B35', 1: '#4CC9F0' };

const ASSET_SIZES = {
  'pump-jack':    { w: 6, h: 6 },
  'water-tank':   { w: 5, h: 5 },
  'container':    { w: 8, h: 4 },
  'silo':         { w: 4, h: 6 },
  'tool-shed':    { w: 5, h: 5 },
  'light-tower':  { w: 3, h: 6 },
  'pickup-truck': { w: 10, h: 7 },
  'water-hauler': { w: 8, h: 3 },
  'frac-truck':   { w: 8, h: 3 },
  'tumbleweed':   { w: 3, h: 3 },
};

// Train asset sizes (game units)
ASSET_SIZES['train-engine'] = { w: 10, h: 6 };
ASSET_SIZES['train-car']    = { w: 8,  h: 6 };

// Fixed train pieces — always present, positioned top-left on the track.
// generateAssets spread-copies these so tags don't bleed between games.
const TRAIN_TEMPLATES = [
  { id: 'train-engine', type: 'train-engine', x:  2, y: 8, w: 10, h: 6 },
  { id: 'train-car-1',  type: 'train-car',    x: 13, y: 8, w:  8, h: 6 },
  { id: 'train-car-2',  type: 'train-car',    x: 22, y: 8, w:  8, h: 6 },
  { id: 'train-car-3',  type: 'train-car',    x: 31, y: 8, w:  8, h: 6 },
  { id: 'train-car-4',  type: 'train-car',    x: 40, y: 8, w:  8, h: 6 },
];
const STATIC_TYPES  = ['container'];
const MOVING_TYPES  = ['pickup-truck'];
const MAP_MARGIN    = 5;   // keep assets 5 units from edges
const ASSET_PADDING = 2;   // min gap between assets
const VEHICLE_SPEED = 1.675; // units per 100ms tick (67% of raccoon speed)

const BOT_NAMES = [
  'Bandit', 'Rascal', 'Dumpster', 'Patches', 'Sneaky',
  'Trashy', 'Nibbles', 'Chaos', 'Greasy', 'Mayhem',
];

function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

// makeRoom does NOT attach ws — server.js does that after creating
function makeRoom(code, hostId, hostName) {
  const color = PLAYER_COLORS[0];
  return {
    code,
    state: 'waiting',
    mode: 'ffa',
    hostId,
    joinOrder: [hostId],
    players: new Map([[
      hostId,
      { id: hostId, name: hostName, color, teamId: null, ws: null },
    ]]),
    cleanupTimer: null,
  };
}

function makeBot(room) {
  const usedNames = new Set(Array.from(room.players.values()).map(p => p.name));
  const name = BOT_NAMES.find(n => !usedNames.has(n)) ?? `Bot${room.players.size + 1}`;
  const color = PLAYER_COLORS[room.players.size % PLAYER_COLORS.length];
  const id = 'bot-' + Math.random().toString(36).slice(2, 8);
  return { id, name, color, teamId: null, ws: null, isBot: true };
}

function serializePlayer(p) {
  return { id: p.id, name: p.name, color: p.color, teamId: p.teamId, isBot: p.isBot ?? false };
}

function getPlayers(room) {
  return Array.from(room.players.values()).map(serializePlayer);
}

/**
 * Returns the team index (0 or 1) that should receive the next player
 * to keep teams balanced. Ties go to team 0. Players with teamId === null
 * are not counted.
 */
function assignTeam(room) {
  let count0 = 0, count1 = 0;
  for (const p of room.players.values()) {
    if (p.teamId === 0) count0++;
    else if (p.teamId === 1) count1++;
  }
  return count0 <= count1 ? 0 : 1;
}

// Returns the id of the player who should become host after `leavingId` departs.
// Reads from joinOrder (leavingId still present) and room.players (leavingId may be gone).
// Caller must call nextHost BEFORE deleting the player from room.players if needed.
function nextHost(room, leavingId) {
  return room.joinOrder.find(id => id !== leavingId && room.players.has(id)) || null;
}

// Fixed trough obstacle — always present, non-taggable, blocks movement
const TROUGH = {
  id: 'trough',
  type: 'trough',
  x: 46, y: 47, w: 8, h: 3,
  ownerId: null, ownerColor: null, cooldownUntil: 0,
  moving: false, vx: 0, vy: 0,
};

function generateAssets(playerCount) {
  const count      = Math.min(Math.max(playerCount * 3, 6), 18);
  const movingCount = Math.max(1, Math.floor(count * 0.25));
  const staticCount = count - movingCount;
  const trainAssets = TRAIN_TEMPLATES.map(t => ({
    ...t,
    ownerId: null, ownerColor: null, cooldownUntil: 0,
    moving: false, vx: 0, vy: 0,
  }));
  const placed = [TROUGH, ...trainAssets]; // trough placed first so nothing spawns on it

  function noOverlap(candidate) {
    for (const a of placed) {
      if (!(candidate.x + candidate.w <= a.x - ASSET_PADDING ||
            a.x + a.w + ASSET_PADDING <= candidate.x ||
            candidate.y + candidate.h <= a.y - ASSET_PADDING ||
            a.y + a.h + ASSET_PADDING <= candidate.y)) return false;
    }
    return true;
  }

  // Check that the full swept area of a rectangular route doesn't cross any
  // static asset already in `placed`. Prevents vehicles getting stuck mid-route.
  function routeIsClear(route, assetW, assetH) {
    const rX = route[0].x, rY = route[0].y;
    const rW = route[1].x - rX;
    const rH = route[2].y - rY;
    // Four swept rectangles — the full area the vehicle occupies on each leg
    const sweeps = [
      { x: rX,      y: rY,      w: rW + assetW, h: assetH      }, // →
      { x: rX + rW, y: rY,      w: assetW,      h: rH + assetH }, // ↓
      { x: rX,      y: rY + rH, w: rW + assetW, h: assetH      }, // ←
      { x: rX,      y: rY,      w: assetW,      h: rH + assetH }, // ↑
    ];
    for (const sw of sweeps) {
      for (const s of placed) {
        if (s.moving) continue; // only care about statics
        if (!(sw.x + sw.w <= s.x || s.x + s.w <= sw.x ||
              sw.y + sw.h <= s.y || s.y + s.h <= sw.y)) return false;
      }
    }
    return true;
  }

  function placeOne(type, moving) {
    const { w, h } = ASSET_SIZES[type];
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!moving) {
        const x = MAP_MARGIN + Math.random() * (100 - MAP_MARGIN * 2 - w);
        const y = MAP_MARGIN + Math.random() * (100 - MAP_MARGIN * 2 - h);
        if (noOverlap({ x, y, w, h })) {
          return {
            id: Math.random().toString(36).slice(2, 8),
            type, x, y, w, h,
            ownerId: null, ownerColor: null, cooldownUntil: 0,
            moving: false, vx: 0, vy: 0,
          };
        }
      } else {
        // Pick a random center point, generate route dimensions, then clamp to map.
        // Overlap check uses the actual start position (rX, rY) so each truck
        // gets a distinct route rather than clustering at the same clamped corner.
        const rW = 15 + Math.random() * 25;
        const rH = 15 + Math.random() * 25;
        const cx = MAP_MARGIN + Math.random() * (100 - MAP_MARGIN * 2);
        const cy = MAP_MARGIN + Math.random() * (100 - MAP_MARGIN * 2);
        const rX = Math.max(MAP_MARGIN, Math.min(100 - MAP_MARGIN - w - rW, cx - rW / 2));
        const rY = Math.max(MAP_MARGIN, Math.min(100 - MAP_MARGIN - h - rH, cy - rH / 2));
        const route = [
          { x: rX,      y: rY      },
          { x: rX + rW, y: rY      },
          { x: rX + rW, y: rY + rH },
          { x: rX,      y: rY + rH },
        ];
        if (noOverlap({ x: rX, y: rY, w, h }) && routeIsClear(route, w, h)) {
          return {
            id: Math.random().toString(36).slice(2, 8),
            type, x: rX, y: rY, w, h,
            ownerId: null, ownerColor: null, cooldownUntil: 0,
            moving: true, vx: VEHICLE_SPEED, vy: 0,
            route, routeIdx: 1,
          };
        }
      }
    }
    return null;
  }

  for (let i = 0; i < staticCount; i++) {
    const a = placeOne(STATIC_TYPES[i % STATIC_TYPES.length], false);
    if (a) placed.push(a);
  }
  for (let i = 0; i < movingCount; i++) {
    const a = placeOne(MOVING_TYPES[i % MOVING_TYPES.length], true);
    if (a) placed.push(a);
  }
  return placed;
}

module.exports = {
  ROOM_CODE_CHARS,
  MAX_PLAYERS,
  MIN_PLAYERS_TO_START,
  PLAYER_COLORS,
  TEAM_COLORS,
  BOT_NAMES,
  generateRoomCode,
  makeRoom,
  makeBot,
  serializePlayer,
  getPlayers,
  nextHost,
  assignTeam,
  generateAssets,
};
