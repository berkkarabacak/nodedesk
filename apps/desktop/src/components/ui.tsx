import { useEffect, useRef, type ReactNode } from 'react'

// Shared UI primitives for the redesign. All consume the design tokens via
// nd-* Tailwind classes; square corners and 2px dividers per SPEC §04.

export function Button({
  variant = 'primary',
  disabled,
  onClick,
  children,
  type = 'button',
  ariaLabel,
}: {
  variant?: 'primary' | 'secondary' | 'danger'
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
  type?: 'button' | 'submit'
  ariaLabel?: string
}) {
  const base =
    'px-5 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40'
  const styles = {
    primary: 'bg-nd-accent text-nd-on-accent hover:brightness-110',
    secondary: 'border-2 border-nd-divider text-nd-text hover:bg-nd-surface',
    danger: 'bg-nd-danger text-white hover:brightness-110',
  } as const
  return (
    <button type={type} aria-label={ariaLabel} disabled={disabled} onClick={onClick} className={`${base} ${styles[variant]}`}>
      {children}
    </button>
  )
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 border-2 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? 'border-nd-accent bg-nd-accent' : 'border-nd-divider bg-nd-surface'
      }`}
    >
      <span
        aria-hidden
        className={`absolute top-0.5 h-4 w-4 transition-transform ${
          checked ? 'translate-x-[22px] bg-nd-on-accent' : 'translate-x-0.5 bg-nd-dim'
        }`}
      />
    </button>
  )
}

/** Accessible modal dialog: focus trap, Escape cancels, focus restored on
 * close, backdrop click cancels (ACCESS-01). */
export function Dialog({
  title,
  onClose,
  children,
  labelledBy,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  labelledBy?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<Element | null>(null)
  const titleId = labelledBy ?? 'nd-dialog-title'

  useEffect(() => {
    restoreRef.current = document.activeElement
    const root = ref.current
    if (!root) return
    const focusables = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled'))
    const first = focusables()[0]
    ;(root.querySelector<HTMLElement>('input, select, textarea') ?? first)?.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) return
      const firstItem = items[0]
      const lastItem = items[items.length - 1]
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault()
        lastItem.focus()
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault()
        firstItem.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      ;(restoreRef.current as HTMLElement | null)?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md border-2 border-nd-divider bg-nd-bg p-6 shadow-[var(--nd-shadow)]"
      >
        <h2 id={titleId} className="text-lg font-bold">
          {title}
        </h2>
        {children}
      </div>
    </div>
  )
}

/** Square segmented control used for quality presets and theme choice. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  disabled,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  ariaLabel: string
  disabled?: boolean
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex border-2 border-nd-divider">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          disabled={disabled}
          onClick={() => onChange(opt.value)}
          className={`px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            value === opt.value ? 'bg-nd-text text-nd-bg' : 'text-nd-dim hover:bg-nd-surface'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

export function FieldRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-nd-rule py-4 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-semibold">{label}</p>
        {hint && <p className="mt-0.5 text-xs text-nd-dim">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/** Small status banner that never collapses distinct causes into one. */
export function Notice({ tone, children }: { tone: 'error' | 'info' | 'ok'; children: ReactNode }) {
  const styles = {
    error: 'border-nd-danger text-nd-danger',
    info: 'border-nd-divider text-nd-dim',
    ok: 'border-nd-ok text-nd-ok',
  } as const
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`border-2 bg-nd-surface px-4 py-3 text-sm ${styles[tone]}`}>
      {children}
    </div>
  )
}
