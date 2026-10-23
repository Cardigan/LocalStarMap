import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readCatalog } from '../scripts/catalog.mjs';
import { DEG, dot, length, subtract, positionFromEquatorial, toGalactic, orbitCamera, anglesFor, cameraBasis, project, apparentMagnitude, directionMarker, arrivalPulse, flightFrame } from '../src/space.js';

const near = (actual, expected, epsilon = 1e-8) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
const catalog = await readCatalog();
const alpha = catalog.find(star => star.catalogName === 'Alpha Centauri');
const alphaPosition = positionFromEquatorial(alpha.ra, alpha.dec, alpha.distance);

test('all supplied coordinate rows are preserved, including names, signs and distances', () => {
  assert.equal(catalog.length, 133);
  assert.equal(new Set(catalog.map(star => star.id)).size, 133);
  assert.equal(alpha.name, 'Rigil Kentaurus');
  near(alpha.ra, (14 + 39.6 / 60) * 15);
  near(alpha.dec, -(60 + 50 / 60));
  near(alpha.distance, 4.39);
  assert.equal(catalog.find(star => star.catalogName === 'Alpha Canis Majoris').name, 'Sirius');
  assert.equal(catalog.find(star => star.name === 'Capella').distance, 42.20);
  assert.ok(catalog.every(star => star.distance <= 50));
  for (const star of catalog) near(length(positionFromEquatorial(star.ra, star.dec, star.distance)), star.distance);
});

test('equatorial axes map to distinct Cartesian directions', () => {
  assert.deepEqual(positionFromEquatorial(0, 0, 10), [10, 0, 0]);
  const east = positionFromEquatorial(90, 0, 10);
  near(east[0], 0); near(east[2], 10);
  const north = positionFromEquatorial(0, 90, 10);
  near(north[0], 0); near(north[1], 10);
});

test('Galactic map frame agrees with known pole and center directions and preserves real distances', () => {
  const pole = toGalactic(positionFromEquatorial(192.85948, 27.12825, 1));
  near(pole[0], 0, 1e-6); near(pole[1], 1, 1e-6); near(pole[2], 0, 1e-6);
  const center = toGalactic(positionFromEquatorial(266.40499, -28.93617, 1));
  near(center[0], 1, 1e-6); near(center[1], 0, 1e-6); near(center[2], 0, 1e-6);
  for (const star of catalog) {
    near(length(toGalactic(positionFromEquatorial(star.ra, star.dec, star.distance))), star.distance, 1e-8);
  }
  const sirius = catalog.find(star => star.name === 'Sirius');
  const galactic = anglesFor(toGalactic(positionFromEquatorial(sirius.ra, sirius.dec, sirius.distance)));
  near((galactic.yaw / DEG + 360) % 360, 227.2, .1);
  near(galactic.pitch / DEG, -8.9, .1);
});

test('external camera orbits its target without changing the stellar observer or target', () => {
  const target = [...alphaPosition];
  const original = [...target];
  for (const yaw of [0, 1.3, 4.5]) {
    for (const elevation of [-1.5, .26, 1.5]) {
      const camera = orbitCamera(target, yaw, elevation, 165);
      near(length(subtract(camera.position, target)), 165);
      const p = project(target, camera.position, camera.basis, 1000, 700, 42);
      near(p.x, 500); near(p.y, 350);
      assert.deepEqual(target, original);
    }
  }
});

test('external rotation exposes real depth and moving closer magnifies the neighborhood', () => {
  const origin = [0, 0, 0], star = [10, 8, -12];
  const first = orbitCamera(origin, .75, .26, 165);
  const rotated = orbitCamera(origin, 2.1, .6, 165);
  const closer = orbitCamera(origin, .75, .26, 90);
  const draw = camera => project(star, camera.position, camera.basis, 1000, 700, 42);
  const a = draw(first), b = draw(rotated), c = draw(closer);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 20);
  assert.ok(Math.hypot(c.x - 500, c.y - 350) > Math.hypot(a.x - 500, a.y - 350));
});

test('camera basis remains orthonormal near poles and points at its requested star', () => {
  for (const pitch of [-89.99, -60, 0, 60, 89.99]) {
    const basis = cameraBasis(245 * DEG, pitch * DEG);
    near(length(basis.forward), 1); near(length(basis.up), 1); near(length(basis.right), 1);
    near(dot(basis.forward, basis.up), 0); near(dot(basis.forward, basis.right), 0);
    const point = project(basis.forward, [0, 0, 0], basis, 1000, 700, 90);
    near(point.x, 500); near(point.y, 350);
  }
});

test('nearby stars show actual parallax from Alpha Centauri, not a fixed sky shell', () => {
  const sirius = catalog.find(star => star.name === 'Sirius');
  const position = positionFromEquatorial(sirius.ra, sirius.dec, sirius.distance);
  const earthAngles = anglesFor(position);
  const alphaAngles = anglesFor(subtract(position, alphaPosition));
  assert.ok(Math.abs(earthAngles.yaw - alphaAngles.yaw) > DEG);
  assert.ok(Math.abs(earthAngles.pitch - alphaAngles.pitch) > DEG);
  const basis = cameraBasis(earthAngles.yaw, earthAngles.pitch);
  const fromEarth = project(position, [0, 0, 0], basis, 1000, 700, 90);
  const fromAlpha = project(position, alphaPosition, basis, 1000, 700, 90);
  assert.ok(Math.hypot(fromEarth.x - fromAlpha.x, fromEarth.y - fromAlpha.y) > 10);
  assert.notEqual(fromEarth.distance, fromAlpha.distance);
});

test('flight starts at Earth, reaches Alpha exactly, then ends facing Earth', () => {
  const start = anglesFor(alphaPosition);
  const initial = flightFrame([0, 0, 0], alphaPosition, start, 0, 8000, 2600);
  assert.deepEqual(initial.position, [0, 0, 0]);
  const midpoint = flightFrame([0, 0, 0], alphaPosition, start, 4000, 8000, 2600);
  near(length(midpoint.position), 4.39 / 2);
  const arrived = flightFrame([0, 0, 0], alphaPosition, start, 8000, 8000, 2600);
  assert.deepEqual(arrived.position, alphaPosition);
  assert.ok(arrived.turning);
  assert.ok(!arrived.done);
  const finished = flightFrame([0, 0, 0], alphaPosition, start, 10600, 8000, 2600);
  assert.ok(finished.done);
  const sol = project([0, 0, 0], finished.position, cameraBasis(finished.yaw, finished.pitch), 1000, 700, 90);
  near(sol.x, 500); near(sol.y, 350); near(sol.distance, 4.39);
});

test('return flight ends at Earth facing Alpha, including an arbitrary starting view', () => {
  const frame = flightFrame(alphaPosition, [0, 0, 0], { yaw: 23, pitch: .8 }, 10600, 8000, 2600);
  assert.deepEqual(frame.position, [0, 0, 0]);
  const destination = project(alphaPosition, frame.position, cameraBasis(frame.yaw, frame.pitch), 1000, 700, 90);
  near(destination.x, 500); near(destination.y, 350);
});

test('brightness varies with observer distance and rear-facing stars are culled', () => {
  near(apparentMagnitude(4.83, 10 * 3.26156), 4.83);
  near(apparentMagnitude(4.83, 100 * 3.26156), 9.83);
  const angles = anglesFor(alphaPosition);
  const basis = cameraBasis(angles.yaw + Math.PI, -angles.pitch);
  assert.equal(project(alphaPosition, [0, 0, 0], basis, 1000, 700, 90), null);
});

test('both requested direction sets agree with a north-up, east-left camera', async () => {
  const references = JSON.parse(await readFile(new URL('../reference/direction-stars.json', import.meta.url), 'utf8'));
  const positions = new Map(catalog.map(star => [star.id, positionFromEquatorial(star.ra, star.dec, star.distance)]));
  for (const star of references.stars) {
    positions.set(star.id, positionFromEquatorial(star.ra, star.dec, 3261.56 / star.parallaxMas));
  }
  for (const [observerId, markers] of Object.entries(references.directions)) {
    const observer = positions.get(observerId);
    const forwardId = observerId === 'sol' ? 'alpha-centauri' : 'sol';
    const angles = anglesFor(subtract(positions.get(forwardId), observer));
    const basis = cameraBasis(angles.yaw, angles.pitch);
    assert.equal(markers.length, 6);
    for (const marker of markers) {
      assert.ok(positions.has(marker.starId), marker.starId);
      const vector = subtract(positions.get(marker.starId), observer);
      if (marker.direction === 'Forward') near(dot(vector, basis.forward) / length(vector), 1);
      if (marker.direction === 'Backward') assert.ok(dot(vector, basis.forward) / length(vector) < -.99);
      if (marker.direction === 'Up') assert.ok(dot(vector, basis.up) > 0);
      if (marker.direction === 'Down') assert.ok(dot(vector, basis.up) < 0);
      if (marker.direction === 'Left') assert.ok(dot(vector, basis.right) < 0);
      if (marker.direction === 'Right') assert.ok(dot(vector, basis.right) > 0);
    }
  }
});

test('off-screen arrows follow all edges, including behind-camera stars without perspective reversal', () => {
  const basis = cameraBasis(0, 0), observer = [0, 0, 0];
  const bounds = { left: 80, right: 920, top: 80, bottom: 620 };
  const marker = (position, fov = 90) => directionMarker(position, observer, basis, 1000, 700, fov, bounds);
  assert.equal(marker([10, 0, 0]).visible, true);
  near(marker([10, 0, -100]).x, 920);
  near(marker([10, 0, 100]).x, 80);
  near(marker([10, 100, 0]).y, 80);
  near(marker([10, -100, 0]).y, 620);
  assert.equal(marker([-10, 0, -1]).behind, true);
  near(marker([-10, 0, -1]).x, 920);
  assert.ok(Math.abs(marker([-10, 0, -1]).angle) < 1e-8);
  assert.ok(Number.isFinite(marker([-10, 0, 0]).x));
  assert.equal(marker([10, 0, -6], 25).visible, false);
  assert.equal(marker([10, 0, -6], 120).visible, true);
  assert.equal(marker([0, 0, 0]), null);
});

test('arrival ring expands during the last approach frames and fades shortly after contact', () => {
  assert.equal(arrivalPulse(7349, 8000), null);
  const approach = arrivalPulse(7600, 8000);
  const contact = arrivalPulse(8000, 8000);
  const after = arrivalPulse(8400, 8000);
  assert.equal(approach.arrived, false);
  assert.equal(contact.arrived, true);
  assert.ok(approach.radius > 17);
  assert.ok(contact.radius > approach.radius);
  assert.ok(after.radius > contact.radius);
  assert.ok(after.opacity < contact.opacity);
  assert.equal(arrivalPulse(8450, 8000), null);
});

test('arbitrary-star flights arrive at their actual coordinates and face their departure system', () => {
  const sirius = catalog.find(star => star.name === 'Sirius');
  const tauCeti = catalog.find(star => star.catalogName === 'Tau Ceti');
  const origin = positionFromEquatorial(sirius.ra, sirius.dec, sirius.distance);
  const destination = positionFromEquatorial(tauCeti.ra, tauCeti.dec, tauCeti.distance);
  const frame = flightFrame(origin, destination, { yaw: -8, pitch: -.4 }, 10600, 8000, 2600);
  assert.deepEqual(frame.position, destination);
  const departure = project(origin, frame.position, cameraBasis(frame.yaw, frame.pitch), 1000, 700, 90);
  near(departure.x, 500); near(departure.y, 350);
  near(departure.distance, length(subtract(origin, destination)));
});
