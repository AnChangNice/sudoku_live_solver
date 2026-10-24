// 加载 OpenCV.js（UMD 单文件，兼容全局对象 / Promise / 工厂函数三种导出形态）。

export async function loadOpenCV(url, timeoutMs = 60000) {
  if (!globalThis.cv) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('识别引擎下载失败，请检查网络后重试'));
      document.head.appendChild(script);
    });
  }

  let cv = globalThis.cv;

  // Emscripten 的 Module 自带 then()：它把回调当作“运行时就绪”通知，并且
  // 回调参数/返回值仍是 Module 自己。因此它是个 thenable，却永远解析不完。
  // 若直接 `await cv`，或从 async 函数里 `return cv`，Promise 解析器会不断
  // 同化它，最终耗尽栈/堆、标签页崩溃。这里手动接住回调，并在交给 Promise
  // 之前先摘掉 then。
  if (cv && typeof cv.then === 'function') {
    cv = await adoptModule(cv);
  } else if (typeof cv === 'function' && !cv.Mat) {
    cv = await adoptModule(cv());
  }

  if (!cv) throw new Error('识别引擎加载失败');
  cv = stripThen(cv);

  if (!cv.Mat) {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        reject(new Error('识别引擎初始化超时'));
      }, timeoutMs);
      // 有的构建在 onload 前就完成了初始化，onRuntimeInitialized 不会再触发，
      // 所以同时轮询 cv.Mat 兜底。
      const poll = setInterval(() => {
        if (cv.Mat) finish();
      }, 50);
      const previous = cv.onRuntimeInitialized;
      cv.onRuntimeInitialized = () => {
        if (previous) previous();
        finish();
      };
      if (cv.Mat) finish();
    });
  }

  globalThis.cv = cv;
  return cv;
}

/**
 * 等待模块就绪，并保证解析结果不再是 thenable。
 * Emscripten 的 then(cb) 会回调模块自身；真实 Promise 也可以走同一条路径。
 */
function adoptModule(value) {
  return new Promise((resolve, reject) => {
    if (!value || typeof value.then !== 'function') {
      resolve(stripThen(value));
      return;
    }
    try {
      value.then(
        (mod) => resolve(stripThen(mod || value)),
        (err) => reject(err || new Error('识别引擎初始化失败')),
      );
    } catch (err) {
      reject(err);
    }
  });
}

/** 摘掉 Emscripten Module 的回调式 then，避免 Promise 无限同化。 */
function stripThen(value) {
  if (value && typeof value.then === 'function') {
    try {
      delete value.then;
    } catch {
      // 忽略，下面再尝试赋值
    }
    if (typeof value.then === 'function') {
      try {
        value.then = undefined;
      } catch {
        // 极端情况下属性不可写；此时只能依赖调用方不要 await 它
      }
    }
  }
  return value;
}
