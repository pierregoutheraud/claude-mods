import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pet, PetMood } from '../types'
import { COLUMNS, ROWS, drawPet, kaomoji, nextStageAt, PALETTES, stageLabel, stageOf, stageStart } from './sprites'

const TICK_MS = 500
const FLASH_MS = 5000
const SLEEP_AFTER_MS = 10 * 60 * 1000
const TESTS_XP = 3
const TEST_COMMAND = /\b(vitest|jest|pytest|mocha|playwright test|go test|cargo test|(npm|pnpm|yarn|bun) (run )?test)\b/

const pet = atom({ plugin: 'pixel-pet', key: 'pet' } as const, null)
const frame = atom({ plugin: 'pixel-pet', key: 'frame' } as const, 0)
const flash = atom({ plugin: 'pixel-pet', key: 'flash' } as const, null)
const isAsleep = atom({ plugin: 'pixel-pet', key: 'isAsleep' } as const, false)
const isHidden = atom({ plugin: 'pixel-pet', key: 'isHidden' } as const, false)

const isPet = (value: unknown): value is Pet =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Pet).name === 'string' &&
  typeof (value as Pet).xp === 'number' &&
  typeof (value as Pet).bornAt === 'number'

const xpBar = (xp: number): string => {
  const stage = stageOf(xp)
  const next = nextStageAt(stage)
  if (next === undefined) return `${xp} xp, fully grown`

  const from = stageStart(stage)
  const filled = Math.round(((xp - from) / (next - from)) * 10)

  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${xp}/${next} xp`
}

const moodLine = (name: string, mood: PetMood, frame: number, isEgg: boolean): string => {
  const dots = '.'.repeat(1 + (frame % 3))
  switch (mood) {
    case 'working':
      return isEgg ? `${name} wobbles${dots}` : `${name} is reading over Claude's shoulder${dots}`
    case 'sleeping':
      return `${name} is asleep ${'z'.repeat(1 + (frame % 3))}`
    case 'idle':
      return isEgg ? `${name} is an egg. It hatches at 3 xp.` : `${name} is waiting for your next prompt`
    default:
      return name
  }
}

// When the person or Claude last did something; a hot reload starts it over.
let lastActiveAt = 0

async function flashMood($: EngineInterface, mood: 'happy' | 'sad', text: string) {
  const until = (await $.clock.now()) + FLASH_MS
  await update($, flash, () => ({ mood, text, until }))
}

async function wake($: EngineInterface) {
  lastActiveAt = await $.clock.now()
  if (await read($, isAsleep)) await update($, isAsleep, () => false)
}

async function pat($: EngineInterface) {
  await wake($)
  await flashMood($, 'happy', 'purrs happily')
}

async function savePet($: EngineInterface, next: Pet) {
  await update($, pet, () => next)
  await $.store.set('pet', next)
}

async function gainXp($: EngineInterface, amount: number) {
  const before = await read($, pet)
  if (before === null) return

  const after = { ...before, xp: before.xp + amount }
  await savePet($, after)

  const grown = stageOf(after.xp)
  if (grown !== stageOf(before.xp)) {
    $.ui.toast(`${after.name} evolved into ${stageLabel(grown)}!`)
    await flashMood($, 'happy', `evolved into ${stageLabel(grown)}!`)
  }
}

async function setHidden($: EngineInterface, hidden: boolean) {
  await update($, isHidden, () => hidden)
  await $.store.set('isHidden', hidden)
}

async function tick($: EngineInterface) {
  const now = await $.clock.now()
  await update($, frame, n => n + 1)

  const shown = await read($, flash)
  if (shown !== null && now >= shown.until) await update($, flash, () => null)

  if (now - lastActiveAt >= SLEEP_AFTER_MS && !(await read($, isAsleep))) {
    await update($, isAsleep, () => true)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const now = await $.clock.now()
    lastActiveAt = now

    const stored = await $.store.get('pet')
    const loaded = isPet(stored) ? stored : { name: 'Byte', xp: 0, bornAt: now }
    await savePet($, loaded)

    const hidden = (await $.store.get('isHidden')) === true
    await update($, isHidden, () => hidden)

    await $.command.register({
      name: 'pet',
      description: 'Check on your pixel pet (/pet, /pet pat, /pet name <name>, /pet hide, /pet show)',
    })

    // Headless runs draw nothing; a timer there would only keep the process busy.
    if (e.isInteractive) {
      $.clock.every(TICK_MS, () => {
        void tick($).catch(() => undefined)
      })
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await wake($)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    if (ran.isError === true) {
      await flashMood($, 'sad', `winces: ${String(e.tool)} failed`)
    } else if (e.tool === 'Bash' && TEST_COMMAND.test(e.command)) {
      await flashMood($, 'happy', `loved that: tests passed! (+${TESTS_XP} xp)`)
      await gainXp($, TESTS_XP)
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await wake($)
      if (e.reason === 'answer') await gainXp($, 1)
      if (e.reason === 'error') await flashMood($, 'sad', 'got scared by an API error')
    }

    return next(e)
  })

  on('command.run', { command: 'pet' }, async ($, e) => {
    const current = await read($, pet)
    if (current === null) return { text: 'Your pet has not arrived yet.' }

    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    switch (verb) {
      case '': {
        await setHidden($, false)
        const stage = stageOf(current.xp)
        const next = nextStageAt(stage)
        const days = Math.floor(((await $.clock.now()) - current.bornAt) / 86_400_000)
        const growth = next === undefined ? 'It is fully grown.' : `It grows up at ${next} xp.`

        return { text: `${current.name} is ${stageLabel(stage)} with ${current.xp} xp, ${days} days old. ${growth}` }
      }
      case 'pat':
        await pat($)

        return { text: `You pat ${current.name}.` }
      case 'name': {
        const name = rest.join(' ').slice(0, 20)
        if (name === '') return { text: 'Usage: /pet name <name>' }
        await savePet($, { ...current, name })

        return { text: `Your pet is now called ${name}.` }
      }
      case 'hide':
        await setHidden($, true)

        return { text: `${current.name} is napping out of sight. /pet show brings it back.` }
      case 'show':
        await setHidden($, false)

        return { text: `${current.name} is back above the prompt.` }
      default:
        return { text: 'Usage: /pet [pat | name <name> | hide | show]' }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, pet)
    if (e.props.hasSurvey || current === null || (await read($, isHidden))) return next(e)

    const beat = await read($, frame)
    const shown = await read($, flash)
    const asleep = await read($, isAsleep)
    const mood: PetMood = shown?.mood ?? (e.props.isWorking ? 'working' : asleep ? 'sleeping' : 'idle')
    const stage = stageOf(current.xp)
    const line = shown === null ? moodLine(current.name, mood, beat, stage === 'egg') : `${current.name} ${shown.text}`
    const color = PALETTES[stage].b

    const { Box, Button, Text } = $.ui.resolve(e)

    if (e.props.bodyColumns < 44) {
      return (
        <Text wrap="truncate">
          {kaomoji(stage, mood, beat)} {line}
        </Text>
      )
    }

    const info = (
      <Box flexDirection="column" flexShrink={1}>
        <Box flexDirection="row" gap={1}>
          <Text bold color={color}>
            {current.name}
          </Text>
          <Text dimColor>{stageLabel(stage)}</Text>
        </Box>
        <Text italic wrap="truncate">
          {line}
        </Text>
        <Text dimColor>
          {xpBar(current.xp)}
        </Text>
        <Box flexDirection="row">
          <Button key="pat" label="pat" onPress={() => pat($)} />
        </Box>
      </Box>
    )

    if (e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)

      return (
        <Box flexDirection="row" gap={2}>
          <Raster key="sprite" columns={COLUMNS} rows={ROWS} cells={drawPet(stage, mood, beat)} />
          {info}
        </Box>
      )
    }

    return (
      <Box flexDirection="row" gap={2}>
        <Text bold color={color}>
          {kaomoji(stage, mood, beat)}
        </Text>
        {info}
      </Box>
    )
  })
}
