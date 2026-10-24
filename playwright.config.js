import { defineConfig } from '@playwright/test';

// 用本机安装的 Chrome 跑合成端到端测试（无需下载浏览器）。
// 运行：npm run test:e2e
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    channel: 'chrome',
    headless: true,
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1400, height: 1000 },
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173/debug/synthetic.html',
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
