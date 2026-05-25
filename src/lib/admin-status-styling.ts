// Shared status-pill styling for the admin list pages
// (proposals.astro, agreements.astro, contracts.astro).
//
// Each domain has its own status vocabulary (proposals are draft/published/
// finalized; agreements are draft/issued/partially_signed/executed/revoked/
// voided; contracts are draft/sent/active/completed/cancelled). The
// VISUAL token is shared via STATUS_TOKENS so a "success" state looks
// the same across all three lists. Adding a new state means picking
// its semantic token here; the class strings don't need to change.

export const STATUS_TOKENS = {
  inactive:   'bg-neutral-700/30 text-neutral-400',
  pending:    'bg-blue-500/10 text-blue-400',
  inProgress: 'bg-amber-500/10 text-amber-600',
  success:    'bg-emerald-500/10 text-emerald-400',
  warning:    'bg-amber-500/10 text-amber-600',
  danger:     'bg-red-500/10 text-red-400',
} as const;

export type StatusToken = keyof typeof STATUS_TOKENS;

export interface StatusInfo {
  token: StatusToken;
  label: string;
}

// Domain-specific status maps. The key is the raw status value stored
// in the DB; the value carries the semantic token + display label.
export const PROPOSAL_STATUS: Record<string, StatusInfo> = {
  draft:     { token: 'inactive', label: 'Draft' },
  published: { token: 'pending',  label: 'Published' },
  finalized: { token: 'success',  label: 'Finalized' },
};

export const AGREEMENT_STATUS: Record<string, StatusInfo> = {
  draft:            { token: 'inactive',   label: 'Draft' },
  issued:           { token: 'pending',    label: 'Issued' },
  partially_signed: { token: 'inProgress', label: 'Partial' },
  executed:         { token: 'success',    label: 'Executed' },
  revoked:          { token: 'warning',    label: 'Revoked' },
  voided:           { token: 'danger',     label: 'Voided' },
};

export const CONTRACT_STATUS: Record<string, StatusInfo> = {
  draft:     { token: 'inactive',   label: 'Draft' },
  sent:      { token: 'pending',    label: 'Sent' },
  active:    { token: 'success',    label: 'Active' },
  completed: { token: 'inProgress', label: 'Completed' },
  cancelled: { token: 'danger',     label: 'Cancelled' },
};

// Shared pill wrapper class so every admin list renders the badge in
// the same shape. Use with badgeClass(token) to add the color tokens.
export const STATUS_PILL_BASE = 'px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider rounded';

export function badgeClass(token: StatusToken): string {
  return STATUS_TOKENS[token];
}

// Convenience: look up a status info with a draft fallback.
export function lookupStatus(
  map: Record<string, StatusInfo>,
  status: string,
): StatusInfo {
  return map[status] || map.draft || { token: 'inactive', label: status };
}
