import net from 'node:net';
import { randomUUID } from 'node:crypto';

import {
  loadServerConfig,
  resolveConfigPath,
  type ServerConfig,
} from '../shared/config';
import { attachLineParser, sendJson } from '../shared/line-protocol';
import { Logger } from '../shared/logger';
import type {
  ClientMessage,
  HelloMessage,
  ProxyErrorMessage,
  ProxyMessage,
  RegisterMessage,
  TunnelDefinition,
} from '../shared/protocol';

interface PendingProxy {
  socket: net.Socket;
  timer: NodeJS.Timeout;
  remotePort: number;
}

interface ClientSession {
  id: string;
  name: string;
  socket: net.Socket;
  tunnels: Map<number, TunnelDefinition>;
  pending: Map<string, PendingProxy>;
}

const parseMessage = (line: string): ClientMessage | null => {
  try {
    return JSON.parse(line) as ClientMessage;
  } catch {
    return null;
  }
};

const sessions = new Map<string, ClientSession>();
const portRegistry = new Map<number, ClientSession>();
const portListeners = new Map<number, net.Server>();

const handleIncomingConnection = (
  config: ServerConfig,
  logger: Logger,
  remotePort: number,
  socket: net.Socket,
): void => {
  const session = portRegistry.get(remotePort);
  if (!session) {
    logger.warn('No session for incoming port', { remotePort });
    socket.destroy();
    return;
  }

  const connId = `${session.id}:${randomUUID()}`;
  const timer = setTimeout(() => {
    const pending = session.pending.get(connId);
    if (pending) {
      logger.warn('Proxy connection timeout', { connId, remotePort });
      session.pending.delete(connId);
      pending.socket.destroy();
    }
  }, 10000);

  session.pending.set(connId, { socket, timer, remotePort });
  sendJson(session.socket, { type: 'start_proxy', connId, remotePort });
};

const ensurePortListener = async (
  config: ServerConfig,
  logger: Logger,
  remotePort: number,
): Promise<net.Server> => {
  const existing = portListeners.get(remotePort);
  if (existing) {
    return existing;
  }

  const listener = net.createServer((socket) => {
    socket.setNoDelay(true);
    handleIncomingConnection(config, logger, remotePort, socket);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      listener.off('listening', onListen);
      reject(err);
    };

    const onListen = (): void => {
      listener.off('error', onError);
      resolve();
    };

    listener.once('error', onError);
    listener.once('listening', onListen);
    listener.listen(remotePort, config.bindAddr);
  });

  listener.on('error', (err) => {
    logger.error('Port listener error', { remotePort, error: err.message });
  });

  portListeners.set(remotePort, listener);
  logger.info('Listening for tunnel port', { remotePort });
  return listener;
};

const releasePort = (remotePort: number, logger: Logger): void => {
  portRegistry.delete(remotePort);
  const listener = portListeners.get(remotePort);
  if (listener) {
    listener.close();
    portListeners.delete(remotePort);
    logger.info('Closed tunnel port listener', { remotePort });
  }
};

const cleanupSession = (session: ClientSession, logger: Logger): void => {
  sessions.delete(session.id);

  for (const [connId, pending] of session.pending) {
    clearTimeout(pending.timer);
    pending.socket.destroy();
    session.pending.delete(connId);
  }

  for (const remotePort of session.tunnels.keys()) {
    if (portRegistry.get(remotePort) === session) {
      releasePort(remotePort, logger);
    }
  }

  logger.info('Session cleaned up', { sessionId: session.id, name: session.name });
};

const handleRegister = async (
  config: ServerConfig,
  session: ClientSession,
  message: RegisterMessage,
  logger: Logger,
): Promise<void> => {
  const accepted: number[] = [];
  const rejected: { port: number; reason: string }[] = [];
  const incomingPorts = new Set<number>();

  for (const tunnel of message.tunnels) {
    incomingPorts.add(tunnel.remotePort);
  }

  for (const existingPort of session.tunnels.keys()) {
    if (!incomingPorts.has(existingPort) && portRegistry.get(existingPort) === session) {
      session.tunnels.delete(existingPort);
      releasePort(existingPort, logger);
    }
  }

  for (const tunnel of message.tunnels) {
    const remotePort = tunnel.remotePort;

    if (tunnel.protocol && tunnel.protocol !== 'tcp') {
      rejected.push({ port: remotePort, reason: 'unsupported_protocol' });
      continue;
    }

    if (
      remotePort < config.tunnelPortMin ||
      remotePort > config.tunnelPortMax ||
      !Number.isInteger(remotePort)
    ) {
      rejected.push({ port: remotePort, reason: 'port_out_of_range' });
      continue;
    }

    const existingSession = portRegistry.get(remotePort);
    if (existingSession && existingSession !== session) {
      rejected.push({ port: remotePort, reason: 'port_in_use' });
      continue;
    }

    try {
      await ensurePortListener(config, logger, remotePort);
      portRegistry.set(remotePort, session);
      session.tunnels.set(remotePort, tunnel);
      accepted.push(remotePort);
    } catch (error) {
      rejected.push({ port: remotePort, reason: 'port_bind_failed' });
      logger.error('Failed to bind port', { remotePort, error: (error as Error).message });
    }
  }

  sendJson(session.socket, { type: 'register_ack', accepted, rejected });
};

const handleProxyError = (
  session: ClientSession,
  message: ProxyErrorMessage,
  logger: Logger,
): void => {
  const pending = session.pending.get(message.connId);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timer);
  session.pending.delete(message.connId);
  pending.socket.destroy();
  logger.warn('Proxy error from client', { connId: message.connId, message: message.message });
};

const pairSockets = (serverSocket: net.Socket, clientSocket: net.Socket): void => {
  serverSocket.pipe(clientSocket);
  clientSocket.pipe(serverSocket);

  const cleanup = (): void => {
    serverSocket.destroy();
    clientSocket.destroy();
  };

  serverSocket.on('close', cleanup);
  clientSocket.on('close', cleanup);
  serverSocket.on('error', cleanup);
  clientSocket.on('error', cleanup);
};

const handleProxyConnection = (
  config: ServerConfig,
  logger: Logger,
  socket: net.Socket,
  message: ProxyMessage,
  detach: () => void,
): void => {
  if (message.token !== config.token) {
    sendJson(socket, { type: 'error', message: 'invalid_token' });
    socket.end();
    return;
  }

  const [sessionId] = message.connId.split(':');
  const session = sessions.get(sessionId);
  if (!session) {
    sendJson(socket, { type: 'error', message: 'unknown_session' });
    socket.end();
    return;
  }

  const pending = session.pending.get(message.connId);
  if (!pending) {
    sendJson(socket, { type: 'error', message: 'unknown_conn' });
    socket.end();
    return;
  }

  clearTimeout(pending.timer);
  session.pending.delete(message.connId);
  detach();

  socket.setNoDelay(true);
  pending.socket.setNoDelay(true);
  pairSockets(pending.socket, socket);
};

const handleConnection = (config: ServerConfig, logger: Logger, socket: net.Socket): void => {
  socket.setNoDelay(true);

  let session: ClientSession | null = null;
  let connectionType: 'unknown' | 'control' | 'proxy' = 'unknown';

  const detach = attachLineParser(socket, (line) => {
    const message = parseMessage(line);
    if (!message || typeof message.type !== 'string') {
      sendJson(socket, { type: 'error', message: 'invalid_message' });
      return;
    }

    if (connectionType === 'unknown') {
      if (message.type === 'hello') {
        const hello = message as HelloMessage;
        if (hello.token !== config.token) {
          sendJson(socket, { type: 'hello_ack', ok: false, message: 'invalid_token' });
          socket.end();
          return;
        }

        session = {
          id: randomUUID(),
          name: hello.clientId ?? 'client',
          socket,
          tunnels: new Map(),
          pending: new Map(),
        };

        sessions.set(session.id, session);
        connectionType = 'control';
        sendJson(socket, { type: 'hello_ack', ok: true, sessionId: session.id });
        logger.info('Client connected', { sessionId: session.id, name: session.name });
        return;
      }

      if (message.type === 'proxy') {
        connectionType = 'proxy';
        handleProxyConnection(config, logger, socket, message as ProxyMessage, detach);
        return;
      }

      sendJson(socket, { type: 'error', message: 'invalid_handshake' });
      socket.end();
      return;
    }

    if (connectionType === 'proxy') {
      sendJson(socket, { type: 'error', message: 'unexpected_message' });
      return;
    }

    if (!session) {
      sendJson(socket, { type: 'error', message: 'session_missing' });
      return;
    }

    switch (message.type) {
      case 'register':
        void handleRegister(config, session, message as RegisterMessage, logger);
        break;
      case 'heartbeat':
        sendJson(socket, { type: 'heartbeat_ack', ts: Date.now() });
        break;
      case 'proxy_error':
        handleProxyError(session, message as ProxyErrorMessage, logger);
        break;
      default:
        sendJson(socket, { type: 'error', message: 'unknown_message' });
    }
  });

  socket.on('close', () => {
    if (connectionType === 'control' && session) {
      cleanupSession(session, logger);
    }
  });

  socket.on('error', (err) => {
    logger.warn('Socket error', { error: err.message });
  });
};

const main = (): void => {
  const args = process.argv.slice(2);
  const logger = new Logger('info', 'server');
  const configPath = resolveConfigPath(args, 'config/server.example.toml', logger);
  const config = loadServerConfig(configPath);

  logger.setLevel(config.logLevel);
  logger.info('Starting server', {
    bind: `${config.bindAddr}:${config.bindPort}`,
    portRange: `${config.tunnelPortMin}-${config.tunnelPortMax}`,
    configPath,
  });

  const server = net.createServer((socket) => handleConnection(config, logger, socket));
  server.on('error', (err) => {
    logger.error('Control server error', { error: err.message });
  });

  server.listen(config.bindPort, config.bindAddr, () => {
    logger.info('Control server listening', { port: config.bindPort });
  });
};

main();
