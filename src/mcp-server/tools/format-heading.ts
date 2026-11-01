/**
 * @fileoverview Preserve upstream text within a single Markdown heading.
 * @module mcp-server/tools/format-heading
 */
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

/** Encode line breaks as entities because ATX headings cannot span source lines. */
export function formatHeading(value: string): string {
  return escapeMarkdownInline(value).replaceAll('\\\n', '&#10;');
}
