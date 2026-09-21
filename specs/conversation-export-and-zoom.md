# 会话转录导出 Markdown 与任务内容缩放

## 背景与目标

桌面端用户在任务（session）内容区需要两个能力：

1. **另存为 Markdown**：把当前任务页的完整对话——用户所有提问、全部思考过程
   （reasoning 行，含 UI 默认折叠/隐藏的行）、助手回复正文、工具调用及其截图——
   导出为一个独立 `.md` 文件。每次通过原生另存为对话框选择位置，对话框缺省
   打开上一次导出目录。
2. **任务内容缩放**：任务内容区右键菜单提供放大/缩小/重置，仅影响转录区文本，
   不影响 composer、导航、设置等其他 UI。

复制按钮（`CopyRowAction` / `resolveAssistantCopyText`）继续只复制本轮助手正文，
不在本 spec 范围内修改。

## 产品规则

### 导出范围与内容

右键菜单提供**两个导出档位**：

- **另存所有为 Markdown…（full）**：当前任务的全部信息。全部 reasoning 行
  （不套用 UI 可见性过滤）、工具调用的输入摘要 + 完整输出 + 错误信息 + 截图。
- **另存为 Markdown…（精简，concise）**：
  - 工具调用只导出**单行摘要**：`- **工具名**：输入首行（≤80 字符）`；
    error 态附错误首行（≤60 字符）。不导出输出正文，不内嵌截图。
  - **不导出思考过程**（reasoning 行全部跳过；用户确认的精简边界）。
  - 用户提问、回复正文、图片附件、citation 与 artifact 图片处理与 full 档相同。

两档共用范围与数据来源：当前 session 的**全部轮次**，按 rowId 线性排列、按
turnId 分组。edit/retry 产生的旧轮照常导出（所见即所得，不做去重）。数据来自
renderer 侧 `ConversationProjectionStore`：导出前调用既有 `loadAllOlder()` 补齐
全量行（与分享选择流程同一先例），完成后从 `store.getState().snapshot.rows.window`
读取。**不新增协议命令，不改 CLI。** concise 档缺省文件名加 `-summary` 后缀。

- 每轮结构（标题层级：轮 = `##`，行 = `###`）：
  - 轮头：序号、origin 标签（用户/目标延续/后台结果/编辑重跑/工作流启动）、
    开始时间；有 `activeMs` 时附「已工作 X 分 Y 秒」。
  - `userInput` → 「用户」小节（origin 非 realUser 时标注为系统输入）；图片附件
    内嵌，非图片附件列出文件名/类型/大小。
  - `reasoning` → 「思考过程」小节（**全部导出**，不套用
    `isConversationReasoningRowVisible` 的 UI 过滤），时长取行内 `durationMs`。
  - `toolCall` → 「工具调用：{toolName}」小节：输入摘要（超 2000 字符截断）、
    输出文本（围栏代码块，围栏字符按内容自适应）、错误信息（error 态）、
    截图内嵌（见下）。
  - `assistantText` → 「回复」小节。
- 行内引用（zcode-file-citation 指令）在代码围栏外替换为 `` `文件名` ``；
  助手正文中的 `zcode-artifact://` 图片引用读取后替换为 data URI 内嵌；
  本地路径与远程 URL 图片链接保持原文。

### 截图与图片

图片以 **data URI 内嵌**进单个 md 文件（满足"独立 .md"）：

- CUA 工具 display `media[]`：`data`（base64）直接用；`artifactUri` 走
  `readAttachment({ sessionId, ref })` 读取。
- `node_repl_images` display `images[]`：base64 + mimeType 直接内嵌。
- 用户附件与助手 artifact 图片：`readAttachment` 读取字节后 base64。
- 限额：单图 ≤ 4MB，全部内嵌总量 ≤ 24MB，成品 md ≤ 45MB（平台 saveFile 上限
  50MB）。超限图片退化为文字说明，导出不失败。

### 保存与目录记忆

- 复用 `IPlatformService.saveFile({ data, suggestedName })`；`SaveFileRequest`
  数据分支新增可选 `defaultDirectory?: string`（绝对路径；非法/相对路径忽略，
  回退 suggestedName 行为）。桌面 main 以 `join(defaultDirectory, suggestedName)`
  作为 `dialog.showSaveDialog` 的 `defaultPath`。
- renderer 用 localStorage key `zcode-conversation-export-last-dir` 记住上次
  导出目录（取保存结果 `path` 的 dirname）；下次导出作为 `defaultDirectory`
  传入。用户取消对话框不更新记忆。
- 文件名：`{任务标题清洗}-{yyyyMMdd-HHmm}.md`，标题去除文件系统非法字符、
  上限 60 字符，空标题回退 `conversation`。
- Web 端 `saveFile` 未实现：右键菜单不显示导出项（桌面版优先，用户已确认）。

### 缩放

- 存储：Zustand `conversationZoomScale`（默认 1），localStorage key
  `zcode-conversation-zoom-scale`，范围 [0.75, 1.6]，步进 0.1，两位小数归一。
  不进 `BROADCAST_FIELDS`（按窗口局部偏好，避免广播回环面）。
- 生效方式：转录滚动容器常挂 `conversation-zoom-scope` class 并以行内样式覆写
  `--ui-font-size = uiFontSizePx × scale`；class 内重声明 `--text-ui-*` 七档
  梯子（custom property 在声明元素处代入，:root 的旧值不会随继承更新，必须
  重声明）。**禁用 CSS `zoom`/`transform`**：自研虚拟化按 scrollTop/offset
  换算，缩放属性会破坏测量。
- 右键菜单项：另存为 Markdown… / 放大 / 缩小 / 缩放 N%（提示项）/ 重置缩放。
  到边界后对应项禁用。

## 状态所有者与边界

- 缩放系数：UI store（`packages/ui/src/store/`）唯一所有者；
  `ConversationTimeline` 读取并应用到滚动容器；菜单只发 action。
- 上次导出目录：localStorage，导出 handler 唯一写入者。
- 导出进行中标志：SessionPane 内 ref 防重入；`loadAllOlder` 自身单飞防重入。
- 平台写文件：仅 main 进程 `desktopSaveFile.ts`；renderer 不获得任意路径写能力
  （defaultDirectory 只影响对话框初始位置，不绕过用户确认）。

## 事件顺序（导出）

```
右键菜单点击「另存为 Markdown…」
→ 防重入检查 → store.loadAllOlder()（复用分享全量补齐，单飞）
→ store.getState().snapshot.rows.window 读取全量行
→ buildConversationMarkdownExport(rows)：同步文本 + 异步 readAttachment（逐个、
  best-effort，失败不中断）→ { markdown, suggestedName }
→ platform.saveFile({ data, suggestedName, defaultDirectory: 上次目录 })
→ 成功：记忆 dirname(path) + toast；取消：静默；失败：toast + logger.warn
```

## 失败语义

- `loadAllOlder` 失败/stale：中止导出，toast 失败提示，logger.warn。
- 单张图片读取失败：小节内文字占位（「图片不可用」），继续导出。
- `saveFile` 返回 canceled：静默（用户主动取消）。
- 超出总量限额：退化为链接/占位，导出继续；md 超 45MB 直接失败并提示。

## 验收场景

1. 多轮任务（含思考、工具调用、CUA/浏览器截图、图片附件）右键「另存所有为」：md 打开后
   问答、思考、回复、工具输出、截图全部可见；截图以 data URI 渲染。
2. 「另存为（精简）」：工具调用只出现单行摘要，无输出围栏与截图，**无任何思考过程小节**。
3. 二次导出时另存为对话框初始目录 = 上次保存目录；取消后再导出仍记住原目录。
4. 缩放：放大/缩小仅改变转录区文本尺寸，composer/侧栏/设置不变；重启应用后
   缩放保持；重置回到 100%；边界值外菜单项禁用。
5. 长会话（超出 tail window）导出包含全部历史轮次。
6. Web 端右键菜单不出现导出项；缩放项在 Web 端仍可用。
