import { STATUS_CODES, type Server, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { z } from 'zod';
import { ipKeyGenerator } from 'express-rate-limit';
import {
  authorizeIncoming,
  requireBoardOrigin,
  requireBoardRuntime,
  type BoardContext,
  type BoardPrincipal,
} from './http.js';
import { BOARD_LIMITS, BoardMessageGate } from './limits.js';
import type { OpenBoard } from './runtime.js';
import { AppError } from '../errors.js';

const SOCKET_RESOURCE_LIMITS = {
  outgoingBytes: 9 * 1024 * 1024,
  pending: 16,
  upgradeTimeoutMs: 5000,
  ipAttempts: 60,
  ipWindowMs: 60000,
  ipBuckets: 128,
} as const;

const querySchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    storeId: z.string().min(1).max(128).optional(),
  })
  .strict();
const protocolSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }).strict(),
  z
    .object({
      type: z.literal('connect'),
      connectRequestId: z.string().min(1).max(128),
      lastServerClock: z.number().int().min(-1),
      protocolVersion: z.number().int().positive(),
      schema: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      type: z.literal('push'),
      clientClock: z.number().int().nonnegative(),
      diff: z.record(z.string(), z.unknown()).optional(),
      presence: z.tuple([z.string(), z.unknown()]).optional(),
    })
    .strict(),
]);
function rejectUpgrade(socket: Duplex, status: number) {
  if (!socket.destroyed) {
    socket.once('error', () => socket.destroy());
    socket.end(
      `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Rejected'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      () => socket.destroy(),
    );
  }
}

/** Own only board upgrades and sockets; unrelated handlers (e.g. Vite HMR) remain installed. */
export function attachBoardSockets(
  server: Server,
  context: BoardContext,
): { close: () => Promise<void> } {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: BOARD_LIMITS.frameBytes,
    perMessageDeflate: false,
  });
  const pending = new Set<Duplex>();
  // Keep reservations until async work ends, even after disconnect/timeout.
  const inFlight = new Set<Duplex>();
  const attempts = new Map<string, { count: number; until: number }>();
  let closing = false;
  let closePromise: Promise<void> | undefined;

  function connect(
    ws: WebSocket,
    req: IncomingMessage,
    id: string,
    clientId: string,
    principal: BoardPrincipal,
    entry: OpenBoard,
  ) {
    const runtime = requireBoardRuntime(context);
    // A client chooses its tab id, never another principal's native room session.
    const sessionId = `${principal.kind}:${principal.principalId}:${clientId}`;
    const previous = entry.connections.get(sessionId);
    previous?.close();
    let stopped = false;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let forceClose: ReturnType<typeof setTimeout> | undefined;
    let queued = 0;
    let queue = Promise.resolve();
    let tokens: number = BOARD_LIMITS.burst;
    let refillAt = performance.now();
    const gate = new BoardMessageGate();
    const connection = { kind: principal.kind, close: () => stop(1008, 'Access revoked') };
    function stop(code = 1008, reason = 'Access denied') {
      if (stopped) return;
      stopped = true;
      clearTimeout(expiry);
      if (entry.connections.get(sessionId) === connection) entry.connections.delete(sessionId);
      try {
        ws.close(code, reason);
      } catch {
        ws.terminate();
      }
      if (ws.readyState !== WebSocket.CLOSED) {
        forceClose = setTimeout(() => ws.terminate(), 1000);
        forceClose.unref();
      }
    }
    // Deliberately no addEventListener: only our ordered authorization path may accept frames.
    const adapter = {
      send: (data: string) => {
        if (stopped || ws.readyState !== WebSocket.OPEN) return;
        // One full 8 MiB native snapshot plus envelope fits; stalled peers cannot
        // make subsequent broadcasts grow the process heap without a bound.
        if (ws.bufferedAmount + Buffer.byteLength(data) > SOCKET_RESOURCE_LIMITS.outgoingBytes) {
          stop(1009, 'Send buffer exceeded');
          return;
        }
        ws.send(data);
      },
      close: (code?: number, reason?: string) => stop(code, reason),
      get readyState() {
        return ws.readyState;
      },
    };
    entry.connections.set(sessionId, connection);
    ws.on('message', (data, binary) => {
      if (stopped) return;
      if (binary) {
        stop(1003, 'Text messages required');
        return;
      }
      const now = performance.now();
      tokens = Math.min(
        BOARD_LIMITS.burst,
        tokens + ((now - refillAt) * BOARD_LIMITS.messagesPerSecond) / 1000,
      );
      refillAt = now;
      if (tokens < 1) {
        stop(1008, 'Message rate exceeded');
        return;
      }
      tokens--;
      if (queued >= BOARD_LIMITS.queue) {
        stop(1009, 'Message queue exceeded');
        return;
      }
      queued++;
      // Bytes are already capped by ws, before conversion or authorization work is queued.
      const frame = data.toString();
      queue = queue
        .then(async () => {
          if (stopped) return;
          await runtime.run(id, async (current) => {
            if (stopped || ws.readyState !== WebSocket.OPEN) return;
            const access = await authorizeIncoming(context, req, id);
            if (stopped) return;
            if (
              access.kind !== principal.kind ||
              access.principalId !== principal.principalId ||
              access.role !== principal.role
            )
              throw new AppError(403, 'Права изменены', 'BOARD_ACCESS_CHANGED');
            const message = gate.accept(frame);
            if (message === null) return;
            const parsed = protocolSchema.parse(JSON.parse(message));
            // Native server isReadonly + objectAccess:'read' discard viewer
            // mutations without changing durable state. Closing here also broke
            // legitimate SDK reconnect bookkeeping and stopped later peer updates.
            void parsed;
            // Pinned SDK handleMessage has no internal await: validation/COMMIT precede this return.
            current.room.handleSocketMessage(sessionId, message, adapter);
          });
        })
        .catch(() => stop(1008, 'Message rejected'))
        .finally(() => {
          queued--;
        });
    });
    ws.on('close', () => {
      stopped = true;
      clearTimeout(expiry);
      clearTimeout(forceClose);
      if (entry.connections.get(sessionId) === connection) entry.connections.delete(sessionId);
      void runtime
        .order(id, () => entry.room.handleSocketClose(sessionId, adapter))
        .catch(() => {});
    });
    ws.on('error', () => {
      stop(1008, 'Socket error');
      void runtime
        .order(id, () => entry.room.handleSocketError(sessionId, adapter))
        .catch(() => {});
    });
    entry.room.handleSocketConnect({
      sessionId,
      socket: adapter,
      isReadonly: principal.role === 'viewer',
      objectAccess: principal.role === 'viewer' ? 'read' : 'write',
    });
    if (principal.expiresAt) {
      expiry = setTimeout(
        () => stop(1008, 'Session expired'),
        Math.max(0, Date.parse(principal.expiresAt) - Date.now()),
      );
      expiry.unref();
    }
  }

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) {
    if (closing) throw new AppError(503, 'Доски закрываются');
    requireBoardOrigin(context, req);
    const runtime = requireBoardRuntime(context);
    const match = /^\/api\/board-access\/([^/]+)\/sync$/.exec(url.pathname);
    if (!match) throw new AppError(404, 'Маршрут не найден');
    const id = z.uuid().parse(decodeURIComponent(match[1]));
    const query = Object.create(null) as Record<string, string>;
    for (const [key, value] of url.searchParams) {
      if (Object.hasOwn(query, key)) throw new AppError(422, 'Повторяющийся параметр');
      query[key] = value;
    }
    const data = querySchema.parse(query);
    await authorizeIncoming(context, req, id);
    if (!pending.has(socket)) return;
    await runtime.run(id, async (entry) => {
      if (!pending.has(socket)) return;
      const principal = await authorizeIncoming(context, req, id);
      if (closing || socket.destroyed || !pending.has(socket)) return;
      const sessionId = `${principal.kind}:${principal.principalId}:${data.sessionId}`;
      if (entry.connections.size >= BOARD_LIMITS.sockets && !entry.connections.has(sessionId))
        throw new AppError(429, 'Комната заполнена', 'BOARD_SOCKET_LIMIT');
      wss.handleUpgrade(req, socket, head, (ws) =>
        connect(ws, req, id, data.sessionId, principal, entry),
      );
    });
  }
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '', context.config.appUrl);
    } catch {
      return;
    }
    if (!url.pathname.startsWith('/api/board-access/')) return;
    if (closing) {
      rejectUpgrade(socket, 503);
      return;
    }
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const ip = ipKeyGenerator(req.socket.remoteAddress ?? 'unknown');
    let budget = attempts.get(ip);
    if (!budget) {
      if (attempts.size >= SOCKET_RESOURCE_LIMITS.ipBuckets) {
        rejectUpgrade(socket, 429);
        return;
      }
      budget = { count: 0, until: now + SOCKET_RESOURCE_LIMITS.ipWindowMs };
      attempts.set(ip, budget);
    }
    if (
      ++budget.count > SOCKET_RESOURCE_LIMITS.ipAttempts ||
      inFlight.size >= SOCKET_RESOURCE_LIMITS.pending
    ) {
      rejectUpgrade(socket, 429);
      return;
    }
    pending.add(socket);
    inFlight.add(socket);
    // Error details can contain headers; never serialize them or secrets.
    const onError = () => socket.destroy();
    const cleanup = () => {
      pending.delete(socket);
      clearTimeout(timeout);
      socket.off('error', onError);
      socket.off('close', cleanup);
    };
    const timeout = setTimeout(() => {
      cleanup();
      rejectUpgrade(socket, 408);
    }, SOCKET_RESOURCE_LIMITS.upgradeTimeoutMs);
    timeout.unref();
    socket.on('error', onError);
    socket.once('close', cleanup);
    void handleUpgrade(req, socket, head, url)
      .catch((error: unknown) => {
        rejectUpgrade(
          socket,
          error instanceof AppError ? error.status : error instanceof z.ZodError ? 422 : 500,
        );
      })
      .finally(() => {
        inFlight.delete(socket);
        cleanup();
      });
  };
  server.on('upgrade', upgrade);
  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    server.off('upgrade', upgrade);
    for (const socket of pending) socket.destroy();
    for (const ws of wss.clients) ws.terminate();
    closePromise = new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    return closePromise;
  }
  server.once('close', () => {
    void close();
  });
  return { close };
}
