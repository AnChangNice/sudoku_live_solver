import { test, expect } from '@playwright/test';
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 复现真实场景：画面上有一个更大、更像“屏幕边框”的四边形（过不了格线校验），
// 真正的数独只占一小块。应用必须先排除干扰四边形，再数出真正的题目并求解。
//
// 画面由浏览器里的 Canvas 渲染（需要 Noto Sans 字体），转成 I420 Y4M 后
// 交给 Chrome 的假摄像头播放，因此跑的是与生产完全相同的摄像头路径。

const W = 1280;
const H = 800;
const PUZZLE =
  '530070000600195000098000060800060003400803001700020006060000280000419005000080079';
const SOLUTION =
  '534678912672195348198342567859761423426853791713924856961537284287419635345286179';

test('画面里更大的“屏幕边框”不会挡住真正的数独', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto('/');
  await expect(page.locator('#gate')).toBeVisible();

  const planes = Buffer.from(
    await page.evaluate(renderScene, { width: W, height: H, puzzle: PUZZLE }),
    'base64',
  );

  const file = path.join(os.tmpdir(), 'sudoku-decoy-scene.y4m');
  const header = Buffer.from(
    `YUV4MPEG2 W${W} H${H} F12:1 Ip A1:1 C420jpeg\n`,
    'ascii',
  );
  const parts = [header];
  for (let i = 0; i < 3; i++) {
    parts.push(Buffer.from('FRAME\n', 'ascii'), planes);
  }
  fs.writeFileSync(file, Buffer.concat(parts));

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
    app.on('pageerror', (error) => errors.push(String(error)));
    app.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await app.goto('/');
    await expect(app.locator('#gate')).toBeVisible();
    await app.locator('#btn-start').click();

    await expect(app.locator('#status')).toContainText('已求解', {
      timeout: 40_000,
    });

    // 叠加的答案必须与这题的标准解一致，而不是随便一个“解”。
    const digits = await app.evaluate(() => {
      const app = window.__sudokuApp;
      return app?.grid ? Array.from(app.grid).join('') : null;
    });
    expect(digits, '开发环境应暴露 __sudokuApp 以便断言').not.toBeNull();
    expect(digits.length).toBe(81);
    for (let i = 0; i < 81; i++) {
      if (PUZZLE[i] !== '0') expect(digits[i]).toBe(PUZZLE[i]);
    }
    const solution = await app.evaluate(() =>
      window.__sudokuApp ? Array.from(window.__sudokuApp.solution || []).join('') : null,
    );
    expect(solution).toBe(SOLUTION);

    // 叠加投影必须落在真正的九宫格上，而不是更大的干扰四边形上。
    const projection = await app.evaluate(() => {
      const p = window.__sudokuApp?.currentProjection;
      return p ? { quad: p.quadSource, sw: p.sw, sh: p.sh } : null;
    });
    expect(projection, '应存在叠加投影').not.toBeNull();
    const expected = [
      [40, 40],
      [472, 40],
      [472, 472],
      [40, 472],
    ];
    const tolerance = Math.hypot(projection.sw, projection.sh) * 0.04;
    projection.quad.forEach((p, i) => {
      const d = Math.hypot(p.x - expected[i][0], p.y - expected[i][1]);
      expect(
        d,
        `第 ${i} 个角点 (${p.x.toFixed(0)},${p.y.toFixed(0)}) 偏离真九宫格 ${d.toFixed(0)}px`,
      ).toBeLessThan(tolerance);
    });

    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

/**
 * 在页面里画出场景（灰底 + 大“屏幕” + 左上角真数独），并返回 I420 平面数据的 base64。
 * 该函数会被序列化到页面里执行，不能引用外部变量。
 */
async function renderScene({ width, height, puzzle }) {
  await document.fonts.ready;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  ctx.fillStyle = '#8f8f8a';
  ctx.fillRect(0, 0, width, height);

  // 干扰项 1：手机屏幕（大矩形边框 + 一块小九宫格），整体过不了 16 条格线校验。
  ctx.fillStyle = '#f7f7f2';
  ctx.fillRect(520, 90, 720, 670);
  ctx.strokeStyle = '#141414';
  ctx.lineWidth = 12;
  ctx.strokeRect(520, 90, 720, 670);
  ctx.fillStyle = '#d8d8d0';
  ctx.fillRect(540, 110, 680, 44); // 假装是状态栏
  ctx.strokeStyle = '#2a2a2a';
  ctx.lineWidth = 3;
  const gx = 700;
  const gy = 220;
  const gs = 360;
  for (let i = 0; i <= 9; i++) {
    const p = (i * gs) / 9;
    ctx.beginPath();
    ctx.moveTo(gx + p, gy);
    ctx.lineTo(gx + p, gy + gs);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(gx, gy + p);
    ctx.lineTo(gx + gs, gy + p);
    ctx.stroke();
  }

  // 真数独：左上角，4px 边距 + 48px 格。
  const cell = 48;
  const margin = 40;
  const size = cell * 9;
  ctx.fillStyle = '#fcfcf8';
  ctx.fillRect(margin, margin, size, size);
  ctx.strokeStyle = '#101010';
  for (let i = 0; i <= 9; i++) {
    const p = margin + i * cell;
    ctx.lineWidth = i % 3 === 0 ? 5 : 2;
    ctx.beginPath();
    ctx.moveTo(p, margin);
    ctx.lineTo(p, margin + size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(margin, p);
    ctx.lineTo(margin + size, p);
    ctx.stroke();
  }
  ctx.fillStyle = '#101010';
  ctx.font = '400 31px "Noto Sans", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < 81; i++) {
    const d = Number(puzzle[i]);
    if (!d) continue;
    ctx.fillText(
      String(d),
      margin + (i % 9) * cell + cell / 2,
      margin + ((i / 9) | 0) * cell + cell / 2 + 1,
    );
  }

  {
    const data = ctx.getImageData(0, 0, width, height).data;
    const ySize = width * height;
    const cw = width >> 1;
    const ch = height >> 1;
    const yPlane = new Uint8Array(ySize);
    const uPlane = new Uint8Array(cw * ch);
    const vPlane = new Uint8Array(cw * ch);

    const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const i = (py * width + px) * 4;
        yPlane[py * width + px] = clamp8(
          0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2],
        );
      }
    }
    for (let py = 0; py < ch; py++) {
      for (let px = 0; px < cw; px++) {
        let r = 0;
        let g = 0;
        let b = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const i = ((py * 2 + dy) * width + (px * 2 + dx)) * 4;
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
          }
        }
        r /= 4;
        g /= 4;
        b /= 4;
        uPlane[py * cw + px] = clamp8(-0.168736 * r - 0.331264 * g + 0.5 * b + 128);
        vPlane[py * cw + px] = clamp8(0.5 * r - 0.418688 * g - 0.081312 * b + 128);
      }
    }

    const out = new Uint8Array(ySize + 2 * cw * ch);
    out.set(yPlane, 0);
    out.set(uPlane, ySize);
    out.set(vPlane, ySize + cw * ch);

    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < out.length; i += chunk) {
      s += String.fromCharCode.apply(null, out.subarray(i, i + chunk));
    }
    return btoa(s);
  }
}
