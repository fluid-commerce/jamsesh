// Who is writing: work that began in a request carries that request's context through every await, timer and job it starts.
// Shutdown sets a deadline for the room; past it, anything carrying a request's context is over (its writes are dropped or
// refused at the store and the vault), wherever it resumes. Shutdown's own work, and the room's own timers, carry none.
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  /** True once the room's shutdown deadline has passed. */
  over(): boolean;
}

const als = new AsyncLocalStorage<RequestContext>();

export const inRequest = <T>(ctx: RequestContext, fn: () => T): T => als.run(ctx, fn);

/** True when the code running now began in a request that outlived the shutdown deadline. */
export const pastDeadline = (): boolean => als.getStore()?.over() ?? false;
