---
name: opencode-v2-branch
description: Load on branch `opencode-v2-refactoring` (the OpenCode v2 cutover) for any change, for "what's new in OpenCode v2 / 2.0.x", for bumping the pinned OpenCode version, or for publishing a v2 preview build for testers. Temporary; delete after the branch merges.
---

# OpenCode v2 branch

`opencode-v2-refactoring` moves OpenChamber from the OpenCode v1 API to v2 in
one cutover. It is active development: everything on it is unreleased, gets
merged from `main` regularly, and ships to testers only through hand-run
preview builds. Behaviour ported from v1 must stay identical or be surfaced as
a decision for the maintainer — never quietly handed to a v2 default.

## Sources of truth

- v2 reference checkout: `~/projects/opencode`, branch `origin/v2` (never
  edit it; `git fetch origin --tags` there to see new releases). Real v2 is
  `origin/v2` and its `v2.x.y` tags, not `dev`.
- Pinned versions: `packages/electron/package.json` → `opencodeCli.version`
  (the binary the desktop app bundles) and `@opencode/client` /
  `@opencode/schema` in the package manifests (the wire types). They move
  together.
- Server behaviour lives in `packages/core/src` and `packages/server/src`
  of the reference; the HTTP surface in `packages/server/src/handlers/*`.
- Known upstream gaps and open reports: the maintainer's questions in the
  OpenCode Slack thread and issue
  https://github.com/anomalyco/opencode/issues/48872 (`catalog.updated`
  storm during streaming; OpenChamber rate-limits and de-duplicates catalog
  re-reads in `packages/ui/src/sync/catalog-reload.ts` as a workaround).

## "What's new in OpenCode v2?"

Answer from the diff, never from memory. Done when every API-facing change
between the pinned tag and the newest tag is classified.

1. `cd ~/projects/opencode && git fetch origin --tags`; read the pinned tag
   from `opencodeCli.version`; newest is `git tag -l 'v2.*' | sort -V | tail -1`.
2. `git log --oneline vPINNED..vNEWEST` and
   `git diff --stat vPINNED..vNEWEST -- packages/core packages/server packages/schema packages/client packages/plugin`.
   Ignore `packages/tui`, `packages/app`, `packages/web` (their own UIs).
3. Classify each change that touches routes, events, schemas or plugin hooks:
   - **breaks us** — a route, field or event OpenChamber reads changed shape
     or went away. Name the OpenChamber file that consumes it.
   - **fixes a workaround** — v2 now does something OpenChamber re-implements
     (precedent: `/api/session/:id/generate` replaced the custom small-model
     client; the turn diff route replaced client-side diffing). Name the
     workaround that can go and what changes for the user if it goes.
   - **closes an open gap** — something from the Slack thread or the
     v1→v2 audit that v2 could not do before (session metadata PATCH,
     credentials over HTTP, MCP OAuth from a client, `/api/generate` on the
     free tier, catalog event storm).
   - **neutral** — TUI, their app, internal refactors.
4. Report in that order, plain words, with the maintainer's decision points
   explicit: what to remove, what to adopt, what still to ask upstream.
   Unchanged code around a known bug means the report stays as filed.

## Bumping the pinned OpenCode

Change `opencodeCli.version` and the `@opencode/*` manifest versions to the
same tag, `bun install`, then type-check `packages/ui` and run the isolated
suites for `packages/web` and `packages/vscode` (`scripts/run-isolated-tests.mjs`).
Also check whether the new tag adds a message `type` or event OpenChamber's
role mapping in `packages/ui/src/lib/opencode/model.ts` and
`packages/ui/src/lib/opencode/events.ts` does not know yet.

## Preview builds for testers

`.github/workflows/v2-preview-desktop.yml` is `workflow_dispatch` only and is
not on `main`, so the GitHub UI does not list it. Run it from a terminal:

```
gh workflow run v2-preview-desktop.yml --ref opencode-v2-refactoring -R openchamber/openchamber
gh run list -R openchamber/openchamber --workflow v2-preview-desktop.yml --limit 3
```

It builds the desktop apps from the branch (macOS arm64 and Intel, signed
and notarized; Windows x64 and arm64; Linux AppImage x64 and arm64), stamps
them `2.0.0-preview.<run number>`, and replaces each target's files on the
`v2-preview` pre-release:
https://github.com/openchamber/openchamber/releases/tag/v2-preview.
The version is stamped in the workflow only; the repo stays on the stable
version. A pre-release is never "latest", so stable installs and the website
ignore it; the preview app keeps checking for updates (that is where install
statistics come from) and never downgrades, since `2.0.0-preview.*` sorts
above any `1.x`. The jobs mirror `release.yml` minus update manifests.

## Keeping the branch alive

- Merge `origin/main` into the branch (a merge, not a rebase: the cutover is
  one commit and conflicts are easier to resolve once). The recurring
  conflict area is the work-status panel: the branch removed the Tasks
  section with the todo tool; keep `main`'s structure, drop Tasks.
- After every merge: `packages/ui` type-check and the tests around the files
  `main` touched.
- The v1→v2 behaviour audit with the maintainer's decisions is in
  `.opencode/plans/v1-v2-audit/` (gitignored, local only).
