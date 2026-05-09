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
import { join as pathJoin } from "node:path";
import { readFileSync, existsSync } from "node:fs";
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
  ModelSelection,
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
      // Image blocks cannot be rendered as plain text for the Cursor SDK —
      // include a placeholder so the user knows an image was attached.
      if (block.type === "image") return "[image attachment]";
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
        (args?.["command"] as string | undefined) ?? (args?.["cmd"] as string | undefined) ?? name,
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
  if (name === "edit_file" || name === "edit" || name === "apply_edit" || name.includes("edit")) {
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
        (args?.["old_string"] as string | undefined) ?? (args?.["oldString"] as string | undefined),
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
function mapCursorConversationToolCall(tc: {
  type: string;
  args?: unknown;
  result?: { status: string; value?: unknown; error?: unknown };
}): ToolCallDetail {
  const args = tc.args as Record<string, unknown> | undefined;
  const resultValue =
    tc.result?.status === "success"
      ? ((tc.result as { value?: unknown }).value as Record<string, unknown> | undefined)
      : undefined;

  switch (tc.type) {
    case "shell": {
      const shellArgs = args as { command?: string; workingDirectory?: string } | undefined;
      const shellResult = resultValue as
        | { stdout?: string; stderr?: string; exitCode?: number; signal?: string }
        | undefined;
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
      const editResult = resultValue as
        | { diffString?: string; linesAdded?: number; linesRemoved?: number }
        | undefined;
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
      const mcpArgs = args as
        | { toolName?: string; providerIdentifier?: string; args?: unknown }
        | undefined;
      return {
        type: "plain_text",
        label: `MCP: ${mcpArgs?.providerIdentifier ?? ""}/${mcpArgs?.toolName ?? ""}`.replace(
          /^\//,
          "",
        ),
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

/**
 * Parse a Paseo model ID back into the SDK's { id, params? } shape.
 *
 * listModels() encodes variant models as JSON strings
 * (e.g. '{"id":"composer-2","params":[{"thinking":"low"}]}') so that a single
 * string can carry both the base model ID and its parameter set. Before passing
 * to Agent.create / Agent.resume we must unwrap the JSON.
 */
function parseModelId(modelId: string): ModelSelection {
  try {
    const parsed = JSON.parse(modelId) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj["id"] === "string") {
        const rawParams = obj["params"];
        const params = Array.isArray(rawParams)
          ? (rawParams as Array<{ id: string; value: string }>)
          : undefined;
        return { id: obj["id"], ...(params ? { params } : {}) };
      }
    }
  } catch {
    // plain string ID — fall through
  }
  return { id: modelId };
}

// ---------------------------------------------------------------------------
// JSONL transcript parsing (analogous to Claude Code's JSONL history loader)
// ---------------------------------------------------------------------------

/**
 * Resolve the path to a Cursor SDK agent's JSONL transcript file.
 *
 * Layout: ~/.cursor/projects/<workspace-slug>/agent-transcripts/<agentId>/<agentId>.jsonl
 * where workspace-slug is the cwd with leading / removed and / replaced by -.
 */
function resolveCursorTranscriptPath(cwd: string, agentId: string): string | null {
  const slug = cwd.replace(/^\//, "").replace(/\//g, "-");
  const cursorDir = pathJoin(homedir(), ".cursor", "projects", slug, "agent-transcripts", agentId);
  const jsonlPath = pathJoin(cursorDir, `${agentId}.jsonl`);
  return existsSync(jsonlPath) ? jsonlPath : null;
}

/**
 * Parse a Cursor JSONL transcript into Paseo AgentTimelineItems.
 *
 * Format per line: { role: "user"|"assistant", message: { content: string | ContentBlock[] } }
 * User messages have text wrapped in <user_query>...</user_query> tags.
 */
function parseCursorTranscript(content: string): AgentTimelineItem[] {
  const items: AgentTimelineItem[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: { role?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(trimmed) as typeof entry;
    } catch {
      continue;
    }
    if (!entry.role || !entry.message?.content) continue;

    if (entry.role === "user") {
      const text = extractCursorUserText(entry.message.content);
      if (text) {
        items.push({ type: "user_message", text });
      }
    } else if (entry.role === "assistant") {
      const blocks = parseCursorAssistantContent(entry.message.content);
      items.push(...blocks);
    }
  }
  return items;
}

/** Extract user text from content, stripping <user_query> tags. */
function extractCursorUserText(content: unknown): string | null {
  let raw: string;
  if (typeof content === "string") {
    raw = content;
  } else if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        const text = (block as { text?: string }).text;
        if (text) textParts.push(text);
      }
    }
    raw = textParts.join("\n");
  } else {
    return null;
  }
  // Strip <user_query>...</user_query> wrapper
  const startTag = "<user_query>";
  const endTag = "</user_query>";
  const startIdx = raw.indexOf(startTag);
  const endIdx = raw.indexOf(endTag);
  if (startIdx >= 0 && endIdx > startIdx) {
    raw = raw.slice(startIdx + startTag.length, endIdx);
  }
  const trimmed = raw.trim();
  return trimmed || null;
}

/** Parse assistant content blocks into timeline items. */
function parseCursorAssistantContent(content: unknown): AgentTimelineItem[] {
  const items: AgentTimelineItem[] = [];
  if (!Array.isArray(content)) return items;

  // Track the last tool_call item so we can attach tool_result content to it.
  let lastToolCallItem: (AgentTimelineItem & { type: "tool_call" }) | null = null;

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    switch (b.type) {
      case "text": {
        const text = (b.text as string | undefined)?.trim();
        if (text) {
          items.push({ type: "assistant_message", text });
        }
        lastToolCallItem = null;
        break;
      }
      case "thinking": {
        const thinking = (b.thinking as string | undefined)?.trim();
        if (thinking) {
          items.push({ type: "reasoning", text: thinking });
        }
        lastToolCallItem = null;
        break;
      }
      case "tool_use": {
        const name = (b.name as string | undefined) ?? "unknown";
        const input = b.input as Record<string, unknown> | undefined;
        const toolItem = {
          type: "tool_call" as const,
          callId: (b.id as string | undefined) ?? randomUUID(),
          name,
          status: "completed" as const,
          detail: mapCursorTranscriptToolCall(name, input),
          error: null,
        };
        items.push(toolItem);
        lastToolCallItem = toolItem;
        break;
      }
      case "tool_result": {
        // Attach tool_result content to the preceding tool_call's detail.
        if (lastToolCallItem) {
          const resultContent = extractToolResultText(b.content);
          if (resultContent) {
            enrichToolCallDetail(lastToolCallItem, resultContent);
          }
        }
        lastToolCallItem = null;
        break;
      }
      // Default: skip unknown block types
    }
  }
  return items;
}

/** Extract text from a tool_result content field. */
function extractToolResultText(content: unknown): string | null {
  if (typeof content === "string") return content || null;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          parts.push(b.text);
        }
      }
    }
    return parts.length > 0 ? parts.join("\n") : null;
  }
  return null;
}

/** Enrich a tool_call item's detail with the tool result output. */
function enrichToolCallDetail(
  item: AgentTimelineItem & { type: "tool_call" },
  resultContent: string,
): void {
  const detail = item.detail;
  if (!detail) return;
  switch (detail.type) {
    case "shell":
      (detail as { output?: string }).output = resultContent;
      break;
    case "read":
      (detail as { content?: string }).content = resultContent;
      break;
    case "search":
      (detail as { content?: string }).content = resultContent;
      break;
    case "edit":
      (detail as { unifiedDiff?: string }).unifiedDiff = resultContent;
      break;
    case "unknown":
      (detail as { output?: unknown }).output = resultContent;
      break;
  }
}

/** Map a JSONL tool_use block to a Paseo ToolCallDetail. */
function mapCursorTranscriptToolCall(
  name: string,
  input: Record<string, unknown> | undefined,
): ToolCallDetail {
  const lname = name.toLowerCase();
  if (lname === "shell" || lname.includes("terminal") || lname === "run_terminal_cmd") {
    return {
      type: "shell",
      command: (input?.["command"] as string | undefined) ?? name,
    };
  }
  if (lname === "read" || lname === "read_file") {
    const filePath = (input?.["path"] as string | undefined) ?? (input?.["target_file"] as string | undefined) ?? "";
    // GUI shows "No additional details" for read without content.
    // Provide the file path + range as content so the panel isn't empty.
    const offset = input?.["offset"] as number | undefined;
    const limit = input?.["limit"] as number | undefined;
    const rangeInfo = [
      offset !== undefined ? `offset: ${offset}` : null,
      limit !== undefined ? `limit: ${limit}` : null,
    ].filter(Boolean).join(", ");
    return {
      type: "read",
      filePath,
      offset,
      limit,
      content: rangeInfo ? `(${rangeInfo})` : "(full file)",
    };
  }
  if (lname === "strreplace" || lname === "str_replace" || lname.includes("edit") || lname === "apply_diff") {
    return {
      type: "edit",
      filePath: (input?.["path"] as string | undefined) ?? (input?.["target_file"] as string | undefined) ?? "",
      oldString: input?.["old_string"] as string | undefined,
      newString: input?.["new_string"] as string | undefined,
    };
  }
  if (lname === "write" || lname === "write_file" || lname === "write_to_file" || lname === "create_file") {
    return {
      type: "write",
      filePath: (input?.["path"] as string | undefined) ?? (input?.["target_file"] as string | undefined) ?? "",
      content: input?.["content"] as string | undefined,
    };
  }
  if (lname === "grep" || lname === "glob" || lname.includes("search") || lname === "websearch") {
    const query = (input?.["pattern"] as string | undefined) ?? (input?.["query"] as string | undefined) ?? (input?.["search_term"] as string | undefined) ?? (input?.["glob_pattern"] as string | undefined) ?? name;
    const path = (input?.["path"] as string | undefined) ?? (input?.["target_directory"] as string | undefined);
    const summary = path ? `${query}  (in ${path})` : query;
    return {
      type: "search",
      query,
      content: summary,
    };
  }
  return { type: "unknown", input: input ?? null, output: null };
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
  ) {
    // Initialize model selection from the config model (which may be a JSON string with params)
    this.currentModelSelection = config.model ? parseModelId(config.model) : undefined;
  }

  /**
   * Current model + params selection. Updated by setModel() and setThinkingOption().
   * Passed to agent.send() on every turn.
   */
  private currentModelSelection:
    | { id: string; params?: Array<{ id: string; value: string }> }
    | undefined;

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
          // Pass current model selection (includes thinking/reasoning params)
          ...(this.currentModelSelection ? { model: this.currentModelSelection } : {}),
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
        const runUsage = (result as { usage?: { inputTokens?: number; outputTokens?: number } })
          .usage;
        if (runUsage?.inputTokens || runUsage?.outputTokens) {
          // Prefer run.wait() usage over onDelta usage if available
          this.latestUsage = {
            inputTokens: runUsage.inputTokens,
            outputTokens: runUsage.outputTokens,
          };
        }

        // Guard: if the turn was already terminated by handleSdkMessage (e.g. a
        // status ERROR/CANCELLED event arrived during streaming), do NOT emit a
        // second terminal event — that would cause duplicate [System Error] messages.
        if (this.activeTurnId !== turnId) {
          this.currentRun = null;
          return;
        }

        this.activeTurnId = null;
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
        // Guard: if the turn was already terminated, suppress the catch-path emit.
        if (this.activeTurnId !== turnId) {
          this.currentRun = null;
          return;
        }
        this.activeTurnId = null;
        this.currentRun = null;
        this.emit({
          type: "turn_failed",
          provider: CURSOR_PROVIDER,
          turnId,
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
    // Strategy: prefer JSONL transcript (complete, includes user messages) over
    // SDK conversation() API (incomplete — no userMessage in local runtime).
    // This mirrors Claude Code provider's approach of reading local JSONL files.
    const agentId = this.sdkAgent.agentId;
    const transcriptPath = resolveCursorTranscriptPath(this.config.cwd, agentId);

    if (transcriptPath) {
      try {
        const content = readFileSync(transcriptPath, "utf8");
        const items = parseCursorTranscript(content);
        for (const item of items) {
          yield { type: "timeline", provider: CURSOR_PROVIDER, item };
        }
        return;
      } catch (error) {
        this.logger.debug(
          { err: error, path: transcriptPath },
          "Cursor JSONL transcript read failed, falling back to SDK",
        );
      }
    }

    // Fallback: use SDK conversation() API (missing user messages).
    try {
      const { items } = await Agent.listRuns(this.sdkAgent.agentId, {
        runtime: "local",
        limit: 100,
      });

      if (items.length === 0) return;

      // Emit the initial user prompt from config.title if available.
      if (this.config.title) {
        yield {
          type: "timeline",
          provider: CURSOR_PROVIDER,
          item: { type: "user_message", text: this.config.title },
        };
      }

      // Process runs in chronological order (oldest first).
      const chronologicalRuns = [...items].reverse();

      for (const run of chronologicalRuns) {
        const turns = await run.conversation();

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
                  ? {
                      ...baseItem,
                      status: "failed" as const,
                      error: String(
                        (tc.result as { error?: unknown } | undefined)?.error ?? "Tool call failed",
                      ),
                    }
                  : { ...baseItem, status: "completed" as const, error: null };
                yield { type: "timeline", provider: CURSOR_PROVIDER, item };
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
      }
    } catch (error) {
      this.logger.debug({ err: error }, "Cursor streamHistory SDK fallback failed");
    }
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

  async respondToPermission(_requestId: string, _response: AgentPermissionResponse): Promise<void> {
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
   * agent.model for subsequent sends.
   */
  async setModel(modelId: string | null): Promise<void> {
    if (modelId) {
      this.config.model = modelId;
      this.currentModelSelection = parseModelId(modelId);
      this.latestModel = this.currentModelSelection?.id ?? modelId;
    }
  }

  /**
   * Switch thinking/reasoning level by updating the params in currentModelSelection.
   *
   * Cursor SDK uses model.params to control thinking/reasoning (not separate model IDs).
   * Different models use different param names:
   *   - GPT: { id: "reasoning", value: "medium" }
   *   - Claude: { id: "thinking", value: "true" } + { id: "effort", value: "high" }
   *   - Composer: only has { id: "fast", value: "true/false" }
   *
   * This method finds the thinking/reasoning param and updates its value.
   */
  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    if (!this.currentModelSelection) return;

    const params = [...(this.currentModelSelection.params ?? [])];

    const thinkingIdx = params.findIndex((p) => p.id === "thinking");
    const effortIdx = params.findIndex((p) => p.id === "effort");
    const reasoningIdx = params.findIndex((p) => p.id === "reasoning");

    if (thinkingIdx >= 0 && effortIdx >= 0) {
      // Claude-style: thinkingOptionId is an effort level (low/medium/high/max).
      // Toggle "thinking" boolean + update "effort" value.
      if (thinkingOptionId) {
        params[thinkingIdx] = { id: "thinking", value: "true" };
        params[effortIdx] = { id: "effort", value: thinkingOptionId };
      } else {
        params[thinkingIdx] = { id: "thinking", value: "false" };
      }
    } else if (reasoningIdx >= 0) {
      // GPT-style: thinkingOptionId is a reasoning level (none/low/medium/high/extra-high).
      params[reasoningIdx] = { id: "reasoning", value: thinkingOptionId ?? "none" };
    } else if (thinkingIdx >= 0) {
      // Simple boolean toggle (haiku, grok, etc.).
      params[thinkingIdx] = { id: "thinking", value: thinkingOptionId ?? "false" };
    }
    // else: model has no thinking-related param (composer-2) — no-op.

    this.currentModelSelection = { ...this.currentModelSelection, params };
    this.config.thinkingOptionId = thinkingOptionId ?? undefined;
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
  private readonly apiKey: string | undefined;

  constructor(options: CursorSdkAgentClientOptions) {
    this.logger = options.logger;
    // Prefer API key from config.json provider env, fall back to process.env
    // Note: ${VAR} expansion is handled in provider-registry.ts toRuntimeSettings()
    this.apiKey =
      (options.runtimeSettings?.env?.["CURSOR_API_KEY"] as string | undefined) ??
      process.env.CURSOR_API_KEY;
    // Persist to process.env so Cursor SDK static methods (models.list, me)
    // can always find it regardless of call site.
    if (this.apiKey) {
      process.env.CURSOR_API_KEY = this.apiKey;
    }
  }

  async createSession(
    config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    // Resolve model: explicit value wins; otherwise query listModels for the
    // default. This avoids Agent.create() falling back to the "default"
    // sentinel ({id:"default",params:[]}) which the Cursor API rejects.
    const resolvedModel = await this.resolveModel(config.model, config.cwd);

    const sdkAgent = await Agent.create({
      // Must pass apiKey explicitly — SDK does not reliably auto-read
      // CURSOR_API_KEY in CJS mode (confirmed by integration test).
      apiKey: this.apiKey,
      ...(resolvedModel ? { model: resolvedModel } : {}),
      local: {
        cwd: config.cwd,
        // Load project hooks (.cursor/hooks.json) and user MCP config
        settingSources: ["project", "user"],
        sandboxOptions: { enabled: false },
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

    const resolvedModel = await this.resolveModel(mergedConfig.model, cwd);

    // Agent.resume() auto-detects runtime from ID prefix (bc- = cloud, else local)
    const sdkAgent = await Agent.resume(agentId, {
      apiKey: this.apiKey,
      ...(resolvedModel ? { model: resolvedModel } : {}),
      local: { cwd, settingSources: ["project", "user"], sandboxOptions: { enabled: false } },
      ...(mergedConfig.mcpServers ? { mcpServers: mergedConfig.mcpServers } : {}),
    });

    return new CursorSdkAgentSession(sdkAgent, mergedConfig, this.logger);
  }

  async listModels(_options: ListModelsOptions): Promise<AgentModelDefinition[]> {
    try {
      const models = await this.withApiKeyEnv(() => Cursor.models.list());
      const result: AgentModelDefinition[] = [];

      for (const m of models) {
        // Show one entry per model (not per variant).
        // Variants are parameter combinations (thinking/context/reasoning/fast).
        // Expanding all variants causes 169 entries with many duplicates.
        //
        // Instead: expose model with its default variant, and surface thinking
        // depth options via thinkingOptions so the user can pick from the selector.
        const defaultVariant = m.variants?.find((v) => v.isDefault) ?? m.variants?.[0];
        const params = defaultVariant?.params;

        // Determine thinkingOptions based on which parameter controls depth:
        //
        // 1. "effort" param  (Claude family) — thinking depth is low/medium/high/max.
        //    The "thinking" boolean is toggled automatically by setThinkingOption.
        //    The ":icon-brain:" displayName on thinking=true is Cursor's internal icon
        //    notation and must NOT be used as the option label.
        //
        // 2. "reasoning" param (GPT family) — depth is none/low/medium/high/extra-high.
        //
        // 3. Only "thinking" boolean (haiku, grok, etc.) — expose Off / On.
        //
        // 4. Only "fast" (composer-2) — no meaningful depth selector; omit.

        const effortParam = m.parameters?.find((p) => p.id === "effort");
        const reasoningParam = m.parameters?.find((p) => p.id === "reasoning");
        const thinkingBoolParam = m.parameters?.find((p) => p.id === "thinking");

        let thinkingOptions: { id: string; label: string }[] | undefined;
        let defaultThinkingOptionId: string | undefined;

        if (effortParam) {
          // Claude-style: effort controls thinking depth.
          thinkingOptions = effortParam.values.map((v) => ({
            id: v.value,
            label: v.displayName ?? v.value,
          }));
          defaultThinkingOptionId = defaultVariant?.params.find((p) => p.id === "effort")?.value;
        } else if (reasoningParam) {
          // GPT-style: reasoning level.
          thinkingOptions = reasoningParam.values.map((v) => ({
            id: v.value,
            label: v.displayName ?? v.value,
          }));
          defaultThinkingOptionId = defaultVariant?.params.find((p) => p.id === "reasoning")?.value;
        } else if (thinkingBoolParam) {
          // Simple on/off toggle (haiku, grok, etc.).
          thinkingOptions = [
            { id: "false", label: "Off" },
            { id: "true", label: "On" },
          ];
          defaultThinkingOptionId =
            defaultVariant?.params.find((p) => p.id === "thinking")?.value ?? "false";
        }
        // else: no meaningful thinking depth (composer-2 / fast-only) — omit.

        result.push({
          provider: CURSOR_PROVIDER,
          id: params ? JSON.stringify({ id: m.id, params }) : m.id,
          label: m.displayName ?? m.id,
          description: m.description,
          isDefault: m.id === "composer-2",
          ...(thinkingOptions?.length ? { thinkingOptions } : {}),
          ...(defaultThinkingOptionId !== undefined ? { defaultThinkingOptionId } : {}),
        });
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

  /**
   * Resolve a model string to the SDK's { id, params? } shape, or undefined.
   *
   * - Explicit, non-"default" values are parsed via parseModelId().
   * - Missing / "default" values trigger a listModels() call to find the
   *   isDefault model so we never pass the "default" sentinel to Agent.create.
   */
  private async resolveModel(
    model: string | undefined,
    cwd: string,
  ): Promise<ModelSelection | undefined> {
    if (model && model !== "default") {
      return parseModelId(model);
    }
    const models = await this.listModels({ cwd, force: false });
    const defaultModel = models.find((m) => m.isDefault) ?? models[0];
    return defaultModel ? parseModelId(defaultModel.id) : undefined;
  }

  private async withApiKeyEnv<T>(fn: () => Promise<T>): Promise<T> {
    const prev = process.env.CURSOR_API_KEY;
    if (this.apiKey) process.env.CURSOR_API_KEY = this.apiKey;
    try {
      return await fn();
    } finally {
      if (this.apiKey) process.env.CURSOR_API_KEY = prev;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.withApiKeyEnv(() => Cursor.models.list());
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
          const user = await this.withApiKeyEnv(() => Cursor.me());
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
