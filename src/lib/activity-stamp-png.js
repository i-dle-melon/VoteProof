export const MAX_STAMP_ICON_LENGTH = 370000;

export function decodeStampPng(encoded) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function paeth(left, up, corner) {
  const estimate = left + up - corner;
  const a = Math.abs(estimate - left), b = Math.abs(estimate - up), c = Math.abs(estimate - corner);
  return a <= b && a <= c ? left : b <= c ? up : corner;
}

// The editor re-encodes artwork as an 8-bit RGBA PNG with no interlacing.
export async function validStampPng(encoded) {
  if (typeof encoded !== 'string' || encoded.length > MAX_STAMP_ICON_LENGTH ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return false;
  try {
    const bytes = decodeStampPng(encoded);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 45 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a ||
        view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452 ||
        bytes[24] !== 8 || bytes[25] !== 6 || bytes[26] || bytes[27] || bytes[28]) return false;
    const width = view.getUint32(16), height = view.getUint32(20);
    if (!width || !height || width > 256 || height > 256) return false;
    const data = [];
    let end = false;
    for (let offset = 33, count = 0; offset + 12 <= bytes.length && count < 128; count++) {
      const size = view.getUint32(offset), type = view.getUint32(offset + 4);
      const next = offset + size + 12;
      if (next > bytes.length) return false;
      if (type === 0x49454e44) {
        end = size === 0 && next === bytes.length;
        break;
      }
      if (type === 0x49444154) data.push(bytes.subarray(offset + 8, next - 4));
      offset = next;
    }
    if (!end || !data.length) return false;
    const stride = width * 4 + 1, pixels = new Uint8Array(height * stride);
    const reader = new Blob(data).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
    let offset = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (offset + value.length > pixels.length) { await reader.cancel(); return false; }
        pixels.set(value, offset);
        offset += value.length;
      }
    } finally { reader.releaseLock(); }
    if (offset !== pixels.length) return false;

    const above = new Uint8Array(width);
    let transparent = false, visible = false;
    for (let y = 0; y < height; y++) {
      const row = y * stride, filter = pixels[row];
      if (filter > 4) return false;
      let left = 0, corner = 0;
      for (let x = 0; x < width; x++) {
        const up = above[x];
        let alpha = pixels[row + 4 + x * 4];
        if (filter === 1) alpha += left;
        if (filter === 2) alpha += up;
        if (filter === 3) alpha += (left + up) >> 1;
        if (filter === 4) alpha += paeth(left, up, corner);
        above[x] = left = alpha & 255;
        corner = up;
        transparent ||= left < 255;
        visible ||= left > 0;
      }
    }
    return transparent && visible;
  } catch {
    return false;
  }
}
