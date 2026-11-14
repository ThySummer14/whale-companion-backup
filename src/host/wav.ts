export function wavDurationMs(audio: Buffer): number {
  if (audio.length < 44) throw new Error('Invalid WAV output')
  let sampleRate = 0
  let channels = 0
  let bitsPerSample = 0
  let frames = 0
  for (const { kind, size, start } of wavChunks(audio)) {
    if (kind === 'fmt ' && size >= 16) {
      channels = audio.readUInt16LE(start + 2)
      sampleRate = audio.readUInt32LE(start + 4)
      bitsPerSample = audio.readUInt16LE(start + 14)
    } else if (kind === 'data') {
      frames += size
    }
  }
  if (!sampleRate || !channels || !bitsPerSample || frames <= 0) throw new Error('WAV has no audio frames')
  const bytesPerFrame = channels * bitsPerSample / 8
  if (!Number.isSafeInteger(bytesPerFrame) || bytesPerFrame <= 0) throw new Error('Invalid WAV format')
  const durationMs = Math.round(frames / bytesPerFrame * 1000 / sampleRate)
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('Invalid WAV duration')
  return durationMs
}

export function* wavChunks(audio: Buffer): Generator<{ kind: string; start: number; size: number }> {
  if (audio.length < 12 || audio.toString('latin1', 0, 4) !== 'RIFF' || audio.toString('latin1', 8, 12) !== 'WAVE') throw new Error('Invalid WAV output')
  let offset = 12
  while (offset + 8 <= audio.length) {
    const kind = audio.toString('latin1', offset, offset + 4)
    const size = audio.readUInt32LE(offset + 4)
    const start = offset + 8
    if (start + size > audio.length) throw new Error('Invalid WAV chunk')
    yield { kind, start, size }
    offset = start + size + (size % 2)
  }
}
