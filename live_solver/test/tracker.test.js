import test from 'node:test';
import assert from 'node:assert/strict';
import { GridTracker, QuadKalman } from '../src/vision/tracker.js';
import { cornerDistance } from '../src/render/homography.js';

const DIAGONAL = 1000;
const GRID = [
  { x: 100, y: 100 },
  { x: 300, y: 100 },
  { x: 300, y: 300 },
  { x: 100, y: 300 },
];
// 手机 App 的内容区（标题 + 九宫格）：上边缘越过标题栏，
// 平均角点距离约 4.5% 对角线 —— 落在“不算跳变、但也不是同一块题”的
// 危险区间，正是跟踪器以前会滑过去的地方。
const CONTENT = [
  { x: 100, y: 20 },
  { x: 300, y: 20 },
  { x: 300, y: 290 },
  { x: 100, y: 290 },
];

// 更近的一种内容区：只比九宫格高出一点（角点平均只偏 2%），
// 光看距离很难区分，但面积大了 20%。
const NEAR_CONTENT = [
  { x: 100, y: 80 },
  { x: 300, y: 80 },
  { x: 300, y: 320 },
  { x: 100, y: 320 },
];

function lockOn(tracker, points, frames = 4) {
  let state = null;
  for (let i = 0; i < frames; i++) {
    state = tracker.update([{ points, area: 40000 }], DIAGONAL);
  }
  return state;
}

// 带显式时间戳的锁定：返回下一次更新的时间（毫秒）。
// 预测相关的用例必须用一致的时间轴，不能混用 performance.now()。
function lockOnAt(tracker, points, t0 = 0, frames = 4, dt = 1000 / 30) {
  let ts = t0;
  for (let i = 0; i < frames; i++) {
    tracker.update([{ points, area: 40000 }], DIAGONAL, ts);
    ts += dt;
  }
  return ts;
}

test('连续多帧一致后锁定', () => {
  const t = new GridTracker();
  const state = lockOn(t, GRID);
  assert.equal(state.locked, true);
  assert.ok(cornerDistance(state.quad, GRID) < 1);
});

test('九宫格候选消失时不漂到旁边更大的四边形上', () => {
  const t = new GridTracker();
  lockOn(t, GRID);

  // 之后几帧只剩内容区候选：跟踪框必须停在原来的九宫格上，
  // 答案才不会整体上移到标题栏。
  for (let i = 0; i < 6; i++) {
    const state = t.update([{ points: CONTENT, area: 62000 }], DIAGONAL);
    assert.equal(state.locked, true);
    assert.ok(
      cornerDistance(state.quad, GRID) < 1,
      `第 ${i} 帧跟踪框漂移了 ${cornerDistance(state.quad, GRID).toFixed(1)}px`,
    );
  }
});

test('邻近但面积明显不同的候选（标题 + 九宫格）不会被跟随', () => {
  const t = new GridTracker();
  lockOn(t, GRID);

  for (let i = 0; i < 6; i++) {
    const state = t.update([{ points: NEAR_CONTENT, area: 48000 }], DIAGONAL);
    assert.equal(state.locked, true);
    assert.ok(
      cornerDistance(state.quad, GRID) < 1,
      `第 ${i} 帧跟踪框漂移了 ${cornerDistance(state.quad, GRID).toFixed(1)}px`,
    );
  }
});

test('比九宫格整体大 3.7% 的候选（屏幕外框）不会被跟随', () => {
  const t = new GridTracker();
  lockOn(t, GRID);
  // 外框和九宫格同心、只大一圈：角点平均只偏 0.5% 对角线，
  // 面积只差 7.5%，旧门槛拦不住，答案会被带偏半格。
  const cx = 200;
  const cy = 200;
  const outer = GRID.map((p) => ({
    x: cx + (p.x - cx) * 1.037,
    y: cy + (p.y - cy) * 1.037,
  }));

  for (let i = 0; i < 6; i++) {
    const state = t.update([{ points: outer, area: 43000 }], DIAGONAL);
    assert.equal(state.locked, true);
    assert.ok(
      cornerDistance(state.quad, GRID) < 1,
      `第 ${i} 帧跟随到了外框，偏移 ${cornerDistance(state.quad, GRID).toFixed(1)}px`,
    );
  }
});

test('目标长期丢失后解锁', () => {
  const t = new GridTracker();
  lockOn(t, GRID);
  let state = t.update([{ points: CONTENT, area: 62000 }], DIAGONAL);
  for (let i = 0; i < 20 && state.locked; i++) {
    state = t.update([{ points: CONTENT, area: 62000 }], DIAGONAL);
  }
  assert.equal(state.locked, false);
  assert.equal(state.quad, null);
});

test('小幅移动持续跟随', () => {
  const t = new GridTracker();
  lockOn(t, GRID);

  let moved = GRID.map((p) => ({ ...p }));
  for (let i = 0; i < 8; i++) {
    moved = moved.map((p) => ({ x: p.x + 8, y: p.y }));
    const state = t.update([{ points: moved, area: 40000 }], DIAGONAL);
    assert.equal(state.locked, true);
  }
  assert.ok(cornerDistance(t.quad, moved) < 30);
});

test('较快的转动/平移（每帧 5% 对角线）不会冻结', () => {
  const t = new GridTracker();
  let ts = lockOnAt(t, GRID);
  let moved = GRID.map((p) => ({ ...p }));

  for (let i = 0; i < 8; i++) {
    // 50,25 px ≈ 每帧 5.6% 对角线。旧版 3.5% 的距离门槛会把整帧丢掉，
    // 叠加先冻住，等解锁重锁后才跳过去——手持转动时就是“跟踪很慢”。
    moved = moved.map((p) => ({ x: p.x + 50, y: p.y + 25 }));
    const state = t.update([{ points: moved, area: 40000 }], DIAGONAL, ts);
    ts += 1000 / 30;
    assert.equal(state.locked, true);
    assert.ok(
      cornerDistance(state.quad, moved) < 10,
      `第 ${i} 帧跟踪框落后 ${cornerDistance(state.quad, moved).toFixed(1)}px`,
    );
  }
});

test('运动中间丢一帧也不会被当成跳变冻住', () => {
  const t = new GridTracker();
  const dt = 1000 / 30;
  let ts = lockOnAt(t, GRID);
  const at = (x) => GRID.map((p) => ({ x: p.x + x, y: p.y }));

  // 先匀速走几帧，把速度估计建立起来
  let x = 0;
  for (let i = 0; i < 6; i++) {
    x += 50;
    t.update([{ points: at(x), area: 40000 }], DIAGONAL, ts);
    ts += dt;
  }

  // 丢一帧：隔两个检测周期才给下一帧，累计位移 100px（10% 对角线）。
  // 按上一帧位置比较会超过距离门槛并判定为“跳变”，用外推位置则不会。
  ts += dt;
  x += 100;
  const state = t.update([{ points: at(x), area: 40000 }], DIAGONAL, ts);
  assert.equal(state.locked, true);
  assert.ok(
    cornerDistance(state.quad, at(x)) < 3,
    `丢帧后跟踪框偏差 ${cornerDistance(state.quad, at(x)).toFixed(1)}px`,
  );
});

test('两次检测之间按速度外推，补偿处理延迟', () => {
  const t = new GridTracker();
  let ts = lockOnAt(t, GRID);
  const dt = 1000 / 30;
  const at = (x) => GRID.map((p) => ({ x: p.x + x, y: p.y }));

  let x = 0;
  for (let i = 0; i < 10; i++) {
    x += 600 * (dt / 1000); // 600 px/s 匀速平移
    t.update([{ points: at(x), area: 40000 }], DIAGONAL, ts);
    ts += dt;
  }

  const nextX = x + 600 * (dt / 1000);
  const pred = t.predict(ts);
  assert.ok(pred, '锁定且运动时应返回预测四边形');
  assert.ok(
    cornerDistance(pred, at(nextX)) < 1,
    `预测误差 ${cornerDistance(pred, at(nextX)).toFixed(1)}px`,
  );
  assert.ok(
    cornerDistance(t.quad, at(nextX)) > 10,
    '不预测时旧框应明显落后于下一帧的真实位置',
  );
});

test('静止时不做外推，避免被噪声带着漂', () => {
  const t = new GridTracker();
  let ts = lockOnAt(t, GRID);
  for (let i = 0; i < 6; i++) {
    t.update([{ points: GRID, area: 40000 }], DIAGONAL, ts);
    ts += 1000 / 30;
  }
  const pred = t.predict(ts + 500);
  assert.ok(pred);
  assert.ok(cornerDistance(pred, GRID) < 0.5);
});

test('卡尔曼滤波：静止时压低角点抖动', () => {
  const f = new QuadKalman({
    measSigma: 2,
    accelSigma: 40,
    nominalDt: 1 / 30,
    maxDt: 0.25,
  });
  f.reset(GRID, 0);
  let t = 0;
  let rawErr = 0;
  let outErr = 0;
  const n = 200;
  // 固定随机序列：Math.random 偶尔会抽到让“滤波后/原始”比值超过
  // 阈值的样本（约 3%），单测因此偶发失败。噪声本身没有随机性需求。
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < n; i++) {
    t += 33.3;
    // 单帧检测抖动 ±4px，像素噪声
    const nx = (rand() * 2 - 1) * 4;
    const ny = (rand() * 2 - 1) * 4;
    const noisy = GRID.map((p) => ({ x: p.x + nx, y: p.y + ny }));
    const out = f.update(noisy, t);
    if (i > 60) {
      rawErr += cornerDistance(noisy, GRID);
      outErr += cornerDistance(out, GRID);
    }
  }
  assert.ok(
    outErr < rawErr * 0.6,
    `滤波后抖动 ${(outErr / rawErr).toFixed(2)}×，应明显小于 1`,
  );
});

test('卡尔曼滤波：匀速平移不滞后', () => {
  const f = new QuadKalman({
    measSigma: 2,
    accelSigma: 40,
    nominalDt: 1 / 30,
    maxDt: 0.25,
  });
  f.reset(GRID, 0);
  let t = 0;
  let lag = 0;
  for (let i = 1; i <= 20; i++) {
    const moved = GRID.map((p) => ({ x: p.x + i * 10, y: p.y }));
    t += 33.3;
    lag = cornerDistance(f.update(moved, t), moved);
  }
  // 固定 EMA(0.35) 在同样速度下会稳定落后 18px
  assert.ok(lag < 5, `匀速移动时跟踪框落后 ${lag.toFixed(1)}px`);
});

test('明显跳变（换了一块题）快速解锁', () => {
  const t = new GridTracker();
  lockOn(t, GRID);
  const far = GRID.map((p) => ({ x: p.x + 200, y: p.y + 120 }));
  let state = null;
  for (let i = 0; i < 3; i++) {
    state = t.update([{ points: far, area: 40000 }], DIAGONAL);
  }
  assert.equal(state.locked, false);
});
