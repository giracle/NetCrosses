import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TunnelConfig {
  name: string;
  localAddr: string;
  localPort: number;
  remotePort: number;
  protocol: 'tcp';
}

export interface ClientConfig {
  serverAddr: string;
  serverPort: number;
  token: string;
  name: string;
  logLevel: LogLevel;
  heartbeatIntervalMs: number;
  reconnectDelayMs: number;
  autoStart: boolean;
  startOnLogin: boolean;
  trayEnabled: boolean;
  tunnels: TunnelConfig[];
}

const defaultConfig: ClientConfig = {
  serverAddr: '127.0.0.1',
  serverPort: 7001,
  token: '',
  name: 'NetCrosses-桌面端',
  logLevel: 'info',
  heartbeatIntervalMs: 10000,
  reconnectDelayMs: 2000,
  autoStart: false,
  startOnLogin: false,
  trayEnabled: true,
  tunnels: [
    {
      name: '映射-10001',
      localAddr: '127.0.0.1',
      localPort: 22,
      remotePort: 10001,
      protocol: 'tcp',
    },
  ],
};

let cachedConfig: ClientConfig | null = null;

const configPath = (): string =>
  path.join(app.getPath('userData'), 'client-config.json');

const toString = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const toNumber = (value: unknown, fallback: number): number => {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return num;
};

const toLogLevel = (value: unknown, fallback: LogLevel): LogLevel => {
  if (typeof value !== 'string') {
    return fallback;
  }
  const candidate = value.toLowerCase();
  if (candidate === 'debug' || candidate === 'info' || candidate === 'warn' || candidate === 'error') {
    return candidate;
  }
  return fallback;
};

const toBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
};

const normalizeTunnels = (value: unknown): TunnelConfig[] => {
  if (!Array.isArray(value)) {
    return defaultConfig.tunnels;
  }

  const tunnels = value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const record = entry as Record<string, unknown>;
      return {
        name: toString(record.name, '未命名映射'),
        localAddr: toString(record.localAddr ?? record.local_addr, '127.0.0.1'),
        localPort: Math.trunc(toNumber(record.localPort ?? record.local_port, 0)),
        remotePort: Math.trunc(toNumber(record.remotePort ?? record.remote_port, 0)),
        protocol: 'tcp',
      } as TunnelConfig;
    })
    .filter((entry): entry is TunnelConfig =>
      Boolean(entry && entry.localPort > 0 && entry.remotePort > 0),
    );

  return tunnels.length > 0 ? tunnels : defaultConfig.tunnels;
};

const normalizeConfig = (value: unknown): ClientConfig => {
  if (!value || typeof value !== 'object') {
    return { ...defaultConfig };
  }

  const record = value as Record<string, unknown>;
  const clientRecord =
    record.client && typeof record.client === 'object'
      ? (record.client as Record<string, unknown>)
      : record;

  return {
    serverAddr: toString(
      clientRecord.serverAddr ?? clientRecord.server_addr ?? record.serverAddr ?? record.server_addr,
      defaultConfig.serverAddr,
    ),
    serverPort: Math.trunc(
      toNumber(
        clientRecord.serverPort ??
          clientRecord.server_port ??
          record.serverPort ??
          record.server_port,
        defaultConfig.serverPort,
      ),
    ),
    token: toString(clientRecord.token ?? record.token, defaultConfig.token),
    name: toString(clientRecord.name ?? record.name, defaultConfig.name),
    logLevel: toLogLevel(
      clientRecord.logLevel ?? clientRecord.log_level ?? record.logLevel ?? record.log_level,
      defaultConfig.logLevel,
    ),
    heartbeatIntervalMs: Math.trunc(
      toNumber(
        clientRecord.heartbeatIntervalMs ??
          clientRecord.heartbeat_interval_ms ??
          record.heartbeatIntervalMs ??
          record.heartbeat_interval_ms,
        defaultConfig.heartbeatIntervalMs,
      ),
    ),
    reconnectDelayMs: Math.trunc(
      toNumber(
        clientRecord.reconnectDelayMs ??
          clientRecord.reconnect_delay_ms ??
          record.reconnectDelayMs ??
          record.reconnect_delay_ms,
        defaultConfig.reconnectDelayMs,
      ),
    ),
    autoStart: toBoolean(
      clientRecord.autoStart ??
        clientRecord.auto_start ??
        record.autoStart ??
        record.auto_start,
      defaultConfig.autoStart,
    ),
    startOnLogin: toBoolean(
      clientRecord.startOnLogin ??
        clientRecord.start_on_login ??
        record.startOnLogin ??
        record.start_on_login,
      defaultConfig.startOnLogin,
    ),
    trayEnabled: toBoolean(
      clientRecord.trayEnabled ??
        clientRecord.tray_enabled ??
        record.trayEnabled ??
        record.tray_enabled,
      defaultConfig.trayEnabled,
    ),
    tunnels: normalizeTunnels(record.tunnels ?? clientRecord.tunnels),
  };
};

export const loadConfig = (): ClientConfig => {
  if (cachedConfig) {
    return cachedConfig;
  }

  const filePath = configPath();
  if (!fs.existsSync(filePath)) {
    cachedConfig = { ...defaultConfig };
    return cachedConfig;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    cachedConfig = normalizeConfig(raw);
    return cachedConfig;
  } catch {
    cachedConfig = { ...defaultConfig };
    return cachedConfig;
  }
};

export const saveConfig = (value: unknown): ClientConfig => {
  const config = normalizeConfig(value);
  cachedConfig = config;
  const filePath = configPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
  return config;
};
