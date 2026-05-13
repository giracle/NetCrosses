import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@iarna/toml';

import { Logger, parseLogLevel, type LogLevel } from './logger';
import type { TunnelDefinition } from './protocol';

export interface ServerConfig {
  bindAddr: string;
  bindPort: number;
  token: string;
  tunnelPortMin: number;
  tunnelPortMax: number;
  logLevel: LogLevel;
}

export interface ClientConfig {
  serverAddr: string;
  serverPort: number;
  token: string;
  name: string;
  logLevel: LogLevel;
  reconnectDelayMs: number;
  heartbeatIntervalMs: number;
  tunnels: TunnelDefinition[];
}

const requireObject = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be a table`);
  }
  return value as Record<string, unknown>;
};

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Expected ${label} to be a non-empty string`);
  }
  return value.trim();
};

const requireNumber = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`Expected ${label} to be a number`);
  }
  return value;
};

const optionalNumber = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback;
  }
  return value;
};

const optionalString = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fallback;
  }
  return value.trim();
};

export const loadServerConfig = (filePath: string): ServerConfig => {
  const raw = parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  const server = requireObject(raw.server, 'server');

  return {
    bindAddr: requireString(server.bind_addr, 'server.bind_addr'),
    bindPort: requireNumber(server.bind_port, 'server.bind_port'),
    token: requireString(server.token, 'server.token'),
    tunnelPortMin: requireNumber(server.tunnel_port_min, 'server.tunnel_port_min'),
    tunnelPortMax: requireNumber(server.tunnel_port_max, 'server.tunnel_port_max'),
    logLevel: parseLogLevel(server.log_level, 'info'),
  };
};

export const loadClientConfig = (filePath: string): ClientConfig => {
  const raw = parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  const client = requireObject(raw.client, 'client');
  const tunnelsRaw = raw.tunnels;

  if (!Array.isArray(tunnelsRaw) || tunnelsRaw.length === 0) {
    throw new Error('Expected tunnels to be a non-empty array');
  }

  const tunnels = tunnelsRaw.map((entry, index) => {
    const tunnel = requireObject(entry, `tunnels[${index}]`);
    return {
      name: requireString(tunnel.name, `tunnels[${index}].name`),
      localAddr: optionalString(tunnel.local_addr, '127.0.0.1'),
      localPort: requireNumber(tunnel.local_port, `tunnels[${index}].local_port`),
      remotePort: requireNumber(tunnel.remote_port, `tunnels[${index}].remote_port`),
      protocol: optionalString(tunnel.protocol, 'tcp'),
    } as TunnelDefinition;
  });

  return {
    serverAddr: requireString(client.server_addr, 'client.server_addr'),
    serverPort: requireNumber(client.server_port, 'client.server_port'),
    token: requireString(client.token, 'client.token'),
    name: optionalString(client.name, 'netcrosses-client'),
    logLevel: parseLogLevel(client.log_level, 'info'),
    reconnectDelayMs: optionalNumber(client.reconnect_delay_ms, 2000),
    heartbeatIntervalMs: optionalNumber(client.heartbeat_interval_ms, 10000),
    tunnels,
  };
};

export const resolveConfigPath = (
  args: string[],
  fallback: string,
  logger?: Logger,
): string => {
  const envPath = process.env.NETCROSSES_CONFIG;
  const argvPath = (() => {
    for (let i = 0; i < args.length; i += 1) {
      const value = args[i];
      if (value === '--config' && args[i + 1]) {
        return args[i + 1];
      }
      if (value.startsWith('--config=')) {
        return value.slice('--config='.length);
      }
    }
    return undefined;
  })();

  const resolved = argvPath ?? envPath ?? fallback;
  const absolutePath = path.isAbsolute(resolved)
    ? resolved
    : path.resolve(process.cwd(), resolved);

  if (!fs.existsSync(absolutePath)) {
    logger?.warn('Config path does not exist', { path: absolutePath });
  }

  return absolutePath;
};
