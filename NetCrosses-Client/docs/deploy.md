# Deployment Guide

## Overview
The current deployment target is a single Linux VPS with a public IP. The server
code lives in a separate repository and is deployed under `/opt/netcrosses-server`.
It accepts control connections on port 7001 and forwards traffic from a fixed TCP
port range (10000-10099) to clients.

## Ports
- Control: `7001/tcp`
- Tunnel ports: `10000-10099/tcp`
- SSH: `22/tcp` (administration)

## Server Setup
Runtime requirements:
- Node.js 20+ at `/root/.nvm/versions/node/v20.19.6/bin/node`

Deployment paths (server repo):
- Repo root: `/opt/netcrosses-server`
- Entrypoint: `/opt/netcrosses-server/dist/server/index.js`
- Config: `/opt/netcrosses-server/config/server.example.toml`
- Logs: `journalctl -u netcrosses-server`

If you want to run as a dedicated user, adjust the repo path and systemd user.

## Configuration Templates
`/etc/netcrosses/server.toml`:
```toml
[server]
bind_addr = "0.0.0.0"
bind_port = 7001
token = "YOUR_64_HEX_TOKEN"
tunnel_port_min = 10000
tunnel_port_max = 10099
log_level = "info"
```

Client `client.toml`:
```toml
[client]
server_addr = "云服务器IP地址"
server_port = 7001
token = "YOUR_64_HEX_TOKEN"

[[tunnels]]
name = "svc-ssh-10001"
local_addr = "127.0.0.1"
local_port = 22
remote_port = 10001
protocol = "tcp"
```

Token generation:
```bash
openssl rand -hex 32
```

## systemd Service
`/etc/systemd/system/netcrosses-server.service`:
```ini
[Unit]
Description=NetCrosses Server
After=network.target

[Service]
WorkingDirectory=/opt/netcrosses-server
ExecStart=/root/.nvm/versions/node/v20.19.6/bin/node /opt/netcrosses-server/dist/server/index.js --config /opt/netcrosses-server/config/server.example.toml
Restart=always
RestartSec=3
LimitNOFILE=65535
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Reload and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now netcrosses-server
```

## Firewall (UFW)
```bash
sudo ufw allow 22/tcp
sudo ufw allow 7001/tcp
sudo ufw allow 10000:10099/tcp
sudo ufw enable
sudo ufw status numbered
```

## Operational Notes
- Keep the token secret and rotate it periodically.
- Keep tunnel counts low relative to bandwidth; 3 Mbps is best for light traffic.
- Record port usage in a shared document to avoid collisions.
