import * as THREE from "three";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { AssetCatalog, type AssetSpec } from "./catalog";

function makeCactusGeometry(rng: () => number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const trunkH = 1.2 + rng() * 0.6;
  const trunkR = 0.10 + rng() * 0.05;
  const trunk = new THREE.CylinderGeometry(trunkR * 0.8, trunkR, trunkH, 8, 1);
  trunk.translate(0, trunkH * 0.5, 0);
  parts.push(trunk);

  const branchCount = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < branchCount; i++) {
    const yBase = trunkH * (0.35 + rng() * 0.3);
    const angle = rng() * Math.PI * 2;
    const armR = trunkR * 0.7;
    const armLen = 0.3 + rng() * 0.3;
    const horiz = new THREE.CylinderGeometry(armR, armR, armLen, 6, 1);
    horiz.rotateZ(Math.PI / 2);
    horiz.translate(armLen * 0.5, 0, 0);
    const up = new THREE.CylinderGeometry(armR * 0.85, armR, 0.4 + rng() * 0.2, 6, 1);
    up.translate(0, 0.2, 0);
    const arm = BufferGeometryUtils.mergeGeometries([horiz, up])!;
    arm.translate(0, yBase, 0);
    arm.rotateY(angle);
    parts.push(arm);
  }
  return BufferGeometryUtils.mergeGeometries(parts)!;
}

const SHARED_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x4a7a3a, roughness: 0.85, metalness: 0.0 });

const cactus: AssetSpec = {
  id: "cactus",
  generate: (rng) => ({ geometry: makeCactusGeometry(rng), material: SHARED_MATERIAL }),
  placement: {
    multiplicity: "fill",
    on_terrain: ["desert"],
    align: "free",
    fillSpacing: 1.6,
  },
};

export function registerCactus() {
  AssetCatalog.register(cactus);
}
