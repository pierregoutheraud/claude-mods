import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Farm, FarmEvent } from '../types'
import { drawStrip, STRIP_ROWS, textStrip, visibleRacks } from './draw'
import { applyEvent, catchUp, formatBytes, formatRate, isFarm, newFarm, ratePerSecond, shopItems, step } from './game'

const SHOP = 'server-farm-shop'
const TICK_MS = 250
const SAVE_EVERY_MS = 5_000
const MIRROR_EVERY_MS = 2_000
const STALE_OWNER_MS = 20_000
const NOTICE_MS = 5_000
// A gap longer than this between ticks (a sleeping laptop) is paid as time away.
const CATCH_UP_AFTER_MS = 5_000
const TEST_COMMAND = /\b(vitest|jest|pytest|mocha|playwright test|go test|cargo test|(npm|pnpm|yarn|bun) (run )?test)\b/

const farm = atom({ plugin: 'server-farm', key: 'farm' } as const, null)
const isOwner = atom({ plugin: 'server-farm', key: 'isOwner' } as const, false)
const notice = atom({ plugin: 'server-farm', key: 'notice' } as const, null)
const isHidden = atom({ plugin: 'server-farm', key: 'isHidden' } as const, false)
const frame = atom({ plugin: 'server-farm', key: 'frame' } as const, 0)

// Which session runs the farm: the others mirror its save and send it their events.
type Owner = { id: string; beatAt: number }

const isOwnerRecord = (value: unknown): value is Owner =>
  typeof value === 'object' && value !== null && typeof (value as Owner).id === 'string'

// The loop's own clock; a hot reload starts it over.
let sessionId = ''
let lastTickAt = 0
let lastSaveAt = 0
let lastMirrorAt = 0

async function say($: EngineInterface, text: string) {
  const until = (await $.clock.now()) + NOTICE_MS
  await update($, notice, () => ({ text, until }))
}

async function loadFarm($: EngineInterface, now: number): Promise<Farm> {
  const stored = await $.store.get('farm')

  return isFarm(stored) ? stored : newFarm(now)
}

async function save($: EngineInterface, now: number) {
  const current = await read($, farm)
  if (current === null) return

  await $.store.set('farm', { ...current, savedAt: now })
  await $.store.set('owner', { id: sessionId, beatAt: now })
  lastSaveAt = now
}

// Takes the farm when nobody runs it, this session already did, or its runner went quiet.
async function claim($: EngineInterface, now: number): Promise<boolean> {
  const owner = await $.store.get('owner')
  const isFree = !isOwnerRecord(owner) || owner.id === sessionId || now - owner.beatAt > STALE_OWNER_MS
  if (isFree) await $.store.set('owner', { id: sessionId, beatAt: now })
  await update($, isOwner, () => isFree)

  return isFree
}

async function takeOver($: EngineInterface, now: number) {
  const loaded = await loadFarm($, now)
  const { farm: caught, earned } = catchUp(loaded, now - loaded.savedAt)
  await update($, farm, () => caught)
  await save($, now)
  if (earned > 0) $.ui.toast(`While you were away, your farm produced ${formatBytes(earned)}`)
}

async function apply($: EngineInterface, event: FarmEvent) {
  let text = null as string | null
  await update($, farm, current => {
    if (current === null) return current
    const result = applyEvent(current, event)
    text = result.notice

    return result.farm
  })
  if (text !== null) await say($, text)
}

// Events from this session: applied here when it runs the farm, else queued for the session that does.
async function send($: EngineInterface, event: FarmEvent) {
  if (await read($, isOwner)) {
    await apply($, event)
    if (event.kind === 'buy') await save($, await $.clock.now())

    return
  }

  const inbox = await $.store.get('inbox')
  await $.store.set('inbox', [...(Array.isArray(inbox) ? inbox : []), event].slice(-50))
  if (event.kind === 'buy') await say($, 'Sent to the session running the farm')
}

async function drainInbox($: EngineInterface) {
  const inbox = await $.store.get('inbox')
  if (!Array.isArray(inbox) || inbox.length === 0) return

  await $.store.set('inbox', [])
  for (const event of inbox as FarmEvent[]) await apply($, event)
}

async function tick($: EngineInterface) {
  const now = await $.clock.now()
  const elapsed = now - lastTickAt
  lastTickAt = now
  await update($, frame, n => n + 1)

  const shown = await read($, notice)
  if (shown !== null && now >= shown.until) await update($, notice, () => null)

  if (!(await read($, isOwner))) {
    if (now - lastMirrorAt < MIRROR_EVERY_MS) return
    lastMirrorAt = now
    if (await claim($, now)) {
      await takeOver($, now)
    } else {
      const mirrored = await loadFarm($, now)
      await update($, farm, () => mirrored)
    }

    return
  }

  let earned = 0
  await update($, farm, current => {
    if (current === null) return current
    if (elapsed <= CATCH_UP_AFTER_MS) return step(current, elapsed)
    const caught = catchUp(current, elapsed)
    earned = caught.earned

    return caught.farm
  })
  if (earned > 0) $.ui.toast(`While you were away, your farm produced ${formatBytes(earned)}`)

  if (now - lastSaveAt >= SAVE_EVERY_MS) {
    // Another session may have taken over while this one slept.
    const owner = await $.store.get('owner')
    if (isOwnerRecord(owner) && owner.id !== sessionId && now - owner.beatAt <= STALE_OWNER_MS) {
      await update($, isOwner, () => false)

      return
    }
    await drainInbox($)
    await save($, now)
  }
}

async function openShop($: EngineInterface) {
  await $.ui.open({ id: SHOP, title: 'Server farm shop', focus: true, closeOnEscape: true })
}

async function closeShop($: EngineInterface) {
  await $.ui.close({ id: SHOP })
}

async function setHidden($: EngineInterface, hidden: boolean) {
  await update($, isHidden, () => hidden)
  await $.store.set('isHidden', hidden)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const now = await $.clock.now()
    sessionId = await $.session.id()
    lastTickAt = now
    lastSaveAt = now
    lastMirrorAt = now

    await update($, isHidden, () => false)
    if ((await $.store.get('isHidden')) === true) await update($, isHidden, () => true)

    await $.command.register({
      name: 'farm',
      description: 'Your server farm: /farm opens the shop, /farm stats, /farm hide, /farm show',
    })

    // A headless run never runs the farm: it only sends its events to the session that does.
    if (e.isInteractive) {
      if (await claim($, now)) {
        await takeOver($, now)
      } else {
        const mirrored = await loadFarm($, now)
        await update($, farm, () => mirrored)
      }

      $.clock.every(TICK_MS, () => {
        void tick($).catch(() => undefined)
      })
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear' && (await read($, isOwner))) {
      await save($, await $.clock.now())
      await $.store.delete('owner')
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.reason === 'answer') await send($, { kind: 'turn' })

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    if (ran.isError === true) await send($, { kind: 'failure' })
    else if (e.tool === 'Bash' && TEST_COMMAND.test(e.command)) await send($, { kind: 'tests' })

    return ran
  })

  on('command.run', { command: 'farm' }, async ($, e) => {
    const current = await read($, farm)
    switch (e.args.trim()) {
      case '':
        await setHidden($, false)
        await openShop($)

        return { text: 'Server farm shop opened.' }
      case 'stats': {
        if (current === null) return { text: 'The farm is still booting.' }
        const racks = current.racks.length
        const daemons = current.daemons.map(daemon => daemon.name).join(', ')

        return {
          text: `${formatBytes(current.bytes)} stored, +${formatRate(ratePerSecond(current))}. ${racks} racks, daemons: ${daemons}. Lifetime ${formatBytes(current.lifetimeBytes)}, ${current.incidents} incidents.`,
        }
      }
      case 'hide':
        await setHidden($, true)

        return { text: 'The farm keeps running out of sight. /farm show brings it back.' }
      case 'show':
        await setHidden($, false)

        return { text: 'The farm is back above the prompt.' }
      default:
        return { text: 'Usage: /farm [stats | hide | show]' }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, farm)
    if (e.props.hasSurvey || current === null || (await read($, isHidden))) return next(e)

    const beat = await read($, frame)
    const shown = await read($, notice)
    const owner = await read($, isOwner)
    const columns = Math.min(e.props.bodyColumns, 512)
    const rate = ratePerSecond(current)
    const offScreen = current.racks.length - visibleRacks(current, columns)
    const { Box, Button, Text } = $.ui.resolve(e)

    if (columns < 40) {
      return (
        <Text wrap="truncate">
          {formatBytes(current.bytes)} +{formatRate(rate)}
        </Text>
      )
    }

    const status = (
      <Box flexDirection="row" gap={2}>
        <Text bold color="#7ee787">
          {formatBytes(current.bytes)}
        </Text>
        <Text dimColor>+{formatRate(rate)}</Text>
        {current.spikeMs > 0 && <Text color="#ffd166">traffic spike x2 {Math.ceil(current.spikeMs / 1000)}s</Text>}
        {offScreen > 0 && <Text dimColor>+{offScreen} racks off screen</Text>}
        {!owner && <Text dimColor>mirroring the farm of another session</Text>}
        {shown !== null && (
          <Text italic wrap="truncate">
            {shown.text}
          </Text>
        )}
        <Button key="shop" label="shop" hotkey="s" onPress={() => openShop($)} />
      </Box>
    )

    if (e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)

      return (
        <Box flexDirection="column">
          <Raster key="farm" columns={columns} rows={STRIP_ROWS} cells={drawStrip(current, columns, beat)} />
          {status}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text>{textStrip(current, beat)}</Text>
        {status}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: SHOP }, async ($, e) => {
    const current = await read($, farm)
    const { Box, Button, Text } = $.ui.resolve(e)
    if (current === null) return <Text dimColor>The farm is still booting.</Text>

    const shown = await read($, notice)
    const daemons = current.daemons.map(daemon => daemon.name).join(', ')

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold color="#7ee787">
            {formatBytes(current.bytes)} stored, +{formatRate(ratePerSecond(current))}
          </Text>
          <Text dimColor>
            {current.racks.length} racks, daemons: {daemons}, overclock level {current.overclock}
          </Text>
        </Box>
        <Box flexDirection="column">
          {shopItems(current).map((item, index) => (
            <Button
              key={`buy-${item.id}`}
              hotkey={String(index + 1)}
              label={item.cost === null ? `${item.label} (sold out)` : `${item.label} (${formatBytes(item.cost)})`}
              dimColor={item.cost === null || current.bytes < item.cost}
              plain
              onPress={() => send($, { kind: 'buy', item: item.id })}
            />
          ))}
        </Box>
        {shown !== null && <Text italic>{shown.text}</Text>}
        <Text dimColor>
          Finished turns bring traffic spikes, passing tests pay a bonus, failing tools take a rack down.
          Lifetime {formatBytes(current.lifetimeBytes)}, {current.incidents} incidents.
        </Text>
        <Button key="close" label="close" role="dismiss" onPress={() => closeShop($)} />
      </Box>
    )
  })
}
