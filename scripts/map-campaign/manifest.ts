import { z } from 'zod/v4';

/** One campaign image: where it came from, under which licence, and the bytes it must have. */
export const manifestEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,80}$/u),
    category: z.string().min(1),
    title: z.string().min(1),
    page: z.url(),
    url: z.url(),
    licence: z.string().min(1),
    licenceUrl: z.string(),
    author: z.string(),
    mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^([a-f0-9]{64})?$/u),
    file: z.string().regex(/^[a-z0-9-]+\/source\.(png|jpg|webp)$/u),
  })
  .strict();
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;

export const manifestSchema = z
  .object({
    version: z.literal(1),
    source: z.string(),
    note: z.string(),
    maps: z.array(manifestEntrySchema),
  })
  .strict();
export type Manifest = z.infer<typeof manifestSchema>;
