/**
 * @fileoverview One wall-clock budget for a service call that chains upstream requests, shared by
 * every request, retry, and backoff the call makes.
 * @module services/call-budget
 */

import { McpError, timeout } from '@cyanheads/mcp-ts-core/errors';

/** The budget a service call threads through each of its requests. */
export type CallBudget = {
  /** What is left of the budget, for a request's `withRetry` `deadlineMs`. */
  remainingMs: () => number;
  /**
   * Restates an expired budget as one Timeout naming the call and how to narrow it; any other
   * error, caller cancellation included, passes through unchanged.
   */
  rethrow: (error: unknown) => never;
};

/**
 * Start a `deadlineMs` budget for one call to `upstream`. An expiry reads
 * "`{upstream}` did not finish the `{task}` within N seconds. `{narrow}`", since the framework's
 * own message reports only the expiring request's remaining milliseconds.
 */
export function callBudget(
  upstream: string,
  task: string,
  deadlineMs: number,
  narrow: string,
): CallBudget {
  const startedAt = Date.now();
  return {
    remainingMs: () => Math.max(0, deadlineMs - (Date.now() - startedAt)),
    rethrow: (error: unknown): never => {
      if (error instanceof McpError && error.data?.reason === 'retry_deadline_exceeded') {
        throw timeout(
          `${upstream} did not finish the ${task} within ${deadlineMs / 1000} seconds. ${narrow}`,
          {
            reason: 'retry_deadline_exceeded',
            deadlineMs,
            elapsedMs: Date.now() - startedAt,
          },
          { cause: error },
        );
      }
      throw error;
    },
  };
}
