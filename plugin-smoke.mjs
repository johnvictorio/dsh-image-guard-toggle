import assert from 'node:assert/strict'
import { apply } from './index.js'

const KB = 1024
const MB = 1048576

function makeFakeCtx(budgetMb = 8) {
  const registered = { tools: new Map(), events: new Map() }
  const toggleValue = { enabled: true, budgetMb }
  const llmValue = { providers: { hyper: { maxRequestImageBytes: budgetMb * 1048576 } } }
  const settings = {
    register: () => () => {},
    get: (ns) => (ns === 'image-guard-toggle' ? toggleValue : ns === 'llm-pi-ai' ? llmValue : undefined),
    describe: () => [],
    update: async () => {},
    mutate: async () => {},
  }
  const ctx = {
    logger: { warn: () => {}, error: () => {}, info: () => {} },
    get: (name) => (name === 'settings' ? settings : name === 'fs' ? undefined : undefined),
    on: (event, handler) => { registered.events.set(event, handler) },
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    tools: {
      register: (def) => { registered.tools.set(def.name, def); return () => {} },
      guard: () => () => {},
    },
  }
  ctx.waterfall = () => {}
  return { ctx, registered, settings }
}

function imageEvent(seq, callId, bytes, path) {
  return {
    type: 'tool/result', seq, time: 0, surfaceOp: 'append',
    data: { turn: 1, step: seq, message: { id: `m${seq}`, role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [
      { type: 'text', text: `<path>${path}</path>\n<type>image</type>` },
      { type: 'image', attachment: { attachmentId: `a${seq}`, mediaType: 'image/png', bytes, width: 100, height: 100 } },
    ] }] } },
  }
}

function makeSession() {
  const events = [
    { type: 'user/message', seq: 0, time: 0, surfaceOp: 'append', data: { id: 'u0', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
    imageEvent(1, 'c1', 2 * MB, '/shots/one.png'),
    imageEvent(2, 'c2', 6 * MB, '/shots/two.png'),
  ]
  const session = {
    events,
    surface: { nodes: [0, 1, 2], replaceGeneration: 0 },
    header: { cwd: '/home/test' },
    append: (type, data, intent) => {
      const seq = events.length
      events.push({ type, seq, time: 0, ...intent === undefined ? {} : { ...intent }, ...(type === 'user/message' ? { data } : { data }) })
      if (type === 'tool/result') session.surface = { nodes: session.surface.nodes.map((n) => (n === intent.surfaceOp.start ? seq : n)), replaceGeneration: session.surface.replaceGeneration + 1 }
      return { seq }
    },
  }
  return session
}

const { ctx, registered } = makeFakeCtx()
apply(ctx)

assert.ok(registered.tools.has('list_images'), 'list_images registered')
assert.ok(registered.tools.has('drop_image'), 'drop_image registered')
assert.ok(registered.events.has('tools/post-execute'), 'post-execute hooked')
assert.ok(registered.events.has('tools/pre-execute'), 'pre-execute hooked')

const session = makeSession()
const agent = { session }

const list = await registered.tools.get('list_images').execute({}, { agent })
assert.equal(list.images.length, 2)
assert.deepEqual(list.images.map((i) => [i.id, i.file, i.kb]), [[1, '/shots/one.png', 2048], [2, '/shots/two.png', 6144]])
assert.equal(list.budget, '8.00 MB')
console.log('list render:', JSON.stringify(registered.tools.get('list_images').output.render({}, list)[0].text))

const capped = Math.ceil(1 * MB * 4 / 3) * 2
assert.equal(list.totalMb, (capped / MB).toFixed(2))

const drop = await registered.tools.get('drop_image').execute({ ids: [1] }, { agent })
assert.deepEqual(drop.dropped.map((d) => d.id), [1])
assert.equal(drop.stale.length, 0)
console.log('drop render:', registered.tools.get('drop_image').output.render({}, drop)[0].text)

const after = await registered.tools.get('list_images').execute({}, { agent })
assert.deepEqual(after.images.map((i) => i.id), [2])

const drop2 = await registered.tools.get('drop_image').execute({ ids: [1, 99] }, { agent })
assert.deepEqual(drop2.dropped, [])
assert.deepEqual(drop2.stale, [1, 99])
console.log('stale render:', registered.tools.get('drop_image').output.render({}, drop2)[0].text)

const preExecute = registered.events.get('tools/pre-execute')
const notImage = await preExecute(
  { name: 'bash', arguments: { command: 'ls' }, agent, signal: new AbortController().signal },
  async () => ({ kind: 'allow' }),
)
assert.deepEqual(notImage, { kind: 'allow' }, 'non-image tools pass through')

const missing = await preExecute(
  { name: 'read_image', arguments: { file_path: '/definitely/not/here.png' }, agent, signal: new AbortController().signal },
  async () => ({ kind: 'allow' }),
)
assert.deepEqual(missing, { kind: 'allow' }, 'unstatutable path stays allowed')

const { writeFileSync, unlinkSync } = await import('node:fs')
const tmp = '/tmp/image-guard-probe.png'
writeFileSync(tmp, Buffer.alloc(400 * 1024))

const tight = makeFakeCtx(1)
apply(tight.ctx)
const tightPre = tight.registered.events.get('tools/pre-execute')
const denied = await tightPre(
  { name: 'read_image', arguments: { file_path: tmp }, agent: { session: makeSession() }, signal: new AbortController().signal },
  async () => ({ kind: 'allow' }),
)
assert.equal(denied.kind, 'deny')
assert.match(denied.reason, /would exceed the 1\.00 MB budget/)
assert.match(denied.reason, /drop_image/)
console.log('deny reason:', denied.reason.slice(0, 130))

const roomy = makeFakeCtx(9)
apply(roomy.ctx)
const allowed = await roomy.registered.events.get('tools/pre-execute')(
  { name: 'read_image', arguments: { file_path: tmp }, agent: { session: makeSession() }, signal: new AbortController().signal },
  async () => ({ kind: 'allow' }),
)
assert.deepEqual(allowed, { kind: 'allow' }, 'under-budget reads are allowed')
unlinkSync(tmp)

const post = registered.events.get('tools/post-execute')
const result = { isError: false, value: {}, content: [
  { type: 'text', text: '<path>/shots/three.png</path>' },
  { type: 'image', attachment: { attachmentId: 'a3', mediaType: 'image/png', bytes: 1 * MB, width: 100, height: 100 } },
] }
const decision = await post({ name: 'read_image', agent }, result, async () => ({ kind: 'accept' }))
assert.equal(decision.content.length, 3)
console.log('appended usage line:', decision.content[2].text)
assert.match(decision.content[2].text, /session image context: 2 images, about 2\.67 MB of 8\.00 MB used \(33%\)/)

const passthrough = await post({ name: 'bash' }, result, async () => ({ kind: 'accept' }))
assert.equal(passthrough.content, undefined, 'non-read_image decisions pass through untouched')

console.log('PLUGIN SMOKE OK')
