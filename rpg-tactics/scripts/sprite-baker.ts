/** Offline only: turn the existing rigs into eight-direction sprite atlases. */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buildWolf, buildPlayerWolf, buildBat, buildSpider, buildGargoyle, buildTombstone } from '../../rpg-3d/src/client/models.js';
import { graphicsAssetUrl } from '../src/client/graphics.js';

const W = 192, DIRECTIONS = 8, FRAMES = 4;
THREE.DefaultLoadingManager.setURLModifier(url => graphicsAssetUrl(url, 'low'));
const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, W); renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffecd4, 0x706860, 2.4));
const light = new THREE.DirectionalLight(0xffffff, 2.8); light.position.set(3, 5, 4); scene.add(light);
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .01, 100);
const result: Record<string, { png: string; span: number; center: number }> = {};

async function bake(name: string, rig: any, dead = false, bite = false, eat = false, stone = false, resolution = W) {
  const model: THREE.Group = rig.model;
  scene.add(model);
  renderer.setSize(resolution, resolution);
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z) * 1.3;
  const overhead = name === 'spider-wall';
  const frames = overhead ? 9 : bite || eat ? 8 : FRAMES;
  const atlas = document.createElement('canvas'); atlas.width = resolution * DIRECTIONS; atlas.height = resolution * frames;
  const ctx = atlas.getContext('2d')!;
  rig.mixer?.stopAllAction();
  const action = dead ? rig.deathAction
    : eat ? rig.eatAction : bite ? rig.attackAction : rig.runAction ?? rig.flightAction ?? rig.walkAction;
  if ((bite || eat) && !action) throw new Error("Player attack/eating animation is missing");
  action?.reset().play();
  camera.left = -span / 2; camera.right = span / 2; camera.top = span / 2; camera.bottom = -span / 2;
  camera.updateProjectionMatrix();
  for (let f = 0; f < frames; f++) {
    if (dead && action) {
      rig.mixer?.setTime(action.getClip().duration * 0.98);
    } else if (action) {
      if (bite || eat) {
        action.reset().play(); action.clampWhenFinished = true;
        rig.mixer?.setTime(action.getClip().duration * f / frames);
      } else if (f === 0) rig.mixer?.stopAllAction();
      else { action.play(); rig.mixer?.setTime(action.getClip().duration * (f - 1) / (frames - 1)); }
    }
    for (let d = 0; d < DIRECTIONS; d++) {
      const angle = d / DIRECTIONS * Math.PI * 2;
      if (overhead) {
        camera.position.set(center.x, center.y + 20, center.z);
        camera.up.set(Math.cos(angle), 0, Math.sin(angle));
      } else {
        camera.up.set(0, 1, 0);
        camera.position.set(center.x + Math.cos(angle) * 20, center.y + (name.startsWith("player") ? 5.5 : 2), center.z + Math.sin(angle) * 20);
      }
      camera.lookAt(center);
      renderer.render(scene, camera);
      ctx.drawImage(renderer.domElement, d * resolution, f * resolution);
    }
  }
  if (stone) {
    const pixels = ctx.getImageData(0, 0, atlas.width, atlas.height);
    for (let index = 0; index < pixels.data.length; index += 4) {
      if (pixels.data[index + 3] === 0) continue;
      const luminance = pixels.data[index]! * .24 + pixels.data[index + 1]! * .62 + pixels.data[index + 2]! * .14;
      const value = Math.min(255, Math.round(luminance * 1.65 + 42));
      pixels.data[index] = value;
      pixels.data[index + 1] = value;
      pixels.data[index + 2] = value;
    }
    ctx.putImageData(pixels, 0, 0);
  }
  result[name] = { png: atlas.toDataURL('image/png'), span: span * 30, center: center.y * 30 };
  scene.remove(model);
}
async function run() {
  const rigs: Record<string, any> = { hellhound: buildWolf(new THREE.Color(0x6c6572)), player: buildPlayerWolf(), bat: buildBat(), spider: buildSpider(), gargoyle: buildGargoyle(), cross: { model: buildTombstone() } };
  // LoadingManager covers nested textures too; callbacks finish on this microtask.
  await new Promise<void>(resolve => { THREE.DefaultLoadingManager.onLoad = () => setTimeout(resolve, 100); });
  const snakeGltf = await new GLTFLoader().loadAsync('/shared-models/snake/scene.gltf');
  const snake = snakeGltf.scene;
  // The viper's head is on source +Z and its tail extends down -Z. Rotate the
  // head onto world +X so a snake looking toward the camera selects a head-on
  // column rather than its tail or side.
  // This makes direction zero genuinely the face, with direction four the tail.
  snake.rotation.y = Math.PI / 2;
  snake.traverse((node: THREE.Object3D) => {
    if (!(node instanceof THREE.Mesh)) return;
    for (const material of (Array.isArray(node.material) ? node.material : [node.material])) {
      const mapped = material as THREE.Material & { map?: THREE.Texture | null; color?: THREE.Color };
      if (!mapped.map?.image) continue;
      const source = mapped.map.image as CanvasImageSource & { width: number; height: number };
      const textureCanvas = document.createElement('canvas');
      textureCanvas.width = source.width; textureCanvas.height = source.height;
      const textureContext = textureCanvas.getContext('2d', { willReadFrequently: true })!;
      textureContext.drawImage(source, 0, 0);
      const pixels = textureContext.getImageData(0, 0, textureCanvas.width, textureCanvas.height);
      for (let index = 0; index < pixels.data.length; index += 4) {
        pixels.data[index] = Math.round(pixels.data[index]! * 0.58);
        pixels.data[index + 1] = Math.round(pixels.data[index + 1]! * 0.58);
        pixels.data[index + 2] = Math.round(pixels.data[index + 2]! * 0.58);
      }
      textureContext.putImageData(pixels, 0, 0);
      const recolored = new THREE.CanvasTexture(textureCanvas);
      recolored.colorSpace = THREE.SRGBColorSpace;
      recolored.flipY = mapped.map.flipY;
      mapped.map = recolored;
      mapped.color?.set(0xffffff);
      mapped.needsUpdate = true;
    }
  });
  snake.updateMatrixWorld(true);
  const snakeBounds = new THREE.Box3().setFromObject(snake);
  const snakeSize = snakeBounds.getSize(new THREE.Vector3());
  // 9.6 units makes the billboard exactly twice the original 4.8-unit bake.
  snake.scale.multiplyScalar(9.6 / Math.max(snakeSize.x, snakeSize.y, snakeSize.z));
  snake.updateMatrixWorld(true);
  const scaledSnakeBounds = new THREE.Box3().setFromObject(snake);
  const snakeCenter = scaledSnakeBounds.getCenter(new THREE.Vector3());
  snake.position.set(-snakeCenter.x, -scaledSnakeBounds.min.y, -snakeCenter.z);
  const snakeMixer = new THREE.AnimationMixer(snake);
  const normalizedClipName = (clip: THREE.AnimationClip) => clip.name.toLowerCase().replace(/[^a-z]/g, '');
  const moveClip = snakeGltf.animations.find(clip => normalizedClipName(clip) === 'crawl');
  const attackClip = snakeGltf.animations.find(clip => normalizedClipName(clip).startsWith('bitestand'));
  const deathClip = snakeGltf.animations.find(clip => normalizedClipName(clip) === 'death');
  if (!moveClip) throw new Error('Viper crawl animation is missing');
  if (!attackClip) throw new Error('Viper bitestand animation is missing');
  const moveAction = snakeMixer.clipAction(moveClip);
  rigs.snake = {
    model: snake,
    mixer: snakeMixer,
    runAction: moveAction,
    attackAction: snakeMixer.clipAction(attackClip),
    deathAction: deathClip ? snakeMixer.clipAction(deathClip) : undefined,
  };
  rigs.hellhound.model.scale.multiplyScalar(1.95);
  for (const [name, rig] of Object.entries(rigs)) {
    if (name === 'cross') {
      // Bake the buried base away so it cannot paint over the raycast floor.
      renderer.localClippingEnabled = true;
      rig.model.traverse((node: THREE.Object3D) => {
        if (node instanceof THREE.Mesh) for (const material of (Array.isArray(node.material) ? node.material : [node.material]))
          material.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 1, 0), -.12)];
      });
      await bake(name, rig);
      renderer.localClippingEnabled = false;
      continue;
    }
    if (name === 'player') { rig.sword.removeFromParent(); rig.dagger.removeFromParent(); }
    await bake(name, rig);
    if (name === 'spider') {
      rig.mixer?.stopAllAction();
      await bake('spider-wall', rig);
      // The floor statue displays at three times enemy scale. Bake three times
      // as many pixels per frame so that enlargement does not magnify the
      // standard 192px enemy atlas.
      await bake('spider-statue', rig, false, false, false, true, W * 3);
      const position = rig.model.position.clone();
      const rotation = rig.model.rotation.clone();
      // Stand the authored +X-facing spider on its head. The regular orbiting
      // cameras now reveal front, side, and back perspectives while world up
      // remains screen-up; unlike rotating an overhead atlas, it never rolls.
      rig.model.rotation.z = -Math.PI / 2;
      rig.model.updateMatrixWorld(true);
      const uprightBounds = new THREE.Box3().setFromObject(rig.model);
      const uprightCenter = uprightBounds.getCenter(new THREE.Vector3());
      rig.model.position.x -= uprightCenter.x;
      rig.model.position.y -= uprightBounds.min.y;
      rig.model.position.z -= uprightCenter.z;
      await bake('spider-wall-statue', rig, false, false, false, true);
      rig.model.position.copy(position);
      rig.model.rotation.copy(rotation);
      rig.model.updateMatrixWorld(true);
    }
    if (name === 'player') {
      await bake('player-bite', rig, false, true);
      rig.mixer?.stopAllAction();
      await bake('player-eat', rig, false, false, true);
    }
    if (name === 'snake') {
      await bake('snake-attack', rig, false, true);
    }
    rig.mixer?.stopAllAction();
    if (name === 'spider') rig.model.rotation.z = Math.PI;
    else if (name !== 'snake') rig.model.rotation.x = name === 'bat' ? Math.PI : Math.PI / 2;
    rig.model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(rig.model);
    rig.model.position.y -= box.min.y;
    await bake(`${name}-dead`, rig, true);
  }
  for (const [name, path] of [['boulder', 'simple-rock/scene.gltf'], ['angel', 'angel-statue/scene-low.glb'], ['gem', 'purple-gem/scene.gltf']]) {
    const gltf = await new GLTFLoader().loadAsync(`/shared-models/${path}`);
    const model = gltf.scene;
    if (name === 'boulder') model.traverse(node => {
      if (node instanceof THREE.Mesh) for (const material of (Array.isArray(node.material) ? node.material : [node.material]))
        if ('color' in material) (material as THREE.MeshStandardMaterial).color.multiplyScalar(.38);
    });
    if (name === 'gem') model.traverse(node => {
      if (!(node instanceof THREE.Mesh)) return;
      for (const material of (Array.isArray(node.material) ? node.material : [node.material])) {
        if (material instanceof THREE.MeshStandardMaterial) {
          material.map = null; material.color.setHex(0xa92fff);
          material.emissive.setHex(0x7114cc); material.emissiveIntensity = 1.55;
          material.metalness = Math.max(.28, material.metalness);
          material.roughness = Math.min(.3, material.roughness);
        }
      }
    });
    const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3());
    model.scale.setScalar((name === 'angel' ? 4.2 : name === 'gem' ? 1.55 : 2.7) / Math.max(size.x, size.y, size.z));
    model.updateMatrixWorld(true);
    const scaled = new THREE.Box3().setFromObject(model), center = scaled.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -scaled.min.y, -center.z);
    if (name === 'boulder') {
      renderer.localClippingEnabled = true;
      model.traverse(node => {
        if (node instanceof THREE.Mesh) for (const material of (Array.isArray(node.material) ? node.material : [node.material]))
          material.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 1, 0), -.2)];
      });
    }
    await bake(name!, { model });
    renderer.localClippingEnabled = false;
  }
  for (const [name, path] of [
    ['dead-tree-1', 'dead-tree-1/scene.gltf'],
    ['dead-tree-2', 'dead-tree-2/scene.gltf'],
    ['dead-tree-3', 'dead-tree-3/scene.gltf'],
  ]) {
    const gltf = await new GLTFLoader().loadAsync(`/shared-models/${path}`);
    const model = gltf.scene;
    model.updateMatrixWorld(true);
    const sourceBounds = new THREE.Box3().setFromObject(model);
    const sourceSize = sourceBounds.getSize(new THREE.Vector3());
    // A little shorter than the doubled dungeon walls, but broad enough for
    // the branches to read clearly from every baked direction.
    model.scale.setScalar(7.4 / Math.max(sourceSize.x, sourceSize.y, sourceSize.z));
    model.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(model);
    const center = bounds.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -bounds.min.y, -center.z);
    await bake(name!, { model });
  }
  // A squat stone block shared by both spider statues. The seeded mottling is
  // baked into the atlas, so it remains crisp and stable at every quality.
  const pedestalTexture = document.createElement('canvas');
  pedestalTexture.width = pedestalTexture.height = 96;
  const pedestalContext = pedestalTexture.getContext('2d')!;
  const pedestalPixels = pedestalContext.createImageData(96, 96);
  let pedestalSeed = 0x51a7c3;
  const pedestalRandom = () => {
    pedestalSeed ^= pedestalSeed << 13; pedestalSeed ^= pedestalSeed >>> 17; pedestalSeed ^= pedestalSeed << 5;
    return (pedestalSeed >>> 0) / 4294967296;
  };
  for (let index = 0; index < pedestalPixels.data.length; index += 4) {
    const grain = Math.round((pedestalRandom() - .5) * 34);
    const broad = Math.sin((index / 4 % 96) * .17) * 8 + Math.sin(Math.floor(index / 4 / 96) * .13) * 7;
    const value = Math.max(74, Math.min(188, Math.round(128 + grain + broad)));
    pedestalPixels.data[index] = Math.round(value * .96);
    pedestalPixels.data[index + 1] = value;
    pedestalPixels.data[index + 2] = Math.min(255, Math.round(value * 1.03));
    pedestalPixels.data[index + 3] = 255;
  }
  pedestalContext.putImageData(pedestalPixels, 0, 0);
  for (let blotch = 0; blotch < 42; blotch++) {
    const light = pedestalRandom() > .48;
    pedestalContext.fillStyle = light ? 'rgba(225,228,230,.17)' : 'rgba(44,49,53,.2)';
    pedestalContext.beginPath();
    pedestalContext.ellipse(pedestalRandom() * 96, pedestalRandom() * 96,
      3 + pedestalRandom() * 12, 2 + pedestalRandom() * 8, pedestalRandom() * Math.PI, 0, Math.PI * 2);
    pedestalContext.fill();
  }
  const pedestalMap = new THREE.CanvasTexture(pedestalTexture);
  pedestalMap.colorSpace = THREE.SRGBColorSpace;
  pedestalMap.wrapS = pedestalMap.wrapT = THREE.RepeatWrapping;
  pedestalMap.repeat.set(2.5, 1.25);
  const pedestalMaterial = new THREE.MeshStandardMaterial({ map: pedestalMap, color: 0xc3c6c9, roughness: .96, metalness: 0 });
  const pedestal = new THREE.Mesh(new THREE.BoxGeometry(6.2, 1.15, 4.8), pedestalMaterial);
  pedestal.position.y = .575;
  const pedestalModel = new THREE.Group(); pedestalModel.add(pedestal);
  await bake('spider-pedestal', { model: pedestalModel });
  (window as any).spriteBake = result;
}
run().catch(error => { (window as any).spriteError = String(error.stack ?? error); });
