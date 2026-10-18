import { connect } from "cloudflare:sockets";
import config from "./cast-config.json";

type CastEnv = { CAST_CONNECTION_LIMITER: RateLimit };
type Transport = Pick<Socket, "readable" | "writable" | "closed" | "close">;

// No database, game decoding or credentials here: only fixed-target binary I/O.
export function forwardCastSocket(websocket: WebSocket, socket: Transport, channel: string) {
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const started = Date.now();
  let lastActivity = started;
  let stopped = false;
  let queuedBytes = 0;
  let queuedMessages = 0;
  let fromGame = 0;
  let toGame = 0;
  let writes = Promise.resolve();
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  const idle = setInterval(() => {
    if (Date.now() - lastActivity > 120_000) stop(1000, "Connection idle");
  }, 30_000);
  const lifetime = setTimeout(() => stop(1000, "Session ended; reload to reconnect"),
    channel === "login" ? 45_000 : 60 * 60_000);

  function stop(code: number, reason: string) {
    if (stopped) return;
    stopped = true;
    clearInterval(idle);
    clearTimeout(lifetime);
    try { websocket.close(code, reason); } catch { /* already disconnected */ }
    void socket.close().catch(() => {});
    // One aggregate log per session, never packet contents or credentials.
    console.log(JSON.stringify({ event: "cast_bridge_closed", channel, fromGame, toGame,
      durationMs: Date.now() - started, reason }));
    resolveDone();
  }

  websocket.binaryType = "arraybuffer";
  websocket.accept();
  websocket.addEventListener("close", () => stop(1000, "Viewer disconnected"));
  websocket.addEventListener("error", () => stop(1011, "WebSocket error"));
  websocket.addEventListener("message", event => {
    if (stopped) return;
    if (!(event.data instanceof ArrayBuffer)) return stop(1003, "Binary messages required");
    const bytes = new Uint8Array(event.data);
    if (bytes.byteLength === 0 || bytes.byteLength > 65_536) return stop(1009, "Invalid packet size");
    if (queuedBytes + bytes.byteLength > 262_144 || queuedMessages >= 128) {
      return stop(1008, "Too much pending data");
    }
    queuedBytes += bytes.byteLength;
    queuedMessages++;
    lastActivity = Date.now();
    // Serialize asynchronous TCP writes so message order cannot change.
    writes = writes.then(async () => {
      if (!stopped) {
        await writer.write(bytes);
        toGame += bytes.byteLength;
      }
    }).catch(() => stop(1011, "Game connection failed")).finally(() => {
      queuedBytes -= bytes.byteLength;
      queuedMessages--;
    });
  });

  const pump = (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        if (stopped) break;
        websocket.send(value);
        fromGame += value.byteLength;
        lastActivity = Date.now();
      }
      stop(1000, "Game connection closed");
    } catch { stop(1011, "Game connection failed"); }
    finally { reader.releaseLock(); }
  })();
  void socket.closed.catch(() => stop(1011, "Game connection failed"));
  // Waiting on the socket, not waitUntil(), keeps the WebSocket session alive.
  return { done, pump };
}

export async function handleCast(request: Request, env: CastEnv, dial = connect): Promise<Response> {
  const url = new URL(request.url);
  const headers = { "Cache-Control": "no-store" };
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET" } });
  if (url.pathname === "/api/cast/config") return Response.json(config, { headers });
  const channel = url.pathname === "/api/cast/login" ? "login" : url.pathname === "/api/cast/game" ? "game" : null;
  if (!channel) return new Response("Not found", { status: 404, headers });
  if (url.search) return new Response("Query parameters are not supported", { status: 400, headers });
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket upgrade required", { status: 426, headers: { ...headers, Upgrade: "websocket" } });
  }
  if (request.headers.get("Origin") !== url.origin) return new Response("Origin not allowed", { status: 403, headers });
  if (request.headers.get("Sec-WebSocket-Protocol") !== "binary") {
    return new Response("Binary subprotocol required", { status: 400, headers });
  }
  const { success } = await env.CAST_CONNECTION_LIMITER.limit({ key: request.headers.get("CF-Connecting-IP") ?? "local" });
  if (!success) return new Response("Too many connections; try again shortly", { status: 429, headers: { ...headers, "Retry-After": "60" } });

  let socket: Socket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    socket = dial({ hostname: config.targetHost, port: channel === "login" ? config.loginPort : config.gamePort });
    void socket.closed.catch(() => {});
    await Promise.race([
      socket.opened,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Connection timeout")), 10_000); }),
    ]);
    const pair = new WebSocketPair();
    forwardCastSocket(pair[1], socket, channel);
    return new Response(null, { status: 101, webSocket: pair[0], headers: { "Sec-WebSocket-Protocol": "binary" } });
  } catch {
    if (socket) void socket.close().catch(() => {});
    return new Response("Cast server unavailable", { status: 502, headers });
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
