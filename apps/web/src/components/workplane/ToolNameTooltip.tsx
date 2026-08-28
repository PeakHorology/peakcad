"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type LabelHTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type PointerEventHandler,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

export const PEAK_TOOLTIP_DELAY_MS = 750;
/** @deprecated Use PEAK_TOOLTIP_DELAY_MS */
export const TOOL_NAME_TOOLTIP_DELAY_MS = PEAK_TOOLTIP_DELAY_MS;

function suppressNativeTooltip(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return;
  }
  target.removeAttribute("title");
  target.querySelectorAll("title").forEach((node) => node.remove());
}

export function usePeakTooltip(delayMs = PEAK_TOOLTIP_DELAY_MS) {
  const [open, setOpen] = useState(false);
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => () => clearTimer(), []);

  const showLater: PointerEventHandler<HTMLElement> = (event) => {
    suppressNativeTooltip(event.currentTarget);
    clearTimer();
    timerRef.current = window.setTimeout(() => setOpen(true), delayMs);
  };

  const hide = () => {
    clearTimer();
    setOpen(false);
  };

  return {
    open,
    showLater,
    hide,
    tooltipProps: {
      title: "",
      onPointerEnter: showLater,
      onPointerLeave: hide as PointerEventHandler<HTMLElement>,
      onPointerDown: hide as PointerEventHandler<HTMLElement>,
      onBlur: hide,
    },
  };
}

/** @deprecated Use usePeakTooltip */
export const useDelayedToolName = usePeakTooltip;

export function PeakTooltip({
  label,
  open,
  anchorRef,
  shortcut,
  hint,
}: {
  label: string;
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  /** Formatted hotkey label, e.g. "Ctrl + Z". */
  shortcut?: string;
  /** Small secondary line, e.g. "Right-click for help". */
  hint?: string;
}) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const node = anchorRef.current;
    if (!node) {
      return;
    }
    suppressNativeTooltip(node);
    const update = () => {
      const rect = node.getBoundingClientRect();
      setPosition({
        x: rect.left + rect.width / 2,
        y: rect.bottom + 8,
      });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [anchorRef, open]);

  if (!open || !position || !label || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <span className="peak-tooltip" role="tooltip" style={{ left: position.x, top: position.y }}>
      <span className="peak-tooltip-row">
        <span className="peak-tooltip-label">{label}</span>
        {shortcut ? <span className="peak-tooltip-shortcut">{shortcut}</span> : null}
      </span>
      {hint ? <span className="peak-tooltip-hint">{hint}</span> : null}
    </span>,
    document.body,
  );
}

/** @deprecated Use PeakTooltip */
export const ToolNameTooltip = PeakTooltip;

export function PeakHelpPopover({
  title,
  description,
  open,
  x,
  y,
}: {
  title: string;
  description: string;
  open: boolean;
  x: number;
  y: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const node = ref.current;
    if (!node) {
      setPos({ left: x, top: y });
      return;
    }
    const pad = 10;
    const rect = node.getBoundingClientRect();
    const left = Math.min(Math.max(pad, x), window.innerWidth - rect.width - pad);
    const top = Math.min(Math.max(pad, y), window.innerHeight - rect.height - pad);
    setPos({ left, top });
  }, [open, x, y]);

  if (!open || !description || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      ref={ref}
      className="peak-tool-help"
      role="dialog"
      aria-label={`${title} help`}
      style={{ left: pos.left, top: pos.top }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <strong>{title}</strong>
      <p>{description}</p>
    </div>,
    document.body,
  );
}

/** Right-click help card for tools. Hover tips stay separate. */
export function usePeakContextHelp(title: string, description?: string) {
  const [open, setOpen] = useState(false);
  const [point, setPoint] = useState({ x: 0, y: 0 });
  const helpText = description?.trim() || "";

  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    // Defer so the opening contextmenu / pointerup does not dismiss immediately.
    const timer = window.setTimeout(() => {
      window.addEventListener("pointerdown", close, true);
      window.addEventListener("keydown", onKeyDown, true);
      window.addEventListener("scroll", close, true);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  const onContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    if (!helpText) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setPoint({ x: event.clientX + 8, y: event.clientY + 8 });
    setOpen(true);
  };

  return {
    helpOpen: open,
    closeHelp: close,
    onContextMenu,
    helpPortal: <PeakHelpPopover title={title} description={helpText} open={open} x={point.x} y={point.y} />,
  };
}

type PeakTipButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  /** Longer help shown on right-click. Defaults to label if omitted. */
  description?: string;
  /** Formatted hotkey label, e.g. "Ctrl + Z". */
  shortcut?: string;
  children?: ReactNode;
};

/** Button with a PeakCAD delayed hover tip and right-click description. */
export function PeakTipButton({
  label,
  description,
  shortcut,
  children,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
  onBlur,
  onContextMenu,
  className,
  style,
  disabled,
  type = "button",
  ...rest
}: PeakTipButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const hasDescription = Boolean(description && description.trim() && description.trim() !== label);
  const hint = hasDescription ? "Right-click for help" : undefined;
  const { open, showLater, hide } = usePeakTooltip(shortcut || hasDescription ? 500 : PEAK_TOOLTIP_DELAY_MS);
  const { onContextMenu: openHelp, helpPortal } = usePeakContextHelp(label, description ?? label);

  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={className}
      style={style as CSSProperties | undefined}
      disabled={disabled}
      aria-label={rest["aria-label"] ?? label}
      title=""
      onPointerEnter={(event) => {
        showLater(event);
        onPointerEnter?.(event);
      }}
      onPointerLeave={(event) => {
        hide();
        onPointerLeave?.(event);
      }}
      onPointerDown={(event) => {
        hide();
        onPointerDown?.(event);
      }}
      onBlur={(event) => {
        hide();
        onBlur?.(event);
      }}
      onContextMenu={(event) => {
        hide();
        openHelp(event);
        onContextMenu?.(event);
      }}
    >
      {children}
      <PeakTooltip label={label} open={open} anchorRef={ref} shortcut={shortcut} hint={hint} />
      {helpPortal}
    </button>
  );
}

type PeakTipLabelProps = LabelHTMLAttributes<HTMLLabelElement> & {
  /** Hover tip text (and default help title). */
  label: string;
  /** Right-click help body. Defaults to label. */
  description?: string;
  /** Right-click help title when hover tip text is not a short name. */
  helpTitle?: string;
  /** Formatted hotkey label, e.g. "Ctrl + Z". */
  shortcut?: string;
  children?: ReactNode;
};

/** Label with a PeakCAD delayed hover tip and right-click description. */
export function PeakTipLabel({
  label,
  description,
  helpTitle,
  shortcut,
  children,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
  onContextMenu,
  className,
  style,
  ...rest
}: PeakTipLabelProps) {
  const ref = useRef<HTMLLabelElement>(null);
  const hasDescription = Boolean(description && description.trim() && description.trim() !== label);
  const hint = hasDescription ? "Right-click for help" : undefined;
  const { open, showLater, hide } = usePeakTooltip(shortcut || hasDescription ? 500 : PEAK_TOOLTIP_DELAY_MS);
  const { onContextMenu: openHelp, helpPortal } = usePeakContextHelp(helpTitle ?? label, description ?? label);

  return (
    <label
      {...rest}
      ref={ref}
      className={className}
      style={style as CSSProperties | undefined}
      title=""
      onPointerEnter={(event) => {
        showLater(event);
        onPointerEnter?.(event);
      }}
      onPointerLeave={(event) => {
        hide();
        onPointerLeave?.(event);
      }}
      onPointerDown={(event) => {
        hide();
        onPointerDown?.(event);
      }}
      onContextMenu={(event) => {
        hide();
        openHelp(event);
        onContextMenu?.(event);
      }}
    >
      {children}
      <PeakTooltip label={label} open={open} anchorRef={ref} shortcut={shortcut} hint={hint} />
      {helpPortal}
    </label>
  );
}
