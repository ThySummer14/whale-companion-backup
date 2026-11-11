import assert from 'node:assert/strict'
import test from 'node:test'
import { crc32, inflateSync } from 'node:zlib'
import { renderSurveyCard } from '../src/host/survey-card.ts'

const verified = 0x2b7564
const planned = 0x9c7549
const field = 0xfcf8ea

function trail(outcome, checkpoints) {
  return { kind: 'survey', at: '2026-11-09T12:00:00Z', outcome, route: { kind: 'trail', trail: 'east-north', checkpoints } }
}

function straight(direction, steps, outcome = 'completed') {
  return { kind: 'survey', at: '2026-11-09T12:00:00Z', outcome, route: { kind: 'straight', direction, steps } }
}

function decode(card) {
  assert.deepEqual([...card.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  const chunks = new Map()
  let offset = 8
  while (offset < card.length) {
    const length = card.readUInt32BE(offset)
    const name = card.toString('ascii', offset + 4, offset + 8)
    const end = offset + 8 + length
    assert.equal(card.readUInt32BE(end), crc32(card.subarray(offset + 4, end)), name)
    assert.ok(!chunks.has(name), name)
    chunks.set(name, card.subarray(offset + 8, end))
    offset = end + 4
  }
  assert.equal(offset, card.length)
  assert.deepEqual([...chunks.keys()], ['IHDR', 'PLTE', 'IDAT', 'IEND'])
  const header = chunks.get('IHDR')
  assert.equal(header.length, 13)
  const width = header.readUInt32BE()
  const height = header.readUInt32BE(4)
  assert.deepEqual([width, height, ...header.subarray(8)], [288, 208, 8, 3, 0, 0, 0])
  const palette = chunks.get('PLTE')
  const pixels = inflateSync(chunks.get('IDAT'))
  const stride = width + 1
  assert.equal(pixels.length, stride * height)
  for (let y = 0; y < height; y++) assert.equal(pixels[y * stride], 0)
  return (x, y) => palette.readUIntBE(pixels[y * stride + 1 + x] * 3, 3)
}

test('survey cards are compact PNGs and depend only on the bounded route and outcome', () => {
  const receipt = trail('completed', 2)
  const card = renderSurveyCard(receipt)
  assert.ok(card.length < 4096)
  assert.deepEqual(card, renderSurveyCard({ ...receipt, at: 'private timestamp', zoneId: 'private zone',
    taskId: 'private task', route: { ...receipt.route, x: 12345, name: 'private title' } }))
  const pixel = decode(card)
  assert.equal(pixel(0, 0), 0x233b32)
  assert.equal(pixel(35, 78), 0x5e6e5f) // North marker.
  assert.equal(pixel(142, 118), 0x8d5944) // Camp marker.
  assert.equal(pixel(167, 15), 0xdde9d5) // Complete badge.
  assert.equal(pixel(172, 118), verified)
  assert.equal(pixel(172, 90), verified)
})

test('early return draws zero or one verified legs without marking unvisited checkpoints', () => {
  const zero = decode(renderSurveyCard(trail('recovered', 0)))
  const one = decode(renderSurveyCard(trail('recovered', 1)))
  assert.equal(zero(167, 15), 0xeee1c2)
  assert.equal(one(167, 15), 0xeee1c2)
  assert.equal(zero(155, 118), planned)
  assert.equal(zero(159, 118), field) // Gap in the dashed first leg.
  assert.equal(zero(172, 118), field)
  assert.equal(one(155, 118), verified)
  assert.equal(one(159, 118), verified)
  assert.equal(one(172, 118), verified)
  for (const pixel of [zero, one]) {
    assert.equal(pixel(172, 107), planned)
    assert.equal(pixel(172, 103), field)
    assert.equal(pixel(172, 90), field)
  }
})

test('straight routes honor each cardinal direction and the allowed distance', () => {
  for (const [direction, endpoint] of [
    ['north', [144, 69]], ['east', [193, 118]], ['south', [144, 167]], ['west', [95, 118]],
  ]) assert.equal(decode(renderSurveyCard(straight(direction, 7)))(...endpoint), verified)
  const short = decode(renderSurveyCard(straight('north', 4)))
  assert.equal(short(144, 90), verified)
  assert.equal(short(144, 69), field)
  const returned = decode(renderSurveyCard(straight('north', 7, 'recovered')))
  assert.equal(returned(144, 69), field)
  assert.equal(returned(144, 107), planned)
})

test('invalid directions, distances, trail IDs and outcome combinations are rejected', () => {
  for (const receipt of [
    undefined, null, { kind: 'build' }, { ...trail('completed', 2), route: undefined },
    { ...trail('completed', 2), route: { kind: 'diagonal' } }, straight('northeast', 4), straight('constructor', 4),
    straight('east', 3), straight('east', 8), straight('east', 4.5), straight('east', '4'), straight('east', NaN),
    trail('planned', 0), trail('completed', 1), trail('recovered', 2), trail('recovered', -1),
    { ...trail('completed', 2), route: { kind: 'trail', trail: 'east-west', checkpoints: 2 } },
  ]) assert.throws(() => renderSurveyCard(receipt), { name: 'TypeError', message: 'Invalid survey receipt' })
})
