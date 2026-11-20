import { crc32, deflateSync } from 'node:zlib'

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii')
  const result = Buffer.alloc(data.length + 12)
  result.writeUInt32BE(data.length)
  name.copy(result, 4)
  data.copy(result, 8)
  result.writeUInt32BE(crc32(data, crc32(name)), result.length - 4)
  return result
}

export function encodePng(width: number, height: number, scanlines: Buffer, palette?: Buffer): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = palette ? 3 : 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), ...(palette ? [chunk('PLTE', palette)] : []),
    chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0)),
  ])
}
