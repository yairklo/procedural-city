// Deterministic, seedable random numbers. Same seed -> same city on every machine.

/** FNV-1a 32-bit hash of a string. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Creates a random stream from any seed (string or number).
 * Uses a 32-bit counter passed through an integer finalizer (splitmix-style).
 *
 * `fork(label)` derives an independent stream, so changing how many numbers one
 * stage consumes (e.g. lot splitting) does not reshuffle another (e.g. names).
 */
export function createRng(seed) {
  const label = String(seed);
  let state = hashString(label);

  const next = () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    z = (z ^ (z >>> 16)) >>> 0;
    return z / 4294967296;
  };

  return {
    seed: label,
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const t = arr[i];
        arr[i] = arr[j];
        arr[j] = t;
      }
      return arr;
    },
    fork: (sub) => createRng(`${label}/${sub}`),
  };
}
