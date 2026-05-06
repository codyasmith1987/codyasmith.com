import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const baseFields = {
  title: z.string(),
  seoTitle: z.string().optional(),
  description: z.string(),
  dek: z.string().optional(),
  publishDate: z.coerce.date(),
  updated: z.coerce.date().optional(),
  draft: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  cover: z
    .object({
      src: z.string(),
      alt: z.string(),
      credit: z.string().optional(),
    })
    .optional(),
};

const articles = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/articles' }),
  schema: z.object({
    ...baseFields,
    series: z
      .object({
        name: z.string(),
        order: z.number().int().positive(),
      })
      .optional(),
  }),
});

const caseStudies = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/case-studies' }),
  schema: z.object({
    ...baseFields,
    client: z.string(),
    clientAnonymized: z.boolean().default(false),
    sector: z.string(),
    role: z.string(),
    duration: z.object({
      start: z.coerce.date(),
      end: z.coerce.date().optional(),
    }),
    problem: z.string(),
    approach: z.string(),
    outcome: z.string(),
    metrics: z
      .array(
        z.object({
          label: z.string(),
          value: z.string(),
          direction: z.enum(['up', 'down', 'neutral']).default('neutral'),
          context: z.string().optional(),
        })
      )
      .default([]),
    services: z.array(z.string()).default([]),
    gallery: z
      .array(
        z.object({
          src: z.string(),
          alt: z.string(),
          credit: z.string().optional(),
        })
      )
      .optional(),
  }),
});

export const collections = { articles, caseStudies };
