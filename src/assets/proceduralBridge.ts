import * as THREE from "three";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { AssetCatalog, type AssetSpec } from "./catalog";

const PLANK_MAT = new THREE.MeshStandardMaterial({ color: 0x6a4a2a, roughness: 0.95 });
const RAIL_MAT = new THREE.MeshStandardMaterial({ color: 0x4a3018, roughness: 0.95 });

function makeBridgeGeometry(_rng: () => number): THREE.BufferGeometry {
  // Bridge is built unit-length along +X; placeAssets stretches via scale.
  const planks: THREE.BufferGeometry[] = [];
  const len = 1.0, width = 0.4;
  const deck = new THREE.BoxGeometry(len, 0.05, width);
  deck.translate(0, 0.18, 0);
  planks.push(deck);
  for (const z of [width * 0.5, -width * 0.5]) {
    const rail = new THREE.BoxGeometry(len, 0.04, 0.04);
    rail.translate(0, 0.32, z);
    planks.push(rail);
    for (const x of [-0.4, -0.1, 0.2, 0.45]) {
      const post = new THREE.BoxGeometry(0.04, 0.18, 0.04);
      post.translate(x, 0.27, z);
      planks.push(post);
    }
  }
  // Use group 0 for deck/posts, group 1 for the two rails — actually merge as single group for simplicity
  const deckMerged = deck;
  const railsMerged = BufferGeometryUtils.mergeGeometries(planks.slice(1))!;
  return BufferGeometryUtils.mergeGeometries([deckMerged, railsMerged], true)!;
}

const bridge: AssetSpec = {
  id: "bridge",
  generate: (rng) => ({
    geometry: makeBridgeGeometry(rng),
    material: [PLANK_MAT, RAIL_MAT] as unknown as THREE.Material,
  }),
  placement: {
    multiplicity: "one",
    align: "principal",
    baseScale: 0.95,
  },
};

export function registerBridge() {
  AssetCatalog.register(bridge);
}
