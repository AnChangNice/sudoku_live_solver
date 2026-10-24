import test from 'node:test';
import assert from 'node:assert/strict';
import { refineGridLines, verifyWarpLines } from '../src/vision/warp.js';

const SIZE = 900;

function emptyImage() {
  return new Uint8Array(SIZE * SIZE);
}

function drawVertical(bin, x, thickness = 3) {
  for (let y = 0; y < SIZE; y++) {
    for (let d = 0; d < thickness; d++) {
      const xx = x + d;
      if (xx >= 0 && xx < SIZE) bin[y * SIZE + xx] = 255;
    }
  }
}

function drawHorizontal(bin, y, thickness = 3) {
  for (let x = 0; x < SIZE; x++) {
    for (let d = 0; d < thickness; d++) {
      const yy = y + d;
      if (yy >= 0 && yy < SIZE) bin[yy * SIZE + x] = 255;
    }
  }
}

/** 在整个 warp 里画一张 9×9 网格；margin 即四边形比真实格线大出来的部分。 */
function drawGrid(bin, margin, { boldOnly = false } = {}) {
  const span = SIZE - 2 * margin;
  for (let i = 0; i <= 9; i++) {
    const p = Math.round(margin + (span * i) / 9);
    const bold = i % 3 === 0;
    if (boldOnly && !bold) continue;
    drawVertical(bin, p, bold ? 6 : 2);
    drawHorizontal(bin, p, bold ? 6 : 2);
  }
}

test('完整九宫格通过格线校验', () => {
  const bin = emptyImage();
  drawGrid(bin, 0);
  const v = verifyWarpLines(bin, SIZE);
  assert.equal(v.pass, true);
  assert.equal(v.mode, 'full');
});

test('细格线消失、只剩粗格线时仍能通过（手机屏幕）', () => {
  const bin = emptyImage();
  drawGrid(bin, 0, { boldOnly: true });
  const v = verifyWarpLines(bin, SIZE);
  assert.equal(v.pass, true);
  assert.equal(v.mode, 'bold');
  assert.ok(v.boldShift < 3, `粗格线偏移 ${v.boldShift.toFixed(1)}px`);
});

test('略松的四边形（格线缩进 1%）仍通过', () => {
  const bin = emptyImage();
  drawGrid(bin, SIZE * 0.01);
  const v = verifyWarpLines(bin, SIZE);
  assert.equal(v.pass, true);
});

test('整块屏幕外框（格线缩进 5%）不能通过', () => {
  const bin = emptyImage();
  // 锁定到比九宫格大一圈的四边形时，格线会被透视到 1/3、2/3 之外；
  // 这类四边形必须被拒绝，否则答案会按屏幕外框投影、铺满整屏。
  drawGrid(bin, SIZE * 0.05);
  const v = verifyWarpLines(bin, SIZE);
  assert.equal(v.pass, false);
  assert.ok(v.boldShift > 7, `粗格线偏移 ${v.boldShift.toFixed(1)}px`);
});

test('格线位置与等分不一致时能测出真实位置', () => {
  const bin = emptyImage();
  // 间距 98、起点 6：内部 8 条线与 100/200/... 的等分分别差 +4 ~ -12px。
  const xs = [6, 104, 202, 300, 398, 496, 594, 692, 790, 888];
  const ys = xs.map((v) => v);
  for (const x of xs) drawVertical(bin, x);
  for (const y of ys) drawHorizontal(bin, y);

  const lines = refineGridLines(bin, SIZE);
  assert.equal(lines.refined, true);
  for (let k = 0; k <= 9; k++) {
    assert.ok(
      Math.abs(lines.xs[k] - xs[k]) < 3,
      `竖线 ${k}: ${lines.xs[k].toFixed(1)} vs ${xs[k]}`,
    );
    assert.ok(
      Math.abs(lines.ys[k] - ys[k]) < 3,
      `横线 ${k}: ${lines.ys[k].toFixed(1)} vs ${ys[k]}`,
    );
  }
});

test('没有格线时退回等分', () => {
  const bin = emptyImage();
  const lines = refineGridLines(bin, SIZE);
  assert.equal(lines.refined, false);
  for (let k = 0; k <= 9; k++) {
    assert.equal(lines.xs[k], (k * SIZE) / 9);
    assert.equal(lines.ys[k], (k * SIZE) / 9);
  }
});

test('只有部分格线时用线性拟合补出外框', () => {
  const bin = emptyImage();
  // 只画内部 6 条竖线/横线（其余被数字或反光打断），外框靠拟合。
  const xs = [4, 102, 200, 298, 398, 0, 598, 698, 796, 894];
  const valid = xs.map((v, k) => ({ v, k })).filter((p) => p.v > 0);
  for (const p of valid) drawVertical(bin, p.v);
  // 只画横线的 6 条内部线，保证 refined 仍能成立
  for (const p of valid) drawHorizontal(bin, p.v);

  const lines = refineGridLines(bin, SIZE);
  assert.equal(lines.refined, true);
  for (const p of valid) {
    assert.ok(
      Math.abs(lines.xs[p.k] - p.v) < 3,
      `竖线 ${p.k}: ${lines.xs[p.k].toFixed(1)} vs ${p.v}`,
    );
  }
  // 外框按 6 个点的线性趋势外推，应接近 4 / 894
  assert.ok(Math.abs(lines.xs[0] - 4) < 6, `左外框 ${lines.xs[0].toFixed(1)}`);
  assert.ok(Math.abs(lines.xs[9] - 894) < 6, `右外框 ${lines.xs[9].toFixed(1)}`);
});
