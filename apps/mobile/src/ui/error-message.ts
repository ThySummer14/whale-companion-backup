export function displayError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('CLEARTEXT communication')) return '明文 HTTP 无法用于正式连接。请在 Mac mini 上配置 Tailscale Serve，再使用 HTTPS 地址重新配对。'
  if (message === 'Network request failed' || message === 'Failed to fetch') return '暂时无法连接 Host。请检查 Tailscale、配对地址和 Mac mini 上的 DSH 是否正常运行。'
  return message
}
