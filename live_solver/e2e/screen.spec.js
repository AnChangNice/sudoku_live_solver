import { test, expect } from '@playwright/test';

// 手机屏幕照片场景：小格、屏显字体、像素栅格、摩尔纹、轻微模糊与噪声。
// 这是用户最常见的输入（对着另一台手机/平板的数独 App 拍），比印刷纸难得多。

test.beforeEach(async ({ page }) => {
  await page.goto('/debug/synthetic.html');
  await expect
    .poll(() => page.evaluate(() => window.__sudokuDebug?.ready), {
      timeout: 120_000,
    })
    .toBe(true);
});

test('屏幕照片：小格 + 像素纹理仍能正确识别', async ({ page }) => {
  const result = await page.evaluate(() =>
    window.__sudokuDebug.run({
      style: 'screen',
      screen: true,
      tilt: false,
      blur: 1.0,
      noise: 8,
    }),
  );
  console.log('SCREEN', JSON.stringify(summarize(result)));

  expect(result.ok).toBe(true);
  expect(result.digitAccuracy).toBeGreaterThanOrEqual(0.95);
  expect(result.falsePositive).toBe(0);
  expect(result.solvedCorrect).toBe(true);
});

test('屏幕照片 + 四边形略有偏差：格线校正后仍能识别', async ({ page }) => {
  const result = await page.evaluate(() =>
    window.__sudokuDebug.run({
      style: 'screen',
      screen: true,
      tilt: false,
      blur: 1.0,
      noise: 8,
      border: 3,
    }),
  );
  console.log('SCREEN-BORDER', JSON.stringify(summarize(result)));

  expect(result.ok).toBe(true);
  expect(result.digitAccuracy).toBeGreaterThanOrEqual(0.95);
  expect(result.solvedCorrect).toBe(true);
});

function summarize(r) {
  return {
    ok: r.ok,
    candidates: r.candidates,
    verify: r.verify,
    correct: r.correct,
    wrong: r.wrong,
    missed: r.missed,
    falsePositive: r.falsePositive,
    digitAccuracy: r.digitAccuracy,
    solveStatus: r.solveStatus,
    solvedCorrect: r.solvedCorrect,
    mistakes: r.mistakes,
    unknown: (r.unknownDetails || []).slice(0, 6).map((u) => ({
      i: u.i,
      truth: u.truth,
      a: u.a.kind,
      b: u.b.kind,
      reasonA: u.cellA.reason,
      reasonB: u.cellB.reason,
    })),
  };
}
