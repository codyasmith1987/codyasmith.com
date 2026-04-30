// RDAP availability lookups against IANA's bootstrap registry.
// Concurrency in chunks, throttled to a target rate per second across the run.
// 200 = registered, 404 = available, anything else = unknown (do not mark available).

import { DEFAULTS } from './config';
import type { AvailabilityResult } from './types';

type FetchLike = typeof fetch;

interface RdapBootstrapResponse {
  services: Array<[string[], string[]]>;
}

export interface AvailabilityDeps {
  fetch?: FetchLike;
  bootstrap?: Record<string, string>;
}

let bootstrapCache: Record<string, string> | null = null;

export function clearBootstrapCache(): void {
  bootstrapCache = null;
}

async function loadBootstrap(fetchFn: FetchLike): Promise<Record<string, string>> {
  if (bootstrapCache) return bootstrapCache;

  const res = await fetchFn(DEFAULTS.RDAP_BOOTSTRAP_URL);
  if (!res.ok) {
    throw new Error(`RDAP bootstrap fetch failed: ${res.status}`);
  }
  const data = (await res.json()) as RdapBootstrapResponse;
  const map: Record<string, string> = {};
  for (const [tlds, urls] of data.services) {
    if (!urls[0]) continue;
    const baseUrl = urls[0].replace(/\/$/, '');
    for (const tld of tlds) {
      map[tld.toLowerCase()] = baseUrl;
    }
  }
  bootstrapCache = map;
  return map;
}

async function checkOne(
  fetchFn: FetchLike,
  bootstrap: Record<string, string>,
  name: string,
  tld: string,
): Promise<AvailabilityResult> {
  const checkedAt = new Date().toISOString();
  const baseUrl = bootstrap[tld.toLowerCase()];
  if (!baseUrl) {
    return { name, tld, available: null, checkedAt };
  }

  const url = `${baseUrl}/domain/${encodeURIComponent(name.toLowerCase())}.${tld.toLowerCase()}`;

  try {
    const res = await fetchFn(url, {
      headers: { Accept: 'application/rdap+json' },
    });
    if (res.status === 200) return { name, tld, available: false, checkedAt };
    if (res.status === 404) return { name, tld, available: true, checkedAt };
    return { name, tld, available: null, checkedAt };
  } catch {
    return { name, tld, available: null, checkedAt };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function checkAvailability(
  names: string[],
  tlds: string[],
  deps: AvailabilityDeps = {},
): Promise<AvailabilityResult[]> {
  const fetchFn = deps.fetch ?? fetch;
  const bootstrap = deps.bootstrap ?? (await loadBootstrap(fetchFn));

  const tasks: Array<{ name: string; tld: string }> = [];
  for (const name of names) {
    for (const tld of tlds) {
      tasks.push({ name, tld });
    }
  }

  const results: AvailabilityResult[] = [];
  const concurrency = DEFAULTS.RDAP_CONCURRENCY;
  const minIntervalMs = 1000 / DEFAULTS.RDAP_RATE_LIMIT_PER_SECOND;
  let lastDispatchAt = 0;

  for (let i = 0; i < tasks.length; i += concurrency) {
    const chunk = tasks.slice(i, i + concurrency);
    const elapsed = Date.now() - lastDispatchAt;
    if (lastDispatchAt > 0 && elapsed < minIntervalMs) {
      await sleep(minIntervalMs - elapsed);
    }
    lastDispatchAt = Date.now();
    const chunkResults = await Promise.all(
      chunk.map(({ name, tld }) => checkOne(fetchFn, bootstrap, name, tld)),
    );
    results.push(...chunkResults);
  }

  return results;
}
