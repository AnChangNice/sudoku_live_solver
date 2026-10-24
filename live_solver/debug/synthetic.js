// 合成端到端测试：用 Canvas 渲染已知题目，施加透视/光照/噪声，
// 再走与生产完全相同的 Vision 管线，报告识别与求解正确率。

import '@fontsource/roboto/latin-400.css';
import '@fontsource/roboto/latin-700.css';
import '@fontsource/noto-sans/latin-400.css';
import '@fontsource/noto-sans/latin-700.css';
// 手机数独 App 常用的粗圆体：训练集里给它们加了权重，这里也做端到端回归。
import '@fontsource/fredoka/latin-600.css';
import '@fontsource/fredoka/latin-700.css';
import '@fontsource/baloo-2/latin-800.css';

import { loadOpenCV } from '../src/opencv-loader.js';
import { createRecognizer, recognizeCells, mergeConsensus, toGrid, SENSITIVITY } from '../src/vision/recognize.js';
import { Vision } from '../src/vision/pipeline.js';
import { solve, parsePuzzle, formatPuzzle } from '../src/solver.js';
import { CONFIG } from '../src/config.js';

const PUZZLE =
  '530070000600195000098000060800060003400803001700020006060000280000419005000080079';
const SOLUTION =
  '534678912672195348198342567859761423426853791713924856961537284287419635345286179';

const reportEl = document.getElementById('report');
const stage = (s) => { reportEl.textContent = 'stage: ' + s; console.log('[synthetic] ' + s); };
const sourceCanvas = document.getElementById('source');
const targetCanvas = document.getElementById('target');

let cv;
let model;
let vision;

async function setup() {
  // 相对文档解析：开发时 /debug/ → /vendor/，构建后 dist/debug/ → dist/vendor/，
  // 不依赖打包产物里 import.meta.url 的位置。
  const url = new URL(
    `../vendor/opencv.js?v=${CONFIG.opencvVersion}`,
    document.baseURI,
  ).href;
  stage('loading opencv');
  cv = await loadOpenCV(url);
  stage('opencv ready');
  const recognizer = await createRecognizer();
  stage('recognizer ready ' + recognizer.count);
  model = recognizer.model;
  vision = new Vision(cv, CONFIG);
  // 画布首次用某个字体时才真正去加载；显式 load 一遍，避免第一次 run()
  // 静默回退到 Arial，把“字体识别测试”测成 Arial。
  const faces = [
    '400 64px "Roboto"',
    '700 64px "Roboto"',
    '400 64px "Noto Sans"',
    '700 64px "Noto Sans"',
    '700 64px "Fredoka"',
    '800 64px "Baloo 2"',
    '400 64px "Georgia"',
  ];
  await Promise.all(
    faces.map((f) => document.fonts.load(f, '0123456789').catch(() => {})),
  );
  await document.fonts.ready;
  stage('setup done');
}

function renderPuzzle(opts) {
  // style=screen 模拟手机 App：小格、细灰线、屏显字体。
  const screen = opts.style === 'screen';
  const cell = opts.cell ?? (screen ? 38 : 120);
  const margin = opts.margin ?? (screen ? 6 : 80);
  const font = opts.font ?? (screen ? 'Roboto' : 'Noto Sans');
  const weight = opts.weight ?? (screen ? 500 : 400);
  const size = margin * 2 + cell * 9;

  sourceCanvas.width = size;
  sourceCanvas.height = size;
  const ctx = sourceCanvas.getContext('2d');

  ctx.fillStyle = screen ? '#f4f4f1' : '#fbfbf7';
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = screen ? '#4c4c4c' : '#181818';
  for (let i = 0; i <= 9; i++) {
    const p = margin + i * cell;
    ctx.lineWidth = i % 3 === 0 ? (screen ? 3 : 6) : screen ? 1 : 2;
    ctx.beginPath();
    ctx.moveTo(p, margin);
    ctx.lineTo(p, margin + cell * 9);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(margin, p);
    ctx.lineTo(margin + cell * 9, p);
    ctx.stroke();
  }

  if (opts.border) {
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 4;
    ctx.strokeRect(
      margin - opts.border,
      margin - opts.border,
      size + opts.border * 2,
      size + opts.border * 2,
    );
  }

  const grid = parsePuzzle(PUZZLE);
  ctx.fillStyle = '#0b0b0b';
  ctx.font = `${weight} ${Math.round(cell * (screen ? 0.6 : 0.64))}px "${font}", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < 81; i++) {
    if (!grid[i]) continue;
    const r = (i / 9) | 0;
    const c = i % 9;
    ctx.fillText(
      String(grid[i]),
      margin + c * cell + cell / 2,
      margin + r * cell + cell / 2 + cell * 0.03,
    );
  }
  return { size, cell, margin };
}

function perspectiveQuad(tilt, w, h) {
  if (!tilt) {
    return [
      { x: w * 0.12, y: h * 0.08 },
      { x: w * 0.88, y: h * 0.08 },
      { x: w * 0.88, y: h * 0.92 },
      { x: w * 0.12, y: h * 0.92 },
    ];
  }
  return [
    { x: w * 0.18, y: h * 0.05 },
    { x: w * 0.86, y: h * 0.16 },
    { x: w * 0.8, y: h * 0.95 },
    { x: w * 0.13, y: h * 0.82 },
  ];
}

function renderTarget(opts) {
  const W = 1400;
  const H = 1100;
  const quad = insetQuad(perspectiveQuad(!!opts.tilt, W, H), opts.quadInset ?? 0);

  const src = cv.imread(sourceCanvas);
  const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    src.cols, 0,
    src.cols, src.rows,
    0, src.rows,
  ]);
  const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    quad[0].x, quad[0].y,
    quad[1].x, quad[1].y,
    quad[2].x, quad[2].y,
    quad[3].x, quad[3].y,
  ]);
  const M = cv.getPerspectiveTransform(srcPts, dstPts);
  const dst = new cv.Mat();
  cv.warpPerspective(
    src,
    dst,
    M,
    new cv.Size(W, H),
    cv.INTER_LINEAR,
    cv.BORDER_CONSTANT,
    new cv.Scalar(148, 146, 140, 255),
  );

  if (opts.blur) {
    const blurred = new cv.Mat();
    cv.GaussianBlur(dst, blurred, new cv.Size(3, 3), opts.blur, 0, cv.BORDER_DEFAULT);
    dst.delete();
    cv.imshow(targetCanvas, blurred);
    blurred.delete();
  } else {
    cv.imshow(targetCanvas, dst);
    dst.delete();
  }

  src.delete();
  srcPts.delete();
  dstPts.delete();
  M.delete();

  if (opts.screen) applyScreenTexture(targetCanvas);
  if (opts.lighting !== false) applyLighting(targetCanvas);
  if (opts.noise) applyNoise(targetCanvas, opts.noise);
  return quad;
}

/** 模拟拍摄屏幕：细密的像素栅格 + 轻微摩尔纹。 */
function applyScreenTexture(canvas) {
  const ctx = canvas.getContext('2d');
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  const w = canvas.width;
  const h = canvas.height;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const stripe = (x % 3 === 0 ? -7 : 0) + (y % 3 === 0 ? -7 : 0);
      const moire = Math.sin(x * 0.7) * Math.sin(y * 0.9) * 3;
      const i = (y * w + x) * 4;
      data[i] = clamp255(data[i] + stripe + moire);
      data[i + 1] = clamp255(data[i + 1] + stripe + moire);
      data[i + 2] = clamp255(data[i + 2] + stripe + moire);
    }
  }
  ctx.putImageData(image, 0, 0);
}

function insetQuad(quad, factor) {
  if (!factor) return quad;
  const cx = quad.reduce((s, p) => s + p.x, 0) / 4;
  const cy = quad.reduce((s, p) => s + p.y, 0) / 4;
  return quad.map((p) => ({
    x: cx + (p.x - cx) * (1 - factor),
    y: cy + (p.y - cy) * (1 - factor),
  }));
}

function applyLighting(canvas) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  const g = ctx.createRadialGradient(
    w * 0.38,
    h * 0.32,
    Math.min(w, h) * 0.1,
    w * 0.5,
    h * 0.5,
    Math.max(w, h) * 0.72,
  );
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.65, '#ececec');
  g.addColorStop(1, '#b4b4b4');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

function applyNoise(canvas, amount) {
  const ctx = canvas.getContext('2d');
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (Math.random() - 0.5) * amount;
    data[i] = clamp255(data[i] + n);
    data[i + 1] = clamp255(data[i + 1] + n);
    data[i + 2] = clamp255(data[i + 2] + n);
  }
  ctx.putImageData(image, 0, 0);
}

function clamp255(v) {
  return Math.max(0, Math.min(255, v));
}

function evaluate(opts = {}) {
  const started = performance.now();
  stage('render puzzle');
  renderPuzzle(opts);
  stage('warp target');
  renderTarget(opts);

  const sw = targetCanvas.width;
  const sh = targetCanvas.height;
  stage('detect');
  const tDetect = performance.now();
  const det = vision.detect(targetCanvas, sw, sh, {
    longSide: CONFIG.detectLongSideStatic,
    fallback: true,
  });
  const detectMs = performance.now() - tDetect;
  stage('detect done ' + det.quads.length);

  let chosen = null;
  let lastVerify = null;
  const tRead = performance.now();
  for (const q of det.quads) {
    stage('read attempt');
    const res = vision.read(targetCanvas, sw, sh, q.points, det.PW, det.PH);
    stage('read result ' + res.ok + ' ' + (res.verify?.score ?? ''));
    if (res.ok) {
      chosen = res;
      break;
    }
    lastVerify = res.verify;
  }
  const readMs = performance.now() - tRead;

  if (!chosen) {
    return {
      ok: false,
      reason: 'grid-not-verified',
      candidates: det.quads.length,
      verify: lastVerify,
      detectMs,
      ms: performance.now() - started,
    };
  }

  const thresholds = SENSITIVITY.medium;
  const a = recognizeCells(chosen.cellsA, model, thresholds);
  const b = recognizeCells(chosen.cellsB, model, thresholds);
  const merged = mergeConsensus(a, b);
  const grid = toGrid(merged);
  const truth = parsePuzzle(PUZZLE);

  let correct = 0;
  let wrong = 0;
  let missed = 0;
  let falsePositive = 0;
  const mistakes = [];
  const unknownDetails = [];
  for (let i = 0; i < 81; i++) {
    if (truth[i]) {
      if (grid[i] === truth[i]) correct++;
      else if (grid[i] === 0) {
        missed++;
        unknownDetails.push({
          i,
          truth: truth[i],
          a: brief(a[i]),
          b: brief(b[i]),
          m: brief(merged[i]),
          cellA: cellBrief(chosen.cellsA[i]),
          cellB: cellBrief(chosen.cellsB[i]),
        });
      } else {
        wrong++;
        mistakes.push({ i, truth: truth[i], got: grid[i] });
      }
    } else if (grid[i] !== 0) {
      falsePositive++;
      mistakes.push({ i, truth: 0, got: grid[i] });
    }
  }

  const solved = solve(grid);
  const solvedCorrect =
    !!solved.solution && formatPuzzle(solved.solution) === SOLUTION;

  return {
    ok: true,
    opts: {
      tilt: !!opts.tilt,
      font: opts.font ?? 'Noto Sans',
      weight: opts.weight ?? 400,
      blur: opts.blur ?? 0,
      noise: opts.noise ?? 0,
    },
    candidates: det.quads.length,
    verify: {
      pass: chosen.verify.pass,
      score: chosen.verify.score,
      vOk: chosen.verify.vOk,
      hOk: chosen.verify.hOk,
    },
    clues: truth.filter(Boolean).length,
    correct,
    wrong,
    missed,
    falsePositive,
    mistakes: mistakes.slice(0, 12),
    unknownDetails,
    digitAccuracy: correct / truth.filter(Boolean).length,
    solveStatus: solved.status,
    solvedCorrect,
    detectMs,
    readMs,
    totalMs: performance.now() - started,
  };
}

/** 在 warp 灰度图上测量每条期望格线位置的黑白对比。 */
function probeWarp({ data, size }) {
  const pad = Math.round(size * 0.04);
  const colMean = (x) => {
    let s = 0;
    let n = 0;
    for (let y = pad; y < size - pad; y += 2) {
      s += data[y * size + x];
      n++;
    }
    return s / n;
  };
  const rowMean = (y) => {
    let s = 0;
    let n = 0;
    for (let x = pad; x < size - pad; x += 2) {
      s += data[y * size + x];
      n++;
    }
    return s / n;
  };
  const scan = (mean) => {
    const out = [];
    for (let k = 1; k <= 8; k++) {
      const c = Math.round((k * size) / 9);
      let dark = 255;
      let bg = 0;
      for (let p = c - 6; p <= c + 6; p++) {
        if (p < 1 || p >= size - 1) continue;
        const m = mean(p);
        if (m < dark) dark = m;
        if (m > bg) bg = m;
      }
      out.push({ k, dark: Math.round(dark), bg: Math.round(bg), contrast: Math.round(bg - dark) });
    }
    return out;
  };
  return { v: scan(colMean), h: scan(rowMean) };
}

/**
 * 对一张真实照片做完整诊断（调试面板用）：
 * 列出每个候选四边形的校验分数，并对第一个通过校验的候选输出逐格识别结果。
 */
async function analyzeDataUrl(
  dataUrl,
  longSide = CONFIG.detectLongSideStatic,
  deep = false,
) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);
  const sw = canvas.width;
  const sh = canvas.height;

  const det = vision.detect(canvas, sw, sh, {
    longSide,
    fallback: true,
    deep,
    maxCandidates: deep ? 6 : undefined,
  });
  const attempts = [];
  let chosen = null;

  for (const q of det.quads) {
    const res = vision.read(canvas, sw, sh, q.points, det.PW, det.PH);
    const entry = {
      quad: q.points.map((p) => [Math.round(p.x), Math.round(p.y)]),
      ok: res.ok,
      verify: res.verify
        ? {
            pass: res.verify.pass,
            score: +res.verify.score.toFixed(3),
            vOk: res.verify.vOk,
            hOk: res.verify.hOk,
            v: res.verify.v.map((x) => +x.toFixed(2)),
            h: res.verify.h.map((x) => +x.toFixed(2)),
          }
        : null,
      lines: res.lines
        ? {
            refined: res.lines.refined,
            strength: +res.lines.strength.toFixed(2),
            xs: res.lines.xs.map((x) => Math.round(x)),
            ys: res.lines.ys.map((x) => Math.round(x)),
          }
        : null,
      quadSource: res.quadSource
        ? res.quadSource.map((p) => [Math.round(p.x), Math.round(p.y)])
        : null,
      // 每条期望格线处的灰度对比：用来判断细格线是否在拍照后消失
      warpProbe: vision.lastWarp ? probeWarp(vision.lastWarp) : null,
    };

    if (res.ok && !chosen) {
      chosen = res;
      const a = recognizeCells(res.cellsA, model, SENSITIVITY.medium);
      const b = recognizeCells(res.cellsB, model, SENSITIVITY.medium);
      const merged = mergeConsensus(a, b);
      const grid = toGrid(merged);
      const solved = solve(grid);
      entry.grid = Array.from(grid).join('');
      entry.cells = merged.map((m, i) => ({
        i,
        r: (i / 9) | 0,
        c: i % 9,
        kind: m.kind,
        v: m.value,
        guess: m.guess || 0,
        score: +(m.score || 0).toFixed(2),
        margin: +(m.margin || 0).toFixed(2),
        a: a[i].kind,
        b: b[i].kind,
        bbox: a[i].bbox || b[i].bbox,
      }));
      entry.solve = {
        status: solved.status,
        solution: solved.solution ? formatPuzzle(solved.solution) : null,
      };
    }
    attempts.push(entry);
  }

  return {
    size: [sw, sh],
    detect: { PW: det.PW, PH: det.PH, candidates: det.quads.length },
    attempts,
  };
}

function cellBrief(c) {
  return {
    kind: c.kind,
    reason: c.reason,
    ink: Math.round((c.inkRatio || 0) * 1000) / 1000,
    bbox: c.bbox,
  };
}

function brief(r) {
  return {
    kind: r.kind,
    guess: r.guess,
    score: Math.round((r.score || 0) * 1000) / 1000,
    margin: Math.round((r.margin || 0) * 1000) / 1000,
    second: r.secondDigit,
    secondScore: r.secondScore == null ? undefined : Math.round(r.secondScore * 1000) / 1000,
  };
}

function formatResult(label, r) {
  if (!r.ok) {
    return `${label}: FAIL (${r.reason}) candidates=${r.candidates} verify=${
      r.verify ? r.verify.score.toFixed(2) : 'n/a'
    }`;
  }
  return [
    `${label}: ${r.solvedCorrect ? 'PASS' : 'CHECK'}`,
    `  candidates=${r.candidates} verify=${r.verify.score.toFixed(2)} (v${r.verify.vOk}/h${r.verify.hOk})`,
    `  clues=${r.clues} correct=${r.correct} wrong=${r.wrong} missed=${r.missed} falsePositive=${r.falsePositive}`,
    `  digitAccuracy=${(r.digitAccuracy * 100).toFixed(1)}% solver=${r.solveStatus} solvedCorrect=${r.solvedCorrect}`,
    `  detect=${r.detectMs.toFixed(0)}ms total=${r.totalMs.toFixed(0)}ms`,
    r.mistakes.length ? `  mistakes=${JSON.stringify(r.mistakes)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function main() {
  try {
    await setup();
    const flat = evaluate({ tilt: false, font: 'Noto Sans', weight: 400 });
    document.getElementById('report').textContent = formatResult('flat', flat);

    window.__sudokuDebug = {
      ready: true,
      run: (opts = {}) => evaluate(opts),
      setup,
      net: { input: model.input, hidden: model.hidden },
      analyzeDataUrl,
      vision,
      cv,
      model,
      recognizeCells,
      mergeConsensus,
      toGrid,
      sensitivity: SENSITIVITY,
      flat,
    };
    console.log('[synthetic] ready', JSON.stringify(window.__sudokuDebug.net));

    const tilted = evaluate({ tilt: true, font: 'Roboto', weight: 700 });
    document.getElementById('report').textContent +=
      '\n\n' + formatResult('tilted', tilted);
    window.__sudokuDebug.tilted = tilted;
  } catch (err) {
    console.error(err);
    document.getElementById('report').textContent = `初始化失败: ${err.message}\n${err.stack}`;
    window.__sudokuDebug = { ready: false, error: String(err?.message || err) };
  }
}

main();
