import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadStabilizer } from '../src/vision/stable-read.js';

function grid(values) {
  const out = new Uint8Array(81);
  for (const [i, v] of values) out[i] = v;
  return out;
}

function details(fill, overrides = {}) {
  const out = Array.from({ length: 81 }, () => fill);
  for (const [i, d] of Object.entries(overrides)) out[i] = d;
  return out;
}

const digit = (value, score = 0.95, margin = 0.4) => ({
  kind: 'digit',
  value,
  score,
  margin,
});
const blank = () => ({ kind: 'blank', value: 0 });
const unknown = () => ({ kind: 'unknown', value: 0 });

test('第一份读数直接采纳', () => {
  const s = new ReadStabilizer();
  const res = s.apply(
    grid([[0, 4], [1, 7]]),
    details(blank(), { 0: digit(4), 1: digit(7) }),
  );
  assert.equal(res.grid[0], 4);
  assert.equal(res.grid[1], 7);
  assert.equal(res.unknown[3], 0);
});

test('单次翻转不生效，连续两次读到同一个值才采纳', () => {
  const s = new ReadStabilizer();
  s.apply(grid([[0, 4]]), details(blank(), { 0: digit(4) }));

  // 一次读成 2：保持 4，答案不跳
  let res = s.apply(grid([[0, 2]]), details(blank(), { 0: digit(2) }));
  assert.equal(res.grid[0], 4);

  // 再读一次还是 2：两次一致，采纳
  res = s.apply(grid([[0, 2]]), details(blank(), { 0: digit(2) }));
  assert.equal(res.grid[0], 2);

  // 又变回 4：同样要两次
  res = s.apply(grid([[0, 4]]), details(blank(), { 0: digit(4) }));
  assert.equal(res.grid[0], 2);
});

test('中途回到已确认值时，待确认的翻转作废', () => {
  const s = new ReadStabilizer();
  s.apply(grid([[0, 4]]), details(blank(), { 0: digit(4) }));
  s.apply(grid([[0, 2]]), details(blank(), { 0: digit(2) }));
  s.apply(grid([[0, 4]]), details(blank(), { 0: digit(4) }));
  // 再出现一次 2 不应算作“连续两次”
  const res = s.apply(grid([[0, 2]]), details(blank(), { 0: digit(2) }));
  assert.equal(res.grid[0], 4);
});

test('这次没认出来不会抹掉已确认的数字，也不弹待确认', () => {
  const s = new ReadStabilizer();
  s.apply(grid([[0, 4]]), details(blank(), { 0: digit(4) }));
  const res = s.apply(
    grid([[0, 0]]),
    details(blank(), { 0: unknown() }),
  );
  assert.equal(res.grid[0], 4);
  assert.equal(res.unknown[0], 0);
});

test('空格从未确认过时，认不出来仍标待确认', () => {
  const s = new ReadStabilizer();
  s.apply(grid([]), details(blank()));
  const res = s.apply(grid([]), details(blank(), { 5: unknown() }));
  assert.equal(res.unknown[5], 1);
});

test('空 → 高置信数字直接采纳，低置信要两次', () => {
  const s = new ReadStabilizer();
  s.apply(grid([]), details(blank()));

  let res = s.apply(
    grid([[0, 6]]),
    details(blank(), { 0: digit(6, 0.9, 0.3) }),
  );
  assert.equal(res.grid[0], 6);

  res = s.apply(
    grid([[1, 6]]),
    details(blank(), { 1: digit(6, 0.5, 0.05) }),
  );
  assert.equal(res.grid[1], 0, '低置信读数先不采纳');
  res = s.apply(
    grid([[1, 6]]),
    details(blank(), { 1: digit(6, 0.5, 0.05) }),
  );
  assert.equal(res.grid[1], 6);
});

test('reset 后重新从第一份读数开始', () => {
  const s = new ReadStabilizer();
  s.apply(grid([[0, 4]]), details(blank(), { 0: digit(4) }));
  s.reset();
  const res = s.apply(grid([[0, 2]]), details(blank(), { 0: digit(2) }));
  assert.equal(res.grid[0], 2);
});
