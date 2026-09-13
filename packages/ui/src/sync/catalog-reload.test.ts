import { describe, expect, test } from "bun:test"

import { CATALOG_RELOAD_DEBOUNCE_MS, CATALOG_RELOAD_MIN_INTERVAL_MS, catalogReloadDelay } from "./catalog-reload"

describe("catalogReloadDelay", () => {
  test("a kind never re-read before waits only for the burst to settle", () => {
    expect(catalogReloadDelay(["model"], new Map(), 10_000)).toBe(CATALOG_RELOAD_DEBOUNCE_MS)
  })

  test("a kind re-read moments ago waits out its cooldown", () => {
    const last = new Map([["model", 10_000]] as const)
    expect(catalogReloadDelay(["model"], last, 10_500)).toBe(CATALOG_RELOAD_MIN_INTERVAL_MS - 500)
  })

  test("a kind past its cooldown falls back to the settle delay", () => {
    const last = new Map([["model", 10_000]] as const)
    expect(catalogReloadDelay(["model"], last, 10_000 + CATALOG_RELOAD_MIN_INTERVAL_MS + 1)).toBe(CATALOG_RELOAD_DEBOUNCE_MS)
  })

  test("the longest pending cooldown wins", () => {
    const last = new Map([["model", 9_000], ["agent", 10_000]] as const)
    expect(catalogReloadDelay(["model", "agent"], last, 10_100)).toBe(CATALOG_RELOAD_MIN_INTERVAL_MS - 100)
  })
})
