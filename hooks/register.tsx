import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BoardEvent, BoardSession, BoardState } from '../types'

// Every session on this machine writes its own file under ~/.claude/session-board/;
// the pane in any session reads them all, so one glance covers every stream.

const PANE = 'session-board'
const PANE_ARGS = { id: PANE, title: 'Sessions', columns: 48 }
const REFRESH_MS = 5_000
const SHOW_ENDED_MS = 12 * 60 * 60 * 1000
const SHOW_ANY_MS = 3 * 24 * 60 * 60 * 1000
const QUIET_MS = 2 * 60 * 60 * 1000
const MAX_EVENTS = 200

const sessions = atom({ plugin: 'session-board', key: 'sessions' } as const, [])
const selfId = atom({ plugin: 'session-board', key: 'selfId' } as const, '')

const ORDER: BoardState[] = ['needs-you', 'your-turn', 'working', 'ended']
const HEADINGS: Record<BoardState, string> = {
  'needs-you': 'Needs you',
  'your-turn': 'Finished, your turn',
  working: 'Working',
  ended: 'Ended today',
}
const COLORS: Record<BoardState, string> = {
  'needs-you': 'warning',
  'your-turn': 'success',
  working: 'suggestion',
  ended: 'inactive',
}

const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const ago = (ms: number) => {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${Math.floor(hours / 24)}d`
}

const time = (at: number) => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const lastPart = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

let dir = ''
let me: BoardSession | undefined
let writes = Promise.resolve()

async function boardDir($: EngineInterface) {
  if (dir) return dir
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  dir = `${home.replace(/[\\/]$/, '')}/.claude/session-board`
  return dir
}

async function loadAll($: EngineInterface) {
  const folder = await boardDir($)
  if (!(await $.fs.exists(folder))) return []
  const now = await $.clock.now()
  const entries = await $.fs.list(folder)
  const found: BoardSession[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    if (now - entry.mtimeMs > SHOW_ANY_MS) continue
    try {
      found.push(JSON.parse(await $.fs.read(`${folder}/${entry.name}`)) as BoardSession)
    } catch {
      // A file mid-write or hand-edited: skip it this round.
    }
  }
  return found
}

async function refresh($: EngineInterface) {
  const found = await loadAll($)
  await update($, sessions, () => found)
}

async function write($: EngineInterface, state: BoardState, note: string) {
  if (!me) return
  const at = await $.clock.now()
  const event: BoardEvent = { at, state, note: oneLine(note, 160) }
  me = {
    ...me,
    state,
    note: event.note,
    since: me.state === state ? me.since : at,
    updatedAt: at,
    events: [...me.events, event].slice(-MAX_EVENTS),
  }
  await $.fs.write(`${await boardDir($)}/${me.id}.json`, JSON.stringify(me, null, 1))
  await refresh($)
}

// Writes queue one behind another so a session's file never interleaves.
function record($: EngineInterface, state: BoardState, note: string) {
  writes = writes.then(() => write($, state, note)).catch(() => undefined)
  return writes
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const id = await $.session.id()
    const folder = await boardDir($)
    const path = `${folder}/${id}.json`
    const now = await $.clock.now()
    const saved = (await $.fs.exists(path))
      ? (JSON.parse(await $.fs.read(path)) as BoardSession)
      : undefined
    me = saved ?? {
      id,
      project: lastPart(e.cwd),
      cwd: e.cwd,
      label: '',
      state: 'your-turn',
      since: now,
      note: 'Started',
      updatedAt: now,
      events: [],
    }
    await update($, selfId, () => id)

    await $.command.register({ name: 'board', description: 'Show every Claude Code session: which need you, finished, working' })
    await $.command.register({ name: 'board-log', description: "Today's timeline across every Claude Code session" })

    await record($, saved ? saved.state : 'your-turn', saved ? 'Resumed' : 'Started')
    $.clock.every(REFRESH_MS, () => refresh($))
    // The desktop app reports its sessions as not interactive, so open regardless;
    // with nothing attached the pane simply waits.
    void $.ui.open(PANE_ARGS)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (me && !me.label && !e.isMeta) me = { ...me, label: oneLine(e.text, 70) }
    if (!e.isMeta) await record($, 'working', e.text)
    return next(e)
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    await record($, 'needs-you', `Approve ${e.tool_name}?`)
    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    // The idle reminder repeats "your turn"; everything else is a real ask.
    if (e.notification_type !== 'idle_prompt' && me?.state !== 'your-turn') {
      await record($, 'needs-you', e.message)
    }
    return next(e)
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    await record($, 'needs-you', `Question: ${e.questions[0]?.question ?? ''}`)
    const result = await next(e)
    await record($, 'working', 'Answered')
    return result
  })

  on('tool.call', async ($, e, next) => {
    // An approved permission means the session is moving again.
    if (me?.state === 'needs-you') await record($, 'working', `Running ${e.tool}`)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await record($, 'your-turn', e.isAborted ? 'Stopped' : e.answer || 'Finished')
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await record($, 'ended', `Ended (${e.reason})`)
    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    await refresh($)
    await $.ui.open(PANE_ARGS)
    return { text: 'Sessions board opened.' }
  })

  on('command.run', { command: 'board-log' }, async $ => {
    const all = await loadAll($)
    const now = new Date(await $.clock.now())
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const rows = all
      .flatMap(s => s.events.filter(ev => ev.at >= midnight).map(ev => ({ ...ev, who: `${s.project} · ${s.label || s.id.slice(0, 8)}` })))
      .sort((a, b) => a.at - b.at)
    if (rows.length === 0) return { text: 'No session activity today yet.' }
    const lines = rows.map(r => `${time(r.at)}  ${HEADINGS[r.state].padEnd(19)}  ${r.who} — ${r.note}`)
    return { text: `Today across ${new Set(rows.map(r => r.who)).size} sessions:\n\n${lines.join('\n')}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, sessions)
    const mine = await read($, selfId)
    const others = list.filter(s => s.id !== mine && s.state !== 'ended')
    const waiting = others.filter(s => s.state === 'needs-you')
    const finished = others.filter(s => s.state === 'your-turn')
    if (waiting.length === 0 && finished.length === 0) return next(e)
    const { Text } = $.ui.resolve(e)
    const names = (group: BoardSession[]) => group.map(s => s.project).join(', ')

    return (
      <Text>
        {waiting.length > 0 && <Text color="warning" bold>{waiting.length} need you: {names(waiting)}  </Text>}
        {finished.length > 0 && <Text color="success">{finished.length} finished: {names(finished)}</Text>}
      </Text>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, sessions)
    const mine = await read($, selfId)
    const now = await $.clock.now()
    const width = Math.max(20, e.props.bodyColumns)

    const shown = list.filter(s => s.state !== 'ended' || now - s.updatedAt < SHOW_ENDED_MS)
    const waiting = shown.filter(s => s.state === 'needs-you').length

    return (
      <Box flexDirection="column">
        <Text bold color={waiting ? 'warning' : 'success'}>
          {waiting ? `${waiting} need${waiting === 1 ? 's' : ''} you` : 'Nothing waiting on you'}
          <Text dimColor> · {shown.filter(s => s.state !== 'ended').length} open</Text>
        </Text>
        {shown.length === 0 && <Text dimColor>No sessions recorded yet.</Text>}
        {ORDER.map(state => {
          const group = shown
            .filter(s => s.state === state)
            .sort((a, b) => (state === 'ended' ? b.updatedAt - a.updatedAt : a.since - b.since))
          if (group.length === 0) return null
          return (
            <Box flexDirection="column" marginTop={1}>
              <Text color={COLORS[state]} bold>
                {HEADINGS[state]} ({group.length})
              </Text>
              {group.map(s => {
                const isQuiet = state === 'working' && now - s.updatedAt > QUIET_MS
                return (
                  <Box flexDirection="column">
                    <Text dimColor={state === 'ended'}>
                      {s.id === mine ? '▸ ' : '  '}
                      <Text bold>{s.project}</Text>
                      {s.label ? ` · ${oneLine(s.label, Math.max(10, width - s.project.length - 14))}` : ''}
                      <Text dimColor> {ago(now - s.since)}{isQuiet ? ' (quiet)' : ''}</Text>
                    </Text>
                    <Text dimColor>    {oneLine(s.note, Math.max(10, width - 4))}</Text>
                  </Box>
                )
              })}
            </Box>
          )
        })}
      </Box>
    )
  })
}
