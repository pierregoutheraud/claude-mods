import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Farm, FarmEvent } from '../types'
import { drawStrip, STRIP_ROWS, textStrip, visibleRacks } from './draw'
import { applyEvent, catchUp, formatBytes, formatRate, isFarm, newFarm, ratePerSecond, shopItems, step } from './game'

const SHOP = 'server-farm-shop'
// The farm animates every tick by repainting its Raster in place (no redraw of
// the band); the status line under it is redrawn once a second, or at once on an event.
const TICK_MS = 250
const PUBLISH_EVERY_MS = 1_000
const SAVE_EVERY_MS = 5_000
const MIRROR_EVERY_MS = 2_000
const STALE_OWNER_MS = 20_000
const NOTICE_MS = 5_000
// Empty rows between the transcript and the farm.
const BAND_SPACING = 1
// A gap longer than this between ticks (a sleeping laptop) is paid as time away.
const CATCH_UP_AFTER_MS = 5_000
const TEST_COMMAND = /\b(vitest|jest|pytest|mocha|playwright test|go test|cargo test|(npm|pnpm|yarn|bun) (run )?test)\b/

const farm = atom({ plugin: 'server-farm', key: 'farm' } as const, null)
const isOwner = atom({ plugin: 'server-farm', key: 'isOwner' } as const, false)
const notice = atom({ plugin: 'server-farm', key: 'notice' } as const, null)
const isHidden = atom({ plugin: 'server-farm', key: 'isHidden' } as const, false)

// Which session runs the farm: the others mirror its save and send it their events.
type Owner = { id: string; beatAt: number }

const isOwnerRecord = (value: unknown): value is Owner =>
  typeof value === 'object' && value !== null && typeof (value as Owner).id === 'string'

// The loop's own state; a hot reload starts it over, and session.start seeds it again.
let sessionId = ''
let lastTickAt = 0
let lastSaveAt = 0
let lastMirrorAt = 0
let lastPublishAt = 0
let noticeUntil = 0
let frame = 0
// The farm as this session runs it, ahead of what `farm` last published; null unless it runs the farm.
let live = null as Farm | null
// The Raster the band last drew on the terminal, which blits repaint; null when none is mounted.
let band = null as { requestId: string; columns: number } | null

async function say($: EngineInterface, text: string) {
  noticeUntil = (await $.clock.now()) + NOTICE_MS
  await update($, notice, () => ({ text, until: noticeUntil }))
}

async function publish($: EngineInterface, now: number) {
  lastPublishAt = now
  const current = live
  if (current !== null) await update($, farm, () => current)
  if (noticeUntil !== 0 && now >= noticeUntil) {
    noticeUntil = 0
    await update($, notice, () => null)
  }
}

// Repaints the band's Raster with the next frame, without redrawing the band.
async function paint($: EngineInterface) {
  if (band === null || live === null) return
  try {
    const painted = await $.ui.blit({
      requestId: band.requestId,
      key: 'farm',
      cells: drawStrip(live, band.columns, frame),
      columns: band.columns,
      rows: STRIP_ROWS,
    })
    // Not mounted any more, or another size: the next drawing of the band arms it again.
    if (painted.deny !== undefined) band = null
  } catch {
    band = null
  }
}

async function loadFarm($: EngineInterface, now: number): Promise<Farm> {
  const stored = await $.store.get('farm')

  return isFarm(stored) ? stored : newFarm(now)
}

async function save($: EngineInterface, now: number) {
  const current = live
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

// Starts running the farm here, from `seed` (what this session last published, after a hot
// reload) or else from the save.
async function takeOver($: EngineInterface, now: number, seed: Farm | null) {
  const loaded = seed ?? (await loadFarm($, now))
  const { farm: caught, earned } = catchUp(loaded, now - loaded.savedAt)
  live = caught
  await update($, isOwner, () => true)
  await publish($, now)
  await save($, now)
  if (earned > 0) $.ui.toast(`While you were away, your farm produced ${formatBytes(earned)}`)
}

async function apply($: EngineInterface, event: FarmEvent) {
  if (live === null) return

  const result = applyEvent(live, event)
  live = result.farm
  if (result.notice !== null) await say($, result.notice)
  await publish($, await $.clock.now())
}

// Events from this session: applied here when it runs the farm, else queued for the session that does.
async function send($: EngineInterface, event: FarmEvent) {
  if (live !== null) {
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
  frame += 1

  if (live === null) {
    if (now - lastMirrorAt < MIRROR_EVERY_MS) return
    lastMirrorAt = now
    if (noticeUntil !== 0 && now >= noticeUntil) await publish($, now)
    if (await claim($, now)) {
      await takeOver($, now, null)
    } else {
      const mirrored = await loadFarm($, now)
      await update($, farm, () => mirrored)
    }

    return
  }

  if (elapsed <= CATCH_UP_AFTER_MS) {
    live = step(live, elapsed)
  } else {
    const caught = catchUp(live, elapsed)
    live = caught.farm
    if (caught.earned > 0) $.ui.toast(`While you were away, your farm produced ${formatBytes(caught.earned)}`)
  }

  await paint($)
  if (now - lastPublishAt >= PUBLISH_EVERY_MS) await publish($, now)

  if (now - lastSaveAt >= SAVE_EVERY_MS) {
    // Another session may have taken over while this one slept.
    const owner = await $.store.get('owner')
    if (isOwnerRecord(owner) && owner.id !== sessionId && now - owner.beatAt <= STALE_OWNER_MS) {
      live = null
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
    lastPublishAt = now
    live = null
    band = null

    await update($, isHidden, () => false)
    if ((await $.store.get('isHidden')) === true) await update($, isHidden, () => true)

    await $.command.register({
      name: 'farm',
      description: 'Your server farm: /farm opens the shop, /farm stats, /farm hide, /farm show',
    })

    // A headless run never runs the farm: it only sends its events to the session that does.
    if (e.isInteractive) {
      // A hot reload of the session running the farm picks up where it left off.
      const seed = (await read($, isOwner)) ? await read($, farm) : null
      if (await claim($, now)) {
        await takeOver($, now, seed)
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
    if (e.reason !== 'clear' && live !== null) {
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
    if (e.props.hasSurvey || current === null || (await read($, isHidden))) {
      band = null

      return next(e)
    }

    const beat = frame
    const shown = await read($, notice)
    const owner = await read($, isOwner)
    const columns = Math.min(e.props.bodyColumns, 512)
    const rate = ratePerSecond(current)
    const offScreen = current.racks.length - visibleRacks(current, columns)
    const { Box, Button, Text } = $.ui.resolve(e)

    if (columns < 40) {
      band = null

      return (
        <Box marginTop={BAND_SPACING}>
          <Text wrap="truncate">
            {formatBytes(current.bytes)} +{formatRate(rate)}
          </Text>
        </Box>
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
      band = { requestId: e.requestId, columns }

      return (
        <Box flexDirection="column" marginTop={BAND_SPACING}>
          <Raster key="farm" columns={columns} rows={STRIP_ROWS} cells={drawStrip(current, columns, beat)} />
          {status}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" marginTop={BAND_SPACING}>
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
