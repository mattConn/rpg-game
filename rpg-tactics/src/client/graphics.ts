import { TEXTURE_VARIANTS } from "./texture-manifest.js";

export type GraphicsQuality = "low" | "med" | "high" | "max";

export const GRAPHICS_PRESETS = {
  low: { renderWidth: 320, textureSize: 64, maxFps: 30 },
  med: { renderWidth: 480, textureSize: 128, maxFps: 60 },
  high: { renderWidth: 640, textureSize: 256, maxFps: Infinity },
  max: { renderWidth: 960, textureSize: 512, maxFps: Infinity },
} as const;

const STORAGE_KEY = "rpg-graphics-quality";

export function readGraphicsQuality(): GraphicsQuality {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "low" || saved === "med" || saved === "high" || saved === "max") return saved;
  } catch { /* Settings still work when storage is unavailable. */ }
  return "high";
}

export function setupGraphicsControl(initial: GraphicsQuality, onChange: (quality: GraphicsQuality) => void) {
  const control = document.getElementById("graphics-quality") as HTMLSelectElement;
  control.value = initial;
  // Keyboard selection must not move the player or trigger combat shortcuts.
  control.addEventListener("keydown", (event) => event.stopPropagation());
  control.addEventListener("keyup", (event) => event.stopPropagation());
  control.addEventListener("change", () => {
    const quality = control.value as GraphicsQuality;
    try { localStorage.setItem(STORAGE_KEY, quality); } catch { /* Optional persistence. */ }
    onChange(quality);
    control.blur();
  });
}

/** Resolve texture and mesh detail together; leave blob/data URLs and originals alone. */
export function graphicsAssetUrl(url: string, quality: GraphicsQuality): string {
  if (quality === "high" || quality === "max") return url;
  const texture = TEXTURE_VARIANTS[url];
  if (texture) return texture[quality];
  return url.replace(
    /(\/shared-models\/(?:bat|gray-wolf|spider|gargoyle-statue)\/)scene\.gltf$/,
    `$1scene-${quality}.gltf`,
  );
}
