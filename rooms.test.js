'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const {
  ROOM_CODE_CHARS,
  PLAYER_COLORS,
  generateRoomCode,
  makeRoom,
  getPlayers,
  nextHost,
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

const { generateAssets } = require('./rooms');

test('generateAssets: returns 6 assets for 2 players', () => {
  const assets = generateAssets(2);
  assert.equal(assets.length, 6);
});

test('generateAssets: returns 12 assets for 4 players', () => {
  const assets = generateAssets(4);
  assert.equal(assets.length, 12);
});

test('generateAssets: caps at 18 for 10 players', () => {
  const assets = generateAssets(10);
  assert.equal(assets.length, 18);
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
