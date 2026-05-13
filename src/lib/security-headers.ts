// Re-export of security-headers.json as a typed object.
//
// Source of truth lives at /security-headers.json so both src/middleware.ts
// (via this module) and scripts/postbuild-security-headers.mjs (via direct
// JSON read) can consume the same values. Keeping the JSON file at the
// project root means the postbuild script (plain Node ESM) does not need a
// TS loader to read it.
//
// The `_comment` field is stripped on import so callers can iterate every
// header without filtering. See security-audit-2026-05-12 round 4 SEC4-003.

import raw from '../../security-headers.json' with { type: 'json' };

const { _comment, ...rest } = raw as Record<string, string>;

export const SECURITY_HEADERS: Record<string, string> = rest;
