'use strict';

// 24-letter pool — no I or O to avoid confusion with 1 and 0
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const MAX_PLAYERS = 10;
const MIN_PLAYERS_TO_START = 5;

const PLAYER_COLORS = [
  '#FF6B35', '#E63946', '#2EC4B6', '#FF9F1C',
  '#C77DFF', '#4CC9F0', '#F72585', '#4ADE80',
  '#FB8500', '#7209B7',
];

// Team colors: team 0 = orange, team 1 = sky blue
const TEAM_COLORS = { 0: '#FF6B35', 1: '#4CC9F0' };

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

function serializePlayer(p) {
  return { id: p.id, name: p.name, color: p.color, teamId: p.teamId };
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

module.exports = {
  ROOM_CODE_CHARS,
  MAX_PLAYERS,
  MIN_PLAYERS_TO_START,
  PLAYER_COLORS,
  TEAM_COLORS,
  generateRoomCode,
  makeRoom,
  serializePlayer,
  getPlayers,
  nextHost,
};
