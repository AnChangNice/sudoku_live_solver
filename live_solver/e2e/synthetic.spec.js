import { test, expect } from '@playwright/test';

// 端到端验证：渲染已知题目 → 透视/光照/噪声 → 生产管线 → 识别 → 求解。

test('合成图像：检测、识别与求解', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto('/debug/synthetic.html');
  await page.waitForFunction(() => window.__sudokuDebug?.ready === true, null, {
    timeout: 150_000,
  });

  const flat = await page.evaluate(() => window.__sudokuDebug.flat);
  console.log('flat', JSON.stringify(flat, null, 2));

  expect(flat.ok, '网格检测失败').toBe(true);
  expect(flat.solvedCorrect, '求解结果与标准答案不一致').toBe(true);
  expect(flat.digitAccuracy).toBeGreaterThanOrEqual(0.99);
  expect(flat.falsePositive).toBe(0);
  expect(flat.wrong).toBe(0);

  const tilted = await page.evaluate(() =>
    window.__sudokuDebug.run({
      tilt: true,
      font: 'Roboto',
      weight: 700,
      blur: 1.2,
      noise: 10,
    }),
  );
  console.log('tilted', JSON.stringify(tilted, null, 2));

  expect(tilted.ok, '透视/退化图像检测失败').toBe(true);
  expect(tilted.digitAccuracy).toBeGreaterThanOrEqual(0.95);
  expect(tilted.solvedCorrect, '退化图像求解结果不一致').toBe(true);

  const net = await page.evaluate(() => window.__sudokuDebug.net);
  expect(net.input).toBe(28 * 28);
  expect(net.hidden).toBeGreaterThanOrEqual(24);

  expect(errors).toEqual([]);
});

test('不同字体与字重仍可识别', async ({ page }) => {
  await page.goto('/debug/synthetic.html');
  await page.waitForFunction(() => window.__sudokuDebug?.ready === true, null, {
    timeout: 150_000,
  });

  const cases = [
    { tilt: false, font: 'Roboto', weight: 400 },
    { tilt: true, font: 'Noto Sans', weight: 700 },
    { tilt: true, font: 'Georgia', weight: 400 },
    // 手机 App 的粗圆体（3/8、4/9 缺口浅，曾经读成待确认或别的数字）
    { tilt: true, font: 'Fredoka', weight: 700 },
    { tilt: true, font: 'Baloo 2', weight: 800 },
  ];

  for (const opts of cases) {
    const result = await page.evaluate((o) => window.__sudokuDebug.run(o), opts);
    console.log(`${opts.font} ${opts.weight} tilt=${opts.tilt}`, result.digitAccuracy, result.solveStatus, result.solvedCorrect);
    expect.soft(result.ok, `${opts.font} 检测失败`).toBe(true);
    if (result.ok) {
      expect.soft(result.digitAccuracy, `${opts.font} 识别准确率`).toBeGreaterThanOrEqual(0.95);
      expect.soft(result.solvedCorrect, `${opts.font} 求解不一致`).toBe(true);
    }
  }
});
