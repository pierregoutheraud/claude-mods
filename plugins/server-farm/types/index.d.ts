export type ServerKind = 'pi' | 'tower' | 'blade' | 'gpu'

export type Rack = {
  kind: ServerKind
  // 0 to 1; at 1 the rack holds a full batch of data waiting for a daemon.
  progress: number
  isDown: boolean
}

export type Daemon = {
  name: string
  // Position along the strip, in pixels.
  x: number
  // The rack it is heading to or working on.
  target: number | null
  // Time left on the job at the target; 0 while walking or idle.
  workMs: number
}

export type Farm = {
  version: 1
  bytes: number
  lifetimeBytes: number
  racks: Rack[]
  daemons: Daemon[]
  overclock: number
  spikeMs: number
  incidents: number
  savedAt: number
}

export type ShopItemId = 'rack' | 'daemon' | 'overclock' | 'upgrade'

export type FarmEvent = { kind: 'turn' } | { kind: 'tests' } | { kind: 'failure' } | { kind: 'buy'; item: ShopItemId }

export type FarmNotice = { text: string; until: number }

declare module 'claude-code' {
  interface PluginState {
    'server-farm': {
      farm: Farm | null
      isOwner: boolean
      notice: FarmNotice | null
      isHidden: boolean
      frame: number
    }
  }
}
