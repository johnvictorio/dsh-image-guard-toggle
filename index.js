import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { statSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-image-guard-toggle'
export const inject = ['tools']

const NS = settingsNamespace('image-guard-toggle')
const LLM_NS = settingsNamespace('llm-pi-ai')
const BYTES_PER_MB = 1048576
const DEFAULT_ROUTE = 'hyper'
const DEFAULT_BUDGET_MB = 8
const RETRY_MS = 1000
const RETRY_LIMIT = 30
const PER_IMAGE_CAP_BYTES = 1048576
const NEAR_LIMIT_FRACTION = 0.8

export function estimateRequestBytes(rawBytes) {
  return Math.ceil(Math.min(rawBytes, PER_IMAGE_CAP_BYTES) * 4 / 3)
}

export function formatMb(bytes) {
  return (bytes / BYTES_PER_MB).toFixed(2)
}

export function collectSessionImages(session) {
  const toolNames = new Map()
  for (const event of session.events) {
    if (event.type !== 'assistant/message') continue
    for (const block of event.data?.message?.content ?? []) {
      if (block?.type === 'tool-call' && typeof block.id === 'string') toolNames.set(block.id, block.name ?? 'unknown')
    }
  }
  const entries = []
  let userAttached = 0
  let userBytes = 0
  for (const seq of session.surface.nodes) {
    const event = session.events[seq]
    if (!event) continue
    if (event.type === 'tool/result') {
      const message = event.data?.message
      const result = message?.content?.[0]
      if (result?.type !== 'tool-result' || !Array.isArray(result.content)) continue
      const images = result.content.filter((block) => block?.type === 'image' && typeof block.attachment?.bytes === 'number')
      if (images.length === 0) continue
      const envelope = result.content.find((block) => block?.type === 'text' && typeof block.text === 'string')?.text ?? ''
      const pathMatch = /<path>([^<]*)<\/path>/.exec(envelope)
      entries.push({
        seq,
        images,
        kb: Math.round(images.reduce((sum, image) => sum + image.attachment.bytes, 0) / 1024),
        bytes: images.reduce((sum, image) => sum + estimateRequestBytes(image.attachment.bytes), 0),
        file: pathMatch?.[1] || images[0].attachment.name || 'attached image',
        tool: toolNames.get(result.toolCallId) ?? 'unknown',
      })
    } else if (event.type === 'user/message') {
      const images = (event.data?.content ?? []).filter((block) => block?.type === 'image' && typeof block.attachment?.bytes === 'number')
      if (images.length === 0) continue
      userAttached += images.length
      userBytes += images.reduce((sum, image) => sum + estimateRequestBytes(image.attachment.bytes), 0)
    }
  }
  return { entries, userAttached, userBytes }
}

export function sessionUsage(session) {
  const { entries, userAttached, userBytes } = collectSessionImages(session)
  const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0) + userBytes
  const count = entries.reduce((sum, entry) => sum + entry.images.length, 0) + userAttached
  return { entries, userAttached, count, bytes }
}

export function buildDropReplacements(session, ids, priceOf) {
  const surface = new Set(session.surface.nodes)
  const stale = []
  const replacements = []
  for (const id of ids) {
    if (!surface.has(id)) {
      stale.push(id)
      continue
    }
    const event = session.events[id]
    if (event?.type !== 'tool/result' || event.data?.message?.content?.[0]?.type !== 'tool-result') {
      stale.push(id)
      continue
    }
    const result = event.data.message.content[0]
    if (!result.content.some((block) => block?.type === 'image')) {
      stale.push(id)
      continue
    }
    const content = result.content.map((block) => {
      if (block?.type !== 'image') return block
      const kb = Math.max(1, Math.round(block.attachment.bytes / 1024))
      return { type: 'text', text: `[image-guard] dropped from context by drop_image (about ${kb} KB; it may be re-read with read_image if still needed).]` }
    })
    const data = {
      ...event.data,
      message: freezeMessage({ ...event.data.message, content: [{ ...result, content }] }),
    }
    const shadowedTokenCount = priceOf === undefined ? undefined : priceOf(event.data.message)
    replacements.push({ seq: id, data, shadowedTokenCount })
  }
  return { stale, replacements }
}

function usageLine(count, bytes, budget) {
  if (budget === undefined || budget <= 0) {
    return `[image-guard] session image context: ${count} image${count === 1 ? '' : 's'}, about ${formatMb(bytes)} MB (guard off).`
  }
  const pct = Math.round((bytes / budget) * 100)
  const tail = pct >= NEAR_LIMIT_FRACTION * 100
    ? ' Near the limit: call list_images, then drop_image with unneeded ids before reading more images.'
    : ''
  return `[image-guard] session image context: ${count} image${count === 1 ? '' : 's'}, about ${formatMb(bytes)} MB of ${formatMb(budget)} MB used (${pct}%).${tail}`
}

const ToggleSchema = z.object({
  enabled: z.boolean().default(true),
  budgetMb: z.number().step(1).min(1).max(64).default(DEFAULT_BUDGET_MB),
  route: z.string().default(DEFAULT_ROUTE),
})

export function planMirrorOperation(llm, toggle) {
  const route = typeof toggle.route === 'string' && toggle.route.length > 0 ? toggle.route : DEFAULT_ROUTE
  const budget = Number(toggle.budgetMb)
  const want = toggle.enabled === false
    ? undefined
    : Math.round((Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_BUDGET_MB) * BYTES_PER_MB)
  if (llm === undefined || llm.providers === undefined || llm.providers[route] === undefined) {
    return { kind: 'missing-route', route, want }
  }
  const current = llm.providers[route].maxRequestImageBytes
  if (want === undefined && current === undefined) return { kind: 'noop' }
  if (want !== undefined && current === want) return { kind: 'noop' }
  const path = ['providers', route, 'maxRequestImageBytes']
  if (want === undefined) return { kind: 'op', op: { op: 'unset', path } }
  return { kind: 'op', op: { op: 'set', path, value: want } }
}

export function apply(ctx) {
  let settingsRef
  let fs
  try {
    fs = ctx.get('fs')
  } catch {
    fs = undefined
  }
  let tokenMeter
  try {
    tokenMeter = ctx.get('tokenMeter')
  } catch {
    tokenMeter = undefined
  }

  const budgetBytes = () => {
    const value = settingsRef?.get(NS) ?? {}
    if (value.enabled === false) return undefined
    const mb = Number(value.budgetMb)
    return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_BUDGET_MB) * BYTES_PER_MB
  }

  const usageOf = (agent) => (agent === undefined ? undefined : sessionUsage(agent.session))

  const currentUsageLine = (agent, pendingBlocks) => {
    const usage = usageOf(agent)
    if (usage === undefined) return ''
    const pending = (pendingBlocks ?? [])
      .filter((block) => block?.type === 'image' && typeof block.attachment?.bytes === 'number')
    const bytes = usage.bytes + pending.reduce((sum, block) => sum + estimateRequestBytes(block.attachment.bytes), 0)
    const count = usage.count + pending.length
    return usageLine(count, bytes, budgetBytes())
  }

  ctx.tools.register(defineTool({
    name: 'list_images',
    description: 'List every image currently held in this session\'s context, oldest first: id (the number to pass to drop_image), file, approximate request bytes, and which tool call produced it. Ends with the session image total and the remaining budget. Call this before drop_image to choose ids.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          images: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer' },
                file: { type: 'string' },
                kb: { type: 'integer' },
                tool: { type: 'string' },
              },
            },
          },
          userAttached: { type: 'integer' },
          totalMb: { type: 'string' },
          budget: { type: 'string' },
        },
      },
      render(_args, value) {
        if (value.images.length === 0) {
          return [{ type: 'text', text: `No tool-result images in context.${value.userAttached > 0 ? ` (${value.userAttached} user-attached image${value.userAttached === 1 ? '' : 's'} stay in history and cannot be dropped here.)` : ''}` }]
        }
        const lines = value.images.map((image) => `${image.id}  ${image.kb} KB  ${image.tool}  ${image.file}`)
        return [{ type: 'text', text: `id  approx  tool  file (pass an id to drop_image)\n${lines.join('\n')}\ntotal: ${value.totalMb} MB of ${value.budget}${value.userAttached > 0 ? ` · ${value.userAttached} user-attached image(s) are not droppable here` : ''}` }]
      },
    },
    isConcurrencySafe: () => true,
    execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) return { images: [], userAttached: 0, totalMb: '0', budget: 'unknown (no calling agent)' }
      const usage = sessionUsage(agent.session)
      const budget = budgetBytes()
      return {
        images: usage.entries.map((entry) => ({ id: entry.seq, file: entry.file, kb: entry.kb, tool: entry.tool })),
        userAttached: usage.userAttached,
        totalMb: formatMb(usage.bytes),
        budget: budget === undefined ? 'guard off' : `${formatMb(budget)} MB`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'drop_image',
    description: 'Drop images from this session\'s context by the ids that list_images reported. The result text of that read is rewritten in place (the log keeps the original), freeing request size permanently for every later turn. Use it when the session total is near the budget: drop screenshots already analyzed, superseded, or unrelated to the current task. Keep the ids you still need.',
    parameters: {
      ids: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Image ids from list_images to drop from context',
        required: true,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dropped: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer' },
                file: { type: 'string' },
                kb: { type: 'integer' },
              },
            },
          },
          stale: { type: 'array', items: { type: 'integer' } },
          usage: { type: 'string' },
        },
      },
      render(_args, value) {
        const parts = []
        if (value.dropped.length > 0) parts.push(`dropped ${value.dropped.map((d) => `${d.id} (${d.file}, ${d.kb} KB)`).join(', ')}`)
        if (value.stale.length > 0) parts.push(`unknown ids: ${value.stale.join(', ')} (list_images again)`)
        if (parts.length === 0) parts.push('nothing dropped (no matching ids)')
        parts.push(value.usage.trim())
        return [{ type: 'text', text: parts.join('. ') }]
      },
    },
    execute(args, exec) {
      const agent = exec.agent
      const ids = Array.isArray(args.ids) ? args.ids.filter((id) => Number.isInteger(id) && id > 0) : []
      if (agent === undefined) return { dropped: [], stale: ids, usage: '[image-guard] no calling agent.' }
      const session = agent.session
      const before = sessionUsage(session)
      const { stale, replacements } = buildDropReplacements(session, ids, (message) => tokenMeter?.estimateMessage(message) ?? 0)
      for (const replacement of replacements) {
        if (tokenMeter !== undefined) {
          session.append('compaction/prune', {
            shadowedRange: { start: replacement.seq, end: replacement.seq },
            shadowedSeqs: [replacement.seq],
            shadowedTokenCount: replacement.shadowedTokenCount,
          })
        }
        session.append('tool/result', replacement.data, {
          surfaceOp: { op: 'replace', start: replacement.seq, end: replacement.seq },
          sourceEventSeqs: [replacement.seq],
        })
      }
      const after = sessionUsage(session)
      const dropped = replacements.map((replacement) => {
        const entry = before.entries.find((candidate) => candidate.seq === replacement.seq)
        return { id: replacement.seq, file: entry?.file ?? 'image', kb: entry?.kb ?? 0 }
      })
      return { dropped, stale, usage: usageLine(after.count, after.bytes, budgetBytes()) }
    },
  }))

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.name !== 'read_image' || decision.kind !== 'accept' || result.isError) return decision
    if (Object.hasOwn(decision, 'value')) return decision
    const content = decision.content ?? result.content
    if (!Array.isArray(content) || !content.some((block) => block?.type === 'image')) return decision
    const line = currentUsageLine(exec.agent, content)
    if (line === '') return decision
    return { ...decision, content: [...content, { type: 'text', text: line }] }
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'read_image') return next()
    const budget = budgetBytes()
    if (budget === undefined) return next()
    const usage = usageOf(exec.agent)
    if (usage === undefined) return next()
    const filePath = typeof exec.arguments?.file_path === 'string' && exec.arguments.file_path.length > 0
      ? exec.arguments.file_path
      : undefined
    if (filePath === undefined) return next()
    let size
    if (fs !== undefined) {
      const cwd = exec.agent?.session?.header?.cwd
      try {
        const info = await fs.lstat(filePath, { ...cwd === undefined || typeof cwd !== 'string' ? {} : { cwd } }, exec.signal)
        size = info?.type === 'file' ? info.size : undefined
      } catch {
        size = undefined
      }
    } else {
      try {
        const st = statSync(filePath)
        size = st.isFile() ? st.size : undefined
      } catch {
        size = undefined
      }
    }
    if (size === undefined) return next()
    const incoming = estimateRequestBytes(size)
    if (usage.bytes + incoming <= budget) return next()
    return {
      kind: 'deny',
      reason: `[image-guard] blocked: this session holds ${formatMb(usage.bytes)} MB of images and "${filePath}" (about ${formatMb(incoming)} MB) would exceed the ${formatMb(budget)} MB budget, pushing your oldest screenshots out of the request. Call list_images, then drop_image with ids of screenshots you no longer need, then retry this read. If nothing is safely droppable, work from the descriptions already in history or ask the user to raise the image guard budget.`,
    }
  })

  const install = (settings) => {
    settingsRef = settings
    settings.register(NS, ToggleSchema)

    let writing = false
    let timer
    let retries = 0
    let warnedRoute = false
    let adopted = false

    const stopRetry = () => {
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    }

    const descriptorFor = (ns) => {
      try {
        return (settings.describe() ?? []).find((d) => d.ns === ns)
      } catch {
        return undefined
      }
    }

    const adoptExistingOverride = (plan, toggleUser) => {
      if (adopted || plan.op.op !== 'set') return false
      if (toggleUser !== undefined && Object.keys(toggleUser).length > 0) return false
      const llmUser = descriptorFor(LLM_NS)?.user
      const explicit = llmUser?.providers?.[plan.route]?.maxRequestImageBytes
      if (!Number.isInteger(explicit) || explicit <= 0) return false
      const mb = explicit / BYTES_PER_MB
      if (!Number.isInteger(mb) || mb < 1 || mb > 64) return false
      adopted = true
      writing = true
      Promise.resolve(settings.update(NS, { budgetMb: mb }))
        .catch((error) => {
          ctx.logger.error('image-guard-toggle: adopting existing budget failed', error)
        })
        .finally(() => {
          writing = false
        })
      return true
    }

    const mirror = () => {
      if (writing) return
      const llm = settings.get(LLM_NS)
      if (llm === undefined) {
        if (retries >= RETRY_LIMIT) {
          stopRetry()
          ctx.logger.warn('image-guard-toggle: settings namespace "llm-pi-ai" never registered; mirror disabled')
          return
        }
        retries += 1
        if (timer === undefined) timer = setInterval(mirror, RETRY_MS)
        return
      }
      stopRetry()
      const resolved = settings.get(NS) ?? {}
      const plan = planMirrorOperation(llm, {
        enabled: resolved.enabled !== false,
        budgetMb: resolved.budgetMb,
        route: resolved.route,
      })
      if (plan.kind === 'noop') return
      if (plan.kind === 'missing-route') {
        if (!warnedRoute) {
          warnedRoute = true
          ctx.logger.warn(`image-guard-toggle: provider route "${plan.route}" is not configured in llm-pi-ai; toggle inert until it exists`)
        }
        return
      }
      warnedRoute = false
      if (adoptExistingOverride(plan, descriptorFor(NS)?.user)) return
      writing = true
      Promise.resolve(settings.mutate(LLM_NS, [plan.op]))
        .catch((error) => {
          ctx.logger.error('image-guard-toggle: mirror write to llm-pi-ai failed', error)
        })
        .finally(() => {
          writing = false
        })
    }

    ctx.on('settings/updated', (changed) => {
      if (changed === NS || changed === LLM_NS) mirror()
    })
    ctx.effect(() => stopRetry)
    mirror()
  }

  const settings = ctx.get('settings')
  if (settings !== undefined) {
    install(settings)
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (sub) => {
      const provider = sub.get('settings')
      if (provider !== undefined) install(provider)
    })
  }
}
