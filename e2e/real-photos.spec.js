import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// 真实样张回归：两张照片都是一个手机屏幕上的数独 App，
// 绿框曾经错误地锁在手机外框上、细格线在照片里淡到几乎看不见。
// 这里不经过摄像头，直接跑与生产相同的 Vision 管线：
// 1) 手机外框必须被格线校验拒绝（防止"答案铺满屏幕"回归）
// 2) 必须能通过粗格线（3×3 分隔线）确认九宫格
// 3) 读出的每个数字都必须正确

const CASES = [
  {
    name: 'real-grid-a',
    minDigits: 20,
    truth:
      '870500003000008007000040000009000000080700016002086000200000000050100230096000000',
  },
  {
    name: 'real-grid-b',
    minDigits: 22,
    truth:
      '000490700002100508300000000705000000290000043000000605000000007506002400009078000',
  },
];

test('真实手机屏幕照片：拒绝手机外框，正确读取九宫格', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/debug/synthetic.html');
  await page.waitForFunction(() => window.__sudokuDebug?.ready === true, null, {
    timeout: 150_000,
  });

  for (const item of CASES) {
    const b64 = fs
      .readFileSync(path.resolve('e2e/fixtures', `${item.name}.jpg`))
      .toString('base64');
    const result = await page.evaluate(
      (url) => window.__sudokuDebug.analyzeDataUrl(url),
      `data:image/jpeg;base64,${b64}`,
    );

    expect(
      result.detect.candidates,
      `${item.name} 候选四边形数量`,
    ).toBeGreaterThanOrEqual(2);

    // 面积最大的候选是手机屏幕/外壳，绝不能被当成九宫格
    expect(result.attempts[0].ok, `${item.name} 手机外框不应通过校验`).toBe(
      false,
    );

    const chosen = result.attempts.find((a) => a.ok);
    expect(chosen, `${item.name} 没有找到通过校验的九宫格`).toBeTruthy();
    if (!chosen) continue;

    // 逐格比对：truth 里的数字必须一个不少地读出来（空格读成数字也算错），
    // 且不能有待确认格——这两张样张是“清晰可读”的基准。
    const wrong = [];
    const missing = [];
    const unknownAt = [];
    let read = 0;
    for (let i = 0; i < 81; i++) {
      const got = Number(chosen.grid[i]);
      const truth = Number(item.truth[i]);
      if (chosen.cells[i]?.kind === 'unknown') unknownAt.push(i);
      if (got) read++;
      if (truth === 0) {
        if (got !== 0) wrong.push({ i, got, truth: 0 });
      } else if (got === 0) {
        missing.push({ i, truth });
      } else if (got !== truth) {
        wrong.push({ i, got, truth });
      }
    }

    expect(wrong, `${item.name} 读错的数字`).toEqual([]);
    expect(missing, `${item.name} 漏读的数字`).toEqual([]);
    expect(unknownAt, `${item.name} 待确认的格子`).toEqual([]);
    expect(read, `${item.name} 读出的数字数量`).toBeGreaterThanOrEqual(
      item.minDigits,
    );
    expect(
      ['solved', 'ambiguous'],
      `${item.name} 求解状态`,
    ).toContain(chosen.solve.status);
  }
});

test('边框阴影不会把空格变成待确认', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/debug/synthetic.html');
  await page.waitForFunction(() => window.__sudokuDebug?.ready === true, null, {
    timeout: 150_000,
  });

  const b64 = fs
    .readFileSync(path.resolve('e2e/fixtures/real-grid-a.jpg'))
    .toString('base64');
  const truth = CASES[0].truth;

  // 给照片的左侧和底部叠一道手机边框/桌面投下的柔和阴影——这是用户
  // 反复看到的“空格却要我确认”的来源。
  const shadowed = await page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const left = ctx.createLinearGradient(0, 0, canvas.width * 0.28, 0);
    left.addColorStop(0, 'rgba(0,0,0,0.55)');
    left.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = left;
    ctx.fillRect(0, 0, canvas.width * 0.28, canvas.height);
    const bottom = ctx.createLinearGradient(0, canvas.height, 0, canvas.height * 0.72);
    bottom.addColorStop(0, 'rgba(0,0,0,0.55)');
    bottom.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bottom;
    ctx.fillRect(0, canvas.height * 0.72, canvas.width, canvas.height * 0.28);
    return window.__sudokuDebug.analyzeDataUrl(
      canvas.toDataURL('image/jpeg', 0.85),
    );
  }, `data:image/jpeg;base64,${b64}`);

  const chosen = shadowed.attempts.find((a) => a.ok);
  expect(chosen, '有阴影时仍应识别出九宫格').toBeTruthy();
  if (!chosen) return;

  // 阴影可能让个别真实数字变成“待确认”（可以接受，用户可编辑），
  // 但空格绝不能变成待确认，也绝不能凭空读出数字。
  const falseUnknown = chosen.cells.filter(
    (c) => c.kind === 'unknown' && truth[c.i] === '0',
  );
  const wrong = chosen.cells.filter(
    (c) => c.kind === 'digit' && Number(truth[c.i]) !== c.v,
  );
  expect(falseUnknown, '空格被标成待确认').toEqual([]);
  expect(wrong, '读错的数字（含空格读出数字）').toEqual([]);
});
