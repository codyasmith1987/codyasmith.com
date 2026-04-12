// Request-correlated logging using AsyncLocalStorage
// Each request gets a unique ID that flows through all log entries
// without bleeding across concurrent requests

import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage<string>();

export function setRequestId(id: string) {
  // Legacy setter — still used by middleware for backward compatibility
  // Actual correlation happens via runWithRequestId
  _fallbackId = id;
}

let _fallbackId = '';

export function runWithRequestId<T>(id: string, fn: () => T): T {
  return als.run(id, fn);
}

function prefix(): string {
  const id = als.getStore() || _fallbackId;
  return id ? `[${id}]` : '';
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
