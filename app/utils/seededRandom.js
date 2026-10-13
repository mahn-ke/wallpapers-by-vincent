import { createHash } from 'node:crypto';

export function seededHash(seed) {
  return createHash('sha256').update(String(seed)).digest('hex');
}

export function seededRandom(seed, max) {
  if (max <= 0) return 0;
  const value = createHash('sha256').update(String(seed)).digest().readUInt32BE(0);
  return Math.floor((value / 0x100000000) * max);
}