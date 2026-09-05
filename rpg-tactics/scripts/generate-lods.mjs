// Generate index-only LODs: keep original vertex attributes, skins, and animations.
import { readFile, writeFile } from 'node:fs/promises';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import assert from 'node:assert/strict';
await MeshoptSimplifier.ready;
const root = new URL('../../public/models/', import.meta.url);
for (const model of ['bat', 'gray-wolf', 'spider', 'gargoyle-statue']) {
  const dir = new URL(`${model}/`, root);
  const source = JSON.parse(await readFile(new URL('scene.gltf', dir), 'utf8'));
  const buffers = await Promise.all(source.buffers.map(b => readFile(new URL(b.uri, dir))));
  function accessor(id) {
    const a = source.accessors[id], v = source.bufferViews[a.bufferView];
    assert(!a.sparse && !a.normalized, 'Unsupported accessor encoding');
    const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    const bytes = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 }[a.componentType];
    const read = { 5121: 'readUInt8', 5123: 'readUInt16LE', 5125: 'readUInt32LE', 5126: 'readFloatLE' }[a.componentType];
    const data = buffers[v.buffer], out = [];
    for (let i = 0; i < a.count; i++) for (let c = 0; c < components; c++)
      out.push(data[read]((v.byteOffset || 0) + (a.byteOffset || 0) + i * (v.byteStride || components * bytes) + c * bytes));
    return out;
  }
  for (const [quality, ratio, error] of [['low', 0.15, 0.03], ['med', 0.4, 0.015]]) {
    const doc = structuredClone(source), chunks = [];
    let offset = 0, before = 0, after = 0;
    for (const mesh of doc.meshes) for (const primitive of mesh.primitives) {
      assert(primitive.mode === undefined || primitive.mode === 4);
      const positions = new Float32Array(accessor(primitive.attributes.POSITION));
      const indices = new Uint32Array(accessor(primitive.indices));
      const [reduced] = MeshoptSimplifier.simplify(indices, positions, 3,
        Math.max(3, Math.floor(indices.length * ratio / 3) * 3), error);
      assert(reduced.length > 0 && reduced.length % 3 === 0);
      assert(reduced.every(i => i < positions.length / 3));
      const data = Buffer.from(reduced.buffer, reduced.byteOffset, reduced.byteLength);
      const view = doc.bufferViews.push({ buffer: source.buffers.length, byteOffset: offset, byteLength: data.length, target: 34963 }) - 1;
      primitive.indices = doc.accessors.push({ bufferView: view, componentType: 5125, count: reduced.length, type: 'SCALAR' }) - 1;
      chunks.push(data); offset += data.length;
      before += indices.length / 3; after += reduced.length / 3;
    }
    doc.buffers.push({ uri: `scene-${quality}.bin`, byteLength: offset });
    assert.deepEqual(doc.skins, source.skins);
    assert.deepEqual(doc.animations, source.animations);
    await writeFile(new URL(`scene-${quality}.bin`, dir), Buffer.concat(chunks));
    await writeFile(new URL(`scene-${quality}.gltf`, dir), JSON.stringify(doc));
    console.log(`${model} ${quality}: ${before} -> ${after} triangles (${Math.round((1-after/before)*100)}% reduction)`);
  }
}
