import { compareCodeUnits, hashCanonical } from '../core/canonical.js';
import type { Diagnostic } from '../core/diagnostics.js';
import type { ScannedFile } from '../core/scanner.js';
import { parseClausewitz } from '../core/source/index.js';
import { GUI_POINT_BLOCK_KEYS, guiElementKeyUses, type GuiElementKeyUse } from './source-graph.js';

/**
 * Which keys the game's GUI loader parses on each element type and inside each of its nested
 * blocks (issue 220). The game refuses a key it does not parse there ("Unexpected token: size"
 * for `size` on an `iconType`, `alwaystransparent` on a `containerWindowType`,
 * `quadTextureSprite` inside a `scrollbarType`'s `slider`), refuses `width` and `height` where it
 * reads `x` and `y` ("Malformed token: height"), and loads the element without them, so the
 * window lays out differently in game than the source asks.
 *
 * The allowed keys are evidence, not a guess: the keys the installed game's own `.gui` files
 * write at the same place (element type and enclosing blocks), from the game and DLC roots, plus
 * {@link ACCEPTED_UNUSED_KEYS}, keys the game is known to accept although its own files never
 * write them. A place the game's files never use is not checked. A key the game accepts but never
 * writes itself would be reported wrongly; add it to {@link ACCEPTED_UNUSED_KEYS} with evidence.
 */
export interface GuiEngineKeyInventory {
  /** Content revision of the game `.gui` files the inventory was read from. */
  revision: string;
  fileCount: number;
  /** {@link placeKey} to the lowercase keys written there. */
  keys: ReadonlyMap<string, ReadonlySet<string>>;
  /** The subset of {@link keys} the game's files write as a block (`slider = { ... }`). */
  blockKeys: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Keys the game accepts at a place ({@link placeKey}) although its own files never write them. */
const ACCEPTED_UNUSED_KEYS: Readonly<Record<string, readonly string[]>> = {};

const INVENTORY_CACHE_ENTRIES = 2;
const inventories = new Map<string, GuiEngineKeyInventory>();

/** `icontype` for a key on an iconType, `scrollbartype/slider` inside its slider block. */
export function placeKey(elementType: string, parents: readonly string[]): string {
  return [elementType, ...parents].map((part) => part.toLowerCase()).join('/');
}

/** The inventory of the game's own `.gui` files, cached by their content. */
export function guiEngineKeyInventory(
  gameFiles: readonly ScannedFile[],
): GuiEngineKeyInventory | undefined {
  const files = gameFiles
    .filter(
      ({ rootKind, relativePath, shadowedBy }) =>
        (rootKind === 'game' || rootKind === 'dlc') &&
        shadowedBy === undefined &&
        relativePath.toLowerCase().endsWith('.gui'),
    )
    .sort((left, right) => compareCodeUnits(left.displayPath, right.displayPath));
  if (files.length === 0) return undefined;
  const revision = hashCanonical(files.map(({ displayPath, sha256 }) => [displayPath, sha256]));
  const cached = inventories.get(revision);
  if (cached !== undefined) return cached;
  const keys = new Map<string, Set<string>>();
  const blockKeys = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, place: string, key: string) => {
    let written = map.get(place);
    if (written === undefined) map.set(place, (written = new Set()));
    written.add(key);
  };
  for (const file of files)
    for (const use of guiElementKeyUses(parseClausewitz(file.bytes, file.displayPath))) {
      if (use.bareWord === true) continue;
      const place = placeKey(use.elementType, use.parents);
      add(keys, place, use.key.toLowerCase());
      if (use.block) add(blockKeys, place, use.key.toLowerCase());
    }
  for (const [place, accepted] of Object.entries(ACCEPTED_UNUSED_KEYS)) {
    const written = keys.get(place);
    if (written !== undefined) for (const key of accepted) written.add(key.toLowerCase());
  }
  const inventory = { revision, fileCount: files.length, keys, blockKeys };
  inventories.set(revision, inventory);
  while (inventories.size > INVENTORY_CACHE_ENTRIES) {
    const oldest = inventories.keys().next().value;
    if (oldest === undefined) break;
    inventories.delete(oldest);
  }
  return inventory;
}

interface ElementPosition {
  path: string;
  start: { line: number; column: number };
}

function elementKey(name: string, { path, start }: ElementPosition): string {
  return `${path}\0${name}\0${start.line}:${start.column}`;
}

function written(use: GuiElementKeyUse): string {
  return [...use.parents, use.key].join('.');
}

/**
 * `GUI_KEY_REFUSED_BY_ENGINE` for each key that an element of the mod's own files writes where
 * the game does not parse it, and `GUI_VALUE_MALFORMED` for a coordinate the game does not read
 * in a point block (`width` where it reads `x`, or a bare word). The children of a refused key
 * are not reported again. Only the given elements are checked (by source path, name and
 * location), and only files outside the installed game, which defines the inventory.
 */
export function guiEngineKeyDiagnostics(
  files: readonly ScannedFile[],
  elements: readonly { name: string; sourcePath: string; location?: ElementPosition }[],
  inventory: GuiEngineKeyInventory | undefined,
): Diagnostic[] {
  if (inventory === undefined) return [];
  const selected = new Set(
    elements.flatMap(({ name, location }) =>
      location === undefined ? [] : [elementKey(name, location)],
    ),
  );
  const sourcePaths = new Set(elements.map(({ sourcePath }) => sourcePath));
  const diagnostics: Diagnostic[] = [];
  for (const file of files) {
    if (
      file.rootKind === 'game' ||
      file.rootKind === 'dlc' ||
      file.shadowedBy !== undefined ||
      !sourcePaths.has(file.displayPath) ||
      !file.relativePath.toLowerCase().endsWith('.gui')
    )
      continue;
    const refused = new Set<string>();
    for (const use of guiElementKeyUses(parseClausewitz(file.bytes, file.displayPath))) {
      const element = elementKey(use.elementName, use.elementLocation);
      if (!selected.has(element)) continue;
      if (
        use.parents.some((_, index) =>
          refused.has(`${element}\0${use.parents.slice(0, index + 1).join('.')}`),
        )
      )
        continue;
      const pointBlock =
        use.parents.length > 0 && GUI_POINT_BLOCK_KEYS.has(use.parents.at(-1)!.toLowerCase());
      const place = placeKey(use.elementType, use.parents);
      const allowed = inventory.keys.get(place);
      const key = use.key.toLowerCase();
      // A block where the game's files only ever write a value: a scrollbarType's
      // `slider = "button name"` written as `slider = { ... }`.
      const blockForValue =
        use.block &&
        allowed?.has(key) === true &&
        inventory.blockKeys.get(place)?.has(key) !== true;
      const unread =
        use.bareWord === true || (allowed !== undefined && !allowed.has(key)) || blockForValue;
      if (!unread) continue;
      refused.add(`${element}\0${written(use)}`);
      const details = {
        elementType: use.elementType,
        elementName: use.elementName,
        key: written(use),
        evidence: 'installed-game-gui-files',
        gameFileCount: inventory.fileCount,
      };
      const where =
        use.parents.length === 0
          ? `${use.elementType} ${use.elementName}`
          : `${use.parents.join('.')} of ${use.elementType} ${use.elementName}`;
      if (blockForValue) {
        diagnostics.push({
          code: 'GUI_KEY_REFUSED_BY_ENGINE',
          severity: 'error',
          category: 'syntax',
          message: `${where} writes ${use.key} as a block, but every ${use.elementType} in the installed game's interface files writes ${use.key} = <value> there (for a scrollbarType, the name of a guiButtonType child). The game refuses the block's contents and loads the element without them.`,
          location: use.location,
          details: { ...details, expectedValue: 'scalar' },
        });
        continue;
      }
      if (pointBlock) {
        const expected = [...(allowed ?? [])].sort(compareCodeUnits);
        diagnostics.push({
          code: 'GUI_VALUE_MALFORMED',
          severity: 'error',
          category: 'syntax',
          message: `${where} writes ${use.key}${use.bareWord === true ? ' without a value' : ''}, which the game does not read there${expected.length === 0 ? '' : `; the game's own files write ${expected.join(' and ')}`}. The game reports "Malformed token: ${use.key}" and ignores it.`,
          location: use.location,
          details: { ...details, ...(expected.length === 0 ? {} : { expectedKeys: expected }) },
        });
        continue;
      }
      diagnostics.push({
        code: 'GUI_KEY_REFUSED_BY_ENGINE',
        severity: 'error',
        category: 'syntax',
        message: `${where} has ${use.key}, which no ${use.elementType} in the installed game's interface files writes ${use.parents.length === 0 ? 'on the element' : `in ${use.parents.join('.')}`}. The game refuses a key it does not parse there ("Unexpected token: ${use.key}" in error.log) and loads the element without it.`,
        location: use.location,
        details,
      });
    }
  }
  return diagnostics;
}
