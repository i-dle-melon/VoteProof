import { stampPngSize } from './campaign-collection.js';

export async function prepareStampIcon(file) {
  if (file.size > 1024 * 1024) throw Error('圖案檔案不得超過 1 MB。');
  const size = stampPngSize(new Uint8Array(await file.slice(0, 33).arrayBuffer()));
  if (!size?.width || !size?.height) throw Error('請選擇透明背景的 PNG 圖片。');
  if (size.width > 1024 || size.height > 1024) throw Error('圖案長寬不得超過 1024 像素。');
  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw Error('無法讀取這張 PNG，請選擇其他檔案。'); }
  try {
    const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let hasTransparency = false, hasArtwork = false;
    for (let i = 3; i < data.length; i += 4) {
      hasTransparency ||= data[i] < 255;
      hasArtwork ||= data[i] > 0;
      if (hasTransparency && hasArtwork) break;
    }
    if (!hasTransparency || !hasArtwork) throw Error('PNG 必須同時包含透明背景與可見的圖案。');
    return canvas.toDataURL('image/png').split(',')[1];
  } finally { bitmap.close(); }
}

export function stampPhase(stamp, now = Date.now()) {
  if (stamp.status !== 'published') return stamp.status;
  if (now < Date.parse(stamp.opens_at)) return 'scheduled';
  return now < Date.parse(stamp.closes_at) ? 'open' : 'ended';
}
