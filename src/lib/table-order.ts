/**
 * Tables are named by people ("Table 1" … "Table 10") and displayed as a list.
 * A plain string sort puts "Table 10" between "Table 1" and "Table 2", which is
 * the order a reader never expects — on the QR page and in the POS picker both.
 *
 * The database has no natural ordering of its own (`order by name` is lexical),
 * so every surface that lists tables goes through this.
 */

/** Compare two names the way a person reads them: "Table 2" before "Table 10". */
export function naturalCompare(a: string, b: string): number {
  const ax = String(a ?? '').match(/(\d+|\D+)/g) ?? []
  const bx = String(b ?? '').match(/(\d+|\D+)/g) ?? []

  const len = Math.max(ax.length, bx.length)
  for (let i = 0; i < len; i++) {
    const l = ax[i]
    const r = bx[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    // A chunk of digits compares as a number — "2" < "10" — so leading zeros
    // and multi-digit table numbers land where they belong.
    if (/^\d+$/.test(l) && /^\d+$/.test(r)) {
      const diff = Number(l) - Number(r)
      if (diff !== 0) return diff
    } else if (l !== r) {
      return l.localeCompare(r, undefined, { sensitivity: 'base' })
    }
  }
  return 0
}

/** A copy of the list in natural order. Never mutates the input. */
export function sortTables<T extends { name: string }>(rows: readonly T[] | null | undefined): T[] {
  return [...(rows ?? [])].sort((a, b) => naturalCompare(a.name, b.name))
}
