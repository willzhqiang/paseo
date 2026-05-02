/**
 * Cursor SDK provider for Paseo.
 *
 * Uses the official @cursor/sdk (local runtime) to give Paseo first-class
 * Cursor Agent support — the same depth as the Claude and Pi providers.
 *
 * Architecture mirrors pi-direct-agent.ts:
 *   CursorSdkAgentClient  implements AgentClient   (factory / lifecycle)
 *   CursorSdkAgentSession implements AgentSession  (per-session state machine)
 *
 * Upstream merge strategy: this file is self-contained and only touches
 * three upstream files (provider-manifest.ts, provider-registry.ts,
 * package.json). All changes there are clearly marked with
 * "// [cursor-sdk-provider]" so they are easy to identify and re-apply
 * after an upstream rebase.
 *
 * Reference: https://cursor.com/docs/sdk/typescript
 * Example:   https://github.com/cursor/cookbook/tree/main/sdk/coding-agent-cli
 */

import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { Agent, Cursor } from "@cursor/sdk";
import type {
  SDKAgent,
  SDKMessage,
  SDKToolUseMessage,
  SDKAssistantMessage,
  SDKThinkingMessage,
  SDKStatusMessage,
  SDKTaskMessage,
  Run,
  TurnEndedUpdate,
} from "@cursor/sdk";

import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentLaunchContext,
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentSlashCommand,
  AgentStreamEvent,
  AgentTimelineItem,
  AgentUsage,
  ListModelsOptions,
  ListPersistedAgentsOptions,
  PersistedAgentDescriptor,
  ToolCallDetail,
} from "../agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../provider-launch-config.js";
import { renderPromptAttachmentAsText } from "../prompt-attachments.js";
import {
  formatDiagnosticStatus,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  toDiagnosticErrorMessage,
} from "./diagnostic-utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CURSOR_PROVIDER = "cursor";

const CURSOR_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function convertPromptToText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  return prompt
    .map((block) => {
      if (block.type === "text") return block.text;
      return renderPromptAttachmentAsText(
        block as Parameters<typeof renderPromptAttachmentAsText>[0],
      );
    })
    .join("\n\n");
}

/**
 * Map a Cursor SDK SDKToolUseMessage to a Paseo ToolCallDetail.
 *
 * Per the SDK docs: "Tool call schema is not stable. Treat args and result
 * as unknown and parse defensively. The event envelope (type, call_id, name,
 * status) is stable."
 *
 * We do a best-effort mapping based on common tool names observed in practice,
 * with a safe fallback to the "unknown" detail type.
 */
function mapCursorToolDetail(msg: SDKToolUseMessage): ToolCallDetail {
  const name = msg.name.toLowerCase();
  const args = msg.args as Record<string, unknown> | null | undefined;
  const result = msg.result as Record<string, unknown> | string | null | undefined;

  const resultText =
    typeof result === "string"
      ? result
      : result && typeof result === "object"
        ? ((result["output"] as string | undefined) ??
          (result["text"] as string | undefined) ??
          (result["stdout"] as string | undefined))
        : undefined;

  const exitCode =
    result && typeof result === "object"
      ? ((result["exitCode"] as number | null | undefined) ??
        (result["exit_code"] as number | null | undefined))
      : undefined;

  // Shell / terminal commands
  if (
    name === "run_terminal_cmd" ||
    name === "terminal" ||
    name === "shell" ||
    name === "bash" ||
    name.includes("command")
  ) {
    return {
      type: "shell",
      command:
        (args?.["command"] as string | undefined) ??
        (args?.["cmd"] as string | undefined) ??
        name,
      output: resultText,
      exitCode,
    };
  }

  // File reads
  if (name === "read_file" || name === "read") {
    return {
      type: "read",
      filePath:
        (args?.["target_file"] as string | undefined) ??
        (args?.["path"] as string | undefined) ??
        (args?.["filePath"] as string | undefined) ??
        "",
      content: resultText,
      offset: args?.["offset"] as number | undefined,
      limit: args?.["limit"] as number | undefined,
    };
  }

  // File edits
  if (
    name === "edit_file" ||
    name === "edit" ||
    name === "apply_edit" ||
    name.includes("edit")
  ) {
    return {
      type: "edit",
      filePath:
        (args?.["target_file"] as string | undefined) ??
        (args?.["path"] as string | undefined) ??
        "",
      newString:
        (args?.["code_edit"] as string | undefined) ??
        (args?.["new_string"] as string | undefined) ??
        (args?.["newString"] as string | undefined),
      oldString:
        (args?.["old_string"] as string | undefined) ??
        (args?.["oldString"] as string | undefined),
    };
  }

  // File writes
  if (name === "write_file" || name === "write") {
    return {
      type: "write",
      filePath: (args?.["path"] as string | undefined) ?? "",
      content: args?.["content"] as string | undefined,
    };
  }

  // Search / grep / glob
  if (
    name === "grep_search" ||
    name === "codebase_search" ||
    name === "file_search" ||
    name === "search" ||
    name.includes("grep") ||
    name.includes("search") ||
    name.includes("glob")
  ) {
    return {
      type: "search",
      query:
        (args?.["query"] as string | undefined) ??
        (args?.["pattern"] as string | undefined) ??
        name,
      content: resultText,
    };
  }

  // Fallback — SDK docs say tool schema is not stable, so this is expected
  return {
    type: "unknown",
    input: args ?? null,
    output: result ?? null,
  };
}

/**
 * Extract AgentUsage from a TurnEndedUpdate's usage field.
 * The onDelta callback receives this with full token counts.
 */
function mapTurnUsage(usage: TurnEndedUpdate["usage"]): AgentUsage | undefined {
  if (!usage) return undefined;
  const { inputTokens, outputTokens, cacheReadTokens } = usage;
  if (!inputTokens && !outputTokens) return undefined;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: cacheReadTokens,
    // cacheWriteTokens has no direct Paseo field; store in metadata if needed
  };
}

/**
 * Map a structured ToolCall from run.conversation() to a Paseo ToolCallDetail.
 *
 * Unlike SDKToolUseMessage (which has unknown args/result), ConversationTurn's
 * ToolCall is a fully typed discriminated union with known arg and result shapes.
 * This gives us much richer detail than the stream-time mapping.
 */
function mapCursorConversationToolCall(
  tc: { type: string; args?: unknown; result?: { status: string; value?: unknown; error?: unknown } },
): ToolCallDetail {
  const args = tc.args as Record<string, unknown> | undefined;
  const resultValue = tc.result?.status === "success"
    ? (tc.result as { value?: unknown }).value as Record<string, unknown> | undefined
    : undefined;

  switch (tc.type) {
    case "shell": {
      const shellArgs = args as { command?: string; workingDirectory?: string } | undefined;
      const shellResult = resultValue as { stdout?: string; stderr?: string; exitCode?: number; signal?: string } | undefined;
      return {
        type: "shell",
        command: shellArgs?.command ?? "shell",
        cwd: shellArgs?.workingDirectory,
        output: shellResult?.stdout,
        exitCode: shellResult?.exitCode ?? null,
      };
    }
    case "read": {
      const readArgs = args as { path?: string } | undefined;
      const readResult = resultValue as { content?: string } | undefined;
      return {
        type: "read",
        filePath: readArgs?.path ?? "",
        content: readResult?.content,
      };
    }
    case "edit": {
      const editArgs = args as { path?: string } | undefined;
      const editResult = resultValue as { diffString?: string; linesAdded?: number; linesRemoved?: number } | undefined;
      return {
        type: "edit",
        filePath: editArgs?.path ?? "",
        unifiedDiff: editResult?.diffString,
      };
    }
    case "write": {
      const writeArgs = args as { path?: string; fileText?: string } | undefined;
      return {
        type: "write",
        filePath: writeArgs?.path ?? "",
        content: writeArgs?.fileText,
      };
    }
    case "grep": {
      const grepArgs = args as { pattern?: string; path?: string } | undefined;
      return {
        type: "search",
        query: grepArgs?.pattern ?? "grep",
        toolName: "grep",
      };
    }
    case "glob": {
      const globArgs = args as { globPattern?: string; targetDirectory?: string } | undefined;
      return {
        type: "search",
        query: globArgs?.globPattern ?? "glob",
        toolName: "glob",
      };
    }
    case "semSearch": {
      const semArgs = args as { query?: string } | undefined;
      return {
        type: "search",
        query: semArgs?.query ?? "semSearch",
      };
    }
    case "ls": {
      const lsArgs = args as { path?: string } | undefined;
      return {
        type: "search",
        query: lsArgs?.path ?? "ls",
      };
    }
    case "mcp": {
      const mcpArgs = args as { toolName?: string; providerIdentifier?: string; args?: unknown } | undefined;
      return {
        type: "plain_text",
        label: `MCP: ${mcpArgs?.providerIdentifier ?? ""}/${mcpArgs?.toolName ?? ""}`.replace(/^\//, ""),
        text: JSON.stringify(mcpArgs?.args ?? {}),
      };
    }
    default:
      return {
        type: "unknown",
        input: args ?? null,
        output: resultValue ?? null,
      };
  }
}

// ---------------------------------------------------------------------------
// CursorSdkAgentSession
// ---------------------------------------------------------------------------

interface CursorPersistenceMetadata {
  cwd?: string;
  agentId?: string;
}

export class CursorSdkAgentSession implements AgentSession {
  readonly provider = CURSOR_PROVIDER;
  readonly capabilities = CURSOR_CAPABILITIES;

  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private activeTurnId: string | null = null;
  private currentRun: Run | null = null;
  private latestUsage: AgentUsage | undefined;
  private latestModel: string | undefined;

  constructor(
    private readonly sdkAgent: SDKAgent,
    private readonly config: AgentSessionConfig,
    private readonly logger: Logger,
  ) {}

  get id(): string | null {
    return this.sdkAgent.agentId ?? null;
  }

  private emit(event: AgentStreamEvent): void {
    for (const sub of this.subscribers) {
      sub(event);
    }
  }

  private currentTurnId(): string | undefined {
    return this.activeTurnId ?? undefined;
  }

  /**
   * Translate a single Cursor SDK SDKMessage into Paseo AgentStreamEvents.
   * Based on the official cookbook's emitSdkMessage pattern.
   */
  private handleSdkMessage(msg: SDKMessage): void {
    const turnId = this.currentTurnId();

    switch (msg.type) {
      case "system": {
        // system/init — thread started
        this.emit({
          type: "thread_started",
          provider: CURSOR_PROVIDER,
          sessionId: this.sdkAgent.agentId,
        });
        if (msg.model) {
          this.latestModel = msg.model.id;
        }
        return;
      }

      case "assistant": {
        const assistantMsg = msg as SDKAssistantMessage;
        for (const block of assistantMsg.message.content) {
          if (block.type === "text" && block.text) {
            this.emit({
              type: "timeline",
              provider: CURSOR_PROVIDER,
              turnId,
              item: { type: "assistant_message", text: block.text },
            });
          }
          // ToolUseBlock inside assistant messages are also reported via
          // dedicated tool_call messages — skip to avoid duplication.
        }
        return;
      }

      case "thinking": {
        const thinkingMsg = msg as SDKThinkingMessage;
        if (thinkingMsg.text) {
          this.emit({
            type: "timeline",
            provider: CURSOR_PROVIDER,
            turnId,
            item: { type: "reasoning", text: thinkingMsg.text },
          });
        }
        return;
      }

      case "tool_call": {
        const toolMsg = msg as SDKToolUseMessage;
        const detail = mapCursorToolDetail(toolMsg);
        const baseItem = {
          type: "tool_call" as const,
          callId: toolMsg.call_id,
          name: toolMsg.name,
          detail,
        };
        const item =
          toolMsg.status === "error"
            ? {
                ...baseItem,
                status: "failed" as const,
                error: String(toolMsg.result ?? "Tool call failed"),
              }
            : toolMsg.status === "running"
              ? { ...baseItem, status: "running" as const, error: null }
              : { ...baseItem, status: "completed" as const, error: null };

        this.emit({ type: "timeline", provider: CURSOR_PROVIDER, turnId, item });
        return;
      }

      case "task": {
        const taskMsg = msg as SDKTaskMessage;
        if (taskMsg.text) {
          this.emit({
            type: "timeline",
            provider: CURSOR_PROVIDER,
            turnId,
            item: { type: "assistant_message", text: taskMsg.text },
          });
        }
        return;
      }

      case "status": {
        // status messages signal cloud lifecycle transitions.
        // For local runs, the stream ends naturally — we rely on run.wait()
        // rather than status messages to detect completion.
        const statusMsg = msg as SDKStatusMessage;
        if (statusMsg.status === "ERROR") {
          const failedTurnId = this.activeTurnId ?? turnId;
          this.activeTurnId = null;
          this.emit({
            type: "turn_failed",
            provider: CURSOR_PROVIDER,
            turnId: failedTurnId,
            error: statusMsg.message ?? "Cursor agent error",
          });
        } else if (statusMsg.status === "CANCELLED") {
          const cancelledTurnId = this.activeTurnId ?? turnId;
          this.activeTurnId = null;
          this.emit({
            type: "turn_canceled",
            provider: CURSOR_PROVIDER,
            turnId: cancelledTurnId,
            reason: statusMsg.message ?? "Cancelled",
          });
        }
        return;
      }

      default:
        return;
    }
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    const timeline: AgentTimelineItem[] = [];
    let finalText = "";
    let turnId: string | null = null;
    const buffered: AgentStreamEvent[] = [];
    let settled = false;
    let resolve!: () => void;
    let reject!: (e: Error) => void;

    const completion = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const processEvent = (event: AgentStreamEvent): void => {
      if (settled) return;
      if (event.type === "timeline") {
        timeline.push(event.item);
        if (event.item.type === "assistant_message") finalText += event.item.text;
        return;
      }
      if (event.type === "turn_completed") {
        settled = true;
        resolve();
        return;
      }
      if (event.type === "turn_failed") {
        settled = true;
        reject(new Error(event.error));
      }
    };

    const unsub = this.subscribe((event) => {
      if (!turnId) {
        buffered.push(event);
        return;
      }
      processEvent(event);
    });

    try {
      const result = await this.startTurn(prompt, options);
      turnId = result.turnId;
      for (const e of buffered) processEvent(e);
      if (!settled) await completion;
    } finally {
      unsub();
    }

    return {
      sessionId: this.sdkAgent.agentId,
      finalText,
      usage: this.latestUsage,
      timeline,
    };
  }

  async startTurn(
    prompt: AgentPromptInput,
    _options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    if (this.activeTurnId) {
      throw new Error("A Cursor turn is already active");
    }

    const text = convertPromptToText(prompt);
    const turnId = randomUUID();
    this.activeTurnId = turnId;

    this.emit({ type: "turn_started", provider: CURSOR_PROVIDER, turnId });

    void (async () => {
      try {
        const run = await this.sdkAgent.send(text, {
          // Use onDelta to capture token usage from TurnEndedUpdate
          onDelta: ({ update }) => {
            if (update.type === "turn-ended") {
              const usage = mapTurnUsage((update as TurnEndedUpdate).usage);
              if (usage) this.latestUsage = usage;
            }
          },
        });

        this.currentRun = run;

        for await (const msg of run.stream()) {
          this.handleSdkMessage(msg);
        }

        // Use run.wait() to get the authoritative final status, duration, and model.
        // Per the cookbook: usage is a runtime field not in the type definition,
        // accessed via (result as { usage?: { inputTokens?: number; outputTokens?: number } }).
        const result = await run.wait();
        const runUsage = (result as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;
        if (runUsage?.inputTokens || runUsage?.outputTokens) {
          // Prefer run.wait() usage over onDelta usage if available
          this.latestUsage = {
            inputTokens: runUsage.inputTokens,
            outputTokens: runUsage.outputTokens,
          };
        }

        if (this.activeTurnId === turnId) {
          this.activeTurnId = null;
        }
        this.currentRun = null;

        if (result.status === "error") {
          this.emit({
            type: "turn_failed",
            provider: CURSOR_PROVIDER,
            turnId,
            error: "Run finished with error status",
          });
        } else if (result.status === "cancelled") {
          this.emit({
            type: "turn_canceled",
            provider: CURSOR_PROVIDER,
            turnId,
            reason: "Run was cancelled",
          });
        } else {
          // "finished"
          if (result.model) this.latestModel = result.model.id;
          this.emit({
            type: "turn_completed",
            provider: CURSOR_PROVIDER,
            turnId,
            usage: this.latestUsage,
          });
        }
      } catch (error) {
        const failedTurnId = this.activeTurnId ?? turnId;
        this.activeTurnId = null;
        this.currentRun = null;
        this.emit({
          type: "turn_failed",
          provider: CURSOR_PROVIDER,
          turnId: failedTurnId,
          error: toDiagnosticErrorMessage(error),
        });
      }
    })();

    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  /**
   * Replay history using run.conversation() on the most recent run.
   * The SDK returns structured ConversationTurn[] with steps.
   */
  /**
   * Replay history using run.conversation() on the most recent run.
   *
   * The SDK's ConversationTurn has a fully typed ToolCall discriminated union
   * (shell / write / read / edit / grep / glob / ls / mcp / semSearch / task / ...).
   * We map each variant to the appropriate Paseo ToolCallDetail.
   */
  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    try {
      const { items } = await Agent.listRuns(this.sdkAgent.agentId, {
        runtime: "local",
        cwd: this.config.cwd,
        limit: 1,
      });

      if (items.length === 0) return;

      const turns = await items[0].conversation();

      for (const turn of turns) {
        if (turn.type === "agentConversationTurn") {
          const { userMessage, steps } = turn.turn;

          if (userMessage?.text) {
            yield {
              type: "timeline",
              provider: CURSOR_PROVIDER,
              item: { type: "user_message", text: userMessage.text },
            };
          }

          for (const step of steps) {
            if (step.type === "assistantMessage") {
              yield {
                type: "timeline",
                provider: CURSOR_PROVIDER,
                item: { type: "assistant_message", text: step.message.text },
              };
            } else if (step.type === "thinkingMessage") {
              yield {
                type: "timeline",
                provider: CURSOR_PROVIDER,
                item: { type: "reasoning", text: step.message.text },
              };
            } else if (step.type === "toolCall") {
              // step.message is a fully typed ToolCall discriminated union.
              // Map each variant to the appropriate Paseo ToolCallDetail.
              const tc = step.message;
              const detail = mapCursorConversationToolCall(tc);
              const isFailed = tc.result?.status === "error";
              const baseItem = {
                type: "tool_call" as const,
                callId: randomUUID(),
                name: tc.type,
                detail,
              };
              const item = isFailed
                ? { ...baseItem, status: "failed" as const, error: String((tc.result as { error?: unknown } | undefined)?.error ?? "Tool call failed") }
                : { ...baseItem, status: "completed" as const, error: null };
              yield {
                type: "timeline",
                provider: CURSOR_PROVIDER,
                item,
              };
            }
          }
        } else if (turn.type === "shellConversationTurn") {
          const { shellCommand, shellOutput } = turn.turn;
          if (shellCommand) {
            yield {
              type: "timeline",
              provider: CURSOR_PROVIDER,
              item: {
                type: "tool_call",
                callId: randomUUID(),
                name: "shell",
                status: shellOutput ? "completed" : "running",
                detail: {
                  type: "shell",
                  command: shellCommand.command,
                  output: shellOutput?.stdout,
                  exitCode: shellOutput?.exitCode ?? null,
                },
                error: null,
              },
            };
          }
        }
      }
    } catch (error) {
      this.logger.debug({ err: error }, "Cursor streamHistory failed");
    }
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return {
      provider: CURSOR_PROVIDER,
      sessionId: this.sdkAgent.agentId ?? null,
      model:
        this.sdkAgent.model?.id ??
        this.latestModel ??
        this.config.model ??
        null,
      modeId: null,
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [];
  }

  async getCurrentMode(): Promise<string | null> {
    return null;
  }

  async setMode(_modeId: string): Promise<void> {
    throw new Error("Cursor SDK provider does not expose selectable modes");
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }

  async respondToPermission(
    _requestId: string,
    _response: AgentPermissionResponse,
  ): Promise<void> {
    // Cursor handles tool approvals internally via hooks (.cursor/hooks.json).
    // There is no external permission API in the SDK.
  }

  describePersistence(): AgentPersistenceHandle | null {
    return {
      provider: CURSOR_PROVIDER,
      sessionId: this.sdkAgent.agentId,
      nativeHandle: this.sdkAgent.agentId,
      metadata: {
        cwd: this.config.cwd,
        agentId: this.sdkAgent.agentId,
      } satisfies CursorPersistenceMetadata,
    };
  }

  /**
   * Cancel the active run using run.cancel().
   * The SDK docs confirm: "Cancel is supported on running local and cloud runs."
   */
  async interrupt(): Promise<void> {
    const run = this.currentRun;
    if (!run) {
      this.logger.debug("Cursor interrupt(): no active run");
      return;
    }
    if (!run.supports("cancel")) {
      this.logger.warn(
        `Cursor interrupt(): cancel not supported — ${run.unsupportedReason("cancel") ?? "unknown reason"}`,
      );
      return;
    }
    await run.cancel();
  }

  async close(): Promise<void> {
    await this.sdkAgent[Symbol.asyncDispose]();
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    return [];
  }

  /**
   * Switch model for the next send() call.
   * Per SDK docs: model override on agent.send() is sticky — it updates
   * agent.model for subsequent sends. We store it in config for getRuntimeInfo().
   */
  async setModel(modelId: string | null): Promise<void> {
    if (modelId) {
      this.config.model = modelId;
      this.latestModel = modelId;
    }
  }
}

// ---------------------------------------------------------------------------
// CursorSdkAgentClient
// ---------------------------------------------------------------------------

interface CursorSdkAgentClientOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
}

export class CursorSdkAgentClient implements AgentClient {
  readonly provider = CURSOR_PROVIDER;
  readonly capabilities = CURSOR_CAPABILITIES;

  private readonly logger: Logger;

  constructor(options: CursorSdkAgentClientOptions) {
    this.logger = options.logger;
  }

  async createSession(
    config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const sdkAgent = await Agent.create({
      ...(config.model ? { model: { id: config.model } } : {}),
      local: {
        cwd: config.cwd,
        // Load project hooks (.cursor/hooks.json) and user MCP config
        settingSources: ["project", "user"],
      },
      ...(config.mcpServers ? { mcpServers: config.mcpServers } : {}),
    });

    return new CursorSdkAgentSession(sdkAgent, config, this.logger);
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const agentId = handle.nativeHandle ?? handle.sessionId;
    if (!agentId) {
      throw new Error("Cursor resume requires an agentId in the persistence handle");
    }

    const cwd =
      overrides?.cwd ??
      (handle.metadata as CursorPersistenceMetadata | undefined)?.cwd ??
      process.cwd();

    const mergedConfig: AgentSessionConfig = {
      provider: CURSOR_PROVIDER,
      cwd,
      ...overrides,
    };

    // Agent.resume() auto-detects runtime from ID prefix (bc- = cloud, else local)
    const sdkAgent = await Agent.resume(agentId, {
      ...(mergedConfig.model ? { model: { id: mergedConfig.model } } : {}),
      local: { cwd, settingSources: ["project", "user"] },
      ...(mergedConfig.mcpServers ? { mcpServers: mergedConfig.mcpServers } : {}),
    });

    return new CursorSdkAgentSession(sdkAgent, mergedConfig, this.logger);
  }

  async listModels(_options: ListModelsOptions): Promise<AgentModelDefinition[]> {
    try {
      const models = await Cursor.models.list();
      const result: AgentModelDefinition[] = [];

      for (const m of models) {
        // If the model has variants (e.g. composer-2 with thinking=low/high),
        // expose each variant as a separate selectable model — same pattern
        // as the official cookbook's modelToChoices().
        if (m.variants && m.variants.length > 0) {
          for (const variant of m.variants) {
            result.push({
              provider: CURSOR_PROVIDER,
              id: JSON.stringify({ id: m.id, params: variant.params }),
              label: `${m.displayName ?? m.id} — ${variant.displayName}`,
              description: variant.description ?? m.description,
              isDefault: variant.isDefault ?? m.id === "composer-2",
            });
          }
        } else {
          result.push({
            provider: CURSOR_PROVIDER,
            id: m.id,
            label: m.displayName ?? m.id,
            description: m.description,
            isDefault: m.id === "composer-2",
          });
        }
      }

      return result;
    } catch (error) {
      this.logger.debug({ err: error }, "Cursor listModels failed, returning empty list");
      return [];
    }
  }

  /**
   * List persisted local agents using Agent.list().
   * This gives Paseo the ability to show previously created Cursor agents.
   */
  async listPersistedAgents(
    options?: ListPersistedAgentsOptions,
  ): Promise<PersistedAgentDescriptor[]> {
    try {
      const { items } = await Agent.list({
        runtime: "local",
        cwd: process.cwd(),
        limit: options?.limit ?? 20,
      });

      return items.map((info) => ({
        provider: CURSOR_PROVIDER,
        sessionId: info.agentId,
        cwd: (info as { cwd?: string }).cwd ?? process.cwd(),
        title: info.name ?? info.summary ?? null,
        lastActivityAt: new Date(info.lastModified),
        persistence: {
          provider: CURSOR_PROVIDER,
          sessionId: info.agentId,
          nativeHandle: info.agentId,
          metadata: {
            agentId: info.agentId,
            cwd: (info as { cwd?: string }).cwd,
          } satisfies CursorPersistenceMetadata,
        },
        timeline: [],
      }));
    } catch (error) {
      this.logger.debug({ err: error }, "Cursor listPersistedAgents failed");
      return [];
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await Cursor.models.list();
      return true;
    } catch {
      return false;
    }
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const available = await this.isAvailable();
      let modelsValue = "Not checked";
      let userValue = "Not checked";
      const status = formatDiagnosticStatus(available);

      if (available) {
        try {
          const models = await this.listModels({ cwd: homedir(), force: false });
          modelsValue = String(models.length);
        } catch (error) {
          modelsValue = `Error — ${toDiagnosticErrorMessage(error)}`;
        }
        try {
          const user = await Cursor.me();
          userValue = user.userEmail ?? user.apiKeyName;
        } catch {
          userValue = "Not available";
        }
      }

      return {
        diagnostic: formatProviderDiagnostic("Cursor", [
          { label: "SDK", value: "@cursor/sdk" },
          { label: "Auth", value: userValue },
          { label: "Models", value: modelsValue },
          { label: "Status", value: status },
        ]),
      };
    } catch (error) {
      this.logger.debug({ err: error }, "Cursor diagnostic lookup failed");
      return { diagnostic: formatProviderDiagnosticError("Cursor", error) };
    }
  }
}
