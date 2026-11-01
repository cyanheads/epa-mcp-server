/**
 * @fileoverview Tests for the effectiveQuery echo builder.
 * @module tests/mcp-server/tools/effective-query.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import {
  beginsWithTerm,
  containsTerm,
  echoQuery,
  equalsTerm,
} from '@/mcp-server/tools/effective-query.js';

describe('echoQuery', () => {
  it('joins the terms that applied with "; " and skips filters the call did not send', () => {
    const ctx = createMockContext();
    echoQuery(ctx, [
      equalsTerm('state', 'WA'),
      undefined,
      containsTerm('county', 'KING'),
      false,
      beginsWithTerm('zip_code', '98108'),
      equalsTerm('year', 2022),
    ]);
    expect(getEnrichment(ctx).effectiveQuery).toBe(
      'state=WA; county contains KING; zip_code begins with 98108; year=2022',
    );
  });

  it('writes an empty echo when no term applied', () => {
    const ctx = createMockContext();
    echoQuery(ctx, [undefined, false]);
    expect(getEnrichment(ctx).effectiveQuery).toBe('');
  });
});
