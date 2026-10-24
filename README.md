# session-board

One board of every Claude Code session on your machine, in a pane beside the chat. When you run many sessions at once, notifications flash and vanish; the board stays put and answers one question: **which sessions are waiting on me?**

Sessions are grouped:

- **Needs you** — a permission prompt, a question, or another ask
- **Finished, your turn** — the turn ended; the last line of the answer is shown
- **Working** — running; marked *(quiet)* after two hours with no activity
- **Ended today** — closed within the last 12 hours

The session you are in is marked with ▸.

## Commands

- `/board` — open the board pane
- `/board-log` — today's timeline across every session, oldest first

## How it works

Every session with the mod installed writes its own small JSON file to `~/.claude/session-board/<session-id>.json` (state, project, first prompt as its label, last note, and up to 200 events). Each pane reads that folder every five seconds. Nothing leaves your machine. Files older than three days are ignored; delete the folder at any time to start fresh.

## Install

At the prompt of a terminal session:

```
/plugin install session-board --marketplace iiljohne/claude-session-board
```

From a shell:

```
claude plugin install session-board --marketplace iiljohne/claude-session-board
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `iiljohne/claude-session-board`, then Add plugin.

Install at the user scope so it runs in every session.
