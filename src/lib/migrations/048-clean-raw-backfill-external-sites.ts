import type { Migration } from '../migrate';
import turso from '../turso';

// Cleanup for the bad raw_csv_data fallback shipped during the
// backfill audit. PR #187 let raw CSV URL columns derive managed
// client_sites, but generic raw CSVs include external assets/embeds:
// YouTube, Google Maps, Facebook pixels, fonts, GTM, social profiles,
// etc. Zip Kit was the only prod client affected before this fix.
//
// Keep the known real sites:
//   - zipkithomes.com (existing primary)
//   - mountainvalleyprefab.com (MVP related site surfaced in data)
//
// Delete only exact bad external rows, and only when they still look
// machine-created: untouched label, no page_count, no Cloudflare zone,
// no go-live date, and no pricing overrides. If Cody manually edited
// any row before this migration, leave it alone.
const migration: Migration = {
  id: '048-clean-raw-backfill-external-sites',
  up: async () => {
    const badDomains = [
      'youtube.com',
      'google.com',
      'facebook.com',
      'fonts.googleapis.com',
      'googletagmanager.com',
      'youtu.be',
      '2749206.my1003app.com',
      'instagram.com',
      'leveluplendingllc.com',
      'linkedin.com',
      'static.cloudflareinsights.com',
    ];
    const placeholders = badDomains.map(() => '?').join(', ');
    await turso.execute({
      sql: `DELETE FROM client_sites
            WHERE client_id IN (SELECT id FROM clients WHERE slug = 'zipkit-homes')
              AND domain IN (${placeholders})
              AND COALESCE(label, domain) = domain
              AND page_count IS NULL
              AND cloudflare_zone_id IS NULL
              AND went_live_at IS NULL
              AND monthly_override IS NULL
              AND onboarding_override IS NULL`,
      args: badDomains,
    });
  },
};

export default migration;
