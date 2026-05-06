precision highp float;
uniform sampler2D uDist;       // RGBA: per-terrain distance
uniform vec2 uTexel;
varying vec2 vUv;

// 3x3 Sobel on the per-pixel softmin distance: gradient direction = boundary normal
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

  // pack into 0..1 (offset 0.5)
  gl_FragColor = vec4(gx * 0.125 + 0.5, gy * 0.125 + 0.5, 0.0, 1.0);
}
