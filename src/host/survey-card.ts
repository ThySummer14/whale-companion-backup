import { crc32, deflateSync } from 'node:zlib'
import { surveyDiagram, type SurveyPoint } from '../core/survey-diagram.ts'
import type { CommunityCampReceipt } from '../protocol/api.ts'

const WIDTH = 288
const HEIGHT = 208
const STRIDE = WIDTH + 1 // Each PNG scanline starts with a zero filter byte.
const CENTER_X = 144
const CENTER_Y = 118
const STEP = 7

const PALETTE = {
  paper: 0xf3efde,
  field: 0xfcf8ea,
  ink: 0x233b32,
  grid: 0xe5dfca,
  muted: 0x5e6e5f,
  camp: 0x8d5944,
  verified: 0x2b7564,
  planned: 0x9c7549,
  recovery: 0xeee1c2,
  complete: 0xdde9d5,
  rule: 0xcec5ab,
} as const
type Color = keyof typeof PALETTE
const colorIndex = Object.fromEntries(Object.keys(PALETTE).map((color, index) => [color, index])) as Record<Color, number>
const palette = Buffer.from(Object.values(PALETTE).flatMap(rgb => [rgb >> 16, (rgb >> 8) & 0xff, rgb & 0xff]))

// Seven rows of five bits, used only for the card's fixed labels and bounded counters.
const FONT: Record<string, readonly number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17], C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30], E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15],
  H: [17, 17, 17, 31, 17, 17, 17], I: [31, 4, 4, 4, 4, 4, 31],
  K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 25, 21, 19, 17, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4], Y: [17, 17, 10, 4, 4, 4, 4],
  0: [14, 17, 19, 21, 25, 17, 14], 1: [4, 12, 4, 4, 4, 4, 14],
  2: [14, 17, 1, 2, 4, 8, 31], 4: [2, 6, 10, 18, 31, 2, 2],
  5: [31, 16, 16, 30, 1, 17, 14], 6: [6, 8, 16, 30, 17, 17, 14],
  7: [31, 1, 2, 4, 8, 8, 8], '/': [1, 1, 2, 4, 8, 16, 16],
}

class Raster {
  readonly scanlines = Buffer.alloc(STRIDE * HEIGHT)

  rect(x: number, y: number, width: number, height: number, color: Color) {
    for (let row = y; row < y + height; row++) {
      const start = row * STRIDE + 1 + x
      this.scanlines.fill(colorIndex[color], start, start + width)
    }
  }

  label(x: number, y: number, text: string, color: Color, scale = 1) {
    for (const character of text) {
      FONT[character]?.forEach((bits, row) => {
        for (let column = 0; column < 5; column++) {
          if (bits & (16 >> column)) this.rect(x + column * scale, y + row * scale, scale, scale, color)
        }
      })
      x += 6 * scale
    }
  }

  segment([x, y]: SurveyPoint, [endX, endY]: SurveyPoint, verified: boolean) {
    const dx = Math.sign(endX - x)
    const dy = Math.sign(endY - y)
    const length = Math.abs(endX - x) + Math.abs(endY - y)
    for (let offset = 0; offset <= length; offset++) {
      if (verified || offset % 9 < 5) {
        this.rect(x + dx * offset - 1, y + dy * offset - 1, 3, 3, verified ? 'verified' : 'planned')
      }
    }
  }

  camp(x: number, y: number) {
    this.rect(x - 6, y - 6, 13, 13, 'field')
    this.rect(x - 1, y - 5, 3, 1, 'camp')
    this.rect(x - 3, y - 4, 7, 1, 'camp')
    this.rect(x - 5, y - 3, 11, 2, 'camp')
    this.rect(x - 4, y - 1, 9, 6, 'camp')
    this.rect(x, y + 1, 2, 4, 'field')
  }
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii')
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length)
  name.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(data, crc32(name)), chunk.length - 4)
  return chunk
}

export function renderSurveyCard(receipt: Extract<CommunityCampReceipt, { kind: 'survey' }>): Buffer {
  const diagram = surveyDiagram(receipt)
  if (!diagram) throw new TypeError('Invalid survey receipt')

  const card = new Raster()
  const complete = receipt.outcome === 'completed'
  const status = complete ? 'COMPLETE' : 'EARLY RETURN'
  const details = receipt.route.kind === 'trail' ? `${diagram.reached}/2 CHECKPOINTS` : `${receipt.route.steps} STEP ROUTE`
  card.rect(0, 0, WIDTH, HEIGHT, 'ink')
  card.rect(2, 2, WIDTH - 4, HEIGHT - 4, 'paper')
  card.rect(16, 14, 7, 7, 'verified')
  card.label(29, 14, 'COOPCRAFT', 'muted')
  card.label(16, 29, 'SURVEY LOG', 'ink', 2)
  card.rect(166, 14, 106, 30, complete ? 'complete' : 'recovery')
  card.label(219 - Math.floor(status.length * 6 / 2), 20, status, 'ink')
  card.label(219 - Math.floor(details.length * 6 / 2), 32, details, 'muted')

  card.rect(16, 54, 256, 128, 'rule')
  card.rect(17, 55, 254, 126, 'field')
  for (let y = 62; y <= 174; y += 14) {
    for (let x = 32; x <= 256; x += 14) card.rect(x, y, 1, 1, 'grid')
  }
  card.rect(24, 62, 23, 28, 'field')
  card.label(33, 63, 'N', 'muted')
  card.rect(35, 73, 1, 11, 'muted')
  card.rect(34, 74, 3, 2, 'muted')
  card.rect(33, 76, 5, 2, 'muted')

  const points = diagram.points.map(([x, y]): SurveyPoint => [CENTER_X + x * STEP, CENTER_Y + y * STEP])
  for (const [index, point] of points.entries()) {
    if (index > 0) card.segment(points[index - 1]!, point, index <= diagram.reached)
  }
  for (const [index, [x, y]] of points.slice(1).entries()) {
    const reached = index < diagram.reached
    card.rect(x - 4, y - 4, 9, 9, 'field')
    card.rect(x - 3, y - 3, 7, 7, reached ? 'verified' : 'planned')
    card.rect(x - 1, y - 1, 3, 3, 'field')
    if (reached) card.rect(x, y, 1, 1, 'verified')
  }
  card.camp(CENTER_X, CENTER_Y)

  card.camp(23, 195)
  card.label(35, 192, 'CAMP', 'muted')
  card.segment([84, 195], [104, 195], true)
  card.label(112, 192, 'VERIFIED', 'muted')
  card.segment([183, 195], [203, 195], false)
  card.label(211, 192, 'PLANNED', 'muted')

  const header = Buffer.alloc(13)
  header.writeUInt32BE(WIDTH)
  header.writeUInt32BE(HEIGHT, 4)
  header[8] = 8
  header[9] = 3 // Indexed color.
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('PLTE', palette),
    pngChunk('IDAT', deflateSync(card.scanlines)), pngChunk('IEND', Buffer.alloc(0)),
  ])
}
