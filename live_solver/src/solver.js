// 数独求解器：位掩码 + MRV（最少候选优先）+ 回溯。
// 语义对齐 c/solver.c：1-9 为已知数字，其它字符视为空格。

export const FULL = 0x1ff;

const POPCOUNT = new Uint8Array(512);
for (let i = 1; i < 512; i++) POPCOUNT[i] = POPCOUNT[i >> 1] + (i & 1);

const now = () =>
  typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();

/** 把 81 字符串解析成 Uint8Array，非 1-9 一律为 0。 */
export function parsePuzzle(str) {
  if (typeof str !== 'string' || str.length !== 81) {
    throw new Error('题目必须是 81 个字符');
  }
  const grid = new Uint8Array(81);
  for (let i = 0; i < 81; i++) {
    const c = str.charCodeAt(i);
    grid[i] = c >= 49 && c <= 57 ? c - 48 : 0;
  }
  return grid;
}

/** 转成 81 字符串，0 输出为 '.'。 */
export function formatPuzzle(grid) {
  let s = '';
  for (let i = 0; i < 81; i++) s += grid[i] ? String(grid[i]) : '.';
  return s;
}

const ROW = (i) => (i / 9) | 0;
const COL = (i) => i % 9;
const BOX = (i) => (((i / 27) | 0) * 3) + (((i % 9) / 3) | 0);

/** 返回所有处于冲突中的格子下标（行/列/宫重复）。 */
export function findConflicts(values) {
  const bad = new Set();
  const visit = (indexes) => {
    const seen = new Map();
    for (const idx of indexes) {
      const v = values[idx];
      if (!v) continue;
      if (seen.has(v)) {
        bad.add(idx);
        bad.add(seen.get(v));
      } else {
        seen.set(v, idx);
      }
    }
  };
  for (let r = 0; r < 9; r++) {
    const row = [];
    for (let c = 0; c < 9; c++) row.push(r * 9 + c);
    visit(row);
  }
  for (let c = 0; c < 9; c++) {
    const col = [];
    for (let r = 0; r < 9; r++) col.push(r * 9 + c);
    visit(col);
  }
  for (let br = 0; br < 3; br++) {
    for (let bc = 0; bc < 3; bc++) {
      const box = [];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) box.push((br * 3 + r) * 9 + bc * 3 + c);
      }
      visit(box);
    }
  }
  return [...bad].sort((a, b) => a - b);
}

/**
 * 求解。
 * @param {ArrayLike<number>} values 81 个 0-9
 * @param {{maxSolutions?: number, nodeLimit?: number}} opts
 * @returns {{status: 'solved'|'invalid'|'unsolvable'|'ambiguous'|'limit',
 *            solution: Uint8Array|null, solutions: number,
 *            conflicts: number[], nodes: number, ms: number}}
 */
export function solve(values, opts = {}) {
  const maxSolutions = opts.maxSolutions ?? 2;
  const nodeLimit = opts.nodeLimit ?? 500000;
  const t0 = now();

  const grid = Uint8Array.from(values);
  const rowMask = new Int32Array(9);
  const colMask = new Int32Array(9);
  const boxMask = new Int32Array(9);

  for (let i = 0; i < 81; i++) {
    const v = grid[i];
    if (!v) continue;
    const bit = 1 << (v - 1);
    const r = ROW(i);
    const c = COL(i);
    const b = BOX(i);
    rowMask[r] |= bit;
    colMask[c] |= bit;
    boxMask[b] |= bit;
  }

  const conflicts = findConflicts(grid);
  if (conflicts.length) {
    return {
      status: 'invalid',
      solution: null,
      solutions: 0,
      conflicts,
      nodes: 0,
      ms: now() - t0,
    };
  }

  const solutions = [];
  let nodes = 0;
  let hitLimit = false;

  const search = () => {
    if (solutions.length >= maxSolutions || hitLimit) return true;

    nodes++;
    if (nodes > nodeLimit) {
      hitLimit = true;
      return true;
    }

    // MRV：选候选最少的空格
    let bestIdx = -1;
    let bestMask = 0;
    let bestCount = 10;
    for (let i = 0; i < 81; i++) {
      if (grid[i]) continue;
      const mask =
        FULL & ~(rowMask[ROW(i)] | colMask[COL(i)] | boxMask[BOX(i)]);
      if (mask === 0) return false; // 死路
      const count = POPCOUNT[mask];
      if (count < bestCount) {
        bestCount = count;
        bestIdx = i;
        bestMask = mask;
        if (count === 1) break;
      }
    }

    if (bestIdx === -1) {
      solutions.push(Uint8Array.from(grid));
      return solutions.length >= maxSolutions;
    }

    const r = ROW(bestIdx);
    const c = COL(bestIdx);
    const b = BOX(bestIdx);
    let mask = bestMask;
    while (mask) {
      const bit = mask & -mask;
      mask ^= bit;
      const value = 31 - Math.clz32(bit) + 1;

      grid[bestIdx] = value;
      rowMask[r] |= bit;
      colMask[c] |= bit;
      boxMask[b] |= bit;

      const stop = search();

      grid[bestIdx] = 0;
      rowMask[r] &= ~bit;
      colMask[c] &= ~bit;
      boxMask[b] &= ~bit;

      if (stop) return true;
    }
    return false;
  };

  search();

  let status;
  if (solutions.length === 0) {
    status = hitLimit ? 'limit' : 'unsolvable';
  } else if (solutions.length >= 2) {
    status = 'ambiguous';
  } else {
    status = 'solved';
  }

  return {
    status,
    solution: solutions[0] ?? null,
    solutions: solutions.length,
    conflicts: [],
    nodes,
    ms: now() - t0,
  };
}

export const STATUS_TEXT = {
  solved: '已求解',
  invalid: '题目有冲突',
  unsolvable: '无解',
  ambiguous: '可能有多解',
  limit: '搜索超限',
};
