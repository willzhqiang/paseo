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
 * agent-sdk-types.ts). All changes there are clearly marked with
 * "// [cursor-sdk-provider]" so they are easy to identify and re-apply
 * after an upstream rebase.
 */

import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { Agent } from "@cursor/sdk";
import type {
  SDKAgent,
  SDKMessage,
  SDKToolUseMessage,
  SDKAssistantMessage,
  SDKThinkingMessage,
  SDKStatusMessage,
  SDKTaskMessage,
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
  ListModelsOptions,
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
      return renderPromptAttachmentAsText(block as Parameters<typeof renderPromptAttachmentAsText>[0]);
    })
    .join("\n\n");
}

/**
 * Map a Cursor SDK SDKToolUseMessage to a Paseo ToolCallDetail.
 * Cursor reports shell commands, file edits, reads, etc. through the
 * generic tool_call message — we do a best-effort mapping.
 */
function mapCursorToolDetail(msg: SDKToolUseMessage): ToolCallDetail {
  const name = msg.name.toLowerCase();
  const args = msg.args as Record<string, unknown> | null | undefined;
  const result = msg.result as Record<string, unknown> | string | null | undefined;

  const resultText =
    typeof result === "string"
      ? result
      : result && typeof result === "object"
        ? (result["output"] as string | undefined) ??
          (result["text"] as string | undefined) ??
          JSON.stringify(result)
        : undefined;

  // Shell / terminal commands
  if (name === "run_terminal_cmd" || name === "terminal" || name === "shell" || name === "bash") {
    return {
      type: "shell",
      command: (args?.["command"] as string | undefined) ?? name,
      output: resultText,
      exitCode: (result as Record<string, unknown> | undefined)?.["exitCode"] as
        | number
        | null
        | undefined,
    };
  }

  // File reads
  if (name === "read_file" || name === "read") {
    return {
      type: "read",
      filePath: (args?.["target_file"] as string | undefined) ?? (args?.["path"] as string | undefined) ?? "",
      content: resultText,
    };
  }

  // File edits
  if (name === "edit_file" || name === "edit" || name === "apply_edit") {
    return {
      type: "edit",
      filePath: (args?.["target_file"] as string | undefined) ?? (args?.["path"] as string | undefined) ?? "",
      newString: (args?.["code_edit"] as string | undefined) ?? (args?.["new_string"] as string | undefined),
    };
  }

  // File writes
  if (name === "write_file" || name === "write") {
    return {
      type: "write",
      filePath: (args?.["path"] as string | undefined) ?? "",
      content: (args?.["content"] as string | undefined),
    };
  }

  // Search / grep
  if (name === "grep_search" || name === "codebase_search" || name === "file_search" || name === "search") {
    return {
      type: "search",
      query: (args?.["query"] as string | undefined) ?? (args?.["pattern"] as string | undefined) ?? name,
      content: resultText,
    };
  }

  // Fallback
  return {
    type: "unknown",
    input: args ?? null,
    output: result ?? null,
  };
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
   * Translate a single Cursor SDK SDKMessage into zero or more Paseo
   * AgentStreamEvents and emit them.
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
          // tool_use blocks inside assistant messages are handled via
          // dedicated tool_call messages — skip here to avoid duplication.
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
            ? { ...baseItem, status: "failed" as const, error: String(toolMsg.result ?? "Tool call failed") }
            : toolMsg.status === "running"
              ? { ...baseItem, status: "running" as const, error: null }
              : { ...baseItem, status: "completed" as const, error: null };
        this.emit({
          type: "timeline",
          provider: CURSOR_PROVIDER,
          turnId,
          item,
        });
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
        const statusMsg = msg as SDKStatusMessage;
        const completedTurnId = this.activeTurnId ?? turnId;

        if (statusMsg.status === "FINISHED") {
          this.activeTurnId = null;
          this.emit({
            type: "turn_completed",
            provider: CURSOR_PROVIDER,
            turnId: completedTurnId,
          });
        } else if (statusMsg.status === "ERROR") {
          this.activeTurnId = null;
          this.emit({
            type: "turn_failed",
            provider: CURSOR_PROVIDER,
            turnId: completedTurnId,
            error: statusMsg.message ?? "Cursor agent error",
          });
        } else if (statusMsg.status === "CANCELLED") {
          this.activeTurnId = null;
          this.emit({
            type: "turn_canceled",
            provider: CURSOR_PROVIDER,
            turnId: completedTurnId,
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
      usage: undefined, // Cursor SDK does not expose token counts yet
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
        const run = await this.sdkAgent.send(text);
        for await (const msg of run.stream()) {
          this.handleSdkMessage(msg);
        }
        // If stream ends without a status=FINISHED message, emit completion
        if (this.activeTurnId === turnId) {
          this.activeTurnId = null;
          this.emit({ type: "turn_completed", provider: CURSOR_PROVIDER, turnId });
        }
      } catch (error) {
        const failedTurnId = this.activeTurnId ?? turnId;
        this.activeTurnId = null;
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

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    // Cursor SDK does not expose a history replay API yet.
    // Return empty — the UI will show an empty timeline on resume.
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return {
      provider: CURSOR_PROVIDER,
      sessionId: this.sdkAgent.agentId ?? null,
      model: this.sdkAgent.model?.id ?? this.latestModel ?? this.config.model ?? null,
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
    // Cursor handles tool approvals internally; no external permission API yet.
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

  async interrupt(): Promise<void> {
    // Cursor SDK does not expose a cancel-in-flight API on SDKAgent directly.
    // The run.cancel() path requires holding the Run reference; we fire-and-forget
    // the turn so we can't reach it here. This is a known limitation.
    this.logger.warn("Cursor SDK provider: interrupt() is not yet supported");
  }

  async close(): Promise<void> {
    this.sdkAgent.close();
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    return [];
  }

  async setModel(modelId: string | null): Promise<void> {
    // Model switching mid-session is not supported by the Cursor SDK.
    // The model is fixed at Agent.create() time.
    void modelId;
    this.logger.warn("Cursor SDK provider: setModel() is not supported mid-session");
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
      local: { cwd: config.cwd },
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
      model: overrides?.model,
      ...overrides,
    };

    const sdkAgent = await Agent.resume(agentId, {
      ...(mergedConfig.model ? { model: { id: mergedConfig.model } } : {}),
      local: { cwd },
    });

    return new CursorSdkAgentSession(sdkAgent, mergedConfig, this.logger);
  }

  async listModels(_options: ListModelsOptions): Promise<AgentModelDefinition[]> {
    try {
      const models = await import("@cursor/sdk").then((m) => m.Cursor.models.list());
      return models.map((m) => ({
        provider: CURSOR_PROVIDER,
        id: m.id,
        label: m.displayName ?? m.id,
        description: m.id,
        isDefault: m.id === "composer-2",
      }));
    } catch (error) {
      this.logger.debug({ err: error }, "Cursor listModels failed, returning empty list");
      return [];
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Attempt a lightweight SDK call to verify Cursor is installed and auth works.
      await import("@cursor/sdk").then((m) => m.Cursor.models.list());
      return true;
    } catch {
      return false;
    }
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const available = await this.isAvailable();
      let modelsValue = "Not checked";
      const status = formatDiagnosticStatus(available);

      if (available) {
        try {
          const models = await this.listModels({ cwd: process.cwd(), force: false });
          modelsValue = String(models.length);
        } catch (error) {
          modelsValue = `Error - ${toDiagnosticErrorMessage(error)}`;
        }
      }

      return {
        diagnostic: formatProviderDiagnostic("Cursor", [
          { label: "SDK", value: "@cursor/sdk" },
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
