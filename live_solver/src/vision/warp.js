// 透视校正与格线校验。

/**
 * 把四边形区域校正成 size×size 的正方形灰度图。
 * @returns {any} 新的 cv.Mat（调用方负责 delete）
 */
export function warpToSquare(cv, srcGray, quad, size) {
  const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    quad[0].x, quad[0].y,
    quad[1].x, quad[1].y,
    quad[2].x, quad[2].y,
    quad[3].x, quad[3].y,
  ]);
  const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    size, 0,
    size, size,
    0, size,
  ]);
  const M = cv.getPerspectiveTransform(srcPts, dstPts);
  const dst = new cv.Mat();

  try {
    cv.warpPerspective(
      srcGray,
      dst,
      M,
      new cv.Size(size, size),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(255),
    );
  } finally {
    srcPts.delete();
    dstPts.delete();
    M.delete();
  }
  return dst;
}

/**
 * 校验 warp 后是否真的像九宫格：内部 8 条竖线 + 8 条横线的覆盖率。
 * @param {Uint8Array} bin 二值图（格线为白，CV_8UC1）
 * @param {number} size
 */
export function verifyWarpLines(bin, size) {
  const pad = Math.round(size * 0.017);
  const tol = 4;
  const v = [];
  const h = [];
  const vShift = [];
  const hShift = [];

  for (let i = 1; i <= 8; i++) {
    const pos = Math.round((i * size) / 9);
    const vc = lineCoverageWithSearch(bin, size, pos, true, tol, pad);
    const hc = lineCoverageWithSearch(bin, size, pos, false, tol, pad);
    v.push(vc);
    h.push(hc);
    vShift.push(vc > 0.5 ? lineCenterShift(bin, size, pos, true, pad) : 0);
    hShift.push(hc > 0.5 ? lineCenterShift(bin, size, pos, false, pad) : 0);
  }

  const vOk = v.filter((c) => c > 0.7).length;
  const hOk = h.filter((c) => c > 0.7).length;
  const mean = [...v, ...h].reduce((s, c) => s + c, 0) / 16;

  // 手机屏幕、打印件的细格线在照片里常常只剩两三个灰阶的差别，
  // 自适应阈值后直接消失（实测样张里 8 条细线覆盖率只有 0.01）。
  // 但 3×3 的粗格线永远清晰。所以除了“16 条全中”，再允许
  // “4 条粗格线（k=3、6）全都命中”这一种通过方式。
  //
  // 光“命中”还不够：之前只要求粗格线落在期望位置 ±10px 内，结果
  // 比九宫格大一圈的四边形（手机/笔记本屏幕外框、App 的标题+内容区）
  // 把粗格线整体推开 6~10px 也照样通过，于是整块屏幕被当成九宫格读，
  // 答案铺满屏幕。这里改用线的真实中心位置判断。
  const bold = [v[2], v[5], h[2], h[5]];
  const boldShift = Math.max(
    Math.abs(vShift[2]),
    Math.abs(vShift[5]),
    Math.abs(hShift[2]),
    Math.abs(hShift[5]),
  );
  const structural = bold.every((c) => c >= 0.6) && boldShift <= BOLD_MAX_SHIFT;
  const full = vOk >= 7 && hOk >= 7 && mean >= 0.65;

  return {
    pass: full || structural,
    mode: full ? 'full' : structural ? 'bold' : 'none',
    score: mean,
    vOk,
    hOk,
    bold: Math.min(...bold),
    boldShift,
    v,
    h,
  };
}

// 粗格线中心相对等分位置允许的偏差（warp 900 像素下）。
// 实测正确识别时 1~3px；四边形比真实格线大 2% 时约 6px，大 4% 时约 8px，
// 大 5% 以上 8.5~10px。取 7：允许检测得略松的四边形（2~3% 时识别仍准确），
// 拒绝明显套在屏幕/内容区外框上的候选。
const BOLD_MAX_SHIFT = 7;

/**
 * 找一条格线的亚像素中心，返回相对期望位置的偏移。
 * 用 ±1px 的窄窗口算覆盖率，峰值处再按覆盖率加权，避免把相邻的
 * 数字笔画或粗线边缘算进中心。
 */
function lineCenterShift(bin, size, pos, vertical, pad) {
  const radius = 10;
  const cover = new Array(radius * 2 + 1).fill(0);
  let best = 0;
  let bestD = 0;
  for (let d = -radius; d <= radius; d++) {
    const c = lineCoverage(bin, size, pos + d, vertical, 1, pad);
    cover[d + radius] = c;
    if (c > best) {
      best = c;
      bestD = d;
    }
  }
  if (best < 0.4) return 0;

  let sum = 0;
  let weight = 0;
  for (let d = bestD - 3; d <= bestD + 3; d++) {
    if (d < -radius || d > radius) continue;
    const p = pos + d;
    if (p < 1 || p >= size - 1) continue;
    const w = Math.max(0, cover[d + radius] - best * 0.5);
    sum += p * w;
    weight += w;
  }
  return weight > 0 ? sum / weight - pos : 0;
}

/**
 * 找出 warp 后 9×9 网格线的真实位置（含外框）。
 *
 * 检测到的四边形和真正的格线之间常有几像素的偏差（外框线中心 vs 外沿、
 * 透视误差、圆角……）。若直接用 size/9 等分来切格，偏差会累积到某一侧，
 * 让格线侵入单元格、数字贴边，最终表现为“个别格子识别不出/识别错”。
 * 这里从二值图的行列投影里把每条线的中心找出来，再据此切格。
 *
 * @param {Uint8Array} bin 二值图（格线为白）
 * @param {number} size
 * @returns {{xs:number[], ys:number[], refined:boolean, strength:number}}
 */
export function refineGridLines(bin, size) {
  const pad = Math.round(size * 0.04);
  const step = 2;
  const span = size - 2 * pad;
  const samples = Math.ceil(span / step);

  const vProfile = new Float32Array(size);
  const hProfile = new Float32Array(size);

  for (let pos = 0; pos < size; pos++) {
    let vHit = 0;
    let hHit = 0;
    for (let t = pad; t < size - pad; t += step) {
      if (inkNear(bin, size, pos, t, true)) vHit++;
      if (inkNear(bin, size, pos, t, false)) hHit++;
    }
    vProfile[pos] = vHit / samples;
    hProfile[pos] = hHit / samples;
  }

  const vx = locateLines(vProfile, size);
  const hy = locateLines(hProfile, size);
  const xs = buildLinePositions(vx, size);
  const ys = buildLinePositions(hy, size);

  const found = vx.filter((p) => p != null).length + hy.filter((p) => p != null).length;
  return {
    xs: xs.positions,
    ys: ys.positions,
    refined: xs.ok && ys.ok,
    strength: found / 16,
  };
}

function inkNear(bin, size, a, b, vertical) {
  for (let d = -1; d <= 1; d++) {
    const p = a + d;
    if (p < 0 || p >= size) continue;
    const idx = vertical ? b * size + p : p * size + b;
    if (bin[idx] > 0) return true;
  }
  return false;
}

/** 在期望位置附近找线中心；找不到返回 null。 */
function locateLines(profile, size) {
  const out = [];
  for (let k = 1; k <= 8; k++) {
    const expected = Math.round((k * size) / 9);
    const radius = 10;
    let best = -1;
    let bestPos = expected;
    const lo = Math.max(1, expected - radius);
    const hi = Math.min(size - 2, expected + radius);
    for (let p = lo; p <= hi; p++) {
      if (profile[p] > best) {
        best = profile[p];
        bestPos = p;
      }
    }
    if (best < 0.6) {
      out.push(null);
      continue;
    }
    let sum = 0;
    let weight = 0;
    for (let p = Math.max(1, bestPos - 4); p <= Math.min(size - 2, bestPos + 4); p++) {
      const w = Math.max(0, profile[p] - best * 0.6);
      sum += p * w;
      weight += w;
    }
    out.push(weight > 0 ? sum / weight : bestPos);
  }
  return out;
}

/**
 * 用内部 8 条线的偏移做线性拟合，推算两条外框的位置。
 * 不合格时退回 size/9 等分。
 */
function buildLinePositions(found, size) {
  const expected = (k) => (k * size) / 9;
  const valid = found.filter((p) => p != null).length;
  if (valid < 6) {
    return { ok: false, positions: Array.from({ length: 10 }, (_, k) => expected(k)) };
  }

  // d(k) = a + b·k，最小二乘
  let n = 0;
  let sk = 0;
  let sd = 0;
  let skk = 0;
  let skd = 0;
  for (let k = 1; k <= 8; k++) {
    const p = found[k - 1];
    if (p == null) continue;
    const d = p - expected(k);
    n++;
    sk += k;
    sd += d;
    skk += k * k;
    skd += k * d;
  }
  const denom = n * skk - sk * sk;
  const b = Math.abs(denom) < 1e-6 ? 0 : (n * skd - sk * sd) / denom;
  const a = (sd - b * sk) / n;

  const positions = new Array(10);
  for (let k = 0; k <= 9; k++) {
    if (k >= 1 && k <= 8 && found[k - 1] != null) {
      positions[k] = found[k - 1];
    } else {
      positions[k] = expected(k) + a + b * k;
    }
  }

  // 必须单调且间距合理，否则宁可用等分
  const minGap = (size / 9) * 0.5;
  const maxGap = (size / 9) * 1.6;
  for (let k = 1; k <= 9; k++) {
    const gap = positions[k] - positions[k - 1];
    if (!(gap >= minGap && gap <= maxGap)) {
      return { ok: false, positions: Array.from({ length: 10 }, (_, i) => expected(i)) };
    }
  }
  return { ok: true, positions };
}

function lineCoverageWithSearch(bin, size, pos, vertical, tol, pad) {
  let best = 0;
  for (let offset = -6; offset <= 6; offset++) {
    const c = lineCoverage(bin, size, pos + offset, vertical, tol, pad);
    if (c > best) best = c;
    if (best >= 0.95) break;
  }
  return best;
}

function lineCoverage(bin, size, pos, vertical, tol, pad) {
  if (pos < tol || pos >= size - tol) return 0;
  let hit = 0;
  let total = 0;
  const step = 2;

  for (let t = pad; t < size - pad; t += step) {
    total++;
    let found = false;
    for (let d = -tol; d <= tol; d++) {
      const x = vertical ? pos + d : t;
      const y = vertical ? t : pos + d;
      if (x < 0 || x >= size || y < 0 || y >= size) continue;
      if (bin[y * size + x] > 0) {
        found = true;
        break;
      }
    }
    if (found) hit++;
  }
  return total ? hit / total : 0;
}
