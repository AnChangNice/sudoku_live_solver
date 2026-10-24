import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readCells,
  normalizeGlyph,
  bilinear,
  WARP_SIZE,
} from '../src/vision/cells.js';

function blankWarp() {
  return new Uint8Array(WARP_SIZE * WARP_SIZE).fill(255);
}

function paintRect(gray, x0, y0, w, h, value = 0) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      gray[y * WARP_SIZE + x] = value;
    }
  }
}

test('空白网格全部判空', () => {
  const cells = readCells(blankWarp(), WARP_SIZE, WARP_SIZE);
  assert.equal(cells.length, 81);
  assert.ok(cells.every((c) => c.kind === 'blank'));
});

test('格内墨迹被识别为字形并归一化', () => {
  const gray = blankWarp();
  // 第 0 格（内缩 11 后约 11..88）画一个 40x50 的“数字”
  paintRect(gray, 31, 24, 40, 52, 0);
  const cells = readCells(gray, WARP_SIZE, WARP_SIZE);
  assert.equal(cells[0].kind, 'glyph');
  assert.ok(cells[0].vec);
  assert.equal(cells[0].vec.length, 28 * 28);

  let mean = 0;
  let norm = 0;
  for (const v of cells[0].vec) {
    mean += v;
    norm += v * v;
  }
  assert.ok(Math.abs(mean) < 1e-4);
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-4);

  // 其余格仍为空白
  assert.ok(cells.slice(1).every((c) => c.kind === 'blank'));
});

test('贴边墨迹（残留格线）判空，不让用户确认一个空格', () => {
  const gray = blankWarp();
  // 在格子的内缩边界附近画一条粗线，模拟残留格线
  paintRect(gray, 12, 12, 76, 4, 0);
  const cells = readCells(gray, WARP_SIZE, WARP_SIZE);
  assert.equal(cells[0].kind, 'blank');
});

test('手机边框的阴影（沿两条格边）判空', () => {
  const gray = blankWarp();
  // 左边缘一条 20px 宽的黑影，同时贴住上、下边界：以前会被当成“1”。
  // 故意离边界 4px（不被“贴边墨迹”那条规则先丢掉），验证的是位置规则。
  paintRect(gray, 17, 17, 20, 67, 0);
  const cells = readCells(gray, WARP_SIZE, WARP_SIZE);
  assert.equal(cells[0].kind, 'blank');
});

test('只贴住一侧的大数字仍算字形（小屏上数字离格线很近）', () => {
  const gray = blankWarp();
  // 贴住下边界 5px、左右都有余量：小分辨率屏幕照片里的真实数字就是这样。
  paintRect(gray, 33, 24, 42, 58, 0);
  const cells = readCells(gray, WARP_SIZE, WARP_SIZE);
  assert.equal(cells[0].kind, 'glyph');
});

test('格内小墨点（屏幕噪点）判空，不会被当成数字', () => {
  const gray = blankWarp();
  // 10x10 的孤立墨点：真实数字的墨量远不止这些
  paintRect(gray, 40, 35, 10, 10, 40);
  const cells = readCells(gray, WARP_SIZE, WARP_SIZE);
  assert.equal(cells[0].kind, 'blank');
});

test('横贯格的条带（摩尔纹/格线残留）判空', () => {
  const gray = blankWarp();
  // 远离内缩边界、宽 40 高 4 的横条：不是任何数字的形状
  paintRect(gray, 30, 40, 40, 4, 60);
  const cells = readCells(gray, WARP_SIZE, WARP_SIZE);
  assert.equal(cells[0].kind, 'blank');
});

test('低对比纹理（屏幕摩尔纹）判空', () => {
  const gray = blankWarp();
  // 在格内铺 190..225 的确定性噪声：std 足够大，Otsu 一定把格子劈成两类，
  // 但两类均值只差约 20 级——这是纹理，不是数字。
  let seed = 12345;
  for (let y = 13; y < 87; y++) {
    for (let x = 13; x < 87; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      gray[y * WARP_SIZE + x] = 190 + (seed % 36);
    }
  }
  const cells = readCells(gray, WARP_SIZE, WARP_SIZE);
  assert.equal(cells[0].kind, 'blank');
  assert.ok(cells[0].contrast < 26, `contrast=${cells[0].contrast}`);
});

test('1px 细线纹理判空（腐蚀后没有笔画核心）', () => {
  const gray = blankWarp();
  // 每 4px 一条 1px 细线：对比度很高，但没有任何一处能经住 4 邻域腐蚀
  for (let y = 20; y < 80; y += 4) paintRect(gray, 20, y, 60, 1, 0);
  const cells = readCells(gray, WARP_SIZE, WARP_SIZE);
  assert.equal(cells[0].kind, 'blank');
});

test('淡字（约 100 级对比度）仍识别为字形', () => {
  const gray = blankWarp();
  paintRect(gray, 31, 24, 40, 52, 150);
  const cells = readCells(gray, WARP_SIZE, WARP_SIZE);
  assert.equal(cells[0].kind, 'glyph');
  assert.ok(cells[0].contrast > 90);
});

test('深底白字会先反相再识别', () => {
  const gray = new Uint8Array(WARP_SIZE * WARP_SIZE).fill(20);
  paintRect(gray, 31, 24, 40, 52, 240);
  const cells = readCells(gray, WARP_SIZE, WARP_SIZE);
  assert.equal(cells[0].kind, 'glyph');
  assert.ok(cells[0].vec);
});

test('bilinear 边界与插值', () => {
  const pixels = new Uint8Array([0, 100, 200, 250]);
  assert.equal(bilinear(pixels, 2, 2, 0, 0), 0);
  assert.equal(bilinear(pixels, 2, 2, 1, 1), 250);
  assert.ok(Math.abs(bilinear(pixels, 2, 2, 0.5, 0.5) - 137.5) < 1e-6);
});

test('normalizeGlyph 对纯白输入返回 null', () => {
  const flat = new Uint8Array(100).fill(255);
  const vec = normalizeGlyph(flat, 10, 10, { x: 0, y: 0, w: 10, h: 10 });
  assert.equal(vec, null);
});
