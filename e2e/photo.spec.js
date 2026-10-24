import { test, expect } from '@playwright/test';

// 相册/拍照路径的端到端测试：生成一张已知题目图片 → 走真实 App 管线
// （检测 → 校正 → 识别 → 求解）→ 断言状态与叠加层确实画出了答案。

const PUZZLE =
  '530070000600195000098000060800060003400803001700020006060000280000419005000080079';

async function makePuzzlePng(page) {
  const dataUrl = await page.evaluate(async (puzzle) => {
    await document.fonts.ready;
    const cell = 120;
    const margin = 80;
    const size = margin * 2 + cell * 9;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#fbfbf7';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = '#161616';
    for (let i = 0; i <= 9; i++) {
      const p = margin + i * cell;
      ctx.lineWidth = i % 3 === 0 ? 6 : 2;
      ctx.beginPath();
      ctx.moveTo(p, margin);
      ctx.lineTo(p, margin + cell * 9);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(margin, p);
      ctx.lineTo(margin + cell * 9, p);
      ctx.stroke();
    }

    ctx.fillStyle = '#111111';
    ctx.font = `400 ${Math.round(cell * 0.64)}px "Noto Sans", Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < 81; i++) {
      const d = Number(puzzle[i]);
      if (!d) continue;
      const r = (i / 9) | 0;
      const c = i % 9;
      ctx.fillText(
        String(d),
        margin + c * cell + cell / 2,
        margin + r * cell + cell / 2 + cell * 0.03,
      );
    }
    return canvas.toDataURL('image/png');
  }, PUZZLE);

  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

test('上传照片后求解并绘制答案', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto('/');
  await expect(page.locator('#gate')).toBeVisible();

  const png = await makePuzzlePng(page);
  await page.locator('#file-input').setInputFiles({
    name: 'sudoku.png',
    mimeType: 'image/png',
    buffer: png,
  });

  await expect(page.locator('#status')).toContainText('已求解', {
    timeout: 30_000,
  });
  await expect(page.locator('#gate')).toBeHidden();
  await expect(page.locator('#frozen')).toBeVisible();

  // 叠加层应已画出答案（绿色半透明字形）。
  const painted = await expect
    .poll(
      () =>
        page.evaluate(() => {
          const canvas = document.getElementById('overlay');
          const ctx = canvas.getContext('2d');
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let opaque = 0;
          for (let i = 3; i < data.length; i += 4) {
            if (data[i] > 20) opaque++;
          }
          return opaque;
        }),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(500);

  void painted;

  // 设置 → 保存识别图：导出一张 900×900 的校正图（排查识别问题用）。
  await page.locator('#btn-settings').click();
  await expect(page.locator('#settings-panel')).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#btn-save-warp').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^sudoku-warp-\d+\.png$/);
  await page.locator('#settings-panel [data-action="close-settings"].primary').click();
  await expect(page.locator('#settings-panel')).toBeHidden();

  // 编辑面板：81 格都在；点空格 + 输入数字后立即重算。
  await page.locator('#bottombar button[data-action="edit"]').click();
  await expect(page.locator('#edit-panel')).toBeVisible();
  await expect(page.locator('#edit-grid .cell')).toHaveCount(81);

  // 数字键盘还没弹出时的默认位置，用于后面验证“重新打开会复位”。
  const panel = page.locator('#edit-panel');
  const initial = await panel.boundingBox();

  const cell = page.locator('#edit-grid .cell').nth(2);
  await cell.click();
  await expect(page.locator('#numpad')).toBeVisible();
  await page.keyboard.press('4');
  await expect(cell.locator('.val')).toHaveText('4');
  await expect(page.locator('#status')).toContainText('已求解');

  // “都当空格”：有待确认格时才出现；点掉后不再提示，记入手工修改。
  const emptyIdx = await page.evaluate(() => {
    const a = window.__sudokuApp;
    const i = Array.from(a.grid).findIndex((v) => v === 0);
    a.unknown[i] = 1;
    a.results[i] = {
      kind: 'unknown', value: 0, guess: 4, score: 0.5, margin: 0.1, confidence: 0.5,
    };
    a.renderEditor();
    a.updateStatus();
    return i;
  });
  const ignore = page.locator('#edit-ignore');
  await expect(ignore).toBeVisible();
  await ignore.click();
  await expect(ignore).toBeHidden();
  const ignored = await page.evaluate((i) => {
    const a = window.__sudokuApp;
    return {
      unknown: a.unknown[i],
      fix: a.fixes.get(i),
      status: document.getElementById('status').textContent,
    };
  }, emptyIdx);
  expect(ignored.unknown).toBe(0);
  expect(ignored.fix).toBe(0);
  expect(ignored.status).not.toContain('待确认');

  // 面板会挡住画面：按住标题栏可以拖到一边。
  const before = await panel.boundingBox();
  const head = await page.locator('#edit-panel .sheet-head').boundingBox();
  await page.mouse.move(head.x + 40, head.y + head.height / 2);
  await page.mouse.down();
  await page.mouse.move(head.x - 120, head.y - 150, { steps: 8 });
  await page.mouse.up();
  const moved = await panel.boundingBox();
  expect(moved.x).toBeLessThan(before.x - 50);
  expect(moved.y).toBeLessThan(before.y - 50);

  // 关闭后重新打开回到默认位置（键盘也收起了，所以和 initial 比）。
  await page.locator('#edit-panel [data-action="close-edit"]').click();
  await expect(panel).toBeHidden();
  await page.locator('#bottombar button[data-action="edit"]').click();
  await expect(panel).toBeVisible();
  const reopened = await panel.boundingBox();
  expect(Math.abs(reopened.x - initial.x)).toBeLessThan(2);
  expect(Math.abs(reopened.y - initial.y)).toBeLessThan(2);

  expect(errors).toEqual([]);
});
