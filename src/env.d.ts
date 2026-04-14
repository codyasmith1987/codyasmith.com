/// <reference path="../.astro/types.d.ts" />

declare namespace App {
  interface Locals {
    user?: {
      id: string;
      email: string;
      name: string;
      role: 'admin' | 'client';
      client_id: string | null;
      permissions: string | null;
    };
    session?: {
      id: string;
      expires_at: string;
    };
    csrfToken?: string;
    // Slice 13: the set of module keys this request's user is allowed
    // to see. Admins always get the full set. Clients get the union
    // of their active contracts' modules_json, falling back to
    // DEFAULT_MODULES on any failure. Absent for unauthenticated
    // requests. The middleware populates it; Portal.astro reads it
    // to filter nav; route guards enforce the real gate.
    enabledModules?: Set<'dashboard' | 'rankings' | 'health' | 'files' | 'invoices'>;
    // Slice 14a: clients.brand_accent — a hex color like '#f59e0b' —
    // loaded by middleware so layouts can inject it as a CSS custom
    // property without a second DB round-trip. Null when the client
    // has not set one or when the user is admin without a client_id.
    brandAccent?: string | null;
  }
}
