import { describe, expect, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { OpenCode } from '@opencode/client'
import { SyncProvider, useSyncDirectory } from './sync-context'
import { usePrefetchSessionMessages } from './use-sync'
import { installHookTestDom } from '../components/session/sidebar/test-utils/testDom'

// The provider's own data access goes through the `opencodeClient` singleton;
// this client only satisfies the prop and absorbs the event stream, so the
// assertion below measures render boundaries and nothing else.
const createSdk = () => OpenCode.make({
  baseUrl: 'https://sync.test',
  fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname
    if (path.endsWith('/event')) {
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } })
    }
    const body = path.endsWith('/location')
      ? { directory: '/workspace', project: { id: 'project', directory: '/workspace', canonical: '/workspace' } }
      : path.endsWith('/session/active') ? {}
      : { data: [] }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  },
})

describe('SyncProvider selection boundary', () => {
  test('does not rerender a stable prefetch consumer when only current directory changes', async () => {
    const dom = installHookTestDom()
    const root = createRoot(dom.container)
    let runtimeRenders = 0
    let directoryRenders = 0
    let callback: ReturnType<typeof usePrefetchSessionMessages> | undefined
    const RuntimeConsumer = React.memo(() => {
      callback = usePrefetchSessionMessages()
      runtimeRenders += 1
      return null
    })
    const DirectoryConsumer = () => {
      useSyncDirectory()
      directoryRenders += 1
      return null
    }
    const sdk = createSdk()

    try {
      await act(async () => root.render(
        <SyncProvider sdk={sdk} directory="/workspace/a">
          <RuntimeConsumer />
          <DirectoryConsumer />
        </SyncProvider>,
      ))
      const initialCallback = callback
      await act(async () => root.render(
        <SyncProvider sdk={sdk} directory="/workspace/b">
          <RuntimeConsumer />
          <DirectoryConsumer />
        </SyncProvider>,
      ))
      expect(runtimeRenders).toBe(1)
      expect(callback).toBe(initialCallback)
      expect(directoryRenders).toBe(2)
    } finally {
      await act(async () => root.unmount())
      dom.restore()
    }
  })
})
