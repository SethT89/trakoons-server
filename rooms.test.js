'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const {
  ROOM_CODE_CHARS,
  PLAYER_COLORS,
  generateRoomCode,
  makeRoom,
  nextColor,
  getPlayers,
  nextHost,
  generateAssets,
} = require('./rooms');

test('generateRoomCode returns exactly 4 characters', () => {
  assert.equal(generateRoomCode().length, 4);
});

test('generateRoomCode never contains I or O', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateRoomCode();
    for (const ch of code) {
      assert.ok(ROOM_CODE_CHARS.includes(ch), `Unexpected char: ${ch}`);
    }
    assert.ok(!code.includes('I'), 'Should not contain I');
    assert.ok(!code.includes('O'), 'Should not contain O');
  }
});

test('makeRoom creates room with correct initial state', () => {
  const hostId = uuidv4();
  const room = makeRoom('ABCD', hostId, 'Alice');
  assert.equal(room.code, 'ABCD');
  assert.equal(room.hostId, hostId);
  assert.equal(room.state, 'waiting');
  assert.equal(room.mode, 'ffa');
  assert.ok(room.players.has(hostId));
  assert.equal(room.players.get(hostId).name, 'Alice');
  assert.deepEqual(room.joinOrder, [hostId]);
});

test('getPlayers strips ws from serialized output', () => {
  const hostId = uuidv4();
  const room = makeRoom('ABCD', hostId, 'Alice');
  room.players.get(hostId).ws = { fake: 'ws' };
  const players = getPlayers(room);
  assert.equal(players.length, 1);
  assert.equal(players[0].name, 'Alice');
  assert.ok(!('ws' in players[0]), 'ws must not be serialized');
});

test('nextHost returns next player in joinOrder', () => {
  const hostId = uuidv4();
  const p2Id = uuidv4();
  const room = makeRoom('ABCD', hostId, 'Alice');
  room.players.set(p2Id, { id: p2Id, name: 'Bob', color: PLAYER_COLORS[1], teamId: null, ws: null });
  room.joinOrder.push(p2Id);
  assert.equal(nextHost(room, hostId), p2Id);
});

test('nextHost returns null when only one player', () => {
  const hostId = uuidv4();
  const room = makeRoom('ABCD', hostId, 'Alice');
  assert.equal(nextHost(room, hostId), null);
});

const { assignTeam } = require('./rooms');

test('assignTeam: returns 0 when no players have a team', () => {
  const hostId = uuidv4();
  const room = makeRoom('ABCD', hostId, 'Alice');
  assert.equal(assignTeam(room), 0);
});

test('assignTeam: returns 1 when team 0 has more players', () => {
  const hostId = uuidv4();
  const p2Id = uuidv4();
  const room = makeRoom('ABCD', hostId, 'Alice');
  room.players.get(hostId).teamId = 0;
  room.players.set(p2Id, { id: p2Id, name: 'Bob', color: '#fff', teamId: null, ws: null });
  room.joinOrder.push(p2Id);
  assert.equal(assignTeam(room), 1);
});

test('assignTeam: returns 0 when team 1 has more players', () => {
  const hostId = uuidv4();
  const p2Id = uuidv4();
  const room = makeRoom('ABCD', hostId, 'Alice');
  room.players.get(hostId).teamId = 1;
  room.players.set(p2Id, { id: p2Id, name: 'Bob', color: '#fff', teamId: null, ws: null });
  room.joinOrder.push(p2Id);
  assert.equal(assignTeam(room), 0);
});

test('assignTeam: returns 0 on a tie', () => {
  const hostId = uuidv4();
  const p2Id = uuidv4();
  const room = makeRoom('ABCD', hostId, 'Alice');
  room.players.get(hostId).teamId = 0;
  room.players.set(p2Id, { id: p2Id, name: 'Bob', color: '#fff', teamId: 1, ws: null });
  room.joinOrder.push(p2Id);
  assert.equal(assignTeam(room), 0);
});

test('assignTeam: ignores players with teamId null when counting', () => {
  const hostId = uuidv4();
  const p2Id = uuidv4();
  const p3Id = uuidv4();
  const room = makeRoom('ABCD', hostId, 'Alice');
  room.players.get(hostId).teamId = 0;
  room.players.set(p2Id, { id: p2Id, name: 'Bob', color: '#fff', teamId: null, ws: null });
  room.players.set(p3Id, { id: p3Id, name: 'Carol', color: '#fff', teamId: null, ws: null });
  room.joinOrder.push(p2Id, p3Id);
  assert.equal(assignTeam(room), 1);
});

test('generateAssets: returns at least 7 assets for 2 players (1 trough + 5 train + at least 1 generated)', () => {
  const assets = generateAssets(2);
  assert.ok(assets.length >= 7);
});

test('generateAssets: returns at least 7 assets for 4 players (1 trough + 5 train + at least 1 generated)', () => {
  const assets = generateAssets(4);
  assert.ok(assets.length >= 7);
});

test('generateAssets: caps at least 7 assets for 10 players (1 trough + 5 train + at least 1 generated)', () => {
  const assets = generateAssets(10);
  assert.ok(assets.length >= 7);
});

test('generateAssets: all assets have required fields', () => {
  const assets = generateAssets(2);
  for (const a of assets) {
    assert.ok(a.id, 'has id');
    assert.ok(a.type, 'has type');
    assert.equal(typeof a.x, 'number');
    assert.equal(typeof a.y, 'number');
    assert.ok(a.w > 0);
    assert.ok(a.h > 0);
    assert.equal(a.ownerId, null);
    assert.equal(a.ownerColor, null);
    assert.equal(a.cooldownUntil, 0);
    assert.equal(typeof a.moving, 'boolean');
    assert.equal(typeof a.vx, 'number');
    assert.equal(typeof a.vy, 'number');
  }
});

test('generateAssets: no assets overlap each other', () => {
  const assets = generateAssets(6);
  for (let i = 0; i < assets.length; i++) {
    for (let j = i + 1; j < assets.length; j++) {
      const a = assets[i], b = assets[j];
      const overlap = !(a.x + a.w <= b.x || b.x + b.w <= a.x ||
                        a.y + a.h <= b.y || b.y + b.h <= a.y);
      assert.ok(!overlap, `assets ${i} and ${j} must not overlap`);
    }
  }
});

test('generateAssets: moving assets have non-zero velocity', () => {
  const assets = generateAssets(6);
  const moving = assets.filter(a => a.moving);
  assert.ok(moving.length > 0, 'has at least one moving asset');
  for (const a of moving) {
    assert.ok(Math.abs(a.vx) > 0 || Math.abs(a.vy) > 0, 'moving asset has velocity');
  }
});

test('generateAssets always includes all 5 train assets with correct ids', () => {
  const assets = generateAssets(2);
  const trainIds = ['train-engine', 'train-car-1', 'train-car-2', 'train-car-3', 'train-car-4'];
  for (const id of trainIds) {
    const a = assets.find(a => a.id === id);
    assert.ok(a, `Missing train asset: ${id}`);
    assert.equal(a.moving, false);
    assert.equal(a.ownerColor, null);
  }
});

test('nextColor returns first unused PLAYER_COLORS entry', () => {
  const room = makeRoom('TEST', 'host-1', 'Host');
  // Host has PLAYER_COLORS[0]; nextColor should return PLAYER_COLORS[1]
  assert.equal(nextColor(room), PLAYER_COLORS[1]);
});

test('nextColor skips colors already in use after a player leaves', () => {
  const room = makeRoom('TEST', 'host-1', 'Host');
  // Simulate two more players with colors[1] and colors[2]
  room.players.set('p2', { id: 'p2', name: 'P2', color: PLAYER_COLORS[1], teamId: null, ws: null });
  room.players.set('p3', { id: 'p3', name: 'P3', color: PLAYER_COLORS[2], teamId: null, ws: null });
  // Remove p2 — their color should now be available again
  room.players.delete('p2');
  assert.equal(nextColor(room), PLAYER_COLORS[1]);
});

test('train-engine is left of train-car-1, which is left of train-car-4', () => {
  const assets = generateAssets(2);
  const engine = assets.find(a => a.id === 'train-engine');
  const car1   = assets.find(a => a.id === 'train-car-1');
  const car4   = assets.find(a => a.id === 'train-car-4');
  assert.ok(engine.x < car1.x, 'engine must be left of car-1');
  assert.ok(car1.x  < car4.x, 'car-1 must be left of car-4');
});
