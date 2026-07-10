import { z } from 'zod/v4';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export function isSafeAnimationSourcePath(value: string): boolean {
  if (value.length === 0 || value.includes('\0') || value.includes('\\')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/u.test(value)) return false;
  if (['*', '?', '[', ']', '{', '}', '(', ')', '!'].some((character) => value.includes(character)))
    return false;
  return !value.split('/').some((segment) => segment.length === 0 || segment === '..');
}

const workspacePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    isSafeAnimationSourcePath,
    'Expected a safe workspace-relative path using forward slashes',
  );

const anchorSchema = z
  .object({
    x: z.number().min(0),
    y: z.number().min(0),
  })
  .strict();

export const GuiAnimationSourceManifestSchema = z
  .object({
    $schema: z.string().optional(),
    schemaVersion: z.literal(1),
    projectOwned: z.literal(true),
    sprite: z.string().min(1).max(256),
    sheet: z
      .object({
        path: workspacePathSchema,
        sha256: hashSchema,
        frameWidth: z.number().int().positive().max(16_384),
        frameHeight: z.number().int().positive().max(16_384),
      })
      .strict(),
    sourceFrames: z
      .array(
        z
          .object({
            path: workspacePathSchema,
            sha256: hashSchema,
            anchor: anchorSchema,
          })
          .strict(),
      )
      .min(2)
      .max(1024),
    animation: z
      .object({
        frameCount: z.number().int().min(2).max(1024),
        rateFps: z.number().positive().max(10_000),
        looping: z.boolean(),
        playOnShow: z.boolean(),
        pauseOnLoop: z.number().min(0).max(86_400).optional(),
      })
      .strict(),
    staticFallback: z
      .object({
        sprite: z.string().min(1).max(256),
        path: workspacePathSchema,
        sha256: hashSchema,
        frameIndex: z.number().int().min(0).max(1023),
      })
      .strict(),
  })
  .strict();

export type GuiAnimationSourceManifestDocument = z.infer<typeof GuiAnimationSourceManifestSchema>;
