import type { Daemon, Farm, Rack, ServerKind } from '../types'
import { RACK_WIDTH, rackX } from './game'

// The strip is 10 pixels tall, two per terminal row with half blocks: racks on
// top, a lane below them where the daemons walk, and the floor.
export const STRIP_ROWS = 5
const HEIGHT = STRIP_ROWS * 2
const FLOOR_Y = HEIGHT - 1
const RACK_TOP = 0
const RACK_HEIGHT = 6
const LEDS = 4

const COLORS = {
  floor: '#30363d',
  inside: '#161b22',
  bay: '#30363d',
  led: '#7ee787',
  ledOff: '#21262d',
  ready: '#ffd166',
  down: '#ff6b6b',
  activity: '#58a6ff',
  visor: '#56d4dd',
  packet: '#ffd166',
}

const FRAMES: Record<ServerKind, string> = {
  pi: '#4b5563',
  tower: '#9ca3af',
  blade: '#58a6ff',
  gpu: '#3fb950',
}

const DAEMON_COLORS = ['#e5c07b', '#c678dd', '#56b6c2', '#e06c75', '#98c379', '#d19a66']

type Canvas = (string | undefined)[][]

const paint = (canvas: Canvas, x: number, y: number, color: string) => {
  const row = canvas[y]
  if (row !== undefined && x >= 0 && x < row.length) row[x] = color
}

export const visibleRacks = (farm: Farm, columns: number): number =>
  farm.racks.filter((_, index) => rackX(index) + RACK_WIDTH <= columns).length

const drawRack = (canvas: Canvas, rack: Rack, index: number, frame: number, isSpiking: boolean) => {
  const left = rackX(index)
  const right = left + RACK_WIDTH - 1
  const bottom = RACK_TOP + RACK_HEIGHT - 1

  for (let y = RACK_TOP; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const isEdge = y === RACK_TOP || y === bottom || x === left || x === right
      paint(canvas, x, y, isEdge ? FRAMES[rack.kind] : COLORS.inside)
    }
  }

  // Drive bays for texture.
  for (const y of [RACK_TOP + 2, RACK_TOP + 4]) {
    paint(canvas, left + 3, y, COLORS.bay)
    paint(canvas, left + 4, y, COLORS.bay)
  }

  // Two columns of LEDs fill from the bottom as the batch builds up.
  const lit = Math.floor(rack.progress * LEDS)
  for (let level = 0; level < LEDS; level++) {
    const y = bottom - 1 - level
    const color = rack.isDown
      ? frame % 2 === 0
        ? COLORS.down
        : COLORS.ledOff
      : rack.progress >= 1
        ? frame % 4 < 2
          ? COLORS.ready
          : COLORS.ledOff
        : level < lit
          ? COLORS.led
          : COLORS.ledOff
    paint(canvas, left + 1, y, color)
    paint(canvas, left + 2, y, color)
  }

  // The activity light flickers while the rack works, faster during a traffic spike.
  const isWorking = !rack.isDown && rack.progress < 1
  const isOn = isWorking && (frame + index) % (isSpiking ? 2 : 4) === 0
  paint(canvas, left + 4, RACK_TOP + 1, isOn ? COLORS.activity : COLORS.inside)
}

// A daemon is a 4x4 robot with a visor, walking the lane below the racks. While it
// works, a packet blinks between it and the rack.
const drawDaemon = (canvas: Canvas, daemon: Daemon, index: number, frame: number) => {
  const x = Math.round(daemon.x)
  const body = DAEMON_COLORS[index % DAEMON_COLORS.length] ?? COLORS.visor
  const isWorking = daemon.workMs > 0
  const isWalking = daemon.target !== null && !isWorking
  const top = FLOOR_Y - 3

  if (isWorking && frame % 2 === 0) paint(canvas, x + 2, top - 1, COLORS.packet)
  for (const dx of [1, 2]) paint(canvas, x + dx, top, body)
  paint(canvas, x, top + 1, body)
  paint(canvas, x + 1, top + 1, COLORS.visor)
  paint(canvas, x + 2, top + 1, COLORS.visor)
  paint(canvas, x + 3, top + 1, body)
  for (let dx = 0; dx < 4; dx++) paint(canvas, x + dx, top + 2, body)

  const legs = isWalking && frame % 2 === 1 ? [1, 2] : [0, 3]
  for (const dx of legs) paint(canvas, x + dx, top + 3, body)
}

const DEFAULT_COLOR = 0x01000000
const UPPER_HALF = 0x2580
const LOWER_HALF = 0x2584
const SPACE = 0x20

const hex = (color: string | undefined): number | undefined =>
  color === undefined ? undefined : parseInt(color.slice(1), 16)

// Packs a canvas into RasterProps cells: [codePoint, fg, bg] u32 triplets, base64.
const encode = (canvas: Canvas, columns: number): string => {
  const words = new Uint32Array(columns * STRIP_ROWS * 3)
  for (let row = 0; row < STRIP_ROWS; row++) {
    for (let x = 0; x < columns; x++) {
      const top = hex(canvas[2 * row]?.[x])
      const bottom = hex(canvas[2 * row + 1]?.[x])
      const cell =
        top !== undefined
          ? [UPPER_HALF, top, bottom ?? DEFAULT_COLOR]
          : bottom !== undefined
            ? [LOWER_HALF, bottom, DEFAULT_COLOR]
            : [SPACE, DEFAULT_COLOR, DEFAULT_COLOR]
      words.set(cell, (row * columns + x) * 3)
    }
  }

  const bytes = new Uint8Array(words.buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)

  return btoa(binary)
}

export const drawCanvas = (farm: Farm, columns: number, frame: number): Canvas => {
  const canvas: Canvas = Array.from({ length: HEIGHT }, () => new Array<string | undefined>(columns).fill(undefined))
  for (let x = 0; x < columns; x++) paint(canvas, x, FLOOR_Y, COLORS.floor)

  const shown = visibleRacks(farm, columns)
  farm.racks.slice(0, shown).forEach((rack, index) => drawRack(canvas, rack, index, frame, farm.spikeMs > 0))
  farm.daemons.forEach((daemon, index) => drawDaemon(canvas, daemon, index, frame))

  return canvas
}

export const drawStrip = (farm: Farm, columns: number, frame: number): string =>
  encode(drawCanvas(farm, columns, frame), columns)

const LEVELS = '▁▂▃▄▅▆▇█'

// The farm as text, for surfaces without Raster (desktop, VS Code, mobile).
export const textStrip = (farm: Farm, frame: number): string =>
  farm.racks
    .map(rack =>
      rack.isDown
        ? '[x]'
        : rack.progress >= 1
          ? frame % 4 < 2
            ? '[*]'
            : '[ ]'
          : `[${LEVELS[Math.min(LEVELS.length - 1, Math.floor(rack.progress * LEVELS.length))]}]`,
    )
    .join('')
