// 任务内容区右键菜单：另存所有为 / 另存为（Markdown）/ 放大 / 缩小 / 重置缩放。
// 自绘 fixed 定位菜单（视觉类名与 components/ui/context-menu.tsx 对齐）；不用 Radix
// ContextMenu 的 Trigger 包裹层——多出的盒子会改变转录区 flex 布局并干扰自研虚拟化测量。
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import type { ConversationExportDetailLevel } from "@/v4/conversationMarkdownExport.js";

export interface ConversationTimelineContextMenuAnchor {
  x: number;
  y: number;
}

interface ConversationTimelineContextMenuProps {
  anchor: ConversationTimelineContextMenuAnchor;
  zoomPercent: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
  exportEnabled: boolean;
  exportBusy: boolean;
  onClose: () => void;
  onExportMarkdown: (detailLevel: ConversationExportDetailLevel) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
}

const MENU_WIDTH_PX = 220;
const MENU_HEIGHT_ESTIMATE_PX = 180;

function MenuButton({
  children,
  disabled,
  onClick,
  onClose,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  onClose: () => void;
}) {
  const handleClick = useCallback(() => {
    if (disabled) return;
    onClick();
    onClose();
  }, [disabled, onClick, onClose]);
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={handleClick}
      className={cn(
        "relative flex min-h-7 w-full cursor-default items-center gap-2 rounded-md px-2 py-1 text-left text-ui-base/relaxed text-foreground outline-hidden select-none",
        "data-[highlighted]:bg-menu-hover data-highlighted:bg-menu-hover hover:bg-menu-hover focus-visible:bg-menu-hover",
        "data-disabled:pointer-events-none data-disabled:text-foreground-subtlest disabled:pointer-events-none disabled:text-foreground-subtlest",
      )}
    >
      {children}
    </button>
  );
}

export function ConversationTimelineContextMenu({
  anchor,
  zoomPercent,
  canZoomIn,
  canZoomOut,
  exportEnabled,
  exportBusy,
  onClose,
  onExportMarkdown,
  onZoomIn,
  onZoomOut,
  onZoomReset,
}: ConversationTimelineContextMenuProps) {
  const { intl } = useZCodeIntl();
  const menuRef = useRef<HTMLDivElement>(null);

  // 点击外部 / Escape / 滚动 / 窗口失焦关闭；pointerdown 用捕获阶段，
  // 菜单自身按钮的 click 属于后续事件，不会被这里抢先关掉。
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const handleDismiss = () => onClose();
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("wheel", handleDismiss, { passive: true, capture: true });
    window.addEventListener("blur", handleDismiss);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("wheel", handleDismiss, true);
      window.removeEventListener("blur", handleDismiss);
    };
  }, [onClose]);

  const left = Math.min(anchor.x, Math.max(8, window.innerWidth - MENU_WIDTH_PX - 8));
  const top = Math.min(anchor.y, Math.max(8, window.innerHeight - MENU_HEIGHT_ESTIMATE_PX - 8));

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={intl.formatMessage({ id: "chat.contextMenu.title" })}
      style={{ left, top }}
      data-testid="v4-timeline-context-menu"
      className={cn(
        "fixed z-[60] flex min-w-44 flex-col gap-0.5 overflow-hidden rounded-lg border border-popover-border bg-menu p-1 text-foreground shadow-md",
        "animate-in fade-in-0 zoom-in-95 duration-100",
      )}
      onContextMenu={(event) => event.preventDefault()}
    >
      <MenuButton
        disabled={!exportEnabled || exportBusy}
        onClick={() => onExportMarkdown("full")}
        onClose={onClose}
      >
        {exportBusy
          ? intl.formatMessage({ id: "chat.contextMenu.exportBusy" })
          : intl.formatMessage({ id: "chat.contextMenu.exportMarkdownFull" })}
      </MenuButton>
      <MenuButton
        disabled={!exportEnabled || exportBusy}
        onClick={() => onExportMarkdown("concise")}
        onClose={onClose}
      >
        {exportBusy
          ? intl.formatMessage({ id: "chat.contextMenu.exportBusy" })
          : intl.formatMessage({ id: "chat.contextMenu.exportMarkdown" })}
      </MenuButton>
      <div className="-mx-1 my-1 h-px bg-border" />
      <MenuButton disabled={!canZoomIn} onClick={onZoomIn} onClose={onClose}>
        {intl.formatMessage({ id: "chat.contextMenu.zoomIn" })}
      </MenuButton>
      <MenuButton disabled={!canZoomOut} onClick={onZoomOut} onClose={onClose}>
        {intl.formatMessage({ id: "chat.contextMenu.zoomOut" })}
      </MenuButton>
      <div
        role="presentation"
        className="px-2 py-1 text-ui-caption text-foreground-subtle select-none"
      >
        {intl.formatMessage({ id: "chat.contextMenu.zoomLevel" }, { percent: zoomPercent })}
      </div>
      <MenuButton disabled={zoomPercent === 100} onClick={onZoomReset} onClose={onClose}>
        {intl.formatMessage({ id: "chat.contextMenu.zoomReset" })}
      </MenuButton>
    </div>
  );
}
