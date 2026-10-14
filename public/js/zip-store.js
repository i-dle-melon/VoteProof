// ZIP32 STORE with data descriptors: image bytes are never buffered as a whole.
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export const crcUpdate = (crc, bytes) => {
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc >>> 0;
};
const header = (size, fields) => {
  const bytes = new Uint8Array(size),
    view = new DataView(bytes.buffer);
  for (const [offset, value, width = 4] of fields)
    width === 2 ? view.setUint16(offset, value, true) : view.setUint32(offset, value, true);
  return bytes;
};
export class ZipStore {
  constructor(write) {
    this.write = write;
    this.offset = 0;
    this.entries = [];
    this.names = new Set();
    this.finished = false;
  }
  async emit(bytes) {
    if (this.offset + bytes.length >= 0xffffffff) throw Error("ZIP_LIMIT");
    await this.write(bytes);
    this.offset += bytes.length;
  }
  async add(name, stream, expectedSize) {
    if (this.finished || !/^[A-Za-z0-9_-]+\.(png|jpg|webp|csv)$/.test(name) || this.names.has(name))
      throw Error("ZIP_INVALID_NAME");
    this.names.add(name);
    const encoded = encoder.encode(name),
      offset = this.offset;
    await this.emit(
      header(30, [
        [0, 0x04034b50],
        [4, 20, 2],
        [6, 0x808, 2],
        [8, 0, 2],
        [12, 33, 2],
        [26, encoded.length, 2],
      ]),
    );
    await this.emit(encoded);
    let crc = 0xffffffff,
      size = 0;
    const reader = stream.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw Error("ZIP_INVALID_BYTES");
        size += value.length;
        if (size > expectedSize) throw Error("EXPORT_PROOF_INTEGRITY");
        crc = crcUpdate(crc, value);
        await this.emit(value);
      }
      if (size !== expectedSize) throw Error("EXPORT_PROOF_INTEGRITY");
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    await this.emit(
      header(16, [
        [0, 0x08074b50],
        [4, crc],
        [8, size],
        [12, size],
      ]),
    );
    this.entries.push({ encoded, offset, crc, size });
  }
  async close() {
    if (this.finished) throw Error("ZIP_CLOSED");
    this.finished = true;
    const start = this.offset;
    for (const e of this.entries) {
      await this.emit(
        header(46, [
          [0, 0x02014b50],
          [4, 20, 2],
          [6, 20, 2],
          [8, 0x808, 2],
          [10, 0, 2],
          [14, 33, 2],
          [16, e.crc],
          [20, e.size],
          [24, e.size],
          [28, e.encoded.length, 2],
          [42, e.offset],
        ]),
      );
      await this.emit(e.encoded);
    }
    const size = this.offset - start;
    await this.emit(
      header(22, [
        [0, 0x06054b50],
        [8, this.entries.length, 2],
        [10, this.entries.length, 2],
        [12, size],
        [16, start],
      ]),
    );
  }
}
