# 实时数独求解（摄像头 + AR 叠加）

用摄像头对准纸质或屏幕上的数独，浏览器自动检测九宫格、识别已知数字、求解，并把答案以绿色数字直接叠加到空格中。图像处理全部在本地完成，画面不上传。

## 在线使用

部署后地址：<https://anchangnice.github.io/sudoku_live_solver/>

手机浏览器可直接打开（摄像头需要 HTTPS）。

## 开发

```bash
cd live_solver
npm install
npm run dev
```

完整说明见 [live_solver/README.md](live_solver/README.md)：使用方法、实现细节、测试、隐私与部署。

## 目录

- `live_solver/` — Web 应用（Vite + OpenCV.js + Canvas）
- `.github/workflows/deploy.yml` — 推送到 `master` 后自动测试、构建并发布 GitHub Pages
- `c/` — 早期的 C 语言命令行数独求解器
