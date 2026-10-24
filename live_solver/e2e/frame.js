/**
 * 把一张图片铺进给定尺寸的画面，返回 I420 平面数据的 base64。
 * 供假摄像头（--use-file-for-fake-video-capture）构造 Y4M 用。
 *
 * fit='contain'：整张图完整放进画面（留边）；
 * fit='height' ：按高度铺满（照片左右被裁掉），更接近“手机立着对准摄像头”。
 */
export async function makeFrame({ dataUrl, width, height, fit = 'contain' }) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#5a5a55';
  ctx.fillRect(0, 0, width, height);

  if (fit === 'height') {
    const scale = height / img.naturalHeight;
    const w = img.naturalWidth * scale;
    ctx.drawImage(img, (width - w) / 2, 0, w, height);
  } else {
    const scale = Math.min(
      width / img.naturalWidth,
      height / img.naturalHeight,
    );
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
  }

  const data = ctx.getImageData(0, 0, width, height).data;
  const ySize = width * height;
  const cw = width >> 1;
  const ch = height >> 1;
  const yPlane = new Uint8Array(ySize);
  const uPlane = new Uint8Array(cw * ch);
  const vPlane = new Uint8Array(cw * ch);
  const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const i = (py * width + px) * 4;
      yPlane[py * width + px] = clamp8(
        0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2],
      );
    }
  }
  for (let py = 0; py < ch; py++) {
    for (let px = 0; px < cw; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const i = ((py * 2 + dy) * width + (px * 2 + dx)) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
        }
      }
      r /= 4;
      g /= 4;
      b /= 4;
      uPlane[py * cw + px] = clamp8(-0.168736 * r - 0.331264 * g + 0.5 * b + 128);
      vPlane[py * cw + px] = clamp8(0.5 * r - 0.418688 * g - 0.081312 * b + 128);
    }
  }

  const out = new Uint8Array(ySize + 2 * cw * ch);
  out.set(yPlane, 0);
  out.set(uPlane, ySize);
  out.set(vPlane, ySize + cw * ch);

  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < out.length; i += chunk) {
    s += String.fromCharCode.apply(null, out.subarray(i, i + chunk));
  }
  return { planes: btoa(s), width, height };
}

/** 生成可循环播放的 Y4M（同一帧重复 frames 次）。 */
export function y4m(planesBase64, { width, height, frames = 3, fps = 12 }) {
  const header = Buffer.from(
    `YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`,
    'ascii',
  );
  const buf = Buffer.from(planesBase64, 'base64');
  const parts = [header];
  for (let i = 0; i < frames; i++) {
    parts.push(Buffer.from('FRAME\n', 'ascii'), buf);
  }
  return Buffer.concat(parts);
}
