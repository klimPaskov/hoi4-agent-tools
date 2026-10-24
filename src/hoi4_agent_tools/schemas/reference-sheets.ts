import { z } from 'zod/v4';
import { workspaceRelativePathSchema } from './common.js';

/** Bounds of a sheet document (ADR 0067). */
export const REFERENCE_SHEETS_SOURCE_MAX_BYTES = 1_048_576;
export const REFERENCE_SHEETS_MAX = 64;
export const REFERENCE_SHEET_CLIP_MAX_VERTICES = 512;

const unit = z.number().min(0).max(1);
const finite = z.number().refine(Number.isFinite, 'Must be a finite number');
const pointSchema = z.tuple([unit, unit]);

/**
 * One drawn sheet: the part of the picture it occupies (`box`, optionally cut by `clip`), and the
 * map from picture to world, `world = target + scale * (picture - anchor)` per axis, or a general
 * affine `[a, b, c, d, e, f]` with `x' = a x + b y + c`, `y' = d x + e y + f`. Picture coordinates
 * are normalised to the picture, world coordinates to the output frame; a negative scale mirrors.
 */
export const referenceSheetSchema = z
  .object({
    id: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u)
      .describe('Unique sheet id, named in diagnostics and artifacts.'),
    box: z
      .tuple([unit, unit, unit, unit])
      .refine(([left, top, right, bottom]) => right > left && bottom > top, {
        message: 'box is [left, top, right, bottom] with right > left and bottom > top',
      })
      .describe('[left, top, right, bottom] of the sheet in normalised picture coordinates.'),
    clip: z
      .array(pointSchema)
      .min(3)
      .max(REFERENCE_SHEET_CLIP_MAX_VERTICES)
      .optional()
      .describe(
        'Polygon in picture coordinates that cuts the sheet out of its box, so a neighbouring sheet inside the box is not pulled in.',
      ),
    anchor: z.tuple([unit, unit]).optional().describe('Picture point that maps to target.'),
    target: z.tuple([finite, finite]).optional().describe('World point of the anchor.'),
    scale: z
      .tuple([finite, finite])
      .refine(([x, y]) => x !== 0 && y !== 0, 'scale must not be zero')
      .optional()
      .describe('World units per picture unit along x and y; a negative value mirrors.'),
    affine: z
      .tuple([finite, finite, finite, finite, finite, finite])
      .optional()
      .describe(
        'General map [a, b, c, d, e, f] from picture to world, instead of anchor, target and scale.',
      ),
    order: z
      .number()
      .int()
      .min(0)
      .max(1_000)
      .default(0)
      .describe(
        'Where targets overlap the higher order wins; equal orders that overlap are an error.',
      ),
  })
  .strict()
  .refine(
    (sheet) =>
      (sheet.affine === undefined) ===
        (sheet.anchor !== undefined && sheet.target !== undefined && sheet.scale !== undefined) &&
      (sheet.affine !== undefined || sheet.anchor !== undefined),
    { message: 'Give either anchor, target and scale, or affine' },
  );

export const referenceSheetsDocumentSchema = z
  .object({
    version: z.literal(1),
    source: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .optional(),
      })
      .strict()
      .optional()
      .describe(
        'The picture these registrations were made for; a picture of another size or hash is refused.',
      ),
    fill: z
      .enum(['sea', 'error'])
      .default('sea')
      .describe('What world pixels outside every sheet become: open sea, or an error.'),
    sheets: z.array(referenceSheetSchema).min(1).max(REFERENCE_SHEETS_MAX),
  })
  .strict()
  .superRefine((document, context) => {
    const seen = new Set<string>();
    for (const [index, sheet] of document.sheets.entries()) {
      if (seen.has(sheet.id))
        context.addIssue({
          code: 'custom',
          path: ['sheets', index, 'id'],
          message: `Duplicate sheet id ${sheet.id}`,
        });
      seen.add(sheet.id);
    }
  })
  .describe(
    'Registration of a drawn picture made of sheets onto the world frame (ADR 0067). Coordinates are normalised: picture coordinates to the picture, world coordinates to width x height.',
  );

export const referenceSheetsPathSchema = workspaceRelativePathSchema.refine(
  (value) => !value.includes(':') && /\.json$/iu.test(value),
  'Sheets must be a workspace-relative .json file',
);

export type ReferenceSheetInput = z.infer<typeof referenceSheetSchema>;
export type ReferenceSheetsDocument = z.infer<typeof referenceSheetsDocumentSchema>;
