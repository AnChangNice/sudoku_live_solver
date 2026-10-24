// 相册/拍照文件 → 受尺寸限制的 canvas。

export async function loadImageToCanvas(file, canvas, maxLongSide = 1600) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    bitmap = await decodeWithImageElement(file);
  }

  const scale = Math.min(
    1,
    maxLongSide / Math.max(bitmap.width, bitmap.height),
  );
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return { width: w, height: h };
}

function decodeWithImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('无法读取该图片'));
    };
    img.src = url;
  });
}
