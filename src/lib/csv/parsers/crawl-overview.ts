import { nanoid } from 'nanoid';
import turso from '../../turso';

export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  // Crawl overview is a multi-section metadata file, not a flat CSV.
  // Parse key-value pairs and summary sections.
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  let metricsStored = 0;

  const metricMap: Record<string, { category: string; key: string }> = {
    'total urls': { category: 'crawl', key: 'total_urls' },
    'total urls crawled': { category: 'crawl', key: 'urls_crawled' },
    'total internal urls': { category: 'crawl', key: 'internal_urls' },
    'total external urls': { category: 'crawl', key: 'external_urls' },
  };

  for (const line of lines) {
    // Look for "Summary,URLs,% of Total" pattern or key-value pairs
    const parts = line.split(',').map(s => s.trim().replace(/^"|"$/g, ''));

    if (parts.length >= 2) {
      const label = parts[0].toLowerCase();
      const value = parseFloat(parts[1]);

      if (!isNaN(value)) {
        // Check if it's a known metric
        for (const [pattern, meta] of Object.entries(metricMap)) {
          if (label.includes(pattern)) {
            await turso.execute({
              sql: `INSERT OR REPLACE INTO metrics (id, client_id, month, category, metric_key, metric_value, source, csv_upload_id)
                    VALUES (?, ?, ?, ?, ?, ?, 'csv_upload', ?)
                    ON CONFLICT(client_id, month, category, metric_key)
                    DO UPDATE SET metric_value = excluded.metric_value, csv_upload_id = excluded.csv_upload_id`,
              args: [nanoid(), clientId, month, meta.category, meta.key, value, uploadId],
            });
            metricsStored++;
            break;
          }
        }

        // Capture HTML, JavaScript, CSS, Image counts
        if (label === 'html' || label === 'javascript' || label === 'css' || label === 'images') {
          await turso.execute({
            sql: `INSERT OR REPLACE INTO metrics (id, client_id, month, category, metric_key, metric_value, source, csv_upload_id)
                  VALUES (?, ?, ?, 'crawl', ?, ?, 'csv_upload', ?)
                  ON CONFLICT(client_id, month, category, metric_key)
                  DO UPDATE SET metric_value = excluded.metric_value, csv_upload_id = excluded.csv_upload_id`,
            args: [nanoid(), clientId, month, `resource_${label}`, value, uploadId],
          });
          metricsStored++;
        }
      }
    }
  }

  return metricsStored;
}
