import turso from '../../turso';

// Parallel-chunked INSERT to stay under the Cloudflare 100s edge timeout on
// a fronted POST. Row-by-row `await turso.execute` blows the budget at a few
// hundred rows (a 2,118-row Ubersuggest domain export 524'd outright); 50 in
// parallel chunks finishes 1,000+ rows in well under 10s. Same approach as
// ga4.ts's local bulkInsert, shared here for the keyword parsers.
export const INSERT_BATCH = 50;

export async function bulkInsert(sql: string, allArgs: any[][]): Promise<void> {
  for (let i = 0; i < allArgs.length; i += INSERT_BATCH) {
    const chunk = allArgs.slice(i, i + INSERT_BATCH);
    await Promise.all(chunk.map(args => turso.execute({ sql, args })));
  }
}
