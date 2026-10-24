export type BoardState = 'needs-you' | 'your-turn' | 'working' | 'ended'

export type BoardEvent = { at: number; state: BoardState; note: string }

export type BoardSession = {
  id: string
  project: string
  cwd: string
  label: string
  /** The desktop app's sidebar title, when the session runs there. */
  title?: string
  state: BoardState
  since: number
  note: string
  updatedAt: number
  events: BoardEvent[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-board': { sessions: BoardSession[]; selfId: string }
  }
}
