import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { COLUMNS, petPixels, ROWS, STAGES } from '../hooks/sprites'

const START = { cwd: '/tmp/project', surface: 'terminal', isInteractive: true } as const

// Stands in for the engine beneath the plugin; answers what the pet calls, keeps the toasts.
const engine = (on: On) => {
  const toasts: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine band</Text>
  })

  return { toasts }
}

const pet = (args: string) => ({
  command: 'pet',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 100 },
})

const band = (surface: 'terminal' | 'desktop', isWorking = false) => ({
  plugin: 'pixel-pet',
  surface,
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
})

const text = (pattern: RegExp | string) => ({ type: 'Text', text: pattern })

const BASH_OK = { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }
const BASH_FAIL = { ...BASH_OK, text: 'boom', isError: true as const }

const ANSWER = { answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' as const }

describe('sprites', () => {
  test('every stage and mood draws a full 14x12 sprite', async () => {
    for (const { stage } of STAGES) {
      for (const mood of ['idle', 'working', 'happy', 'sad', 'sleeping'] as const) {
        const pixels = petPixels(stage, mood, 3)
        expect(pixels).toHaveLength(ROWS * 2)
        for (const row of pixels) expect(row).toHaveLength(COLUMNS)
      }
    }
  })
})

describe('pixel-pet', () => {
  test('a new pet arrives as an egg, drawn as a sprite on the terminal', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    engine(on)
    await $.session.start(START)

    const ui = await $.ui.mount(band('terminal'))
    expect(await ui.find(text('Byte is an egg. It hatches at 3 xp.'))).toBeDefined()
    expect(await ui.find({ key: 'sprite' })).toBeDefined()
    await ui.unmount()

    const working = await $.ui.mount(band('terminal', true))
    expect(await working.find(text(/^Byte wobbles\.+$/))).toBeDefined()
    await working.unmount()
  })

  test('desktop draws a text face instead of a Raster', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    engine(on)
    await $.session.start(START)

    const ui = await $.ui.mount(band('desktop'))
    expect(await ui.find(text('(0)'))).toBeDefined()
    expect(await ui.find({ key: 'sprite' })).toBeUndefined()
    await ui.unmount()
  })

  test('passing tests feed the pet, and enough xp hatches the egg', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    const { toasts } = engine(on)
    on('tool.call', { tool: 'Bash' }, () => BASH_OK)
    await $.session.start(START)

    await $.tool.call({ tool: 'Bash', command: 'npm test' })

    const ui = await $.ui.mount(band('terminal'))
    expect(await ui.find(text('Byte evolved into a baby slime!'))).toBeDefined()
    expect(await ui.find(text(/ 3\/25 xp$/))).toBeDefined()
    expect(toasts).toEqual(['Byte evolved into a baby slime!'])
    await ui.unmount()
  })

  test('a command that is not a test run gives no xp', async ($, on) => {
    mock.clock(on)
    mock.store(on, { pet: { name: 'Byte', xp: 10, bornAt: 0 } })
    engine(on)
    on('tool.call', { tool: 'Bash' }, () => BASH_OK)
    await $.session.start(START)

    await $.tool.call({ tool: 'Bash', command: 'ls -la' })

    const ui = await $.ui.mount(band('terminal'))
    expect(await ui.find(text(/ 10\/25 xp$/))).toBeDefined()
    await ui.unmount()
  })

  test('a failed tool makes the pet sad until the moment passes', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on, { pet: { name: 'Byte', xp: 10, bornAt: 0 } })
    engine(on)
    on('tool.call', { tool: 'Bash' }, () => BASH_FAIL)
    await $.session.start(START)

    await $.tool.call({ tool: 'Bash', command: 'npm test' })

    const ui = await $.ui.mount(band('terminal'))
    expect(await ui.find(text('Byte winces: Bash failed'))).toBeDefined()
    expect(await ui.find(text(/ 10\/25 xp$/))).toBeDefined()

    await clock.advance(5_500)
    expect(await ui.find(text('Byte is waiting for your next prompt'))).toBeDefined()
    await ui.unmount()
  })

  test('the pet falls asleep when idle and wakes when a turn starts', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on, { pet: { name: 'Byte', xp: 30, bornAt: 0 } })
    engine(on)
    await $.session.start(START)

    await clock.advance(10 * 60 * 1000 + 500)
    const ui = await $.ui.mount(band('terminal'))
    expect(await ui.find(text(/^Byte is asleep z+$/))).toBeDefined()

    await $.turn.start({ text: 'hello', turnId: 't1' })
    expect(await ui.find(text('Byte is waiting for your next prompt'))).toBeDefined()
    await ui.unmount()
  })

  test('each answered turn gives 1 xp, and the pet keeps its xp across sessions', async ($, on) => {
    mock.clock(on)
    mock.store(on, { pet: { name: 'Byte', xp: 24, bornAt: 0 } })
    engine(on)
    await $.session.start(START)

    await $.turn.complete(ANSWER)
    await $.session.start(START)

    const ui = await $.ui.mount(band('terminal'))
    expect(await ui.find(text(/ 25\/100 xp$/))).toBeDefined()
    expect(await ui.find(text('a teen slime'))).toBeDefined()
    await ui.unmount()
  })

  test('/pet renames, hides and shows the pet', async ($, on) => {
    mock.clock(on)
    mock.store(on, { pet: { name: 'Byte', xp: 5, bornAt: 0 } })
    engine(on)
    await $.session.start(START)

    expect((await $.command.run(pet('name Mochi'))).text).toBe('Your pet is now called Mochi.')
    expect((await $.command.run(pet(''))).text).toMatch(/^Mochi is a baby slime with 5 xp/)

    await $.command.run(pet('hide'))
    const hidden = await $.ui.mount(band('terminal'))
    expect(await hidden.find(text('engine band'))).toBeDefined()
    expect(await hidden.find(text(/Mochi/))).toBeUndefined()
    await hidden.unmount()

    await $.command.run(pet('show'))
    const shown = await $.ui.mount(band('terminal'))
    expect(await shown.find(text('Mochi is waiting for your next prompt'))).toBeDefined()
    await shown.unmount()
  })

  test('pressing pat makes the pet purr', async ($, on) => {
    mock.clock(on)
    mock.store(on, { pet: { name: 'Byte', xp: 5, bornAt: 0 } })
    engine(on)
    await $.session.start(START)

    const ui = await $.ui.mount(band('terminal'))
    await ui.press({ key: 'pat' })
    expect(await ui.find(text('Byte purrs happily'))).toBeDefined()
    await ui.unmount()
  })
})
