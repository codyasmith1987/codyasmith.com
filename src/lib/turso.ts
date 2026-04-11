import { createClient, type Client } from '@libsql/client';

let client: Client | null = null;

function getTurso(): Client {
  if (!client) {
    const url = (import.meta.env.TURSO_DATABASE_URL || '').trim();
    const authToken = (import.meta.env.TURSO_AUTH_TOKEN || '').replace(/\s+/g, '');
    if (!url) {
      throw new Error('TURSO_DATABASE_URL is not set');
    }
    client = createClient({ url, authToken });
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
