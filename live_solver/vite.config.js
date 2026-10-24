import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath } from 'node:url';

// base: './' 让构建产物在 GitHub Pages 子路径、自定义域名、本地预览下都能用。
// `npm run dev:lan`（--mode lan）会启用 HTTPS，便于手机通过局域网访问；
// 注意 iOS 可能拒绝不受信任证书的摄像头权限，真机验收仍以 Pages 为准。
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'lan' ? [basicSsl()] : [],
  server: { host: mode === 'lan' },
  preview: { host: mode === 'lan' },
  // 把调试页也纳入启动扫描，避免首次访问时才优化依赖、触发整页重载。
  // 重载如果恰好撞上 OpenCV 的 WASM 初始化，会让标签页崩溃。
  optimizeDeps: {
    entries: ['index.html', 'debug/synthetic.html'],
  },
  build: {
    target: 'es2020',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        synthetic: fileURLToPath(new URL('./debug/synthetic.html', import.meta.url)),
      },
    },
  },
}));
