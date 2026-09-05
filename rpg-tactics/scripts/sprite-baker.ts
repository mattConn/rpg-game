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

async function bake(name: string, rig: any, dead = false, bite = false, eat = false) {
  const model: THREE.Group = rig.model;
  scene.add(model);
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z) * 1.3;
  const overhead = name === 'spider-wall';
  const frames = overhead ? 9 : bite || eat ? 8 : FRAMES;
  const atlas = document.createElement('canvas'); atlas.width = W * DIRECTIONS; atlas.height = W * frames;
  const ctx = atlas.getContext('2d')!;
  rig.mixer?.stopAllAction();
  const action = eat ? rig.eatAction : bite ? rig.attackAction : rig.runAction ?? rig.flightAction ?? rig.walkAction;
  if ((bite || eat) && !action) throw new Error("Player attack/eating animation is missing");
  if (!dead) action?.reset().play();
  camera.left = -span / 2; camera.right = span / 2; camera.top = span / 2; camera.bottom = -span / 2;
  camera.updateProjectionMatrix();
  for (let f = 0; f < frames; f++) {
    if (!dead && action) {
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
      ctx.drawImage(renderer.domElement, d * W, f * W);
    }
  }
  result[name] = { png: atlas.toDataURL('image/png'), span: span * 30, center: center.y * 30 };
  scene.remove(model);
}
async function run() {
  const rigs: Record<string, any> = { hellhound: buildWolf(new THREE.Color(0x6c6572)), player: buildPlayerWolf(), bat: buildBat(), spider: buildSpider(), gargoyle: buildGargoyle(), cross: { model: buildTombstone() } };
  // LoadingManager covers nested textures too; callbacks finish on this microtask.
  await new Promise<void>(resolve => { THREE.DefaultLoadingManager.onLoad = () => setTimeout(resolve, 100); });
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
    }
    if (name === 'player') {
      await bake('player-bite', rig, false, true);
      rig.mixer?.stopAllAction();
      await bake('player-eat', rig, false, false, true);
    }
    rig.mixer?.stopAllAction();
    if (name === 'spider') rig.model.rotation.z = Math.PI;
    else rig.model.rotation.x = name === 'bat' ? Math.PI : Math.PI / 2;
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
  (window as any).spriteBake = result;
}
run().catch(error => { (window as any).spriteError = String(error.stack ?? error); });
