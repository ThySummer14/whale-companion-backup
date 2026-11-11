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
