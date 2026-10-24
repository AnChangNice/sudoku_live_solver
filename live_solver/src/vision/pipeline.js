// 检测与高清读取的编排层：持有可复用的 canvas，管理 OpenCV Mat 生命周期。

import { detectQuads } from './grid-detect.js';
import { warpToSquare, verifyWarpLines, refineGridLines } from './warp.js';
import { readCells } from './cells.js';
import { solveHomography, applyH } from '../render/homography.js';

export class Vision {
  constructor(cv, cfg) {
    this.cv = cv;
    this.cfg = cfg;
    this.procCanvas = makeCanvas();
    this.procCtx = this.procCanvas.getContext('2d', { willReadFrequently: true });
    this.readCanvas = makeCanvas();
    this.readCtx = this.readCanvas.getContext('2d', { willReadFrequently: true });
    this.lastWarp = null;
  }

  /**
   * 在检测分辨率下找候选四边形。
   * @param {CanvasImageSource} source
   * @param {number} sw 源宽
   * @param {number} sh 源高
   */
  detect(source, sw, sh, opts = {}) {
    const longSide = opts.longSide ?? this.cfg.detectLongSide;
    const scale = Math.min(1, longSide / Math.max(sw, sh));
    const PW = Math.max(1, Math.round(sw * scale));
    const PH = Math.max(1, Math.round(sh * scale));

    this.procCanvas.width = PW;
    this.procCanvas.height = PH;
    this.procCtx.drawImage(source, 0, 0, PW, PH);

    const cv = this.cv;
    const rgba = cv.imread(this.procCanvas);
    let candidates;
    try {
      candidates = detectQuads(cv, rgba, {
        fallback: !!opts.fallback,
        deep: !!opts.deep,
        maxCandidates: opts.maxCandidates,
      });
    } finally {
      rgba.delete();
    }
    return { quads: candidates, PW, PH };
  }

  /**
   * 高清读取：warp → 校验格线 → 两次切格。
   * @param {object} quadProc 检测坐标系下的四边形
   */
  read(source, sw, sh, quadProc, PW, PH, opts = {}) {
    const cv = this.cv;
    const cfg = this.cfg;
    const longSide = opts.longSide ?? cfg.readLongSide;
    const scale = Math.min(1, longSide / Math.max(sw, sh));
    const RW = Math.max(1, Math.round(sw * scale));
    const RH = Math.max(1, Math.round(sh * scale));

    this.readCanvas.width = RW;
    this.readCanvas.height = RH;
    this.readCtx.drawImage(source, 0, 0, RW, RH);

    const quadRead = quadProc.map((p) => ({
      x: (p.x * RW) / PW,
      y: (p.y * RH) / PH,
    }));

    const rgba = cv.imread(this.readCanvas);
    const gray = new cv.Mat();
    let warp = null;
    let bin = null;

    try {
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
      warp = warpToSquare(cv, gray, quadRead, cfg.warpSize);

      const meanGray = cv.mean(warp)[0];
      if (meanGray < 110) {
        cv.bitwise_not(warp, warp);
      }

      bin = new cv.Mat();
      cv.adaptiveThreshold(
        warp,
        bin,
        255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY_INV,
        31,
        10,
      );
      const binData = bin.data.slice();
      const verify = verifyWarpLines(binData, cfg.warpSize);
      const grayData = warp.data.slice();
      // 留一份最近一次校正后的图，便于“保存识别图”排查识别问题。
      // 必须在格线校验之前保存：识别失败时恰恰最需要看这张图。
      this.lastWarp = { data: grayData, size: cfg.warpSize };

      if (!verify.pass) {
        return { ok: false, verify };
      }

      // 用实测格线位置切格：四边形与真实格线常差几个像素，
      // 等分切格会把格线带进单元格，造成“个别格子读不出/读错”。
      const lines = refineGridLines(binData, cfg.warpSize);
      const cellsA = readCells(grayData, cfg.warpSize, cfg.warpSize, {
        inset: cfg.cellInsetA,
        minStd: cfg.cellMinStd,
        minContrast: cfg.cellMinContrast,
        minCore: cfg.cellMinCore,
        xs: lines.xs,
        ys: lines.ys,
      });
      const cellsB = readCells(grayData, cfg.warpSize, cfg.warpSize, {
        inset: cfg.cellInsetB,
        minStd: cfg.cellMinStd,
        minContrast: cfg.cellMinContrast,
        minCore: cfg.cellMinCore,
        xs: lines.xs,
        ys: lines.ys,
      });

      const baseQuad = quadRead.map((p) => ({
        x: (p.x * sw) / RW,
        y: (p.y * sh) / RH,
      }));
      const H = solveHomography(warpCorners(cfg.warpSize), baseQuad);

      // 叠加也必须贴着真实格线，否则答案整体偏几个像素。
      const quadSource = lines.refined
        ? [
            applyH(H, lines.xs[0], lines.ys[0]),
            applyH(H, lines.xs[9], lines.ys[0]),
            applyH(H, lines.xs[9], lines.ys[9]),
            applyH(H, lines.xs[0], lines.ys[9]),
          ]
        : baseQuad;

      return {
        ok: true,
        verify,
        lines,
        cellsA,
        cellsB,
        quadSource,
        quadProc: quadProc.map((p) => ({ x: p.x, y: p.y })),
        H,
        RW,
        RH,
        meanGray,
      };
    } finally {
      rgba.delete();
      gray.delete();
      if (warp) warp.delete();
      if (bin) bin.delete();
    }
  }
}

export function warpCorners(size) {
  return [
    { x: 0, y: 0 },
    { x: size, y: 0 },
    { x: size, y: size },
    { x: 0, y: size },
  ];
}

function makeCanvas() {
  return document.createElement('canvas');
}
