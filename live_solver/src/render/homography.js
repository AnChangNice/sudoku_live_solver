// 3x3 单应矩阵（h33 固定为 1）与显示坐标变换。
// 纯 JS，便于 Node 单测；运行时不需要 OpenCV 参与叠加计算。

/**
 * 由 4 组对应点求单应矩阵，满足 dst = H * src。
 * @param {{x:number,y:number}[]} src 4 个点
 * @param {{x:number,y:number}[]} dst 4 个点
 * @returns {number[]} 长度 9，行优先
 */
export function solveHomography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: X, y: Y } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]);
    b.push(Y);
  }
  const h = solveLinear(A, b);
  if (!h) throw new Error('无法求解单应矩阵');
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function solveLinear(A, b) {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    }
    if (Math.abs(A[pivot][col]) < 1e-12) return null;
    if (pivot !== col) {
      [A[col], A[pivot]] = [A[pivot], A[col]];
      [b[col], b[pivot]] = [b[pivot], b[col]];
    }
    const p = A[col][col];
    for (let c = col; c < n; c++) A[col][c] /= p;
    b[col] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (!f) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  return b;
}

/** 应用单应矩阵。 */
export function applyH(H, x, y) {
  const d = H[6] * x + H[7] * y + H[8];
  if (Math.abs(d) < 1e-12) return { x: NaN, y: NaN };
  return {
    x: (H[0] * x + H[1] * y + H[2]) / d,
    y: (H[3] * x + H[4] * y + H[5]) / d,
  };
}

/** 复合矩阵：先应用 B，再应用 A。 */
export function composeH(A, B) {
  const C = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      C[r * 3 + c] =
        A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    }
  }
  return C;
}

/** 求逆矩阵。 */
export function invertH(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) throw new Error('单应矩阵不可逆');
  const inv = [
    e * i - f * h,
    c * h - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * h - e * g,
    b * g - a * h,
    a * e - b * d,
  ];
  return inv.map((v) => v / det);
}

/** 4 点角点排序：TL, TR, BR, BL。 */
export function orderCorners(points) {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  const arr = points
    .slice()
    .sort(
      (p, q) =>
        Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx),
    );
  let start = 0;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i].x + arr[i].y < arr[start].x + arr[start].y) start = i;
  }
  return arr.slice(start).concat(arr.slice(0, start));
}

/** 四边形平均角点距离。 */
export function cornerDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    sum += Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y);
  }
  return sum / 4;
}

/** 四边形面积（鞋带公式）。 */
export function quadArea(q) {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    area += q[i].x * q[j].y - q[j].x * q[i].y;
  }
  return Math.abs(area) / 2;
}

/** object-fit: cover / contain 下的源像素 → CSS 像素矩阵。 */
export function displayMatrix(srcW, srcH, dstW, dstH, fit = 'cover') {
  const s =
    fit === 'contain'
      ? Math.min(dstW / srcW, dstH / srcH)
      : Math.max(dstW / srcW, dstH / srcH);
  const ox = (dstW - srcW * s) / 2;
  const oy = (dstH - srcH * s) / 2;
  return [s, 0, ox, 0, s, oy, 0, 0, 1];
}
