import assert from 'node:assert/strict'
import test from 'node:test'
import { parseBilibiliSubtitleFile } from '../src/core/bilibili-subtitle.ts'
import { MAX_BILIBILI_SUBTITLE_BYTES } from '../src/protocol/bilibili.ts'

const srtCue = '00:00:00,010 --> 00:00:01,250'
const vttCue = '00:00.010 --> 00:01.250'

test('SRT keeps millisecond timing and multilingual text across BOM, CRLF and multiline cues', () => {
  const content = [
    '\uFEFF1',
    srtCue,
    '<font color="#00ff00">大肥鱼</font> &amp; 🐟',
    '<i>Bonjour</i> こんにちは',
    '',
    '002',
    '00:00:01,200 --> 00:00:02,425',
    'Overlap &nbsp; العربية',
  ].join('\r\n')
  assert.deepEqual(parseBilibiliSubtitleFile('srt', content), [
    { from: 0.01, to: 1.25, text: '大肥鱼 & 🐟 Bonjour こんにちは' },
    { from: 1.2, to: 2.425, text: 'Overlap العربية' },
  ])
})

test('WebVTT skips comments, styles and regions while retaining identified cues in order', () => {
  const content = [
    '\uFEFFWEBVTT example',
    '',
    'STYLE',
    '::cue { background: url(https://example.invalid/image); }',
    '',
    'REGION',
    'id:main width:40%',
    '',
    'NOTE materials',
    'This does not enter the subtitle.',
    '',
    'first-cue',
    vttCue + '\tregion:main align:start position:50%,line-left',
    '<v Speaker><c.highlight>Fish</c> <00:00.800>🐟 &lt; 3 &#x9c7c;',
    '',
    'NOTE',
    '',
    '00:00:01.100 --> 00:00:01.500',
    '<ruby>魚<rt>さかな</rt></ruby>',
  ].join('\r')
  assert.deepEqual(parseBilibiliSubtitleFile('vtt', content), [
    { from: 0.01, to: 1.25, text: 'Fish 🐟 < 3 鱼' },
    { from: 1.1, to: 1.5, text: '魚さかな' },
  ])
})

test('timings are validated for every cue and permit equal chronological starts', () => {
  assert.deepEqual(parseBilibiliSubtitleFile('vtt', `WEBVTT\n\n${vttCue}\nfirst\n\n${vttCue}\nsecond`), [
    { from: 0.01, to: 1.25, text: 'first' },
    { from: 0.01, to: 1.25, text: 'second' },
  ])
  const invalidTimings = [
    '00:60:00,010 --> 00:00:01,250',
    '00:00:00,010 --> 00:00:60,000',
    '-00:00:00,010 --> 00:00:01,250',
    '00:00:00,010 --> 00:00:01,25',
    '00:00:00,010 --> 00:00:00,010',
    '00:00:01,250 --> 00:00:00,010',
    '00:00:00,010 --> 168:00:00,001',
    '00:00:00,010-->00:00:01,250',
  ]
  for (const timeline of invalidTimings) assert.equal(parseBilibiliSubtitleFile('srt', `1\n${timeline}\nsubtitle`), undefined, timeline)
  assert.equal(parseBilibiliSubtitleFile('srt', `1\n${srtCue}\nfirst\n\n2\n00:00:00,009 --> 00:00:02,000\nsecond`), undefined)
})

test('rejects ambiguous format, empty payloads and VTT blocks that would hide a malformed timing', () => {
  const invalidSrt = [
    '', srtCue + '\nno ordinal', '0\n' + srtCue + '\nzero ordinal', '1\n' + srtCue,
    '1\n' + srtCue + '\n\n2\n' + srtCue + '\npayload', '1\n' + srtCue + '\n<b> </b>',
    '1\n' + vttCue + '\nwrong timing delimiter', '1\n' + srtCue + '\nfirst\n2\n' + srtCue + '\nmissing separator',
  ]
  for (const content of invalidSrt) assert.equal(parseBilibiliSubtitleFile('srt', content), undefined, content)
  const invalidVtt = [
    vttCue + '\nno header',
    'WEBVTTjunk\n\n' + vttCue + '\nwrong header',
    'WEBVTT --> invalid\n\n' + vttCue + '\npayload',
    'WEBVTT\n' + vttCue + '\nmissing blank line',
    'WEBVTT\n\nNOTE\n' + vttCue + '\nconcealed cue',
    'WEBVTT\n\n' + vttCue + ' malformed\ninvalid settings',
    `WEBVTT\n\nrepeat\n${vttCue}\nfirst\n\nrepeat\n${vttCue}\nsecond`,
  ]
  for (const content of invalidVtt) assert.equal(parseBilibiliSubtitleFile('vtt', content), undefined, content)
})

test('subtitle markup and entities produce plain cue text without raw presentation tags', () => {
  const payload = '<b>Fish</b><img src=x onerror=alert(1)> &lt;svg onload=alert(1)&gt; &quot;鲸&quot; &#x1f41f;'
  const [cue] = parseBilibiliSubtitleFile('srt', `1\n${srtCue}\n${payload}`)
  assert.equal(cue.text, 'Fish "鲸" 🐟')
})

test('rejects bad controls, unmatched UTF-16 surrogates and byte or cue budget overruns', () => {
  for (const character of ['\u0000', '\u000B', '\u007F', '\u0085', '\uD800', '\uDC00']) {
    assert.equal(parseBilibiliSubtitleFile('srt', `1\n${srtCue}\nfish${character}`), undefined)
  }
  const prefix = `1\n${srtCue}\n`
  const atLimit = prefix + 'x'.repeat(MAX_BILIBILI_SUBTITLE_BYTES - Buffer.byteLength(prefix))
  assert.equal(Buffer.byteLength(atLimit), MAX_BILIBILI_SUBTITLE_BYTES)
  assert.equal(parseBilibiliSubtitleFile('srt', atLimit).length, 1)
  assert.equal(parseBilibiliSubtitleFile('srt', atLimit + '🐟'), undefined)
  const many = 'WEBVTT\n\n' + `${vttCue}\n鱼\n\n`.repeat(6_000)
  assert.ok(Buffer.byteLength(many) < MAX_BILIBILI_SUBTITLE_BYTES)
  assert.equal(parseBilibiliSubtitleFile('vtt', many).length, 6_000)
  assert.equal(parseBilibiliSubtitleFile('vtt', many + `${vttCue}\n鱼`), undefined)
})
