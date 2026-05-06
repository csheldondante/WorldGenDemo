import * as THREE from "three";
import { AssetCatalog, type AssetSpec } from "./catalog";

const MAT = new THREE.MeshStandardMaterial({ color: 0x807060, roughness: 1.0, flatShading: true });

function makeBoulderGeometry(rng: () => number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.5 + rng() * 0.4, 1);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const k = (rng() - 0.5) * 0.18;
    pos.setX(i, pos.getX(i) * (1 + k));
    pos.setY(i, pos.getY(i) * (1 + k * 0.6));
    pos.setZ(i, pos.getZ(i) * (1 + k));
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

const boulder: AssetSpec = {
  id: "boulder",
  generate: (rng) => ({ geometry: makeBoulderGeometry(rng), material: MAT }),
  placement: { multiplicity: "fill", align: "free", fillSpacing: 1.8 },
};

export function registerBoulder() {
  AssetCatalog.register(boulder);
}
