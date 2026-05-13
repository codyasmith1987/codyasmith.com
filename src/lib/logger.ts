// Request-correlated logging using AsyncLocalStorage
// Each request gets a unique ID that flows through all log entries
// without bleeding across concurrent requests

import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage<string>();

// Deprecated. Kept exported so any older call site does not crash; logs
// from outside an ALS scope are now unprefixed rather than picking up a
// shared fallback that cross-correlates concurrent requests. See
// security-audit-2026-05-12 round 4 SEC4-004.
export function setRequestId(_id: string) {
  // intentionally a no-op.
}

export function runWithRequestId<T>(id: string, fn: () => T): T {
  return als.run(id, fn);
}

function prefix(): string {
  const id = als.getStore();
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
