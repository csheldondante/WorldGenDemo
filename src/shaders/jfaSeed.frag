precision highp float;
uniform sampler2D uTerrain;     // R = terrain index packed into 0..1 (i / uTotalTerrains)
uniform float uTargetIndex;
uniform float uTotalTerrains;
varying vec2 vUv;

void main() {
  float t = texture2D(uTerrain, vUv).r * uTotalTerrains;
  // Treat as match if rounded index equals target
  bool match = abs(t - uTargetIndex) < 0.5;
  if (match) {
    gl_FragColor = vec4(vUv, 1.0, 1.0); // RG = seed UV; A flags valid
  } else {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
  }
}
