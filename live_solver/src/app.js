// 应用状态机：实时检测 → 锁定 → 高清识别 → 求解 → 叠加；以及定格/照片/编辑。

import { Vision, warpCorners } from './vision/pipeline.js';
import { GridTracker } from './vision/tracker.js';
import { CameraSource } from './sources/camera.js';
import { loadImageToCanvas } from './sources/image.js';
import { Overlay, buildDisplayProjection } from './render/overlay.js';
import {
  solveHomography,
  applyH,
  cornerDistance,
} from './render/homography.js';
import {
  recognizeCells,
  mergeConsensus,
  toGrid,
  toGuessGrid,
  SENSITIVITY,
} from './vision/recognize.js';
import { solve, findConflicts } from './solver.js';
import { ReadStabilizer } from './vision/stable-read.js';
import { CONFIG } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class App {
  constructor({ cv, cfg, ui, recognizer }) {
    this.cv = cv;
    this.cfg = cfg;
    this.ui = ui;
    this.model = recognizer.model;

    this.video = document.getElementById('video');
    this.frozen = document.getElementById('frozen');
    this.frozenCtx = this.frozen.getContext('2d', { willReadFrequently: true });
    this.overlay = new Overlay(document.getElementById('overlay'));
    this.camera = new CameraSource(this.video);
    this.vision = new Vision(cv, cfg);
    this.tracker = new GridTracker();

    this.mode = 'idle'; // idle | live | static
    this.fit = 'cover';
    this.photoMode = false;
    this.reading = false;
    this.staticW = 0;
    this.staticH = 0;
    this.currentProjection = null;

    this.settings = ui.getSettings();
    this.frameInterval = frameIntervalFor(this.settings.fps);
    this.lastDetect = 0;
    // 实际处理帧率（最近 30 次检测的滑动平均），调试 HUD 里和设定值对照。
    this.detectStamps = [];
    this.actualFps = 0;
    this.failStreak = 0;
    this.readCooldown = 0;
    this.lastQuads = [];
    this.lastDetectDims = null;

    // 每次锁定视为一次“读取会话”：none 未读 / failed 校验失败 / done 已出结果。
    // 早期版本只在 justLocked 那一帧尝试读取，一旦那次读取失败（或撞上冷却），
    // 就会永远停在“已锁定，准备识别…”。现在只要会话没完成就持续重试。
    this.readState = 'none';
    this.readFailUntil = 0;
    this.badQuads = [];
    // 上一次成功读取的目标，用于判断“重新锁定的还是不是同一块题”
    this.lastReadQuad = null;
    this.lastReadAt = 0;
    // 最近一次仍处于锁定状态的时刻。锁定短暂丢失时用它决定叠加是
    // “再等一帧”还是“真的丢了，该淡出”，避免把旧答案钉在别的画面上。
    this.lastLockedAt = 0;

    this.results = null;
    this.grid = null;
    this.guessGrid = null;
    this.unknown = null;
    this.solveResult = null;
    this.solution = null;
    this.conflicts = [];
    // 用户手工改过的格子（index → 值，0 表示“这里是空的”）。重新识别同一道题
    // 时优先采用，避免“改完一按继续，又被新读数覆盖、又弹待确认”。
    this.fixes = new Map();
    // 上一次读取的原始盘面（未叠加手工修改），用来判断新读的是不是同一道题。
    this.readGrid = null;
    // 同一道题多次重读之间的时序稳定：相机读数会在相邻两次之间翻转
    // （同一格这次读 4、下次读 2），盘面一抖，答案和待确认框就跟着跳。
    this.stabilizer = new ReadStabilizer();

    this.trackerQuad = null;
    this.torchOn = false;
    this.wakeLock = null;
    this.debug = false;
    this.lastMetrics = { detect: 0, read: 0 };

    this.loop = this.loop.bind(this);
  }

  init() {
    this.ui.bind({
      onStart: () => this.startCamera(),
      onPickPhoto: () => this.ui.el.fileInput.click(),
      onRetry: () => this.startCamera(),
      onPhoto: (file) => this.loadPhoto(file),
      onFreeze: () => this.toggleFreeze(),
      onSwitch: () => this.switchCamera(),
      onTorch: () => this.toggleTorch(),
      onEdit: () => this.openEditor(),
      onCloseEdit: () => this.ui.closeEditPanel(),
      onDoneEdit: () => this.ui.closeEditPanel(),
      onReread: () => this.reread(),
      onIgnoreUnknown: () => this.ignoreUnknownCells(),
      onCellEdit: (i, v) => this.editCell(i, v),
      onSettings: (s) => this.applySettings(s),
      onSaveWarp: () => this.downloadWarp(),
    });

    this.applySettings(this.ui.getSettings());
    this.setupResize();
    requestAnimationFrame(this.loop);
  }

  setupResize() {
    const stage = this.ui.el.stage;
    this.resizeObserver = new ResizeObserver(() => this.resizeOverlay());
    this.resizeObserver.observe(stage);
    window.addEventListener('orientationchange', () => {
      setTimeout(() => this.resizeOverlay(), 180);
    });
    this.resizeOverlay();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.applyWakeLock();
    });
  }

  resizeOverlay() {
    const rect = this.ui.el.stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.overlay.resize(
      rect.width,
      rect.height,
      window.devicePixelRatio || 1,
    );
    this.refreshProjection();
  }

  refreshProjection() {
    if (!this.currentProjection) return;
    const { quadSource, sw, sh, fit } = this.currentProjection;
    this.applyProjection(quadSource, sw, sh, fit);
  }

  // ---------------------------------------------------------------- 摄像头

  async startCamera() {
    this.ui.hideError();
    this.ui.setState('正在启动摄像头…', 'info');
    try {
      await this.camera.start({ facingMode: 'environment' });
    } catch (err) {
      this.ui.showError(
        err?.message || '无法访问摄像头，请允许权限并使用 HTTPS 打开页面',
      );
      return;
    }

    this.ui.hideGate();
    this.ui.hideError();
    this.ui.showBars();
    this.ui.setFrozen(false);
    this.ui.setTorchVisible(this.camera.hasTorch());

    this.mode = 'live';
    this.fit = 'cover';
    this.photoMode = false;
    this.video.style.visibility = 'visible';
    this.video.style.objectFit = 'cover';
    this.frozen.hidden = true;
    this.resetLiveState();
    this.applyWakeLock();
    this.ui.setState('对准数独网格…', 'info');
    if (this.debug) this.updateDebug();
  }

  resetLiveState() {
    this.tracker.reset();
    this.trackerQuad = null;
    this.results = null;
    this.grid = null;
    this.guessGrid = null;
    this.unknown = null;
    this.solveResult = null;
    this.solution = null;
    this.conflicts = [];
    this.fixes.clear();
    this.readGrid = null;
    this.resetReadStability();
    this.currentProjection = null;
    this.overlay.setProjection(null);
    this.overlay.setData({ solution: null });
    this.overlay.targetAlpha = 0;
    this.lastDetect = 0;
    this.detectStamps = [];
    this.actualFps = 0;
    this.failStreak = 0;
    this.readCooldown = 0;
    this.lastQuads = [];
    this.readState = 'none';
    this.readFailUntil = 0;
    this.badQuads = [];
    this.lastReadQuad = null;
    this.lastReadAt = 0;
    this.lastLockedAt = 0;
  }

  /**
   * 从定格/编辑回到实时，但保留已经读出的盘面（含手工修改）。
   * 重新锁定到同一块题时直接恢复叠加，不再重读；只有目标明显变了才重读。
   */
  resumeLiveState() {
    this.tracker.reset();
    this.trackerQuad = null;
    this.currentProjection = null;
    this.overlay.setProjection(null);
    this.overlay.setData({
      solution: this.solution,
      grid: this.grid,
      unknown: this.unknown,
    });
    this.overlay.targetAlpha = 0;
    this.lastDetect = 0;
    this.detectStamps = [];
    this.actualFps = 0;
    this.failStreak = 0;
    this.readCooldown = 0;
    this.lastQuads = [];
    this.readFailUntil = 0;
    this.badQuads = [];
    // 编辑可能花了几分钟，sameTarget 的 15s 窗口从现在重新算。
    this.lastReadAt = performance.now();
    this.lastLockedAt = 0;
  }

  async switchCamera() {
    if (this.mode !== 'live') {
      this.ui.toast('请先回到实时模式再切换摄像头');
      return;
    }
    try {
      const devices = await this.camera.listDevices();
      const current = this.camera.currentDeviceId();
      if (devices.length > 1) {
        const idx = devices.findIndex((d) => d.deviceId === current);
        const next = devices[(idx + 1 + devices.length) % devices.length];
        await this.camera.start({ deviceId: next.deviceId });
      } else {
        const facing =
          this.camera.facingMode === 'environment' ? 'user' : 'environment';
        await this.camera.start({ facingMode: facing });
      }
    } catch (err) {
      this.ui.toast(err?.message || '切换摄像头失败');
      return;
    }
    this.ui.setTorchVisible(this.camera.hasTorch());
    this.torchOn = false;
    this.resetLiveState();
    this.ui.setState('对准数独网格…', 'info');
  }

  async toggleTorch() {
    if (this.mode !== 'live') return;
    this.torchOn = !this.torchOn;
    const ok = await this.camera.setTorch(this.torchOn);
    if (!ok) {
      this.torchOn = false;
      this.ui.toast('该设备不支持手电筒');
    }
  }

  // ---------------------------------------------------------------- 主循环

  loop(ts) {
    requestAnimationFrame(this.loop);
    // 检测只有十几到几十 fps，叠加却跟着屏幕刷新率走。两次检测之间
    // 按卡尔曼的速度外推四边形，否则转动镜头时答案会明显落后于纸面。
    this.predictProjection(ts);
    this.overlay.render(ts);

    if (this.mode !== 'live' || this.reading) return;
    if (!this.video.videoWidth || !this.video.videoHeight) return;
    if (ts - this.lastDetect < this.frameInterval) return;

    this.lastDetect = ts;
    this.detectStamps.push(ts);
    if (this.detectStamps.length > 31) this.detectStamps.shift();
    const span = ts - this.detectStamps[0];
    if (this.detectStamps.length >= 8 && span > 0) {
      this.actualFps = ((this.detectStamps.length - 1) * 1000) / span;
    }
    try {
      this.detectTick();
    } catch (err) {
      console.error(err);
      this.ui.setState(`识别出错：${err?.message || err}`, 'error');
    }
  }

  detectTick() {
    const src = this.video;
    const sw = src.videoWidth;
    const sh = src.videoHeight;

    const t0 = performance.now();
    const { quads, PW, PH } = this.vision.detect(src, sw, sh, {
      fallback: this.failStreak >= 2,
    });
    // 帧是在 detect 开头抓的，处理耗时几十毫秒；让时间戳对应“画面
    // 拍摄时刻”，两次检测之间的外推才能把这段延迟补回来。
    const frameTs = t0;
    this.lastMetrics.detect = performance.now() - t0;
    this.failStreak = quads.length ? 0 : this.failStreak + 1;

    const diagonal = Math.hypot(PW, PH);
    // 读校验失败过的四边形（手机屏幕边框、桌面边缘等）先冷处理一会儿，
    // 否则会一直锁定同一个错误目标、反复失败。
    const usable = this.activeQuads(quads, diagonal);
    this.lastQuads = usable;
    this.lastDetectDims = { PW, PH, sw, sh };

    const state = this.tracker.update(usable, diagonal, frameTs);

    if (state.locked && state.quad) {
      this.trackerQuad = state.quad;
      this.lastLockedAt = performance.now();
      this.applyProjection(
        state.quad.map((p) => ({ x: (p.x * sw) / PW, y: (p.y * sh) / PH })),
        sw,
        sh,
        'cover',
      );

      // 重新锁定通常只是跟踪抖动，不一定要重读：同一块题、刚读过、位置也没大挪动，
      // 就保留现有结果，避免手持时答案反复重算、来回跳。
      // 真正换了题（位置明显变了）才开启新的读取会话。
      if (state.justLocked && !this.sameTarget(state.quad, PW, PH)) {
        this.readState = 'none';
      }

      if (this.readState === 'done') {
        // 跟踪短暂丢失会让叠加淡出；重新锁定同一块题时必须恢复显示，
        // 否则答案会一直不回来（因为不再重读）。
        this.overlay.targetAlpha = this.solution ? 1 : 0;
        this.updateStatus();
      } else if (!this.reading && performance.now() >= this.readCooldown) {
        this.startLiveRead(usable, state.quad, sw, sh, PW, PH);
      } else if (!this.reading) {
        this.ui.setState(
          this.readState === 'failed'
            ? '未识别到九宫格，请对准并避免反光'
            : '已锁定，准备识别…',
          this.readState === 'failed' ? 'warn' : 'info',
        );
      }
    } else {
      // 锁定刚断的一小段时间里先保留叠加，避免短暂丢失（细线、遮挡）
      // 让答案闪一下；但如果跟踪真的丢了，就赶紧淡出——把旧答案钉在
      // 已经移开的画面上，看起来就是“叠加跟不上镜头”。
      const hold =
        this.readState === 'done' &&
        this.solution &&
        performance.now() - this.lastLockedAt < 250;
      if (hold) {
        this.updateStatus();
      } else {
        this.overlay.targetAlpha = 0;
        if (
          this.readState === 'failed' &&
          performance.now() < this.readFailUntil
        ) {
          this.ui.setState('未识别到九宫格，请对准并避免反光', 'warn');
        } else {
          this.ui.setState(
            usable.length ? '保持稳定…' : '对准数独网格…',
            'info',
          );
        }
      }
    }

    if (this.debug) this.updateDebug();
  }

  /**
   * 每帧用卡尔曼外推的四边形刷新投影。检测帧率低于屏幕刷新率时，
   * 没有这一步叠加就只能按检测节奏“跳格”，手持转动尤其明显。
   * 只在实时模式、已锁定、且最近有检测结果时做；定格/编辑不做。
   */
  predictProjection(ts) {
    if (this.mode !== 'live' || this.reading) return;
    if (!this.tracker.locked || !this.lastDetectDims) return;
    const quad = this.tracker.predict(ts);
    if (!quad) return;
    const { PW, PH, sw, sh } = this.lastDetectDims;
    this.applyProjection(
      quad.map((p) => ({ x: (p.x * sw) / PW, y: (p.y * sh) / PH })),
      sw,
      sh,
      'cover',
    );
  }

  /** 过滤掉近期校验失败过的候选四边形。 */
  activeQuads(quads, diagonal) {
    const now = performance.now();
    if (!this.badQuads.length) return quads;
    this.badQuads = this.badQuads.filter((q) => q.until > now);
    if (!this.badQuads.length) return quads;
    return quads.filter(
      (q) =>
        !this.badQuads.some(
          (bad) => cornerDistance(q.points, bad.points) < 0.03 * diagonal,
        ),
    );
  }

  blockQuad(points, diagonal) {
    this.badQuads.push({
      points: points.map((p) => ({ x: p.x, y: p.y })),
      until: performance.now() + 2500,
    });
    if (this.badQuads.length > 8) this.badQuads.shift();
  }

  /**
   * 重新锁定的目标是否就是刚读过的那块题（位置几乎没变、且刚读过）。
   * 用归一化坐标比较：实拍重读和定格重读的分辨率不同，像素坐标没法直接比。
   */
  sameTarget(quad, PW, PH) {
    if (this.readState !== 'done' || !this.lastReadQuad) return false;
    if (performance.now() - this.lastReadAt > 15000) return false;
    const norm = quad.map((p) => ({ x: p.x / PW, y: p.y / PH }));
    // 原来的阈值是 2.5% 对角线；归一化后对角线上限约 1.414。
    return cornerDistance(norm, this.lastReadQuad) < 0.025 * Math.SQRT2;
  }

  startLiveRead(quads, trackedQuad, sw, sh, PW, PH) {
    if (performance.now() < this.readCooldown) return;
    this.reading = true;
    this.ui.setState('正在识别数字…', 'reading');
    this.overlay.targetAlpha = 0;

    const candidates = [trackedQuad, ...quads.map((q) => q.points)];

    setTimeout(() => {
      try {
        this.doLiveRead(candidates, sw, sh, PW, PH);
      } catch (err) {
        console.error(err);
        this.readState = 'failed';
        this.readFailUntil = performance.now() + 2000;
        this.readCooldown = performance.now() + 1200;
        this.ui.setState('识别失败，请重试', 'error');
      } finally {
        this.reading = false;
      }
    }, 25);
  }

  doLiveRead(candidates, sw, sh, PW, PH) {
    const t0 = performance.now();
    let chosen = null;
    const tried = [];

    for (const quad of dedupeQuads(candidates)) {
      tried.push(quad);
      const res = this.vision.read(this.video, sw, sh, quad, PW, PH);
      if (res.ok) {
        chosen = res;
        break;
      }
    }

    // 当前候选都不过校验时，再做加力检测。两招按代价从小到大：
    // 1) 同分辨率换更强的二值化（Canny + 更低阈值 + 更多候选）；
    // 2) 提高检测分辨率 —— 屏幕上的细格线在检测尺寸下会整块消失，
    //    同一帧放大到 1200 就能干净检出。定格能识别、实时识别不出就是这一条。
    if (!chosen) {
      const passes = [
        { fallback: true, deep: true, maxCandidates: 6 },
        {
          fallback: true,
          longSide: Math.max(this.cfg.detectLongSide, this.cfg.detectLongSideStatic),
          maxCandidates: 6,
        },
      ];
      for (const opts of passes) {
        const fresh = this.vision.detect(this.video, sw, sh, opts);
        for (const q of fresh.quads) {
          // 换分辨率后候选坐标的坐标系也变了，拉黑时要换算回跟踪坐标系。
          tried.push(
            q.points.map((p) => ({
              x: (p.x * PW) / fresh.PW,
              y: (p.y * PH) / fresh.PH,
            })),
          );
          const res = this.vision.read(
            this.video,
            sw,
            sh,
            q.points,
            fresh.PW,
            fresh.PH,
          );
          if (res.ok) {
            chosen = res;
            break;
          }
        }
        if (chosen) break;
      }
    }

    if (!chosen) {
      const diagonal = Math.hypot(PW, PH);
      for (const quad of tried) this.blockQuad(quad, diagonal);
      this.readState = 'failed';
      this.readFailUntil = performance.now() + 2200;
      this.readCooldown = performance.now() + 1200;
      this.tracker.reset();
      this.ui.setState('未识别到九宫格，请对准并避免反光', 'warn');
      this.overlay.targetAlpha = 0;
      return;
    }

    this.readState = 'done';
    this.badQuads = [];
    // 归一化保存，定格读取（另一套分辨率）也能和实时跟踪的四边形比较。
    this.lastReadQuad = chosen.quadSource.map((p) => ({
      x: p.x / sw,
      y: p.y / sh,
    }));
    this.lastReadAt = performance.now();
    this.lastMetrics.read = performance.now() - t0;
    this.readCooldown = performance.now() + 800;
    // 读取可能是在另一个候选上成功的（锁定的那个过不了格线校验）。
    // 叠加必须以真正读到数字的四边形为准，并让跟踪器改盯它，
    // 否则会出现“答案铺满整个屏幕/桌面”的错位。
    this.tracker.setQuad(
      chosen.quadSource.map((p) => ({
        x: (p.x * PW) / sw,
        y: (p.y * PH) / sh,
      })),
    );
    this.applyReadResult(chosen, sw, sh, 'cover');
    this.applyProjection(chosen.quadSource, sw, sh, 'cover');
  }

  applyReadResult(res, sw, sh, fit) {
    const thresholds =
      SENSITIVITY[this.settings.sensitivity] || SENSITIVITY.medium;
    const a = recognizeCells(res.cellsA, this.model, thresholds);
    const b = recognizeCells(res.cellsB, this.model, thresholds);
    const merged = mergeConsensus(a, b);

    const rawGrid = toGrid(merged);
    const guessGrid = toGuessGrid(merged);

    // 同一道题的重读：用户改过的格子优先，不能又被新读数覆盖。
    // 换了题（线索大部分对不上）才丢弃旧的修改和稳定历史。
    const samePuzzle =
      this.readGrid != null && gridOverlap(this.readGrid, rawGrid) >= 0.5;
    this.readGrid = Uint8Array.from(rawGrid);
    if (!samePuzzle) {
      this.fixes.clear();
      this.resetReadStability();
    }

    // 同一块题连续读：把这次读数和上一份“已确认”盘面做时序融合，
    // 单次异常读数（4↔2）不会立刻改写答案。
    const { grid, unknown } = this.stabilizer.apply(rawGrid, merged);
    for (const [i, value] of this.fixes) {
      grid[i] = value;
      unknown[i] = 0;
      merged[i] = value
        ? { kind: 'digit', value, guess: value, score: 1, margin: 1, confidence: 1 }
        : { kind: 'blank', value: 0, guess: 0, score: 0, margin: 0, confidence: 1 };
    }
    const unknownCount = countTrue(unknown);

    const solved = solve(grid);
    const givenCount = countTrue(grid);

    this.results = merged;
    this.grid = grid;
    this.guessGrid = guessGrid;
    this.unknown = unknown;
    this.solveResult = solved;
    this.conflicts = solved.conflicts || [];
    // 一个数字都没读到时不要把空盘的“解”盖上去：那会画出 81 个毫无依据的数字。
    this.solution =
      givenCount &&
      (solved.status === 'solved' || solved.status === 'ambiguous')
        ? solved.solution
        : null;

    this.overlay.setData({ solution: this.solution, grid, unknown });
    this.updateStatus();

    if (unknownCount > 0) {
      this.ui.toast(
        `有 ${unknownCount} 格字迹没认出来，点“编辑”可确认或都当空格`,
        2600,
      );
    }
    if (this.debug) this.updateDebug();
  }

  resetReadStability() {
    this.stabilizer.reset();
  }

  updateStatus() {
    const s = this.solveResult;
    if (!s) return;
    const unknownCount = countTrue(this.unknown);
    const filled = this.solution
      ? countFilled(this.grid, this.solution, this.unknown)
      : 0;

    if (!countTrue(this.grid)) {
      this.ui.setState('未识别到数字，请让九宫格占满画面', 'warn');
      return;
    }

    if (s.status === 'solved' || s.status === 'ambiguous') {
      let text;
      if (filled) {
        text = `已求解 · 填入 ${filled} 格`;
        if (unknownCount) text += ` · ${unknownCount} 格待确认`;
      } else if (unknownCount) {
        // 题面已经填满，只差这几格没认出来：别显示“填入 0 格”，
        // 引导去编辑面板确认。
        text = `已读取 · ${unknownCount} 格待确认`;
      } else {
        text = '已读取 · 盘面完整';
      }
      if (s.status === 'ambiguous') text += ' · 可能多解';
      this.ui.setState(text, unknownCount ? 'warn' : 'ok');
    } else if (s.status === 'invalid') {
      this.ui.setState('盘面有冲突，请打开“编辑”校对', 'error');
    } else if (s.status === 'unsolvable') {
      this.ui.setState('无解，请打开“编辑”校对', 'error');
    } else {
      this.ui.setState('搜索超限，请检查盘面', 'warn');
    }
  }

  // ---------------------------------------------------------------- 定格 / 照片

  async toggleFreeze() {
    if (this.mode === 'static') {
      this.resumeLive();
    } else {
      await this.freeze();
    }
  }

  async freeze() {
    if (this.mode !== 'live' || !this.video.videoWidth) return;
    this.captureSnapshot();
    this.mode = 'static';
    this.fit = 'cover';
    this.photoMode = false;
    this.frozen.style.objectFit = 'cover';
    this.frozen.hidden = false;
    this.video.style.visibility = 'hidden';
    this.ui.setFrozen(true);
    this.ui.showBars();
    this.overlay.setProjection(null);
    this.overlay.targetAlpha = 0;
    this.currentProjection = null;
    this.tracker.reset();
    await this.analyzeStatic();
  }

  captureSnapshot() {
    const sw = this.video.videoWidth;
    const sh = this.video.videoHeight;
    const scale = Math.min(1, this.cfg.readLongSide / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    this.frozen.width = w;
    this.frozen.height = h;
    this.frozenCtx.drawImage(this.video, 0, 0, w, h);
    this.staticW = w;
    this.staticH = h;
  }

  async analyzeStatic() {
    // 实时读取可能正在收尾（定格恰好发生在识别过程中）：等它结束，
    // 否则这里直接 return，定格后就永远停在“正在识别数字…”。
    const deadline = performance.now() + 3000;
    while (this.reading && performance.now() < deadline) await sleep(40);
    if (this.reading) return;

    this.reading = true;
    this.ui.setState('正在识别数字…', 'reading');
    await sleep(20);

    try {
      const src = this.frozen;
      const sw = src.width;
      const sh = src.height;
      if (!sw || !sh) return;

      const t0 = performance.now();
      const det = this.vision.detect(src, sw, sh, {
        longSide: this.cfg.detectLongSideStatic,
        fallback: true,
      });

      let chosen = null;
      for (const q of det.quads) {
        const res = this.vision.read(src, sw, sh, q.points, det.PW, det.PH);
        if (res.ok) {
          chosen = res;
          break;
        }
      }

      if (!chosen) {
        this.readState = 'failed';
        this.ui.setState('未识别到九宫格，请重拍或调整角度', 'warn');
        this.overlay.setData({ solution: null });
        this.currentProjection = null;
        return;
      }

      this.readState = 'done';
      this.badQuads = [];
      this.lastMetrics.read = performance.now() - t0;
      // 定格读到的也是同一块题：记下它的位置（归一化），回到实时后
      // 跟踪器重新锁定时才能认出“还是它”，从而不必重读、不丢手工修改。
      this.lastReadQuad = chosen.quadSource.map((p) => ({
        x: p.x / sw,
        y: p.y / sh,
      }));
      this.lastReadAt = performance.now();
      this.applyReadResult(chosen, sw, sh, this.fit);
      this.applyProjection(chosen.quadSource, sw, sh, this.fit);
    } finally {
      this.reading = false;
      if (this.debug) this.updateDebug();
    }
  }

  resumeLive() {
    if (!this.camera.stream) {
      this.ui.toast('请先开启摄像头再回到实时模式');
      return;
    }
    this.mode = 'live';
    this.fit = 'cover';
    this.photoMode = false;
    this.frozen.hidden = true;
    this.video.style.visibility = 'visible';
    this.ui.setFrozen(false);
    this.ui.closeEditPanel();
    if (this.readState === 'done' && this.grid) {
      // 定格/编辑过再回来：保留盘面与手工修改，同一块题直接恢复叠加。
      // 以前这里无条件清空状态、强制重读，用户改的格子和“都当空格”的
      // 处理一按“继续”就全丢了，还会重新弹出“待确认”。
      this.resumeLiveState();
    } else {
      this.resetLiveState();
    }
    this.ui.setState('对准数独网格…', 'info');
  }

  async loadPhoto(file) {
    try {
      // 换图 = 换题：上一题的手工修改和稳定读数不能带过来。
      this.fixes.clear();
      this.readGrid = null;
      this.resetReadStability();
      this.ui.hideGate();
      this.ui.hideError();
      this.ui.showBars();
      this.ui.setState('正在读取照片…', 'info');
      await loadImageToCanvas(file, this.frozen, this.cfg.readLongSide);

      this.mode = 'static';
      this.photoMode = true;
      this.fit = 'contain';
      this.staticW = this.frozen.width;
      this.staticH = this.frozen.height;
      this.frozen.style.objectFit = 'contain';
      this.frozen.hidden = false;
      this.video.style.visibility = 'hidden';
      this.ui.setFrozen(true);
      this.overlay.setProjection(null);
      this.overlay.setData({ solution: null });
      this.overlay.targetAlpha = 0;
      this.currentProjection = null;
      this.tracker.reset();

      await this.analyzeStatic();
    } catch (err) {
      console.error(err);
      this.ui.setState('照片读取失败，请换一张', 'error');
    }
  }

  // ---------------------------------------------------------------- 编辑

  async openEditor() {
    if (this.mode === 'live') {
      await this.freeze();
    }

    if (!this.grid) {
      this.grid = new Uint8Array(81);
      this.guessGrid = new Uint8Array(81);
      this.unknown = new Uint8Array(81);
      this.results = null;
      this.solveResult = solve(this.grid);
      // 空盘也能“解出”一个盘面，但那是凭空生成的，不能画出来。
      this.solution = countTrue(this.grid) ? this.solveResult.solution : null;
      this.conflicts = [];
      this.overlay.setData({
        solution: this.solution,
        grid: this.grid,
        unknown: this.unknown,
      });
    }

    this.ui.openEditPanel();
    this.renderEditor();
  }

  editCell(index, value) {
    if (!this.grid) this.grid = new Uint8Array(81);
    this.grid[index] = value;
    if (this.unknown) this.unknown[index] = 0;
    // 记住用户的选择（包括“清除”= 0）：同一道题下次重读时不能被覆盖。
    this.fixes.set(index, value);

    this.solveResult = solve(this.grid);
    this.conflicts = this.solveResult.conflicts || [];
    this.solution =
      this.solveResult.status === 'solved' ||
      this.solveResult.status === 'ambiguous'
        ? this.solveResult.solution
        : null;

    this.overlay.setData({
      solution: this.solution,
      grid: this.grid,
      unknown: this.unknown,
    });
    this.updateStatus();
    this.renderEditor();
    if (this.debug) this.updateDebug();
  }

  /**
   * “都当空格”：把这些有墨但没认出来的格子确认成空。
   * 求解本来就按空格算，所以只需撤掉待确认标记、把选择记进 fixes，
   * 之后同一道题重读也不会再弹出来。
   */
  ignoreUnknownCells() {
    if (!this.unknown) return;
    const n = countTrue(this.unknown);
    if (!n) return;
    for (let i = 0; i < 81; i++) {
      if (!this.unknown[i]) continue;
      this.unknown[i] = 0;
      this.fixes.set(i, 0);
      if (this.results) {
        this.results[i] = {
          kind: 'blank', value: 0, guess: 0, score: 0, margin: 0, confidence: 1,
        };
      }
    }
    this.overlay.setData({
      solution: this.solution,
      grid: this.grid,
      unknown: this.unknown,
    });
    this.renderEditor();
    this.updateStatus();
    this.ui.toast(`已把 ${n} 格按空格处理`);
    if (this.debug) this.updateDebug();
  }

  renderEditor() {
    const conflicts =
      this.conflicts && this.conflicts.length
        ? this.conflicts
        : findConflicts(this.grid || new Uint8Array(81));
    this.ui.renderEditor({
      grid: this.grid,
      details: this.results,
      conflicts,
      unknown: this.unknown,
    });

    const unknownCount = countTrue(this.unknown);
    if (conflicts.length) {
      this.ui.setEditHint(
        `有 ${conflicts.length} 格冲突（红色），请修改后再求解`,
      );
    } else if (unknownCount) {
      this.ui.setEditHint(
        `${unknownCount} 格有字迹但没认出是几：琥珀色框里的小字是猜的，点格子可确认；` +
          '如果那里本来就是空的，点“都当空格”。',
      );
    } else {
      this.ui.setEditHint('点击格子可修改；修改后答案会立即更新');
    }
  }

  async reread() {
    // “重新识别”以画面为准：丢弃手工修改和稳定历史，否则固定值会立刻
    // 覆盖新读数，按了按钮却像没反应。
    this.fixes.clear();
    this.resetReadStability();
    if (this.mode !== 'static') {
      if (!this.tracker.locked || !this.trackerQuad || !this.lastDetectDims) {
        this.ui.toast('请先把镜头对准数独并保持稳定');
        return;
      }
      const { PW, PH, sw, sh } = this.lastDetectDims;
      // 手动重读：跳过冷却与黑名单，让用户点一下就有反应。
      this.readCooldown = 0;
      this.readState = 'none';
      this.badQuads = [];
      this.startLiveRead(this.lastQuads, this.trackerQuad, sw, sh, PW, PH);
      return;
    }
    await this.analyzeStatic();
    if (this.ui.isEditOpen()) this.renderEditor();
  }

  // ---------------------------------------------------------------- 投影 / 调试

  applyProjection(quadSource, sw, sh, fit) {
    const Hwp = solveHomography(warpCorners(this.cfg.warpSize), quadSource);
    const { Hcss, T } = buildDisplayProjection(
      Hwp,
      sw,
      sh,
      this.overlay.cssW,
      this.overlay.cssH,
      fit,
    );
    this.overlay.setProjection(Hcss);
    this.currentProjection = {
      quadSource: quadSource.map((p) => ({ x: p.x, y: p.y })),
      sw,
      sh,
      fit,
    };

    if (this.debug) {
      // 绿色 = 这个四边形已经通过格线校验、答案按它绘制；
      // 琥珀色 = 只是跟踪到了，还没确认是不是九宫格（别误读成“已识别”）。
      this.overlay.setDebugQuad(
        quadSource.map((p) => applyH(T, p.x, p.y)),
        this.readState === 'done',
      );
    } else {
      this.overlay.setDebugQuad(null);
    }
  }

  /** 把最近一次透视校正后的 900×900 图存成 PNG（排查识别问题用）。 */
  downloadWarp() {
    const warp = this.vision.lastWarp;
    if (!warp) {
      this.ui.toast('还没有识别结果，请先对准题目');
      return;
    }
    const { data, size } = warp;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(size, size);
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      image.data[i * 4] = v;
      image.data[i * 4 + 1] = v;
      image.data[i * 4 + 2] = v;
      image.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);

    canvas.toBlob((blob) => {
      if (!blob) {
        this.ui.toast('保存失败，请重试');
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sudoku-warp-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      this.ui.toast('识别图已保存');
    }, 'image/png');
  }

  // ---------------------------------------------------------------- 设置

  applySettings(settings) {
    this.settings = { ...settings };
    this.frameInterval = frameIntervalFor(settings.fps);
    this.detectStamps = [];
    this.actualFps = 0;
    this.overlay.highlightUnknown = !!settings.highlight;
    this.debug = !!settings.debug;
    if (this.debug) {
      this.updateDebug();
    } else {
      this.ui.setDebug(null);
      this.overlay.setDebugQuad(null);
    }
    this.applyWakeLock();
  }

  async applyWakeLock() {
    try {
      if (this.settings.wakelock && 'wakeLock' in navigator) {
        if (!this.wakeLock) {
          this.wakeLock = await navigator.wakeLock.request('screen');
          this.wakeLock.addEventListener?.('release', () => {
            this.wakeLock = null;
          });
        }
      } else if (this.wakeLock) {
        await this.wakeLock.release();
        this.wakeLock = null;
      }
    } catch {
      // 浏览器不支持或用户拒绝时忽略
    }
  }

  updateDebug() {
    if (!this.debug) {
      this.ui.setDebug(null);
      return;
    }
    const s = this.solveResult;
    const lines = [
      `mode ${this.mode}  video ${this.camera.width}×${this.camera.height}`,
      `detect ${this.lastMetrics.detect.toFixed(1)}ms  read ${this.lastMetrics.read.toFixed(0)}ms`,
      `net ${this.model.input}→${this.model.hidden}  fps ${this.settings.fps}/${this.actualFps ? this.actualFps.toFixed(0) : '—'}`,
      `read ${this.readState}  quads ${this.lastQuads.length}`,
    ];
    // 跟踪框和“读到数字的那块九宫格”差多少：差得多说明跟踪跑偏了，
    // 答案就会整体错位（这是真机上最难肉眼判断的故障）。
    if (this.readState === 'done' && this.lastReadQuad && this.trackerQuad && this.lastDetectDims) {
      const diag = Math.hypot(
        this.lastDetectDims.PW,
        this.lastDetectDims.PH,
      );
      const d = cornerDistance(this.trackerQuad, this.lastReadQuad) / diag;
      lines.push(`track-vs-read ${(d * 100).toFixed(1)}%`);
    }
    if (s) {
      lines.push(
        `solver ${s.status} ${s.ms.toFixed(1)}ms nodes ${s.nodes} 解 ${s.solutions}`,
      );
    }
    if (this.mode === 'static') {
      lines.push(`static ${this.staticW}×${this.staticH}`);
    }
    this.ui.setDebug(lines.join('\n'));
  }
}

function dedupeQuads(quads) {
  const out = [];
  for (const q of quads) {
    if (!q) continue;
    const duplicate = out.some((other) =>
      q.every(
        (p, i) =>
          Math.hypot(p.x - other[i].x, p.y - other[i].y) < 3,
      ),
    );
    if (!duplicate) out.push(q);
  }
  return out;
}

// 主循环跑在 rAF（60Hz）上。间隔恰好取 1000/fps 时，帧时间抖动会让
// 30fps 偶尔滑到“隔 3 帧才检测一次”（掉成 20fps）；留 2ms 余量后
// 稳定落在每 2 帧一次。
const RAF_SLACK_MS = 2;

function frameIntervalFor(fps) {
  return 1000 / (fps || 30) - RAF_SLACK_MS;
}

function countTrue(arr) {
  if (!arr) return 0;
  let n = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i]) n++;
  return n;
}

/** 实际会画到画面上的答案格数（待确认格不画，见 overlay.js）。 */
function countFilled(grid, solution, unknown) {
  let n = 0;
  for (let i = 0; i < 81; i++) {
    if (!grid[i] && solution[i] && !(unknown && unknown[i])) n++;
  }
  return n;
}

/**
 * 两次读取的线索重合度。同一道题（即使在别的分辨率/角度下重读）几乎完全一致，
 * 换了一道题则大部分格子对不上——用这个区分要不要沿用用户的手工修改。
 */
function gridOverlap(a, b) {
  if (!a || !b) return 0;
  let same = 0;
  let either = 0;
  for (let i = 0; i < 81; i++) {
    if (a[i] || b[i]) either++;
    if (a[i] && a[i] === b[i]) same++;
  }
  return either ? same / either : 0;
}
