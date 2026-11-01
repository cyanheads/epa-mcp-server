/**
 * @fileoverview The page shape list-returning service methods return, and the slice of a sorted list.
 * @module services/page
 */

/** One page of an upstream list. */
export interface Page<T> {
  items: T[];
  /**
   * Offset of the next page, present exactly when more records follow. It is an upstream or
   * candidate position, so it can advance past rows this page dropped after the read.
   */
  nextOffset?: number;
  /** Records matched before limit and offset, when the upstream reports the full match. */
  totalCount?: number;
}

/** The part of a sorted list a page returns. */
export interface ListSlice {
  limit: number;
  offset: number;
}

/** `slice` of an already sorted list, with the list's length and the offset that continues it. */
export function slicePage<T>(
  sorted: readonly T[],
  { limit, offset }: ListSlice,
): Page<T> & { totalCount: number } {
  const end = offset + limit;
  return {
    items: sorted.slice(offset, end),
    totalCount: sorted.length,
    ...(end < sorted.length && { nextOffset: end }),
  };
}
