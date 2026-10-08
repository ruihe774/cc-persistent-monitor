# persistent-monitor

> **Disclaimer: we do not recommend using this plugin.** It is a third-party implementation, and it bypasses the built-in safety measures that Claude Code applies to `Bash` and `Monitor`. The `monitor` and `waitpid` tools run shell commands and stream their output to Claude without those checks, and watches have no deadline. Install and use it only if you understand and accept these risks.

A Claude Code mod (requires v2.1.287+) that brings back watches with no deadline.

Since 2.1.271 the built-in `Monitor` tool caps every watch at 30 minutes and forces Claude to re-arm it ([anthropics/claude-code#94553](https://github.com/anthropics/claude-code/issues/94553)). This mod adds tools that watch for as long as you need.

## Install

Clone the repo, then add it as a local marketplace and install the plugin:

```sh
git clone <repo-url> ~/persistent-monitor
claude plugin marketplace add ~/persistent-monitor
claude plugin install persistent-monitor@persistent-monitor
```

Restart Claude Code (or run `/reload-plugins`) to load it. To update after pulling changes, run `claude plugin marketplace update persistent-monitor`.

To try it for a single session without installing, use `claude --plugin-dir ~/persistent-monitor`.

## Tools

Claude sees them as `mcp__persistent-monitor__<name>`.

| Tool | What it does |
| :- | :- |
| `monitor` | Runs a shell command; each line of output is sent to Claude as a message. Set `persistent: true` for no deadline, or `timeout_ms` (default 5 minutes, no upper cap). |
| `waitpid` | Notifies Claude once when a process exits. Needs GNU `tail`. |
| `waitfile` | Follows a file and sends each appended line. Optional regex `pattern`, `once`, and `from_start`. No deadline by default. |
| `monitor_stop` | Stops a watch by id (e.g. `pm-3`). With no id, lists running watches. |

Example prompts:

- "Use the persistent-monitor `monitor` tool to watch `npm run dev` and tell me when it logs an error."
- "Use the persistent-monitor `waitpid` tool to wait for PID 4242 to exit, then run the tests."
- "Use the persistent-monitor `waitfile` tool to follow `build.log` and let me know when a line matches `FAILED`."

## Notes

- Use `monitor_stop` to cancel watches. The built-in `TaskStop` can't see them.
- Watches end when the session ends or the mod reloads. Nothing is saved across sessions.
- There is no WebSocket source.
- In non-interactive `-p` runs, notifications arrive after the starting turn, and the session exits when that turn ends.
