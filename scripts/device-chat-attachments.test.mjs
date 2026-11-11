import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CompanionStore } from '../src/core/store.ts'
import { registerDeviceHttp } from '../src/host/device-http.ts'
import { DeviceService } from '../src/host/devices.ts'
import { SessionService } from '../src/host/session.ts'

const CONTEXT = 'chat.mobile'
const SESSION = 'phone-session'
const LIMIT = 8 * 1024 * 1024
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const FILE = Buffer.from('私人文件\u0000内容')
const REQUEST_ID = '11111111-1111-4111-8111-111111111111'
const upload = (name, data) => ({ name, dataBase64: data.toString('base64') })

function fakeStorage() {
  const objects = new Map()
  function put({ name, data }) {
    const attachmentId = `sha256:${createHash('sha256').update(data).digest('hex')}`
    objects.set(attachmentId, data)
    return { attachmentId, name, bytes: data.length }
  }
  return {
    objects,
    isAttachmentError: error => error?.code?.startsWith('ATTACHMENT_') || error?.code === 'INVALID_IMAGE',
    async saveImages(images) {
      if (images.some(image => image.data.length < 24)) throw Object.assign(new Error('bad PNG'), { code: 'INVALID_IMAGE' })
      return images.map(image => ({ ...put(image), mediaType: image.mediaType, width: 1, height: 1 }))
    },
    async saveFile(file) { return put(file) },
    async readImage(ref) { return { data: objects.get(ref.attachmentId), ref } },
    async *readFileStream(ref) {
      const data = objects.get(ref.attachmentId)
      yield data.subarray(0, 5)
      yield data.subarray(5)
    },
  }
}

async function fixture(t, storage = fakeStorage()) {
  mkdirSync('.work', { recursive: true })
  const directory = resolve(mkdtempSync('.work/chat-attachments-test-'))
  const store = new CompanionStore(join(directory, 'store.sqlite'))
  store.bindContext({ contextId: CONTEXT, sessionId: SESSION, label: 'Phone', kind: 'chat' })
  store.bindContext({ contextId: 'chat.other', sessionId: 'different-session', label: 'Other', kind: 'chat' })
  const session = Session.create(SessionId(SESSION))
  const inbox = { nextTurn: [], nextStep: [] }
  const agent = { id: SESSION, inbox, session, followup: t.mock.fn(message => inbox.nextTurn.push(message)) }
  const other = { id: 'different-session', inbox: { nextTurn: [], nextStep: [] }, session: Session.create(SessionId('different-session')) }
  let origin
  const routes = new Map()
  const ctx = {
    agents: { get: id => id === SESSION ? agent : id === other.id ? other : undefined },
    get: name => name === 'attachments' ? storage : undefined,
    webServer: { getOrigin: () => origin, register: route => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
  }
  const sessions = new SessionService(ctx, store, () => {})
  const devices = new DeviceService(ctx, store)
  const dispose = registerDeviceHttp(ctx, { sessions }, devices)
  const server = createServer((req, res) => routes.get('/companion-device/api')(req, res))
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    dispose()
    devices.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  const device = devices.redeem(devices.createOffer({ routes: [origin] }).link)
  const request = (path, { input, credential = device.credential } = {}) => fetch(`${origin}/companion-device/api/${path}`, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { ...(credential && { authorization: credential }), ...(input !== undefined && { 'content-type': 'application/json' }) },
    body: input === undefined ? undefined : JSON.stringify(input),
  })
  const send = (input, options) => request('messages', { input: { contextId: CONTEXT, ...input }, ...options })
  const download = (receipt, attachment, contextId = CONTEXT) => request(`messages/attachment?${new URLSearchParams({ contextId, messageId: receipt.messageId, attachmentId: attachment.id })}`)
  const commit = () => session.append('user/message', inbox.nextTurn.shift(), { surfaceOp: 'append' })
  const compact = event => session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '仅供模型使用的压缩摘要' }], source: { kind: 'compact-checkpoint', compactionId: 'test-compaction' },
  }), { surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] })
  return { agent, device, devices, download, inbox, session, commit, compact, request, send, storage, store }
}

test('paired attachment-only send preserves the order, exact file bytes and history metadata', async t => {
  const h = await fixture(t)
  assert.equal((await h.request('messages/attachments', { credential: null })).status, 401)
  assert.deepEqual(await (await h.request('messages/attachments')).json(), { available: true, maxItems: 4, maxTotalBytes: LIMIT })
  const response = await h.send({ attachments: [upload('笔记.txt', FILE), upload('图片.png', PNG)] })
  assert.equal(response.status, 202)
  const receipt = await response.json()
  assert.deepEqual(h.inbox.nextTurn[0].content.map(part => part.type), ['file', 'image'])
  assert.deepEqual(receipt.attachments.map(({ name, bytes, mimeType }) => [name, bytes, mimeType]), [
    ['笔记.txt', FILE.length, 'application/octet-stream'], ['图片.png', PNG.length, 'image/png'],
  ])
  const inboxDownload = await h.download(receipt, receipt.attachments[0])
  assert.equal(inboxDownload.status, 200)
  assert.equal(inboxDownload.headers.get('content-type'), 'application/octet-stream')
  assert.equal(inboxDownload.headers.get('content-disposition'), 'attachment')
  assert.equal(inboxDownload.headers.get('x-content-type-options'), 'nosniff')
  assert.match(inboxDownload.headers.get('cache-control'), /no-store/u)
  assert.deepEqual(Buffer.from(await inboxDownload.arrayBuffer()), FILE)

  h.compact(h.commit())
  assert.ok(h.session.deriveMessages().every(message => message.id !== receipt.messageId))
  const history = await (await h.request(`messages/history?contextId=${CONTEXT}`)).json()
  assert.deepEqual(history.messages, [{ id: receipt.messageId, role: 'user', text: '', attachments: receipt.attachments }])
  const imageDownload = await h.download(receipt, receipt.attachments[1])
  assert.equal(imageDownload.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await imageDownload.arrayBuffer()), PNG)
  assert.equal((await h.download(receipt, receipt.attachments[0], 'chat.other')).status, 404)
  assert.equal((await h.download({ messageId: 'other-message' }, receipt.attachments[0])).status, 404)
  assert.equal((await h.download(receipt, { id: 'other-attachment' })).status, 404)
  assert.doesNotMatch(JSON.stringify(h.store.activities()), /笔记|图片|base64|sha256:/u)
})

test('validates request count, actual bytes, safe names and canonical base64 before queueing', async t => {
  const h = await fixture(t)
  const oversized = Buffer.alloc(LIMIT)
  for (const [attachments, status] of [
    [Array.from({ length: 5 }, () => upload('file', FILE)), 400],
    [[upload('../file', FILE)], 400],
    [[upload('file\n.txt', FILE)], 400],
    [[{ name: 'file', dataBase64: 'AB==' }], 400],
    [[upload('file', Buffer.alloc(0))], 400],
    [[upload('file', FILE), upload('image', PNG.subarray(0, 8))], 400],
    [[upload('file', oversized), upload('second', Buffer.from([1]))], 413],
  ]) {
    assert.equal((await h.send({ text: '', attachments })).status, status)
  }
  assert.equal((await h.send({ text: '   ' })).status, 400)
  assert.equal((await h.send({ attachments: [upload('private', FILE)] }, { credential: null })).status, 401)
  assert.equal(h.agent.followup.mock.callCount(), 0)
  assert.equal(h.storage.objects.size, 0)
})

test('concurrent and subsequent retries reuse the accepted attachment message, plain voice requests stay compatible', async t => {
  const h = await fixture(t)
  const input = { text: '附件说明', requestId: REQUEST_ID, attachments: [upload('file.txt', FILE)] }
  const responses = await Promise.all([h.send(input), h.send(input)])
  assert.deepEqual(responses.map(response => response.status), [202, 202])
  const [first, second] = await Promise.all(responses.map(response => response.json()))
  assert.deepEqual(first, second)
  assert.equal(h.agent.followup.mock.callCount(), 1)
  assert.equal(h.storage.objects.size, 1)
  h.compact(h.commit())
  assert.deepEqual(await (await h.send(input)).json(), first)
  assert.equal(h.agent.followup.mock.callCount(), 1)
  const plain = await h.send({ text: '  一句话  ', voiceReply: true })
  assert.equal(plain.status, 202)
  assert.deepEqual(h.inbox.nextTurn[0].content, [{ type: 'text', text: '一句话' }])
  assert.equal(h.inbox.nextTurn[0].source.voiceReply, true)
  assert.equal((await plain.json()).attachments, undefined)
})

test('paired text retries reuse one accepted input and reject changes to the same request', async t => {
  const h = await fixture(t, null)
  const requestId = 'abcdefab-1111-4111-8111-111111111111'
  const input = { text: '  记得带地图  ', requestId, expectedSessionId: SESSION, voiceReply: true }
  const responses = await Promise.all([h.send(input), h.send(input), h.send({ ...input, requestId: requestId.toUpperCase() })])
  assert.deepEqual(responses.map(response => response.status), [202, 202, 202])
  const receipts = await Promise.all(responses.map(response => response.json()))
  assert.equal(new Set(receipts.map(receipt => receipt.messageId)).size, 1)
  assert.equal(receipts.filter(receipt => receipt.replayed === true).length, 2)
  assert.equal(h.agent.followup.mock.callCount(), 1)
  h.compact(h.commit())
  const replay = await (await h.send(input)).json()
  assert.equal(replay.messageId, receipts[0].messageId)
  assert.equal(replay.replayed, true)
  for (const changes of [{ text: '改成另一个消息' }, { voiceReply: false }, { attachments: [upload('map', FILE)] }]) {
    const conflict = await h.send({ ...input, ...changes })
    assert.equal(conflict.status, 409)
    assert.equal((await conflict.json()).code, 'chat-request-conflict')
  }
  const stale = await h.send({ ...input, expectedSessionId: 'previous-session' })
  assert.equal(stale.status, 409)
  assert.equal((await stale.json()).code, 'chat-session-changed')
  assert.equal(h.agent.followup.mock.callCount(), 1)
})

test('a claimed message can be retried before DSH appends its user event', async t => {
  const h = await fixture(t)
  let claimed
  h.agent.followup.mock.mockImplementation(message => { claimed = message })
  const input = { text: '待写入日志', requestId: REQUEST_ID, expectedSessionId: SESSION }
  const original = await (await h.send(input)).json()
  assert.equal(h.inbox.nextTurn.length, 0)
  assert.equal(h.session.snapshotEvents().length, 0)
  assert.equal(claimed.id, original.messageId)
  assert.deepEqual(await (await h.send(input)).json(), { ...original, replayed: true })
  assert.equal(h.agent.followup.mock.callCount(), 1)
  h.session.append('user/message', claimed, { surfaceOp: 'append' })
  assert.deepEqual(await (await h.send(input)).json(), { ...original, replayed: true })
})

test('revocation and context rebinding during attachment admission prevent queueing', async t => {
  for (const revoke of [false, true]) {
    const storage = fakeStorage()
    const held = Promise.withResolvers()
    const admitted = Promise.withResolvers()
    const save = storage.saveFile
    storage.saveFile = async input => { admitted.resolve(); await held.promise; return save(input) }
    const h = await fixture(t, storage)
    const sending = h.send({ attachments: [upload('file', FILE)] })
    await admitted.promise
    if (revoke) h.devices.revoke(h.device.device.id)
    else h.store.unbindContext(CONTEXT)
    held.resolve()
    assert.equal((await sending).status, revoke ? 401 : 409)
    assert.equal(h.agent.followup.mock.callCount(), 0)
  }
})

test('incomplete reads fail before sending bytes and unavailable storage leaves text usable', async t => {
  const broken = fakeStorage()
  broken.readFileStream = async function* () { yield Buffer.from('short') }
  const h = await fixture(t, broken)
  const receipt = await (await h.send({ attachments: [upload('file', FILE)] })).json()
  const download = await h.download(receipt, receipt.attachments[0])
  assert.equal(download.status, 409)
  assert.equal((await download.json()).code, 'chat-attachment-corrupt')

  const legacy = await fixture(t, null)
  assert.deepEqual(await (await legacy.request('messages/attachments')).json(), { available: false, maxItems: 4, maxTotalBytes: LIMIT })
  assert.equal((await legacy.send({ attachments: [upload('file', FILE)] })).status, 503)
  assert.equal((await legacy.send({ text: '仍可聊天' })).status, 202)
})
