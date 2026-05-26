/**
 * @fileoverview Barrel export for all EPA MCP server resource definitions.
 * @module mcp-server/resources/definitions/index
 */

export { facilityResource } from './facility.resource.js';
export { superfundSiteResource } from './superfund-site.resource.js';

import { facilityResource } from './facility.resource.js';
import { superfundSiteResource } from './superfund-site.resource.js';

export const allResourceDefinitions = [facilityResource, superfundSiteResource] as const;
