export type Vec2 = [number, number];

export function polygonArea(pts: Vec2[]): number {
  if (pts.length < 3) return 0;
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  }
  return Math.abs(a) * 0.5;
}

// Andrew's monotone-chain convex hull. Returns CCW hull.
export function convexHull(points: Vec2[]): Vec2[] {
  const n = points.length;
  if (n <= 1) return points.slice();
  const pts = points.slice().sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  const cross = (o: Vec2, a: Vec2, b: Vec2) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// PCA on 2D points: returns the principal axis (unit vector along largest variance) and the perpendicular.
export function principalAxes(points: Vec2[]): { axisU: Vec2; axisV: Vec2; center: Vec2 } {
  const n = points.length;
  let cx = 0, cy = 0;
  for (const p of points) { cx += p[0]; cy += p[1]; }
  cx /= n; cy /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of points) {
    const dx = p[0] - cx, dy = p[1] - cy;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  sxx /= n; sxy /= n; syy /= n;
  // 2x2 symmetric eigendecomposition
  const trace = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.max(0, trace * trace * 0.25 - det);
  const lambda1 = trace * 0.5 + Math.sqrt(disc);
  let ex: number, ey: number;
  if (Math.abs(sxy) > 1e-10) {
    ex = lambda1 - syy;
    ey = sxy;
  } else {
    if (sxx >= syy) { ex = 1; ey = 0; }
    else { ex = 0; ey = 1; }
  }
  const len = Math.hypot(ex, ey) || 1;
  ex /= len; ey /= len;
  return {
    axisU: [ex, ey],
    axisV: [-ey, ex],
    center: [cx, cy],
  };
}

// Oriented bounding box around points using their PCA axes.
export function orientedBoundingBox(points: Vec2[]): {
  center: Vec2; axisU: Vec2; axisV: Vec2; halfU: number; halfV: number;
} {
  const { axisU, axisV, center } = principalAxes(points);
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const p of points) {
    const dx = p[0] - center[0], dy = p[1] - center[1];
    const u = dx * axisU[0] + dy * axisU[1];
    const v = dx * axisV[0] + dy * axisV[1];
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  const uMid = (uMin + uMax) * 0.5;
  const vMid = (vMin + vMax) * 0.5;
  const cx = center[0] + axisU[0] * uMid + axisV[0] * vMid;
  const cy = center[1] + axisU[1] * uMid + axisV[1] * vMid;
  return {
    center: [cx, cy],
    axisU,
    axisV,
    halfU: (uMax - uMin) * 0.5,
    halfV: (vMax - vMin) * 0.5,
  };
}
