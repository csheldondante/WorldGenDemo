import * as THREE from "three";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { AssetCatalog, type AssetSpec } from "./catalog";

const WALL_MAT = new THREE.MeshStandardMaterial({ color: 0x8b6f4a, roughness: 0.9 });
const ROOF_MAT = new THREE.MeshStandardMaterial({ color: 0x4a3520, roughness: 0.95 });

function makeShantyGeometry(rng: () => number): THREE.BufferGeometry {
  const w = 1.0;
  const d = 1.0;
  const h = 0.7 + rng() * 0.2;
  const walls = new THREE.BoxGeometry(w, h, d);
  walls.translate(0, h * 0.5, 0);

  const roofH = 0.4;
  const roof = new THREE.BoxGeometry(w * 1.05, roofH, d * 1.1);
  roof.translate(0, h + roofH * 0.5, 0);
  roof.rotateZ(0.18); // tiny lean

  return BufferGeometryUtils.mergeGeometries([walls, roof], true)!;
}

const shanty: AssetSpec = {
  id: "shanty",
  generate: (rng) => ({
    geometry: makeShantyGeometry(rng),
    material: [WALL_MAT, ROOF_MAT] as unknown as THREE.Material,
  }),
  placement: {
    multiplicity: "one",
    attach_to: ["canyon_wall"],
    align: "perpendicular_to_attach",
    face: "outward_from_attach",
    baseScale: 0.85,
  },
};

export function registerShanty() {
  AssetCatalog.register(shanty);
}
