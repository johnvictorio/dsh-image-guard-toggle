import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateRequestBytes, formatMb, collectSessionImages, sessionUsage, buildDropReplacements } from './index.js'

const KB = 1024

test('estimateRequestBytes caps then converts raw bytes to base64 cost', () => {
  assert.equal(estimateRequestBytes(100), Math.ceil(100 * 4 / 3))
  assert.equal(estimateRequestBytes(5 * 1024 * 1024), Math.ceil(1048576 * 4 / 3))
  assert.equal(estimateRequestBytes(1048576), Math.ceil(1048576 * 4 / 3))
})

test('formatMb rounds to two decimals', () => {
  assert.equal(formatMb(8 * 1048576), '8.00')
  assert.equal(formatMb(104857), '0.10')
})

function fakeSession() {
  const events = []
  const push = (event) => {
    events.push(event)
    return event
  }
  push({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1, reason: 'start' } })
  push({ type: 'assistant/message', seq: 1, time: 0, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'hyper', model: 'm' }, content: [{ type: 'tool-call', id: 'call_1', name: 'read_image', arguments: '{}' }] } } })
  push({ type: 'tool/result', seq: 2, time: 0, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'r1', role: 'user', source: { kind: 'tool', callId: 'call_1' }, content: [{ type: 'tool-result', toolCallId: 'call_1', content: [
    { type: 'text', text: '<path>/tmp/one.png</path>\n<type>image</type>' },
    { type: 'image', attachment: { attachmentId: 'att1', mediaType: 'image/png', bytes: 300 * KB, width: 800, height: 600 } },
  ] }] } } })
  push({ type: 'assistant/message', seq: 3, time: 0, data: { turn: 1, step: 2, message: { id: 'a2', role: 'assistant', source: { kind: 'model', provider: 'hyper', model: 'm' }, content: [{ type: 'tool-call', id: 'call_2', name: 'read_image', arguments: '{}' }] } } })
  push({ type: 'tool/result', seq: 4, time: 0, surfaceOp: 'append', data: { turn: 1, step: 2, message: { id: 'r2', role: 'user', source: { kind: 'tool', callId: 'call_2' }, content: [{ type: 'tool-result', toolCallId: 'call_2', content: [
    { type: 'text', text: '<path>/tmp/two.png</path>' },
    { type: 'image', attachment: { attachmentId: 'att2', mediaType: 'image/png', bytes: 900 * KB, width: 800, height: 600 } },
  ] }] } } })
  push({ type: 'user/message', seq: 5, time: 0, surfaceOp: 'append', data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [
    { type: 'text', text: 'look at this' },
    { type: 'image', attachment: { attachmentId: 'att3', mediaType: 'image/png', bytes: 200 * KB, width: 400, height: 300 } },
  ] } })
  const surfaceNodes = [0, 1, 2, 3, 4, 5].filter((i) => i !== 0)
  return { events, surface: { nodes: surfaceNodes, replaceGeneration: 0 } }
}

test('collectSessionImages finds tool-result images oldest first with ids, files, tools', () => {
  const { entries, userAttached } = collectSessionImages(fakeSession())
  assert.equal(userAttached, 1)
  assert.deepEqual(entries.map((e) => [e.seq, e.file, e.tool, e.kb]), [
    [2, '/tmp/one.png', 'read_image', 300],
    [4, '/tmp/two.png', 'read_image', 900],
  ])
})

test('sessionUsage counts all images including user attachments', () => {
  const usage = sessionUsage(fakeSession())
  assert.equal(usage.count, 3)
  assert.equal(usage.bytes, Math.ceil(300 * KB * 4 / 3) + Math.ceil(900 * KB * 4 / 3) + Math.ceil(200 * KB * 4 / 3))
})

test('buildDropReplacements replaces image blocks with markers, keeps text and rest', () => {
  const session = fakeSession()
  const { stale, replacements } = buildDropReplacements(session, [4, 99, 5])
  assert.deepEqual(stale, [99, 5])
  assert.equal(replacements.length, 1)
  const rep = replacements[0]
  assert.equal(rep.seq, 4)
  assert.equal(rep.data.turn, 1)
  assert.equal(rep.data.step, 2)
  assert.deepEqual(rep.data.message.id, 'r2')
  const blocks = rep.data.message.content[0].content
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /<path>/)
  assert.equal(blocks[1].type, 'text')
  assert.match(blocks[1].text, /dropped from context by drop_image/)
  assert.match(blocks[1].text, /900 KB/)
})

test('buildDropReplacements on already-text result is stale', () => {
  const session = fakeSession()
  const session2 = {
    events: session.events.map((e) => e.seq === 4 ? { ...e, data: { ...e.data, message: { ...e.data.message, content: [{ ...e.data.message.content[0], content: [{ type: 'text', text: 'plain' }] }] } } } : e),
    surface: session.surface,
  }
  const { stale, replacements } = buildDropReplacements(session2, [4])
  assert.deepEqual(stale, [4])
  assert.equal(replacements.length, 0)
})

test('replaced surface recomputes usage without dropped images', () => {
  const session = fakeSession()
  const { replacements } = buildDropReplacements(session, [4])
  const rep = replacements[0]
  const surface = { ...session.surface, nodes: session.surface.nodes.map((n) => n === 4 ? 6 : n) }
  const events = [...session.events, { type: 'tool/result', seq: 6, time: 0, surfaceOp: { op: 'replace', start: 4, end: 4 }, data: rep.data }]
  const usage = sessionUsage({ events, surface })
  assert.equal(usage.count, 2)
  assert.equal(usage.bytes, Math.ceil(300 * KB * 4 / 3) + Math.ceil(200 * KB * 4 / 3))
})
