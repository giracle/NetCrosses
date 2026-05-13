import type net from 'node:net';

export type LineHandler = (line: string) => void;

export const attachLineParser = (
  socket: net.Socket,
  onLine: LineHandler,
  maxBuffer = 1024 * 1024,
): (() => void) => {
  let buffer = '';

  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString('utf8');

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        onLine(line);
      }
      newlineIndex = buffer.indexOf('\n');
    }

    if (buffer.length > maxBuffer) {
      socket.destroy(new Error('Line buffer exceeded'));
    }
  };

  socket.on('data', onData);

  return (): void => {
    socket.off('data', onData);
  };
};

export const sendJson = (socket: net.Socket, payload: unknown): void => {
  socket.write(`${JSON.stringify(payload)}\n`);
};
