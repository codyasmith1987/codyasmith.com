// Seed the cody-test fixture (client + user + proposal). Lets Cody
// drive the full proposal -> LOI -> contract -> sign -> PDF flow end
// to end under his personal email without touching the real Raised Bar
// client data.
//
// Idempotent: every insert is gated on a SELECT, so re-running this
// migration is a no-op. The reset endpoint at
// /portal/api/admin/test-fixtures/cody-test/reset clears drafts,
// agreements, signatures, and intake between test runs without
// removing the seeded client / user / proposal rows themselves.

import turso from '../turso';
import { nanoid } from 'nanoid';
import type { Migration } from '../migrate';
import { RAISED_BAR_PROPOSAL_CONFIG } from '../proposal-configs/raised-bar';
import { upsertClientMetadata } from '../agreements';

const CLIENT_SLUG = 'cody-test';
const CLIENT_NAME = 'Cody Test';
const SIGNER_EMAIL = 'codyasmith@live.com';
const SIGNER_NAME = 'Cody Smith';
const PROPOSAL_SLUG = 'cody-test';
const PROPOSAL_TITLE = 'Test Engagement Proposal for Cody';

// Single-signer variant of the Raised Bar config. Reuses the steps
// (mgmt_tier, site_setup, builders_domain, tailwater_domain, consulting,
// consulting_tier) so the proposal-form mechanics render identically
// to what real clients see. Replaces the narrative with test-marker
// copy so the page does not read as Jason and Kevin's actual proposal
// content with someone else's name pasted on top.
function buildTestConfig() {
  return {
    ...RAISED_BAR_PROPOSAL_CONFIG,
    prepared_for: 'Cody Smith (test signer)',
    prepared_on: new Date().toISOString().slice(0, 10),
    title: PROPOSAL_TITLE,
    signers: [
      { id: 'cody', email: SIGNER_EMAIL, name: SIGNER_NAME },
    ],
    narrative: {
      intro: `This is a test fixture, not a real engagement proposal. The steps, pricing, and contract preview below are wired to the same raised_bar_v1 formula real clients see, so you can walk the full flow end to end. The narrative paragraphs below are placeholders.`,
      sections: [
        {
          h2: 'What I see in your business',
          paragraphs: [
            `Placeholder. In a real proposal, this section reads back to the client what their business is, where it stands today, and what is in their way. It is written from the discovery call notes, not from a template.`,
            `Use the admin wizard at <a href="/portal/admin/proposals/new">/portal/admin/proposals/new</a> to create real proposals. Each one gets its own intro, "what I see," "what I recommend," and rollout sections.`,
          ],
        },
        {
          h2: 'What I recommend',
          paragraphs: [
            `Placeholder. In a real proposal, this section names the products, explains why they fit, and sets up the picker cards below.`,
            `The three products are <strong>Web Management</strong>, <strong>Marketing Consulting</strong>, and build work scoped per engagement. Buy one, the other, both, or add a build SOW.`,
          ],
        },
      ],
      rollout: {
        h2: 'How it rolls out',
        intro_html: `Placeholder rollout copy. In a real proposal, this section walks the client through the phasing of the work in plain language.`,
        phases: [
          {
            phase_num: 'Phase 1',
            h3: 'Test phase',
            html: `Placeholder. Test the form interaction below.`,
          },
        ],
        outro_html: `End of test narrative.`,
      },
    },
  };
}

const migration: Migration = {
  id: '025-seed-cody-test',
  async up() {
    // 1) Client.
    let clientId: string;
    const existingClient = await turso.execute({
      sql: 'SELECT id FROM clients WHERE slug = ?',
      args: [CLIENT_SLUG],
    });
    if (existingClient.rows.length > 0) {
      clientId = existingClient.rows[0][0] as string;
    } else {
      clientId = nanoid();
      await turso.execute({
        sql: 'INSERT INTO clients (id, name, slug, active) VALUES (?, ?, ?, 1)',
        args: [clientId, CLIENT_NAME, CLIENT_SLUG],
      });
    }

    // 2) Test signer user. Only created if no user with this email
    // already exists; if Cody already has a portal account at this
    // address (admin or otherwise) the migration leaves it alone.
    const existingUser = await turso.execute({
      sql: 'SELECT id, client_id, role FROM users WHERE email = ? LIMIT 1',
      args: [SIGNER_EMAIL.toLowerCase().trim()],
    });
    if (existingUser.rows.length === 0) {
      const userId = nanoid();
      await turso.execute({
        sql: 'INSERT INTO users (id, email, name, role, client_id) VALUES (?, ?, ?, ?, ?)',
        args: [userId, SIGNER_EMAIL.toLowerCase().trim(), SIGNER_NAME, 'client', clientId],
      });
    }

    // 3) Client metadata. Pre-filling so the preview contract shows
    // real values for legal entity, contact, etc., instead of the
    // [to be confirmed] placeholders. Mirrors what the admin wizard
    // will capture for real proposals.
    await upsertClientMetadata({
      client_id: clientId,
      legal_entity_name: 'Cody Test LLC',
      entity_type: 'limited liability company',
      state_of_organization: 'Utah',
      principal_address: '604 Morningside Circle, Cedar City, UT 84720',
      notice_address: '604 Morningside Circle, Cedar City, UT 84720',
      primary_contact_name: SIGNER_NAME,
      primary_contact_title: 'Member',
      primary_contact_email: SIGNER_EMAIL,
      primary_contact_phone: '435-868-7133',
    });

    // 4) Proposal.
    const existingProposal = await turso.execute({
      sql: 'SELECT id FROM proposals WHERE slug = ? LIMIT 1',
      args: [PROPOSAL_SLUG],
    });
    if (existingProposal.rows.length === 0) {
      const proposalId = nanoid();
      const config = buildTestConfig();
      await turso.execute({
        sql: `INSERT INTO proposals (id, slug, client_id, title, config, status, created_by)
              VALUES (?, ?, ?, ?, ?, 'published', NULL)`,
        args: [proposalId, PROPOSAL_SLUG, clientId, PROPOSAL_TITLE, JSON.stringify(config)],
      });
    } else {
      // If the proposal already exists, update its config to keep it in
      // sync with the latest raised-bar source. Same pattern as
      // migration 024 for the live raised-bar row.
      await turso.execute({
        sql: 'UPDATE proposals SET config = ? WHERE slug = ?',
        args: [JSON.stringify(buildTestConfig()), PROPOSAL_SLUG],
      });
    }
  },
};

export default migration;
