/**
 * Collect the map reliability campaign's images from Wikimedia Commons (request ZR-4).
 *
 * Every Commons file carries a free licence in its metadata, which the manifest records with the
 * source page, author and SHA-256. Images are stored outside git (default `.tmp/map-campaign`),
 * one folder per image, and are read only as image data. The selection is deterministic: files
 * of each category sorted by title and picked at even spacing, so a rerun selects the same set.
 *
 * Usage: tsx scripts/map-campaign/collect.ts [--store <dir>] [--manifest <file>] [--dry-run]
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import { CAMPAIGN_CATEGORIES, type CampaignCategory } from './categories.js';
import { manifestSchema, type ManifestEntry } from './manifest.js';

const API = 'https://commons.wikimedia.org/w/api.php';
const USER_AGENT =
  'hoi4-agent-tools-map-campaign/0.1 (https://github.com/klimPaskov/hoi4-agent-tools)';
const MAX_BYTES = 100 * 1024 * 1024;
const ACCEPTED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

const imageInfoSchema = z.object({
  url: z.string(),
  descriptionurl: z.string(),
  size: z.number(),
  width: z.number(),
  height: z.number(),
  mime: z.string(),
  sha1: z.string(),
  extmetadata: z
    .record(z.string(), z.object({ value: z.unknown() }).loose())
    .optional()
    .default({}),
});
const pageSchema = z.object({
  title: z.string(),
  imageinfo: z.array(imageInfoSchema).optional(),
});
const responseSchema = z.object({
  continue: z.record(z.string(), z.string()).optional(),
  query: z.object({ pages: z.record(z.string(), pageSchema) }).optional(),
});

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function plainText(value: unknown): string {
  return (typeof value === 'string' ? value : '')
    .replace(/<[^>]*>/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 300);
}

function metadata(info: z.infer<typeof imageInfoSchema>, key: string): string {
  return plainText(info.extmetadata[key]?.value);
}

async function api(parameters: Record<string, string>): Promise<z.infer<typeof responseSchema>> {
  const url = new URL(API);
  for (const [key, value] of Object.entries({ ...parameters, format: 'json' })) {
    url.searchParams.set(key, value);
  }
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (response.ok) return responseSchema.parse(await response.json());
    if (attempt >= 3) throw new Error(`Commons API ${response.status} for ${url.toString()}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
  }
}

async function categoryFiles(category: CampaignCategory): Promise<
  {
    title: string;
    info: z.infer<typeof imageInfoSchema>;
  }[]
> {
  const files: { title: string; info: z.infer<typeof imageInfoSchema> }[] = [];
  let next: Record<string, string> = {};
  do {
    const page = await api({
      action: 'query',
      generator: 'categorymembers',
      gcmtitle: `Category:${category.name}`,
      gcmtype: 'file',
      gcmlimit: '200',
      prop: 'imageinfo',
      iiprop: 'url|size|mime|sha1|extmetadata',
      iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|UsageTerms',
      ...next,
    });
    for (const entry of Object.values(page.query?.pages ?? {})) {
      const info = entry.imageinfo?.[0];
      if (info !== undefined) files.push({ title: entry.title, info });
    }
    next = page.continue ?? {};
  } while (Object.keys(next).length > 0 && files.length < 2_000);
  return files.sort((left, right) =>
    left.title < right.title ? -1 : left.title > right.title ? 1 : 0,
  );
}

function evenlySpaced<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  return Array.from(
    { length: count },
    (_, index) => items[Math.floor((index * items.length) / count)]!,
  );
}

function slug(value: string): string {
  return value
    .replace(/^File:/u, '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 60);
}

async function download(url: string): Promise<Buffer> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (response.ok) return Buffer.from(await response.arrayBuffer());
    if (attempt >= 3) throw new Error(`Download ${response.status} for ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 3_000 * (attempt + 1)));
  }
}

async function main(): Promise<void> {
  const store = path.resolve(option('--store') ?? '.tmp/map-campaign');
  const manifestPath = path.resolve(
    option('--manifest') ?? 'docs/plans/map-campaign/manifest.json',
  );
  const dryRun = process.argv.includes('--dry-run');
  const previous = await readFile(manifestPath, 'utf8')
    .then((text) => manifestSchema.parse(JSON.parse(text)).maps)
    .catch(() => [] as ManifestEntry[]);
  const known = new Map(previous.map((entry) => [entry.id, entry]));
  const entries: ManifestEntry[] = [];
  const seen = new Set<string>();

  for (const category of CAMPAIGN_CATEGORIES) {
    const candidates = (await categoryFiles(category)).filter(
      ({ info }) =>
        ACCEPTED_MIME.has(info.mime) &&
        info.size <= MAX_BYTES &&
        info.width >= 64 &&
        info.height >= 64 &&
        metadata(info, 'LicenseShortName').length > 0 &&
        !seen.has(info.sha1),
    );
    const chosen = evenlySpaced(candidates, category.count);
    process.stderr.write(
      `${category.name}: ${candidates.length} usable files, ${chosen.length} chosen\n`,
    );
    for (const { title, info } of chosen) {
      seen.add(info.sha1);
      const id = `${category.key}-${slug(title)}`;
      const extension =
        info.mime === 'image/png' ? 'png' : info.mime === 'image/webp' ? 'webp' : 'jpg';
      const relative = path.posix.join(id, `source.${extension}`);
      let sha256 = known.get(id)?.sha256;
      if (!dryRun) {
        const target = path.join(store, 'maps', relative);
        const existing = await readFile(target).catch(() => undefined);
        const bytes =
          existing !== undefined && createHash('sha256').update(existing).digest('hex') === sha256
            ? existing
            : await download(info.url);
        if (createHash('sha1').update(bytes).digest('hex') !== info.sha1) {
          throw new Error(`SHA-1 mismatch for ${title}`);
        }
        sha256 = createHash('sha256').update(bytes).digest('hex');
        await mkdir(path.dirname(target), { recursive: true });
        if (existing?.length !== bytes.length) await writeFile(target, bytes);
      }
      entries.push({
        id,
        category: category.key,
        title: title.replace(/^File:/u, ''),
        page: info.descriptionurl,
        url: info.url,
        licence: metadata(info, 'LicenseShortName'),
        licenceUrl: metadata(info, 'LicenseUrl'),
        author: metadata(info, 'Artist'),
        mime: info.mime as ManifestEntry['mime'],
        width: info.width,
        height: info.height,
        bytes: info.size,
        sha256: sha256 ?? '',
        file: relative,
      });
    }
  }

  const manifest = manifestSchema.parse({
    version: 1,
    source: 'Wikimedia Commons',
    note: 'Images are stored outside git. Redistribution follows each licence; only redistributable files may become fixtures, with attribution.',
    maps: entries,
  });
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stderr.write(`${entries.length} maps in ${manifestPath}\n`);
}

await main();
