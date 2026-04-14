import { createClient, type Client } from '@libsql/client';

let client: Client | null = null;

function getTurso(): Client {
  if (!client) {
    // Astro/Vite populates import.meta.env at build time. Under plain tsx
    // (Phase 1 migration scripts, unit tests) that object is undefined, so
    // fall back to process.env. Vite wins when present.
    const viteEnv = (import.meta as any).env as Record<string, string | undefined> | undefined;
    const envSource: Record<string, string | undefined> = viteEnv ?? process.env;
    const url = (envSource.TURSO_DATABASE_URL || '').trim();
    const authToken = (envSource.TURSO_AUTH_TOKEN || '').replace(/\s+/g, '');
    if (!url) {
      throw new Error('TURSO_DATABASE_URL is not set');
    }
    client = createClient(authToken ? { url, authToken } : { url });
  }
  return client;
}

export default new Proxy({} as Client, {
  get(_target, prop) {
    const turso = getTurso();
    const value = (turso as any)[prop];
    return typeof value === 'function' ? value.bind(turso) : value;
  },
});
