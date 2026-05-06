precision highp float;
uniform sampler2D uPrev;
uniform vec2 uTexel;
uniform float uStride;
varying vec2 vUv;

void main() {
  vec4 best = texture2D(uPrev, vUv);
  float bestD = 1e30;
  if (best.a > 0.5) {
    vec2 d = best.rg - vUv;
    bestD = dot(d, d);
  }
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 sUv = vUv + vec2(float(i), float(j)) * uTexel * uStride;
      vec4 s = texture2D(uPrev, sUv);
      if (s.a > 0.5) {
        vec2 d = s.rg - vUv;
        float dd = dot(d, d);
        if (dd < bestD) {
          bestD = dd;
          best = s;
        }
      }
    }
  }
  gl_FragColor = best;
}
