export const DEG = Math.PI / 180;
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const add = (a, b) => a.map((value, i) => value + b[i]);
export const subtract = (a, b) => a.map((value, i) => value - b[i]);
export const scale = (a, value) => a.map(component => component * value);
export const length = a => Math.hypot(...a);
export const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
export const lerp = (a, b, t) => a.map((value, i) => value + (b[i] - value) * t);
export const smooth = t => t * t * (3 - 2 * t);
export const angleDelta = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

export function positionFromEquatorial(ra, dec, distance) {
  return [
    distance * Math.cos(dec * DEG) * Math.cos(ra * DEG),
    distance * Math.sin(dec * DEG),
    distance * Math.cos(dec * DEG) * Math.sin(ra * DEG)
  ];
}

export function toGalactic([x, y, z]) {
  // ICRS-to-Galactic matrix: doi:10.1093/mnras/stu1796, eq. 5; this app uses Y as up.
  return [
    -.054875560416 * x - .873437090235 * z - .483835015549 * y,
    -.867666149019 * x - .198076373431 * z + .455983776175 * y,
    .494109427876 * x - .444829629960 * z + .746982244497 * y
  ];
}

export function orbitCamera(target, yaw, elevation, distance) {
  const offset = positionFromEquatorial(yaw / DEG, elevation / DEG, distance);
  const position = add(target, offset);
  const facing = anglesFor(subtract(target, position));
  return { position, basis: cameraBasis(facing.yaw, facing.pitch) };
}

export function anglesFor(vector) {
  const distance = length(vector);
  return { yaw: Math.atan2(vector[2], vector[0]), pitch: Math.asin(clamp(vector[1] / (distance || 1), -1, 1)) };
}

export function cameraBasis(yaw, pitch) {
  return {
    forward: [Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw)],
    right: [Math.sin(yaw), 0, -Math.cos(yaw)],
    up: [-Math.sin(pitch) * Math.cos(yaw), Math.cos(pitch), -Math.sin(pitch) * Math.sin(yaw)]
  };
}

export function project(position, observer, basis, width, height, fov) {
  const relative = subtract(position, observer);
  const depth = dot(relative, basis.forward);
  if (depth <= 0.00001) return null;
  const focal = Math.min(width, height) / (2 * Math.tan(fov * DEG / 2));
  return {
    x: width / 2 + dot(relative, basis.right) * focal / depth,
    y: height / 2 - dot(relative, basis.up) * focal / depth,
    distance: length(relative), depth
  };
}

export function apparentMagnitude(absoluteMagnitude, distanceLy) {
  return absoluteMagnitude + 5 * Math.log10(Math.max(distanceLy, 0.001) / 3.26156) - 5;
}

export function directionMarker(position, observer, basis, width, height, fov, bounds) {
  const relative = subtract(position, observer);
  if (length(relative) < .025) return null;
  const p = project(position, observer, basis, width, height, fov);
  const visible = Boolean(p && p.x >= bounds.left && p.x <= bounds.right && p.y >= bounds.top && p.y <= bounds.bottom);
  const horizontal = dot(relative, basis.right);
  const vertical = -dot(relative, basis.up);
  const behind = dot(relative, basis.forward) <= 0;
  let dx = horizontal, dy = vertical;
  if (Math.hypot(dx, dy) < length(relative) * 1e-10) { dx = 1; dy = 0; }
  const cx = (bounds.left + bounds.right) / 2, cy = (bounds.top + bounds.bottom) / 2;
  const extentX = (bounds.right - bounds.left) / 2, extentY = (bounds.bottom - bounds.top) / 2;
  const factor = Math.min(extentX / (Math.abs(dx) || 1e-20), extentY / (Math.abs(dy) || 1e-20));
  return {
    x: visible ? p.x : cx + dx * factor, y: visible ? p.y : cy + dy * factor,
    edgeX: cx + dx * factor, edgeY: cy + dy * factor,
    visible, behind, angle: Math.atan2(dy, dx)
  };
}

export function arrivalPulse(elapsed, travelDuration) {
  const t = (elapsed - travelDuration + 650) / 1100;
  if (t < 0 || t >= 1) return null;
  return {
    radius: 17 + 95 * smooth(t),
    opacity: .9 * Math.min(clamp(t / .18, 0, 1), clamp((1 - t) / .35, 0, 1)),
    arrived: elapsed >= travelDuration
  };
}

export function flightFrame(from, to, startAngles, elapsed, travelDuration, turnDuration) {
  const progress = clamp(elapsed / travelDuration, 0, 1);
  const outbound = anglesFor(subtract(to, from));
  const homeward = anglesFor(subtract(from, to));
  const turn = smooth(clamp((elapsed - travelDuration) / turnDuration, 0, 1));
  const align = smooth(clamp(elapsed / Math.min(1200, travelDuration * 0.3), 0, 1));
  const outboundYaw = startAngles.yaw + angleDelta(startAngles.yaw, outbound.yaw) * align;
  const outboundPitch = startAngles.pitch + (outbound.pitch - startAngles.pitch) * align;
  return {
    position: lerp(from, to, smooth(progress)), progress,
    yaw: outboundYaw + angleDelta(outboundYaw, homeward.yaw) * turn,
    pitch: outboundPitch + (homeward.pitch - outboundPitch) * turn,
    turning: elapsed >= travelDuration,
    done: elapsed >= travelDuration + turnDuration
  };
}
