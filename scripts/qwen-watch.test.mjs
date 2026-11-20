import assert from 'node:assert/strict'
import test from 'node:test'
import { QwenWatchInput, QwenWatchService } from '../src/host/qwen-watch.ts'

const clip = '看这段：BV1xx411c7mD 0:12 4秒 画面和声音'
const persona = { name: '大肥鱼', description: '对有趣的细节好奇', tagline: '蓝鲸', version: 1, updatedAt: '' }
const noActivity = { recordActivity: () => assert.fail('unexpected watch receipt') }

test('Qwen gets native media and writes the reply in one request, with bounded follow-up history', async t => {
  const inputs = []
  const activities = []
  let samples = 0
  const service = new QwenWatchService({
    async sampleOmniClip(input) {
      samples++
      assert.equal(input.start, 12)
      assert.equal(input.mode, 'both')
      return { title: '视频样例', format: 'mp4', data: Buffer.from('fixture MP4') }
    },
  }, { recordActivity: input => activities.push(input) }, async (url, options) => {
    assert.equal(url.href, 'https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions')
    inputs.push(JSON.parse(options.body))
    return Response.json({ choices: [{ message: { content: '我看到了！' } }] })
  }, { QWENCLOUD_API_KEY: 'fixture-key' })
  t.after(() => service.close())
  const signal = new AbortController().signal
  const reply = input => service.reply('owner', QwenWatchInput.parse(input), persona, signal, () => {})
  const first = await reply({ clip, question: '注意到什么？' })
  assert.equal(first.text, '我看到了！')
  assert.deepEqual(first.receipt, { activityId: 1, title: '视频样例',
    source: { bvid: 'BV1xx411c7mD', part: 1, startSeconds: 12, seconds: 4, visual: true, audio: true } })
  assert.equal(samples, 1)
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0].model, 'qwen3.8-omni-flash')
  assert.match(inputs[0].messages[0].content, /大肥鱼/u)
  assert.match(inputs[0].messages.at(-1).content[0].video_url.url, /^data:;base64,/u)
  const next = await reply({ threadId: first.threadId, question: '刚刚谁说话了？' })
  assert.deepEqual(next.receipt, first.receipt)
  assert.equal(samples, 1)
  assert.equal(inputs.length, 2)
  assert.equal(inputs[1].messages.at(-2).content, '我看到了！')
  assert.equal(activities.length, 1)
  assert.equal(service.session('owner').turns.length, 4)
  assert.equal(service.session('other'), undefined)
  await assert.rejects(service.reply('other', { threadId: first.threadId, question: '别人的会话' }, persona, signal, () => {}),
    { code: 'qwen-watch-thread-expired' })
})

test('unconfigured provider and invalid clip make no network call', async t => {
  const run = () => assert.fail('unexpected media or network call')
  const service = new QwenWatchService({ sampleOmniClip: run }, noActivity, run, {})
  t.after(() => service.close())
  await assert.rejects(service.reply('owner', { clip, question: '' }, persona, new AbortController().signal, () => {}),
    { code: 'qwen-watch-unconfigured' })
  const configured = new QwenWatchService({ sampleOmniClip: run }, noActivity, run, { QWENCLOUD_API_KEY: 'fixture-key' })
  t.after(() => configured.close())
  await assert.rejects(configured.reply('owner', { clip: 'https://unrelated.invalid/', question: '' }, persona,
    new AbortController().signal, () => {}), { code: 'bili-invalid-clip' })
})

test('a device revoked while the provider is running cannot receive a reply or write an activity', async t => {
  const waiting = Promise.withResolvers()
  const service = new QwenWatchService({
    async sampleOmniClip() { return { title: '隔离片段', format: 'mp4', data: Buffer.from('fixture') } },
  }, noActivity, async (_, { signal }) => {
    waiting.resolve()
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }, { QWENCLOUD_API_KEY: 'fixture-key' })
  t.after(() => service.close())
  const reply = service.reply('owner', QwenWatchInput.parse({ clip }), persona, new AbortController().signal, () => {})
  await waiting.promise
  assert.equal(service.watching, true)
  service.revoke('owner')
  await assert.rejects(reply, { status: 401, code: 'device-unauthorized' })
  assert.equal(service.session('owner'), undefined)
  assert.equal(service.watching, false)
})
