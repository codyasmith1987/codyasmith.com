import { getCollection, type CollectionEntry } from 'astro:content';

export type ArticleEntry = CollectionEntry<'articles'>;
export type CaseStudyEntry = CollectionEntry<'caseStudies'>;
export type BlogEntry = ArticleEntry | CaseStudyEntry;

export type UnifiedEntry = {
  kind: 'article' | 'case-study';
  slug: string;
  href: string;
  data: BlogEntry['data'];
  entry: BlogEntry;
};

const WORDS_PER_MINUTE = 220;

export function readingTime(body: string | undefined): number {
  if (!body) return 1;
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatMonthYear(d: Date): string {
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
}

function isPublished<T extends { data: { draft: boolean; publishDate: Date } }>(e: T): boolean {
  if (e.data.draft) return false;
  return e.data.publishDate.getTime() <= Date.now();
}

export async function getArticles(): Promise<ArticleEntry[]> {
  const all = await getCollection('articles');
  return all
    .filter(isPublished)
    .sort((a, b) => b.data.publishDate.getTime() - a.data.publishDate.getTime());
}

export async function getCaseStudies(): Promise<CaseStudyEntry[]> {
  const all = await getCollection('caseStudies');
  return all
    .filter(isPublished)
    .sort((a, b) => b.data.publishDate.getTime() - a.data.publishDate.getTime());
}

export async function getAllEntries(): Promise<UnifiedEntry[]> {
  const [articles, caseStudies] = await Promise.all([getArticles(), getCaseStudies()]);
  const unified: UnifiedEntry[] = [
    ...articles.map((e) => ({
      kind: 'article' as const,
      slug: e.id,
      href: `/blog/articles/${e.id}`,
      data: e.data,
      entry: e,
    })),
    ...caseStudies.map((e) => ({
      kind: 'case-study' as const,
      slug: e.id,
      href: `/blog/case-studies/${e.id}`,
      data: e.data,
      entry: e,
    })),
  ];
  return unified.sort((a, b) => b.data.publishDate.getTime() - a.data.publishDate.getTime());
}

export async function getAllTags(): Promise<Array<{ tag: string; count: number }>> {
  const entries = await getAllEntries();
  const counts = new Map<string, number>();
  for (const e of entries) {
    for (const tag of e.data.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export function tagSlug(tag: string): string {
  return tag
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export async function getEntriesByTag(slug: string): Promise<UnifiedEntry[]> {
  const entries = await getAllEntries();
  return entries.filter((e) => e.data.tags.some((t) => tagSlug(t) === slug));
}

export function relatedByTags(
  current: UnifiedEntry,
  all: UnifiedEntry[],
  n = 3
): UnifiedEntry[] {
  const currentTags = new Set(current.data.tags);
  if (currentTags.size === 0) return [];
  const scored = all
    .filter((e) => e.href !== current.href)
    .map((e) => {
      const overlap = e.data.tags.filter((t) => currentTags.has(t)).length;
      return { entry: e, overlap };
    })
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || b.entry.data.publishDate.getTime() - a.entry.data.publishDate.getTime());
  return scored.slice(0, n).map((s) => s.entry);
}
