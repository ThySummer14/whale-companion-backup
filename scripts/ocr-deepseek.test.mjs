import assert from 'node:assert/strict'
import test from 'node:test'
import { DeepSeekOcrProvider } from '../src/host/ocr-deepseek.ts'

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function provider(fetcher, apiKey = 'test-key') {
  return new DeepSeekOcrProvider({ apiKey, timeoutMs: 5000, fetcher })
}

test('ocr posts multipart file and purpose and parses leading-newline JSON', async () => {
  const seen = []
  const ocr = provider(async (url, init) => {
    seen.push({ url: String(url), init })
    return new Response('\n\n' + JSON.stringify({
      id: 'ocr-1', object: 'ocr.result', page_count: 1,
      pages: [{ index: 0, text: '大肥鱼的歌', finish_reason: 'stop' }],
    }), { status: 200 })
  })
  const result = await ocr.recognize(png, 'cover.png')
  assert.deepEqual(result, { pageCount: 1, pages: [{ index: 0, text: '大肥鱼的歌', finishReason: 'stop' }] })
  assert.equal(seen[0].url, 'https://api.deepseek.com/v1/tools/ocr')
  assert.equal(seen[0].init.headers.authorization, 'Bearer test-key')
  const form = seen[0].init.body
  assert.ok(form instanceof FormData)
  assert.equal(form.get('purpose'), 'text_recognition')
  const file = form.get('file')
  assert.ok(file instanceof Blob)
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), png)
})

test('ocr surfaces in-body errors and maps upload statuses', async () => {
  const inBody = provider(async () => new Response(JSON.stringify({ error: { message: 'OCR did not finish in time' } }), { status: 200 }))
  await assert.rejects(inBody.recognize(png, 'a.png'), { code: 'ocr-provider-failed' })
  for (const [status, code] of [[413, 'ocr-file-too-large'], [402, 'ocr-provider-unavailable'], [429, 'ocr-provider-unavailable'], [503, 'ocr-provider-unavailable'], [400, 'ocr-provider-status']]) {
    const ocr = provider(async () => new Response('{}', { status }))
    await assert.rejects(ocr.recognize(png, 'a.png'), { code })
  }
})

test('ocr rejects oversized or empty files and missing keys before fetching', async () => {
  let calls = 0
  const ocr = provider(async () => { calls += 1; return new Response('{}') })
  await assert.rejects(ocr.recognize(Buffer.alloc(4), 'a.png'), { code: 'ocr-file-too-large' })
  await assert.rejects(ocr.recognize(Buffer.alloc(21 * 1024 * 1024), 'a.png'), { code: 'ocr-file-too-large' })
  const unconfigured = provider(async () => { calls += 1; return new Response('{}') }, '')
  assert.equal(unconfigured.configured(), false)
  await assert.rejects(unconfigured.recognize(png, 'a.png'), { code: 'ocr-unconfigured' })
  assert.equal(calls, 0)
})

test('ocr rejects inconsistent page counts', async () => {
  const ocr = provider(async () => new Response(JSON.stringify({ page_count: 2, pages: [{ index: 0, text: 'x' }] }), { status: 200 }))
  await assert.rejects(ocr.recognize(png, 'a.png'), { code: 'ocr-response-invalid' })
})