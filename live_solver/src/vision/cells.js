// 单元格切分、空白判定与字形归一化。纯 JS，无 OpenCV 依赖，可在 Node 中测试。

export const WARP_SIZE = 900;
export const CELL_SIZE = 100;
export const CELL_INSET = 13;

// 屏幕摩尔纹/压缩噪点与格内背景的灰度差通常只有十几级；真实数字（印刷或
// 屏幕亮字）和背景差 100 级以上。低于这个差值就当空格。
export const MIN_CONTRAST = 26;
// 腐蚀后至少还要剩下这么多比例的墨，才认为有真正的笔画。
// 100×100 的格子里 26px² 约等于一根 1px 宽、26px 长的细芯。
export const MIN_CORE = 0.0026;

/**
 * 从一个 900x900 的透视校正灰度图中读取 81 格。
 * @param {Uint8Array} gray
 * @param {number} width
 * @param {number} height
 * @param {{cellSize?:number, inset?:number, minStd?:number,
 *          minContrast?:number, minCore?:number}} opts
 * @returns {Array<{kind:'blank'|'glyph'|'unknown', vec:Float32Array|null,
 *                  bbox:null|{x:number,y:number,w:number,h:number},
 *                  inkRatio:number, contrast:number, reason?:string}>}
 */
export function readCells(gray, width, height, opts = {}) {
  const cellSize = opts.cellSize ?? width / 9;
  const inset = opts.inset ?? CELL_INSET;
  const minStd = opts.minStd ?? 7;
  const minContrast = opts.minContrast ?? MIN_CONTRAST;
  const minCore = opts.minCore ?? MIN_CORE;
  // 可选：格线的实际位置（10 条，单位与图像一致）。给了就按实测位置切，
  // 避免等分与真实格线之间的几像素偏差把格线切进单元格。
  const xs = opts.xs ?? null;
  const ys = opts.ys ?? null;
  const cells = new Array(81);

  const lineX = (k) => (xs ? xs[k] : k * cellSize);
  const lineY = (k) => (ys ? ys[k] : k * cellSize);

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const x = Math.round(lineX(c)) + inset;
      const y = Math.round(lineY(r)) + inset;
      const w = Math.round(lineX(c + 1) - inset) - x;
      const h = Math.round(lineY(r + 1) - inset) - y;
      cells[r * 9 + c] = readCell(gray, width, height, x, y, w, h, {
        minStd,
        minContrast,
        minCore,
      });
    }
  }
  return cells;
}

function readCell(gray, width, height, x0, y0, w, h, opts) {
  const { minStd, minContrast, minCore } = opts;
  const patch = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const src = (y0 + y) * width + x0;
    patch.set(gray.subarray(src, src + w), y * w);
  }

  const stats = meanStd(patch);
  if (stats.std < minStd) return blank();

  // 判断极性：背景应是多数像素。深底白字则反相。
  const median = histogramMedian(patch);
  if (median < 110) {
    for (let i = 0; i < patch.length; i++) patch[i] = 255 - patch[i];
  }

  const threshold = otsu(patch);
  const fg = new Uint8Array(patch.length);
  let totalInk = 0;
  let sumLo = 0;
  let nLo = 0;
  let sumHi = 0;
  let nHi = 0;
  for (let i = 0; i < patch.length; i++) {
    // 用 <= 兼容二值化后的硬边（Otsu 可能给出 0）
    if (patch[i] <= threshold) {
      fg[i] = 1;
      totalInk++;
      sumLo += patch[i];
      nLo++;
    } else {
      sumHi += patch[i];
      nHi++;
    }
  }
  if (totalInk === 0) return blank();

  // Otsu 永远会把格子分成两类——空格里的屏幕摩尔纹、压缩噪点也会被劈成
  // 一层“墨水”。但数字和背景的灰度差很大（印刷/屏幕都 >100 级），
  // 纹理通常只有十几级：两类均值差太小时，这一格没有数字。
  const contrast = (nHi ? sumHi / nHi : 0) - (nLo ? sumLo / nLo : 0);
  if (contrast < minContrast) return blank(contrast);

  // 数字的笔画很粗，细线（摩尔纹、残留格线、压缩条纹）经不起一次形态学腐蚀。
  // 用“腐蚀后还剩多少墨”区分“真的有字形”和“只有纹理”。
  const core = erode4(fg, w, h);
  let coreInk = 0;
  for (let i = 0; i < core.length; i++) coreInk += core[i];
  if (coreInk / patch.length < minCore) return blank();

  const comps = connectedComponents(fg, w, h, 2);
  const kept = comps.filter((c) => !c.touchesBorder && c.area >= 20);

  if (!kept.length) {
    // 墨迹全贴着内缩边界：这是格线残留、手机边框投下的阴影或折痕。
    // 数字在 8~11px 内缩之后离边还有十几像素，不会贴边。
    // 以前这里报“未知”，结果空格影子全变成琥珀格，让用户确认一个空格。
    return blank(contrast);
  }

  const ink = kept.reduce((s, c) => s + c.area, 0);
  const maxArea = Math.max(...kept.map((c) => c.area));
  const inkRatio = ink / patch.length;

  const bx0 = Math.min(...kept.map((c) => c.minX));
  const by0 = Math.min(...kept.map((c) => c.minY));
  const bx1 = Math.max(...kept.map((c) => c.maxX));
  const by1 = Math.max(...kept.map((c) => c.maxY));
  const bw = bx1 - bx0 + 1;
  const bh = by1 - by0 + 1;

  // 同时贴住两条（或更多）内缩边界的墨不是数字：格线残段、手机/屏幕边框
  // 的投影、纸折痕都沿格边出现，一条 20px 宽的黑条甚至会被分类器认成加粗的
  // “1”，变成错误线索。
  // 只贴住一侧是正常的：小屏上的数字可能离格子边线只有几像素（内缩后只剩
  // 4px），而数字总在格内居中，不会同时贴住两边。
  const edgePad = Math.max(5, Math.round(Math.min(w, h) * 0.07));
  let tightEdges = 0;
  if (bx0 < edgePad) tightEdges++;
  if (by0 < edgePad) tightEdges++;
  if (bx1 > w - 1 - edgePad) tightEdges++;
  if (by1 > h - 1 - edgePad) tightEdges++;
  if (tightEdges >= 2) return blank(contrast);

  // 手机屏/照片的纹理和压缩噪点会在空格里留下零碎墨点。
  // 数字的墨量明显更多、且最大连通域也更大，用这两个门槛把噪点挡在“字形”之外，
  // 否则噪点会被送进分类器，产生完全错误、且每次都不一样的盘面。
  if (inkRatio < 0.025 || maxArea < 120) return blank();

  const hRel = bh / h;
  const wRel = bw / w;
  // 数字总是“竖长”（最窄的“1”也远高于宽）。横贯格的条带几乎只能是
  // 摩尔纹、格线残留或压缩块，直接判空；过窄的竖条仍标未知，
  // 以免把字体里的细“1”悄悄丢掉。
  const aspect = bh / Math.max(1, bw);
  if (aspect < 0.55) return blank();
  if (aspect > 4.2) {
    return {
      kind: 'unknown',
      vec: null,
      bbox: { x: bx0, y: by0, w: bw, h: bh },
      inkRatio,
      contrast,
      reason: 'implausible-bbox',
    };
  }
  if (hRel < 0.3 || hRel > 0.95 || wRel < 0.1 || wRel > 0.92) {
    return {
      kind: 'unknown',
      vec: null,
      bbox: { x: bx0, y: by0, w: bw, h: bh },
      inkRatio,
      contrast,
      reason: 'implausible-bbox',
    };
  }

  const vec = normalizeGlyph(patch, w, h, { x: bx0, y: by0, w: bw, h: bh });
  if (!vec) return blank();

  return {
    kind: 'glyph',
    vec,
    bbox: { x: bx0, y: by0, w: bw, h: bh },
    inkRatio,
    contrast,
  };
}

function blank(contrast = 0) {
  return { kind: 'blank', vec: null, bbox: null, inkRatio: 0, contrast };
}

/** 4 邻域腐蚀：2px 以下的细线（摩尔纹、格线残留）和孤立噪点会被完全消掉。 */
function erode4(fg, w, h) {
  const out = new Uint8Array(fg.length);
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      if (fg[i] && fg[i - 1] && fg[i + 1] && fg[i - w] && fg[i + w]) out[i] = 1;
    }
  }
  return out;
}

function meanStd(arr) {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  const mean = sum / arr.length;
  let variance = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - mean;
    variance += d * d;
  }
  return { mean, std: Math.sqrt(variance / arr.length) };
}

function histogramMedian(arr) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < arr.length; i++) hist[arr[i]]++;
  const half = arr.length / 2;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= half) return v;
  }
  return 255;
}

export function otsu(arr) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < arr.length; i++) hist[arr[i]]++;
  const total = arr.length;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];

  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/** 4 邻域连通域；touchesBorder 用 2px 容差。 */
function connectedComponents(fg, w, h, borderTol) {
  const visited = new Uint8Array(fg.length);
  const stack = new Int32Array(fg.length);
  const comps = [];

  for (let start = 0; start < fg.length; start++) {
    if (!fg[start] || visited[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    let area = 0;
    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;
    let touchesBorder = false;

    while (sp) {
      const idx = stack[--sp];
      const x = idx % w;
      const y = (idx / w) | 0;
      area++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (x <= borderTol || y <= borderTol || x >= w - 1 - borderTol || y >= h - 1 - borderTol) {
        touchesBorder = true;
      }

      const left = idx - 1;
      if (x > 0 && fg[left] && !visited[left]) {
        visited[left] = 1;
        stack[sp++] = left;
      }
      const right = idx + 1;
      if (x < w - 1 && fg[right] && !visited[right]) {
        visited[right] = 1;
        stack[sp++] = right;
      }
      const up = idx - w;
      if (y > 0 && fg[up] && !visited[up]) {
        visited[up] = 1;
        stack[sp++] = up;
      }
      const down = idx + w;
      if (y < h - 1 && fg[down] && !visited[down]) {
        visited[down] = 1;
        stack[sp++] = down;
      }
    }

    comps.push({ area, minX, minY, maxX, maxY, touchesBorder });
  }
  return comps;
}

/**
 * 裁出数字外接框，等比缩放到长边 glyph，居中放入 size×size。
 * 再做零均值、单位 L2 归一化，作为分类器的 784 维输入（训练与线上共用）。
 */
export function normalizeGlyph(pixels, width, height, bbox, opts = {}) {
  const size = opts.size ?? 28;
  const glyph = opts.glyph ?? 22;
  const margin = opts.margin ?? 2;

  const x0 = Math.max(0, bbox.x - margin);
  const y0 = Math.max(0, bbox.y - margin);
  const x1 = Math.min(width - 1, bbox.x + bbox.w - 1 + margin);
  const y1 = Math.min(height - 1, bbox.y + bbox.h - 1 + margin);
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  if (cw <= 0 || ch <= 0) return null;

  const scale = glyph / Math.max(cw, ch);
  const tw = Math.max(1, Math.round(cw * scale));
  const th = Math.max(1, Math.round(ch * scale));
  const ox = Math.floor((size - tw) / 2);
  const oy = Math.floor((size - th) / 2);

  const out = new Float32Array(size * size);
  out.fill(255);

  for (let y = 0; y < th; y++) {
    const sy = y0 + ((y + 0.5) * ch) / th - 0.5;
    for (let x = 0; x < tw; x++) {
      const sx = x0 + ((x + 0.5) * cw) / tw - 0.5;
      out[(oy + y) * size + ox + x] = bilinear(pixels, width, height, sx, sy);
    }
  }

  let mean = 0;
  for (let i = 0; i < out.length; i++) mean += out[i];
  mean /= out.length;

  let norm = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] -= mean;
    norm += out[i] * out[i];
  }
  norm = Math.sqrt(norm);
  if (norm < 1e-6) return null;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

export function bilinear(pixels, width, height, x, y) {
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - Math.floor(x)));
  const fy = Math.max(0, Math.min(1, y - Math.floor(y)));
  const v00 = pixels[y0 * width + x0];
  const v10 = pixels[y0 * width + x1];
  const v01 = pixels[y1 * width + x0];
  const v11 = pixels[y1 * width + x1];
  return (
    v00 * (1 - fx) * (1 - fy) +
    v10 * fx * (1 - fy) +
    v01 * (1 - fx) * fy +
    v11 * fx * fy
  );
}
