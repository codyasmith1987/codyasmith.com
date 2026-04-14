// Contracts, projects, milestones, tasks, and task artifacts — CRUD helpers

import { nanoid } from 'nanoid';
import turso from './turso';
import { seedBindingsInTx, type DataSourceInput } from './data-sources';
import {
  updateClientProfile,
  updateClientProfileInTx,
  seedContactsForClient,
  seedContactsInTx,
  type ClientProfileInput,
  type ContactInput,
} from './clients';
import { createClient as createClientRow } from './auth';
import type { PassthroughRule, ReminderRule } from './contract-rules';
import { getMilestoneTemplateForService } from './milestone-templates';

// Lazy import to avoid circular dependency — invoices.ts imports nothing from contracts.ts
// but contracts.ts needs deleteInvoice for cascade deletes.
async function cascadeDeleteContractChildren(contractId: string): Promise<void> {
  const { getInvoicesByContract, deleteInvoice } = await import('./invoices');
  // pending_charges.billed_invoice_id is a FK to invoices.id, so charges
  // must be dropped (or their billed_invoice_id nulled) BEFORE invoices.
  // Otherwise deleting an invoice that has any billed charges fails with
  // "FOREIGN KEY constraint failed".
  await turso.execute({ sql: 'DELETE FROM pending_charges WHERE contract_id = ?', args: [contractId] });
  await turso.execute({ sql: 'DELETE FROM approvals WHERE contract_id = ?', args: [contractId] });
  await turso.execute({ sql: 'DELETE FROM change_orders WHERE contract_id = ?', args: [contractId] });
  const invoices = await getInvoicesByContract(contractId);
  for (const inv of invoices) {
    await deleteInvoice(inv.id);
  }
}

// --- Column allowlists for dynamic UPDATE builders ---
// Runtime guard against SQL column injection. TypeScript types disappear at runtime;
// these allowlists enforce valid column names regardless of caller.

const UPDATABLE_COLUMNS: Record<string, Set<string>> = {
  contracts: new Set(['title', 'description', 'status', 'type', 'total_value', 'start_date', 'end_date', 'signed_at', 'billing_cadence', 'billing_day', 'recurring_amount', 'included_hours', 'overage_rate', 'payment_terms_days', 'service_type', 'modules_json']),
  projects: new Set(['title', 'description', 'status', 'sort_order', 'client_visible']),
  milestones: new Set(['title', 'description', 'status', 'due_date', 'completed_at', 'sort_order', 'client_visible', 'client_update_text']),
  tasks: new Set(['title', 'description', 'status', 'priority', 'assigned_to', 'estimated_hours', 'actual_hours', 'due_date', 'completed_at', 'sort_order', 'client_visible', 'client_update_text']),
};

function buildSafeUpdate(table: string, id: string, data: Record<string, any>): { sql: string; args: any[] } | null {
  const allowed = UPDATABLE_COLUMNS[table];
  if (!allowed) throw new Error(`No allowlist defined for table: ${table}`);
  const fields: string[] = [];
  const args: any[] = [];
  for (const [key, val] of Object.entries(data)) {
    if (val === undefined) continue;
    if (!allowed.has(key)) throw new Error(`Invalid column "${key}" for table "${table}"`);
    fields.push(`${key} = ?`);
    args.push(val);
  }
  if (fields.length === 0) return null;
  fields.push("updated_at = datetime('now')");
  args.push(id);
  return { sql: `UPDATE ${table} SET ${fields.join(', ')} WHERE id = ?`, args };
}

// --- Query helpers (same pattern as db.ts) ---

async function queryOne(sql: string, args: any[] = []): Promise<any | undefined> {
  const result = await turso.execute({ sql, args });
  if (result.rows.length === 0) return undefined;
  return Object.fromEntries(result.columns.map((col, i) => [col, result.rows[0][i]]));
}

async function queryAll(sql: string, args: any[] = []): Promise<any[]> {
  const result = await turso.execute({ sql, args });
  return result.rows.map(row =>
    Object.fromEntries(result.columns.map((col, i) => [col, row[i]]))
  );
}

// ============================================================
// Contracts
// ============================================================

export type ContractStatus = 'draft' | 'sent' | 'active' | 'completed' | 'cancelled';
export type ContractType = 'fixed' | 'retainer' | 'hourly';
export type BillingCadence = 'monthly' | 'milestone' | 'one-time';

export interface Contract {
  id: string;
  client_id: string;
  title: string;
  description: string | null;
  status: ContractStatus;
  type: ContractType;
  total_value: number | null;
  start_date: string | null;
  end_date: string | null;
  signed_at: string | null;
  billing_cadence: BillingCadence | null;
  billing_day: number | null;
  recurring_amount: number | null;
  included_hours: number | null;
  overage_rate: number | null;
  payment_terms_days: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export async function createContract(data: {
  client_id: string;
  title: string;
  description?: string;
  type?: ContractType;
  total_value?: number;
  start_date?: string;
  end_date?: string;
  billing_cadence?: BillingCadence;
  billing_day?: number;
  recurring_amount?: number;
  included_hours?: number;
  overage_rate?: number;
  payment_terms_days?: number;
  created_by: string;
}): Promise<string> {
  const id = nanoid();
  await turso.execute({
    sql: `INSERT INTO contracts (id, client_id, title, description, type, total_value, start_date, end_date, billing_cadence, billing_day, recurring_amount, included_hours, overage_rate, payment_terms_days, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, data.client_id, data.title, data.description ?? null,
      data.type ?? 'fixed', data.total_value ?? null,
      data.start_date ?? null, data.end_date ?? null,
      data.billing_cadence ?? null, data.billing_day ?? null,
      data.recurring_amount ?? null, data.included_hours ?? null,
      data.overage_rate ?? null, data.payment_terms_days ?? 30,
      data.created_by,
    ],
  });
  return id;
}

// ============================================================
// Contract provisioning (Phase 1 Step 6)
// ============================================================
//
// provisionContract is a transactional wrapper around createContract
// that also seeds the downstream structure a real product needs:
//
//   1. The contract row itself (with service_type + modules_json).
//   2. A default project shell, so lib/billing.ts getContractHoursForPeriod
//      has something to count against and the delivery UI has a parent
//      row for milestones and tasks.
//   3. For monthly contracts: one scheduled_jobs row of type
//      'generate_invoices' scheduled for the next billing day — the
//      first automation a new contract triggers.
//   4. An activity_log entry with action='provisioned'.
//
// All four writes happen inside a single transaction. If any fails,
// nothing persists.
//
// The existing createContract() is still exported for callers that only
// need the contract row (tests, admin edit flows). New code that creates
// contracts from admin input should call provisionContract().

export const DEFAULT_MODULES = ['dashboard', 'rankings', 'health', 'files', 'invoices'];

export type ServiceType = 'web_management' | 'consulting' | 'hybrid';

// Test-only fault injection. When set to a positive integer, the
// next call to provisionContract() throws before opening its
// transaction, and the counter is cleared. Used by the multi-contract
// intake test to exercise partial-failure behavior deterministically.
// Never set in production code.
let __testProvisionFault: string | null = null;
export function __setProvisionFault(message: string | null): void {
  __testProvisionFault = message;
}

export interface ProvisionResult {
  contract_id: string;
  project_id: string;
  scheduled_job_id: string | null;
  activity_id: string;
  binding_ids: string[];
  client_profile_fields_updated: string[];
  milestone_ids: string[];
  contact_ids: string[];
}

// Computes the ISO timestamp for the next run of a monthly billing job
// whose anchor is `billingDay`. Uses Date.UTC so the output is
// timezone-independent — the same contract on a UTC server and a JST
// server produces identical scheduled_for strings.
//
// The anchor is treated as a UTC calendar day. 00:00Z of the billing day.
// Clamped to [1, 28] to match the contracts schema bounds.
export function nextBillingRunIso(billingDay: number, now: Date = new Date()): string {
  const day = Math.max(1, Math.min(28, Math.floor(billingDay)));
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-indexed
  let candidate = Date.UTC(y, m, day, 0, 0, 0, 0);
  if (candidate <= now.getTime()) {
    candidate = Date.UTC(y, m + 1, day, 0, 0, 0, 0);
  }
  return new Date(candidate).toISOString();
}

export async function provisionContract(data: {
  client_id: string;
  title: string;
  description?: string;
  type?: ContractType;
  service_type?: ServiceType;
  modules?: string[];
  total_value?: number;
  start_date?: string;
  end_date?: string;
  billing_cadence?: BillingCadence;
  billing_day?: number;
  recurring_amount?: number;
  included_hours?: number;
  overage_rate?: number;
  payment_terms_days?: number;
  data_sources?: DataSourceInput[];
  client_profile?: ClientProfileInput;
  contacts?: ContactInput[];
  passthrough_rule?: PassthroughRule;
  reminder_rule?: ReminderRule;
  created_by: string;
}): Promise<ProvisionResult> {
  if (__testProvisionFault !== null) {
    const msg = __testProvisionFault;
    __testProvisionFault = null;
    throw new Error(msg);
  }
  const contractId = nanoid();
  const projectId = nanoid();
  const activityId = nanoid();
  let scheduledJobId: string | null = null;
  let bindingIds: string[] = [];
  let contactIds: string[] = [];
  let clientProfileFieldsUpdated: string[] = [];

  const passthroughJson = data.passthrough_rule ? JSON.stringify(data.passthrough_rule) : null;
  const reminderJson = data.reminder_rule ? JSON.stringify(data.reminder_rule) : null;

  // Pre-compute milestone seeding so nanoid allocations and template
  // lookup happen outside the transaction. Empty array when no
  // service_type is provided (backwards compat with earlier slices).
  const milestoneTemplates = getMilestoneTemplateForService(data.service_type);
  const milestoneIds: string[] = milestoneTemplates.map(() => nanoid());

  const modulesJson = JSON.stringify(
    data.modules && data.modules.length > 0 ? data.modules : DEFAULT_MODULES
  );

  const shouldEnqueueBilling =
    data.billing_cadence === 'monthly' &&
    typeof data.billing_day === 'number' &&
    data.billing_day >= 1 &&
    data.billing_day <= 28 &&
    data.recurring_amount != null &&
    data.recurring_amount > 0;

  if (shouldEnqueueBilling) scheduledJobId = nanoid();

  const tx = await turso.transaction('write');
  try {
    // 0. Client profile upsert. Any field the intake provided gets
    //    written to the clients row inside this transaction so the
    //    contract and its client profile land together or not at all.
    if (data.client_profile) {
      const result = await updateClientProfileInTx(tx, data.client_id, data.client_profile);
      clientProfileFieldsUpdated = result.updatedFields;
    }

    // 1. Contract row
    await tx.execute({
      sql: `INSERT INTO contracts
            (id, client_id, title, description, type, total_value, start_date, end_date,
             billing_cadence, billing_day, recurring_amount, included_hours, overage_rate,
             payment_terms_days, created_by, service_type, modules_json,
             passthrough_rule_json, reminder_rule_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        contractId,
        data.client_id,
        data.title,
        data.description ?? null,
        data.type ?? 'fixed',
        data.total_value ?? null,
        data.start_date ?? null,
        data.end_date ?? null,
        data.billing_cadence ?? null,
        data.billing_day ?? null,
        data.recurring_amount ?? null,
        data.included_hours ?? null,
        data.overage_rate ?? null,
        data.payment_terms_days ?? 30,
        data.created_by,
        data.service_type ?? null,
        modulesJson,
        passthroughJson,
        reminderJson,
      ],
    });

    // 2. Default project shell
    await tx.execute({
      sql: `INSERT INTO projects
            (id, contract_id, client_id, title, description, status, sort_order, client_visible)
            VALUES (?, ?, ?, ?, ?, 'in_progress', 0, 1)`,
      args: [
        projectId,
        contractId,
        data.client_id,
        `${data.title} — ongoing`,
        'Default project shell seeded at contract provisioning.',
      ],
    });

    // 2b. Seed service-type milestones into the default project. Each
    // row carries admin-side title/description and client-facing
    // plain-language update text. Status starts as 'not_started' via
    // the schema default. No due_date is set — that's slice 11b work
    // once we know how the monthly cadence maps onto milestone timing.
    for (let i = 0; i < milestoneTemplates.length; i++) {
      const tpl = milestoneTemplates[i];
      await tx.execute({
        sql: `INSERT INTO milestones
              (id, project_id, title, description, sort_order, client_visible, client_update_text)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          milestoneIds[i],
          projectId,
          tpl.title,
          tpl.description,
          tpl.sort_order,
          tpl.client_visible ? 1 : 0,
          tpl.client_update_text,
        ],
      });
    }

    // 3. First scheduled_jobs row for recurring billing.
    if (scheduledJobId) {
      const runAt = nextBillingRunIso(data.billing_day!);
      await tx.execute({
        sql: `INSERT INTO scheduled_jobs
              (id, job_type, scheduled_for, status, payload_json)
              VALUES (?, 'generate_invoices', ?, 'pending', ?)`,
        args: [
          scheduledJobId,
          runAt,
          JSON.stringify({ created_by: data.created_by, contract_id: contractId }),
        ],
      });
    }

    // 4. Data source bindings declared at intake. Each binding row
    //    lands inside the same transaction as the contract so we never
    //    end up with a contract whose bindings half-seeded on a crash.
    if (data.data_sources && data.data_sources.length > 0) {
      bindingIds = await seedBindingsInTx(tx, {
        client_id: data.client_id,
        contract_id: contractId,
        data_sources: data.data_sources,
      });
    }

    // 4b. Contacts seeded at the client level inside the same tx.
    //     Idempotency for re-runs is enforced by the
    //     UNIQUE(client_id, email) constraint — a second run of this
    //     slice's test or a second contract on the same client with
    //     overlapping emails will fail the UNIQUE and roll the whole
    //     intake back. That's the right behavior: commercial truth
    //     about a client's contacts should only be entered once.
    if (data.contacts && data.contacts.length > 0) {
      contactIds = await seedContactsInTx(tx, {
        client_id: data.client_id,
        contacts: data.contacts,
      });
    }

    // 5. Activity log
    const enabledBindingCount = (data.data_sources ?? []).filter((d) => d.enabled).length;
    const summaryParts = [
      'project',
      'modules',
      scheduledJobId ? 'billing schedule' : 'no billing',
    ];
    if (bindingIds.length > 0) {
      summaryParts.push(`${bindingIds.length} data source binding${bindingIds.length === 1 ? '' : 's'} (${enabledBindingCount} enabled)`);
    }
    if (clientProfileFieldsUpdated.length > 0) {
      summaryParts.push(`client profile (${clientProfileFieldsUpdated.join(', ')})`);
    }
    const ruleBits: string[] = [];
    if (passthroughJson) ruleBits.push('passthrough rule');
    if (reminderJson) ruleBits.push('reminder rule');
    if (ruleBits.length > 0) summaryParts.push(ruleBits.join(' + '));
    if (milestoneIds.length > 0) {
      summaryParts.push(`${milestoneIds.length} ${data.service_type} milestones`);
    }
    if (contactIds.length > 0) {
      summaryParts.push(`${contactIds.length} contact${contactIds.length === 1 ? '' : 's'}`);
    }
    await tx.execute({
      sql: `INSERT INTO activity_log (id, client_id, user_id, action, entity_type, entity_id, summary)
            VALUES (?, ?, ?, 'provisioned', 'contract', ?, ?)`,
      args: [
        activityId,
        data.client_id,
        data.created_by,
        contractId,
        `Contract "${data.title}" provisioned (${summaryParts.join(', ')})`,
      ],
    });

    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }

  return {
    contract_id: contractId,
    project_id: projectId,
    scheduled_job_id: scheduledJobId,
    activity_id: activityId,
    binding_ids: bindingIds,
    client_profile_fields_updated: clientProfileFieldsUpdated,
    milestone_ids: milestoneIds,
    contact_ids: contactIds,
  };
}

// ============================================================
// Multi-contract intake (Slice 15)
// ============================================================
//
// One wizard pass can legitimately create multiple contract rows for
// the same client when Cody is signing more than one service in a
// single conversation. Each block carries its own commercial truth
// (title, type, service_type, billing rules, passthrough rules,
// reminder rules, modules) and is provisioned via the existing
// provisionContract() function so its transaction guarantees are
// preserved — block atomicity is per-contract, not across all blocks.
//
// Client-level truth (profile, contacts, data_sources-as-captured)
// is handled ONCE by this orchestrator, before the first block fires:
//
//   1. Resolve the client — use client_id or create via new_client
//   2. Upsert clients.{primary_url, brand_accent, primary_contact_email,
//      reading_level_target}
//   3. Seed contacts rows
//   4. For each contract block in order:
//        - call provisionContract() with contract-level fields
//        - fan out data_sources (client-level mental model, per-contract
//          schema) into each block's bindings
//        - collect the result or the error without throwing, so a
//          failed block doesn't prevent subsequent blocks from landing
//
// If the multi-block run lands partial state (e.g. client + first
// contract succeed but the second errors), the response reports the
// split so the admin UI can show the exact failure and the caller
// can retry just the failed block.

export interface ContractBlockInput {
  title: string;
  description?: string;
  type?: ContractType;
  service_type?: ServiceType;
  modules?: string[];
  total_value?: number;
  start_date?: string;
  end_date?: string;
  billing_cadence?: BillingCadence;
  billing_day?: number;
  recurring_amount?: number;
  included_hours?: number;
  overage_rate?: number;
  payment_terms_days?: number;
  passthrough_rule?: PassthroughRule;
  reminder_rule?: ReminderRule;
}

export interface ClientIntakeInput {
  client_id?: string;
  new_client?: { name: string; slug: string };
  client_profile?: ClientProfileInput;
  contacts?: ContactInput[];
  data_sources?: DataSourceInput[];
  contracts: ContractBlockInput[];
  created_by: string;
}

export type ContractBlockResult =
  | {
      success: true;
      title: string;
      contract_id: string;
      project_id: string;
      scheduled_job_id: string | null;
      binding_ids: string[];
      milestone_ids: string[];
      activity_id: string;
    }
  | {
      success: false;
      title: string;
      error: string;
    };

export interface ClientIntakeResult {
  client_id: string;
  client_created: boolean;
  client_profile_fields_updated: string[];
  contact_ids: string[];
  contracts: ContractBlockResult[];
  success_count: number;
  failure_count: number;
}

export async function provisionClientIntake(
  data: ClientIntakeInput
): Promise<ClientIntakeResult> {
  // Resolve or create the client row. Exactly one of client_id /
  // new_client must be present — the POST handler validates this
  // before dispatching, but we re-check here so direct library
  // callers get the same guarantee.
  if (!data.client_id && !data.new_client) {
    throw new Error('provisionClientIntake: client_id or new_client required');
  }
  if (data.client_id && data.new_client) {
    throw new Error('provisionClientIntake: cannot set both client_id and new_client');
  }
  if (!Array.isArray(data.contracts) || data.contracts.length === 0) {
    throw new Error('provisionClientIntake: contracts array must have at least one block');
  }

  let clientId: string;
  let clientCreated = false;
  if (data.new_client) {
    clientId = await createClientRow(data.new_client.name, data.new_client.slug);
    clientCreated = true;
  } else {
    clientId = data.client_id!;
  }

  // Client-level profile upsert. Runs once, not per block.
  let clientProfileFieldsUpdated: string[] = [];
  if (data.client_profile && Object.keys(data.client_profile).length > 0) {
    const r = await updateClientProfile(clientId, data.client_profile);
    clientProfileFieldsUpdated = r.updatedFields;
  }

  // Client-level contacts seed. Runs once.
  let contactIds: string[] = [];
  if (data.contacts && data.contacts.length > 0) {
    contactIds = await seedContactsForClient(clientId, data.contacts);
  }

  // Per-contract provisioning. Each block uses its own transaction
  // inside provisionContract(); failures are captured and the loop
  // continues so a later block can't un-commit an earlier one.
  const blockResults: ContractBlockResult[] = [];
  for (const block of data.contracts) {
    try {
      const provisioned = await provisionContract({
        client_id: clientId,
        title: block.title,
        description: block.description,
        type: block.type,
        service_type: block.service_type,
        modules: block.modules,
        total_value: block.total_value,
        start_date: block.start_date,
        end_date: block.end_date,
        billing_cadence: block.billing_cadence,
        billing_day: block.billing_day,
        recurring_amount: block.recurring_amount,
        included_hours: block.included_hours,
        overage_rate: block.overage_rate,
        payment_terms_days: block.payment_terms_days,
        // Data sources are client-level in the payload but
        // contract-level in the schema — clone into every block so
        // each contract gets its own binding rows under the same
        // (contract_id, source) UNIQUE key.
        data_sources: data.data_sources && data.data_sources.length > 0
          ? data.data_sources.map((d) => ({ ...d }))
          : undefined,
        passthrough_rule: block.passthrough_rule,
        reminder_rule: block.reminder_rule,
        created_by: data.created_by,
      });
      blockResults.push({
        success: true,
        title: block.title,
        contract_id: provisioned.contract_id,
        project_id: provisioned.project_id,
        scheduled_job_id: provisioned.scheduled_job_id,
        binding_ids: provisioned.binding_ids,
        milestone_ids: provisioned.milestone_ids,
        activity_id: provisioned.activity_id,
      });
    } catch (err) {
      blockResults.push({
        success: false,
        title: block.title,
        error: String((err as Error)?.message ?? err),
      });
    }
  }

  const successCount = blockResults.filter((r) => r.success).length;
  const failureCount = blockResults.length - successCount;

  return {
    client_id: clientId,
    client_created: clientCreated,
    client_profile_fields_updated: clientProfileFieldsUpdated,
    contact_ids: contactIds,
    contracts: blockResults,
    success_count: successCount,
    failure_count: failureCount,
  };
}

export async function getContract(id: string): Promise<Contract | undefined> {
  return queryOne('SELECT * FROM contracts WHERE id = ?', [id]);
}

export async function getContractsByClient(clientId: string): Promise<Contract[]> {
  return queryAll('SELECT * FROM contracts WHERE client_id = ? ORDER BY created_at DESC', [clientId]);
}

export async function getContractsByStatus(status: ContractStatus): Promise<Contract[]> {
  return queryAll('SELECT * FROM contracts WHERE status = ? ORDER BY updated_at DESC', [status]);
}

export async function getAllContracts(): Promise<Contract[]> {
  return queryAll('SELECT * FROM contracts ORDER BY updated_at DESC');
}

export async function updateContract(id: string, data: Partial<Pick<Contract,
  'title' | 'description' | 'status' | 'type' | 'total_value' | 'start_date' | 'end_date' | 'signed_at' |
  'billing_cadence' | 'billing_day' | 'recurring_amount' | 'included_hours' | 'overage_rate' | 'payment_terms_days'
>>): Promise<void> {
  const update = buildSafeUpdate('contracts', id, data);
  if (!update) return;
  await turso.execute(update);
}

// Cascade delete: removes all projects, milestones, tasks, artifacts, invoices, approvals,
// and change orders under this contract.
export async function deleteContract(id: string): Promise<void> {
  const projects = await getProjectsByContract(id);
  for (const project of projects) {
    await deleteProject(project.id);
  }
  await cascadeDeleteContractChildren(id);
  await turso.execute({ sql: 'DELETE FROM contracts WHERE id = ?', args: [id] });
}

// ============================================================
// Projects
// ============================================================

export type ProjectStatus = 'not_started' | 'in_progress' | 'on_hold' | 'completed' | 'cancelled';

export interface Project {
  id: string;
  contract_id: string;
  client_id: string;
  title: string;
  description: string | null;
  status: ProjectStatus;
  sort_order: number;
  client_visible: number;
  created_at: string;
  updated_at: string;
}

export async function createProject(data: {
  contract_id: string;
  client_id: string;
  title: string;
  description?: string;
  client_visible?: boolean;
}): Promise<string> {
  const id = nanoid();
  await turso.execute({
    sql: `INSERT INTO projects (id, contract_id, client_id, title, description, client_visible)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      id, data.contract_id, data.client_id, data.title,
      data.description ?? null, data.client_visible === false ? 0 : 1,
    ],
  });
  return id;
}

export async function getProject(id: string): Promise<Project | undefined> {
  return queryOne('SELECT * FROM projects WHERE id = ?', [id]);
}

export async function getProjectsByContract(contractId: string): Promise<Project[]> {
  return queryAll('SELECT * FROM projects WHERE contract_id = ? ORDER BY sort_order, created_at', [contractId]);
}

export async function getProjectsByClient(clientId: string): Promise<Project[]> {
  return queryAll('SELECT * FROM projects WHERE client_id = ? ORDER BY sort_order, created_at', [clientId]);
}

// Client-safe: excludes sort_order, contract_id (admin context)
export async function getClientVisibleProjects(clientId: string): Promise<Pick<Project, 'id' | 'title' | 'description' | 'status' | 'created_at' | 'updated_at'>[]> {
  return queryAll(
    'SELECT id, title, description, status, created_at, updated_at FROM projects WHERE client_id = ? AND client_visible = 1 ORDER BY sort_order, created_at',
    [clientId]
  );
}

export async function updateProject(id: string, data: Partial<Pick<Project,
  'title' | 'description' | 'status' | 'sort_order' | 'client_visible'
>>): Promise<void> {
  const update = buildSafeUpdate('projects', id, data);
  if (!update) return;
  await turso.execute(update);
}

// Cascade delete: removes all milestones, tasks, and artifacts under this project.
export async function deleteProject(id: string): Promise<void> {
  const milestones = await getMilestonesByProject(id);
  for (const ms of milestones) {
    await deleteMilestone(ms.id);
  }
  await turso.execute({ sql: 'DELETE FROM projects WHERE id = ?', args: [id] });
}

// ============================================================
// Milestones
// ============================================================

export type MilestoneStatus = 'not_started' | 'in_progress' | 'completed';

export interface Milestone {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: MilestoneStatus;
  due_date: string | null;
  completed_at: string | null;
  sort_order: number;
  client_visible: number;
  client_update_text: string | null;
  created_at: string;
  updated_at: string;
}

export async function createMilestone(data: {
  project_id: string;
  title: string;
  description?: string;
  due_date?: string;
  client_visible?: boolean;
  client_update_text?: string;
}): Promise<string> {
  const id = nanoid();
  await turso.execute({
    sql: `INSERT INTO milestones (id, project_id, title, description, due_date, client_visible, client_update_text)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, data.project_id, data.title, data.description ?? null,
      data.due_date ?? null, data.client_visible === false ? 0 : 1,
      data.client_update_text ?? null,
    ],
  });
  return id;
}

export async function getMilestone(id: string): Promise<Milestone | undefined> {
  return queryOne('SELECT * FROM milestones WHERE id = ?', [id]);
}

export async function getMilestonesByProject(projectId: string): Promise<Milestone[]> {
  return queryAll('SELECT * FROM milestones WHERE project_id = ? ORDER BY sort_order, created_at', [projectId]);
}

// Client-safe: excludes sort_order, internal description kept (client needs context), adds client_update_text
export async function getClientVisibleMilestones(projectId: string): Promise<Pick<Milestone, 'id' | 'title' | 'description' | 'status' | 'due_date' | 'completed_at' | 'client_update_text'>[]> {
  return queryAll(
    'SELECT id, title, description, status, due_date, completed_at, client_update_text FROM milestones WHERE project_id = ? AND client_visible = 1 ORDER BY sort_order, created_at',
    [projectId]
  );
}

export async function updateMilestone(id: string, data: Partial<Pick<Milestone,
  'title' | 'description' | 'status' | 'due_date' | 'completed_at' | 'sort_order' | 'client_visible' | 'client_update_text'
>>): Promise<void> {
  const update = buildSafeUpdate('milestones', id, data);
  if (!update) return;
  await turso.execute(update);
}

// Cascade delete: removes all tasks and artifacts under this milestone.
export async function deleteMilestone(id: string): Promise<void> {
  const tasks = await getTasksByMilestone(id);
  for (const task of tasks) {
    await deleteTask(task.id);
  }
  await turso.execute({ sql: 'DELETE FROM milestones WHERE id = ?', args: [id] });
}

// ============================================================
// Tasks
// ============================================================

export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done' | 'blocked';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface Task {
  id: string;
  milestone_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigned_to: string | null;
  estimated_hours: number | null;
  actual_hours: number | null;
  due_date: string | null;
  completed_at: string | null;
  sort_order: number;
  client_visible: number;
  client_update_text: string | null;
  created_at: string;
  updated_at: string;
}

export async function createTask(data: {
  milestone_id: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  assigned_to?: string;
  estimated_hours?: number;
  due_date?: string;
  client_visible?: boolean;
  client_update_text?: string;
}): Promise<string> {
  const id = nanoid();
  await turso.execute({
    sql: `INSERT INTO tasks (id, milestone_id, title, description, priority, assigned_to, estimated_hours, due_date, client_visible, client_update_text)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, data.milestone_id, data.title, data.description ?? null,
      data.priority ?? 'normal', data.assigned_to ?? null,
      data.estimated_hours ?? null, data.due_date ?? null,
      data.client_visible ? 1 : 0, data.client_update_text ?? null,
    ],
  });
  return id;
}

export async function getTask(id: string): Promise<Task | undefined> {
  return queryOne('SELECT * FROM tasks WHERE id = ?', [id]);
}

export async function getTasksByMilestone(milestoneId: string): Promise<Task[]> {
  return queryAll('SELECT * FROM tasks WHERE milestone_id = ? ORDER BY sort_order, created_at', [milestoneId]);
}

export async function getTasksByAssignee(userId: string): Promise<Task[]> {
  return queryAll(
    "SELECT * FROM tasks WHERE assigned_to = ? AND status != 'done' ORDER BY priority DESC, due_date",
    [userId]
  );
}

// Client-safe: excludes estimated_hours, actual_hours, assigned_to, priority, sort_order, internal description
export async function getClientVisibleTasks(milestoneId: string): Promise<Pick<Task, 'id' | 'title' | 'status' | 'client_update_text'>[]> {
  return queryAll(
    'SELECT id, title, status, client_update_text FROM tasks WHERE milestone_id = ? AND client_visible = 1 ORDER BY sort_order, created_at',
    [milestoneId]
  );
}

export async function updateTask(id: string, data: Partial<Pick<Task,
  'title' | 'description' | 'status' | 'priority' | 'assigned_to' | 'estimated_hours' | 'actual_hours' |
  'due_date' | 'completed_at' | 'sort_order' | 'client_visible' | 'client_update_text'
>>): Promise<void> {
  const update = buildSafeUpdate('tasks', id, data);
  if (!update) return;
  await turso.execute(update);
}

// Cascade delete: removes all artifacts under this task.
export async function deleteTask(id: string): Promise<void> {
  await turso.execute({ sql: 'DELETE FROM task_artifacts WHERE task_id = ?', args: [id] });
  await turso.execute({ sql: 'DELETE FROM tasks WHERE id = ?', args: [id] });
}

// ============================================================
// Task Artifacts
// ============================================================

export type ArtifactType = 'file' | 'link' | 'screenshot';

export interface TaskArtifact {
  id: string;
  task_id: string;
  file_id: string | null;
  label: string;
  artifact_type: ArtifactType;
  url: string | null;
  client_visible: number;
  created_at: string;
}

export async function createTaskArtifact(data: {
  task_id: string;
  label: string;
  artifact_type?: ArtifactType;
  file_id?: string;
  url?: string;
  client_visible?: boolean;
}): Promise<string> {
  const id = nanoid();
  await turso.execute({
    sql: `INSERT INTO task_artifacts (id, task_id, file_id, label, artifact_type, url, client_visible)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, data.task_id, data.file_id ?? null, data.label,
      data.artifact_type ?? 'file', data.url ?? null,
      data.client_visible ? 1 : 0,
    ],
  });
  return id;
}

export async function getArtifactsByTask(taskId: string): Promise<TaskArtifact[]> {
  return queryAll('SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY created_at', [taskId]);
}

// Client-safe: excludes file_id (internal reference)
export async function getClientVisibleArtifacts(taskId: string): Promise<Pick<TaskArtifact, 'id' | 'label' | 'artifact_type' | 'url' | 'created_at'>[]> {
  return queryAll(
    'SELECT id, label, artifact_type, url, created_at FROM task_artifacts WHERE task_id = ? AND client_visible = 1 ORDER BY created_at',
    [taskId]
  );
}

export async function deleteTaskArtifact(id: string): Promise<void> {
  await turso.execute({ sql: 'DELETE FROM task_artifacts WHERE id = ?', args: [id] });
}
