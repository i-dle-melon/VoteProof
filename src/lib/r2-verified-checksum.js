// Only provider-returned R2 checksums cross the verification trust boundary.
export const validSha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export function r2VerifiedSha256(object) {
  const value = object?.checksums?.sha256;
  if (!(value instanceof ArrayBuffer) || value.byteLength !== 32) return null;
  return Array.from(new Uint8Array(value), b => b.toString(16).padStart(2, '0')).join('');
}
