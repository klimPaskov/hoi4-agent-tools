/**
 * Overland reach of each realm through impassable land (ZR-28). Impassable states and impassable
 * adjacency rows make a strategic board, but they can also cut a realm in two or box it in by
 * accident. This compares two graphs of land provinces joined by shared borders and `sea`
 * crossings: one with every province and border, and one without the impassable provinces and
 * the blocked borders. Whatever the first joins and the second separates was cut by impassable
 * land; islands, which neither graph joins, are never reported.
 */

export interface ReachInput {
  /** Province kind per index: 1 land. */
  kind: ArrayLike<number>;
  neighbors: readonly ReadonlySet<number>[];
  /** Land provinces in impassable states. */
  impassable: ReadonlySet<number>;
  /** Province index pairs an impassable adjacency row blocks. */
  blocked: ReadonlyArray<readonly [number, number]>;
  /** Province index pairs a `sea` crossing joins. */
  crossings: ReadonlyArray<readonly [number, number]>;
  /** Owning realm per land province index. */
  owner: ReadonlyMap<number, number>;
  /** Capital province index per realm. */
  capitals: readonly number[];
  tags: readonly string[];
}

export interface ReachNote {
  code: 'MAP_REALM_CUT_OFF' | 'MAP_REALM_ENCLOSED';
  severity: 'warning';
  message: string;
  details: Record<string, unknown>;
}

function components(
  count: number,
  include: (id: number) => boolean,
  edges: (id: number) => Iterable<number>,
): Int32Array {
  const label = new Int32Array(count).fill(-1);
  let next = 0;
  for (let start = 0; start < count; start += 1) {
    if (label[start] !== -1 || !include(start)) continue;
    const queue = [start];
    label[start] = next;
    // The array iterator also visits provinces queued during the loop.
    for (const id of queue)
      for (const other of edges(id))
        if (label[other] === -1 && include(other)) {
          label[other] = next;
          queue.push(other);
        }
    next += 1;
  }
  return label;
}

export function realmReachNotes(input: ReachInput): ReachNote[] {
  const count = input.kind.length;
  const key = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const blocked = new Set(input.blocked.map(([a, b]) => key(a, b)));
  const linked: Array<number[] | undefined> = [];
  for (const [a, b] of input.crossings) {
    (linked[a] ??= []).push(b);
    (linked[b] ??= []).push(a);
  }
  const land = (id: number) => input.kind[id] === 1;
  const everything = components(count, land, (id) => [
    ...input.neighbors[id]!,
    ...(linked[id] ?? []),
  ]);
  const passable = components(
    count,
    (id) => land(id) && !input.impassable.has(id),
    (id) =>
      [...input.neighbors[id]!, ...(linked[id] ?? [])].filter(
        (other) => !blocked.has(key(id, other)),
      ),
  );
  const notes: ReachNote[] = [];
  for (const [realm, capital] of input.capitals.entries()) {
    const tag = input.tags[realm] ?? String(realm);
    const home = passable[capital]!;
    const cut: number[] = [];
    for (const [id, owner] of input.owner)
      if (
        owner === realm &&
        !input.impassable.has(id) &&
        passable[id] !== home &&
        everything[id] === everything[capital]
      )
        cut.push(id);
    if (cut.length > 0)
      notes.push({
        code: 'MAP_REALM_CUT_OFF',
        severity: 'warning',
        message: `${cut.length} land province(s) of ${tag} are cut off from its capital by impassable land or borders; open a pass or give them to a realm on their side`,
        details: { tag, provinces: cut.length, sample: cut.slice(0, 10).map((id) => id + 1) },
      });
    // Boxed in: the land around the capital reaches another realm only through impassable land.
    let foreignBefore = false;
    let foreignAfter = false;
    for (const [id, owner] of input.owner) {
      if (owner === realm) continue;
      if (everything[id] === everything[capital]) foreignBefore = true;
      if (passable[id] === home) foreignAfter = true;
    }
    if (foreignBefore && !foreignAfter)
      notes.push({
        code: 'MAP_REALM_ENCLOSED',
        severity: 'warning',
        message: `${tag} reaches no other realm over land: impassable land or borders close every way out of the land around its capital`,
        details: { tag, capitalProvince: capital + 1 },
      });
  }
  return notes;
}
