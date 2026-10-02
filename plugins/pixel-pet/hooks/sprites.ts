import type { PetMood, PetStage } from '../types'

// The sprite is 14x12 pixels, drawn two pixels per terminal cell with half blocks.
export const COLUMNS = 14
export const ROWS = 6

export const STAGES: readonly { stage: PetStage; from: number; label: string }[] = [
  { stage: 'egg', from: 0, label: 'an egg' },
  { stage: 'baby', from: 3, label: 'a baby slime' },
  { stage: 'teen', from: 25, label: 'a teen slime' },
  { stage: 'adult', from: 100, label: 'a slime king' },
]

export const stageOf = (xp: number): PetStage =>
  STAGES.reduce<PetStage>((found, step) => (xp >= step.from ? step.stage : found), 'egg')

export const stageLabel = (stage: PetStage): string =>
  STAGES.find(step => step.stage === stage)?.label ?? stage

export const stageStart = (stage: PetStage): number =>
  STAGES.find(step => step.stage === stage)?.from ?? 0

// The xp the stage after `stage` starts at, or undefined once fully grown.
export const nextStageAt = (stage: PetStage): number | undefined => {
  const index = STAGES.findIndex(step => step.stage === stage)

  return STAGES[index + 1]?.from
}

// '.' is transparent; every other letter is a key of the stage's palette.
const EGG = [
  '..............',
  '.....oooo.....',
  '....obbbbo....',
  '...obblbbbo...',
  '...obbbbbbo...',
  '..obbbbbllbo..',
  '..obllbbbbbo..',
  '..obbbbbbbbo..',
  '..obbbblbbbo..',
  '...obbbbbbo...',
  '....oooooo....',
  '..............',
]

const BODY = [
  '..obllbbbbbo..',
  '.obllbbbbbbbo.',
  '.obbbbbbbbbbo.',
  '.obbbbbbbbbbo.',
  'obbbbbbbbbbbbo',
  'obbbbbbbbbbbbo',
  'obbbbbbbbbbbbo',
  '.obbbbbbbbbbo.',
  '..oooooooooo..',
]

const BODIES: Record<Exclude<PetStage, 'egg'>, string[]> = {
  baby: ['..............', '.....oooo.....', '...oobbbboo...', ...BODY],
  teen: ['..o........o..', '..obo....obo..', '..obboooobbo..', ...BODY],
  adult: ['....g.gg.g....', '....gggggg....', '...oobbbboo...', ...BODY],
}

type Face = 'open' | 'left' | 'right' | 'closed' | 'happy'

// Each eye is 2x2 pixels: top-left, top-right, bottom-left, bottom-right.
const EYES: Record<Face, readonly [string, string, string, string]> = {
  open: ['e', 'w', 'e', 'e'],
  left: ['e', 'w', 'e', 'w'],
  right: ['w', 'e', 'w', 'e'],
  closed: ['b', 'b', 'e', 'e'],
  happy: ['e', 'e', 'b', 'b'],
}

const MOUTHS = {
  neutral: [[6, 9], [7, 9]],
  smile: [[4, 8], [5, 9], [6, 9], [7, 9], [8, 9], [9, 8]],
  frown: [[5, 9], [6, 9], [7, 9], [8, 9], [4, 10], [9, 10]],
} as const

const hex = (color: string): number => parseInt(color.slice(1), 16)

const FACE_COLORS = { e: '#14201a', w: '#ffffff', m: '#14201a', p: '#ff8fab', t: '#6ec6ff' }

export const PALETTES: Record<PetStage, Record<string, string>> = {
  egg: { o: '#3b2f2f', b: '#f2e6c9', l: '#c9a36b' },
  baby: { ...FACE_COLORS, o: '#1f5130', b: '#6fd08c', l: '#b6f2c8' },
  teen: { ...FACE_COLORS, o: '#1d3a6b', b: '#6fa8ff', l: '#bcd6ff' },
  adult: { ...FACE_COLORS, o: '#43205e', b: '#b07cff', l: '#dcc4ff', g: '#ffd166' },
}

const faceFor = (mood: PetMood, frame: number): Face => {
  switch (mood) {
    case 'happy':
      return 'happy'
    case 'sleeping':
      return 'closed'
    case 'working':
      // Glances left and right, as if reading the code going by.
      return Math.floor(frame / 2) % 2 === 0 ? 'left' : 'right'
    case 'sad':
      return 'open'
    case 'idle':
      return frame % 8 === 7 ? 'closed' : 'open'
  }
}

const shift = (row: string, by: number): string =>
  by > 0 ? '.'.repeat(by) + row.slice(0, -by) : by < 0 ? row.slice(-by) + '.'.repeat(-by) : row

export const petPixels = (stage: PetStage, mood: PetMood, frame: number): string[] => {
  if (stage === 'egg') {
    const wobble = mood === 'working' || mood === 'happy' ? ([0, 1, 0, -1][frame % 4] ?? 0) : 0

    return EGG.map(row => shift(row, wobble))
  }

  const grid = BODIES[stage].map(row => row.split(''))
  const paint = (x: number, y: number, key: string) => {
    const row = grid[y]
    if (row !== undefined && x < row.length) row[x] = key
  }

  const [topLeft, topRight, bottomLeft, bottomRight] = EYES[faceFor(mood, frame)]
  for (const x of [4, 8]) {
    paint(x, 6, topLeft)
    paint(x + 1, 6, topRight)
    paint(x, 7, bottomLeft)
    paint(x + 1, 7, bottomRight)
  }

  const mouth = mood === 'happy' ? MOUTHS.smile : mood === 'sad' ? MOUTHS.frown : MOUTHS.neutral
  for (const [x, y] of mouth) paint(x, y, 'm')

  if (mood === 'happy') {
    paint(3, 8, 'p')
    paint(10, 8, 'p')
  }
  if (mood === 'sad') paint(4, 8, 't')

  return grid.map(row => row.join(''))
}

const DEFAULT_COLOR = 0x01000000
const UPPER_HALF = 0x2580
const LOWER_HALF = 0x2584
const SPACE = 0x20

// Packs pixel rows into RasterProps cells: [codePoint, fg, bg] u32 triplets, base64.
export const encodeCells = (pixels: string[], palette: Record<string, string>): string => {
  const width = pixels[0]?.length ?? 0
  const rows = Math.floor(pixels.length / 2)
  const words = new Uint32Array(width * rows * 3)
  const colorAt = (x: number, y: number): number | undefined => {
    const key = pixels[y]?.[x]
    const color = key === undefined ? undefined : palette[key]

    return color === undefined ? undefined : hex(color)
  }

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < width; x++) {
      const top = colorAt(x, 2 * y)
      const bottom = colorAt(x, 2 * y + 1)
      const cell =
        top !== undefined
          ? [UPPER_HALF, top, bottom ?? DEFAULT_COLOR]
          : bottom !== undefined
            ? [LOWER_HALF, bottom, DEFAULT_COLOR]
            : [SPACE, DEFAULT_COLOR, DEFAULT_COLOR]
      words.set(cell, (y * width + x) * 3)
    }
  }

  const bytes = new Uint8Array(words.buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)

  return btoa(binary)
}

export const drawPet = (stage: PetStage, mood: PetMood, frame: number): string =>
  encodeCells(petPixels(stage, mood, frame), PALETTES[stage])

// A text face for surfaces without Raster (desktop, VS Code, mobile).
export const kaomoji = (stage: PetStage, mood: PetMood, frame: number): string => {
  if (stage === 'egg') return mood === 'working' && frame % 2 === 1 ? '(0)~' : '(0)'

  switch (mood) {
    case 'happy':
      return '(^‿^)'
    case 'sad':
      return '(;︵;)'
    case 'sleeping':
      return '(-.-)'
    case 'working':
      return Math.floor(frame / 2) % 2 === 0 ? '(•_• )' : '( •_•)'
    case 'idle':
      return frame % 8 === 7 ? '(-‿-)' : '(•‿•)'
  }
}
