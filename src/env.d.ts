/// <reference path="../.astro/types.d.ts" />

declare namespace App {
  interface Locals {
    user?: {
      id: string;
      email: string;
      name: string;
      role: 'admin' | 'client';
      client_id: string | null;
    };
    session?: {
      id: string;
      expires_at: string;
    };
  }
}
