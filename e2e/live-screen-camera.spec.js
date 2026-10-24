import { test, expect } from '@playwright/test';
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeFrame, y4m } from './frame.js';

// 真实场景回归：手机被拍得比较小、九宫格在画面里只占很小一块。
// 以前实时检测用 720 长边，这块屏幕上的细格线在二值图里整块消失，
// 检测只能给出手机屏幕的四边形；定格走 1200 就能识别——
// 用户看到的就是“不定格识别不出，定格就能识别”。
// 这里用当场的截图铺进 1280×720 假摄像头，走完整的实时链路。

const TRUTH =
  '005300000800000020070010500400005300010070006003200080060500009004000030000009700';

// 截图（1024×919）等比放进 720p 画面后，九宫格四角的大致位置
const GRID_IN_FRAME = [
  [443, 145],
  [841, 151],
  [853, 548],
  [437, 551],
];

test('实时（不定格）也能识别手机屏幕上的小九宫格', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  await expect(page.locator('#gate')).toBeVisible();

  const b64 = fs
    .readFileSync(path.resolve('e2e/fixtures/screen-live-c.png'))
    .toString('base64');

  const { planes, width, height } = await page.evaluate(makeFrame, {
    dataUrl: `data:image/png;base64,${b64}`,
    width: 1280,
    height: 720,
    fit: 'contain',
  });

  const file = path.join(os.tmpdir(), 'sudoku-live-screen.y4m');
  fs.writeFileSync(file, y4m(planes, { width, height }));

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${file.replace(/\\/g, '/')}`,
    ],
  });

  try {
    const context = await browser.newContext({
      permissions: ['camera'],
      baseURL: 'http://127.0.0.1:5173',
      viewport: { width: 1400, height: 1000 },
    });
    const app = await context.newPage();
    app.on('pageerror', (e) => errors.push(String(e)));
    app.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await app.goto('/');
    await expect(app.locator('#gate')).toBeVisible();
    await app.locator('#btn-start').click();

    // 关键：全程不点“定格”，实时模式就要能求解。
    await expect(app.locator('#status')).toContainText('已求解', {
      timeout: 40_000,
    });

    // 等滑动窗口（最近 30 次检测）填满，顺便量一下实际处理帧率。
    await app.waitForTimeout(1200);
    const state = await app.evaluate(() => {
      const a = window.__sudokuApp;
      const kinds = (a?.results || []).map((c) => c.kind);
      return {
        mode: a?.mode,
        stamps: a?.detectStamps?.length,
        grid: a?.grid ? Array.from(a.grid).join('') : null,
        quad: a?.currentProjection?.quadSource || null,
        sw: a?.currentProjection?.sw,
        sh: a?.currentProjection?.sh,
        unknownAt: kinds
          .map((k, i) => (k === 'unknown' ? i : -1))
          .filter((i) => i >= 0),
        fps: a?.actualFps ?? 0,
        fpsSetting: a?.settings?.fps ?? 0,
      };
    });

    expect(state.grid, '应识别出盘面').not.toBeNull();
    const wrong = [];
    let reads = 0;
    for (let i = 0; i < 81; i++) {
      const v = Number(state.grid[i]);
      if (!v) continue;
      reads++;
      if (v !== Number(TRUTH[i])) wrong.push({ i, got: v, truth: Number(TRUTH[i]) });
    }
    console.log('live screen', {
      reads,
      unknownAt: state.unknownAt,
      fps: +state.fps.toFixed(1),
      fpsSetting: state.fpsSetting,
      stamps: state.stamps,
    });
    expect(state.fps, '实时处理帧率').toBeGreaterThan(20);
    expect(wrong, '读错的数字').toEqual([]);
    expect(reads).toBeGreaterThanOrEqual(20);

    // 屏幕上的空格会带摩尔纹和压缩噪点，必须判成空白，不能一片“待确认”。
    // 这张样张的 23 个线索现在应全部读出（留 2 格容差）。
    expect(
      state.unknownAt.length,
      `待确认格：${state.unknownAt.join(',')}`,
    ).toBeLessThanOrEqual(2);

    // 锁定/叠加必须落在九宫格上，而不是旁边的手机屏幕
    expect(state.quad, '应存在叠加四边形').not.toBeNull();
    const tolerance = Math.hypot(state.sw, state.sh) * 0.05;
    state.quad.forEach((p, i) => {
      const d = Math.hypot(
        p.x - GRID_IN_FRAME[i][0],
        p.y - GRID_IN_FRAME[i][1],
      );
      expect(
        d,
        `第 ${i} 个角点 (${p.x.toFixed(0)},${p.y.toFixed(0)}) 偏离九宫格 ${d.toFixed(0)}px`,
      ).toBeLessThan(tolerance);
    });

    // 手工改一格 → 完成 → 继续回实时：修改必须保留，不能重读覆盖、
    // 也不能又弹“待确认”。
    const edit = await app.evaluate(() => {
      const a = window.__sudokuApp;
      const idx = Array.from(a.grid).findIndex((v) => v === 0);
      return { idx, value: a.solution[idx] };
    });
    await app.locator('#bottombar button[data-action="edit"]').click();
    await expect(app.locator('#edit-panel')).toBeVisible();
    const cell = app.locator('#edit-grid .cell').nth(edit.idx);
    await cell.click();
    await app.keyboard.press(String(edit.value));
    await expect(cell.locator('.val')).toHaveText(String(edit.value));
    await app.locator('#edit-panel [data-action="done"]').click();
    await expect(app.locator('#edit-panel')).toBeHidden();
    await app.locator('#bottombar button[data-action="freeze"]').click(); // 继续
    await expect(app.locator('#status')).toContainText('已求解', {
      timeout: 20_000,
    });

    const after = await app.evaluate(() => {
      const a = window.__sudokuApp;
      return {
        fixes: [...a.fixes],
        grid: Array.from(a.grid).join(''),
        mode: a.mode,
        unknownCount: Array.from(a.unknown || []).reduce((s, v) => s + v, 0),
      };
    });
    expect(after.mode).toBe('live');
    expect(after.fixes, '手工修改应被记住').toEqual([[edit.idx, edit.value]]);
    expect(after.grid[edit.idx]).toBe(String(edit.value));
    expect(after.unknownCount, '回到实时后不应重新出现待确认').toBe(0);
    await expect(app.locator('#status')).not.toContainText('待确认');

    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
