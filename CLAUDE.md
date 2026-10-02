# claude-mods

A Claude Code plugin marketplace (`.claude-plugin/marketplace.json`, named `pierre-mods`) holding mods: plugins of function hooks under `plugins/<name>/`.

- Load the `plugin-authoring` skill before writing or debugging a hooks module. The API is early access: the declaration file it points to is the authority, not memory.
- Keep game logic and drawing in pure modules (`game.ts`, `draw.ts`, `sprites.ts`) that never take `$`, and test them directly. `register.tsx` only wires them to events.
- A function that receives `$` must be a top-level declaration in its file; the validator refuses closures inside `register` and names declared twice.
- State a drawing reads goes in `$.state` (declared in `types/index.d.ts`), saves go in `$.store`; module variables reset on every hot reload.
- `.claude-plugin/types/` in each plugin is written by Claude Code when it loads the plugin: never edit or commit it.
- A new plugin goes in `plugins/` and gets an entry in `.claude-plugin/marketplace.json`.
- Run `./scripts/check.sh` before committing.

## Testing notes

- The test kit has no engine underneath: a test answers the engine events the plugin reaches (`session.start`, `command.register`, `ui.toast`, `ui.open`, `session.id`, a fallback `ui.render`), op events as `{ value }`.
- A test registers each event once, and `mock.store` already takes the `store.*` events: to read a store back, answer `store.*` with an in-memory map instead (see `plugins/server-farm/tests/farm.test.tsx`).
- `Text` takes no `key`: find text by content (`ui.find({ type: 'Text', text })`); Buttons and Rasters keep their keys.
- There is no `toBeCloseTo`: round before comparing.
