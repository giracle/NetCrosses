import { EventEmitter } from 'node:events';
import net from 'node:net';

import { attachLineParser, sendJson } from '../shared/line-protocol';
import type {
  RegisterAckMessage,
  StartProxyMessage,
  TunnelDefinition,
} from '../shared/tunnel-protocol';
import type { ClientConfig, LogLevel, TunnelConfig } from './config-store';

export interface ClientStatus {
  state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped' | 'error';
  lastError?: string;
}

export interface LogEntry {
  time: string;
  level: LogLevel;
  message: string;
  meta?: Record<string, unknown>;
}

interface ControlState {
  socket?: net.Socket;
  heartbeatTimer?: NodeJS.Timeout;
  reconnectTimer?: NodeJS.Timeout;
  reconnectAttempts: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isRegisterAck = (message: unknown): message is RegisterAckMessage =>
  isRecord(message) &&
  message.type === 'register_ack' &&
  Array.isArray(message.accepted) &&
  Array.isArray(message.rejected);

const isStartProxy = (message: unknown): message is StartProxyMessage =>
  isRecord(message) &&
  message.type === 'start_proxy' &&
  typeof message.connId === 'string' &&
  typeof message.remotePort === 'number';

const containsChinese = (value: string): boolean => /[\u4e00-\u9fff]/.test(value);

const errorCodeMap: Record<string, string> = {
  ETIMEDOUT: '连接超时',
  ECONNREFUSED: '连接被拒绝',
  ECONNRESET: '连接被重置',
  EHOSTUNREACH: '主机不可达',
  ENOTFOUND: '地址不可达',
  ENETUNREACH: '网络不可达',
  EADDRINUSE: '端口已被占用',
  EACCES: '权限不足',
  EPIPE: '连接已断开',
  EAI_AGAIN: '域名解析失败',
};

const stripErrorPrefix = (value: string): string =>
  value.replace(/^(connect|read|write|getaddrinfo|listen)\s+/i, '');

const translateSocketError = (value: unknown): string => {
  const text =
    value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  if (!text) return '未知错误';
  if (containsChinese(text)) return text;

  const lower = text.toLowerCase();
  if (lower.includes('socket hang up')) return '连接被中断';

  for (const [code, label] of Object.entries(errorCodeMap)) {
    if (text.includes(code)) {
      return stripErrorPrefix(text.replace(code, label)).trim();
    }
  }

  if (lower.includes('timeout')) return '超时';
  if (lower.includes('no response')) return '无响应';
  return '未知错误';
};

const translateServerMessage = (value: string, fallback: string): string => {
  const normalized = value.toLowerCase();
  switch (normalized) {
    case 'invalid_token':
      return '令牌无效';
    case 'invalid_handshake':
      return '握手失败';
    case 'session_missing':
    case 'unknown_session':
      return '会话不存在';
    case 'tunnel_not_found':
      return '未找到映射';
    case 'unsupported_protocol':
      return '不支持的协议';
    case 'port_out_of_range':
      return '端口超出范围';
    case 'port_in_use':
      return '端口已被占用';
    case 'port_bind_failed':
      return '端口绑定失败';
    case 'proxy_connect_failed':
      return '代理连接失败';
    default:
      return fallback;
  }
};

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

const buildTunnelIndex = (tunnels: TunnelConfig[]): Map<number, TunnelDefinition> => {
  const index = new Map<number, TunnelDefinition>();
  for (const tunnel of tunnels) {
    index.set(tunnel.remotePort, tunnel);
  }
  return index;
};

export class TunnelClient extends EventEmitter {
  private config: ClientConfig;
  private state: ControlState = { reconnectAttempts: 0 };
  private status: ClientStatus = { state: 'idle' };
  private logs: LogEntry[] = [];
  private tunnelIndex: Map<number, TunnelDefinition> = new Map();
  private shouldReconnect = false;

  constructor(config: ClientConfig) {
    super();
    this.config = config;
    this.tunnelIndex = buildTunnelIndex(config.tunnels);
  }

  updateConfig(config: ClientConfig): void {
    this.config = config;
    this.tunnelIndex = buildTunnelIndex(config.tunnels);
    this.log('info', '配置已更新', {
      服务器: `${config.serverAddr}:${config.serverPort}`,
      映射数: config.tunnels.length,
    });
  }

  start(): void {
    if (this.status.state === 'connected' || this.status.state === 'connecting') {
      return;
    }
    this.shouldReconnect = true;
    this.connect('connecting');
  }

  stop(): void {
    this.shouldReconnect = false;
    this.clearTimers();

    if (this.state.socket) {
      this.state.socket.destroy();
      this.state.socket = undefined;
    }

    this.updateStatus('stopped');
  }

  getStatus(): ClientStatus {
    return { ...this.status };
  }

  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  private connect(nextState: ClientStatus['state']): void {
    const socket = net.createConnection({
      host: this.config.serverAddr,
      port: this.config.serverPort,
    });
    socket.setNoDelay(true);

    this.state.socket = socket;
    this.updateStatus(nextState);

    const detach = attachLineParser(socket, (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.log('warn', '服务器返回了无效 JSON', { 原始行: line });
        return;
      }

      if (!isRecord(message) || typeof message.type !== 'string') {
        this.log('warn', '服务器消息格式异常', { 消息: message });
        return;
      }

      switch (message.type) {
        case 'hello_ack': {
          const ok = message.ok === true;
          const reason =
            typeof message.message === 'string'
              ? translateServerMessage(message.message, '未知原因')
              : '未知原因';
          if (ok) {
            sendJson(socket, { type: 'register', tunnels: this.config.tunnels });
            this.state.reconnectAttempts = 0;
            this.clearHeartbeat();
            this.state.heartbeatTimer = setInterval(() => {
              sendJson(socket, { type: 'heartbeat', ts: Date.now() });
            }, this.config.heartbeatIntervalMs);
            this.updateStatus('connected');
            this.log('info', '握手成功');
          } else {
            this.updateStatus('error', reason);
            this.log('error', '握手被拒绝', { 原因: reason });
            socket.end();
          }
          break;
        }
        case 'register_ack': {
          if (!isRegisterAck(message)) {
            this.log('warn', '注册响应格式异常', { 消息: message });
            return;
          }
          const rejected = message.rejected.map((item) => ({
            端口: item.port,
            原因: translateServerMessage(item.reason, '未知原因'),
          }));
          this.log('info', '隧道注册结果', {
            已通过: message.accepted,
            已拒绝: rejected,
          });
          break;
        }
        case 'start_proxy': {
          if (!isStartProxy(message)) {
            this.log('warn', '代理启动指令格式异常', { 消息: message });
            return;
          }
          const tunnel = this.tunnelIndex.get(message.remotePort);
          if (!tunnel) {
            sendJson(socket, {
              type: 'proxy_error',
              connId: message.connId,
              message: 'tunnel_not_found',
            });
            this.log('warn', '未找到对应端口的映射', {
              公网端口: message.remotePort,
            });
            return;
          }
          if (tunnel.protocol && tunnel.protocol !== 'tcp') {
            sendJson(socket, {
              type: 'proxy_error',
              connId: message.connId,
              message: 'unsupported_protocol',
            });
            this.log('warn', '不支持的隧道协议', {
              公网端口: message.remotePort,
              协议: tunnel.protocol,
            });
            return;
          }
          this.startProxy(tunnel, message.connId);
          break;
        }
        case 'error': {
          const errorMessage =
            typeof message.message === 'string'
              ? translateServerMessage(message.message, '未知错误')
              : '未知错误';
          this.log('warn', '服务器返回错误', { 原因: errorMessage });
          break;
        }
        default:
          break;
      }
    });

    socket.on('connect', () => {
      sendJson(socket, {
        type: 'hello',
        token: this.config.token,
        clientId: this.config.name,
      });
      this.log('info', '已连接到服务器', {
        服务器: `${this.config.serverAddr}:${this.config.serverPort}`,
      });
    });

    socket.on('close', () => {
      detach();
      this.clearHeartbeat();
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      } else {
        this.updateStatus('stopped');
      }
    });

    socket.on('error', (err) => {
      this.log('warn', '控制通道错误', {
        错误: translateSocketError(err),
        服务器: `${this.config.serverAddr}:${this.config.serverPort}`,
      });
    });
  }

  private startProxy(tunnel: TunnelDefinition, connId: string): void {
    const controlSocket = this.state.socket;
    if (!controlSocket || controlSocket.destroyed) {
      this.log('warn', '代理启动时控制通道不可用', { 连接ID: connId });
      return;
    }

    const serverSocket = net.createConnection({
      host: this.config.serverAddr,
      port: this.config.serverPort,
    });
    serverSocket.setNoDelay(true);

    const localSocket = net.createConnection({
      host: tunnel.localAddr,
      port: tunnel.localPort,
    });
    localSocket.setNoDelay(true);

    const serverReady = waitForConnect(serverSocket).then(() => {
      sendJson(serverSocket, { type: 'proxy', connId, token: this.config.token });
    });

    const localReady = waitForConnect(localSocket);

    Promise.all([serverReady, localReady])
      .then(() => {
        let cleaned = false;
        const cleanup = (source: string, error?: unknown): void => {
          if (cleaned) return;
          cleaned = true;
          if (error) {
            this.log('warn', '代理连接异常中断', {
              连接ID: connId,
              公网端口: tunnel.remotePort,
              本地地址: `${tunnel.localAddr}:${tunnel.localPort}`,
              来源: source,
              错误: translateSocketError(error),
            });
          }
          if (!serverSocket.destroyed) serverSocket.destroy();
          if (!localSocket.destroyed) localSocket.destroy();
        };

        serverSocket.on('error', (err) => cleanup('服务器', err));
        localSocket.on('error', (err) => cleanup('本地', err));
        serverSocket.on('close', () => {
          if (!localSocket.destroyed) localSocket.destroy();
        });
        localSocket.on('close', () => {
          if (!serverSocket.destroyed) serverSocket.destroy();
        });

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
        this.log('warn', '代理连接失败', {
          连接ID: connId,
          公网端口: tunnel.remotePort,
          本地地址: `${tunnel.localAddr}:${tunnel.localPort}`,
          错误: translateSocketError(error),
        });
      });
  }

  private scheduleReconnect(): void {
    if (this.state.reconnectTimer) {
      return;
    }

    const delay = Math.min(
      this.config.reconnectDelayMs * 2 ** this.state.reconnectAttempts,
      30000,
    );
    this.state.reconnectAttempts += 1;
    this.updateStatus('reconnecting');
    this.log('info', '准备重连', { 延迟毫秒: delay });

    this.state.reconnectTimer = setTimeout(() => {
      this.state.reconnectTimer = undefined;
      if (this.shouldReconnect) {
        this.connect('reconnecting');
      }
    }, delay);
  }

  private updateStatus(state: ClientStatus['state'], lastError?: string): void {
    this.status = { state, lastError };
    this.emit('status', this.status);
  }

  private log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    const entry: LogEntry = {
      time: new Date().toISOString(),
      level,
      message,
      meta,
    };
    this.logs.push(entry);
    if (this.logs.length > 200) {
      this.logs.shift();
    }
    this.emit('log', entry);
  }

  private clearHeartbeat(): void {
    if (this.state.heartbeatTimer) {
      clearInterval(this.state.heartbeatTimer);
      this.state.heartbeatTimer = undefined;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.state.reconnectTimer) {
      clearTimeout(this.state.reconnectTimer);
      this.state.reconnectTimer = undefined;
    }
    this.state.reconnectAttempts = 0;
  }
}
