import './styles.css';
// 只带拉丁子集：叠加答案的 1–9 优先用这两套字体，界面中文用系统中文字体。
// （数字识别已改用随包发布的预训练分类器，启动时不再依赖字体加载。）
import '@fontsource/roboto/latin-400.css';
import '@fontsource/roboto/latin-700.css';
import '@fontsource/noto-sans/latin-400.css';
import '@fontsource/noto-sans/latin-700.css';

import { loadOpenCV } from './opencv-loader.js';
import { createRecognizer } from './vision/recognize.js';
import { UI } from './ui.js';
import { App } from './app.js';
import { CONFIG } from './config.js';

async function main() {
  const ui = new UI();
  ui.showLoading();

  try {
    const base = import.meta.env.BASE_URL || './';
    const url = new URL(
      `${base}vendor/opencv.js?v=${CONFIG.opencvVersion}`,
      document.baseURI,
    ).href;

    const cv = await loadOpenCV(url);
    const recognizer = await createRecognizer();

    const app = new App({ cv, cfg: CONFIG, ui, recognizer });
    app.init();
    // 仅开发/测试环境暴露，便于端到端测试断言盘面与解。
    if (import.meta.env.DEV) globalThis.__sudokuApp = app;

    ui.hideLoading();
    ui.showGate();
  } catch (err) {
    console.error(err);
    ui.hideLoading();
    ui.showError(err?.message || '初始化失败，请刷新重试');
  }
}

main();
