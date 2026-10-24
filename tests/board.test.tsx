import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'session-board',
  component: 'Pane',
  requestId: 'session-board',
  props: {
    title: 'Sessions',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('a prompt puts the session under Working, then a finished turn under your turn', async ($, on) => {
  const files = new Map<string, string>()
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'abc123' }))
  on('env.get', (_, e) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/test' : undefined }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) || e.path.endsWith('session-board') }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.list', () => ({
    value: [...files.keys()].map(path => ({
      name: path.split(/[\\/]/).at(-1) ?? path,
      kind: 'file' as const,
      size: 1,
      mtimeMs: Date.now(),
      isLink: false,
    })),
  }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  mock.clock(on)

  await $.session.start({ cwd: 'C:/dev/my-app', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Tidy the board backlog' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Working \(1\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /my-app/ })).toBeDefined()
    await ui.unmount()
  }

  await $.turn.complete({ answer: 'Backlog tidied.', durationMs: 1, isAborted: false, turnId: 't1' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Finished, your turn \(1\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Backlog tidied/ })).toBeDefined()
  await ui.unmount()
})
