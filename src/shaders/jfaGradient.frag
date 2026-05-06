precision highp float;
uniform sampler2D uDist;       // RGBA: per-terrain distance
uniform vec2 uTexel;
varying vec2 vUv;

float minDist(vec4 d) { return min(min(d.r, d.g), min(d.b, d.a)); }

void main() {
  float d00 = minDist(texture2D(uDist, vUv + uTexel * vec2(-1.0, -1.0)));
  float d10 = minDist(texture2D(uDist, vUv + uTexel * vec2( 0.0, -1.0)));
  float d20 = minDist(texture2D(uDist, vUv + uTexel * vec2( 1.0, -1.0)));
  float d01 = minDist(texture2D(uDist, vUv + uTexel * vec2(-1.0,  0.0)));
  float d21 = minDist(texture2D(uDist, vUv + uTexel * vec2( 1.0,  0.0)));
  float d02 = minDist(texture2D(uDist, vUv + uTexel * vec2(-1.0,  1.0)));
  float d12 = minDist(texture2D(uDist, vUv + uTexel * vec2( 0.0,  1.0)));
  float d22 = minDist(texture2D(uDist, vUv + uTexel * vec2( 1.0,  1.0)));

  float gx = (d20 + 2.0 * d21 + d22) - (d00 + 2.0 * d01 + d02);
  float gy = (d02 + 2.0 * d12 + d22) - (d00 + 2.0 * d10 + d20);

  vec2 g = vec2(gx, gy);
  float L = length(g);
  vec2 nrm = L > 1e-3 ? g / L : vec2(0.0);
  // Pack unit vector into [0,1]
  gl_FragColor = vec4(nrm * 0.5 + 0.5, 0.0, 1.0);
}
