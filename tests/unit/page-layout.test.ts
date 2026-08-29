import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ModuleManifest } from '@shared/modules'
import type { Block, PageSpec, WidgetSpec } from '@shared/module-ui'

/**
 * The layout conventions this module borrows from OpenWRT.
 *
 * They are repetitive and easy to get subtly wrong one page at a time - a form
 * whose help text went into `FormField.help` instead of a note, a banner that
 * ends up hidden the moment somebody turns hints off, a table with no
 * `emptyText` that renders as a blank rectangle. None of that fails a spec
 * check, none of it fails a typecheck, and all of it is only noticed by
 * somebody using the page.
 *
 * So they are asserted here. The language stays coherent because CI says so,
 * not because whoever edits a page next happens to remember.
 */

const ID = 'service-fleet'
const root = join(process.cwd(), ID)
const manifest = JSON.parse(readFileSync(join(root, 'module.json'), 'utf8')) as ModuleManifest

function page(id: string): PageSpec {
  return JSON.parse(readFileSync(join(root, 'ui', 'pages', `${id}.json`), 'utf8')) as PageSpec
}

function widget(id: string): WidgetSpec {
  return JSON.parse(readFileSync(join(root, 'ui', 'widgets', `${id}.json`), 'utf8')) as WidgetSpec
}

const PAGE_IDS = (manifest.pages ?? []).map((entry) => entry.id)

/** Every block in a spec, however deeply nested. */
function walk(blocks: readonly Block[] | undefined): Block[] {
  const out: Block[] = []
  for (const block of blocks ?? []) {
    out.push(block)
    const anyBlock = block as unknown as Record<string, unknown>
    for (const key of ['blocks', 'else', 'rowDetail']) {
      const nested = anyBlock[key]
      if (Array.isArray(nested)) out.push(...walk(nested as Block[]))
    }
    if (block.type === 'subnav') {
      for (const item of block.items) out.push(...walk(item.blocks))
    }
  }
  return out
}

function blocksOf(spec: PageSpec | WidgetSpec): Block[] {
  return walk(spec.blocks)
}

describe('every page is one rail', () => {
  it.each(PAGE_IDS)('%s opens with a readiness gate and nothing beside it', (id) => {
    const spec = page(id)
    // One root block, and it is the conditional cascade. A page that drew a
    // figure before the gate would be drawing one it had not been told.
    expect(spec.blocks).toHaveLength(1)
    expect(spec.blocks[0].type).toBe('conditional')
  })

  it.each(PAGE_IDS)('%s has exactly one subnav, and it is the whole content', (id) => {
    const rails = blocksOf(page(id)).filter((block) => block.type === 'subnav')
    expect(rails).toHaveLength(1)
  })

  it.each(PAGE_IDS)('%s gates on capabilities before anything else', (id) => {
    const spec = page(id)
    const gate = spec.blocks[0] as Extract<Block, { type: 'conditional' }>
    expect(gate.when.source).toMatchObject({ kind: 'stream', event: 'capabilities' })
  })
})

describe('prose lives in notes, not in fields', () => {
  it.each(PAGE_IDS)('%s never uses FormField.help', (id) => {
    // A field's own help cannot be hidden by the hints switch and cannot be
    // more than a line. Prose belongs in a note, which can be both.
    //
    // Checked on the fields themselves rather than by searching the file: a
    // *column* called `help` is legitimate, and one of these pages has one -
    // the table listing what a chosen template asks for.
    for (const block of blocksOf(page(id))) {
      if (block.type !== 'form' && block.type !== 'checkForm') continue
      for (const field of block.fields) {
        expect((field as { help?: string }).help, `${id}: field ${field.key}`).toBeUndefined()
      }
    }
  })

  it.each(PAGE_IDS)('%s never hides the readiness gate behind the hints switch', (id) => {
    // The gate's notes say what is wrong and what to do about it - not
    // connected, a tool missing on the jump host. Those have to be readable
    // with explanations turned off, which is exactly when somebody has decided
    // they know this module and is now looking at a page that will not load.
    const spec = page(id)
    const gate = spec.blocks[0] as Extract<Block, { type: 'conditional' }>
    for (const block of walk([gate]).filter((entry) => entry.type === 'conditional')) {
      const source = (block as Extract<Block, { type: 'conditional' }>).when.source as {
        event?: string
        path?: string
      }
      if (source.event !== 'ui' || source.path !== 'hintsOn') continue
      // A hints conditional is fine inside a rail item; it must not wrap the
      // gate's own branches. Those live before the subnav.
      const nested = walk((block as Extract<Block, { type: 'conditional' }>).blocks)
      expect(nested.some((entry) => entry.type === 'section' && entry.title?.includes('cannot reach')), id).toBe(
        false
      )
    }
  })

  it.each(PAGE_IDS)('%s teaches through notes rather than through field help', (id) => {
    // Every page carries at least one explanation, and it is a note - which is
    // what the hints switch can hide and a field's own help could not.
    const notes = blocksOf(page(id)).filter((block) => block.type === 'note')
    expect(notes.length, id).toBeGreaterThan(0)
  })

  it.each(PAGE_IDS)('%s never hides a warning banner behind the hints switch', (id) => {
    // The one rule worth stating twice: a banner says something is wrong, and
    // turning off explanations must never turn off "this is broken".
    const spec = page(id)
    for (const block of blocksOf(spec)) {
      if (block.type !== 'conditional') continue
      const source = block.when.source as { event?: string; path?: string }
      if (source.event !== 'ui' || source.path !== 'hintsOn') continue
      const warnings = walk(block.blocks).filter(
        (nested) => nested.type === 'note' && nested.tone === 'warning'
      )
      expect(warnings, id).toEqual([])
    }
  })
})

describe('nothing renders as a blank rectangle', () => {
  it.each(PAGE_IDS)('%s gives every collection an emptyText', (id) => {
    for (const block of blocksOf(page(id))) {
      if (block.type !== 'table' && block.type !== 'list' && block.type !== 'statusCards') continue
      const text = (block as { emptyText?: string }).emptyText
      expect(text, `${id}: a ${block.type} with no emptyText`).toBeTruthy()
    }
  })

  it.each(PAGE_IDS)('%s writes emptyText as a sentence, not as "No data"', (id) => {
    for (const block of blocksOf(page(id))) {
      const text = (block as { emptyText?: string }).emptyText
      if (!text) continue
      // Long enough to say what to do next. "No data" and "No rows" are not
      // answers to "why is this empty, and what do I do about it".
      expect(text.length, `${id}: "${text}"`).toBeGreaterThan(20)
    }
  })
})

describe('mutations are checked before they are applied', () => {
  it.each(PAGE_IDS)('%s uses checkForm for anything that changes several machines', (id) => {
    const forms = blocksOf(page(id)).filter((block) => block.type === 'form')
    for (const form of forms) {
      // A plain form is only for a preference the user can flip back. Every
      // one here has to be exactly that.
      const keys = form.fields.map((field) => field.key)
      expect(keys.every((key) => key === 'hintsOn'), `${id}: ${keys.join(', ')}`).toBe(true)
    }
  })

  it.each(PAGE_IDS)('%s marks destructive actions as destructive', (id) => {
    for (const block of blocksOf(page(id))) {
      const specs = [
        ...((block as { rowActions?: Array<Record<string, unknown>> }).rowActions ?? []),
        ...((block as { bulkActions?: Array<Record<string, unknown>> }).bulkActions ?? []),
        ...(block.type === 'actions' ? (block.actions as unknown as Array<Record<string, unknown>>) : [])
      ]
      for (const action of specs) {
        const method = String(action['method'] ?? '')
        if (!/(Delete|Forget|Uninstall|Reset|Clear)/i.test(method)) continue
        expect(action['kind'] ?? action['confirm'], `${id}: ${method}`).toBeTruthy()
      }
    }
  })
})

describe('charts', () => {
  it.each(PAGE_IDS)('%s never pins a single window across a whole page', (id) => {
    const windows = blocksOf(page(id))
      .filter((block) => block.type === 'chart')
      .map((block) => (block as { window?: number }).window)
    if (windows.length < 2) return
    // More than one window on offer, so a user can zoom out without leaving
    // the page - the OpenWRT rule this module borrows.
    expect(new Set(windows).size).toBeGreaterThan(1)
  })
})

describe('the Overview widgets', () => {
  it.each((manifest.widgets ?? []).map((entry) => entry.id))('%s stays flat', (id) => {
    // A 300px card has no room for a rail, and one there would be unusable.
    expect(blocksOf(widget(id)).some((block) => block.type === 'subnav')).toBe(false)
  })
})
