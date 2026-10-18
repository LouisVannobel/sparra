import { hasBoundedBillingPageData } from './provider-shapes.server'

// Bounded Stripe list reads shared by lineage and risk discovery. Each owner
// supplies its exact row admission and error policy; this grants no authority.
export async function collectBillingPages<T extends { id: string }>(
  read: (cursor?: string) => Promise<{ object: 'list'; data: T[]; has_more: boolean }>,
  requireRow: (row: T, seen: ReadonlySet<string>) => void,
  unavailable: () => never,
): Promise<T[]> {
  const all: T[] = [], seen = new Set<string>()
  let cursor: string | undefined
  for (let count = 0; count < 5; count++) {
    const page = await read(cursor)
    if (page.object !== 'list' || !hasBoundedBillingPageData(page)) unavailable()
    for (const row of page.data) {
      requireRow(row, seen)
      seen.add(row.id); all.push(row)
    }
    if (!page.has_more) return all
    cursor = page.data.at(-1)!.id
  }
  return unavailable()
}
