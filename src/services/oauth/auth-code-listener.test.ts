import { afterEach, expect, test } from 'bun:test'

import { AuthCodeListener } from './auth-code-listener.js'

const listeners: AuthCodeListener[] = []

afterEach(() => {
  while (listeners.length > 0) {
    listeners.pop()?.close()
  }
})

test('responds to requests immediately after start', async () => {
  const listener = new AuthCodeListener('/callback')
  listeners.push(listener)

  const port = await listener.start()
  const response = await fetch(`http://localhost:${port}/`)

  expect(response.status).toBe(404)
})

test('cancelPendingAuthorization rejects a pending OAuth wait', async () => {
  const listener = new AuthCodeListener('/callback')
  listeners.push(listener)

  await listener.start()

  const pendingAuthorization = listener.waitForAuthorization(
    'state-test',
    async () => {},
  )

  listener.cancelPendingAuthorization(
    new Error('Codex OAuth flow was cancelled.'),
  )

  await expect(pendingAuthorization).rejects.toThrow(
    'Codex OAuth flow was cancelled.',
  )
})
