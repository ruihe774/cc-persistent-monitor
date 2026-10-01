type Watch = {
  id: string
  description: string
  stop: (reason: string) => void
}

type Io = {
  spawn: (r: { argv: string[] }) => any
  after: (ms: number, fn: () => void) => any
  submit: (text: string) => Promise<unknown>
}

const DEFAULT_TIMEOUT_MS = 300_000
const BATCH_MS = 200
const MAX_BATCH_CHARS = 8_000
// Models tend to poll or block after starting a watch, which only delays delivery
const DELIVERY_NOTE =
  'Events arrive between turns as new messages from this plugin, never as tool results. ' +
  'After starting a watch, continue with other work or end your turn. Do not poll for events (ReadNotifications, sleep, tail or wait loops) ' +
  'and do not wait inside the turn: waiting does not speed delivery up and only delays it.'
const RESULT_NOTE = 'Events arrive as messages after this turn; do not poll or wait for them, just continue or end your turn.'

export function register(on: any) {
  const watches = new Map<string, Watch>()
  let nextId = 1

  on('session.start', async ($: any, e: any, next: any) => {
    await $.tool.register({
      name: 'monitor',
      description:
        'Start a background monitor that streams events from a long-running shell command. Each stdout line is an event: ' +
        'you keep working and notifications arrive as messages from this plugin. ' + DELIVERY_NOTE + ' Unlike the built-in Monitor, a watch with ' +
        '`persistent: true` has no deadline and runs until `monitor_stop` or the session ends, so you never need to re-arm it.\n\n' +
        'Pick by how many notifications you need:\n' +
        '- One ("tell me when the build finishes") -> use Bash with run_in_background and a command that exits when the condition is true.\n' +
        '- One per occurrence -> this tool, with an unbounded command (`tail -f`, `inotifywait -m`, `while true`).\n\n' +
        'Script quality: every pipe stage must flush per line (`grep --line-buffered`, awk `fflush()`); handle transient failures in poll loops ' +
        '(`curl ... || true`); poll 30s+ for remote APIs. Only stdout is the event stream; merge stderr with `2>&1` if failures should reach you. ' +
        'Silence is not success: the filter must match failure/terminal states too. Keep output selective, since every line is a message; ' +
        'a monitor that floods is stopped automatically. Write a specific `description`: it appears in every notification. ' +
        'The command runs via `bash -c` in the session working directory.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command or script. Each stdout line is an event; exit ends the watch.' },
          description: { type: 'string', description: 'Short human-readable description of what you are monitoring (shown in notifications).' },
          persistent: {
            type: 'boolean',
            default: false,
            description: 'Run for the whole session with no deadline, until monitor_stop. Ignores timeout_ms.',
          },
          timeout_ms: {
            type: 'number',
            default: DEFAULT_TIMEOUT_MS,
            minimum: 1000,
            description: 'Kill the monitor after this deadline (default 300000). Ignored when persistent is true.',
          },
        },
        required: ['command', 'description'],
        additionalProperties: false,
      },
    })
    await $.tool.register({
      name: 'monitor_stop',
      description: 'Stop a monitor started with the monitor tool, by its id. With no id, lists the running monitors.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Monitor id, e.g. "pm-1".' } },
        additionalProperties: false,
      },
    })
    await $.tool.register({
      name: 'waitpid',
      description:
        'Wait for a process to exit. Returns immediately; you get one message when process `pid` ends (no deadline). ' +
        'Use this instead of polling `ps`. Cancel with monitor_stop. ' + DELIVERY_NOTE,
      inputSchema: {
        type: 'object',
        properties: {
          pid: { type: 'integer', description: 'Process id to wait for.' },
          description: { type: 'string', description: 'What the process is, shown in the notification.' },
        },
        required: ['pid'],
        additionalProperties: false,
      },
    })
    await $.tool.register({
      name: 'waitfile',
      description:
        'Follow a file (`tail -F`) and get a message for each line appended to it, optionally only lines matching a regex. ' +
        'The file may not exist yet. Set `once` to stop after the first (matching) line. Runs with no deadline by default; cancel with monitor_stop. ' + DELIVERY_NOTE,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File to follow.' },
          pattern: { type: 'string', description: 'JavaScript regex; only matching lines are events.' },
          once: { type: 'boolean', default: false, description: 'Stop after the first event.' },
          from_start: { type: 'boolean', default: false, description: 'Also report lines already in the file.' },
          persistent: { type: 'boolean', default: true, description: 'No deadline. Set false to use timeout_ms.' },
          timeout_ms: { type: 'number', default: DEFAULT_TIMEOUT_MS, minimum: 1000, description: 'Deadline when persistent is false.' },
          description: { type: 'string', description: 'Shown in notifications.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    })
    return next(e)
  })

  type WatchOpts = {
    argv: string[]
    description: string
    persistent: boolean
    timeoutMs: number
    kind?: string
    // Keep only lines this accepts
    filter?: (line: string) => boolean
    // Stop after the first event
    once?: boolean
    // Replaces the generic "ended" text on a natural exit
    endText?: (exit: { code: number | null; signal: string | null } | undefined) => string
  }

  function startWatch(io: Io, o: WatchOpts) {
    const { description, persistent, timeoutMs } = o
    const id = 'pm-' + nextId++
    const stream = io.spawn({ argv: o.argv })
    let stopReason: string | null = null
    let timer: any = null
    let events = 0

    const watch: Watch = {
      id,
      description,
      stop: (reason: string) => {
        if (stopReason === null) stopReason = reason
        // Leaving the loop kills the child
        void stream.return?.(undefined as any).catch(() => {})
      },
    }
    watches.set(id, watch)
    if (!persistent) timer = io.after(timeoutMs, () => watch.stop(`timed out after ${Math.round(timeoutMs / 1000)}s`))

    const notify = (text: string) => {
      io.submit(text).catch(() => {})
    }

    void (async () => {
      let buf = ''
      let pending: string[] = []
      let flushTimer: any = null
      let size = 0
      const flush = () => {
        flushTimer = null
        if (!pending.length) return
        const lines = pending
        pending = []
        size = 0
        events += lines.length
        notify(`[${o.kind ?? 'monitor'} ${id}: ${description}]\n` + lines.join('\n'))
      }
      const push = (line: string) => {
        if (o.filter && !o.filter(line)) return
        if (size > MAX_BATCH_CHARS) return
        size += line.length
        pending.push(size > MAX_BATCH_CHARS ? '[output truncated]' : line)
        if (!flushTimer) flushTimer = io.after(BATCH_MS, flush)
        if (o.once) watch.stop('first event received')
      }
      let exit: { code: number | null; signal: string | null } | undefined
      try {
        while (true) {
          const r = await stream.next()
          if (r.done) {
            exit = r.value
            break
          }
          if (r.value.stream !== 'stdout') continue
          buf += r.value.text
          const parts = buf.split('\n')
          buf = parts.pop() ?? ''
          for (const l of parts) if (l) push(l)
        }
      } catch (err: any) {
        stopReason ??= 'failed: ' + (err?.message ?? err)
      }
      if (buf) push(buf)
      flushTimer?.cancel?.()
      flush()
      timer?.cancel?.()
      watches.delete(id)
      const label = `[${o.kind ?? 'monitor'} ${id}: ${description}]`
      if (stopReason === null && o.endText) {
        notify(`${label} ${o.endText(exit)}`)
      } else {
        const how = stopReason ?? (exit ? `exited with code ${exit.code ?? exit.signal}` : 'ended')
        notify(`${label} ended: ${how} (${events} event${events === 1 ? '' : 's'}). Re-arm if you still need the watch.`)
      }
    })()
    return id
  }

  on('tool.call', { tool: 'mcp__persistent-monitor__monitor' }, async ($: any, e: any) => {
    const io: Io = {
      spawn: r => $.process.spawn(r),
      after: (ms, fn) => $.clock.after(ms, fn),
      submit: text => $.prompt.submit({ text }),
    }
    if (typeof e.command !== 'string' || !e.command.trim()) return { result: 'Error: command is required', isError: true }
    const description = String(e.description ?? e.command).slice(0, 200)
    const persistent = e.persistent === true
    const timeoutMs = Number.isFinite(e.timeout_ms) ? Math.max(1000, e.timeout_ms) : DEFAULT_TIMEOUT_MS
    const id = startWatch(io, { argv: ['bash', '-c', e.command], description, persistent, timeoutMs })
    return {
      result: persistent
        ? `Monitor ${id} started: ${description}. persistent: runs until monitor_stop or session end. ${RESULT_NOTE}`
        : `Monitor ${id} started: ${description}. Expires in ${Math.round(timeoutMs / 1000)}s. ${RESULT_NOTE}`,
    }
  })

  on('tool.call', { tool: 'mcp__persistent-monitor__waitpid' }, async ($: any, e: any) => {
    const io: Io = {
      spawn: r => $.process.spawn(r),
      after: (ms, fn) => $.clock.after(ms, fn),
      submit: text => $.prompt.submit({ text }),
    }
    const pid = Number(e.pid)
    if (!Number.isInteger(pid) || pid <= 0) return { result: 'Error: pid must be a positive integer', isError: true }
    const description = String(e.description ?? `process ${pid}`).slice(0, 200)
    // tail exits when the process does; nothing is written to /dev/null
    const id = startWatch(io, {
      argv: ['tail', `--pid=${pid}`, '-f', '/dev/null'],
      description,
      kind: 'waitpid',
      persistent: true,
      timeoutMs: 0,
      endText: () => `process ${pid} has exited.`,
    })
    return { result: `waitpid ${id} started: ${description}. You will get one message when process ${pid} exits (no deadline; monitor_stop to cancel). ${RESULT_NOTE}` }
  })

  on('tool.call', { tool: 'mcp__persistent-monitor__waitfile' }, async ($: any, e: any) => {
    const io: Io = {
      spawn: r => $.process.spawn(r),
      after: (ms, fn) => $.clock.after(ms, fn),
      submit: text => $.prompt.submit({ text }),
    }
    if (typeof e.path !== 'string' || !e.path) return { result: 'Error: path is required', isError: true }
    let re: RegExp | undefined
    if (e.pattern) {
      try {
        re = new RegExp(e.pattern)
      } catch (err: any) {
        return { result: 'Error: invalid pattern: ' + err.message, isError: true }
      }
    }
    const once = e.once === true
    const description = String(e.description ?? `${e.path}${re ? ` /${e.pattern}/` : ''}`).slice(0, 200)
    // -F follows by name and retries, so the file may not exist yet or may be rotated
    const id = startWatch(io, {
      argv: ['tail', '-F', '-n', e.from_start === true ? '+1' : '0', '--', e.path],
      description,
      kind: 'waitfile',
      persistent: e.persistent !== false,
      timeoutMs: Number.isFinite(e.timeout_ms) ? Math.max(1000, e.timeout_ms) : DEFAULT_TIMEOUT_MS,
      filter: re ? l => re!.test(l) : undefined,
      once,
    })
    return {
      result: `waitfile ${id} started: ${description}. ${once ? 'One message on the first' : 'A message for each'} ${re ? 'matching ' : ''}line appended to ${e.path}. ${e.persistent !== false ? 'No deadline' : 'Has a deadline'}; monitor_stop to cancel. ${RESULT_NOTE}`,
    }
  })

  on('tool.call', { tool: 'mcp__persistent-monitor__monitor_stop' }, async ($: any, e: any) => {
    if (!e.id) {
      const list = [...watches.values()].map(w => `${w.id}: ${w.description}`)
      return { result: list.length ? list.join('\n') : 'No monitors running.' }
    }
    const w = watches.get(e.id)
    if (!w) return { result: `No running monitor with id ${e.id}`, isError: true }
    w.stop('stopped by monitor_stop')
    return { result: `Stopped ${e.id}.` }
  })
}
