function hashCode(value) {
  let hash = 0;
  const input = String(value);
  if (input.length === 0) return hash;

  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) - hash) + input.charCodeAt(index);
    hash &= hash;
  }
  return Math.abs(hash);
}

function xorshift32(seed) {
  let value = seed;
  value ^= value << 13;
  value ^= value >> 17;
  value ^= value << 5;
  return Math.abs(value) / 0x7fffffff;
}

export function seededRandom(seed, max) {
  if (max <= 0) return 0;
  return Math.floor(xorshift32(hashCode(seed)) * max);
}