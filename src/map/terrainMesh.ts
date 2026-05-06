import * as THREE from "three";
import type { Heightmap } from "./heightmap";
import { makeSplatMaterial, type SplatInputs } from "../render/splatShader";

export function buildTerrainMesh(heightmap: Heightmap, splat: SplatInputs): THREE.Mesh {
  const { width, height, tileSize, data } = heightmap;
  const geom = new THREE.PlaneGeometry(
    (width - 1) * tileSize,
    (height - 1) * tileSize,
    width - 1,
    height - 1,
  );
  // PlaneGeometry default lies in XY plane; we rotate to XZ.
  geom.rotateX(-Math.PI / 2);

  const pos = geom.attributes.position as THREE.BufferAttribute;
  // PlaneGeometry vertex order is row-major: y from -h/2..+h/2 step 1, x from -w/2..+w/2.
  // After rotateX, "y" of plane became "z" in world. We must sample heightmap with the same
  // (i, j) order the geometry was built in.
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const vertIndex = j * width + i;
      const h = data[j * width + i];
      pos.setY(vertIndex, h);
    }
  }
  pos.needsUpdate = true;
  geom.computeVertexNormals();

  const material = makeSplatMaterial(splat);
  const mesh = new THREE.Mesh(geom, material);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  return mesh;
}
