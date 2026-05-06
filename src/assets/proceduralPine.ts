import * as THREE from "three";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { AssetCatalog, type AssetSpec } from "./catalog";

const TRUNK_MAT = new THREE.MeshStandardMaterial({ color: 0x4d3520, roughness: 0.9 });
const NEEDLE_MAT = new THREE.MeshStandardMaterial({ color: 0x2a4d28, roughness: 0.85 });

function makePineGeometry(rng: () => number): THREE.BufferGeometry {
  const trunkH = 1.2 + rng() * 0.6;
  const trunk = new THREE.CylinderGeometry(0.08, 0.12, trunkH, 6, 1);
  trunk.translate(0, trunkH * 0.5, 0);

  const cones: THREE.BufferGeometry[] = [];
  let y = trunkH * 0.55;
  let r = 0.7 + rng() * 0.2;
  while (y < trunkH + 1.5) {
    const c = new THREE.ConeGeometry(r, 0.7, 8, 1);
    c.translate(0, y + 0.35, 0);
    cones.push(c);
    y += 0.45;
    r *= 0.78;
  }

  // We bake 2 sub-geometries with different colors via groups.
  const trunkMerged = trunk;
  const conesMerged = BufferGeometryUtils.mergeGeometries(cones)!;
  const out = BufferGeometryUtils.mergeGeometries([trunkMerged, conesMerged], true)!;
  return out;
}

const pine: AssetSpec = {
  id: "pine",
  generate: (rng) => ({
    geometry: makePineGeometry(rng),
    // Multi-material: groups use 0 = trunk, 1 = needles
    material: [TRUNK_MAT, NEEDLE_MAT] as unknown as THREE.Material,
  }),
  placement: {
    multiplicity: "fill",
    on_terrain: ["forest", "tundra", "plains"],
    align: "free",
    fillSpacing: 1.4,
  },
};

export function registerPine() {
  AssetCatalog.register(pine);
}
