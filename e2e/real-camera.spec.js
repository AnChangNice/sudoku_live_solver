import { test, expect } from '@playwright/test';
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeFrame, y4m } from './frame.js';

// 真实场景回归：摄像头画面是“一台手机在显示数独 App”。
// 手机屏幕比九宫格大得多，而且九宫格的细外框在照片里是断开的，
// 以前检测阶段根本给不出九宫格的四边形，绿框一直停在手机屏幕上。
// 这里把用户提供的照片铺进 1280×720 的画面，用假摄像头走完整的生产路径。

const TRUTH =
  '000490700002100508300000000705000000290000043000000605000000007506002400009078000';

// 照片（942×914）按高度铺满 720p 画面后，九宫格四角的大致位置
const GRID_IN_FRAME = [
  [404, 166],
  [843, 169],
  [851, 609],
  [396, 616],
];

test('摄像头对着手机屏幕：锁定并求解真正的九宫格', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  await expect(page.locator('#gate')).toBeVisible();

  const b64 = fs
    .readFileSync(path.resolve('e2e/fixtures/real-grid-b.jpg'))
    .toString('base64');

  const { planes, width, height } = await page.evaluate(makeFrame, {
    dataUrl: `data:image/jpeg;base64,${b64}`,
    width: 1280,
    height: 720,
    fit: 'height',
  });

  const file = path.join(os.tmpdir(), 'sudoku-real-camera.y4m');
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

    await expect(app.locator('#status')).toContainText('已求解', {
      timeout: 40_000,
    });

    const state = await app.evaluate(() => {
      const a = window.__sudokuApp;
      return {
        grid: a?.grid ? Array.from(a.grid).join('') : null,
        quad: a?.currentProjection?.quadSource || null,
        sw: a?.currentProjection?.sw,
        sh: a?.currentProjection?.sh,
      };
    });

    // 读出的每个线索都必须正确
    expect(state.grid, '应识别出盘面').not.toBeNull();
    const wrong = [];
    let reads = 0;
    for (let i = 0; i < 81; i++) {
      const v = Number(state.grid[i]);
      if (!v) continue;
      reads++;
      if (v !== Number(TRUTH[i])) wrong.push({ i, got: v, truth: Number(TRUTH[i]) });
    }
    expect(wrong, '读错的数字').toEqual([]);
    expect(reads).toBeGreaterThanOrEqual(22);

    // 叠加必须落在九宫格上，而不是手机屏幕边框上
    expect(state.quad, '应存在叠加四边形').not.toBeNull();
    const tolerance = Math.hypot(state.sw, state.sh) * 0.05;
    state.quad.forEach((p, i) => {
      const d = Math.hypot(p.x - GRID_IN_FRAME[i][0], p.y - GRID_IN_FRAME[i][1]);
      expect(
        d,
        `第 ${i} 个角点 (${p.x.toFixed(0)},${p.y.toFixed(0)}) 偏离九宫格 ${d.toFixed(0)}px`,
      ).toBeLessThan(tolerance);
    });

    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
