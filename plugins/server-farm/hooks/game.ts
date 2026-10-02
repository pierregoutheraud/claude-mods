import type { Daemon, Farm, FarmEvent, Rack, ServerKind, ShopItemId } from '../types'

// Layout along the strip, in pixels: a rack is 6 wide, one every 8.
export const RACK_WIDTH = 6
export const RACK_STRIDE = 8
export const STRIP_LEFT = 1

export const MAX_RACKS = 12
export const MAX_DAEMONS = 6
export const MAX_OVERCLOCK = 10

const DAEMON_SPEED = 12 // pixels per second
const COLLECT_MS = 600
const FIX_MS = 4_000
const SPIKE_MS = 60_000
const MAX_SPIKE_MS = 300_000
const OFFLINE_CAP_MS = 8 * 60 * 60 * 1000
const OFFLINE_EFFICIENCY = 0.5
const STEP_MS = 250

export const DAEMON_NAMES = ['Byte', 'Nibble', 'Bit', 'Word', 'Qword', 'Kilo']

export const SERVERS: Record<ServerKind, { label: string; cycleMs: number; yield: number; cost: number }> = {
  pi: { label: 'Raspberry Pi', cycleMs: 10_000, yield: 8, cost: 0 },
  tower: { label: 'Tower server', cycleMs: 30_000, yield: 60, cost: 250 },
  blade: { label: 'Blade server', cycleMs: 90_000, yield: 400, cost: 2_000 },
  gpu: { label: 'GPU rig', cycleMs: 240_000, yield: 2_400, cost: 16_000 },
}

const TIERS: readonly ServerKind[] = ['pi', 'tower', 'blade', 'gpu']

export const rackX = (index: number): number => STRIP_LEFT + index * RACK_STRIDE

// Where a daemon stands to work on a rack.
const standX = (index: number): number => rackX(index) + 1

const newRack = (): Rack => ({ kind: 'pi', progress: 0, isDown: false })

const newDaemon = (index: number): Daemon => ({
  name: DAEMON_NAMES[index] ?? `Daemon ${index + 1}`,
  x: standX(0),
  target: null,
  workMs: 0,
})

export const newFarm = (now: number): Farm => ({
  version: 1,
  bytes: 0,
  lifetimeBytes: 0,
  racks: [newRack(), newRack()],
  daemons: [newDaemon(0)],
  overclock: 0,
  spikeMs: 0,
  incidents: 0,
  savedAt: now,
})

export const isFarm = (value: unknown): value is Farm => {
  const farm = value as Farm

  return (
    typeof value === 'object' &&
    value !== null &&
    farm.version === 1 &&
    typeof farm.bytes === 'number' &&
    Array.isArray(farm.racks) &&
    Array.isArray(farm.daemons)
  )
}

const speedOf = (farm: Farm): number => (1 + 0.2 * farm.overclock) * (farm.spikeMs > 0 ? 2 : 1)

export const ratePerSecond = (farm: Farm): number =>
  farm.racks.reduce(
    (sum, rack) => (rack.isDown ? sum : sum + (SERVERS[rack.kind].yield * 1000) / SERVERS[rack.kind].cycleMs),
    0,
  ) * speedOf(farm)

// The nearest rack that is full or down and that no other daemon has claimed.
const pickTarget = (racks: readonly Rack[], x: number, taken: ReadonlySet<number>): number | null => {
  let best = null as number | null
  racks.forEach((rack, index) => {
    const needsWork = rack.isDown || rack.progress >= 1
    if (!needsWork || taken.has(index)) return
    if (best === null || Math.abs(standX(index) - x) < Math.abs(standX(best) - x)) best = index
  })

  return best
}

const jobMs = (rack: Rack | undefined): number => (rack?.isDown ? FIX_MS : COLLECT_MS)

const tick = (farm: Farm, dt: number): Farm => {
  const speed = speedOf(farm)
  const racks = farm.racks.map(rack =>
    rack.isDown || rack.progress >= 1
      ? rack
      : { ...rack, progress: Math.min(1, rack.progress + (dt * speed) / SERVERS[rack.kind].cycleMs) },
  )
  const taken = new Set(farm.daemons.flatMap(daemon => (daemon.target === null ? [] : [daemon.target])))
  let bytes = farm.bytes
  let lifetimeBytes = farm.lifetimeBytes

  const daemons = farm.daemons.map(daemon => {
    let { x, target, workMs } = daemon

    if (target === null || target >= racks.length) {
      target = pickTarget(racks, x, taken)
      workMs = 0
      if (target !== null) taken.add(target)
    }
    if (target === null) return { ...daemon, target, workMs }

    const goal = standX(target)
    if (x !== goal) {
      const move = (DAEMON_SPEED * dt) / 1000
      x = Math.abs(goal - x) <= move ? goal : x + Math.sign(goal - x) * move
      if (x === goal) workMs = jobMs(racks[target])

      return { ...daemon, x, target, workMs }
    }

    if (workMs === 0) workMs = jobMs(racks[target])
    workMs -= dt
    if (workMs > 0) return { ...daemon, x, target, workMs }

    const rack = racks[target]
    if (rack?.isDown) {
      racks[target] = { ...rack, isDown: false }
    } else if (rack !== undefined && rack.progress >= 1) {
      bytes += SERVERS[rack.kind].yield
      lifetimeBytes += SERVERS[rack.kind].yield
      racks[target] = { ...rack, progress: 0 }
    }
    taken.delete(target)

    return { ...daemon, x, target: null, workMs: 0 }
  })

  return { ...farm, racks, daemons, bytes, lifetimeBytes, spikeMs: Math.max(0, farm.spikeMs - dt) }
}

// Runs the farm forward, in steps short enough for daemons to walk smoothly.
export const step = (farm: Farm, elapsedMs: number): Farm => {
  let next = farm
  for (let left = elapsedMs; left > 0; left -= STEP_MS) next = tick(next, Math.min(STEP_MS, left))

  return next
}

// Time the farm was not watched: paid at half rate, up to 8 hours, racks left full.
export const catchUp = (farm: Farm, elapsedMs: number): { farm: Farm; earned: number } => {
  const ms = Math.min(Math.max(0, elapsedMs), OFFLINE_CAP_MS)
  const speed = 1 + 0.2 * farm.overclock
  const perMs = farm.racks.reduce(
    (sum, rack) => (rack.isDown ? sum : sum + SERVERS[rack.kind].yield / SERVERS[rack.kind].cycleMs),
    0,
  )
  const earned = Math.floor(perMs * speed * ms * OFFLINE_EFFICIENCY)
  const racks = farm.racks.map(rack =>
    rack.isDown ? rack : { ...rack, progress: Math.min(1, rack.progress + (ms * speed) / SERVERS[rack.kind].cycleMs) },
  )

  return {
    farm: {
      ...farm,
      racks,
      bytes: farm.bytes + earned,
      lifetimeBytes: farm.lifetimeBytes + earned,
      spikeMs: Math.max(0, farm.spikeMs - ms),
    },
    earned,
  }
}

const upgradeTarget = (farm: Farm): { index: number; to: ServerKind } | null => {
  // Spelled with `as` so TypeScript keeps the type through the forEach assignments.
  let found = null as { index: number; tier: number } | null
  farm.racks.forEach((rack, index) => {
    const tier = TIERS.indexOf(rack.kind)
    if (tier < TIERS.length - 1 && (found === null || tier < found.tier)) found = { index, tier }
  })
  if (found === null) return null

  const { index, tier } = found
  const to = TIERS[tier + 1]

  return to === undefined ? null : { index, to }
}

export type ShopItem = { id: ShopItemId; label: string; cost: number | null }

export const shopItems = (farm: Farm): ShopItem[] => {
  const upgrade = upgradeTarget(farm)
  const from = upgrade === null ? undefined : farm.racks[upgrade.index]

  return [
    {
      id: 'rack',
      label: 'New rack',
      cost: farm.racks.length >= MAX_RACKS ? null : Math.round(40 * 1.6 ** (farm.racks.length - 2)),
    },
    {
      id: 'daemon',
      label: `Hire ${DAEMON_NAMES[farm.daemons.length] ?? 'a daemon'}`,
      cost: farm.daemons.length >= MAX_DAEMONS ? null : Math.round(120 * 3 ** (farm.daemons.length - 1)),
    },
    {
      id: 'overclock',
      label: `Overclock to level ${farm.overclock + 1}`,
      cost: farm.overclock >= MAX_OVERCLOCK ? null : Math.round(80 * 2.2 ** farm.overclock),
    },
    upgrade === null || from === undefined
      ? { id: 'upgrade', label: 'Upgrade a rack', cost: null }
      : {
          id: 'upgrade',
          label: `Rack ${upgrade.index + 1}: ${SERVERS[from.kind].label} to ${SERVERS[upgrade.to].label}`,
          cost: SERVERS[upgrade.to].cost,
        },
  ]
}

export const buy = (farm: Farm, id: ShopItemId): { farm: Farm; notice: string } => {
  const item = shopItems(farm).find(one => one.id === id)
  if (item === undefined || item.cost === null) return { farm, notice: 'Sold out' }
  if (farm.bytes < item.cost) return { farm, notice: `Not enough data for ${item.label}` }

  const paid = { ...farm, bytes: farm.bytes - item.cost }
  const upgrade = upgradeTarget(farm)
  switch (id) {
    case 'rack':
      return { farm: { ...paid, racks: [...paid.racks, newRack()] }, notice: 'A new rack is online' }
    case 'daemon':
      return {
        farm: { ...paid, daemons: [...paid.daemons, newDaemon(paid.daemons.length)] },
        notice: `${DAEMON_NAMES[paid.daemons.length] ?? 'A daemon'} joined the farm`,
      }
    case 'overclock':
      return { farm: { ...paid, overclock: paid.overclock + 1 }, notice: `Overclocked to level ${paid.overclock + 1}` }
    case 'upgrade': {
      if (upgrade === null) return { farm, notice: 'Sold out' }
      const racks = paid.racks.map((rack, index) =>
        index === upgrade.index ? { kind: upgrade.to, progress: 0, isDown: false } : rack,
      )

      return { farm: { ...paid, racks }, notice: `Rack ${upgrade.index + 1} is now a ${SERVERS[upgrade.to].label}` }
    }
  }
}

// What Claude Code activity does to the farm, and the line the band shows for it.
export const applyEvent = (farm: Farm, event: FarmEvent): { farm: Farm; notice: string | null } => {
  switch (event.kind) {
    case 'turn':
      return {
        farm: { ...farm, spikeMs: Math.min(MAX_SPIKE_MS, farm.spikeMs + SPIKE_MS) },
        notice: farm.spikeMs > 0 ? 'Traffic spike extended' : 'Traffic spike! Production x2',
      }
    case 'tests': {
      const bonus = Math.max(16, Math.floor(ratePerSecond({ ...farm, spikeMs: 0 }) * 30))

      return {
        farm: { ...farm, bytes: farm.bytes + bonus, lifetimeBytes: farm.lifetimeBytes + bonus },
        notice: `Green build! +${formatBytes(bonus)}`,
      }
    }
    case 'failure': {
      const up = farm.racks.flatMap((rack, index) => (rack.isDown ? [] : [index]))
      const down = farm.racks.length - up.length
      const index = up[farm.incidents % Math.max(1, up.length)]
      if (index === undefined || down >= Math.ceil(farm.racks.length / 3)) return { farm, notice: null }

      const racks = farm.racks.map((rack, i) => (i === index ? { ...rack, isDown: true } : rack))

      return { farm: { ...farm, racks, incidents: farm.incidents + 1 }, notice: `Incident! Rack ${index + 1} went down` }
    }
    case 'buy':
      return buy(farm, event.item)
  }
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

export const formatBytes = (bytes: number): string => {
  let value = Math.floor(bytes)
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }

  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${UNITS[unit]}`
}

export const formatRate = (perSecond: number): string =>
  perSecond < 10 ? `${perSecond.toFixed(1)} B/s` : `${formatBytes(perSecond)}/s`
