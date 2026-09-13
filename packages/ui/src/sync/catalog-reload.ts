import type { CatalogKind } from "@/lib/opencode/events"

/** Settle delay: one saved file makes v2 rebuild several catalogs in a burst. */
export const CATALOG_RELOAD_DEBOUNCE_MS = 250
/**
 * Cooldown per kind: OpenCode publishes `catalog.updated` continuously while a
 * reply streams (dozens of times per turn, a few hundred milliseconds apart),
 * which a settle delay alone cannot absorb.
 */
export const CATALOG_RELOAD_MIN_INTERVAL_MS = 3000

/**
 * How long the pending kinds wait before they are re-read: the settle delay,
 * and no sooner than every pending kind's cooldown has passed. Events inside a
 * cooldown fold into one trailing re-read, so the last change is never dropped.
 */
export function catalogReloadDelay(
  kinds: Iterable<CatalogKind>,
  lastReloadAt: ReadonlyMap<CatalogKind, number>,
  now: number,
): number {
  let delay = CATALOG_RELOAD_DEBOUNCE_MS
  for (const kind of kinds) {
    const last = lastReloadAt.get(kind)
    if (last === undefined) continue
    delay = Math.max(delay, last + CATALOG_RELOAD_MIN_INTERVAL_MS - now)
  }
  return delay
}
