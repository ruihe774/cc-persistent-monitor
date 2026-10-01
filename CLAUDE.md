# persistent-monitor

A Claude Mod (v2.1.287+) that restores the old `Monitor` behavior removed in 2.1.271 (`persistent` option; watches with no deadline). The built-in `Monitor` now caps every watch at 30 minutes and forces a re-arm turn (anthropics/claude-code#94553). A mod is a plugin directory whose hooks run as JS/TS middleware.

## Layout

- `.claude-plugin/plugin.json`: manifest (name `persistent-monitor` determines tool names)
- `hooks/hooks.json`: `modules` points to `./register.ts`
- `hooks/register.ts`: the whole mod
- `.claude-plugin/types/`: generated per version, authoritative, not hand-edited (see below)
- `tests/`: empty; add `*.test.ts` and run with `claude plugin test`
- `docs/`: downloaded docs (see below)

## Tools (full name is `mcp__persistent-monitor__<name>`)

| Tool | Behavior |
| :- | :- |
| `monitor` | `bash -c <command>`; each stdout line becomes a message to Claude. `persistent: true` = no deadline; else `timeout_ms` (default 300000, no upper cap). No `ws` source (dropped on purpose). |
| `waitpid` | `tail --pid=<pid> -f /dev/null`; one message when the process exits. GNU tail only. |
| `waitfile` | `tail -F -n 0 -- <path>`; a message per appended line, optional JS regex `pattern`, `once`, `from_start`. No deadline by default. |
| `monitor_stop` | Stops a watch by id (`pm-N`); with no id, lists running ones. Needed because built-in `TaskStop` can't see mod-spawned processes. |

All four go through `startWatch` in `register.ts`: spawn via `$.process.spawn`, split stdout into lines, batch 200 ms, deliver with `$.prompt.submit({ text })`, then send a final "ended" message. Stopping calls `stream.return()`, which kills the child (verified, even for a silent child).

## Gotchas

- Tools are registered in `session.start` and served by `tool.call` hooks matched on the full `mcp__persistent-monitor__<name>` name; a call no hook answers fails.
- Validation (`claude plugin validate .`) rejects passing `$` to a helper function. That's why each handler builds a small `io` object (`spawn`, `after`, `submit`) from `$` and hands that to `startWatch`. Keep `$.noun.method(...)` spelled in full at call sites.
- Notifications arrive as mod-sent messages, not tool results. In `-p` runs they land after the turn that started the watch, and the session exits when the turn ends.
- Watches die with the module (reload, session end). Nothing is persisted.
- Names of tools: letters, digits, `_`, `-`, up to 64.

## Verifying changes

1. `claude plugin validate .`
2. End-to-end: `claude -p --plugin-dir . --permission-mode bypassPermissions "<prompt that calls the tools>" < /dev/null`. Use a finite child (e.g. `timeout 40 tail -f /dev/null`) and ask Claude to report notifications verbatim.
3. Regenerate types by loading the mod once (`claude -p hi --plugin-dir .`); read `.claude-plugin/types/claude-code/index.d.ts` for exact signatures (`ToolSpec`, `ProcessSpawnRequest`, `PromptSubmitArgs`).

## Docs (downloaded; consult before changing APIs)

- `docs/mods-reference.md`: events, API methods, limits
- `docs/mods-api.md`: `$.tool.register`, `$.process`, `$.clock`, `$.prompt.submit`
- `docs/mods-events.md`: `tool.call` hooks and middleware semantics
- `docs/mods-create.md`: writing a mod
- `docs/mods-test.md`: testing

Mods change between releases; if docs and types disagree, trust the types. Online index: https://code.claude.com/docs/llms.txt
