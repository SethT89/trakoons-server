'use strict';
const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const {
  PLAYER_COLORS,
  MAX_PLAYERS,
  MIN_PLAYERS_TO_START,
  generateRoomCode,
  makeRoom,
  makeBot,
  getPlayers,
  nextHost,
  assignTeam,
} = require('./rooms');
const { startGameLoop, stopGameLoop } = require('./gameLoop');

const PORT = process.env.PORT || 8080;
const COUNTDOWN_SECONDS = 3;
const IDLE_CLEANUP_MS = 30 * 60 * 1000;

const rooms = new Map();          // roomCode → room
const clientToRoom = new Map();   // ws → roomCode
const clientToPlayer = new Map(); // ws → playerId

// ─── Helpers ──────────────────────────────────────────────────────────────────

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastToRoom(room, msg, excludeWs = null) {
  const data = JSON.stringify(msg);
  room.players.forEach(p => {
    if (p.ws && p.ws !== excludeWs && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(data);
    }
  });
}

function getRoomAndPlayer(ws) {
  const roomCode = clientToRoom.get(ws);
  const playerId = clientToPlayer.get(ws);
  const room = roomCode ? rooms.get(roomCode) : null;
  const player = room ? room.players.get(playerId) : null;
  return { roomCode, playerId, room, player };
}

function scheduleIdleCleanup(room) {
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => rooms.delete(room.code), IDLE_CLEANUP_MS);
}

// ─── Message handlers ─────────────────────────────────────────────────────────

function handleCreateRoom(ws, msg) {
  const name = String(msg.name || '').trim().slice(0, 20);
  if (!name) { send(ws, { type: 'error', message: 'Name required' }); return; }

  let code;
  do { code = generateRoomCode(); } while (rooms.has(code));

  const playerId = uuidv4();
  const room = makeRoom(code, playerId, name);
  room.players.get(playerId).ws = ws;
  rooms.set(code, room);
  clientToRoom.set(ws, code);
  clientToPlayer.set(ws, playerId);

  send(ws, {
    type: 'roomCreated',
    roomCode: code,
    playerId,
    color: room.players.get(playerId).color,
    mode: room.mode,
    hostId: room.hostId,
    players: getPlayers(room),
  });
}

function handleJoinRoom(ws, msg) {
  const name = String(msg.name || '').trim().slice(0, 20);
  const code = String(msg.code || '').toUpperCase().trim();
  if (!name) { send(ws, { type: 'error', message: 'Name required' }); return; }

  const room = rooms.get(code);
  if (!room) { send(ws, { type: 'error', message: 'Room not found' }); return; }
  if (room.state !== 'waiting') { send(ws, { type: 'error', message: 'Game already in progress' }); return; }
  if (room.players.size >= MAX_PLAYERS) { send(ws, { type: 'error', message: 'Room is full' }); return; }

  const playerId = uuidv4();
  const color = PLAYER_COLORS[room.players.size % PLAYER_COLORS.length];
  const teamId = room.mode === 'teams' ? assignTeam(room) : null;
  room.players.set(playerId, { id: playerId, name, color, teamId, ws });
  room.joinOrder.push(playerId);
  clientToRoom.set(ws, code);
  clientToPlayer.set(ws, playerId);

  // Cancel any idle cleanup now that a player joined
  if (room.cleanupTimer) { clearTimeout(room.cleanupTimer); room.cleanupTimer = null; }

  send(ws, {
    type: 'roomJoined',
    roomCode: code,
    playerId,
    color,
    mode: room.mode,
    hostId: room.hostId,
    players: getPlayers(room),
  });
  broadcastToRoom(room, { type: 'playerJoined', players: getPlayers(room) }, ws);
}

function handleSetMode(ws, msg) {
  const { playerId, room } = getRoomAndPlayer(ws);
  if (!room || room.state !== 'waiting' || room.hostId !== playerId) return;
  if (msg.mode !== 'ffa' && msg.mode !== 'teams') return;
  room.mode = msg.mode;
  // Reset all team assignments first
  room.players.forEach(p => { p.teamId = null; });
  // In teams mode, auto-assign everyone in join order to keep balance
  if (room.mode === 'teams') {
    for (const id of room.joinOrder) {
      const p = room.players.get(id);
      if (p) p.teamId = assignTeam(room);
    }
  }
  broadcastToRoom(room, { type: 'modeChanged', mode: room.mode, players: getPlayers(room) });
}

function handleSetTeam(ws, msg) {
  const { playerId, room, player } = getRoomAndPlayer(ws);
  if (!room || room.state !== 'waiting' || room.mode !== 'teams') return;
  if (!player) return;
  if (msg.teamId !== 0 && msg.teamId !== 1) return;
  player.teamId = msg.teamId;
  broadcastToRoom(room, { type: 'teamChanged', players: getPlayers(room) });
}

function handleKickPlayer(ws, msg) {
  const { playerId, room } = getRoomAndPlayer(ws);
  if (!room || room.state !== 'waiting' || room.hostId !== playerId) return;
  const kickId = msg.playerId;
  if (!kickId || kickId === playerId) return;
  const kicked = room.players.get(kickId);
  if (!kicked) return;

  if (kicked.ws && kicked.ws.readyState === WebSocket.OPEN) {
    kicked.ws.send(JSON.stringify({ type: 'kicked' }));
    kicked.ws.close();
  }
  room.players.delete(kickId);
  room.joinOrder = room.joinOrder.filter(id => id !== kickId);
  clientToRoom.delete(kicked.ws);
  clientToPlayer.delete(kicked.ws);

  broadcastToRoom(room, { type: 'playerKicked', kickedPlayerId: kickId, players: getPlayers(room) });
}

function handleSetBotTeam(ws, msg) {
  const { playerId, room } = getRoomAndPlayer(ws);
  if (!room || room.state !== 'waiting' || room.hostId !== playerId) return;
  const bot = room.players.get(msg.botId);
  if (!bot || !bot.isBot) return;
  if (msg.teamId !== 0 && msg.teamId !== 1) return;
  bot.teamId = msg.teamId;
  broadcastToRoom(room, { type: 'teamChanged', players: getPlayers(room) });
}

function handleAddBot(ws) {
  const { playerId, room } = getRoomAndPlayer(ws);
  if (!room || room.state !== 'waiting' || room.hostId !== playerId) return;
  if (room.players.size >= MAX_PLAYERS) {
    send(ws, { type: 'error', message: 'Room is full' });
    return;
  }
  const bot = makeBot(room);
  if (room.mode === 'teams') bot.teamId = assignTeam(room);
  room.players.set(bot.id, bot);
  room.joinOrder.push(bot.id);
  broadcastToRoom(room, { type: 'playerJoined', players: getPlayers(room) });
}

function handleRemoveBot(ws, msg) {
  const { playerId, room } = getRoomAndPlayer(ws);
  if (!room || room.state !== 'waiting' || room.hostId !== playerId) return;
  const bot = room.players.get(msg.botId);
  if (!bot || !bot.isBot) return;
  room.players.delete(bot.id);
  room.joinOrder = room.joinOrder.filter(id => id !== bot.id);
  broadcastToRoom(room, { type: 'playerLeft', players: getPlayers(room) });
}

function handleMove(ws, msg) {
  const { room, player } = getRoomAndPlayer(ws);
  if (!room || room.state !== 'playing' || !player || player.isBot) return;
  const x = Number(msg.x), y = Number(msg.y);
  if (!isFinite(x) || !isFinite(y)) return;
  player.pendingX = x;
  player.pendingY = y;
}

function handleBackToLobby(ws) {
  const { room } = getRoomAndPlayer(ws);
  if (!room) return;
  if (room.getReadyTimer) { clearTimeout(room.getReadyTimer); room.getReadyTimer = null; }
  stopGameLoop(room);
  room.state = 'waiting';
}

function handleStartGame(ws) {
  const { playerId, room } = getRoomAndPlayer(ws);
  if (!room || room.state !== 'waiting' || room.hostId !== playerId) return;
  if (room.players.size < MIN_PLAYERS_TO_START) {
    send(ws, { type: 'error', message: `Need ${MIN_PLAYERS_TO_START}+ players to start` });
    return;
  }
  startCountdown(room.code);
}

function startCountdown(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  room.state = 'countdown';
  broadcastToRoom(room, { type: 'getReady' });

  room.getReadyTimer = setTimeout(() => {
    room.getReadyTimer = null;
    const r = rooms.get(roomCode);
    if (!r || r.state !== 'countdown') return; // aborted (e.g. back to lobby)
    broadcastToRoom(r, { type: 'countdown', count: COUNTDOWN_SECONDS });
    let count = COUNTDOWN_SECONDS;
    const iv = setInterval(() => {
      count--;
      if (count > 0) {
        broadcastToRoom(r, { type: 'countdown', count });
      } else {
        clearInterval(iv);
        r.state = 'playing';
        broadcastToRoom(r, { type: 'gameStarted', players: getPlayers(r), mode: r.mode });
        startGameLoop(r);
      }
    }, 1000);
  }, 3000);
}

function handleDisconnect(ws) {
  const { roomCode, playerId, room } = getRoomAndPlayer(ws);
  clientToRoom.delete(ws);
  clientToPlayer.delete(ws);
  if (!room || !playerId) return;

  // Determine next host BEFORE mutating players/joinOrder
  const newHostId = room.hostId === playerId ? nextHost(room, playerId) : null;

  room.players.delete(playerId);
  room.joinOrder = room.joinOrder.filter(id => id !== playerId);

  if (room.players.size === 0) {
    stopGameLoop(room);
    rooms.delete(roomCode);
    return;
  }

  if (newHostId) {
    room.hostId = newHostId;
    broadcastToRoom(room, { type: 'hostChanged', hostId: newHostId });
  }

  if (room.state === 'waiting') {
    broadcastToRoom(room, { type: 'playerLeft', players: getPlayers(room) });
    scheduleIdleCleanup(room);
  } else {
    broadcastToRoom(room, { type: 'playerLeft', players: getPlayers(room) });
    if (room.players.size === 0) {
      stopGameLoop(room);
      rooms.delete(roomCode);
    }
  }
}

// ─── HTTP + WebSocket ─────────────────────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Trakoons server running');
});

const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', ws => {
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case 'createRoom':  handleCreateRoom(ws, msg); break;
      case 'joinRoom':    handleJoinRoom(ws, msg);   break;
      case 'setMode':     handleSetMode(ws, msg);    break;
      case 'setTeam':     handleSetTeam(ws, msg);    break;
      case 'kickPlayer':  handleKickPlayer(ws, msg); break;
      case 'addBot':       handleAddBot(ws);              break;
      case 'removeBot':    handleRemoveBot(ws, msg);     break;
      case 'setBotTeam':   handleSetBotTeam(ws, msg);    break;
      case 'startGame':   handleStartGame(ws);       break;
      case 'backToLobby': handleBackToLobby(ws);     break;
      case 'move':        handleMove(ws, msg);        break;
    }
  });
  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => ws.close());
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Trakoons server running on port ${PORT}`);
});
