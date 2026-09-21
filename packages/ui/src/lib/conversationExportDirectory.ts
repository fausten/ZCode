import { readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";

const CONVERSATION_EXPORT_LAST_DIR_KEY = "zcode-conversation-export-last-dir";

/** 读取上次导出目录；空串与超长值视为未记录。 */
export function loadConversationExportLastDirectory(): string | null {
  const value = readSafeLocalStorage(CONVERSATION_EXPORT_LAST_DIR_KEY);
  if (!value || value.length > 4096) return null;
  return value;
}

export function saveConversationExportLastDirectory(filePath: string): void {
  const separatorIndex = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (separatorIndex <= 0) return;
  const directory = filePath.slice(0, separatorIndex);
  if (!directory) return;
  writeSafeLocalStorage(CONVERSATION_EXPORT_LAST_DIR_KEY, directory);
}
