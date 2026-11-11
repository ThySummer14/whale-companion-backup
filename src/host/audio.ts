import { createReadStream } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TtsAsset } from '../core/model.ts'

export function streamAudio(req: IncomingMessage, res: ServerResponse, asset: Pick<TtsAsset, 'mimeType' | 'bytes' | 'filePath'> & { data?: Uint8Array }, playbackHeaders?: () => Record<string, string>): void {
  const headers = {
    'content-type': asset.mimeType,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
  }
  const match = req.headers.range ? /^bytes=(\d*)-(\d*)$/u.exec(req.headers.range) : undefined
  let start = 0
  let end = asset.bytes - 1
  if (req.headers.range && !match) {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${asset.bytes}` })
    res.end()
    return
  }
  if (match) {
    if (!match[1] && !match[2]) {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${asset.bytes}` })
      res.end()
      return
    }
    start = match[1] ? Number(match[1]) : Math.max(0, asset.bytes - Number(match[2]))
    end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= asset.bytes) {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${asset.bytes}` })
    res.end()
    return
  }
  res.writeHead(match ? 206 : 200, {
    ...headers,
    'content-length': end - start + 1,
    ...(match ? { 'content-range': `bytes ${start}-${end}/${asset.bytes}` } : {}),
    ...(req.method === 'GET' && start === 0 ? playbackHeaders?.() : {}),
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  if (asset.data) {
    res.end(asset.data.subarray(start, end + 1))
    return
  }
  const stream = createReadStream(asset.filePath, { start, end })
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}
