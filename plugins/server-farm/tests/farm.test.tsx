import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { newFarm } from '../hooks/game'

const START = { cwd: '/tmp/project', surface: 'terminal', isInteractive: true } as const

// Stands in for the engine beneath the plugin; answers what the farm calls, keeps what it showed.
const engine = (on: On, id = 'me') => {
  const toasts: string[] = []
  const opened: string[] = []
  const blits: { requestId: string; key: string }[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: id }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.blit', (_$, e) => {
    blits.push({ requestId: e.requestId, key: e.key })

    return { value: {} }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine band</Text>
  })

  return { toasts, opened, blits }
}

// An in-memory store the test can read back, standing in for $.store (mock.store keeps its own).
const memoryStore = (on: On, entries: Record<string, unknown> = {}) => {
  const stored = new Map<string, unknown>(Object.entries(entries))
  const copy = (value: unknown) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
  on('store.get', (_$, e) => ({ value: copy(stored.get(e.key)) }))
  on('store.set', (_$, e) => {
    stored.set(e.key, copy(e.value))

    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    stored.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...stored.keys()] }))

  return stored
}

const band = (surface: 'terminal' | 'desktop' = 'terminal') => ({
  plugin: 'server-farm',
  surface,
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
})

const shop = {
  plugin: 'server-farm',
  surface: 'terminal' as const,
  component: 'Pane' as const,
  requestId: 'server-farm-shop',
  props: {
    title: 'Server farm shop',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
}

const farmCommand = (args: string) => ({
  command: 'farm',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 100 },
})

const text = (pattern: RegExp | string) => ({ type: 'Text', text: pattern })

const ANSWER = { answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' as const }
const BASH_FAIL = { result: { stdout: '', stderr: 'boom', interrupted: false }, text: 'boom', isError: true as const }

describe('server-farm', () => {
  test('a first session boots a new farm and draws it as a strip', async ($, on) => {
    mock.clock(on)
    const written = memoryStore(on)
    engine(on)
    await $.session.start(START)

    const ui = await $.ui.mount(band())
    expect(await ui.find({ key: 'farm' })).toBeDefined()
    expect(await ui.find(text('0 B'))).toBeDefined()
    expect(await ui.find(text('+1.6 B/s'))).toBeDefined()
    expect(written.get('owner')).toEqual({ id: 'me', beatAt: 0 })
    await ui.unmount()
  })

  test('the band keeps an empty row above the farm on every surface', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    engine(on)
    await $.session.start(START)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount(band(surface))
      expect(await ui.drawn()).toMatchObject({ type: 'Box', props: { marginTop: 1 } })
      await ui.unmount()
    }
  })

  test('the farm animates by repainting its Raster in place, not by redrawing the band', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    const { blits } = engine(on)
    await $.session.start(START)

    const ui = await $.ui.mount({ ...band(), requestId: 'band' })
    await clock.advance(1_000)
    expect(blits.length).toBeGreaterThanOrEqual(3)
    expect(blits.every(blit => blit.requestId === 'band' && blit.key === 'farm')).toBe(true)
    await ui.unmount()
  })

  test('the farm runs on its own and earns data', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    engine(on)
    await $.session.start(START)

    await clock.advance(15_000)
    const ui = await $.ui.mount(band())
    expect(await ui.find(text('16 B'))).toBeDefined()
    await ui.unmount()
  })

  test('a finished turn brings a traffic spike, a failing tool an incident', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    engine(on)
    on('tool.call', { tool: 'Bash' }, () => BASH_FAIL)
    await $.session.start(START)

    await $.turn.complete(ANSWER)
    const spiking = await $.ui.mount(band())
    expect(await spiking.find(text('+3.2 B/s'))).toBeDefined()
    expect(await spiking.find(text(/^traffic spike x2 60s$/))).toBeDefined()
    await spiking.unmount()

    await $.tool.call({ tool: 'Bash', command: 'ls nowhere' })
    const hit = await $.ui.mount(band())
    expect(await hit.find(text('Incident! Rack 1 went down'))).toBeDefined()
    await hit.unmount()
  })

  test('/farm opens the shop, and its buttons buy upgrades', async ($, on) => {
    mock.clock(on)
    mock.store(on, { farm: { ...newFarm(0), bytes: 100 } })
    const { opened } = engine(on)
    await $.session.start(START)

    await $.command.run(farmCommand(''))
    expect(opened).toEqual(['server-farm-shop'])

    const ui = await $.ui.mount(shop)
    expect((await ui.find({ key: 'buy-rack' }))?.props.label).toBe('New rack (40 B)')
    await ui.press({ key: 'buy-rack' })
    expect(await ui.find(text(/^60 B stored, \+2\.4 B\/s$/))).toBeDefined()
    expect(await ui.find(text('A new rack is online'))).toBeDefined()

    await ui.press({ key: 'buy-daemon' })
    expect(await ui.find(text('Not enough data for Hire Nibble'))).toBeDefined()
    await ui.unmount()
  })

  test('time away is paid when the farm boots again', async ($, on) => {
    mock.clock(on, { now: 60 * 60 * 1000 })
    mock.store(on, { farm: newFarm(0) })
    const { toasts } = engine(on)
    await $.session.start(START)

    expect(toasts).toEqual(['While you were away, your farm produced 2.8 KB'])
  })

  test('a second session mirrors the farm and queues its events for the one running it', async ($, on) => {
    mock.clock(on, { now: 1_000 })
    const written = memoryStore(on, { farm: newFarm(0), owner: { id: 'other', beatAt: 1_000 } })
    engine(on)
    await $.session.start(START)

    const ui = await $.ui.mount(band())
    expect(await ui.find(text('mirroring the farm of another session'))).toBeDefined()
    await ui.unmount()

    await $.turn.complete(ANSWER)
    expect(written.get('inbox')).toEqual([{ kind: 'turn' }])
    expect(written.get('owner')).toEqual({ id: 'other', beatAt: 1_000 })
  })

  test('a session takes over a farm whose runner went quiet, and drains its inbox', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const written = memoryStore(on, { farm: newFarm(1_000), owner: { id: 'other', beatAt: 1_000 } })
    engine(on)
    await $.session.start(START)
    await $.turn.complete(ANSWER)

    await clock.advance(22_000)
    expect(written.get('owner')).toMatchObject({ id: 'me' })

    await clock.advance(5_000)
    expect(written.get('inbox')).toEqual([])
    const ui = await $.ui.mount(band())
    expect(await ui.find(text(/^traffic spike x2/))).toBeDefined()
    await ui.unmount()
  })

  test('desktop draws the racks as text', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    engine(on)
    await $.session.start(START)

    const ui = await $.ui.mount(band('desktop'))
    expect(await ui.find({ key: 'farm' })).toBeUndefined()
    expect(await ui.find(text('[▁][▁]'))).toBeDefined()
    await ui.unmount()
  })

  test('/farm hide gives the band back to the engine', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    engine(on)
    await $.session.start(START)

    await $.command.run(farmCommand('hide'))
    const ui = await $.ui.mount(band())
    expect(await ui.find(text('engine band'))).toBeDefined()
    await ui.unmount()
  })
})
