;(() => {
  if (window.__netcrossesRendererLoaded) {
    console.warn('渲染脚本已加载，跳过重复初始化。');
    return;
  }
  window.__netcrossesRendererLoaded = true;

  const api = window.netcrosses;
  const appMeta = window.appMeta || {};

  const state = {
    logs: [],
    status: { state: 'idle' },
    currentPage: 'connection',
    theme: localStorage.getItem('netcrosses-theme') || 'dark',
  };

  const elements = {
    serverAddr: document.querySelector('#serverAddr'),
    serverPort: document.querySelector('#serverPort'),
    token: document.querySelector('#token'),
    clientName: document.querySelector('#clientName'),
    heartbeatInterval: document.querySelector('#heartbeatInterval'),
    reconnectDelay: document.querySelector('#reconnectDelay'),
    autoStart: document.querySelector('#autoStart'),
    startOnLogin: document.querySelector('#startOnLogin'),
    trayEnabled: document.querySelector('#trayEnabled'),
    saveBtn: document.querySelector('#saveBtn'),
    startBtn: document.querySelector('#startBtn'),
    stopBtn: document.querySelector('#stopBtn'),
    quickTestBtn: document.querySelector('#quickTestBtn'),
    deepTestBtn: document.querySelector('#deepTestBtn'),
    importTomlBtn: document.querySelector('#importTomlBtn'),
    exportTomlBtn: document.querySelector('#exportTomlBtn'),
    addTunnelBtn: document.querySelector('#addTunnelBtn'),
    addTunnelCardBtn: document.querySelector('#addTunnelCardBtn'),
    tunnelsGrid: document.querySelector('#tunnelsGrid'),
    logsList: document.querySelector('#logsList'),
    clearLogsBtn: document.querySelector('#clearLogsBtn'),
    statusDot: document.querySelector('#sidebarDot'),
    statusText: document.querySelector('#statusText'),
    statusHint: document.querySelector('#statusHint'),
    sidebarStatus: document.querySelector('#sidebarStatus'),
    statusIcon: document.querySelector('#statusIcon'),
    statusBanner: document.querySelector('#statusBanner'),
    statusMeta: document.querySelector('#statusMeta'),
    statusUptime: document.querySelector('#statusUptime'),
    statusLatency: document.querySelector('#statusLatency'),
    validationSummary: document.querySelector('#validationSummary'),
    platformLabel: document.querySelector('#platformLabel'),
    fwControlPort: document.querySelector('#fwControlPort'),
    fwRangeStart: document.querySelector('#fwRangeStart'),
    fwRangeEnd: document.querySelector('#fwRangeEnd'),
    fwExtraPorts: document.querySelector('#fwExtraPorts'),
    fwOutput: document.querySelector('#fwOutput'),
    themeToggle: document.querySelector('#themeToggle'),
    pageTitle: document.querySelector('#pageTitle'),
    navItems: document.querySelectorAll('.nav-item'),
    pageCards: document.querySelectorAll('.card[data-page]'),
  };

  const pageTitles = {
    connection: '连接设置',
    tunnels: '隧道映射',
    firewall: '防火墙助手',
    logs: '实时日志',
  };

  const statusTextMap = {
    idle: { label: '空闲', hint: '等待操作。', icon: '&#9679;' },
    connecting: { label: '连接中', hint: '正在建立控制通道。', icon: '&#8635;' },
    connected: { label: '已连接', hint: '隧道已就绪。', icon: '&#10003;' },
    reconnecting: { label: '重连中', hint: '正在尝试重新连接。', icon: '&#8635;' },
    stopped: { label: '已停止', hint: '客户端已离线。', icon: '&#9632;' },
    error: { label: '异常', hint: '请检查令牌或网络。', icon: '&#9888;' },
  };

  const errorTextMap = {
    token_missing: '令牌为空',
    invalid_token: '令牌无效',
    invalid_handshake: '握手失败',
    session_missing: '会话丢失',
    handshake_rejected: '握手被拒绝',
    ipc_unavailable: 'IPC 不可用',
    client_missing: '客户端未初始化',
  };

  const REMOTE_PORT_MIN = 10000;
  const REMOTE_PORT_MAX = 10099;
  const FIREWALL_DEFAULT_RANGE = { start: REMOTE_PORT_MIN, end: REMOTE_PORT_MAX };

  const toNumber = (value, fallback) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  };

  const toPort = (value, fallback = 0) => {
    const num = toNumber(value, fallback);
    if (!Number.isFinite(num)) return fallback;
    const port = Math.trunc(num);
    if (port < 1 || port > 65535) return fallback;
    return port;
  };

  const parsePortList = (value) => {
    if (!value) return [];
    return String(value)
      .split(/[,，\s]+/)
      .map((item) => toPort(item, 0))
      .filter((item) => item > 0);
  };

  const getPlatformLabel = (platform) => {
    switch (platform) {
      case 'win32':
        return 'Windows';
      case 'darwin':
        return 'macOS';
      case 'linux':
        return 'Linux';
      default:
        return '未知';
    }
  };

  const formatError = (value) => {
    if (!value) return '';
    return errorTextMap[value] ?? '未知错误';
  };

  const formatState = (state) => {
    if (!state) return '';
    return statusTextMap[state]?.label ?? state;
  };

  const mapErrorText = (value) => {
    if (!value) return '';
    const text = String(value);
    const lower = text.toLowerCase();

    if (lower.includes('timeout_no_response')) return '超时无响应';
    if (lower.includes('timeout')) return '超时';
    if (lower.includes('no_response')) return '无响应';
    if (lower.includes('no response')) return '无响应';
    if (lower.includes('remote_unreachable')) return '公网不可达';
    if (lower.includes('socket hang up')) return '连接被中断';
    if (text.includes('ECONNREFUSED')) return '连接被拒绝';
    if (text.includes('ENOTFOUND')) return '地址不可达';
    if (text.includes('EHOSTUNREACH')) return '主机不可达';
    if (text.includes('ECONNRESET')) return '连接被重置';
    if (text.includes('ENETUNREACH')) return '网络不可达';
    if (text.includes('EADDRINUSE')) return '端口已被占用';
    if (text.includes('EACCES')) return '权限不足';
    if (text.includes('EPIPE')) return '连接已断开';
    if (text.includes('EAI_AGAIN')) return '域名解析失败';
    return text;
  };

  const containsChinese = (value) => /[\u4e00-\u9fff]/.test(value);

  const formatErrorMessage = (value) => {
    const mapped = mapErrorText(value);
    if (!mapped) return '错误';
    if (mapped === String(value) && !containsChinese(mapped)) {
      return '未知错误';
    }
    return mapped;
  };

  const buildFirewallCommands = (payload) => {
    const { platform, controlPort, rangeStart, rangeEnd, extraPorts } = payload;
    if (!controlPort || !rangeStart || !rangeEnd) {
      return '请输入完整端口信息。';
    }

    const rangeMin = Math.min(rangeStart, rangeEnd);
    const rangeMax = Math.max(rangeStart, rangeEnd);
    const extras = [...new Set(extraPorts.filter((port) => port >= 1 && port <= 65535))];

    if (platform === 'win32') {
      const lines = [
        '# 需要管理员 PowerShell',
        `New-NetFirewallRule -DisplayName "NetCrosses 控制端口" -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${controlPort}`,
        `New-NetFirewallRule -DisplayName "NetCrosses 映射端口" -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${rangeMin}-${rangeMax}`,
      ];
      if (extras.length > 0) {
        lines.push(
          `New-NetFirewallRule -DisplayName "NetCrosses 额外端口" -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${extras.join(
            ',',
          )}`,
        );
      }
      return lines.join('\n');
    }

    if (platform === 'darwin') {
      const portItems = [`${controlPort}`, `${rangeMin}:${rangeMax}`].concat(
        extras.map((port) => `${port}`),
      );
      return [
        '# 推荐：系统设置 -> 网络 -> 防火墙 -> 允许传入',
        '# 高级（pf 端口规则，需管理员权限）',
        'sudo sh -c \'cat > /etc/pf.anchors/netcrosses <<: "EOF"',
        `pass in proto tcp from any to any port {${portItems.join(',')}}`,
        'EOF\'',
        'sudo sh -c \'grep -q "anchor \\"netcrosses\\"" /etc/pf.conf || printf "\\nanchor \\"netcrosses\\"\\nload anchor \\"netcrosses\\" from \\"/etc/pf.anchors/netcrosses\\"\\n" >> /etc/pf.conf\'',
        'sudo pfctl -f /etc/pf.conf',
        'sudo pfctl -e',
      ].join('\n');
    }

    const extraUfw = extras.map((port) => `sudo ufw allow ${port}/tcp`);
    const extraFirewalld = extras.map((port) => `sudo firewall-cmd --permanent --add-port=${port}/tcp`);
    return [
      '# 适用于 Ubuntu (ufw)',
      `sudo ufw allow ${controlPort}/tcp`,
      `sudo ufw allow ${rangeMin}:${rangeMax}/tcp`,
      ...extraUfw,
      'sudo ufw reload',
      '',
      '# 适用于 firewalld',
      `sudo firewall-cmd --permanent --add-port=${controlPort}/tcp`,
      `sudo firewall-cmd --permanent --add-port=${rangeMin}-${rangeMax}/tcp`,
      ...extraFirewalld,
      'sudo firewall-cmd --reload',
    ].join('\n');
  };

  const updateFirewallOutput = () => {
    if (!elements.fwOutput) return;
    const platform = appMeta.platform || 'unknown';
    const controlPort = toPort(elements.fwControlPort?.value, 0);
    const rangeStart = toPort(elements.fwRangeStart?.value, 0);
    const rangeEnd = toPort(elements.fwRangeEnd?.value, 0);
    const extraPorts = parsePortList(elements.fwExtraPorts?.value || '');

    elements.fwOutput.textContent = buildFirewallCommands({
      platform,
      controlPort,
      rangeStart,
      rangeEnd,
      extraPorts,
    });
  };

  const updateStatus = (status) => {
    state.status = status;
    const mapping = statusTextMap[status.state] ?? statusTextMap.idle;

    if (elements.statusText) elements.statusText.textContent = mapping.label;
    if (elements.sidebarStatus) elements.sidebarStatus.textContent = mapping.label;
    if (elements.statusHint) {
      elements.statusHint.textContent = status.lastError
        ? `${mapping.hint}（${formatError(status.lastError)}）`
        : mapping.hint;
    }

    if (elements.statusIcon) {
      elements.statusIcon.innerHTML = mapping.icon;
      elements.statusIcon.className = `status-icon ${status.state}`;
    }

    if (elements.statusDot) {
      elements.statusDot.className = `dot ${status.state}`;
    }

    if (elements.statusMeta) {
      elements.statusMeta.style.display = status.state === 'connected' ? 'block' : 'none';
    }

    if (status.state === 'connected') {
      if (elements.startBtn) elements.startBtn.style.display = 'none';
      if (elements.stopBtn) elements.stopBtn.style.display = 'inline-flex';
    } else if (status.state === 'idle' || status.state === 'stopped' || status.state === 'error') {
      if (elements.startBtn) elements.startBtn.style.display = 'inline-flex';
      if (elements.stopBtn) elements.stopBtn.style.display = 'none';
    }
  };

  const formatTime = (iso) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleTimeString('zh-CN', { hour12: false });
  };

  const appendLog = (entry) => {
    if (!elements.logsList || !entry) return;
    const line = document.createElement('div');
    line.className = 'log-entry';

    const levelMap = {
      info: 'INFO',
      warn: 'WARN',
      error: 'ERROR',
      debug: 'DEBUG',
    };

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatTime(entry.time);

    const level = document.createElement('span');
    level.className = `level ${entry.level || 'info'}`;
    level.textContent = levelMap[entry.level] ?? levelMap.info;

    const message = document.createElement('span');
    message.className = 'message';
    message.textContent = entry.meta
      ? `${entry.message} ${JSON.stringify(entry.meta)}`
      : entry.message;

    line.append(time, level, message);
    elements.logsList.appendChild(line);
    elements.logsList.scrollTop = elements.logsList.scrollHeight;
  };

  const renderLogs = (logs) => {
    if (!elements.logsList) return;
    elements.logsList.innerHTML = '';
    logs.forEach((entry) => appendLog(entry));
  };

  const setSummary = (message, isSuccess = false) => {
    if (!elements.validationSummary) return;
    elements.validationSummary.textContent = message ?? '';
    elements.validationSummary.classList.toggle('success', Boolean(isSuccess));
  };

  const resetValidation = () => {
    document.querySelectorAll('.input-error').forEach((input) => {
      input.classList.remove('input-error');
      input.removeAttribute('aria-invalid');
      input.removeAttribute('title');
    });
    setSummary('');
  };

  const markInvalid = (input, message, errors) => {
    if (!input) return;
    input.classList.add('input-error');
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('title', message);
    errors.push(message);
  };

  const createTunnelCard = (tunnel = {}) => {
    const card = document.createElement('div');
    card.className = 'tunnel-card';
    card.dataset.remotePort = tunnel.remotePort ?? '';

    const isActive = tunnel.remotePort && tunnel.localPort;

    card.innerHTML = `
      <div class="tunnel-card-header">
        <span class="name">${tunnel.name || '映射-新建'}</span>
        <span class="badge ${isActive ? 'badge-success' : 'badge-idle'}">${isActive ? '运行中' : '未启用'}</span>
      </div>
      <div class="tunnel-card-body">
        <div class="tunnel-field">
          <span class="label">本地地址</span>
          <span class="value">${tunnel.localAddr || '127.0.0.1'}:${tunnel.localPort || '-'}</span>
        </div>
        <div class="tunnel-field">
          <span class="label">公网端口</span>
          <span class="value">${tunnel.remotePort || '-'}</span>
        </div>
      </div>
      <div class="tunnel-card-actions">
        <button class="btn-edit">编辑</button>
        <button class="btn-delete">删除</button>
      </div>
    `;

    const editBtn = card.querySelector('.btn-edit');
    const deleteBtn = card.querySelector('.btn-delete');

    deleteBtn.addEventListener('click', () => card.remove());

    editBtn.addEventListener('click', () => {
      const name = prompt('名称:', tunnel.name || '映射-新建');
      if (name === null) return;
      const localAddr = prompt('本地地址:', tunnel.localAddr || '127.0.0.1');
      if (localAddr === null) return;
      const localPort = prompt('本地端口:', tunnel.localPort || '22');
      if (localPort === null) return;
      const remotePort = prompt('公网端口:', tunnel.remotePort || '10001');
      if (remotePort === null) return;

      tunnel.name = name || '映射-新建';
      tunnel.localAddr = localAddr || '127.0.0.1';
      tunnel.localPort = toPort(localPort, 22);
      tunnel.remotePort = toPort(remotePort, 10001);

      const newCard = createTunnelCard(tunnel);
      card.replaceWith(newCard);
    });

    return card;
  };

  const suggestRemotePort = () => {
    if (!elements.tunnelsGrid) return 10001;
    const cards = elements.tunnelsGrid.querySelectorAll('.tunnel-card');
    const ports = [...cards].map((card) => toNumber(card.dataset.remotePort, 0));
    const maxPort = ports.length > 0 ? Math.max(...ports) : 10000;
    const next = maxPort + 1;
    return next <= 10099 ? next : 10000;
  };

  const collectTunnelCards = () => {
    if (!elements.tunnelsGrid) return [];
    const cards = elements.tunnelsGrid.querySelectorAll('.tunnel-card');
    return [...cards].map((card) => {
      const name = card.querySelector('.name')?.textContent?.trim() ?? '';
      const valueEl = card.querySelector('.tunnel-field .value');
      const localText = valueEl?.textContent?.trim() ?? '';
      const [localAddr, localPortStr] = localText.split(':');
      const remotePort = toNumber(card.dataset.remotePort, 0);

      return {
        card,
        name,
        localAddr: localAddr || '127.0.0.1',
        localPort: toPort(localPortStr, 0),
        remotePort,
      };
    });
  };

  const validateConfig = (config) => {
    const errors = [];
    resetValidation();

    if (!config.serverAddr) {
      markInvalid(elements.serverAddr, '请输入服务器 IP。', errors);
    }

    if (!config.serverPort || config.serverPort < 1 || config.serverPort > 65535) {
      markInvalid(elements.serverPort, '服务器端口应在 1-65535。', errors);
    }

    if (!config.token) {
      markInvalid(elements.token, '令牌不能为空。', errors);
    }

    const rows = collectTunnelCards();
    if (rows.length === 0) {
      errors.push('至少需要一条映射。');
    }

    rows.forEach((row, index) => {
      if (!row.localPort || row.localPort < 1 || row.localPort > 65535) {
        setSummary(`映射 #${index + 1}：本地端口应在 1-65535。`, false);
        errors.push(`映射 #${index + 1}：本地端口应在 1-65535。`);
      }

      if (
        !row.remotePort ||
        row.remotePort < REMOTE_PORT_MIN ||
        row.remotePort > REMOTE_PORT_MAX
      ) {
        setSummary(`映射 #${index + 1}：公网端口需在 ${REMOTE_PORT_MIN}-${REMOTE_PORT_MAX}。`, false);
        errors.push(`映射 #${index + 1}：公网端口需在 ${REMOTE_PORT_MIN}-${REMOTE_PORT_MAX}。`);
      }
    });

    if (elements.validationSummary) {
      setSummary(errors.join(' '), false);
    }

    return errors.length === 0;
  };

  const renderConfig = (config) => {
    if (!config) return;
    elements.serverAddr.value = config.serverAddr ?? '127.0.0.1';
    elements.serverPort.value = config.serverPort ?? 7001;
    elements.token.value = config.token ?? '';
    elements.clientName.value = config.name ?? 'NetCrosses-桌面端';
    elements.heartbeatInterval.value = config.heartbeatIntervalMs ?? 10000;
    elements.reconnectDelay.value = config.reconnectDelayMs ?? 2000;
    if (elements.autoStart) elements.autoStart.checked = Boolean(config.autoStart);
    if (elements.startOnLogin) elements.startOnLogin.checked = Boolean(config.startOnLogin);
    if (elements.trayEnabled) elements.trayEnabled.checked = Boolean(config.trayEnabled);

    if (elements.tunnelsGrid) {
      const addBtn = elements.tunnelsGrid.querySelector('.add-tunnel');
      elements.tunnelsGrid.innerHTML = '';
      (config.tunnels ?? []).forEach((tunnel) => {
        elements.tunnelsGrid.appendChild(createTunnelCard(tunnel));
      });
      if (addBtn) elements.tunnelsGrid.appendChild(addBtn);
    }

    if (elements.fwControlPort) {
      elements.fwControlPort.value = toPort(config.serverPort, 7001);
    }
    if (elements.fwRangeStart && elements.fwRangeEnd) {
      const ports = (config.tunnels ?? [])
        .map((tunnel) => toPort(tunnel.remotePort, 0))
        .filter((port) => port > 0);
      const minPort = ports.length > 0 ? Math.min(...ports) : FIREWALL_DEFAULT_RANGE.start;
      const maxPort = ports.length > 0 ? Math.max(...ports) : FIREWALL_DEFAULT_RANGE.end;
      elements.fwRangeStart.value = minPort;
      elements.fwRangeEnd.value = maxPort;
    }
    if (elements.fwExtraPorts) {
      elements.fwExtraPorts.value = '';
    }

    updateFirewallOutput();
    resetValidation();
  };

  const readConfig = () => {
    const tunnels = collectTunnelCards()
      .map((row) => {
        if (!row.localPort || !row.remotePort) return null;
        return {
          name: row.name || '映射-新建',
          localAddr: row.localAddr || '127.0.0.1',
          localPort: row.localPort,
          remotePort: row.remotePort,
          protocol: 'tcp',
        };
      })
      .filter(Boolean);

    return {
      serverAddr: elements.serverAddr.value.trim(),
      serverPort: toNumber(elements.serverPort.value, 7001),
      token: elements.token.value.trim(),
      name: elements.clientName.value.trim() || 'NetCrosses-桌面端',
      heartbeatIntervalMs: toNumber(elements.heartbeatInterval.value, 10000),
      reconnectDelayMs: toNumber(elements.reconnectDelay.value, 2000),
      autoStart: Boolean(elements.autoStart?.checked),
      startOnLogin: Boolean(elements.startOnLogin?.checked),
      trayEnabled: Boolean(elements.trayEnabled?.checked),
      tunnels,
    };
  };

  // ===== Theme Toggle =====
  const applyTheme = (theme) => {
    state.theme = theme;
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
      if (elements.themeToggle) elements.themeToggle.innerHTML = '&#9790;';
    } else {
      document.documentElement.removeAttribute('data-theme');
      if (elements.themeToggle) elements.themeToggle.innerHTML = '&#9788;';
    }
    localStorage.setItem('netcrosses-theme', theme);
  };

  const toggleTheme = () => {
    const next = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  };

  // ===== Navigation =====
  const switchPage = (page) => {
    state.currentPage = page;

    if (elements.pageTitle) {
      elements.pageTitle.textContent = pageTitles[page] || 'NetCrosses';
    }

    elements.navItems.forEach((item) => {
      item.classList.toggle('active', item.dataset.nav === page);
    });

    elements.pageCards.forEach((card) => {
      const cardPage = card.dataset.page;
      if (cardPage === page) {
        card.style.display = 'block';
      } else {
        card.style.display = 'none';
      }
    });

    if (page === 'logs' && elements.logsList) {
      elements.logsList.scrollTop = elements.logsList.scrollHeight;
    }
  };

  const bindActions = () => {
    const platform = appMeta.platform || 'unknown';
    if (elements.platformLabel) {
      elements.platformLabel.textContent = `当前系统：${getPlatformLabel(platform)}`;
    }

    // Theme toggle
    elements.themeToggle?.addEventListener('click', toggleTheme);

    // Navigation
    elements.navItems.forEach((item) => {
      item.addEventListener('click', () => {
        switchPage(item.dataset.nav);
      });
    });

    // Firewall inputs
    ['input', 'change'].forEach((eventName) => {
      [elements.fwControlPort, elements.fwRangeStart, elements.fwRangeEnd, elements.fwExtraPorts].forEach(
        (input) => input?.addEventListener(eventName, () => updateFirewallOutput()),
      );
    });

    elements.saveBtn?.addEventListener('click', async () => {
      if (!api) return;
      const nextConfig = readConfig();
      if (!validateConfig(nextConfig)) {
        return;
      }
      const saved = await api.saveConfig(nextConfig);
      renderConfig(saved);
      appendLog({
        time: new Date().toISOString(),
        level: 'info',
        message: '配置已保存。',
      });
    });

    elements.startBtn?.addEventListener('click', async () => {
      if (!api) return;
      const nextConfig = readConfig();
      if (!validateConfig(nextConfig)) {
        return;
      }
      await api.saveConfig(nextConfig);
      const status = await api.startClient();
      updateStatus(status);
    });

    elements.stopBtn?.addEventListener('click', async () => {
      if (!api) return;
      const status = await api.stopClient();
      updateStatus(status);
    });

    elements.quickTestBtn?.addEventListener('click', async () => {
      if (!api) return;
      const nextConfig = readConfig();
      if (!validateConfig(nextConfig)) {
        return;
      }
      await api.saveConfig(nextConfig);
      appendLog({
        time: new Date().toISOString(),
        level: 'info',
        message: '正在执行快速连通性检测...',
      });

      const result = await api.quickTest();
      if (!result?.ok || !Array.isArray(result.results)) {
        setSummary('快速检测启动失败。', false);
        return;
      }

      if (result.status?.state && result.status.state !== 'connected') {
        appendLog({
          time: new Date().toISOString(),
          level: 'warn',
          message: `控制通道状态为 ${formatState(result.status.state)}，公网检测可能失败。`,
        });
      }

      let failures = 0;
      result.results.forEach((entry) => {
        const localOk = entry.local?.ok;
        const remoteOk = entry.remote?.ok;
        if (!localOk || !remoteOk) failures += 1;

        const formatCheck = (check) =>
          check?.ok ? `正常 (${check.latencyMs}ms)` : `失败 (${formatErrorMessage(check?.error)})`;

        const level = localOk && remoteOk ? 'info' : localOk || remoteOk ? 'warn' : 'error';

        appendLog({
          time: new Date().toISOString(),
          level,
          message: `${entry.name}：本地 ${formatCheck(entry.local)} / 公网 ${formatCheck(
            entry.remote,
          )}`,
          meta: {
            本地: `${entry.localAddr}:${entry.localPort}`,
            公网: `${nextConfig.serverAddr}:${entry.remotePort}`,
          },
        });
      });

      if (failures === 0) {
        setSummary('快速检测通过，所有映射正常。', true);
      } else {
        setSummary(`快速检测发现 ${failures} 条映射异常。`, false);
      }
    });

    elements.deepTestBtn?.addEventListener('click', async () => {
      if (!api) return;
      const nextConfig = readConfig();
      if (!validateConfig(nextConfig)) {
        return;
      }
      await api.saveConfig(nextConfig);
      appendLog({
        time: new Date().toISOString(),
        level: 'info',
        message: '正在执行深度检测（尝试读取响应）...',
      });

      const result = await api.deepTest();
      if (!result?.ok || !Array.isArray(result.results)) {
        setSummary('深度检测启动失败。', false);
        return;
      }

      if (result.status?.state && result.status.state !== 'connected') {
        appendLog({
          time: new Date().toISOString(),
          level: 'warn',
          message: `控制通道状态为 ${formatState(result.status.state)}，响应检测可能失败。`,
        });
      }

      let failures = 0;
      result.results.forEach((entry) => {
        const localOk = entry.local?.ok;
        const remoteOk = entry.remote?.ok;
        const probeOk = entry.probe?.ok;
        if (!localOk || !remoteOk || !probeOk) failures += 1;

        const formatCheck = (check) =>
          check?.ok ? `正常 (${check.latencyMs}ms)` : `失败 (${formatErrorMessage(check?.error)})`;

        const formatProbe = (probe) => {
          if (!probe?.ok) {
            return `无响应 (${formatErrorMessage(probe?.error)})`;
          }
          const bytes = typeof probe.bytes === 'number' ? `${probe.bytes}字节` : '有响应';
          return `有响应 (${probe.latencyMs}ms, ${bytes})`;
        };

        const level =
          localOk && remoteOk && probeOk ? 'info' : localOk && remoteOk ? 'warn' : 'error';

        appendLog({
          time: new Date().toISOString(),
          level,
          message: `${entry.name}：本地 ${formatCheck(entry.local)} / 公网 ${formatCheck(
            entry.remote,
          )} / 响应 ${formatProbe(entry.probe)}`,
          meta: {
            本地: `${entry.localAddr}:${entry.localPort}`,
            公网: `${nextConfig.serverAddr}:${entry.remotePort}`,
          },
        });
      });

      if (failures === 0) {
        setSummary('深度检测通过，所有映射有响应。', true);
      } else {
        setSummary(`深度检测发现 ${failures} 条异常（部分协议可能不返回数据）。`, false);
      }
    });

    const addTunnelHandler = () => {
      if (!elements.tunnelsGrid) return;
      const addBtn = elements.tunnelsGrid.querySelector('.add-tunnel');
      const card = createTunnelCard({ remotePort: suggestRemotePort() });
      if (addBtn) {
        elements.tunnelsGrid.insertBefore(card, addBtn);
      } else {
        elements.tunnelsGrid.appendChild(card);
      }
    };

    elements.addTunnelBtn?.addEventListener('click', addTunnelHandler);
    elements.addTunnelCardBtn?.addEventListener('click', addTunnelHandler);

    elements.importTomlBtn?.addEventListener('click', async () => {
      if (!api) return;
      const result = await api.importToml();
      if (result?.ok && result.config) {
        renderConfig(result.config);
        appendLog({
          time: new Date().toISOString(),
          level: 'info',
          message: `已导入 TOML：${result.path ?? '文件'}`,
        });
      } else if (result?.error) {
        setSummary(`导入失败：${result.message ?? result.error}`, false);
      }
    });

    elements.exportTomlBtn?.addEventListener('click', async () => {
      if (!api) return;
      const result = await api.exportToml();
      if (result?.ok) {
        appendLog({
          time: new Date().toISOString(),
          level: 'info',
          message: `已导出 TOML：${result.path ?? '文件'}`,
        });
      } else if (result?.error) {
        setSummary(`导出失败：${result.message ?? result.error}`, false);
      }
    });

    elements.clearLogsBtn?.addEventListener('click', () => {
      if (!elements.logsList) return;
      elements.logsList.innerHTML = '';
    });
  };

  const init = async () => {
    applyTheme(state.theme);
    switchPage('connection');

    if (!api) {
      updateStatus({ state: 'error', lastError: 'ipc_unavailable' });
      return;
    }

    const config = await api.getConfig();
    renderConfig(config);

    const logs = await api.getLogs();
    renderLogs(logs);

    const status = await api.getStatus();
    updateStatus(status);

    api.onLog((entry) => appendLog(entry));
    api.onStatus((nextStatus) => updateStatus(nextStatus));
  };

  bindActions();
  init();
})();
