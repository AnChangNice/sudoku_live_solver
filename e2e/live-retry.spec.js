import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 回归测试：镜头里放一个“能检测成四边形、但过不了 16 条格线校验”的物体
// （模拟手机屏幕边框、桌面边缘）。读取失败后应用必须继续重试，不能停住。
//
// 早期版本只在“刚锁定”的那一帧尝试读取：第一次读取失败 → 冷却 1.5s →
// 重新锁定 → 这次被冷却挡掉 → 从此再没有读取机会，状态永久停在
// “已锁定，准备识别…”。这里用 Chrome 的 Y4M 假摄像头复现该场景。

const VIDEO = path.join(os.tmpdir(), 'sudoku-fake-screen.y4m');
if (!fs.existsSync(VIDEO)) fs.writeFileSync(VIDEO, makeY4M());

test.use({
  permissions: ['camera'],
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${VIDEO.replace(/\\/g, '/')}`,
    ],
  },
});

test('读取失败后持续重试，不会卡在“已锁定”', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto('/');
  await expect(page.locator('#gate')).toBeVisible();

  await page.evaluate(() => {
    window.__statusLog = [];
    const el = document.getElementById('status');
    const push = () => {
      const text = el.textContent.trim();
      const now = performance.now();
      const last = window.__statusLog[window.__statusLog.length - 1];
      if (last && last.text === text) {
        last.until = now;
        return;
      }
      window.__statusLog.push({ text, at: now, until: now });
    };
    push();
    new MutationObserver(push).observe(el, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });

  await page.locator('#btn-start').click();

  // 至少两次“识别失败”提示 = 失败后确实又发起过读取。
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window.__statusLog || []).filter((e) =>
              e.text.includes('未识别到九宫格'),
            ).length,
        ),
      { timeout: 45_000, intervals: [500] },
    )
    .toBeGreaterThanOrEqual(2);

  const log = await page.evaluate(() => window.__statusLog);

  // 任何一次“已锁定，准备识别…”都不允许持续超过 2.5s（冷却上限）。
  const stuck = log
    .filter((e) => e.text === '已锁定，准备识别…')
    .map((e) => e.until - e.at)
    .filter((ms) => ms > 2500);
  expect(stuck, `卡住时长 ${JSON.stringify(stuck)}ms，日志：${JSON.stringify(log)}`).toEqual([]);

  expect(errors).toEqual([]);
});

/** 640×480 的 I420 Y4M：灰底上一个只有边框的白色矩形。 */
function makeY4M() {
  const W = 640;
  const H = 480;
  const frames = 10;

  const y = Buffer.alloc(W * H, 120);
  const left = 120;
  const top = 40;
  const right = 520;
  const bottom = 440;
  const border = 8;
  for (let py = top; py < bottom; py++) {
    for (let px = left; px < right; px++) {
      const edge =
        px < left + border ||
        px >= right - border ||
        py < top + border ||
        py >= bottom - border;
      y[py * W + px] = edge ? 20 : 235;
    }
  }

  const chroma = Buffer.alloc((W / 2) * (H / 2), 128);
  const frame = Buffer.concat([
    Buffer.from('FRAME\n', 'ascii'),
    y,
    chroma,
    chroma,
  ]);
  const header = Buffer.from(
    `YUV4MPEG2 W${W} H${H} F12:1 Ip A1:1 C420jpeg\n`,
    'ascii',
  );

  const parts = [header];
  for (let i = 0; i < frames; i++) parts.push(frame);
  return Buffer.concat(parts);
}
