// Single-row seller profile: the letterhead/footer identity for generated
// documents (invoice PDF today; contract/report PDFs can adopt it later).
// Seeded by migration 065. Reads are defensive: if the row or table is
// missing for any reason, fall back to the known-good defaults so a PDF never
// fails to render over a config gap.

import turso from './turso';

export interface SellerProfile {
  display_name: string;
  street: string;
  city_state_zip: string;
  email: string;
  phone: string;
  legal_footer: string;
  payable_to: string;
}

const DEFAULTS: SellerProfile = {
  display_name: 'Cody Smith',
  street: '604 Morningside Cir',
  city_state_zip: 'Cedar City, UT 84720',
  email: 'cody@codyasmith.com',
  phone: '435-868-7133',
  legal_footer: 'Operating as Cody A Smith LLC (Utah)',
  payable_to: 'Cody A Smith LLC',
};

export async function getSellerProfile(): Promise<SellerProfile> {
  try {
    const r = await turso.execute(
      'SELECT display_name, street, city_state_zip, email, phone, legal_footer, payable_to FROM seller_profile WHERE id = 1 LIMIT 1'
    );
    const row = r.rows[0];
    if (!row) return DEFAULTS;
    return {
      display_name: (row[0] as string) || DEFAULTS.display_name,
      street: (row[1] as string) || DEFAULTS.street,
      city_state_zip: (row[2] as string) || DEFAULTS.city_state_zip,
      email: (row[3] as string) || DEFAULTS.email,
      phone: (row[4] as string) || DEFAULTS.phone,
      legal_footer: (row[5] as string) || DEFAULTS.legal_footer,
      payable_to: (row[6] as string) || DEFAULTS.payable_to,
    };
  } catch {
    return DEFAULTS;
  }
}
