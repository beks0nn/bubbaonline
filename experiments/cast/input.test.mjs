import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { canvasMouseAdapter } from '../../public/cast-input.mjs';

// Exercise the real event encoder from our pinned engine, so an ABI change
// fails this check instead of silently making the pointer inaccurate again.
const engine = readFileSync(new URL('../../.cache/cast-browser/release-4.1/build-emscripten-web/otclient.js', import.meta.url), 'utf8');
const encoder = engine.match(/var fillMouseEventData=(.*?);var registerMouseEventCallback=/)?.[1];
assert.ok(encoder, 'Pinned engine mouse encoder must be available');
function fixture() {
  const memory = new ArrayBuffer(256);
  const context = vm.createContext({
    HEAP32: new Int32Array(memory), HEAP16: new Int16Array(memory),
    HEAP8: new Int8Array(memory), HEAPF64: new Float64Array(memory),
    getBoundingClientRect: target => target.rect,
  });
  const canvas = { rect: { left: 0, top: 64 } };
  const fill = canvasMouseAdapter(vm.runInContext(`(${encoder})`, context), canvas, () => context.HEAP32);
  const event = { timeStamp: 1, screenX: 210, screenY: 374, clientX: 200, clientY: 364,
    ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, button: 0, buttons: 1, movementX: 5, movementY: 6 };
  return { fill, canvas, context, event };
}
test('canvas mouse coordinates exclude the header and follow layout changes', () => {
  const { fill, canvas, context, event } = fixture();
  fill(0, event, canvas);
  assert.equal(context.HEAP32[4], 200);
  assert.equal(context.HEAP32[5], 300);
  assert.equal(context.HEAP16[15], 1, 'pressed buttons preserved');
  assert.equal(context.HEAP8[24], 1, 'modifiers preserved');
  canvas.rect = { left: 20, top: 80 };
  fill(0, event, canvas);
  assert.equal(context.HEAP32[4], 180);
  assert.equal(context.HEAP32[5], 284);
});
test('events for other page elements retain their viewport coordinates', () => {
  const { fill, context, event } = fixture();
  fill(0, event, { rect: { left: 20, top: 80 } });
  assert.equal(context.HEAP32[4], 200);
  assert.equal(context.HEAP32[5], 364);
});
