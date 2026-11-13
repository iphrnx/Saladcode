'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '@/components/app/data-context'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { Search, ClipboardList, BookOpen, Table2, LayoutGrid, BarChart3, QrCode, Ticket, Users, ShieldCheck, Settings, CornerDownLeft } from 'lucide-react'

interface Hit {
  id: string
  kind: 'page' | 'order' | 'dish' | 'table'
  label: string
  sub?: string
  view: string
  icon: typeof Search
}

const PAGES: Hit[] = [
  { id: 'p-dashboard', kind: 'page', label: 'POS Dashboard', sub: 'Take new orders', view: 'dashboard', icon: LayoutGrid },
  { id: 'p-orders', kind: 'page', label: 'Orders', sub: 'Manage active orders', view: 'orders', icon: ClipboardList },
  { id: 'p-analytics', kind: 'page', label: 'Analytics', sub: 'Revenue & insights', view: 'analytics', icon: BarChart3 },
  { id: 'p-menu', kind: 'page', label: 'Menu', sub: 'Manage dishes', view: 'menu', icon: BookOpen },
  { id: 'p-qr', kind: 'page', label: 'QR Codes', sub: 'Table QR codes', view: 'qr', icon: QrCode },
  { id: 'p-promos', kind: 'page', label: 'Promo Codes', sub: 'Discounts & coupons', view: 'promos', icon: Ticket },
  { id: 'p-roles', kind: 'page', label: 'Role Access', sub: 'Staff & permissions', view: 'roles', icon: Users },
  { id: 'p-security', kind: 'page', label: 'Security', sub: 'Sessions & logs', view: 'security', icon: ShieldCheck },
  { id: 'p-settings', kind: 'page', label: 'Settings', sub: 'Restaurant config', view: 'settings', icon: Settings },
]

/**
 * Search across the things a restaurant actually looks for: a page, an order,
 * a dish, a table.
 *
 * The bar used to be inert — an input with no value or handler, next to a
 * keyboard hint for a shortcut that was never bound. It now matches against the
 * data already loaded, focuses on Cmd/Ctrl+K, and navigates on Enter.
 *
 * The hint is spelled out in words rather than using the Command glyph, which
 * renders inconsistently and reads as a stray character on some systems.
 */
export function GlobalSearch() {
  const { data } = useApp()
  const { setView } = useStore()
  const t = useT()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [mod, setMod] = useState('Ctrl K')
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Set after mount so the server and first client render agree.
  useEffect(() => {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
    setMod(mac ? 'Cmd K' : 'Ctrl K')
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
        setOpen(true)
      }
      if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Close when clicking away.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [])

  const hits = useMemo<Hit[]>(() => {
    const q = query.trim().toLowerCase()
    if (!q) return PAGES.slice(0, 5)

    const out: Hit[] = []
    for (const p of PAGES) {
      if (p.label.toLowerCase().includes(q) || (p.sub ?? '').toLowerCase().includes(q)) out.push(p)
    }
    if (data) {
      for (const o of data.orders ?? []) {
        const num = `#${o.orderNumber}`
        const who = o.customerName ?? ''
        if (num.includes(q) || String(o.orderNumber) === q.replace('#', '') || who.toLowerCase().includes(q)) {
          out.push({
            id: `o-${o.id}`, kind: 'order', view: 'orders', icon: ClipboardList,
            label: `Order ${num}`, sub: [who, o.table?.name, o.status].filter(Boolean).join(' · '),
          })
        }
      }
      for (const m of data.menuItems ?? []) {
        if (m.name.toLowerCase().includes(q)) {
          out.push({ id: `m-${m.id}`, kind: 'dish', view: 'menu', icon: BookOpen, label: m.name, sub: m.available ? 'On the menu' : 'Unavailable' })
        }
      }
      for (const t of data.tables ?? []) {
        if (t.name.toLowerCase().includes(q)) {
          out.push({ id: `t-${t.id}`, kind: 'table', view: 'qr', icon: Table2, label: t.name, sub: t.area ?? 'Table' })
        }
      }
    }
    return out.slice(0, 8)
  }, [query, data])

  useEffect(() => { setActive(0) }, [query])

  const choose = (hit: Hit) => {
    setView(hit.view as never)
    setQuery('')
    setOpen(false)
    inputRef.current?.blur()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, hits.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter' && hits[active]) { e.preventDefault(); choose(hits[active]) }
  }

  return (
    <div className="hidden lg:block relative" ref={wrapRef}>
      <div className="flex items-center gap-2 bg-secondary/60 rounded-xl px-3 py-2 w-56 xl:w-64">
        <Search className="h-4 w-4 text-muted-foreground shrink-0" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={t('search.placeholder')}
          aria-label={t('search.label')}
          className="bg-transparent outline-none text-sm flex-1 min-w-0 placeholder:text-muted-foreground"
        />
        <kbd className="text-[10px] text-muted-foreground border border-border rounded px-1.5 py-0.5 shrink-0 whitespace-nowrap">
          {mod}
        </kbd>
      </div>

      {open && hits.length > 0 && (
        <div className="absolute right-0 top-full mt-2 w-[340px] rounded-xl border border-border bg-card shadow-2xl overflow-hidden z-50">
          <div className="max-h-[320px] overflow-y-auto overscroll-contain scrollbar-thin">
            {hits.map((h, i) => {
              const Icon = h.icon
              const group = h.kind === 'page' ? 'Pages' : h.kind === 'order' ? 'Orders' : h.kind === 'dish' ? 'Dishes' : 'Tables'
              const prev = i > 0 ? hits[i - 1].kind : null
              return (
                <div key={h.id}>
                  {h.kind !== prev && (
                    <p className="px-3 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{group}</p>
                  )}
                  <button
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(h)}
                    className={cn(
                      'w-full text-left px-3 py-2 flex items-center gap-2.5 transition-colors',
                      i === active ? 'bg-secondary' : 'hover:bg-secondary/60',
                    )}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium truncate">{h.label}</span>
                      {h.sub && <span className="block text-[11px] text-muted-foreground truncate">{h.sub}</span>}
                    </span>
                    {i === active && <CornerDownLeft className="h-3 w-3 shrink-0 text-muted-foreground" />}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {open && query.trim() && hits.length === 0 && (
        <div className="absolute right-0 top-full mt-2 w-[340px] rounded-xl border border-border bg-card shadow-2xl p-6 text-center z-50">
          <p className="text-sm text-muted-foreground">{t('search.nothing')} “{query.trim()}”.</p>
        </div>
      )}
    </div>
  )
}
