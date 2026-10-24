// 叠加层：把答案数字按单应矩阵逐格仿射绘制到视频/快照之上。

import { applyH } from './homography.js';
import { CONFIG } from '../config.js';

export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.Hcss = null;
    this.solution = null;
    this.grid = null;
    this.unknown = null;
    this.debugQuad = null;
    this.alpha = 0;
    this.targetAlpha = 0;
    this.lastTs = 0;
    this.cssW = 1;
    this.cssH = 1;
    this.dpr = 1;
    this.highlightUnknown = true;
    this.debug = false;
  }

  resize(cssW, cssH, dpr) {
    this.cssW = Math.max(1, cssW);
    this.cssH = Math.max(1, cssH);
    this.dpr = Math.min(dpr || 1, 2);
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    this.canvas.style.width = `${this.cssW}px`;
    this.canvas.style.height = `${this.cssH}px`;
  }

  setProjection(Hcss) {
    this.Hcss = Hcss;
  }

  /** 解算结果；传 null 清空。 */
  setData({ solution, grid, unknown } = {}) {
    this.solution = solution || null;
    this.grid = grid || null;
    this.unknown = unknown || null;
    this.targetAlpha = solution ? 1 : 0;
  }

  setDebugQuad(points, verified = false) {
    this.debugQuad = points;
    this.debugQuadVerified = !!verified;
  }

  invalidateProjection() {
    this.Hcss = null;
  }

  render(ts = 0) {
    const dt = this.lastTs ? Math.min(100, ts - this.lastTs) : 16;
    this.lastTs = ts;

    const step = dt / Math.max(16, CONFIG.fadeMs);
    if (this.alpha < this.targetAlpha) {
      this.alpha = Math.min(this.targetAlpha, this.alpha + step);
    } else if (this.alpha > this.targetAlpha) {
      this.alpha = Math.max(this.targetAlpha, this.alpha - step);
    }

    const { ctx, canvas, dpr } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (this.debugQuad) this.drawDebugQuad();

    if (!this.Hcss || !this.solution || this.alpha < 0.01) return;

    ctx.globalAlpha = this.alpha;

    for (let i = 0; i < 81; i++) {
      if (this.grid && this.grid[i]) continue;
      // 待确认的格子不能盖答案：它有可能是题面上的已知数字，只是没认出来。
      // 把解画在它上面会出现两个数字叠在一起，看起来像“识别成别的数”，
      // 而且每次重读解不同，数字就会来回跳。这里只画琥珀色框提示。
      if (this.unknown && this.unknown[i]) continue;
      const value = this.solution[i];
      if (!value) continue;

      const local = this.cellTransform(i);
      if (!local) continue;

      ctx.setTransform(
        dpr * local.ax,
        dpr * local.ay,
        dpr * local.bx,
        dpr * local.by,
        dpr * local.x,
        dpr * local.y,
      );
      ctx.font = '400 68px "Roboto", "Noto Sans", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      // 描边只为在深色背景上可读，常规字重下不宜太粗，否则字形又显加粗。
      ctx.lineWidth = 4;
      ctx.strokeStyle = CONFIG.digitHalo;
      ctx.strokeText(String(value), 50, 52);
      ctx.fillStyle = CONFIG.digitColor;
      ctx.fillText(String(value), 50, 52);
    }

    if (this.highlightUnknown && this.unknown) {
      for (let i = 0; i < 81; i++) {
        if (!this.unknown[i]) continue;
        const local = this.cellTransform(i);
        if (!local) continue;
        ctx.setTransform(
          dpr * local.ax,
          dpr * local.ay,
          dpr * local.bx,
          dpr * local.by,
          dpr * local.x,
          dpr * local.y,
        );
        ctx.lineWidth = 4;
        ctx.strokeStyle = CONFIG.unknownColor;
        ctx.strokeRect(10, 10, 80, 80);
      }
    }

    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  cellTransform(index) {
    const size = 100;
    const x0 = (index % 9) * size;
    const y0 = ((index / 9) | 0) * size;

    const p0 = applyH(this.Hcss, x0, y0);
    const px = applyH(this.Hcss, x0 + size, y0);
    const py = applyH(this.Hcss, x0, y0 + size);
    if (!p0 || !px || !py) return null;
    if (![p0.x, p0.y, px.x, px.y, py.x, py.y].every(Number.isFinite)) {
      return null;
    }

    return {
      ax: (px.x - p0.x) / size,
      ay: (px.y - p0.y) / size,
      bx: (py.x - p0.x) / size,
      by: (py.y - p0.y) / size,
      x: p0.x,
      y: p0.y,
    };
  }

  drawDebugQuad() {
    const ctx = this.ctx;
    const pts = this.debugQuad;
    if (!pts || pts.length !== 4) return;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = this.debugQuadVerified
      ? 'rgba(0, 220, 120, 0.9)'
      : 'rgba(240, 180, 40, 0.9)';
    ctx.setLineDash(this.debugQuadVerified ? [] : [10, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/** 生成 warp(0..size) → CSS 坐标的复合矩阵。 */
export function buildDisplayProjection(Hwp, srcW, srcH, cssW, cssH, fit) {
  const s =
    fit === 'contain'
      ? Math.min(cssW / srcW, cssH / srcH)
      : Math.max(cssW / srcW, cssH / srcH);
  const ox = (cssW - srcW * s) / 2;
  const oy = (cssH - srcH * s) / 2;
  const T = [s, 0, ox, 0, s, oy, 0, 0, 1];
  const Hcss = compose3(T, Hwp);
  return { Hcss, T, fit, srcW, srcH };
}

function compose3(A, B) {
  const C = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      C[r * 3 + c] =
        A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    }
  }
  return C;
}
