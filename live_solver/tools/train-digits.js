// 数字分类器的离线训练：在浏览器里用真实字体渲染 + 退化增广生成样本，
// 训练一个 784 → 48 → 10 的小型 MLP（9 个数字 + 1 个“不是数字”类）。
//
// 只在 `npm run train:digits` 时由 scripts/train-digits.mjs 驱动运行。
// 产物：src/vision/digit-net.js（权重）与 test/fixtures/digit-vectors.json。
//
// 关键点：样本向量必须用生产同一个 normalizeGlyph 生成，否则训练和线上
// 看到的输入分布不一致，再好的分类器也会退化。

import '@fontsource/roboto/latin-400.css';
import '@fontsource/roboto/latin-500.css';
import '@fontsource/roboto/latin-700.css';
import '@fontsource/noto-sans/latin-400.css';
import '@fontsource/noto-sans/latin-500.css';
import '@fontsource/noto-sans/latin-700.css';
// 手机游戏常用的圆角粗体（笔画很粗、字怀很小）。系统字体里没有这一类，
// 不单独覆盖的话，这类界面的数字会被判成“不是数字”。
import '@fontsource/baloo-2/latin-400.css';
import '@fontsource/baloo-2/latin-600.css';
import '@fontsource/baloo-2/latin-800.css';
import '@fontsource/fredoka/latin-400.css';
import '@fontsource/fredoka/latin-600.css';
import '@fontsource/fredoka/latin-700.css';
import '@fontsource/nunito/latin-400.css';
import '@fontsource/nunito/latin-700.css';
import '@fontsource/nunito/latin-900.css';
import '@fontsource/rubik/latin-400.css';
import '@fontsource/rubik/latin-700.css';
import '@fontsource/rubik/latin-900.css';

import { normalizeGlyph, otsu, bilinear } from '../src/vision/cells.js';

// 字体覆盖面越广，换一本书/换一个 App 时越稳。系统字体缺失时浏览器会回退，
// 回退出来的重复样本只是多一点权重，不影响正确性。
// [字体族, 可用字重]
const FONTS = [
  ['Roboto', [400, 500, 700]],
  ['Noto Sans', [400, 500, 700]],
  ['Arial', [400, 500, 600, 700]],
  ['Arial Narrow', [400, 500, 600, 700]],
  ['Helvetica', [400, 500, 600, 700]],
  ['Verdana', [400, 500, 600, 700]],
  ['Tahoma', [400, 500, 600, 700]],
  ['Trebuchet MS', [400, 500, 600, 700]],
  ['Segoe UI', [400, 500, 600, 700]],
  ['Calibri', [400, 500, 600, 700]],
  ['Cambria', [400, 500, 600, 700]],
  ['Georgia', [400, 500, 600, 700]],
  ['Times New Roman', [400, 500, 600, 700]],
  ['Palatino Linotype', [400, 500, 600, 700]],
  ['Franklin Gothic Medium', [400, 500, 600, 700]],
  ['Consolas', [400, 500, 600, 700]],
  ['Courier New', [400, 500, 600, 700]],
  ['Lucida Console', [400, 500, 600, 700]],
  ['Arial Black', [400, 900]],
  ['sans-serif', [400, 500, 600, 700]],
  ['serif', [400, 500, 600, 700]],
  ['monospace', [400, 500, 600, 700]],
  ['Baloo 2', [400, 600, 800]],
  ['Fredoka', [400, 600, 700]],
  ['Nunito', [400, 700, 900]],
  ['Rubik', [400, 700, 900]],
];
const GENERIC = new Set(['sans-serif', 'serif', 'monospace']);

const PATCH = 96;
const INPUT = 784;
const OUT = 10; // 0..8 → 数字 1..9，9 → 不是数字
const JUNK = 9;

const logEl = document.getElementById('log');
function log(msg) {
  logEl.textContent += '\n' + msg;
  console.log('[train] ' + msg);
}

const canvas = document.createElement('canvas');
canvas.width = PATCH;
canvas.height = PATCH;
const ctx = canvas.getContext('2d', { willReadFrequently: true });

/* ------------------------------------------------------------------ *
 * 随机数与基础图像操作
 * ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rnd() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rnd) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function cssFamily(family) {
  return GENERIC.has(family) ? family : `"${family}"`;
}

/** 双线性缩放（借生产同一个 bilinear，保证采样方式一致）。 */
function resample(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = ((y + 0.5) * sh) / dh - 0.5;
    for (let x = 0; x < dw; x++) {
      const sx = ((x + 0.5) * sw) / dw - 0.5;
      out[y * dw + x] = bilinear(src, sw, sh, sx, sy);
    }
  }
  return out;
}

function boxBlurR(src, w, h, radius) {
  if (radius <= 0) return src;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const inv = 1 / (radius * 2 + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        sum += src[row + Math.min(w - 1, Math.max(0, x + k))];
      }
      tmp[row + x] = sum * inv;
    }
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        sum += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x];
      }
      out[row + x] = sum * inv;
    }
  }
  return out;
}

/** mode<0：墨迹膨胀（3×3 取最小）；mode>0：墨迹腐蚀（3×3 取最大）。 */
function morph(src, w, h, mode) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = mode < 0 ? 255 : 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const p = src[yy * w + xx];
          v = mode < 0 ? Math.min(v, p) : Math.max(v, p);
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** Otsu 之后墨迹的外接框；行/列至少 2 个墨点，避免噪点把框撑大。 */
function inkBox(gray, w, h) {
  const thr = otsu(gray);
  const cols = new Uint16Array(w);
  const rows = new Uint16Array(h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (gray[row + x] <= thr) {
        cols[x]++;
        rows[y]++;
      }
    }
  }
  let minX = w;
  let maxX = -1;
  let minY = h;
  let maxY = -1;
  for (let x = 0; x < w; x++) {
    if (cols[x] >= 2) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  for (let y = 0; y < h; y++) {
    if (rows[y] >= 2) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0 || maxY < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/* ------------------------------------------------------------------ *
 * 样本渲染
 * ------------------------------------------------------------------ */

function clearPatch() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PATCH, PATCH);
  ctx.fillStyle = '#000000';
  ctx.strokeStyle = '#000000';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

function drawDigit(digit, rnd, family, weight) {
  const px = 54 + rnd() * 26;
  const dx = (rnd() - 0.5) * 16;
  const dy = (rnd() - 0.5) * 16;
  const rot = (rnd() - 0.5) * 0.18; // ≈ ±5°
  const shear = (rnd() - 0.5) * 0.12;
  ctx.save();
  ctx.translate(PATCH / 2 + dx, PATCH / 2 + dy);
  ctx.rotate(rot);
  ctx.transform(1, 0, shear, 1, 0, 0);
  ctx.fillStyle = '#000000';
  ctx.font = `${weight} ${px.toFixed(1)}px ${cssFamily(family)}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(digit), 0, 0);
  ctx.restore();
}

function drawJunk(rnd, type = (rnd() * 5) | 0) {
  if (type === 0) {
    // 一两条随机线段
    const n = 1 + ((rnd() * 3) | 0);
    for (let i = 0; i < n; i++) {
      ctx.lineWidth = 2 + rnd() * 7;
      ctx.beginPath();
      ctx.moveTo(10 + rnd() * 76, 10 + rnd() * 76);
      ctx.lineTo(10 + rnd() * 76, 10 + rnd() * 76);
      ctx.stroke();
    }
  } else if (type === 1) {
    // 圆弧/椭圆环
    const n = 1 + ((rnd() * 2) | 0);
    for (let i = 0; i < n; i++) {
      ctx.lineWidth = 2 + rnd() * 6;
      const cx = 24 + rnd() * 48;
      const cy = 24 + rnd() * 48;
      const rx = 8 + rnd() * 20;
      const ry = 8 + rnd() * 20;
      const a0 = rnd() * Math.PI * 2;
      ctx.beginPath();
      ctx.ellipse(
        cx,
        cy,
        rx,
        ry,
        rnd() * Math.PI,
        a0,
        a0 + Math.PI * (0.4 + rnd() * 1.4),
      );
      ctx.stroke();
    }
  } else if (type === 2) {
    // 折线
    let x = 14 + rnd() * 68;
    let y = 14 + rnd() * 68;
    ctx.lineWidth = 2 + rnd() * 6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const steps = 2 + ((rnd() * 4) | 0);
    for (let i = 0; i < steps; i++) {
      x += (rnd() - 0.5) * 44;
      y += (rnd() - 0.5) * 44;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  } else if (type === 3) {
    // 被裁掉一部分的数字：线上切格裁掉半截时就是这种输入
    const digit = 1 + ((rnd() * 9) | 0);
    const [family, weights] = FONTS[(rnd() * FONTS.length) | 0];
    const weight = weights[(rnd() * weights.length) | 0];
    const px = 54 + rnd() * 26;
    ctx.save();
    ctx.translate(
      PATCH / 2 + (rnd() - 0.5) * 90,
      PATCH / 2 + (rnd() - 0.5) * 90,
    );
    ctx.rotate((rnd() - 0.5) * 0.5);
    ctx.font = `${weight} ${px.toFixed(1)}px ${cssFamily(family)}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(digit), 0, 0);
    ctx.restore();
  } else {
    // 粗横条/竖条：格线残留、摩尔纹带
    ctx.lineWidth = 3 + rnd() * 9;
    ctx.beginPath();
    if (rnd() < 0.5) {
      const y = 24 + rnd() * 48;
      ctx.moveTo(8, y);
      ctx.lineTo(PATCH - 8, y + (rnd() - 0.5) * 8);
    } else {
      const x = 24 + rnd() * 48;
      ctx.moveTo(x, 8);
      ctx.lineTo(x + (rnd() - 0.5) * 8, PATCH - 8);
    }
    ctx.stroke();
  }
}

/** 模拟低分辨率、模糊、粗细、逆光/发灰、传感器噪声。 */
function degrade(gray, rnd) {
  let g = gray;

  if (rnd() < 0.5) {
    const d = 34 + ((rnd() * 36) | 0);
    const small = resample(g, PATCH, PATCH, d, d);
    g = resample(small, d, d, PATCH, PATCH);
  }

  // 实拍最关键的一类退化：对焦偏软 / 缩放插值让笔画边缘摊开。
  // 在 96px 画布上半径 2–6 约等于 28×28 字形上的 0.5–1.4px 模糊；不加大
  // 这一档，清晰渲染训练出的模型在真实照片上会明显偏保守。
  const BLUR_RADII = [0, 0, 2, 2, 2, 4, 4, 6];
  g = boxBlurR(g, PATCH, PATCH, BLUR_RADII[(rnd() * BLUR_RADII.length) | 0]);

  if (rnd() < 0.25) g = morph(g, PATCH, PATCH, rnd() < 0.5 ? -1 : 1);

  // k 越小字越淡；bg 模拟纸面的灰白程度。
  const k = 0.35 + rnd() * 0.65;
  const bg = 235 + rnd() * 20;
  const sigma = rnd() * 9;
  const out = new Uint8Array(PATCH * PATCH);
  for (let i = 0; i < out.length; i++) {
    let v = 255 - (255 - g[i]) * k;
    v += bg - 255;
    if (sigma) v += gauss(rnd) * sigma;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
  }
  return out;
}

function readGray() {
  const rgba = ctx.getImageData(0, 0, PATCH, PATCH).data;
  const gray = new Uint8Array(PATCH * PATCH);
  for (let i = 0; i < gray.length; i++) gray[i] = rgba[i * 4];
  return gray;
}

/**
 * 生成一个样本向量。cls: 0..8 = 数字 1..9，9 = 不是数字。
 * 外接框合理性用与 readCells 相同的范围，保证训练分布 == 线上分布。
 */
function makeSample(cls, rnd, family, weight, junkType) {
  clearPatch();
  if (cls === JUNK) {
    drawJunk(rnd, junkType);
  } else {
    const [fam, weights] = FONTS[(rnd() * FONTS.length) | 0];
    const wt = weight ?? weights[(rnd() * weights.length) | 0];
    drawDigit(cls + 1, rnd, family ?? fam, wt);
  }

  const gray = degrade(readGray(), rnd);
  const bbox = inkBox(gray, PATCH, PATCH);
  if (!bbox) return null;

  const hRel = bbox.h / PATCH;
  const wRel = bbox.w / PATCH;
  if (hRel < 0.3 || hRel > 0.9 || wRel < 0.08 || wRel > 0.9) return null;

  // 与生产 readCells 完全相同的归一化参数（默认 size 28 / glyph 22 / margin 2）
  return normalizeGlyph(gray, PATCH, PATCH, bbox);
}

/* ------------------------------------------------------------------ *
 * 数据集
 * ------------------------------------------------------------------ */

// 手机数独 App 普遍用粗圆体（Fredoka/Baloo 一类）。它们的 3 和 8、4 和 9
// 只差一个很小的缺口，压缩+反光之后尤其接近，样本量不够时边界会糊。
// 给这几族字体多采样，让模型把这几对字形真正分开。
const HEAVY_FONTS = new Set(['Arial Black', 'Baloo 2', 'Fredoka', 'Nunito', 'Rubik']);
const HEAVY_REPS = 3;

/**
 * 每个字体/字重组合都渲染 1..9 各一张，再加 2 张“不是数字”。
 * rounds 越大样本越多；不同的 round 用不同的字号/位置/退化。
 */
function buildDataset({ rounds, seed }) {
  const rnd = mulberry32(seed);
  const vectors = [];
  const labels = [];
  const junkTypes = [];
  let skipped = 0;
  let junkCounter = 0;

  for (let round = 0; round < rounds; round++) {
    for (const [family, weights] of FONTS) {
      for (const weight of weights) {
        const reps = HEAVY_FONTS.has(family) ? HEAVY_REPS : 1;
        for (let rep = 0; rep < reps; rep++) {
          for (let cls = 0; cls < 9; cls++) {
            let vec = null;
            for (let attempt = 0; attempt < 4 && !vec; attempt++) {
              vec = makeSample(cls, rnd, family, weight);
            }
            if (vec) {
              vectors.push(vec);
              labels.push(cls);
              junkTypes.push(255);
            } else {
              skipped++;
            }
          }
          for (let j = 0; j < 2; j++) {
            const jt = junkCounter++ % 5;
            let vec = null;
            for (let attempt = 0; attempt < 8 && !vec; attempt++) {
              vec = makeSample(JUNK, rnd, undefined, undefined, jt);
            }
            if (vec) {
              vectors.push(vec);
              labels.push(JUNK);
              junkTypes.push(jt);
            } else {
              skipped++;
            }
          }
        }
      }
    }
    if (round % 2 === 1 || round === rounds - 1) {
      log(`生成样本 ${vectors.length}（round ${round + 1}/${rounds}）`);
    }
  }

  const n = vectors.length;
  const X = new Float32Array(n * INPUT);
  for (let i = 0; i < n; i++) X.set(vectors[i], i * INPUT);
  return {
    X,
    y: Uint8Array.from(labels),
    junkType: Uint8Array.from(junkTypes),
    n,
    skipped,
  };
}

/* ------------------------------------------------------------------ *
 * MLP 训练
 * ------------------------------------------------------------------ */

function heInit(size, fanIn, rnd) {
  const a = new Float32Array(size);
  const scale = Math.sqrt(2 / fanIn);
  for (let i = 0; i < size; i++) a[i] = gauss(rnd) * scale;
  return a;
}

function adamStep(p, g, m, v, step, lr, wd, bc1, bc2) {
  const beta1 = 0.9;
  const beta2 = 0.999;
  const eps = 1e-8;
  for (let i = 0; i < p.length; i++) {
    const gi = g[i] + wd * p[i];
    m[i] = beta1 * m[i] + (1 - beta1) * gi;
    v[i] = beta2 * v[i] + (1 - beta2) * gi * gi;
    const mh = m[i] / bc1;
    const vh = v[i] / bc2;
    p[i] -= (lr * mh) / (Math.sqrt(vh) + eps);
  }
  void step;
}

function createNet(hidden, rnd) {
  return {
    input: INPUT,
    hidden,
    out: OUT,
    W1: heInit(hidden * INPUT, INPUT, rnd),
    b1: new Float32Array(hidden),
    W2: heInit(OUT * hidden, hidden, rnd),
    b2: new Float32Array(OUT),
  };
}

function cloneParams(net) {
  return {
    W1: Float32Array.from(net.W1),
    b1: Float32Array.from(net.b1),
    W2: Float32Array.from(net.W2),
    b2: Float32Array.from(net.b2),
  };
}

function forward(net, x, xOff, h, logits) {
  const { hidden, W1, b1, W2, b2 } = net;
  for (let j = 0; j < hidden; j++) {
    let sum = b1[j];
    const wo = j * INPUT;
    for (let k = 0; k < INPUT; k++) sum += W1[wo + k] * x[xOff + k];
    h[j] = sum > 0 ? sum : 0;
  }
  let max = -Infinity;
  for (let d = 0; d < OUT; d++) {
    let sum = b2[d];
    const wo = d * hidden;
    for (let j = 0; j < hidden; j++) sum += W2[wo + j] * h[j];
    logits[d] = sum;
    if (sum > max) max = sum;
  }
  let total = 0;
  for (let d = 0; d < OUT; d++) {
    const e = Math.exp(logits[d] - max);
    logits[d] = e;
    total += e;
  }
  const inv = 1 / total;
  for (let d = 0; d < OUT; d++) logits[d] *= inv;
}

function predict(net, x, xOff) {
  const h = new Float32Array(net.hidden);
  const probs = new Float32Array(OUT);
  forward(net, x, xOff, h, probs);
  let best = -1;
  let bestIdx = 0;
  for (let d = 0; d < OUT; d++) {
    if (probs[d] > best) {
      best = probs[d];
      bestIdx = d;
    }
  }
  return { probs, best, bestIdx };
}

function accuracy(net, dataset, indices) {
  const { X, y, junkType } = dataset;
  let correct = 0;
  let digits = 0;
  let digitCorrect = 0;
  let junk = 0;
  let junkCorrect = 0;
  const confusion = Array.from({ length: OUT }, () => new Array(OUT).fill(0));
  const junkByType = Array.from({ length: 5 }, () => ({ total: 0, rejected: 0 }));
  for (const i of indices) {
    const { bestIdx } = predict(net, X, i * INPUT);
    const truth = y[i];
    confusion[truth][bestIdx]++;
    if (bestIdx === truth) correct++;
    if (truth === JUNK) {
      junk++;
      const t = junkType[i];
      junkByType[t].total++;
      if (bestIdx === JUNK) {
        junkCorrect++;
        junkByType[t].rejected++;
      }
    } else {
      digits++;
      if (bestIdx === truth) digitCorrect++;
    }
  }
  return {
    accuracy: correct / indices.length,
    digitAccuracy: digitCorrect / Math.max(1, digits),
    junkReject: junkCorrect / Math.max(1, junk),
    junkByType,
    confusion,
  };
}

/** 扫描接受阈值：多少真数字被接受、多少被读错、多少非数字混进来。 */
function sweepThresholds(net, dataset, indices) {
  const rows = [];
  const preds = indices.map((i) => {
    const { probs } = predict(net, dataset.X, i * INPUT);
    let best = -1;
    let bestDigit = 0;
    let second = -1;
    for (let d = 0; d < 9; d++) {
      if (probs[d] > best) {
        second = best;
        best = probs[d];
        bestDigit = d + 1;
      } else if (probs[d] > second) {
        second = probs[d];
      }
    }
    return {
      truth: dataset.y[i],
      bestDigit,
      score: best,
      margin: best - Math.max(second, probs[9]),
    };
  });
  for (const minScore of [0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
    for (const minMargin of [0, 0.1, 0.2, 0.3]) {
      let acceptedRight = 0;
      let acceptedWrong = 0;
      let junkIn = 0;
      let digits = 0;
      let junk = 0;
      for (const p of preds) {
        const ok = p.score >= minScore && p.margin >= minMargin;
        if (p.truth === JUNK) {
          junk++;
          if (ok) junkIn++;
        } else {
          digits++;
          if (ok) {
            if (p.bestDigit === p.truth + 1) acceptedRight++;
            else acceptedWrong++;
          }
        }
      }
      rows.push({
        minScore,
        minMargin,
        coverage: acceptedRight / digits,
        wrong: acceptedWrong,
        junkIn,
        junkRate: junkIn / Math.max(1, junk),
      });
    }
  }
  return rows;
}

function shuffle(a, rnd) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

async function trainNet(dataset, opts) {
  const {
    hidden = 48,
    epochs = 30,
    batch = 64,
    lr = 0.003,
    seed = 1234,
    valRatio = 0.15,
  } = opts;
  const { X, y, n } = dataset;
  const rnd = mulberry32(seed);

  // 分层抽样：每一类里取 valRatio 做验证，避免某类缺席。
  const byClass = Array.from({ length: OUT }, () => []);
  for (let i = 0; i < n; i++) byClass[y[i]].push(i);
  const trainIdx = [];
  const valIdx = [];
  for (const list of byClass) {
    shuffle(list, rnd);
    const cut = Math.max(1, Math.round(list.length * valRatio));
    valIdx.push(...list.slice(0, cut));
    trainIdx.push(...list.slice(cut));
  }
  shuffle(trainIdx, rnd);

  const net = createNet(hidden, rnd);
  const mW1 = new Float32Array(net.W1.length);
  const vW1 = new Float32Array(net.W1.length);
  const mb1 = new Float32Array(net.b1.length);
  const vb1 = new Float32Array(net.b1.length);
  const mW2 = new Float32Array(net.W2.length);
  const vW2 = new Float32Array(net.W2.length);
  const mb2 = new Float32Array(net.b2.length);
  const vb2 = new Float32Array(net.b2.length);

  const gW1 = new Float32Array(net.W1.length);
  const gb1 = new Float32Array(net.b1.length);
  const gW2 = new Float32Array(net.W2.length);
  const gb2 = new Float32Array(net.b2.length);

  const h = new Float32Array(hidden);
  const probs = new Float32Array(OUT);
  const dlog = new Float32Array(OUT);
  const dh = new Float32Array(hidden);

  let best = null;
  let bestAcc = -1;
  let step = 0;
  const wd = 1e-4;
  const smooth = 0.05;

  log(
    `开始训练：${n} 样本，训练 ${trainIdx.length} / 验证 ${valIdx.length}，` +
      `hidden ${hidden}，${epochs} epochs`,
  );

  for (let epoch = 0; epoch < epochs; epoch++) {
    const t0 = performance.now();
    const lrNow = lr * (0.1 + 0.9 * 0.5 * (1 + Math.cos((Math.PI * epoch) / epochs)));
    let loss = 0;

    for (let b = 0; b < trainIdx.length; b += batch) {
      const end = Math.min(b + batch, trainIdx.length);
      gW1.fill(0);
      gb1.fill(0);
      gW2.fill(0);
      gb2.fill(0);

      for (let bi = b; bi < end; bi++) {
        const si = trainIdx[bi];
        const off = si * INPUT;
        forward(net, X, off, h, probs);
        const label = y[si];
        loss -= Math.log(Math.max(1e-9, probs[label]));
        for (let d = 0; d < OUT; d++) {
          const target = d === label ? 1 - smooth : smooth / (OUT - 1);
          dlog[d] = probs[d] - target;
        }
        for (let d = 0; d < OUT; d++) {
          const g = dlog[d];
          const wo = d * hidden;
          gb2[d] += g;
          for (let j = 0; j < hidden; j++) gW2[wo + j] += g * h[j];
        }
        for (let j = 0; j < hidden; j++) {
          let sum = 0;
          for (let d = 0; d < OUT; d++) sum += net.W2[d * hidden + j] * dlog[d];
          dh[j] = h[j] > 0 ? sum : 0;
        }
        for (let j = 0; j < hidden; j++) {
          const g = dh[j];
          const wo = j * INPUT;
          gb1[j] += g;
          for (let k = 0; k < INPUT; k++) gW1[wo + k] += g * X[off + k];
        }
      }

      const scale = 1 / (end - b);
      for (let i = 0; i < gW1.length; i++) gW1[i] *= scale;
      for (let i = 0; i < gb1.length; i++) gb1[i] *= scale;
      for (let i = 0; i < gW2.length; i++) gW2[i] *= scale;
      for (let i = 0; i < gb2.length; i++) gb2[i] *= scale;

      step++;
      const bc1 = 1 - Math.pow(0.9, step);
      const bc2 = 1 - Math.pow(0.999, step);
      adamStep(net.W1, gW1, mW1, vW1, step, lrNow, wd, bc1, bc2);
      adamStep(net.b1, gb1, mb1, vb1, step, lrNow, 0, bc1, bc2);
      adamStep(net.W2, gW2, mW2, vW2, step, lrNow, wd, bc1, bc2);
      adamStep(net.b2, gb2, mb2, vb2, step, lrNow, 0, bc1, bc2);
    }

    const val = accuracy(net, dataset, valIdx);
    if (val.accuracy > bestAcc) {
      bestAcc = val.accuracy;
      best = cloneParams(net);
    }
    log(
      `epoch ${epoch + 1}/${epochs} loss ${(loss / trainIdx.length).toFixed(3)} ` +
        `val ${(val.accuracy * 100).toFixed(2)}% ` +
        `(数字 ${(val.digitAccuracy * 100).toFixed(2)}% / 非数字 ${(val.junkReject * 100).toFixed(2)}%) ` +
        `${(performance.now() - t0).toFixed(0)}ms`,
    );
    // 让出主线程：Playwright 才能及时收到日志。
    await new Promise((r) => setTimeout(r, 0));
  }

  Object.assign(net, best);
  return net;
}

/* ------------------------------------------------------------------ *
 * 导出
 * ------------------------------------------------------------------ */

function toBase64(f32) {
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function probabilityStats(net, dataset, indices) {
  let minP = 1;
  let sumP = 0;
  let count = 0;
  let wrong = 0;
  const wrongList = [];
  for (const i of indices) {
    const { probs, best, bestIdx } = predict(net, dataset.X, i * INPUT);
    const truth = dataset.y[i];
    if (bestIdx === truth) {
      if (best < minP) minP = best;
      sumP += best;
      count++;
    } else {
      wrong++;
      wrongList.push({
        truth,
        got: bestIdx,
        p: +best.toFixed(3),
        pTruth: +probs[truth].toFixed(3),
      });
    }
  }
  return {
    correct: count,
    wrong,
    meanP: count ? sumP / count : 0,
    minP,
    wrongList: wrongList.slice(0, 10),
  };
}

async function runTraining(opts = {}) {
  const t0 = performance.now();
  await document.fonts.ready;
  for (const [family, weights] of FONTS) {
    for (const weight of weights) {
      try {
        await document.fonts.load(
          `${weight} 64px ${cssFamily(family)}`,
          '0123456789',
        );
      } catch {
        // 缺失字体回退到默认族，去重由样本随机性兜底
      }
    }
  }
  log(`字体就绪 ${(performance.now() - t0).toFixed(0)}ms`);

  const rounds = opts.rounds ?? 8;
  const dataset = buildDataset({ rounds, seed: opts.seed ?? 20261024 });
  log(
    `数据集 ${dataset.n} 条（跳过 ${dataset.skipped}），` +
      `其中非数字 ${Array.from(dataset.y).filter((v) => v === JUNK).length}`,
  );

  const net = await trainNet(dataset, {
    hidden: opts.hidden ?? 96,
    epochs: opts.epochs ?? 32,
    batch: opts.batch ?? 64,
    lr: opts.lr ?? 0.003,
    seed: opts.trainSeed ?? 1234,
  });

  // 独立评测集：用新的随机种子生成，不参与训练/选模。
  const evalSet = buildDataset({ rounds: opts.evalRounds ?? 3, seed: (opts.seed ?? 20261024) + 7 });
  const evalIdx = Array.from({ length: evalSet.n }, (_, i) => i);
  const evalReport = accuracy(net, evalSet, evalIdx);
  const stats = probabilityStats(net, evalSet, evalIdx);
  log(
    `评测集 ${evalSet.n} 条：总准确率 ${(evalReport.accuracy * 100).toFixed(2)}%，` +
      `数字 ${(evalReport.digitAccuracy * 100).toFixed(2)}%，` +
      `非数字拒绝 ${(evalReport.junkReject * 100).toFixed(2)}%，` +
      `正确样本最低概率 ${stats.minP.toFixed(3)}`,
  );
  if (stats.wrongList.length) {
    log(`错误样例 ${JSON.stringify(stats.wrongList)}`);
  }
  log(
    '混淆矩阵（行=真值 1..9,10=非数字）：\n' +
      evalReport.confusion
        .map((row) => row.map((v) => String(v).padStart(4)).join(''))
        .join('\n'),
  );
  log(
    '非数字拒绝率（0 线段 / 1 圆弧 / 2 折线 / 3 残缺数字 / 4 粗条）：' +
      evalReport.junkByType
        .map(
          (x, i) =>
            `${i} ${((x.rejected / Math.max(1, x.total)) * 100).toFixed(0)}%`,
        )
        .join('  '),
  );

  const sweep = sweepThresholds(net, evalSet, evalIdx);
  const fmt = (v) => (v * 100).toFixed(1).padStart(5) + '%';
  log(
    '阈值扫描（score / margin → 接受率 / 读错 / 非数字混入）：\n' +
      sweep
        .map(
          (r) =>
            `  ${r.minScore.toFixed(2)} / ${r.minMargin.toFixed(1)} → ` +
            `${fmt(r.coverage)}  wrong ${String(r.wrong).padStart(2)}  ` +
            `junk ${fmt(r.junkRate)}`,
        )
        .join('\n'),
  );

  // 给 Node 单测的固定样本：每类 2 条，用评测集里的（模型没见过）。
  const fixtureVectors = [];
  const fixtureLabels = [];
  const perClass = new Array(OUT).fill(0);
  for (let i = 0; i < evalSet.n && fixtureVectors.length < OUT * 2; i++) {
    const cls = evalSet.y[i];
    if (perClass[cls] >= 2) continue;
    // 只收模型自己判对的样本：这个 fixture 用来防止权重/解码回归，
    // 真实的泛化能力由合成端到端测试把关。
    if (predict(net, evalSet.X, i * INPUT).bestIdx !== cls) continue;
    perClass[cls]++;
    fixtureLabels.push(cls === JUNK ? 0 : cls + 1);
    fixtureVectors.push(evalSet.X.subarray(i * INPUT, (i + 1) * INPUT));
  }
  const flat = new Float32Array(fixtureVectors.length * INPUT);
  fixtureVectors.forEach((v, i) => flat.set(v, i * INPUT));

  return {
    model: {
      input: INPUT,
      hidden: net.hidden,
      w1: toBase64(net.W1),
      b1: toBase64(net.b1),
      w2: toBase64(net.W2),
      b2: toBase64(net.b2),
    },
    report: {
      samples: dataset.n,
      evalSamples: evalSet.n,
      overall: evalReport.accuracy,
      digit: evalReport.digitAccuracy,
      junkReject: evalReport.junkReject,
      meanP: stats.meanP,
      minP: stats.minP,
      wrong: stats.wrong,
      wrongList: stats.wrongList,
      confusion: evalReport.confusion,
      ms: Math.round(performance.now() - t0),
    },
    fixture: {
      input: INPUT,
      labels: fixtureLabels,
      vectors: toBase64(flat),
    },
  };
}

window.runTraining = runTraining;
window.__trainReady = true;
log('ready');
