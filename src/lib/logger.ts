// Request-correlated logging
// Each request gets a unique ID that flows through all log entries

let currentRequestId = '';

export function setRequestId(id: string) {
  currentRequestId = id;
}

function prefix(): string {
  return currentRequestId ? `[${currentRequestId}]` : '';
}

export const logger = {
  info(msg: string, data?: Record<string, unknown>) {
    console.log(`${prefix()} ${msg}`, data ? JSON.stringify(data) : '');
  },
  warn(msg: string, data?: Record<string, unknown>) {
    console.warn(`${prefix()} ${msg}`, data ? JSON.stringify(data) : '');
  },
  error(msg: string, err?: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err || '');
    const stack = err instanceof Error ? err.stack : undefined;
    console.error(`${prefix()} ${msg}`, errMsg, stack || '');
  },
};
