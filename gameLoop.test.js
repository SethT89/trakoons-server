'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { overlaps, tryTag, buildGameOverPayload } = require('./gameLoop');

describe('overlaps', () => {
  test('returns true for overlapping boxes', () => {
    assert.equal(overlaps({ x: 0, y: 0, w: 5, h: 5 }, { x: 3, y: 3, w: 5, h: 5 }), true);
  });
  test('returns false for separated boxes', () => {
    assert.equal(overlaps({ x: 0, y: 0, w: 5, h: 5 }, { x: 10, y: 10, w: 5, h: 5 }), false);
  });
  test('returns false for touching-edge boxes (not overlapping)', () => {
    assert.equal(overlaps({ x: 0, y: 0, w: 5, h: 5 }, { x: 5, y: 0, w: 5, h: 5 }), false);
  });
});

describe('tryTag', () => {
  test('claims an unowned asset', () => {
    const asset  = { ownerId: null, ownerColor: null, cooldownUntil: 0 };
    const player = { id: 'p1', color: '#FF0000' };
    tryTag(asset, player, false);
    assert.equal(asset.ownerId, 'p1');
    assert.equal(asset.ownerColor, '#FF0000');
    assert.ok(asset.cooldownUntil > Date.now() + 2000);
  });

  test('ignores tag during cooldown', () => {
    const asset  = { ownerId: 'p1', ownerColor: '#FF0000', cooldownUntil: Date.now() + 5000 };
    const player = { id: 'p2', color: '#0000FF' };
    tryTag(asset, player, false);
    assert.equal(asset.ownerId, 'p1');
  });

  test('ignores tag on own asset (even after cooldown)', () => {
    const asset  = { ownerId: 'p1', ownerColor: '#FF0000', cooldownUntil: Date.now() - 1 };
    const player = { id: 'p1', color: '#FF0000' };
    tryTag(asset, player, false);
    assert.equal(asset.ownerId, 'p1');
    // cooldownUntil should NOT be reset (no change for own tag)
  });

  test('applies frenzy cooldown (~1000ms)', () => {
    const asset  = { ownerId: null, ownerColor: null, cooldownUntil: 0 };
    const player = { id: 'p1', color: '#FF0000' };
    const before = Date.now();
    tryTag(asset, player, true);
    assert.ok(asset.cooldownUntil - before <= 1100);
    assert.ok(asset.cooldownUntil - before >= 900);
  });

  test('allows retag after cooldown expires', () => {
    const asset  = { ownerId: 'p1', ownerColor: '#FF0000', cooldownUntil: Date.now() - 1 };
    const player = { id: 'p2', color: '#0000FF' };
    tryTag(asset, player, false);
    assert.equal(asset.ownerId, 'p2');
  });
});

describe('buildGameOverPayload', () => {
  test('FFA: ranks by asset count, correct winner', () => {
    const room = {
      mode: 'ffa',
      players: new Map([
        ['p1', { id: 'p1', name: 'Alice', color: '#FF0000', teamId: null }],
        ['p2', { id: 'p2', name: 'Bob',   color: '#00FF00', teamId: null }],
      ]),
      assets: [
        { ownerId: 'p1' }, { ownerId: 'p1' }, { ownerId: 'p2' },
      ],
    };
    const p = buildGameOverPayload(room);
    assert.equal(p.type, 'gameOver');
    assert.equal(p.scores[0].id, 'p1');
    assert.equal(p.scores[0].assetCount, 2);
    assert.equal(p.scores[1].assetCount, 1);
    assert.equal(p.winner, 'p1');
    assert.equal(p.winnerLabel, 'Alice');
    assert.equal(p.teamScores, undefined);
  });

  test('Teams: sums by team, correct winner team', () => {
    const room = {
      mode: 'teams',
      players: new Map([
        ['p1', { id: 'p1', name: 'Alice', color: '#FF0000', teamId: 0 }],
        ['p2', { id: 'p2', name: 'Bob',   color: '#00FF00', teamId: 1 }],
        ['p3', { id: 'p3', name: 'Cara',  color: '#0000FF', teamId: 0 }],
      ]),
      assets: [
        { ownerId: 'p1' }, { ownerId: 'p1' },
        { ownerId: 'p2' },
        { ownerId: 'p3' }, { ownerId: 'p3' }, { ownerId: 'p3' },
      ],
    };
    const p = buildGameOverPayload(room);
    assert.equal(p.teamScores[0], 5); // Alice(2) + Cara(3)
    assert.equal(p.teamScores[1], 1); // Bob(1)
    assert.equal(p.winner, '0');
    assert.equal(p.winnerLabel, 'Orange');
  });

  test('unowned assets are not counted for any player', () => {
    const room = {
      mode: 'ffa',
      players: new Map([
        ['p1', { id: 'p1', name: 'Alice', color: '#FF0000', teamId: null }],
      ]),
      assets: [{ ownerId: null }, { ownerId: 'p1' }],
    };
    const p = buildGameOverPayload(room);
    assert.equal(p.scores[0].assetCount, 1);
  });
});
