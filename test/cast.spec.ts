import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardCastSocket, handleCast } from "../src/cast";

afterEach(() => vi.useRealTimers());

function transport(blockWrites = false) {
  let incoming!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let finish!: () => void;
  let rejectWrite!: (error: Error) => void;
  const writes: number[][] = [];
  const socket = {
    readable: new ReadableStream<Uint8Array>({ start(controller) { incoming = controller; } }),
    writable: new WritableStream<Uint8Array>({ write(bytes) {
      writes.push([...bytes]);
      if (blockWrites) return new Promise<void>((_, reject) => { rejectWrite = reject; });
    } }),
    opened: Promise.resolve({ remoteAddress: null, localAddress: null }),
    closed: new Promise<void>(resolve => { finish = resolve; }),
    close: vi.fn(async () => {
      if (closed) return;
      closed = true;
      rejectWrite?.(new Error("closed"));
      incoming.close();
      finish();
    }),
    startTls() { throw new Error("unused"); },
  } as Socket;
  return { socket, writes, incoming: () => incoming };
}

function request(path = "/api/cast/game", headers: Record<string, string> = {}, method = "GET") {
  return new Request(`https://example.com${path}`, { method, headers: {
    Upgrade: "websocket", Origin: "https://example.com", "Sec-WebSocket-Protocol": "binary", ...headers,
  } });
}
const limiter = (success = true) => ({ CAST_CONNECTION_LIMITER: { limit: vi.fn(async () => ({ success })) } });

describe("cast API", () => {
  it("returns only public connection settings", async () => {
    const dial = vi.fn();
    const response = await handleCast(request("/api/cast/config"), limiter(), dial);
    expect(await response.json()).toEqual({ targetHost: "95.179.145.195", loginPort: 7171, gamePort: 7172, protocol: 772, bridgeBase: "/api/cast" });
    expect(dial).not.toHaveBeenCalled();
  });

  it.each([
    ["/api/cast/other", {}, "GET", 404],
    ["/api/cast/game?host=elsewhere", {}, "GET", 400],
    ["/api/cast/game", { Origin: "https://elsewhere.example" }, "GET", 403],
    ["/api/cast/game", { Origin: "" }, "GET", 403],
    ["/api/cast/game", { Upgrade: "" }, "GET", 426],
    ["/api/cast/game", { "Sec-WebSocket-Protocol": "text" }, "GET", 400],
    ["/api/cast/game", {}, "POST", 405],
  ])("rejects invalid bridge requests before opening TCP: %s %j %s", async (path, headers, method, status) => {
    const dial = vi.fn();
    expect((await handleCast(request(path, headers, method), limiter(), dial)).status).toBe(status);
    expect(dial).not.toHaveBeenCalled();
  });

  it("rate limits connection attempts before dialing", async () => {
    const dial = vi.fn();
    const env = limiter(false);
    const response = await handleCast(request(undefined, { "CF-Connecting-IP": "192.0.2.1" }), env, dial);
    expect(response.status).toBe(429);
    expect(env.CAST_CONNECTION_LIMITER.limit).toHaveBeenCalledWith({ key: "192.0.2.1" });
    expect(dial).not.toHaveBeenCalled();
  });

  it.each([["login", 7171], ["game", 7172]])("connects %s only to the fixed destination", async (channel, port) => {
    const { socket } = transport();
    const dial = vi.fn(() => socket);
    const response = await handleCast(request(`/api/cast/${channel}`), limiter(), dial);
    expect(response.status).toBe(101);
    expect(response.headers.get("Sec-WebSocket-Protocol")).toBe("binary");
    expect(dial).toHaveBeenCalledWith({ hostname: "95.179.145.195", port });
    response.webSocket!.accept();
    response.webSocket!.close();
    await vi.waitFor(() => expect(socket.close).toHaveBeenCalled());
  });

  it("closes a TCP connection whose handshake fails", async () => {
    const { socket } = transport();
    Object.defineProperty(socket, "opened", { value: Promise.reject(new Error("unreachable")) });
    const response = await handleCast(request(), limiter(), () => socket);
    expect(response.status).toBe(502);
    expect(socket.close).toHaveBeenCalled();
  });

  it("times out and closes a TCP connection that never opens", async () => {
    vi.useFakeTimers();
    const { socket } = transport();
    Object.defineProperty(socket, "opened", { value: new Promise(() => {}) });
    const response = handleCast(request(), limiter(), () => socket);
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await response).status).toBe(502);
    expect(socket.close).toHaveBeenCalledOnce();
  });
});

describe("cast forwarding", () => {
  it.each([["login", 45_001], ["game", 150_001]])("cleans up %s sessions at their timeout", async (channel, duration) => {
    vi.useFakeTimers();
    const upstream = transport();
    const pair = new WebSocketPair();
    pair[0].accept();
    const bridge = forwardCastSocket(pair[1], upstream.socket, channel);
    await vi.advanceTimersByTimeAsync(duration);
    await bridge.done;
    await bridge.pump;
    expect(upstream.socket.close).toHaveBeenCalledOnce();
    pair[0].close();
  });
  it("preserves binary bytes in both directions and cleans up on viewer close", async () => {
    const upstream = transport();
    const pair = new WebSocketPair();
    pair[0].accept();
    pair[0].binaryType = "arraybuffer";
    const received: number[] = [];
    pair[0].addEventListener("message", e => { received.push(...new Uint8Array(e.data as ArrayBuffer)); });
    const bridge = forwardCastSocket(pair[1], upstream.socket, "game");
    pair[0].send(new Uint8Array([0, 255, 128]));
    pair[0].send(new Uint8Array([7, 72]));
    upstream.incoming().enqueue(new Uint8Array([255]));
    upstream.incoming().enqueue(new Uint8Array([0, 7, 72]));
    await vi.waitFor(() => {
      expect(upstream.writes).toEqual([[0, 255, 128], [7, 72]]);
      expect(received).toEqual([255, 0, 7, 72]);
    });
    pair[0].close();
    await bridge.done;
    await bridge.pump;
    expect(upstream.socket.close).toHaveBeenCalledOnce();
  });

  it.each(["text", new Uint8Array(65_537)])("rejects invalid messages without writing to TCP", async payload => {
    const upstream = transport();
    const pair = new WebSocketPair();
    pair[0].accept();
    const bridge = forwardCastSocket(pair[1], upstream.socket, "game");
    pair[0].send(payload);
    await bridge.done;
    await bridge.pump;
    expect(upstream.writes).toEqual([]);
    expect(upstream.socket.close).toHaveBeenCalledOnce();
  });

  it("bounds queued data when TCP stops accepting writes", async () => {
    const upstream = transport(true);
    const pair = new WebSocketPair();
    pair[0].accept();
    const bridge = forwardCastSocket(pair[1], upstream.socket, "game");
    for (let i = 0; i < 5; i++) pair[0].send(new Uint8Array(65_536));
    await bridge.done;
    await bridge.pump;
    expect(upstream.socket.close).toHaveBeenCalledOnce();
  });

  it("closes the viewer when the game stream fails", async () => {
    const upstream = transport();
    upstream.socket.close = vi.fn(async () => {});
    const pair = new WebSocketPair();
    pair[0].accept();
    const bridge = forwardCastSocket(pair[1], upstream.socket, "game");
    upstream.incoming().error(new Error("TCP read failed"));
    await bridge.done;
    await bridge.pump;
    expect(upstream.socket.close).toHaveBeenCalledOnce();
    pair[0].close();
  });
});
