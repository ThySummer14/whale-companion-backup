import { gzipSync } from 'node:zlib'

function text(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  const length = Buffer.alloc(2)
  length.writeUInt16BE(bytes.length)
  return Buffer.concat([length, bytes])
}

export function number(value: number, long = false): Buffer {
  const bytes = Buffer.alloc(long ? 8 : 4)
  if (long) bytes.writeBigInt64BE(BigInt(value))
  else bytes.writeInt32BE(value)
  return bytes
}

export const tag = (type: number, name: string, body: Buffer) => Buffer.concat([Buffer.from([type]), text(name), body])
export const compound = (...fields: Buffer[]) => Buffer.concat([...fields, Buffer.from([0])])
export const integer = (name: string, value: number) => tag(3, name, number(value))
export const string = (name: string, value: string) => tag(8, name, text(value))
export const list = (name: string, elements: Buffer[] = [], type = 10) =>
  tag(9, name, Buffer.concat([Buffer.from([type]), number(elements.length), ...elements]))
export const vector = (name: string, x: number, y: number, z: number) =>
  tag(10, name, compound(integer('x', x), integer('y', y), integer('z', z)))
export const nbtFile = (...fields: Buffer[]) => gzipSync(tag(10, '', compound(...fields)))

export function short(name: string, value: number): Buffer {
  const bytes = Buffer.alloc(2)
  bytes.writeUInt16BE(value)
  return tag(2, name, bytes)
}

export const intArray = (name: string, values: readonly number[]) =>
  tag(11, name, Buffer.concat([number(values.length), ...values.map(value => number(value))]))
export const byteArray = (name: string, bytes: Buffer) => tag(7, name, Buffer.concat([number(bytes.length), bytes]))
export const intList = (name: string, values: readonly number[]) => list(name, values.map(value => number(value)), 3)
