// 基于 OpenCV.js 的九宫格候选检测。
// 输入 RGBA Mat，输出按面积降序的四边形候选（TL, TR, BR, BL，检测坐标系）。
// 默认最多 4 个；deep 模式会额外跑 Canny / 低阈值并给出更多候选。

import { orderCorners, cornerDistance, quadArea } from '../render/homography.js';

/**
 * @param {any} cv OpenCV.js 模块
 * @param {any} rgba
 * @param {{fallback?: boolean, deep?: boolean, maxCandidates?: number}} opts
 */
export function detectQuads(cv, rgba, opts = {}) {
  let quads = runDetect(cv, rgba, {});

  if (opts.deep) {
    // 常规阈值找不到九宫格时的加力搜索：细外框在照片里常被压断，
    // 自适应阈值给不出闭合四边形。Canny（边缘 + 膨胀）和更低 C 的阈值
    // 能从不同角度还原它。只在“锁定后读不出来”时跑，不影响每帧开销。
    quads = mergeQuads(quads, runDetect(cv, rgba, { useCanny: true }), rgba);
    quads = mergeQuads(quads, runDetect(cv, rgba, { c: 4 }), rgba);
  } else if (!quads.length && opts.fallback) {
    quads = runDetect(cv, rgba, { useCanny: true });
  }

  return quads.slice(0, opts.maxCandidates ?? 4);
}

function mergeQuads(base, extra, rgba) {
  const diag = Math.hypot(rgba.cols, rgba.rows);
  const out = base.slice();
  for (const q of extra) {
    if (out.some((o) => cornerDistance(o.points, q.points) < 0.02 * diag)) continue;
    out.push(q);
  }
  out.sort((a, b) => b.area - a.area);
  return out;
}

function runDetect(cv, rgba, { useCanny = false, c = 8 } = {}) {
  const w = rgba.cols;
  const h = rgba.rows;
  const bin = binarize(cv, rgba, { useCanny, c });
  try {
    return collectQuads(cv, bin, w, h);
  } finally {
    bin.delete();
  }
}

function binarize(cv, rgba, { useCanny = false, c = 8 } = {}) {
  const w = rgba.cols;
  const h = rgba.rows;
  const gray = new cv.Mat();
  const blur = new cv.Mat();
  let bin = null;
  let kernel = null;

  try {
    bin = new cv.Mat();
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);

    if (useCanny) {
      cv.Canny(blur, bin, 50, 150);
      kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      cv.dilate(bin, bin, kernel);
    } else {
      const block = oddClamp(Math.round(0.06 * Math.min(w, h)), 15, 35);
      cv.adaptiveThreshold(
        blur,
        bin,
        255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY_INV,
        block,
        c,
      );
      kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kernel);
    }

    const out = bin;
    bin = null;
    return out;
  } finally {
    if (bin) bin.delete();
    gray.delete();
    blur.delete();
    if (kernel) kernel.delete();
  }
}

function collectQuads(cv, bin, w, h) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const found = [];
  const minArea = w * h * 0.06;
  const maxArea = w * h * 0.98;
  const minSide = Math.max(28, 0.07 * Math.min(w, h));
  const diag = Math.hypot(w, h);
  const minSideLen2 = minSide * minSide;

  try {
    cv.findContours(
      bin,
      contours,
      hierarchy,
      cv.RETR_LIST,
      cv.CHAIN_APPROX_SIMPLE,
    );

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      try {
        const area = cv.contourArea(contour);
        if (area < minArea || area > maxArea) continue;

        const perimeter = cv.arcLength(contour, true);
        const approx = new cv.Mat();
        const hull = new cv.Mat();
        try {
          let pts = quadApprox(cv, contour, 0.02 * perimeter, approx);
          if (!pts) pts = quadApprox(cv, contour, 0.04 * perimeter, approx);
          if (!pts) {
            // 九宫格的细外框在照片里常常断成一节一节，轮廓就变成带凹口的
            // 多变形，怎么调 eps 都退化不成四边形。它的凸包恰好就是外框矩形。
            cv.convexHull(contour, hull, false, true);
            const hullPerim = cv.arcLength(hull, true);
            pts = quadApprox(cv, hull, 0.02 * hullPerim, approx);
          }
          if (!pts) continue;

          const ordered = orderCorners(pts);
          if (!validQuad(ordered, minSideLen2)) continue;

          const qArea = quadArea(ordered);
          if (qArea < minArea) continue;

          // 与已有候选去重
          if (
            found.some(
              (q) => cornerDistance(q.points, ordered) < 0.02 * diag,
            )
          ) {
            continue;
          }

          found.push({ points: ordered, area: qArea, score: area });
        } finally {
          approx.delete();
          hull.delete();
        }
      } finally {
        contour.delete();
      }
    }
  } finally {
    contours.delete();
    hierarchy.delete();
  }

  found.sort((a, b) => b.area - a.area);
  return found;
}

/** 用给定 eps 近似；只有恰好 4 点且凸时才返回角点。 */
function quadApprox(cv, contour, eps, dst) {
  cv.approxPolyDP(contour, dst, eps, true);
  if (dst.rows !== 4 || !cv.isContourConvex(dst)) return null;
  const pts = [];
  for (let k = 0; k < 4; k++) {
    pts.push({ x: dst.data32S[k * 2], y: dst.data32S[k * 2 + 1] });
  }
  return pts;
}

function validQuad(q, minSideLen2) {
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dx * dx + dy * dy < minSideLen2) return false;
  }
  for (let i = 0; i < 4; i++) {
    const prev = q[(i + 3) % 4];
    const cur = q[i];
    const next = q[(i + 1) % 4];
    const ax = prev.x - cur.x;
    const ay = prev.y - cur.y;
    const bx = next.x - cur.x;
    const by = next.y - cur.y;
    const denom = Math.hypot(ax, ay) * Math.hypot(bx, by);
    if (denom < 1e-6) return false;
    const angle = (Math.acos(clamp((ax * bx + ay * by) / denom, -1, 1)) * 180) / Math.PI;
    if (angle < 35 || angle > 145) return false;
  }
  return true;
}

function oddClamp(value, lo, hi) {
  let v = Math.max(lo, Math.min(hi, value));
  if (v % 2 === 0) v++;
  return v;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
