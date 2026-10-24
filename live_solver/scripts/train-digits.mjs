// 驱动浏览器里的数字分类器训练，并把权重写回仓库。
// 用法：npm run train:digits [-- --epochs 40 --rounds 10 --hidden 128]
//
// 训练需要本机 Chrome（与 e2e 相同）。脚本会自己起一个临时 Vite dev server，
// 结束后关掉；已有 5199 端口的服务时直接复用。

import { chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PORT = 5199;
const URL = `http://127.0.0.1:${PORT}/tools/train-digits.html`;
const ROOT = process.cwd();

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) {
      opts[key] = true;
    } else {
      const num = Number(next);
      opts[key] = Number.isFinite(num) ? num : next;
      i++;
    }
  }
  return opts;
}

async function waitForServer(url, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function startServer() {
  const isWin = process.platform === 'win32';
  const child = spawn(
    isWin ? 'npx.cmd' : 'npx',
    ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, shell: isWin, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (d) => process.stdout.write(`[vite] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  return child;
}

function stopServer(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
    });
  } else {
    child.kill('SIGTERM');
  }
}

function chunked(str) {
  const parts = str.match(/.{1,100}/g) || [];
  return parts.map((p) => `'${p}'`).join(' +\n    ');
}

function modelSource(model, report, date) {
  const pct = (v) => (v * 100).toFixed(2);
  return `// 由 \`npm run train:digits\` 自动生成，请勿手改。
// 训练日期：${date}
// 评测集（${report.evalSamples} 条，独立随机种子）：
//   总准确率 ${pct(report.overall)}%，数字 ${pct(report.digit)}%，
//   非数字拒绝 ${pct(report.junkReject)}%，正确样本最低概率 ${report.minP.toFixed(3)}
//
// 输入：28x28 零均值单位 L2 的归一化字形（与 cells.js 的 normalizeGlyph 一致）。
// 输出：10 类（0..8 → 数字 1..9，9 → 不是数字）。权重为 Float32 的 base64。
export const DIGIT_NET = {
  input: ${model.input},
  hidden: ${model.hidden},
  w1: ${chunked(model.w1)},
  b1: ${chunked(model.b1)},
  w2: ${chunked(model.w2)},
  b2: ${chunked(model.b2)},
};
`;
}

const opts = parseArgs(process.argv.slice(2));
const trainOpts = {
  rounds: opts.rounds ?? 8,
  evalRounds: opts.evalRounds ?? 3,
  epochs: opts.epochs ?? 32,
  hidden: opts.hidden ?? 96,
  batch: opts.batch ?? 64,
  lr: opts.lr ?? 0.003,
};

let server = null;
const needsServer = !(await waitForServer(URL, 800));
if (needsServer) {
  console.log('启动临时 Vite dev server…');
  server = startServer();
  if (!(await waitForServer(URL, 90_000))) {
    stopServer(server);
    console.error('Vite 没有起来，训练中止');
    process.exit(1);
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'log') console.log(msg.text());
  });
  page.on('pageerror', (e) => console.error('[pageerror]', String(e)));

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__trainReady === true, null, {
    timeout: 120_000,
  });

  console.log('训练开始', trainOpts);
  const result = await page.evaluate((o) => window.runTraining(o), trainOpts);

  const date = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(
    path.resolve('src/vision/digit-net.js'),
    modelSource(result.model, result.report, date),
  );
  fs.writeFileSync(
    path.resolve('test/fixtures/digit-vectors.json'),
    JSON.stringify(result.fixture) + '\n',
  );

  console.log('\n=== 训练完成 ===');
  console.log(
    `样本 ${result.report.samples}，评测 ${result.report.evalSamples}，` +
      `总准确率 ${(result.report.overall * 100).toFixed(2)}%，` +
      `数字 ${(result.report.digit * 100).toFixed(2)}%，` +
      `非数字拒绝 ${(result.report.junkReject * 100).toFixed(2)}%，` +
      `耗时 ${result.report.ms}ms`,
  );
  console.log('已写入 src/vision/digit-net.js 与 test/fixtures/digit-vectors.json');
} finally {
  await browser.close();
  stopServer(server);
}
