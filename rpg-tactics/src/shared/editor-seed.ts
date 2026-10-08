interface SeedableEditorLevel {
  width: number;
  height: number;
  tiles: Array<{ x: number; y: number; type: string }>;
  entities: Array<{ type: string; x: number; y: number; facing: number; label?: string }>;
}

/** Stable numeric identity for an editor room; names and transient entity IDs do not affect it. */
export function editorDungeonSeed(level: SeedableEditorLevel): number {
  const canonical = JSON.stringify({
    width: level.width,
    height: level.height,
    tiles: level.tiles,
    entities: level.entities.map(({ type, x, y, facing, label }) => ({ type, x, y, facing, label }))
      .sort((a, b) => a.y - b.y || a.x - b.x || a.type.localeCompare(b.type) || (a.label ?? "").localeCompare(b.label ?? "")),
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index++) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) || 1;
}
