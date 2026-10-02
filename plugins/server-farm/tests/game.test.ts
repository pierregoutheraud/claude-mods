import { describe, expect, test } from 'claude-code/testing'

import { drawCanvas } from '../hooks/draw'
import type { Farm } from '../types'
import { applyEvent, buy, catchUp, formatBytes, newFarm, ratePerSecond, step } from '../hooks/game'

// Production per second, to one decimal.
const rate = (farm: Farm) => Math.round(ratePerSecond(farm) * 10) / 10

describe('game', () => {
  test('a new farm has two Raspberry Pi racks and Byte', async () => {
    const farm = newFarm(0)
    expect(farm.racks.map(rack => rack.kind)).toEqual(['pi', 'pi'])
    expect(farm.daemons.map(daemon => daemon.name)).toEqual(['Byte'])
    expect(rate(farm)).toBe(1.6)
  })

  test('racks fill up and Byte walks over to collect them', async () => {
    const farm = step(newFarm(0), 15_000)
    expect(farm.bytes).toBe(16)
    expect(farm.racks.every(rack => rack.progress < 1)).toBe(true)
  })

  test('two daemons never claim the same rack', async () => {
    const start = buy({ ...newFarm(0), bytes: 120 }, 'daemon').farm
    const ready = { ...start, racks: [{ kind: 'pi' as const, progress: 1, isDown: false }, start.racks[1]!] }
    const next = step(ready, 250)
    expect(next.daemons.filter(daemon => daemon.target === 0)).toHaveLength(1)
  })

  test('the shop charges data and refuses what you cannot afford', async () => {
    const bought = buy({ ...newFarm(0), bytes: 100 }, 'rack')
    expect(bought.farm.racks).toHaveLength(3)
    expect(bought.farm.bytes).toBe(60)

    const refused = buy(bought.farm, 'daemon')
    expect(refused.farm).toBe(bought.farm)
    expect(refused.notice).toBe('Not enough data for Hire Nibble')

    const upgraded = buy({ ...newFarm(0), bytes: 300 }, 'upgrade')
    expect(upgraded.farm.racks.map(rack => rack.kind)).toEqual(['tower', 'pi'])
    expect(upgraded.farm.bytes).toBe(50)
  })

  test('a finished turn doubles production for a minute, up to five', async () => {
    const spiking = applyEvent(newFarm(0), { kind: 'turn' })
    expect(spiking.notice).toBe('Traffic spike! Production x2')
    expect(rate(spiking.farm)).toBe(3.2)

    let farm = spiking.farm
    for (let i = 0; i < 10; i++) farm = applyEvent(farm, { kind: 'turn' }).farm
    expect(farm.spikeMs).toBe(300_000)
    expect(step(farm, 300_000).spikeMs).toBe(0)
  })

  test('passing tests pay 30 seconds of production', async () => {
    const paid = applyEvent(newFarm(0), { kind: 'tests' })
    expect(paid.farm.bytes).toBe(48)
    expect(paid.notice).toBe('Green build! +48 B')
  })

  test('a failure takes a rack down until a daemon fixes it, a third of the racks at most', async () => {
    const hit = applyEvent(newFarm(0), { kind: 'failure' })
    expect(hit.notice).toBe('Incident! Rack 1 went down')
    expect(rate(hit.farm)).toBe(0.8)

    const again = applyEvent(hit.farm, { kind: 'failure' })
    expect(again.notice).toBeNull()
    expect(again.farm).toBe(hit.farm)

    expect(step(hit.farm, 5_000).racks[0]?.isDown).toBe(false)
  })

  test('time away pays half rate, up to 8 hours', async () => {
    const hour = catchUp(newFarm(0), 60 * 60 * 1000)
    expect(hour.earned).toBe(2880)
    expect(hour.farm.racks.every(rack => rack.progress === 1)).toBe(true)

    expect(catchUp(newFarm(0), 24 * 60 * 60 * 1000).earned).toBe(2880 * 8)
  })

  test('data is counted in bytes, kilobytes and up', async () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023.9)).toBe('1023 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  test('the strip is 10 pixels tall with a floor across the whole width', async () => {
    const canvas = drawCanvas(newFarm(0), 60, 0)
    expect(canvas).toHaveLength(10)
    expect(canvas[9]?.every(color => color !== undefined)).toBe(true)
  })
})
