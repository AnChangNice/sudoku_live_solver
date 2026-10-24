import test from 'node:test';
import assert from 'node:assert/strict';
import {
  solveHomography,
  applyH,
  composeH,
  invertH,
  orderCorners,
  cornerDistance,
  displayMatrix,
} from '../src/render/homography.js';

const SQUARE = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

const QUAD = [
  { x: 20, y: 10 },
  { x: 220, y: 30 },
  { x: 200, y: 240 },
  { x: 10, y: 200 },
];

test('单位单应矩阵', () => {
  const H = solveHomography(SQUARE, SQUARE);
  const p = applyH(H, 37, 71);
  assert.ok(Math.abs(p.x - 37) < 1e-9);
  assert.ok(Math.abs(p.y - 71) < 1e-9);
});

test('四点映射精确命中角点', () => {
  const H = solveHomography(SQUARE, QUAD);
  for (let i = 0; i < 4; i++) {
    const p = applyH(H, SQUARE[i].x, SQUARE[i].y);
    assert.ok(Math.abs(p.x - QUAD[i].x) < 1e-6, `x ${i}`);
    assert.ok(Math.abs(p.y - QUAD[i].y) < 1e-6, `y ${i}`);
  }
});

test('逆矩阵往返', () => {
  const H = solveHomography(SQUARE, QUAD);
  const inv = invertH(H);
  const p = applyH(H, 40, 65);
  const q = applyH(inv, p.x, p.y);
  assert.ok(Math.abs(q.x - 40) < 1e-6);
  assert.ok(Math.abs(q.y - 65) < 1e-6);
});

test('复合矩阵等价于依次应用', () => {
  const A = solveHomography(SQUARE, QUAD);
  const B = [2, 0, 5, 0, 2, 7, 0, 0, 1];
  const C = composeH(A, B);
  const p1 = applyH(B, 11, 22);
  const p2 = applyH(A, p1.x, p1.y);
  const p3 = applyH(C, 11, 22);
  assert.ok(Math.abs(p2.x - p3.x) < 1e-9);
  assert.ok(Math.abs(p2.y - p3.y) < 1e-9);
});

test('角点排序对旋转鲁棒', () => {
  const rotated = [
    { x: 100, y: 100 },
    { x: 0, y: 100 },
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ];
  const ordered = orderCorners(rotated);
  assert.deepEqual(ordered[0], { x: 0, y: 0 });
  assert.deepEqual(ordered[1], { x: 100, y: 0 });
  assert.deepEqual(ordered[2], { x: 100, y: 100 });
  assert.deepEqual(ordered[3], { x: 0, y: 100 });
});

test('角点距离与显示变换', () => {
  assert.equal(cornerDistance(SQUARE, SQUARE), 0);
  const cover = displayMatrix(1000, 500, 400, 400, 'cover');
  assert.equal(cover[0], 0.8);
  assert.equal(cover[2], -200);
  assert.equal(cover[5], 0);

  const contain = displayMatrix(1000, 500, 400, 400, 'contain');
  assert.equal(contain[0], 0.4);
  assert.equal(contain[2], 0);
  assert.equal(contain[5], 100);
});
