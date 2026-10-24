import test from 'node:test';
import assert from 'node:assert/strict';
import {
  solve,
  parsePuzzle,
  formatPuzzle,
  findConflicts,
} from '../src/solver.js';

const EASY =
  '530070000600195000098000060800060003400803001700020006060000280000419005000080079';
const EASY_SOLUTION =
  '534678912672195348198342567859761423426853791713924856961537284287419635345286179';

test('求解标准题并得到唯一解', () => {
  const grid = parsePuzzle(EASY);
  const result = solve(grid);
  assert.equal(result.status, 'solved');
  assert.equal(result.solutions, 1);
  assert.equal(formatPuzzle(result.solution), EASY_SOLUTION);
  assert.equal(result.conflicts.length, 0);
});

test('求解结果自身合法且不覆盖已知格', () => {
  const grid = parsePuzzle(EASY);
  const result = solve(grid);
  for (let i = 0; i < 81; i++) {
    if (grid[i]) assert.equal(result.solution[i], grid[i]);
  }
  assert.deepEqual(findConflicts(result.solution), []);
});

test('冲突盘面返回 invalid 并定位冲突格', () => {
  const grid = new Uint8Array(81);
  grid[0] = 5;
  grid[1] = 5;
  const result = solve(grid);
  assert.equal(result.status, 'invalid');
  assert.equal(result.solution, null);
  assert.deepEqual([...result.conflicts].sort((a, b) => a - b), [0, 1]);
});

test('无候选的空格导致 unsolvable', () => {
  const grid = new Uint8Array(81);
  for (let c = 1; c <= 8; c++) grid[c] = c;
  grid[9] = 9; // (1,0) 放进 9，使 (0,0) 行/列/宫覆盖 1-9
  const result = solve(grid);
  assert.equal(result.status, 'unsolvable');
  assert.equal(result.solution, null);
  assert.equal(result.conflicts.length, 0);
});

test('空盘多解检测在第二解处停止', () => {
  const result = solve(new Uint8Array(81), { maxSolutions: 2 });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.solutions, 2);
  assert.ok(result.solution);
});

test('节点上限返回 limit', () => {
  const result = solve(new Uint8Array(81), {
    maxSolutions: 2,
    nodeLimit: 5,
  });
  assert.equal(result.status, 'limit');
});

test('parsePuzzle / formatPuzzle 输入语义', () => {
  const grid = parsePuzzle('1.2X3'.padEnd(81, '.'));
  assert.equal(grid[0], 1);
  assert.equal(grid[1], 0);
  assert.equal(grid[2], 2);
  assert.equal(grid[3], 0);
  assert.equal(grid[4], 3);
  assert.equal(formatPuzzle(grid).slice(0, 5), '1.2.3');
  assert.throws(() => parsePuzzle('123'));
});

test('难题求解在 50ms 以内', () => {
  const hard =
    '..............3.85..1.2.......5.7.....4...1...9.......5......73..2.1........4...9';
  const result = solve(parsePuzzle(hard), { maxSolutions: 1 });
  assert.ok(['solved', 'unsolvable'].includes(result.status));
  assert.ok(result.ms < 50, `耗时 ${result.ms}ms`);
});
