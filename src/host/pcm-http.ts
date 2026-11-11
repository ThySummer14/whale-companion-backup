import { once } from 'node:events'
import type { ServerResponse } from 'node:http'
import type { RealtimePcmStream } from './realtime-pcm.ts'

export async function streamPcm(res: ServerResponse, open: (signal: AbortSignal) => RealtimePcmStream, playbackHeaders?: () => Record<string, string>): Promise<void> {
  const client = new AbortController()
  const disconnect = () => { if (!res.writableFinished) client.abort() }
  res.once('close', disconnect)
  try {
    if (res.destroyed) client.abort()
    const stream = open(client.signal)
    const { body, sampleRate, signal } = stream
    for await (const chunk of body) {
      signal.throwIfAborted()
      if (!chunk.length) continue
      if (!res.headersSent) res.writeHead(200, {
        'content-type': 'application/octet-stream', 'x-companion-sample-rate': String(sampleRate),
        'cache-control': 'no-store, no-transform', 'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no',
        ...(stream.source ? { 'x-companion-voice-source': stream.source } : {}),
        ...playbackHeaders?.(),
      })
      if (!res.write(chunk)) await once(res, 'drain', { signal })
    }
    signal.throwIfAborted()
    res.end()
  } finally {
    res.off('close', disconnect)
  }
}
