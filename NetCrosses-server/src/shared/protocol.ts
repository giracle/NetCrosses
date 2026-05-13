export interface TunnelDefinition {
  name: string;
  localAddr: string;
  localPort: number;
  remotePort: number;
  protocol?: string;
}

export interface HelloMessage {
  type: 'hello';
  token: string;
  clientId?: string;
}

export interface HelloAckMessage {
  type: 'hello_ack';
  ok: boolean;
  sessionId?: string;
  message?: string;
}

export interface RegisterMessage {
  type: 'register';
  tunnels: TunnelDefinition[];
}

export interface RegisterAckMessage {
  type: 'register_ack';
  accepted: number[];
  rejected: { port: number; reason: string }[];
}

export interface HeartbeatMessage {
  type: 'heartbeat';
  ts: number;
}

export interface StartProxyMessage {
  type: 'start_proxy';
  connId: string;
  remotePort: number;
}

export interface ProxyMessage {
  type: 'proxy';
  connId: string;
  token: string;
}

export interface ProxyErrorMessage {
  type: 'proxy_error';
  connId: string;
  message: string;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type ClientMessage =
  | HelloMessage
  | RegisterMessage
  | HeartbeatMessage
  | ProxyMessage
  | ProxyErrorMessage;

export type ServerMessage =
  | HelloAckMessage
  | RegisterAckMessage
  | StartProxyMessage
  | ErrorMessage;
