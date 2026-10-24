// 数字识别：预训练的小型分类器 + 双读共识。
//
// 分类器由 `npm run train:digits` 生成（见 tools/train-digits.js）：
//   输入 28×28 归一化字形（与 cells.js 的 normalizeGlyph 完全一致）
//   MLP 784 → 96 → 10，输出 10 类：0..8 = 数字 1..9，9 = 不是数字
//
// 与原来的多字体模板 NCC 相比：
//   - 非线性 + 大量退化样本（低分辨率/模糊/淡墨/噪声/透视字体），换字体更稳；
//   - 直接输出概率，阈值有明确含义；
//   - 多了一个“不是数字”类，格线残留、残缺字形不会被硬读成数字。

import { DIGIT_NET } from './digit-net.js';

// 概率尺度上的接受阈值：score = 最可能的数字概率，margin = 它与
// 次优数字、“不是数字”类中较大者的差距。
//
// 标准档的分数门槛定在 0.5 而不是 0.6：实拍屏幕/淡墨时，4、7 这类细笔画
// 数字常落在 0.5~0.6（次优数字只有 0.1 左右，margin 主要被“不是数字”拉低），
// 0.6 会把大量真实线索判成“待确认”。分类器评测集上 0.45 以下才出现风险，
// 0.5 + 0.1 仍是安全的。
export const SENSITIVITY = {
  high: { minScore: 0.45, minMargin: 0.08, strongScore: 0.85, strongMargin: 0.03, label: '灵敏' },
  medium: { minScore: 0.5, minMargin: 0.1, strongScore: 0.9, strongMargin: 0.04, label: '标准' },
  low: { minScore: 0.75, minMargin: 0.3, strongScore: 0.96, strongMargin: 0.1, label: '严格' },
};

function decodeF32(b64) {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(b64, 'base64');
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

function decodeModel(weights) {
  return {
    input: weights.input,
    hidden: weights.hidden,
    w1: decodeF32(weights.w1),
    b1: decodeF32(weights.b1),
    w2: decodeF32(weights.w2),
    b2: decodeF32(weights.b2),
  };
}

/**
 * 加载识别器。权重随包发布，不需要等字体或训练，调用开销只有一次 base64 解码。
 * @returns {Promise<{model: object, count: number}>}
 */
export async function createRecognizer() {
  const model = decodeModel(DIGIT_NET);
  return { model, count: model.input * model.hidden + model.hidden * 10 };
}

/** 对单个归一化字形分类。 */
export function classify(vec, model, thresholds) {
  const { input, hidden, w1, b1, w2, b2 } = model;

  const h = new Float32Array(hidden);
  for (let j = 0; j < hidden; j++) {
    let sum = b1[j];
    const off = j * input;
    for (let k = 0; k < input; k++) sum += w1[off + k] * vec[k];
    h[j] = sum > 0 ? sum : 0;
  }

  const probs = new Float32Array(10);
  let max = -Infinity;
  for (let d = 0; d < 10; d++) {
    let sum = b2[d];
    const off = d * hidden;
    for (let j = 0; j < hidden; j++) sum += w2[off + j] * h[j];
    probs[d] = sum;
    if (sum > max) max = sum;
  }
  let total = 0;
  for (let d = 0; d < 10; d++) {
    const e = Math.exp(probs[d] - max);
    probs[d] = e;
    total += e;
  }
  const inv = 1 / total;
  const pJunk = probs[9] * inv;

  let bestDigit = 0;
  let secondDigit = 0;
  let best = -1;
  let second = -1;
  for (let d = 0; d < 9; d++) {
    const p = probs[d] * inv;
    if (p > best) {
      second = best;
      secondDigit = bestDigit;
      best = p;
      bestDigit = d + 1;
    } else if (p > second) {
      second = p;
      secondDigit = d + 1;
    }
  }

  // margin 把“不是数字”也当作竞争对手：一个 0.7 的 8 如果“不是数字”也是 0.6，
  // 说明它更像半截字形，不该当成确定线索。
  const margin = best - Math.max(second, pJunk);
  const ok =
    (best >= thresholds.minScore && margin >= thresholds.minMargin && best > pJunk) ||
    (best >= (thresholds.strongScore ?? Infinity) &&
      margin >= (thresholds.strongMargin ?? Infinity) &&
      best > pJunk);

  return {
    digit: bestDigit,
    secondDigit,
    score: best,
    secondScore: second,
    margin,
    pJunk,
    ok,
    confidence: best,
  };
}

/** 对 readCells 的结果做分类。 */
export function recognizeCells(cells, model, thresholds) {
  return cells.map((cell) => {
    if (cell.kind === 'blank') {
      return { kind: 'blank', value: 0, guess: 0, score: 0, margin: 0, confidence: 1, bbox: null };
    }
    if (cell.kind === 'unknown' || !cell.vec) {
      return { kind: 'unknown', value: 0, guess: 0, score: 0, margin: 0, confidence: 0, bbox: cell.bbox };
    }
    const c = classify(cell.vec, model, thresholds);
    if (c.ok) {
      return {
        kind: 'digit',
        value: c.digit,
        guess: c.digit,
        score: c.score,
        secondScore: c.secondScore,
        secondDigit: c.secondDigit,
        margin: c.margin,
        confidence: c.confidence,
        bbox: cell.bbox,
      };
    }
    // 分类器明确认为“这不是数字”（阴影、摩尔纹、格线残段）：单独记为 junk，
    // 不当作“待确认”。否则每个噪点都会变成需要用户确认的琥珀格——
    // 用户看到的是一个空格，却要反复确认它。
    // 它和 blank 的区别在于有墨：双读时若另一侧读出了很强的数字，
    // 仍可采用（见 mergeConsensus），不会因为这一侧被格线切坏而丢掉线索。
    if (c.pJunk >= 0.6 && c.pJunk > c.score) {
      return { kind: 'junk', value: 0, guess: 0, score: 0, margin: 0, confidence: 0, bbox: null };
    }
    return {
      kind: 'unknown',
      value: 0,
      guess: c.digit,
      score: c.score,
      secondScore: c.secondScore,
      secondDigit: c.secondDigit,
      margin: c.margin,
      confidence: c.confidence,
      bbox: cell.bbox,
    };
  });
}

/**
 * 双读共识：两次读取（不同内缩）结果一致才认为是数字。
 */
export function mergeConsensus(a, b) {
  const out = new Array(81);
  for (let i = 0; i < 81; i++) {
    const x = a[i];
    const y = b[i];
    // blank = 确定没墨；junk = 有墨但分类器认为不是数字。两者都不是线索，
    // 但只要有一侧是 junk，就说明格子里确实有东西（见 strongSingle）。
    const xNoDigit = x.kind === 'blank' || x.kind === 'junk';
    const yNoDigit = y.kind === 'blank' || y.kind === 'junk';
    if (xNoDigit && yNoDigit) {
      out[i] = { kind: 'blank', value: 0, guess: 0, score: 0, margin: 0, confidence: 1 };
      continue;
    }
    if (x.kind === 'digit' && y.kind === 'digit' && x.value === y.value) {
      out[i] = {
        kind: 'digit',
        value: x.value,
        guess: x.value,
        score: Math.min(x.score, y.score),
        margin: Math.min(x.margin, y.margin),
        confidence: Math.min(x.confidence, y.confidence),
      };
      continue;
    }

    // 一次读出数字、另一次不确定：只要那次概率足够高就采用。
    // 两个内缩不同，某一侧可能因为格线侵入/裁切而分割失败，
    // 这并不代表另一侧读到的数字是错的（否则真实题目会到处都是“待确认”）。
    const single = strongSingle(x, y);
    if (single) {
      out[i] = {
        kind: 'digit',
        value: single.value,
        guess: single.value,
        score: single.score,
        secondScore: single.secondScore,
        secondDigit: single.secondDigit,
        margin: single.margin,
        confidence: single.confidence,
      };
      continue;
    }

    const guess = pickGuess(x, y);
    out[i] = {
      kind: 'unknown',
      value: 0,
      guess,
      score: Math.max(x.score || 0, y.score || 0),
      margin: Math.max(x.margin || 0, y.margin || 0),
      confidence: Math.max(x.confidence || 0, y.confidence || 0),
    };
  }
  return out;
}

// 单侧确认的门槛：比常规接受阈值更严，避免把噪声当成数字。
const SINGLE_SCORE = 0.85;
const SINGLE_MARGIN = 0.25;

function strongSingle(x, y) {
  const cand = x.kind === 'digit' ? x : y.kind === 'digit' ? y : null;
  if (!cand) return null;
  const other = cand === x ? y : x;
  // 另一侧确定是空的（没墨）时保持保守：空 vs 数字是强矛盾，交给编辑面板确认。
  // 另一侧是 unknown/junk（有墨但没读出数字）则可以采信这一侧——
  // 内缩不同，另一侧可能正好被格线切坏。
  if (other.kind !== 'unknown' && other.kind !== 'junk') return null;
  if (cand.score < SINGLE_SCORE || cand.margin < SINGLE_MARGIN) return null;
  return cand;
}

function pickGuess(x, y) {
  const gx = x.kind === 'digit' ? x.value : x.guess || 0;
  const gy = y.kind === 'digit' ? y.value : y.guess || 0;
  if (gx && gy) return gx === gy ? gx : x.score >= y.score ? gx : gy;
  return gx || gy || 0;
}

/** 分类结果 → 求解用盘面（未知格当空格）。 */
export function toGrid(results) {
  const grid = new Uint8Array(81);
  for (let i = 0; i < 81; i++) {
    if (results[i].kind === 'digit') grid[i] = results[i].value;
  }
  return grid;
}

/** 编辑/显示用：未知格保留猜测值。 */
export function toGuessGrid(results) {
  const grid = new Uint8Array(81);
  for (let i = 0; i < 81; i++) {
    const r = results[i];
    grid[i] = r.kind === 'digit' ? r.value : r.guess || 0;
  }
  return grid;
}
