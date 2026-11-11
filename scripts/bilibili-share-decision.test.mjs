import assert from 'node:assert/strict'
import test from 'node:test'
import { bilibiliSharePrompt, parseBilibiliShare } from '../src/host/bilibili-share.ts'

const source = {
  bvid: 'BV1234567890', part: 2,
  cues: [
    { from: 12.74, to: 14, text: '海风吹过安静的旧码头' },
    { from: 29.9, to: 31, text: '远处的灯塔每隔三秒亮一次' },
  ],
}

const decide = (observation, cueIndex = 0) => JSON.stringify({ decision: 'share', observation, cueIndex })

test('a reading decision can stay private or attach the selected real cue time', () => {
  assert.equal(parseBilibiliShare('{"decision":"skip"}', source), undefined)
  assert.deepEqual(parseBilibiliShare(decide('我想弄明白为什么人会记住这样的声音。', 1), source), {
    observation: '我想弄明白为什么人会记住这样的声音。', startSeconds: 29,
  })
  const prompt = bilibiliSharePrompt('大肥鱼', source)
  assert.match(prompt, /外部资料/u)
  assert.match(prompt, /不得引用或复述字幕/u)
  assert.match(prompt, /海风吹过安静的旧码头/u)
})

test('a model cannot choose an unoffered cue, fabricate a timestamp or attach a link', () => {
  assert.throws(() => parseBilibiliShare(decide('我对这类声音产生了好奇。', 2), source), /bili-share-cue-unconfirmed/u)
  assert.throws(() => parseBilibiliShare('{"decision":"share","observation":"我对这段产生了好奇。","cueIndex":0,"startSeconds":60}', source))
  for (const observation of ['我想去 https://example.org 看看。', '我想聊聊 @其他账号。', '我刚把整集看完了。', '我觉得这段值得多看。\n接下来是私聊。']) {
    assert.throws(() => parseBilibiliShare(decide(observation), source))
  }
})

test('known cue excerpts are rejected even if copied from a different offered cue or with added punctuation', () => {
  for (const observation of ['我读到海风吹过安静的旧码头。', '我想起远处的灯塔，每隔三秒亮一次。']) {
    assert.throws(() => parseBilibiliShare(decide(observation), source), /bili-share-repeats-subtitles/u)
  }
})
