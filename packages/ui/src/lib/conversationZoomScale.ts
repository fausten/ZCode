import { readSafeLocalStorage } from "@/lib/browserEnvironment.js";

export const DEFAULT_CONVERSATION_ZOOM_SCALE = 1;
export const MIN_CONVERSATION_ZOOM_SCALE = 0.75;
export const MAX_CONVERSATION_ZOOM_SCALE = 1.6;
export const CONVERSATION_ZOOM_STEP = 0.1;
export const CONVERSATION_ZOOM_STORAGE_KEY = "zcode-conversation-zoom-scale";

export function normalizeConversationZoomScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CONVERSATION_ZOOM_SCALE;
  }
  const clamped = Math.min(
    MAX_CONVERSATION_ZOOM_SCALE,
    Math.max(MIN_CONVERSATION_ZOOM_SCALE, value),
  );
  return Math.round(clamped * 100) / 100;
}

export function loadConversationZoomScale(): number {
  const rawValue = readSafeLocalStorage(CONVERSATION_ZOOM_STORAGE_KEY);
  const storedValue = rawValue === null ? Number.NaN : Number(rawValue);
  return normalizeConversationZoomScale(Number.isFinite(storedValue) ? storedValue : undefined);
}

export function persistConversationZoomScale(scale: number): void {
  try {
    window.localStorage.setItem(
      CONVERSATION_ZOOM_STORAGE_KEY,
      String(normalizeConversationZoomScale(scale)),
    );
  } catch {
    // 隐私模式等场景下 localStorage 不可写：缩放仅本次会话生效。
  }
}
