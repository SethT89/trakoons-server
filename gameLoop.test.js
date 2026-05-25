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

const {
  tickTrainState, getTrainAssets, pushPlayersFromTrain, TRAIN_SPEED,
  DOCKED_TICKS_MIN, DOCKED_TICKS_MAX,
  OFFSCREEN_TICKS_MIN, OFFSCREEN_TICKS_MAX,
  RACCOON_SIZE,
} = require('./gameLoop');

function makeMockTrain() {
  const dockedX = [2, 9, 14, 19, 24, 29, 34];
  const ids = ['train-engine', 'train-car-1', 'train-car-2', 'train-car-3', 'train-car-4', 'train-car-5', 'train-car-6'];
  const assets = ids.map((id, i) => ({
    id, type: id === 'train-engine' ? 'train-engine' : 'train-car',
    x: dockedX[i], y: 8, w: id === 'train-engine' ? 7 : 5, h: 6,
    ownerId: null, ownerColor: null, cooldownUntil: 0, moving: false, vx: 0, vy: 0,
  }));
  const trainState = { phase: 'docked', ticksLeft: DOCKED_TICKS_MAX, dockedX };
  return { assets, trainState };
}

describe('tickTrainState', () => {
  test('docked phase counts down and transitions to departing at zero', () => {
    const { assets, trainState } = makeMockTrain();
    trainState.ticksLeft = 1;
    tickTrainState(assets, trainState);
    assert.equal(trainState.phase, 'departing');
  });

  test('departing phase moves all train assets left each tick', () => {
    const { assets, trainState } = makeMockTrain();
    trainState.phase = 'departing';
    const xBefore = assets.map(a => a.x);
    tickTrainState(assets, trainState);
    const delta = xBefore[0] - assets[0].x;
    assert.ok(delta > 0, 'engine must move left');
    for (let i = 1; i < assets.length; i++) {
      const moveDelta = xBefore[i] - assets[i].x;
      // Allow ±0.0001 tolerance due to floating-point arithmetic
      assert.ok(Math.abs(moveDelta - delta) < 0.0001, `asset ${i} must move by same delta as engine; expected ~${delta}, got ${moveDelta}`);
    }
  });

  test('departing transitions to offscreen when car-6 right edge clears left boundary', () => {
    const { assets, trainState } = makeMockTrain();
    trainState.phase = 'departing';
    const car6 = assets.find(a => a.id === 'train-car-6');
    car6.x = -car6.w + 0.5; // right edge at 0.5
    tickTrainState(assets, trainState);
    assert.equal(trainState.phase, 'offscreen');
    assert.ok(
      trainState.ticksLeft >= OFFSCREEN_TICKS_MIN && trainState.ticksLeft <= OFFSCREEN_TICKS_MAX,
      `ticksLeft ${trainState.ticksLeft} out of range [${OFFSCREEN_TICKS_MIN}, ${OFFSCREEN_TICKS_MAX}]`,
    );
    for (const a of getTrainAssets(assets)) {
      assert.ok(a.x + a.w < 0, `${a.id} should be off-screen, got x=${a.x}`);
    }
  });

  test('offscreen phase counts down and transitions to arriving at zero', () => {
    const { assets, trainState } = makeMockTrain();
    trainState.phase = 'offscreen';
    trainState.ticksLeft = 1;
    for (let i = 0; i < assets.length; i++) assets[i].x = trainState.dockedX[i] - 60;
    tickTrainState(assets, trainState);
    assert.equal(trainState.phase, 'arriving');
  });

  test('arriving phase moves all train assets right each tick', () => {
    const { assets, trainState } = makeMockTrain();
    trainState.phase = 'arriving';
    for (let i = 0; i < assets.length; i++) assets[i].x = trainState.dockedX[i] - 60;
    const engineXBefore = assets[0].x;
    tickTrainState(assets, trainState);
    assert.ok(assets[0].x > engineXBefore, 'engine must move right');
  });

  test('arriving snaps to docked positions and transitions to docked when engine reaches home', () => {
    const { assets, trainState } = makeMockTrain();
    trainState.phase = 'arriving';
    for (let i = 0; i < assets.length; i++) {
      assets[i].x = trainState.dockedX[i] - TRAIN_SPEED + 0.1;
    }
    tickTrainState(assets, trainState);
    assert.equal(trainState.phase, 'docked');
    assert.ok(
      trainState.ticksLeft >= DOCKED_TICKS_MIN && trainState.ticksLeft <= DOCKED_TICKS_MAX,
      `ticksLeft ${trainState.ticksLeft} out of range [${DOCKED_TICKS_MIN}, ${DOCKED_TICKS_MAX}]`,
    );
    assert.equal(assets[0].x, trainState.dockedX[0], 'engine should snap to docked x');
  });

  test('tags persist on train assets through offscreen phase', () => {
    const { assets, trainState } = makeMockTrain();
    trainState.phase = 'offscreen';
    trainState.ticksLeft = 1;
    assets[1].ownerId = 'p1';
    assets[1].ownerColor = '#FF0000';
    for (let i = 0; i < assets.length; i++) assets[i].x = trainState.dockedX[i] + (-60);
    tickTrainState(assets, trainState);
    assert.equal(assets[1].ownerId, 'p1');
    assert.equal(assets[1].ownerColor, '#FF0000');
  });
});

describe('pushPlayersFromTrain', () => {
  test('player overlapping an on-screen train piece is pushed below it', () => {
    const { assets, trainState } = makeMockTrain();
    // Player standing on the tracks at docked position
    const player = { x: 5, y: 10, pendingX: 5, pendingY: 10 };
    const room = { assets, trainState, players: new Map([['p1', player]]) };
    pushPlayersFromTrain(room);
    // Train engine is at y=8, h=6 → player should be pushed to y=14
    assert.equal(player.y, 14);
    assert.equal(player.pendingY, 14);
  });

  test('player NOT overlapping train is unaffected', () => {
    const { assets, trainState } = makeMockTrain();
    const player = { x: 50, y: 50, pendingX: 50, pendingY: 50 };
    const room = { assets, trainState, players: new Map([['p1', player]]) };
    pushPlayersFromTrain(room);
    assert.equal(player.y, 50);
  });

  test('off-screen train pieces do not push players', () => {
    const { assets, trainState } = makeMockTrain();
    // Move all train assets off-screen
    for (const a of assets) a.x = -70;
    const player = { x: 5, y: 10, pendingX: 5, pendingY: 10 };
    const room = { assets, trainState, players: new Map([['p1', player]]) };
    pushPlayersFromTrain(room);
    assert.equal(player.y, 10); // untouched
  });
});
