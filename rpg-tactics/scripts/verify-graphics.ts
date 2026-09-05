import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { TEXTURE_VARIANTS } from '../src/client/texture-manifest.js';
import { graphicsAssetUrl } from '../src/client/graphics.js';
for (const [source, variants] of Object.entries(TEXTURE_VARIANTS)) {
  assert.equal(graphicsAssetUrl(source, 'high'), source);
  for (const quality of ['low', 'med'] as const) {
    const url = graphicsAssetUrl(source, quality);
    assert.equal(url, variants[quality]);
    const info = await stat(new URL(`../public${url}`, import.meta.url));
    const response = await fetch(`http://localhost:3300${url}`, { method: 'HEAD' });
    assert.equal(response.status, 200, url);
    assert.equal(Number(response.headers.get('content-length')), info.size, url);
  }
}
for (const quality of ['low', 'med'] as const) {
  assert.equal(graphicsAssetUrl('/shared-models/bat/scene.gltf', quality), `/shared-models/bat/scene-${quality}.gltf`);
  assert.equal(graphicsAssetUrl('blob:unchanged', quality), 'blob:unchanged');
  assert.equal(graphicsAssetUrl('/unknown.png', quality), '/unknown.png');
}
console.log('All 76 generated assets resolve and are served with matching file sizes; model routing and High remain intact.');
