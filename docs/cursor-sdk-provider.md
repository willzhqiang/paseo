# Adding Cursor SDK Provider to Paseo

> How the `cursor-sdk-agent.ts` provider was added with minimal upstream invasion,
> so you can merge future Paseo releases without conflict.

## Architecture

```
packages/server/src/server/agent/
├── providers/
│   ├── claude-agent.ts          ← Anthropic SDK (4557 lines, deepest)
│   ├── pi-direct-agent.ts       ← Pi SDK (1531 lines)
│   ├── codex-app-server-agent.ts
│   ├── copilot-acp-agent.ts     ← ACP protocol
│   ├── opencode-agent.ts
│   └── cursor-sdk-agent.ts      ← NEW: @cursor/sdk (1026 lines)
├── provider-manifest.ts         ← +9 lines (provider definition)
├── provider-registry.ts         ← +10 lines (client factory)
└── agent-sdk-types.ts           ← unchanged
```

## Files Changed

| File | Change | Lines |
|------|--------|-------|
| `providers/cursor-sdk-agent.ts` | **NEW** | 1026 |
| `provider-manifest.ts` | Add `cursor` definition | +9 |
| `provider-registry.ts` | Import + factory | +10 |
| `package.json` | Add `@cursor/sdk` dep | +1 |

**Total upstream invasion: ~20 lines**, all marked with `/* [cursor-sdk-provider] */` comments.

## Merge Strategy

After pulling upstream updates:

```bash
git fetch origin
git rebase origin/main

# If conflicts in provider-manifest.ts or provider-registry.ts:
# Search for [cursor-sdk-provider] markers and re-apply the ~20 lines
git grep '[cursor-sdk-provider]'
```

## Implementation Pattern

Follows the same pattern as `pi-direct-agent.ts`:

```typescript
// Two classes implement two interfaces:
CursorSdkAgentClient  → AgentClient   (factory)
CursorSdkAgentSession → AgentSession  (per-session state)
```

### Key Design Decisions

1. **SDK imported as library** (like Pi), not spawned as subprocess (like Codex)
2. **`run.stream()` for real-time events**, `run.wait()` for authoritative completion
3. **`onDelta` callback captures token usage** from `TurnEndedUpdate`
4. **`run.cancel()` for interrupt** — SDK confirms support for local and cloud runs
5. **`run.conversation()` for history replay** — uses fully typed `ToolCall` union
6. **Sticky model override** — per SDK docs, `send({ model })` updates `agent.model`
7. **`settingSources: ['project', 'user']`** — loads `.cursor/hooks.json` and `~/.cursor/mcp.json`

### Event Mapping

```
Cursor SDKMessage          → Paseo AgentStreamEvent
─────────────────────────────────────────────────────
system (subtype=init)      → thread_started
assistant                  → timeline/assistant_message
thinking                   → timeline/reasoning
tool_call (running)        → timeline/tool_call (status=running)
tool_call (completed)      → timeline/tool_call (status=completed)
tool_call (error)          → timeline/tool_call (status=failed)
task                       → timeline/assistant_message
status (FINISHED)          → (handled by run.wait())
status (ERROR)             → turn_failed
status (CANCELLED)         → turn_canceled
```

### Tool Detail Mapping (Stream vs History)

**During streaming** (`SDKToolUseMessage`):
- SDK warns: "Tool call schema is not stable. Treat args and result as unknown."
- We do best-effort name-based mapping (shell/read/edit/write/search/unknown)

**During history replay** (`run.conversation()` → `ConversationTurn`):
- SDK provides **fully typed** `ToolCall` discriminated union
- `mapCursorConversationToolCall()` uses proper type narrowing
- Covers: shell, read, edit, write, grep, glob, ls, mcp, semSearch, delete, task

## Known Limitations (SDK constraints, not our bugs)

| Feature | Status | Why |
|---------|--------|-----|
| Permission requests | ❌ | Cursor handles via `.cursor/hooks.json`, no SDK API |
| Mode switching | ❌ | Not exposed in SDK |
| Context window usage | ❌ | SDK only reports token counts, not window size |
| Compaction events | ❌ | No equivalent concept in Cursor |
| Real-time usage_updated | ❌ | Only at turn end via `TurnEndedUpdate` |
| `setModel()` mid-session | ⚠️ | Sticky override via `send({ model })`, not true runtime switch |
| `features` (AgentFeature[]) | ❌ | Not exposed |

## Testing

```bash
# Build
cd ~/projects/paseo
npm run build --workspace=packages/server

# Verify no regressions
npm run build --workspace=packages/server 2>&1 | grep error

# Manual test (requires CURSOR_API_KEY)
export CURSOR_API_KEY="crsr_..."
paseo run --provider cursor "Hello from Paseo"
```

## Future Improvements

- [ ] Use `onDelta` `ToolCallStartedUpdate`/`ToolCallCompletedUpdate` for richer real-time tool detail
- [ ] Map `SDKRequestMessage` (type=request) to Paseo permission requests if Cursor exposes approval flow
- [ ] Support `cloud` runtime (pass `cloud: { repos: [...] }` instead of `local`)
- [ ] Map `updateTodos` tool call to Paseo `todo` timeline item
- [ ] Subagent support via `agents: { ... }` option
