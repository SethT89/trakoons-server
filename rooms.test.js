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
