// Redemption 4.1 reads viewport clientX/Y as canvas coordinates. Emscripten
// already computes canvas-relative targetX/Y; use those for the native client.
// These slots are the pinned release's EmscriptenMouseEvent ABI (32-bit ints).
export function canvasMouseAdapter(fillEvent, canvas, getHeap) {
  return (eventStruct, event, target) => {
    fillEvent(eventStruct, event, target);
    if (target !== canvas) return;
    const heap = getHeap();
    const index = eventStruct >> 2;
    heap[index + 4] = heap[index + 10];
    heap[index + 5] = heap[index + 11];
  };
}
