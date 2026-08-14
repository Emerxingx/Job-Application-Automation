'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/components/ui';

/**
 * Focusable descendants, in DOM order. Recomputed on every Tab because a
 * drawer's contents change (a form reveals fields, a row expands).
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/** True when the visitor has asked their OS to reduce motion. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

export type DrawerSide = 'right' | 'left';
export type DrawerWidth = 'sm' | 'md' | 'lg' | 'xl';

const WIDTHS: Record<DrawerWidth, string> = {
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-md',
  lg: 'sm:max-w-2xl',
  xl: 'sm:max-w-4xl',
};

export interface DrawerProps {
  /** Whether the panel is on screen. The parent owns this state. */
  open: boolean;
  /** Called for Escape, backdrop click and the close button. */
  onClose: () => void;
  /** Announced as the dialog's accessible name. Always supply one. */
  title: string;
  /** Optional supporting line under the title; also the accessible description. */
  description?: string;
  /** Which edge the panel slides in from. Defaults to `right`. */
  side?: DrawerSide;
  /** Panel width on `sm` and up. Below that the drawer is always full width. */
  width?: DrawerWidth;
  /** Pinned to the bottom of the panel, outside the scrolling body. */
  footer?: ReactNode;
  /** Rendered beside the close button, e.g. a status badge or an overflow menu. */
  headerAction?: ReactNode;
  /** Element to focus on open. Defaults to the first focusable node in the panel. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Set false to keep a click on the backdrop from closing a half-filled form. */
  closeOnBackdropClick?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * Slide-over panel for detail views that must not lose the list behind them —
 * an invoice from the invoice table, a support ticket from the queue, a
 * customer from the CRM grid.
 *
 * It is a real modal dialog: focus moves in on open and is trapped until close,
 * Escape and the backdrop both dismiss, the page behind cannot scroll, and
 * focus returns to whatever opened it. Under `prefers-reduced-motion` the slide
 * is replaced by an instant show.
 *
 * Use a Drawer when the surrounding list is the context. Use a full page when
 * the record is the destination, and a `<dialog>`-style centred modal for a
 * short confirmation.
 *
 * ```tsx
 * const [selected, setSelected] = useState<Invoice | null>(null);
 * <Drawer open={!!selected} onClose={() => setSelected(null)} title={`Invoice ${selected?.number ?? ''}`}>
 *   <InvoiceDetail invoice={selected} />
 * </Drawer>
 * ```
 */
export function Drawer({
  open,
  onClose,
  title,
  description,
  side = 'right',
  width = 'lg',
  footer,
  headerAction,
  initialFocusRef,
  closeOnBackdropClick = true,
  children,
  className,
}: DrawerProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  // `mounted` gates the portal (there is no document during SSR). `rendered`
  // keeps the panel in the tree for the length of the exit transition, and
  // `entered` drives the transform so the browser has a frame to paint the
  // off-screen start position before it animates.
  const [mounted, setMounted] = useState(false);
  const [rendered, setRendered] = useState(open);
  const [entered, setEntered] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (open) {
      setRendered(true);
      const frame = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(frame);
    }
    setEntered(false);
    if (reducedMotion) {
      setRendered(false);
      return;
    }
    const timer = setTimeout(() => setRendered(false), 220);
    return () => clearTimeout(timer);
  }, [open, reducedMotion]);

  // Body scroll lock. The padding compensates for the scrollbar the lock
  // removes, so the page behind does not jump sideways as the drawer opens.
  useEffect(() => {
    if (!rendered) return;
    const { body, documentElement } = document;
    const previousOverflow = body.style.overflow;
    const previousPadding = body.style.paddingRight;
    const scrollbar = window.innerWidth - documentElement.clientWidth;

    body.style.overflow = 'hidden';
    if (scrollbar > 0) {
      const current = parseFloat(window.getComputedStyle(body).paddingRight) || 0;
      body.style.paddingRight = `${current + scrollbar}px`;
    }
    return () => {
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPadding;
    };
  }, [rendered]);

  // Move focus in on open, and put it back where it came from on close.
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const target = initialFocusRef?.current ?? focusableWithin(panel)[0] ?? panel;
      target.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      const previous = restoreFocusRef.current;
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [open, initialFocusRef]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const onPanelKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;

    const items = focusableWithin(panel);
    if (items.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }

    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  if (!mounted || !rendered) return null;

  const offScreen = side === 'right' ? 'translate-x-full' : '-translate-x-full';

  return createPortal(
    <div className="fixed inset-0 z-50" aria-hidden={!open}>
      <div
        onClick={closeOnBackdropClick ? onClose : undefined}
        className={cn(
          'absolute inset-0 bg-ink/40 transition-opacity duration-200 motion-reduce:transition-none',
          entered ? 'opacity-100' : 'opacity-0',
        )}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
        className={cn(
          'absolute inset-y-0 flex w-full flex-col bg-surface shadow-lift outline-none',
          'transition-transform duration-200 ease-out motion-reduce:transition-none',
          side === 'right' ? 'right-0 border-l border-line' : 'left-0 border-r border-line',
          WIDTHS[width],
          entered ? 'translate-x-0' : offScreen,
          className,
        )}
      >
        <header className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-base font-semibold text-ink">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="mt-0.5 text-sm text-muted">
                {description}
              </p>
            )}
          </div>
          {headerAction}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="btn-ghost -mr-2 shrink-0 rounded-lg p-2"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">{children}</div>

        {footer && (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-4">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
