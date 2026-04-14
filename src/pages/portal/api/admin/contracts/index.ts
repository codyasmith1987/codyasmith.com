// GET: list contracts (optionally filtered by client_id or status)
// POST: create a new contract

import type { APIRoute } from 'astro';
import {
  provisionContract,
  provisionClientIntake,
  getAllContracts, getContractsByClient, getContractsByStatus,
  type ContractStatus, type ServiceType, type ContractBlockInput,
} from '../../../../../lib/contracts';
import { parseDataSourceInput } from '../../../../../lib/data-sources';
import { parseClientProfileInput, parseContactsInput } from '../../../../../lib/clients';
import { parsePassthroughRule, parseReminderRule } from '../../../../../lib/contract-rules';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, url }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const clientId = url.searchParams.get('client_id');
    const status = url.searchParams.get('status') as ContractStatus | null;

    if (clientId) return json(await getContractsByClient(clientId));
    if (status) return json(await getContractsByStatus(status));
    return json(await getAllContracts());
  } catch (err) {
    logger.error('List contracts error', err);
    return json({ error: 'Failed to load contracts' }, 500);
  }
};

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const body = await request.json();

    // Shape discriminator: a `contracts` array means multi-contract
    // intake (Slice 15). Anything else is the legacy flat-field
    // single-contract shape and routes through the original
    // provisionContract path so existing callers keep working.
    if (Array.isArray(body.contracts)) {
      return await handleMultiContractIntake(body, locals);
    }

    const { client_id, title, description, type, service_type, modules,
            total_value, start_date, end_date,
            billing_cadence, billing_day, recurring_amount, included_hours, overage_rate, payment_terms_days,
            data_sources, client_profile, contacts, passthrough_rule, reminder_rule } = body;

    if (!client_id?.trim() || !title?.trim()) {
      return json({ error: 'client_id and title are required' }, 400);
    }

    // Untrusted payload — parse strictly. Each parser returns null on
    // any malformed field so the request is rejected before touching
    // the DB.
    const dataSources = parseDataSourceInput(data_sources);
    if (dataSources === null) {
      return json({ error: 'data_sources is malformed' }, 400);
    }

    const clientProfile = parseClientProfileInput(client_profile);
    if (clientProfile === null) {
      return json({ error: 'client_profile is malformed' }, 400);
    }

    const contactsList = parseContactsInput(contacts);
    if (contactsList === null) {
      return json({ error: 'contacts is malformed' }, 400);
    }

    const passthroughRule = parsePassthroughRule(passthrough_rule);
    if (passthroughRule === null) {
      return json({ error: 'passthrough_rule is malformed' }, 400);
    }

    const reminderRule = parseReminderRule(reminder_rule);
    if (reminderRule === null) {
      return json({ error: 'reminder_rule is malformed' }, 400);
    }

    // provisionContract seeds the project shell, billing schedule, data
    // source bindings, and activity log entry inside a single
    // transaction. The returned shape tells the caller what was created.
    const result = await provisionContract({
      client_id: client_id.trim(),
      title: title.trim(),
      description: description?.trim() || undefined,
      type: type || undefined,
      service_type: (service_type || undefined) as ServiceType | undefined,
      modules: Array.isArray(modules) ? modules : undefined,
      total_value: total_value != null ? Number(total_value) : undefined,
      start_date: start_date || undefined,
      end_date: end_date || undefined,
      billing_cadence: billing_cadence || undefined,
      billing_day: billing_day != null ? Number(billing_day) : undefined,
      recurring_amount: recurring_amount != null ? Number(recurring_amount) : undefined,
      included_hours: included_hours != null ? Number(included_hours) : undefined,
      overage_rate: overage_rate != null ? Number(overage_rate) : undefined,
      payment_terms_days: payment_terms_days != null ? Number(payment_terms_days) : undefined,
      data_sources: dataSources.length > 0 ? dataSources : undefined,
      client_profile: Object.keys(clientProfile).length > 0 ? clientProfile : undefined,
      contacts: contactsList.length > 0 ? contactsList : undefined,
      passthrough_rule: passthroughRule === 'absent' ? undefined : passthroughRule,
      reminder_rule: reminderRule === 'absent' ? undefined : reminderRule,
      created_by: locals.user!.id,
    });

    return json(
      {
        id: result.contract_id,
        project_id: result.project_id,
        scheduled_job_id: result.scheduled_job_id,
        binding_ids: result.binding_ids,
        milestone_ids: result.milestone_ids,
        contact_ids: result.contact_ids,
        client_profile_fields_updated: result.client_profile_fields_updated,
      },
      201
    );
  } catch (err) {
    logger.error('Create contract error', err);
    return json({ error: 'Failed to create contract' }, 500);
  }
};

// Slice 15 — multi-contract intake handler. Split out so the single
// POST function stays readable. Same auth + CSRF gate as the main
// handler (enforced by middleware before this is reached).
async function handleMultiContractIntake(
  body: any,
  locals: App.Locals
): Promise<Response> {
  try {
    const {
      client_id,
      new_client,
      client_profile,
      contacts,
      data_sources,
      contracts: blocks,
    } = body;

    if (!client_id && !new_client) {
      return json({ error: 'client_id or new_client required' }, 400);
    }
    if (client_id && new_client) {
      return json({ error: 'cannot set both client_id and new_client' }, 400);
    }
    if (new_client) {
      if (typeof new_client !== 'object' || new_client == null) {
        return json({ error: 'new_client must be an object' }, 400);
      }
      if (typeof new_client.name !== 'string' || !new_client.name.trim()) {
        return json({ error: 'new_client.name required' }, 400);
      }
      if (
        typeof new_client.slug !== 'string' ||
        !/^[a-z0-9-]+$/.test(new_client.slug.trim())
      ) {
        return json({ error: 'new_client.slug must be lowercase letters, numbers, hyphens' }, 400);
      }
    }

    if (!Array.isArray(blocks) || blocks.length === 0) {
      return json({ error: 'contracts array must have at least one block' }, 400);
    }

    const dataSources = parseDataSourceInput(data_sources);
    if (dataSources === null) {
      return json({ error: 'data_sources is malformed' }, 400);
    }
    const clientProfile = parseClientProfileInput(client_profile);
    if (clientProfile === null) {
      return json({ error: 'client_profile is malformed' }, 400);
    }
    const contactsList = parseContactsInput(contacts);
    if (contactsList === null) {
      return json({ error: 'contacts is malformed' }, 400);
    }

    // Validate and parse each block.
    const parsedBlocks: ContractBlockInput[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (!b || typeof b !== 'object') {
        return json({ error: `contracts[${i}] must be an object` }, 400);
      }
      if (typeof b.title !== 'string' || !b.title.trim()) {
        return json({ error: `contracts[${i}].title required` }, 400);
      }
      const passthroughRule = parsePassthroughRule(b.passthrough_rule);
      if (passthroughRule === null) {
        return json({ error: `contracts[${i}].passthrough_rule is malformed` }, 400);
      }
      const reminderRule = parseReminderRule(b.reminder_rule);
      if (reminderRule === null) {
        return json({ error: `contracts[${i}].reminder_rule is malformed` }, 400);
      }
      parsedBlocks.push({
        title: b.title.trim(),
        description: b.description?.trim() || undefined,
        type: b.type || undefined,
        service_type: (b.service_type || undefined) as ServiceType | undefined,
        modules: Array.isArray(b.modules) ? b.modules : undefined,
        total_value: b.total_value != null ? Number(b.total_value) : undefined,
        start_date: b.start_date || undefined,
        end_date: b.end_date || undefined,
        billing_cadence: b.billing_cadence || undefined,
        billing_day: b.billing_day != null ? Number(b.billing_day) : undefined,
        recurring_amount: b.recurring_amount != null ? Number(b.recurring_amount) : undefined,
        included_hours: b.included_hours != null ? Number(b.included_hours) : undefined,
        overage_rate: b.overage_rate != null ? Number(b.overage_rate) : undefined,
        payment_terms_days: b.payment_terms_days != null ? Number(b.payment_terms_days) : undefined,
        passthrough_rule: passthroughRule === 'absent' ? undefined : passthroughRule,
        reminder_rule: reminderRule === 'absent' ? undefined : reminderRule,
      });
    }

    const result = await provisionClientIntake({
      client_id: client_id ? String(client_id).trim() : undefined,
      new_client: new_client
        ? { name: String(new_client.name).trim(), slug: String(new_client.slug).trim() }
        : undefined,
      client_profile: Object.keys(clientProfile).length > 0 ? clientProfile : undefined,
      contacts: contactsList.length > 0 ? contactsList : undefined,
      data_sources: dataSources.length > 0 ? dataSources : undefined,
      contracts: parsedBlocks,
      created_by: locals.user!.id,
    });

    // 207 Multi-Status when some blocks failed, 201 when all succeeded.
    const status = result.failure_count === 0 ? 201 : 207;
    return json(result, status);
  } catch (err) {
    logger.error('Multi-contract intake error', err);
    return json({ error: 'Failed to run client intake' }, 500);
  }
}
