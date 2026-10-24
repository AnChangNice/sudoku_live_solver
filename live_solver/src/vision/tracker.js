// 候选四边形的时序稳定判定：连续多帧一致才锁定，锁定后用卡尔曼滤波平滑。

import { cornerDistance, quadArea } from '../render/homography.js';

const DEFAULTS = {
  stableFrames: 4,
  stableDistance: 0.03, // 相对对角线
  maxMisses: 10,
  jumpDistance: 0.06,
  jumpFrames: 3,
  // 每一帧只接受离上一帧跟踪目标足够近的候选。超过这个距离就当作
  // “这一帧没看见原来的目标”，而不是把跟踪框滑过去。
  // 误跟到旁边更大的四边形（手机屏幕/内容区）主要靠面积门槛拦截，
  // 距离门槛不能太小：手持转动时九宫格单帧就能移动几个百分点，
  // 门槛过紧会让叠加先冻住、再跳过去，看起来就是“跟踪很慢”。
  matchDistance: 0.08,
  emaSearch: 0.5,
  // 匀速卡尔曼的噪声参数（检测分辨率下的像素）：
  // measSigma 是单帧检测到的角点抖动，accelSigma 是允许的加速度。
  // 前者越小越稳，后者越大越跟手。40 在启动/停止时会有 ~20px 的
  // 瞬态滞后（手持转动时很明显），250 把瞬态压到几像素，静态抖动
  // 仍然明显低于原始检测值。
  measSigma: 2,
  accelSigma: 250,
  nominalDt: 1 / 30,
  maxDt: 0.25,
};

export class GridTracker {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.filter = new QuadKalman(this.opts);
    this.reset();
  }

  reset() {
    this.locked = false;
    this.quad = null;
    this.stableCount = 0;
    this.missCount = 0;
    this.jumpCount = 0;
    this.diagonal = 0;
    this.filter.reset(null);
  }

  /**
   * 直接把跟踪目标换成指定四边形（检测坐标系）。
   * 用于“锁定的四边形不是九宫格”的情况：识别其实是在另一个候选上成功的，
   * 叠加必须跟着那个候选走，否则答案会画到整块屏幕/桌面上。
   */
  setQuad(points) {
    if (!points || points.length !== 4) return;
    this.quad = points.map((p) => ({ x: p.x, y: p.y }));
    this.locked = true;
    this.stableCount = this.opts.stableFrames;
    this.missCount = 0;
    this.jumpCount = 0;
    this.filter.reset(this.quad, now());
  }

  /**
   * @param {Array<{points:Array,area:number}>} candidates 面积降序
   * @param {number} diagonal 检测坐标系对角线长度
   * @param {number} [timestamp] 本帧时间（毫秒），用于卡尔曼的 dt
   */
  update(candidates, diagonal, timestamp = now()) {
    const wasLocked = this.locked;
    let justLocked = false;
    this.diagonal = diagonal;

    if (!candidates || !candidates.length) {
      this.stableCount = 0;
      this.missCount++;
      if (this.locked && this.missCount > this.opts.maxMisses) {
        this.locked = false;
        this.quad = null;
        this.filter.reset(null);
      }
      return {
        locked: this.locked,
        quad: this.quad,
        justLocked: false,
        justUnlocked: wasLocked && !this.locked,
      };
    }

    // 匹配基准用“外推到这一帧时刻”的四边形，而不是上一帧的滤波结果：
    // 手持移动时两者的差距就是这段时间的真实位移，用旧位置比较会把
    // 正常运动误判成跳变（尤其检测偶尔丢一帧时），叠加就冻住了。
    const reference = this.referenceQuad(timestamp);
    const candidate = this.choose(candidates, diagonal, reference);
    if (!candidate) {
      // 这一帧没有可以跟随的候选：原来的目标丢了，或最近的候选是
      // 手机屏幕外框/内容区之类的诱饵。锁定期间保持跟踪框不动
      // （答案也就不动），而不是滑到旁边的诱饵上；丢得久了才解锁重新找。
      const nearest = this.pick(candidates);
      const drift = this.quad ? cornerDistance(nearest.points, reference) : 0;
      this.missCount++;
      this.jumpCount =
        drift > this.opts.jumpDistance * diagonal ? this.jumpCount + 1 : 0;
      if (
        this.locked &&
        (this.jumpCount >= this.opts.jumpFrames ||
          this.missCount > this.opts.maxMisses)
      ) {
        this.locked = false;
        this.quad = null;
        this.stableCount = 0;
        this.filter.reset(null);
      } else if (!this.locked) {
        this.stableCount = 1;
        this.quad = ema(this.quad, nearest.points, this.opts.emaSearch);
        this.filter.reset(this.quad, timestamp);
      }
      return {
        locked: this.locked,
        quad: this.quad,
        justLocked: false,
        justUnlocked: wasLocked && !this.locked,
      };
    }

    const points = candidate.points;

    if (!this.locked) {
      if (this.quad) {
        const dist = cornerDistance(points, this.quad);
        const areaA = quadArea(points);
        const areaB = quadArea(this.quad);
        const areaChange = Math.abs(areaA - areaB) / Math.max(1, areaB);
        if (
          dist < this.opts.stableDistance * diagonal &&
          areaChange < 0.12
        ) {
          this.stableCount++;
        } else {
          this.stableCount = 1;
        }
        this.quad = ema(this.quad, points, this.opts.emaSearch);
      } else {
        this.stableCount = 1;
        this.quad = points;
      }

      if (this.stableCount >= this.opts.stableFrames) {
        this.locked = true;
        justLocked = true;
        this.jumpCount = 0;
        // 从锁定这一刻开始用卡尔曼：搜索阶段要的是“快速跟到候选上”，
        // 锁定后要的是“稳”。
        this.filter.reset(this.quad, timestamp);
      }
    } else {
      // 走到这里说明距离和面积都在“同一块四边形”的范围内，跟随即可。
      this.jumpCount = 0;
      this.quad = this.filter.update(points, timestamp);
    }

    this.missCount = 0;
    return {
      locked: this.locked,
      quad: this.quad,
      justLocked,
      justUnlocked: wasLocked && !this.locked,
    };
  }

  pick(candidates) {
    if (!this.quad) return candidates[0];
    let best = candidates[0];
    let bestDist = cornerDistance(candidates[0].points, this.quad);
    for (let i = 1; i < candidates.length; i++) {
      const d = cornerDistance(candidates[i].points, this.quad);
      if (d < bestDist) {
        best = candidates[i];
        bestDist = d;
      }
    }
    return best;
  }

  /**
   * 在所有候选里挑一个能跟的：按离当前跟踪框的距离排序，返回第一个
   * 通过几何门槛的。只取最近的那个会有问题——最近的是屏幕外框
   * （被尺寸/面积门槛拒绝）时，真正移动了的九宫格明明也在候选列表里，
   * 却整帧被丢掉，叠加就会先冻住再跳过去。
   */
  choose(candidates, diagonal, reference) {
    if (!this.quad) return candidates[0];
    const base = reference || this.quad;
    const sorted = candidates
      .map((c) => ({ c, d: cornerDistance(c.points, base) }))
      .sort((a, b) => a.d - b.d);
    for (const { c, d } of sorted) {
      if (this.followable(c.points, d, diagonal)) return c;
    }
    return null;
  }

  /** 当前时刻的匹配基准：锁定且已有速度时用外推位置，否则用滤波位置。 */
  referenceQuad(timestamp) {
    if (!this.quad) return null;
    if (this.locked) {
      const predicted = this.predict(timestamp);
      if (predicted) return predicted;
    }
    return this.quad;
  }

  followable(points, drift, diagonal) {
    if (drift > this.opts.matchDistance * diagonal) return false;
    // 面积突然变了 15% 以上，说明候选根本不是同一块四边形：
    // 手机 App 的“标题 + 九宫格”和九宫格只差一圈，位置可能很近（2%），
    // 但高度明显不同。只靠距离会把跟踪框滑到它上面，答案整体上移。
    const areaRatio = quadArea(points) / Math.max(1, quadArea(this.quad));
    if (areaRatio > 1.15 || areaRatio * 1.15 < 1) return false;
    // 整体放大/缩小 3% 以上同样不能跟：屏幕/窗口外框常比九宫格大
    // 2~4%，且几乎同心，角点只挪 1% 左右。跟过去答案会整体偏出半格。
    // 但这个门槛只对“几乎没移动”的候选生效：真实转动/俯仰时四边形
    // 也会连续地改变尺寸，把它挡掉会让叠加滞后甚至冻结。
    if (drift < 0.02 * diagonal) {
      const scale = edgeScaleRatio(points, this.quad);
      if (scale > 1.03 || scale < 1 / 1.03) return false;
    }
    return true;
  }

  /**
   * 按卡尔曼的速度状态预测 timestamp 时刻的四边形。叠加在两次检测
   * 之间按屏幕刷新率重绘时用它补偿检测/处理延迟；没有它，数字会
   * 按检测帧率“跳格”，转动镜头时尤其明显。
   */
  predict(timestamp = now()) {
    if (!this.locked || !this.quad || !this.filter.ready) return null;
    let dt = (timestamp - this.filter.t) / 1000;
    if (!(dt > 0)) return this.quad.map((p) => ({ x: p.x, y: p.y }));
    dt = Math.min(dt, 0.08);
    // 速度很小时不做外推，避免静止时被噪声带着慢慢漂。
    let speed = 0;
    for (let k = 0; k < 8; k += 2) {
      speed = Math.max(
        speed,
        Math.hypot(this.filter.vel[k], this.filter.vel[k + 1]),
      );
    }
    if (speed < 20) return this.quad.map((p) => ({ x: p.x, y: p.y }));
    // 外推距离上限：速度估计异常时别把叠加甩出画面（约半格封顶）。
    const maxShift = 0.06 * (this.diagonal || 1000);
    const scale = Math.min(1, maxShift / Math.max(1e-6, speed * dt));
    const out = [];
    for (let i = 0; i < 4; i++) {
      const k = i * 2;
      out.push({
        x: this.filter.pos[k] + this.filter.vel[k] * dt * scale,
        y: this.filter.pos[k + 1] + this.filter.vel[k + 1] * dt * scale,
      });
    }
    return out;
  }
}

/** 两个四边形四条对应边的平均长度比（>1 表示候选更大）。 */
function edgeScaleRatio(a, b) {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const la = Math.hypot(a[j].x - a[i].x, a[j].y - a[i].y);
    const lb = Math.hypot(b[j].x - b[i].x, b[j].y - b[i].y);
    sum += la / Math.max(1e-6, lb);
  }
  return sum / 4;
}

function ema(prev, next, alpha) {
  return next.map((p, i) => ({
    x: prev[i].x + (p.x - prev[i].x) * alpha,
    y: prev[i].y + (p.y - prev[i].y) * alpha,
  }));
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * 四个角点的匀速卡尔曼滤波：每个坐标一组 [位置, 速度] 状态。
 *
 * 固定 EMA 的取舍是“稳”和“跟手”二选一：α 小则静止不抖但移动时拖影，
 * α 大则跟手但数字一直抖。匀速模型能同时做到：位置项压抖动，速度项
 * 在移动时提前量补偿，手持平移时叠加基本不滞后。
 */
export class QuadKalman {
  constructor({ measSigma, accelSigma, nominalDt, maxDt }) {
    this.measVar = measSigma * measSigma;
    this.accVar = accelSigma * accelSigma;
    this.nominalDt = nominalDt;
    this.maxDt = maxDt;
    this.reset(null, 0);
  }

  reset(points, timestamp = 0) {
    this.ready = !!points;
    this.pos = new Float64Array(8);
    this.vel = new Float64Array(8);
    this.p00 = new Float64Array(8);
    this.p01 = new Float64Array(8);
    this.p11 = new Float64Array(8);
    this.t = timestamp;
    if (!points) return;
    for (let i = 0; i < 4; i++) {
      this.pos[i * 2] = points[i].x;
      this.pos[i * 2 + 1] = points[i].y;
    }
    for (let k = 0; k < 8; k++) {
      this.p00[k] = this.measVar;
      this.p11[k] = 1e6;
    }
  }

  update(points, timestamp) {
    if (!this.ready) {
      this.reset(points, timestamp);
      return points.map((p) => ({ x: p.x, y: p.y }));
    }
    // 单测里的紧循环两帧间隔接近 0，按标称帧间隔算；切换分辨率/掉帧
    // 时 dt 可能很大，截断避免速度项把跟踪框预测得太远。
    let dt = (timestamp - this.t) / 1000;
    if (!(dt > 0.004)) dt = this.nominalDt;
    dt = Math.min(dt, this.maxDt);
    this.t = timestamp;

    const q = this.accVar;
    const q00 = (q * dt * dt * dt) / 3;
    const q01 = (q * dt * dt) / 2;
    const q11 = q * dt;
    const out = [];
    for (let i = 0; i < 4; i++) {
      out.push({
        x: this.step(i * 2, points[i].x, dt, q00, q01, q11),
        y: this.step(i * 2 + 1, points[i].y, dt, q00, q01, q11),
      });
    }
    return out;
  }

  step(k, z, dt, q00, q01, q11) {
    const xp = this.pos[k] + this.vel[k] * dt;
    const P00 = this.p00[k] + 2 * dt * this.p01[k] + dt * dt * this.p11[k] + q00;
    const P01 = this.p01[k] + dt * this.p11[k] + q01;
    const P11 = this.p11[k] + q11;
    const S = P00 + this.measVar;
    const K0 = P00 / S;
    const K1 = P01 / S;
    const y = z - xp;
    this.pos[k] = xp + K0 * y;
    this.vel[k] += K1 * y;
    this.p00[k] = (1 - K0) * P00;
    this.p01[k] = (1 - K0) * P01;
    this.p11[k] = P11 - K1 * P01;
    return this.pos[k];
  }
}
