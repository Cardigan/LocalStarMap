import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const gestures = source.slice(source.indexOf('function resetPointers()'), source.indexOf("canvas.addEventListener('keydown'"));

function setup(view = 'sky') {
  const handlers = new Map(), captures = new Set(), timers = new Map();
  const state = {
    view, fov: 90, yaw: 0, pitch: 0, flight: null,
    orbit: { yaw: 0, pitch: 0, distance: 165, extent: 50 }
  };
  const context = {
    state, pointer: null, pointers: new Map(), dirty: false, lastCanvasClick: null, canvasClickTimer: null,
    width: 390, height: 600, performance: { now: () => 0 },
    clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
    $: () => ({ style: {} }), updateZoomLabel() {},
    hitTest: () => ({ id: 'alpha' }), selectStar() { throw new Error('Gesture selected a star'); },
    beginFlight() { throw new Error('Gesture started a flight'); },
    setTimeout(callback) { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    canvas: {
      style: {}, classList: { add() {}, remove() {} },
      addEventListener: (name, handler) => handlers.set(name, handler),
      setPointerCapture: id => captures.add(id),
      hasPointerCapture: id => captures.has(id),
      releasePointerCapture: id => captures.delete(id),
      getBoundingClientRect: () => ({ left: 0, top: 0 })
    }
  };
  runInNewContext(gestures, context);
  function send(type, id, x = 100, y = 100) {
    handlers.get(type)({ pointerId: id, pointerType: 'touch', clientX: x, clientY: y });
  }
  function pinch(from, to) {
    send('pointerdown', 1, 100);
    send('pointerdown', 2, 100 + from);
    send('pointermove', 2, 100 + to);
    send('pointerup', 1, 100);
    send('pointerup', 2, 100 + to);
  }
  return { state, context, captures, timers, send, pinch };
}

test('pinch zooms the sky without rotating or selecting stars', () => {
  const { state, timers, pinch } = setup();
  pinch(100, 200);
  assert.equal(state.fov, 45);
  assert.equal(state.yaw, 0);
  assert.equal(state.pitch, 0);
  assert.equal(timers.size, 0);
  pinch(200, 100);
  assert.equal(state.fov, 90);
  pinch(100, 1000);
  assert.equal(state.fov, 25);
  pinch(1000, 10);
  assert.equal(state.fov, 120);
});

test('pinch changes external camera distance within its existing bounds', () => {
  const { state, pinch } = setup('external');
  pinch(100, 200);
  assert.equal(state.orbit.distance, 82.5);
  pinch(200, 100);
  assert.equal(state.orbit.distance, 165);
  pinch(10, 1000);
  assert.equal(state.orbit.distance, 7.5);
  pinch(1000, 1);
  assert.equal(state.orbit.distance, 600);
  assert.equal(state.orbit.yaw, 0);
  assert.equal(state.orbit.pitch, 0);
});

test('one-finger rotation resumes without a jump after either pinch finger lifts', () => {
  for (const lifted of [1, 2]) {
    const { state, send, timers } = setup();
    send('pointerdown', 1, 100);
    send('pointerdown', 2, 200);
    send('pointermove', 1, 50);
    send('pointermove', 2, 250);
    send('pointerup', lifted, lifted === 1 ? 50 : 250);
    const remaining = lifted === 1 ? 2 : 1;
    const x = remaining === 1 ? 50 : 250;
    send('pointermove', remaining, x + 10);
    assert.ok(Math.abs(state.yaw - 10 * .0035 * state.fov / 90) < 1e-12);
    send('pointerup', remaining, x + 10);
    assert.equal(timers.size, 0);
  }
});

test('canceled and lost captures clean up without selecting a star', () => {
  for (const ending of ['pointercancel', 'lostpointercapture']) {
    const { send, captures, context, timers } = setup();
    send('pointerdown', 1, 100);
    send('pointerdown', 2, 200);
    send(ending, 1);
    send(ending, 2);
    assert.equal(captures.size, 0);
    assert.equal(context.pointers.size, 0);
    assert.equal(context.pointer, null);
    assert.equal(timers.size, 0);
    send('pointerdown', 3);
    send('pointermove', 3, 120);
    assert.ok(context.state.yaw > 0);
  }
});

test('pinching cancels pending star selection and ignores coincident contacts', () => {
  const { send, state, context, timers } = setup();
  send('pointerdown', 1);
  send('pointerup', 1);
  assert.equal(timers.size, 1);
  send('pointerdown', 1);
  send('pointerdown', 2);
  assert.equal(timers.size, 0);
  assert.equal(context.lastCanvasClick, null);
  send('pointermove', 2, 200);
  assert.equal(state.fov, 90);
  send('pointermove', 2, 300);
  assert.equal(state.fov, 45);
});

test('resetting a gesture releases every captured pointer', () => {
  const { send, context, captures } = setup();
  send('pointerdown', 1);
  send('pointerdown', 2, 200);
  context.resetPointers();
  assert.equal(context.pointer, null);
  assert.equal(context.pointers.size, 0);
  assert.equal(captures.size, 0);
});
