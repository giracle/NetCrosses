import net from 'node:net';
import os from 'node:os';

import {
  loadClientConfig,
  resolveConfigPath,
  type ClientConfig,
} from '../shared/config';
import { attachLineParser, sendJson } from '../shared/line-protocol';
import { Logger } from '../shared/logger';
import type {
  RegisterAckMessage,
  StartProxyMessage,
  TunnelDefinition,
} from '../shared/protocol';

interface ControlState {
  socket?: net.Socket;
  heartbeatTimer?: NodeJS.Timeout;
  reconnectTimer?: NodeJS.Timeout;
  reconnectAttempts: number;
}

const parseMessage = (line: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isRegisterAckMessage = (message: unknown): message is RegisterAckMessage =>
  isRecord(message) &&
  message.type === 'register_ack' &&
  Array.isArray(message.accepted) &&
  Array.isArray(message.rejected);

const isStartProxyMessage = (message: unknown): message is StartProxyMessage =>
  isRecord(message) &&
  message.type === 'start_proxy' &&
  typeof message.connId === 'string' &&
  typeof message.remotePort === 'number';

const waitForConnect = (socket: net.Socket): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      socket.off('connect', onConnect);
      reject(err);
    };

    const onConnect = (): void => {
      socket.off('error', onError);
      resolve();
    };

    socket.once('error', onError);
    socket.once('connect', onConnect);
  });

const startProxy = (
  config: ClientConfig,
  tunnel: TunnelDefinition,
  connId: string,
  controlSocket: net.Socket,
  logger: Logger,
): void => {
  const serverSocket = net.createConnection({
    host: config.serverAddr,
    port: config.serverPort,
  });
  serverSocket.setNoDelay(true);

  const localSocket = net.createConnection({
    host: tunnel.localAddr,
    port: tunnel.localPort,
  });
  localSocket.setNoDelay(true);

  const serverReady = waitForConnect(serverSocket).then(() => {
    sendJson(serverSocket, { type: 'proxy', connId, token: config.token });
  });

  const localReady = waitForConnect(localSocket);

  Promise.all([serverReady, localReady])
    .then(() => {
      localSocket.pipe(serverSocket);
      serverSocket.pipe(localSocket);
    })
    .catch((error) => {
      sendJson(controlSocket, {
        type: 'proxy_error',
        connId,
        message: error instanceof Error ? error.message : 'proxy_connect_failed',
      });
      serverSocket.destroy();
      localSocket.destroy();
      logger.warn('Proxy connection failed', {
        connId,
        remotePort: tunnel.remotePort,
        error: error instanceof Error ? error.message : String(error),
      });
    });
};

const buildTunnelIndex = (tunnels: TunnelDefinition[]): Map<number, TunnelDefinition> => {
  const index = new Map<number, TunnelDefinition>();
  for (const tunnel of tunnels) {
    index.set(tunnel.remotePort, tunnel);
  }
  return index;
};

const connectControl = (config: ClientConfig, logger: Logger): void => {
  const state: ControlState = { reconnectAttempts: 0 };
  const tunnelIndex = buildTunnelIndex(config.tunnels);

  const scheduleReconnect = (): void => {
    if (state.reconnectTimer) {
      return;
    }
    const delay = Math.min(config.reconnectDelayMs * 2 ** state.reconnectAttempts, 30000);
    state.reconnectAttempts += 1;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = undefined;
      connect();
    }, delay);
    logger.info('Reconnecting', { delayMs: delay });
  };

  const clearHeartbeat = (): void => {
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = undefined;
    }
  };

  const connect = (): void => {
    const socket = net.createConnection({
      host: config.serverAddr,
      port: config.serverPort,
    });
    socket.setNoDelay(true);

    state.socket = socket;

    const detach = attachLineParser(socket, (line) => {
      const message = parseMessage(line);
      if (!message || typeof message.type !== 'string') {
        logger.warn('Invalid message', { line });
        return;
      }

      switch (message.type) {
        case 'hello_ack': {
          const ok = message.ok === true;
          const reason = typeof message.message === 'string' ? message.message : 'unknown';
          if (ok) {
            sendJson(socket, {
              type: 'register',
              tunnels: config.tunnels,
            });
            state.reconnectAttempts = 0;
            clearHeartbeat();
            state.heartbeatTimer = setInterval(() => {
              sendJson(socket, { type: 'heartbeat', ts: Date.now() });
            }, config.heartbeatIntervalMs);
          } else {
            logger.error('Handshake rejected', { reason });
            socket.end();
          }
          break;
        }
        case 'register_ack': {
          if (!isRegisterAckMessage(message)) {
            logger.warn('Malformed register_ack', { message });
            return;
          }
          logger.info('Tunnel registration', {
            accepted: message.accepted,
            rejected: message.rejected,
          });
          break;
        }
        case 'start_proxy': {
          if (!isStartProxyMessage(message)) {
            logger.warn('Malformed start_proxy', { message });
            return;
          }
          const start = message;
          const tunnel = tunnelIndex.get(start.remotePort);
          if (!tunnel) {
            sendJson(socket, {
              type: 'proxy_error',
              connId: start.connId,
              message: 'tunnel_not_found',
            });
            logger.warn('Tunnel not found for port', { remotePort: start.remotePort });
            return;
          }
          if (tunnel.protocol && tunnel.protocol !== 'tcp') {
            sendJson(socket, {
              type: 'proxy_error',
              connId: start.connId,
              message: 'unsupported_protocol',
            });
            logger.warn('Unsupported tunnel protocol', {
              remotePort: start.remotePort,
              protocol: tunnel.protocol,
            });
            return;
          }
          startProxy(config, tunnel, start.connId, socket, logger);
          break;
        }
        case 'error': {
          const errorMessage =
            typeof message.message === 'string' ? message.message : 'unknown';
          logger.warn('Server error', { message: errorMessage });
          break;
        }
        default:
          logger.warn('Unhandled message', { type: message.type });
      }
    });

    socket.on('connect', () => {
      sendJson(socket, {
        type: 'hello',
        token: config.token,
        clientId: config.name,
      });
      logger.info('Connected to server', {
        server: `${config.serverAddr}:${config.serverPort}`,
      });
    });

    socket.on('close', () => {
      detach();
      clearHeartbeat();
      logger.warn('Control connection closed');
      scheduleReconnect();
    });

    socket.on('error', (err) => {
      logger.warn('Control socket error', { error: err.message });
    });
  };

  connect();
};

const main = (): void => {
  const args = process.argv.slice(2);
  const logger = new Logger('info', 'client');
  const configPath = resolveConfigPath(args, 'config/client.example.toml', logger);
  const config = loadClientConfig(configPath);

  if (!config.name || config.name === 'netcrosses-client') {
    config.name = `${config.name}-${os.hostname()}`;
  }

  logger.setLevel(config.logLevel);
  logger.info('Starting client', { configPath, server: config.serverAddr });
  connectControl(config, logger);
};

main();
