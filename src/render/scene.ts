import * as THREE from "three";

export interface SceneBundle {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  sun: THREE.DirectionalLight;
  ambient: THREE.AmbientLight;
}

export function createSceneBundle(canvas: HTMLCanvasElement): SceneBundle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  // Size against the canvas's parent (or the canvas itself) rather than innerWidth.
  const host = canvas.parentElement;
  const w = host?.clientWidth || innerWidth;
  const h = host?.clientHeight || innerHeight;
  renderer.setSize(w, h, false);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x88aacc);
  scene.fog = new THREE.Fog(0x88aacc, 60, 220);

  const sun = new THREE.DirectionalLight(0xfff2dd, 1.4);
  sun.position.set(80, 120, 60);
  scene.add(sun);

  const ambient = new THREE.AmbientLight(0x88aacc, 0.55);
  scene.add(ambient);

  // Sky-ish hemisphere fill
  const hemi = new THREE.HemisphereLight(0xbcd6ff, 0x404030, 0.5);
  scene.add(hemi);

  return { scene, renderer, sun, ambient };
}
