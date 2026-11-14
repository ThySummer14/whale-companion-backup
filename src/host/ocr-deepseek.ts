import { DeviceAuthError } from './devices.ts'

const ENDPOINT = 'https://api.deepseek.com/v1/tools/ocr'
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

export interface OcrPage {
  index: number
  text: string
  finishReason: string
}

export interface DeepSeekOcrOptions {
  apiKey: string
  timeoutMs: number
  fetcher?: typeof fetch
}

export class DeepSeekOcrProvider {
  private readonly fetcher: typeof fetch

  constructor(private readonly options: DeepSeekOcrOptions) {
    this.fetcher = options.fetcher ?? fetch
  }

  configured(): boolean {
    return !!this.options.apiKey.trim()
  }

  async recognize(file: Buffer, filename: string, purpose: 'text_recognition' | 'rich_layout_recognition' = 'text_recognition'): Promise<{ pageCount: number; pages: OcrPage[] }> {
    if (!this.configured()) throw new DeviceAuthError(503, 'ocr-unconfigured')
    if (file.length < 8 || file.length > MAX_FILE_BYTES) throw new DeviceAuthError(413, 'ocr-file-too-large')
    const form = new FormData()
    form.append('purpose', purpose)
    form.append('file', new Blob([new Uint8Array(file).buffer]), filename)
    const response = await this.fetcher(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.apiKey.trim()}` },
      body: form,
      signal: AbortSignal.timeout(this.options.timeoutMs),
    })
    if (response.status === 413) throw new DeviceAuthError(413, 'ocr-file-too-large')
    if (response.status === 402 || response.status === 429 || response.status === 503) throw new DeviceAuthError(503, 'ocr-provider-unavailable')
    if (response.status !== 200) throw new DeviceAuthError(502, 'ocr-provider-status')
    const body = Buffer.from(await response.arrayBuffer())
    if (body.length > MAX_RESPONSE_BYTES) throw new DeviceAuthError(502, 'ocr-response-too-large')
    let payload: { error?: { message?: string }; page_count?: number; pages?: { index?: number; text?: string; finish_reason?: string }[] }
    try { payload = JSON.parse(body.toString('utf8')) } catch { throw new DeviceAuthError(502, 'ocr-response-invalid') }
    if (payload.error) throw new DeviceAuthError(502, 'ocr-provider-failed')
    const pages = (payload.pages ?? []).map(page => ({
      index: page.index ?? 0,
      text: page.text ?? '',
      finishReason: page.finish_reason ?? 'stop',
    }))
    if (!pages.length || pages.length !== payload.page_count) throw new DeviceAuthError(502, 'ocr-response-invalid')
    return { pageCount: pages.length, pages }
  }
}