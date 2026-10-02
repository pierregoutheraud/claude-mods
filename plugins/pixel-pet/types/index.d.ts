export type PetStage = 'egg' | 'baby' | 'teen' | 'adult'

export type PetMood = 'idle' | 'working' | 'happy' | 'sad' | 'sleeping'

export type Pet = { name: string; xp: number; bornAt: number }

export type PetFlash = { mood: 'happy' | 'sad'; text: string; until: number }

declare module 'claude-code' {
  interface PluginState {
    'pixel-pet': {
      pet: Pet | null
      frame: number
      flash: PetFlash | null
      isAsleep: boolean
      isHidden: boolean
    }
  }
}
