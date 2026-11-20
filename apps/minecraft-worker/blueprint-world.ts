import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { VoxelWorldReceipt, voxelWorldReceiptMatches, type VoxelWorldInput, type VoxelWorldMode } from '../../src/core/minecraft-blueprint-build.ts'

type Console = (command: string, receipt: RegExp, signal?: AbortSignal) => Promise<string>

export async function runVoxelBlueprint(input: VoxelWorldInput, mode: VoxelWorldMode, bot: string,
  send: Console, signal: AbortSignal) {
  const { operationId: id, sha256: hash, dimension, origin, size, solids } = input
  const command = async (operation: 'start' | 'status' | 'cancel', abort?: AbortSignal) => {
    const nonce = randomBytes(8).toString('hex')
    const completion = new RegExp(String.raw`^\[[^\]\r\n]+\] \[Server thread/INFO\]: companion-blueprint id=${id} nonce=${nonce} hash=(?<sha256>[0-9a-f]{64}|-) phase=(?<phase>checking|placing|verifying|ready|built|failed|cancelled) total=(?<total>\d{1,8}) solids=(?<solids>\d{1,8}) checked=(?<checked>\d{1,8}) matched=(?<matched>\d{1,8}) placed=(?<placed>\d{1,8}) restored=(?<restored>true|false) reason=(?<reason>blueprint-[a-z-]{1,60}|-)\r?\n`, 'mu')
    const fields = operation === 'start' ? ` ${mode} ${hash} ${origin.x} ${origin.y} ${origin.z} ${size.x} ${size.y} ${size.z} ${solids} ${bot}` : ''
    const line = await send(`execute in ${dimension} run companionblueprint ${operation} ${id} ${nonce}${fields}`, completion, abort)
    const result = completion.exec(line)?.groups
    if (!result) throw new Error('blueprint-receipt-unconfirmed')
    return { operationId: id, sha256: result.sha256, phase: result.phase, total: Number(result.total), solids: Number(result.solids),
      checked: Number(result.checked), matched: Number(result.matched), placed: Number(result.placed), restored: result.restored === 'true',
      ...(result.reason !== '-' && { reason: result.reason }) }
  }

  let requiresStop = false
  try {
    signal.throwIfAborted()
    requiresStop = true
    let report = await command('start', signal).catch(error => {
      if (error instanceof Error && error.message === 'console-command-rejected') {
        requiresStop = false
        throw new Error('blueprint-server-unavailable')
      }
      throw error
    })
    while (['checking', 'placing', 'verifying'].includes(report.phase ?? '')) {
      if (report.sha256 !== hash || report.solids !== solids || report.total !== size.x * size.y * size.z) {
        throw new Error('blueprint-receipt-unconfirmed')
      }
      await delay(400, undefined, { signal })
      report = await command('status', signal)
    }
    const parsed = VoxelWorldReceipt.safeParse(report).data
    if (!parsed || !voxelWorldReceiptMatches(parsed, input, mode)) throw new Error('blueprint-receipt-unconfirmed')
    requiresStop = false
    return parsed
  } finally {
    if (requiresStop) {
      const stopped = await command('cancel').catch(() => undefined)
      if (!stopped || stopped.sha256 !== hash || !stopped.restored || !['ready', 'built', 'failed', 'cancelled'].includes(stopped.phase ?? '')) {
        throw new Error('blueprint-stop-unconfirmed')
      }
    }
  }
}
