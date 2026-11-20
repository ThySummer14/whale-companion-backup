import { compound, string, tag } from './nbt-write.ts'

const State = /^(?<name>[a-z0-9_.-]+:[a-z0-9_./-]+)(?:\[(?<attributes>[a-z0-9_]+=[a-z0-9_-]+(?:,[a-z0-9_]+=[a-z0-9_-]+)*)\])?$/u

export function minecraftBlockState(value: string) {
  const result = State.exec(value)
  const match = result?.groups
  if (result?.[0] !== value || !match?.name) return
  const properties = new Map<string, string>()
  for (const attribute of match.attributes?.split(',') ?? []) {
    const [key, setting] = attribute.split('=') as [string, string]
    if (properties.has(key)) return
    properties.set(key, setting)
  }
  const sorted = [...properties].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  const state = sorted.length ? `${match.name}[${sorted.map(([key, setting]) => `${key}=${setting}`).join(',')}]` : match.name
  return { name: match.name, properties: sorted, state }
}

export function blockStateNbt(raw: string): Buffer {
  const block = minecraftBlockState(raw)
  if (!block) throw new Error('invalid-minecraft-block-state')
  return compound(string('Name', block.name), ...(block.properties.length ? [
    tag(10, 'Properties', compound(...block.properties.map(([key, value]) => string(key, value)))),
  ] : []))
}
