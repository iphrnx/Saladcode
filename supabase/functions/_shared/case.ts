/** The database speaks snake_case; the frontend speaks camelCase. */

export function toCamel<T = unknown>(input: unknown): T {
  if (Array.isArray(input)) return input.map((v) => toCamel(v)) as unknown as T;
  if (input === null || typeof input !== "object") return input as T;
  if (input instanceof Date) return input as unknown as T;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const camel = key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
    out[camel] = value !== null && typeof value === "object" ? toCamel(value) : value;
  }
  return out as T;
}

/**
 * PostgREST returns embedded aggregate counts as either `[{count: n}]` or
 * `{count: n}` depending on version. Normalise to a plain number.
 */
export function embedCount(value: unknown): number {
  if (Array.isArray(value)) return Number((value[0] as { count?: number })?.count ?? 0);
  return Number((value as { count?: number })?.count ?? 0);
}
