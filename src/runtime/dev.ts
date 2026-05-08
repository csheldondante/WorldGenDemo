/**
 * Dev-mode toggles. In Vite, `import.meta.env.DEV` is `true` for `vite dev`
 * and `false` for `vite build`. Tests run via vitest set DEV true as well.
 *
 * `assertDev(condition, message)` throws loudly in dev / tests; in production
 * it silently no-ops. Use it for invariants whose violation indicates a bug
 * we want surfaced fast.
 *
 * `warnDev(message)` is the soft variant — logs to console but doesn't throw.
 * Use for "expected something, didn't get it, app continues."
 */

const env = (import.meta as { env?: { DEV?: boolean; MODE?: string } }).env;
export const IS_DEV: boolean = !!(env?.DEV ?? env?.MODE !== "production");

export function assertDev(condition: unknown, message: string): asserts condition {
  if (condition) return;
  if (IS_DEV) throw new Error(`[assertDev] ${message}`);
  // eslint-disable-next-line no-console
  console.error(`[assertDev:prod] ${message}`);
}

export function warnDev(message: string, ...rest: unknown[]): void {
  if (!IS_DEV) return;
  // eslint-disable-next-line no-console
  console.warn(`[runtime] ${message}`, ...rest);
}
