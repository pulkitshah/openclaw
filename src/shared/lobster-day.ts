// "Lobster day" calendar hash for the Control UI pet's wardrobe. The CLI
// banner's ASCII cousin used to share it; that art is retired, so the hash is
// module-local now. Roughly one day in sixteen hits.

function lobsterDayHash(now: Date): number {
  const key = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function isLobsterDay(now: Date): boolean {
  return lobsterDayHash(now) % 16 === 3;
}
