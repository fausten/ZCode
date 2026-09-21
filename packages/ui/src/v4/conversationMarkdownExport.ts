// 会话转录 → 单文件 Markdown 导出收集器。
// 数据全部来自 renderer 已有投影行（导出前由调用方 loadAllOlder 补齐），不新增协议命令。
// 图片以 data URI 内嵌满足「独立 .md」；限额与目录记忆规则见 specs/conversation-export-and-zoom.md。
import type {
  AssistantTextRow,
  ConversationRow,
  ReasoningRow,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { extractMarkdownArtifactImageRefs } from "@zcode/shared";
import type { ConversationAttachmentReadParams } from "@/v4/transport.js";
import {
  findMarkdownCodeRanges,
  overlapsAssistantTextRanges,
} from "@/lib/assistantDirectiveParser.js";
import { extractZCodeFileCitationDirectives } from "@/lib/zcodeFileCitation.js";
import { logger } from "@/logger.js";

const MAX_PER_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;
const TOOL_INPUT_PREVIEW_LIMIT = 2_000;
const TOOL_SUMMARY_INPUT_LIMIT = 80;
const TOOL_SUMMARY_ERROR_LIMIT = 60;

export type ConversationAttachmentReader = (
  params: ConversationAttachmentReadParams,
) => Promise<
  { bytes: Uint8Array; mediaType: string } | { url: string; mediaType: string } | { url: string }
>;

export interface ConversationExportLabels {
  exportedAt: (time: string, turns: number) => string;
  turnHeading: (index: number, origin: string, time: string) => string;
  originUser: string;
  originGoalContinuation: string;
  originBackgroundResult: string;
  originEditRerun: string;
  originWorkflowLaunch: string;
  sectionUser: string;
  sectionSystemInput: string;
  sectionReasoning: string;
  sectionAssistant: string;
  sectionToolCall: (name: string) => string;
  workedFor: (duration: string) => string;
  durationMinutesSeconds: (minutes: number, seconds: number) => string;
  durationSeconds: (seconds: number) => string;
  attachment: (name: string, mime: string, sizeLabel: string) => string;
  screenshot: (index: number) => string;
  imageUnavailable: string;
  inputTruncated: string;
  toolFailedShort: (message: string) => string;
}

/**
 * 导出明细档位：
 * - full「另存所有为」：全部 reasoning 行、工具完整输出与截图——当前任务的全部信息。
 * - concise「另存为」：工具调用只导出单行摘要，**不导出思考过程**（空文本
 *   reasoning 行两种档位都跳过，对齐 render unit 的空行过滤）。
 */
export type ConversationExportDetailLevel = "full" | "concise";

export interface ConversationMarkdownExportOptions {
  sessionId: string;
  sessionTitle: string;
  labels: ConversationExportLabels;
  formatDateTime: (timestamp: number) => string;
  readAttachment?: ConversationAttachmentReader;
  now?: () => Date;
  detailLevel?: ConversationExportDetailLevel;
}

export interface ConversationMarkdownExportResult {
  markdown: string;
  suggestedName: string;
  turnCount: number;
  skippedImageCount: number;
}

function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatWorkDuration(ms: number, labels: ConversationExportLabels): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) return labels.durationSeconds(totalSeconds);
  return labels.durationMinutesSeconds(Math.floor(totalSeconds / 60), totalSeconds % 60);
}

export function sanitizeExportFileTitle(title: string): string {
  const cleaned = title
    // 文件名清洗有意覆盖控制字符：换行/制表等会破坏 md 链接与文件系统兼容性。
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "_")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.\s]+$/u, "");
  const trimmed = cleaned.slice(0, 60).trim();
  return trimmed || "conversation";
}

function formatFileStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}`;
}

/** 围栏字符按内容自适应：正文中已有的 ```/~~~ 序列不能截断围栏。 */
function pickFenceMarker(text: string): string {
  const backtickRuns = text.match(/`+/gu)?.map((run) => run.length) ?? [];
  const tildeRuns = text.match(/~+/gu)?.map((run) => run.length) ?? [];
  const maxBackticks = Math.max(0, ...backtickRuns);
  const maxTildes = Math.max(0, ...tildeRuns);
  if (maxBackticks < 3) return "```";
  if (maxTildes < 3) return "~~~";
  return "`".repeat(Math.min(12, maxBackticks + 1));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function readAsBytes(result: Awaited<ReturnType<ConversationAttachmentReader>>): Uint8Array | null {
  if ("bytes" in result && result.bytes instanceof Uint8Array) return result.bytes;
  if ("url" in result && typeof result.url === "string") {
    // URL 分支只有 Desktop 本地视频会走；图片导出理论上不会命中，兜底 best-effort 拉取。
    return null;
  }
  return null;
}

interface ExportImageContext {
  sessionId: string;
  readAttachment?: ConversationAttachmentReader;
  labels: ConversationExportLabels;
  usedBytes: number;
  skipped: number;
}

/** 读取一个受 Host 授权的附件 ref，返回 data URI；超限或失败返回 null 并计数。 */
async function resolveAttachmentDataUri(
  context: ExportImageContext,
  ref: string,
  fallbackMime: string,
): Promise<string | null> {
  if (!context.readAttachment) {
    // 无读取通道（Web 端 / 分享只读投影）与读取失败同口径：计入 skipped，由调用方降级占位。
    context.skipped += 1;
    return null;
  }
  if (context.usedBytes >= MAX_TOTAL_IMAGE_BYTES) {
    context.skipped += 1;
    return null;
  }
  try {
    const result = await context.readAttachment({ sessionId: context.sessionId, ref });
    const bytes = readAsBytes(result);
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_PER_IMAGE_BYTES) {
      context.skipped += 1;
      return null;
    }
    context.usedBytes += bytes.byteLength;
    const mediaType = "mediaType" in result && result.mediaType ? result.mediaType : fallbackMime;
    return `data:${mediaType};base64,${bytesToBase64(bytes)}`;
  } catch (error) {
    context.skipped += 1;
    logger.debug("[conversation-export] 附件读取失败", { ref: ref.slice(0, 24), error });
    return null;
  }
}

/** 工具行截图来源：输入侧 node_repl_images（浏览器/Node REPL）与结果侧 cua media（Computer Use）。 */
interface PendingToolImage {
  mimeType: string;
  base64?: string;
  artifactUri?: string;
}

function collectToolImages(row: ToolCallRow): PendingToolImage[] {
  const images: PendingToolImage[] = [];
  if (row.display?.kind === "node_repl_images" && row.display.images) {
    for (const image of row.display.images) {
      images.push({ mimeType: image.mimeType, base64: image.base64 });
    }
  }
  const resultDisplay = row.output?.display;
  if (resultDisplay?.kind === "cua" && resultDisplay.media) {
    for (const media of resultDisplay.media) {
      images.push({ mimeType: media.mimeType, base64: media.data, artifactUri: media.artifactUri });
    }
  }
  return images;
}

function appendImageMarkdown(
  parts: string[],
  alt: string,
  dataUri: string | null,
  context: ExportImageContext,
): void {
  if (dataUri) {
    parts.push(`![${alt}](${dataUri})`, "");
  } else {
    parts.push(`> ${context.labels.imageUnavailable}（${alt}）`, "");
    // skipped 已在 resolve 阶段计数；直接内联 base64 的分支不经过 resolve，这里不重复计。
  }
}

/** 行内 citation 指令 → `` `文件名` ``；代码围栏内的指令保持原文（与分享投影同规则）。 */
function inlineFileCitations(markdown: string): string {
  const protectedRanges = findMarkdownCodeRanges(markdown);
  const directives = extractZCodeFileCitationDirectives(markdown).filter(
    (directive) => !overlapsAssistantTextRanges(directive.start, directive.end, protectedRanges),
  );
  let result = markdown;
  for (const directive of [...directives].reverse()) {
    const path = directive.path?.trim();
    const fileName = path ? (path.replace(/\\/gu, "/").split("/").at(-1) ?? path) : "";
    result = `${result.slice(0, directive.start)}\`${fileName}\`${result.slice(directive.end)}`;
  }
  return result;
}

/** 助手正文里的 zcode-artifact:// 图片引用 → data URI；读取失败保持原文（仍是合法 md 链接文本）。 */
async function embedAssistantArtifactImages(
  context: ExportImageContext,
  markdown: string,
): Promise<string> {
  const refs = extractMarkdownArtifactImageRefs(markdown);
  let result = markdown;
  for (const ref of refs) {
    const dataUri = await resolveAttachmentDataUri(context, ref, "image/png");
    if (!dataUri) continue;
    result = result.split(`](${ref})`).join(`](${dataUri})`);
  }
  return result;
}

function originLabel(origin: TurnHeaderRow["origin"], labels: ConversationExportLabels): string {
  switch (origin) {
    case "userInput":
      return labels.originUser;
    case "goalContinuation":
      return labels.originGoalContinuation;
    case "backgroundResult":
      return labels.originBackgroundResult;
    case "editRerun":
      return labels.originEditRerun;
    case "workflowLaunch":
      return labels.originWorkflowLaunch;
  }
}

export async function buildConversationMarkdownExport(
  rows: readonly ConversationRow[],
  options: ConversationMarkdownExportOptions,
): Promise<ConversationMarkdownExportResult> {
  const { labels } = options;
  const now = options.now ?? (() => new Date());
  const context: ExportImageContext = {
    sessionId: options.sessionId,
    readAttachment: options.readAttachment,
    labels,
    usedBytes: 0,
    skipped: 0,
  };

  const header: string[] = [
    `# ${options.sessionTitle || "conversation"}`,
    "",
    labels.exportedAt(options.formatDateTime(now().getTime()), 0),
    "",
    "---",
    "",
  ];

  const body: string[] = [];
  let turnCount = 0;
  let screenshotIndex = 0;
  const detailLevel = options.detailLevel ?? "full";

  const appendUserRow = async (row: UserInputRow): Promise<void> => {
    const isRealUser = row.origin === "realUser";
    body.push(`### ${isRealUser ? labels.sectionUser : labels.sectionSystemInput}`, "");
    body.push(row.text.trim(), "");
    for (const attachment of row.attachments ?? []) {
      if (attachment.mime.startsWith("image/")) {
        const dataUri = await resolveAttachmentDataUri(context, attachment.ref, attachment.mime);
        appendImageMarkdown(body, labels.screenshot((screenshotIndex += 1)), dataUri, context);
      } else {
        body.push(
          `- ${labels.attachment(attachment.fileName, attachment.mime, formatByteSize(attachment.bytes))}`,
          "",
        );
      }
    }
  };

  const appendReasoningRow = (row: ReasoningRow): void => {
    // concise 档不导出思考过程（用户确认的精简边界）。
    if (detailLevel === "concise") return;
    // 空文本行 full 档也跳过：与 render unit 的空 reasoning 过滤一致，零信息小节没有意义。
    if (row.text.trim().length === 0) return;
    const durationSuffix =
      row.durationMs !== undefined ? `（${formatWorkDuration(row.durationMs, labels)}）` : "";
    body.push(`### ${labels.sectionReasoning}${durationSuffix}`, "", row.text.trim(), "");
  };

  /** concise 档的工具单行摘要：`- **工具**：输入首行`；失败时附错误首行。 */
  const appendToolSummaryRow = (row: ToolCallRow): void => {
    const inputFirstLine = row.inputText.trim().split("\n")[0] ?? "";
    const inputPreview =
      inputFirstLine.length > TOOL_SUMMARY_INPUT_LIMIT
        ? `${inputFirstLine.slice(0, TOOL_SUMMARY_INPUT_LIMIT)}…`
        : inputFirstLine;
    const parts = [`- **${row.toolName}**`];
    if (inputPreview) parts.push(`：${inputPreview}`);
    if (row.status === "error" && row.error?.message) {
      const errorFirstLine = row.error.message.split("\n")[0] ?? "";
      const errorPreview =
        errorFirstLine.length > TOOL_SUMMARY_ERROR_LIMIT
          ? `${errorFirstLine.slice(0, TOOL_SUMMARY_ERROR_LIMIT)}…`
          : errorFirstLine;
      parts.push(`（${labels.toolFailedShort(errorPreview)}）`);
    }
    body.push(parts.join(""), "");
  };

  const appendToolCallRow = async (row: ToolCallRow): Promise<void> => {
    if (detailLevel === "concise") {
      appendToolSummaryRow(row);
      return;
    }
    body.push(`### ${labels.sectionToolCall(row.toolName)}`, "");
    const inputText = row.inputText.trim();
    if (inputText) {
      const truncated = inputText.length > TOOL_INPUT_PREVIEW_LIMIT;
      const preview = truncated
        ? `${inputText.slice(0, TOOL_INPUT_PREVIEW_LIMIT)}…\n${labels.inputTruncated}`
        : inputText;
      const fence = pickFenceMarker(preview);
      body.push(fence, preview, fence, "");
    }
    const outputText = row.output?.text?.trim();
    if (outputText) {
      const fence = pickFenceMarker(outputText);
      body.push(fence, outputText, fence, "");
    }
    if (row.status === "error" && row.error?.message) {
      const fence = pickFenceMarker(row.error.message);
      body.push(fence, row.error.message, fence, "");
    }
    for (const image of collectToolImages(row)) {
      const alt = labels.screenshot((screenshotIndex += 1));
      if (image.base64) {
        if (context.usedBytes < MAX_TOTAL_IMAGE_BYTES) {
          context.usedBytes += Math.ceil((image.base64.length * 3) / 4);
          body.push(`![${alt}](data:${image.mimeType};base64,${image.base64})`, "");
        } else {
          context.skipped += 1;
          body.push(`> ${labels.imageUnavailable}（${alt}）`, "");
        }
      } else if (image.artifactUri) {
        const dataUri = await resolveAttachmentDataUri(context, image.artifactUri, image.mimeType);
        appendImageMarkdown(body, alt, dataUri, context);
      }
    }
  };

  const appendAssistantTextRow = async (row: AssistantTextRow): Promise<void> => {
    body.push(`### ${labels.sectionAssistant}`, "");
    const withCitations = inlineFileCitations(row.text.trim());
    body.push(await embedAssistantArtifactImages(context, withCitations), "");
  };

  for (const row of rows) {
    switch (row.kind) {
      case "turnHeader": {
        turnCount += 1;
        const meta: string[] = [
          labels.turnHeading(
            turnCount,
            originLabel(row.origin, labels),
            options.formatDateTime(row.startedAt),
          ),
        ];
        if (row.activeMs !== undefined && row.activeMs > 0) {
          meta[0] = `${meta[0]} · ${labels.workedFor(formatWorkDuration(row.activeMs, labels))}`;
        }
        body.push(`## ${meta[0]}`, "");
        break;
      }
      case "userInput":
        await appendUserRow(row);
        break;
      case "reasoning":
        appendReasoningRow(row);
        break;
      case "toolCall":
        await appendToolCallRow(row);
        break;
      case "assistantText":
        await appendAssistantTextRow(row);
        break;
      default:
        break;
    }
  }

  header[2] = labels.exportedAt(options.formatDateTime(now().getTime()), turnCount);
  const markdown = [...header, ...body].join("\n");

  const fileTitle = sanitizeExportFileTitle(options.sessionTitle);
  const suggestedName =
    detailLevel === "concise"
      ? `${fileTitle}-${formatFileStamp(now())}-summary.md`
      : `${fileTitle}-${formatFileStamp(now())}.md`;

  return {
    markdown,
    suggestedName,
    turnCount,
    skippedImageCount: context.skipped,
  };
}
