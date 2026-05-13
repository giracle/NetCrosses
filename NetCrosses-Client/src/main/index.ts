import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  type NativeImage,
} from 'electron';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { parse as parseToml, stringify as stringifyToml } from '@iarna/toml';

import { loadConfig, saveConfig, type ClientConfig } from './config-store';
import { TunnelClient } from './tunnel-client';

type TomlMap = Parameters<typeof stringifyToml>[0];

interface SocketCheckResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

interface ProbeResult extends SocketCheckResult {
  bytes?: number;
}

interface TunnelTestResult {
  name: string;
  localAddr: string;
  localPort: number;
  remotePort: number;
  local: SocketCheckResult;
  remote: SocketCheckResult;
}

interface TunnelDeepResult extends TunnelTestResult {
  probe: ProbeResult;
}

let mainWindow: BrowserWindow | null = null;
let tunnelClient: TunnelClient | null = null;
let tray: Tray | null = null;
let trayEnabled = false;
let isQuitting = false;

const trayIconSvg = `
<svg width="128" height="128" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="16" y="20" width="96" height="88" rx="20" stroke="#E9EDF5" stroke-width="8"/>
  <path d="M40 76C52 62 76 62 88 76" stroke="#E9EDF5" stroke-width="8" stroke-linecap="round"/>
  <circle cx="46" cy="50" r="6" fill="#E9EDF5"/>
  <circle cx="82" cy="50" r="6" fill="#E9EDF5"/>
</svg>
`;

const createTrayImage = (): NativeImage => {
  const svg = `data:image/svg+xml;utf8,${encodeURIComponent(trayIconSvg)}`;
  const image = nativeImage.createFromDataURL(svg);
  if (process.platform === 'darwin') {
    image.setTemplateImage(true);
  }
  return image;
};

const statusLabelMap: Record<string, string> = {
  idle: '空闲',
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '重连中',
  stopped: '已停止',
  error: '异常',
};

const formatStatusLabel = (state: string): string => statusLabelMap[state] ?? state;

const buildTomlPayload = (config: ClientConfig): TomlMap => ({
  client: {
    server_addr: config.serverAddr,
    server_port: config.serverPort,
    token: config.token,
    name: config.name,
    log_level: config.logLevel,
    heartbeat_interval_ms: config.heartbeatIntervalMs,
    reconnect_delay_ms: config.reconnectDelayMs,
    auto_start: config.autoStart,
    start_on_login: config.startOnLogin,
    tray_enabled: config.trayEnabled,
  },
  tunnels: config.tunnels.map((tunnel) => ({
    name: tunnel.name,
    local_addr: tunnel.localAddr,
    local_port: tunnel.localPort,
    remote_port: tunnel.remotePort,
    protocol: tunnel.protocol,
  })),
});

const checkTcp = (host: string, port: number, timeoutMs = 1500): Promise<SocketCheckResult> =>
  new Promise((resolve) => {
    const start = Date.now();
    const socket = net.createConnection({ host, port });
    let settled = false;

    const finalize = (ok: boolean, error?: string): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, error, latencyMs: Date.now() - start });
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      socket.end();
      finalize(true);
    });
    socket.on('timeout', () => finalize(false, 'timeout'));
    socket.on('error', (err) => finalize(false, err.message));
  });

const probeTcpResponse = (
  host: string,
  port: number,
  timeoutMs = 2000,
): Promise<ProbeResult> =>
  new Promise((resolve) => {
    const start = Date.now();
    const socket = net.createConnection({ host, port });
    let settled = false;
    let bytes = 0;

    const finalize = (ok: boolean, error?: string): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve({
        ok,
        error,
        bytes: ok ? bytes : undefined,
        latencyMs: Date.now() - start,
      });
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      const payload = [
        `GET /__netcrosses_probe?ts=${Date.now()} HTTP/1.1`,
        `Host: ${host}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n');
      socket.write(payload);
    });
    socket.on('data', (chunk) => {
      bytes += chunk.length;
      finalize(true);
    });
    socket.on('timeout', () => finalize(false, 'timeout_no_response'));
    socket.on('error', (err) => finalize(false, err.message));
    socket.on('end', () => {
      if (!settled) {
        finalize(false, 'no_response');
      }
    });
  });

const runQuickTest = async (config: ClientConfig): Promise<TunnelTestResult[]> => {
  const results: TunnelTestResult[] = [];

  for (const tunnel of config.tunnels) {
    const local = await checkTcp(tunnel.localAddr, tunnel.localPort);
    const remote = await checkTcp(config.serverAddr, tunnel.remotePort);

    results.push({
      name: tunnel.name,
      localAddr: tunnel.localAddr,
      localPort: tunnel.localPort,
      remotePort: tunnel.remotePort,
      local,
      remote,
    });
  }

  return results;
};

const runDeepTest = async (config: ClientConfig): Promise<TunnelDeepResult[]> => {
  const results: TunnelDeepResult[] = [];

  for (const tunnel of config.tunnels) {
    const local = await checkTcp(tunnel.localAddr, tunnel.localPort);
    const remote = await checkTcp(config.serverAddr, tunnel.remotePort);
    const probe = remote.ok
      ? await probeTcpResponse(config.serverAddr, tunnel.remotePort)
      : { ok: false, latencyMs: 0, error: 'remote_unreachable' };

    results.push({
      name: tunnel.name,
      localAddr: tunnel.localAddr,
      localPort: tunnel.localPort,
      remotePort: tunnel.remotePort,
      local,
      remote,
      probe,
    });
  }

  return results;
};

const showWindow = (): void => {
  if (!mainWindow) {
    mainWindow = createWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
};

const toggleWindow = (): void => {
  if (!mainWindow) {
    showWindow();
    return;
  }
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    showWindow();
  }
};

const updateTrayMenu = (status: { state: string } | null): void => {
  if (!tray) {
    return;
  }
  const state = status?.state ?? 'idle';
  const label = formatStatusLabel(state);
  const menu = Menu.buildFromTemplate([
    { label: '显示窗口', click: () => showWindow() },
    { label: '隐藏窗口', click: () => mainWindow?.hide(), enabled: Boolean(mainWindow) },
    { type: 'separator' },
    { label: `状态：${label}`, enabled: false },
    {
      label: '启动隧道',
      click: () => startClientWithConfig(),
      enabled: state === 'idle' || state === 'stopped' || state === 'error',
    },
    {
      label: '停止隧道',
      click: () => tunnelClient?.stop(),
      enabled: state === 'connected' || state === 'connecting' || state === 'reconnecting',
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip(`NetCrosses · ${label}`);
};

const applyTraySetting = (enabled: boolean): void => {
  trayEnabled = enabled;
  if (!enabled && tray) {
    tray.destroy();
    tray = null;
    return;
  }

  if (enabled && !tray) {
    tray = new Tray(createTrayImage());
    tray.on('click', () => toggleWindow());
  }
  updateTrayMenu(tunnelClient?.getStatus() ?? null);
};

const applyLoginSetting = (enabled: boolean): void => {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled });
  } catch (error) {
    console.warn('设置开机自启失败', error);
  }
};

const maybeAutoStart = (config: ClientConfig): void => {
  if (!tunnelClient || !config.autoStart) {
    return;
  }
  if (!config.token.trim()) {
    return;
  }
  const status = tunnelClient.getStatus();
  if (status.state === 'connected' || status.state === 'connecting' || status.state === 'reconnecting') {
    return;
  }
  tunnelClient.start();
};

const startClientWithConfig = (): { state: string; lastError?: string } => {
  if (!tunnelClient) {
    return { state: 'error', lastError: 'client_missing' };
  }
  const config = loadConfig();
  tunnelClient.updateConfig(config);
  if (!config.token.trim()) {
    return { state: 'error', lastError: 'token_missing' };
  }
  tunnelClient.start();
  return tunnelClient.getStatus();
};

const createWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const rendererPath = path.join(app.getAppPath(), 'src', 'renderer', 'index.html');
  void window.loadFile(rendererPath);

  window.on('close', (event) => {
    if (!isQuitting && trayEnabled) {
      event.preventDefault();
      window.hide();
    }
  });

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  return window;
};

app.whenReady().then(() => {
  app.on('before-quit', () => {
    isQuitting = true;
  });

  mainWindow = createWindow();

  const config = loadConfig();
  tunnelClient = new TunnelClient(config);
  applyTraySetting(config.trayEnabled);
  applyLoginSetting(config.startOnLogin);
  maybeAutoStart(config);

  const sendToWindow = (channel: string, payload: unknown): void => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.webContents.send(channel, payload);
  };

  tunnelClient.on('log', (entry) => sendToWindow('client:log', entry));
  tunnelClient.on('status', (status) => {
    sendToWindow('client:status', status);
    updateTrayMenu(status);
  });

  ipcMain.handle('config:get', () => loadConfig());
  ipcMain.handle('config:save', (_event, payload) => {
    const nextConfig = saveConfig(payload);
    tunnelClient?.updateConfig(nextConfig);
    applyTraySetting(nextConfig.trayEnabled);
    applyLoginSetting(nextConfig.startOnLogin);
    maybeAutoStart(nextConfig);
    return nextConfig;
  });
  ipcMain.handle('config:importToml', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入 TOML',
      properties: ['openFile'],
      filters: [{ name: 'TOML 文件', extensions: ['toml'] }],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, cancelled: true };
    }

    const filePath = result.filePaths[0];
    let parsed: Record<string, unknown>;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      parsed = parseToml(raw) as Record<string, unknown>;
    } catch (error) {
      return {
        ok: false,
        error: '解析失败',
        message: 'TOML 解析失败',
        detail: (error as Error).message,
      };
    }

    const nextConfig = saveConfig(parsed);
    tunnelClient?.updateConfig(nextConfig);
    applyTraySetting(nextConfig.trayEnabled);
    applyLoginSetting(nextConfig.startOnLogin);
    maybeAutoStart(nextConfig);
    return { ok: true, path: filePath, config: nextConfig };
  });
  ipcMain.handle('config:exportToml', async () => {
    const result = await dialog.showSaveDialog({
      title: '导出 TOML',
      defaultPath: 'netcrosses-client.toml',
      filters: [{ name: 'TOML 文件', extensions: ['toml'] }],
    });

    if (result.canceled || !result.filePath) {
      return { ok: false, cancelled: true };
    }

    const currentConfig = loadConfig();
    const payload = buildTomlPayload(currentConfig);
    try {
      const tomlText = stringifyToml(payload);
      fs.writeFileSync(result.filePath, tomlText, 'utf8');
      return { ok: true, path: result.filePath };
    } catch (error) {
      return {
        ok: false,
        error: '写入失败',
        message: 'TOML 写入失败',
        detail: (error as Error).message,
      };
    }
  });
  ipcMain.handle('client:start', () => {
    return startClientWithConfig();
  });
  ipcMain.handle('client:stop', () => {
    tunnelClient?.stop();
    return tunnelClient?.getStatus() ?? { state: 'stopped' };
  });
  ipcMain.handle('client:status', () => tunnelClient?.getStatus() ?? { state: 'idle' });
  ipcMain.handle('client:logs', () => tunnelClient?.getLogs() ?? []);
  ipcMain.handle('client:quickTest', async () => {
    const config = loadConfig();
    const status = tunnelClient?.getStatus() ?? { state: 'idle' };
    const results = await runQuickTest(config);
    return { ok: true, status, results };
  });
  ipcMain.handle('client:deepTest', async () => {
    const config = loadConfig();
    const status = tunnelClient?.getStatus() ?? { state: 'idle' };
    const results = await runDeepTest(config);
    return { ok: true, status, results };
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
