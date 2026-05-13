export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  private levelValue: number;

  constructor(private level: LogLevel = 'info', private scope?: string) {
    this.levelValue = levelOrder[this.level] ?? levelOrder.info;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
    this.levelValue = levelOrder[level] ?? levelOrder.info;
  }

  child(scope: string): Logger {
    return new Logger(this.level, scope);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', message, meta);
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (levelOrder[level] < this.levelValue) {
      return;
    }

    const time = new Date().toISOString();
    const scope = this.scope ? `[${this.scope}] ` : '';
    const metaText = meta ? ` ${JSON.stringify(meta)}` : '';
    console.log(`${time} ${level.toUpperCase()} ${scope}${message}${metaText}`);
  }
}

export const parseLogLevel = (
  value: unknown,
  fallback: LogLevel = 'info',
): LogLevel => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.toLowerCase();
  if (normalized in levelOrder) {
    return normalized as LogLevel;
  }

  return fallback;
};
