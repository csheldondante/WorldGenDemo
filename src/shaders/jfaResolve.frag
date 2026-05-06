precision highp float;
// Up to 4 input seed textures (one per top-N terrain).
uniform sampler2D uSeedA;
uniform sampler2D uSeedB;
uniform sampler2D uSeedC;
uniform sampler2D uSeedD;
uniform float uActiveCount; // 1..4
uniform vec2 uMapSize;      // width, height in pixels
varying vec2 vUv;

float seedDist(sampler2D tex, vec2 uv) {
  vec4 s = texture2D(tex, uv);
  if (s.a < 0.5) return 1e6;
  vec2 d = (s.rg - uv) * uMapSize;
  return length(d);
}

void main() {
  float dA = seedDist(uSeedA, vUv);
  float dB = uActiveCount > 1.5 ? seedDist(uSeedB, vUv) : 1e6;
  float dC = uActiveCount > 2.5 ? seedDist(uSeedC, vUv) : 1e6;
  float dD = uActiveCount > 3.5 ? seedDist(uSeedD, vUv) : 1e6;
  gl_FragColor = vec4(dA, dB, dC, dD);
}
