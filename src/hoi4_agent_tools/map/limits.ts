/** Fixed memory/work ceilings for exact map geometry operations. */

/** Maximum decoded cells in a canonical one-byte raster-mask payload. */
export const MAP_MASK_CELL_LIMIT = 20_000_000;

/**
 * Maximum pixels one operation may select or recolor. Selection is retained as
 * four-byte numeric offsets, so the operation-owned offset buffer stays at or
 * below 4 MiB instead of allocating millions of coordinate/color objects.
 */
export const MAP_SELECTED_PIXEL_LIMIT = 1_000_000;

/** Maximum polygon cell/edge comparisons before rasterization is refused. */
export const MAP_POLYGON_WORK_LIMIT = 50_000_000;

export const MAP_SELECTED_OFFSET_BYTES = Uint32Array.BYTES_PER_ELEMENT;
