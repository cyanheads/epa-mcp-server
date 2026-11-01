/**
 * @fileoverview Renders raw enrichment notices as literal Markdown blockquotes.
 * @module mcp-server/tools/format-notice
 */
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

/** Quote every line without changing the notice stored in structuredContent. */
export function formatNotice(notice: string): string {
  return `> ${escapeMarkdownInline(notice).replaceAll('\n', '\n> ')}`;
}
