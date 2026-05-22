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
  'pickup-truck': { w: 6, h: 3 },
  'water-hauler': { w: 8, h: 3 },
  'frac-truck':   { w: 8, h: 3 },
  'tumbleweed':   { w: 3, h: 3 },
};
const STATIC_TYPES  = ['pump-jack', 'water-tank', 'container', 'silo', 'tool-shed', 'light-tower'];
const MOVING_TYPES  = ['pickup-truck', 'water-hauler', 'frac-truck', 'tumbleweed'];
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

// Returns the id of the player who should become host after `leavingId` departs.
// Reads from joinOrder (leavingId still present) and room.players (leavingId may be gone).
// Caller must call nextHost BEFORE deleting the player from room.players if needed.
function nextHost(room, leavingId) {
  return room.joinOrder.find(id => id !== leavingId && room.players.has(id)) || null;
}

function generateAssets(playerCount) {
  const count      = Math.min(Math.max(playerCount * 3, 6), 18);
  const movingCount = Math.max(1, Math.floor(count * 0.25));
  const staticCount = count - movingCount;
  const placed = [];

  function noOverlap(candidate) {
    for (const a of placed) {
      if (!(candidate.x + candidate.w <= a.x - ASSET_PADDING ||
            a.x + a.w + ASSET_PADDING <= candidate.x ||
            candidate.y + candidate.h <= a.y - ASSET_PADDING ||
            a.y + a.h + ASSET_PADDING <= candidate.y)) return false;
    }
    return true;
  }

  function placeOne(type, moving) {
    const { w, h } = ASSET_SIZES[type];
    for (let attempt = 0; attempt < 100; attempt++) {
      const x = MAP_MARGIN + Math.random() * (100 - MAP_MARGIN * 2 - w);
      const y = MAP_MARGIN + Math.random() * (100 - MAP_MARGIN * 2 - h);
      if (noOverlap({ x, y, w, h })) {
        const angle = Math.random() * Math.PI * 2;
        return {
          id: Math.random().toString(36).slice(2, 8),
          type, x, y, w, h,
          ownerId: null, ownerColor: null, cooldownUntil: 0,
          moving,
          vx: moving ? Math.cos(angle) * VEHICLE_SPEED : 0,
          vy: moving ? Math.sin(angle) * VEHICLE_SPEED : 0,
        };
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
  generateAssets,
};
