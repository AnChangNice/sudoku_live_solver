import { test, expect } from '@playwright/test';

// 用 Chrome 的假摄像头验证启动流程：权限门 → getUserMedia → 视频尺寸 → 检测循环。
// 假设备输出彩条，不会锁到网格，但足以覆盖摄像头与 UI 状态机。

test.use({
  permissions: ['camera'],
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  },
});

test('启动应用并打开摄像头', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto('/');
  await expect(page.locator('#gate')).toBeVisible();
  await expect(page.locator('#btn-start')).toBeVisible();

  await page.locator('#btn-start').click();

  await expect
    .poll(
      () =>
        page.evaluate(() => document.getElementById('video').videoWidth),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  await expect(page.locator('#gate')).toBeHidden();
  await expect(page.locator('#error-card')).toBeHidden();
  await expect(page.locator('#status')).toContainText('对准');
  await expect(page.locator('#bottombar')).toBeVisible();

  expect(errors).toEqual([]);
});
