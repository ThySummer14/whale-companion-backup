import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'
import { DeviceAuthError } from '../src/host/devices.ts'
import { registerHttp } from '../src/host/http.ts'

test('house reference reads only the draft-bound raster image through management', async t => {
  const id = randomUUID()
  const reference = { contextId: 'chat.mobile', messageId: 'source-message', attachmentId: 'source-image' }
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  let mode = 'image/png'
  const sessions = {
    houseReferenceAttachment: t.mock.fn(async (sessionId, messageId, attachmentId, signal) => {
      assert.equal(sessionId, 'original-session')
      assert.equal(messageId, reference.messageId)
      assert.equal(attachmentId, reference.attachmentId)
      assert.ok(signal instanceof AbortSignal)
      if (mode === 'missing') throw new DeviceAuthError(404, 'chat-attachment-not-found')
      return { attachment: { mimeType: mode }, data: image }
    }),
  }
  let handler, origin
  const ctx = { webServer: { host: '127.0.0.1', getOrigin: () => origin, register: route => { handler = route.handler } } }
  registerHttp(ctx, { store: { minecraftHouses: { referenceSource: key => key === id ? { sessionId: 'original-session', reference } : undefined } }, sessions })
  const server = createServer(handler)
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = 'http://127.0.0.1:' + server.address().port
  const owner = { 'x-companion-request': '1' }
  const url = key => `${origin}/companion/api/minecraft/houses/${key}/reference`

  assert.equal((await fetch(url(id))).status, 403)
  assert.equal((await fetch(url(id), { headers: { ...owner, origin: 'https://outside.invalid' } })).status, 403)
  assert.equal((await fetch(url(id) + '?attachmentId=other', { headers: owner })).status, 400)
  assert.equal((await fetch(url(randomUUID()), { headers: owner })).status, 404)
  assert.equal(sessions.houseReferenceAttachment.mock.callCount(), 0)

  const response = await fetch(url(id), { headers: owner })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), mode)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), image)

  for (const unsupported of ['image/svg+xml', 'application/octet-stream', 'missing']) {
    mode = unsupported
    assert.equal((await fetch(url(id), { headers: owner })).status, 404)
  }
  assert.equal(sessions.houseReferenceAttachment.mock.callCount(), 4)
})
