// 把 node_modules 里的 OpenCV.js 复制到 public/vendor，构建时随静态资源发布。
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'node_modules/@techstark/opencv-js/dist/opencv.js');
const destDir = resolve(root, 'public/vendor');
const dest = resolve(destDir, 'opencv.js');

await mkdir(destDir, { recursive: true });
await copyFile(src, dest);
console.log(`[copy-opencv] ${src} -> ${dest}`);
