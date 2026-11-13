'use client'

import { useMemo, useState } from 'react'
import { useApp, type PromoCode } from '@/components/app/data-context'
import { cn } from '@/lib/utils'
import { useScrollCollapse } from '@/lib/use-scroll-collapse'
import { edgeFetch } from '@/lib/edge'
import { failIfNotOk } from '@/lib/api-error'
import { useAccessDenied } from '@/lib/use-access-denied'
import { AccessDeniedForView } from '@/components/shared/access-denied'
import { canView, hasPermission } from '@/lib/permissions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Calendar } from '@/components/ui/calendar'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { toast } from 'sonner'
import {
  Search,
  Plus,
  Pencil,
  Trash2,
  Copy,
  Percent,
  IndianRupee,
  Ticket,
  CheckCircle2,
  TrendingUp,
  CalendarClock,
  CalendarIcon,
  Loader2,
  Gift,
  X,
} from 'lucide-react'

interface PromoFormState {
  code: string
  description: string
  type: string
  value: string
  minOrder: string
  maxDiscount: string
  usageLimit: string
  validTo: string
  active: boolean
}

const EMPTY_FORM: PromoFormState = {
  code: '',
  description: '',
  type: 'PERCENTAGE',
  value: '',
  minOrder: '0',
  maxDiscount: '0',
  usageLimit: '100',
  validTo: '',
  active: true,
}

export function PromosView() {
  const { data, refresh } = useApp()
  const { handleAction } = useAccessDenied()
  const [search, setSearch] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<PromoCode | null>(null)
  const [form, setForm] = useState<PromoFormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<PromoCode | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const { scrollRef, collapsed } = useScrollCollapse()

  const promos = data?.promos ?? []
  const tenant = data?.tenant
  const currency = tenant?.currencySymbol ?? '$'
  // The `promos` function guards every write on `promos.manage`; the buttons
  // that reach those writes are gated on the same key so a custom role without
  // it is not offered an action the server will refuse.
  const canManage = hasPermission(data?.permissions, 'promos.manage')

  const stats = useMemo(() => {
    const total = promos.length
    const active = promos.filter((p) => p.active && !isExpired(p)).length
    const redemptions = promos.reduce((s, p) => s + p.usedCount, 0)
    return { total, active, redemptions }
  }, [promos])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return promos
    return promos.filter(
      (p) =>
        p.code.toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q),
    )
  }, [promos, search])

  // (scrollRef + collapsed come from useScrollCollapse above)
  if (!data || !tenant) return null

  // Promos arrive with the bootstrap payload rather than from a fetch in this
  // view, so there is no failed request to classify — the role's own permission
  // list is the only signal. A role that may not see promos gets the refusal
  // here, never the "No promo codes yet" empty state, which would be a claim
  // about the restaurant's promos rather than about the role.
  if (!canView(data.permissions, 'promos')) {
    return <AccessDeniedForView view="promos" />
  }

  const openCreate = () => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setDialogOpen(true)
  }

  const openEdit = (p: PromoCode) => {
    setEditing(p)
    setForm({
      code: p.code,
      description: p.description || '',
      type: p.type,
      value: String(p.value ?? ''),
      minOrder: String(p.minOrder ?? 0),
      maxDiscount: String(p.maxDiscount ?? 0),
      usageLimit: String(p.usageLimit ?? 0),
      validTo: p.validTo ? p.validTo.slice(0, 10) : '',
      active: p.active,
    })
    setDialogOpen(true)
  }

  const setField = <K extends keyof PromoFormState>(key: K, value: PromoFormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
  }

  const handleSave = async () => {
    if (!form.code.trim()) {
      toast.error('Promo code is required')
      return
    }
    const value = parseFloat(form.value)
    if (Number.isNaN(value) || value <= 0) {
      toast.error('Enter a valid value')
      return
    }
    const body = {
      code: form.code.trim().toUpperCase(),
      description: form.description.trim() || null,
      type: form.type,
      value,
      minOrder: parseFloat(form.minOrder) || 0,
      maxDiscount: parseFloat(form.maxDiscount) || 0,
      usageLimit: parseInt(form.usageLimit, 10) || 0,
      validTo: form.validTo || null,
      active: form.active,
    }
    setSaving(true)
    try {
      const headers = { 'content-type': 'application/json', 'x-tenant-id': tenant.id }
      let res: Response
      if (editing) {
        res = await edgeFetch(`/api/promos/${editing.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify(body),
        })
      } else {
        res = await edgeFetch('/api/promos', {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        })
      }
      await failIfNotOk(res, 'promo codes')
      toast.success(editing ? 'Promo updated' : 'Promo created')
      setDialogOpen(false)
      await refresh()
    } catch (err) {
      handleAction(err, 'promo codes')
    } finally {
      setSaving(false)
    }
  }

  const handleToggleActive = async (p: PromoCode) => {
    setTogglingId(p.id)
    try {
      const res = await edgeFetch(`/api/promos/${p.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-tenant-id': tenant.id },
        body: JSON.stringify({ active: !p.active }),
      })
      await failIfNotOk(res, 'promo codes')
      toast.success(!p.active ? 'Promo activated' : 'Promo paused')
      await refresh()
    } catch (err) {
      handleAction(err, 'promo codes')
    } finally {
      setTogglingId(null)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const res = await edgeFetch(`/api/promos/${deleteTarget.id}`, {
        method: 'DELETE',
        headers: { 'x-tenant-id': tenant.id },
      })
      await failIfNotOk(res, 'promo codes')
      toast.success('Promo deleted')
      setDeleteTarget(null)
      await refresh()
    } catch (err) {
      handleAction(err, 'promo codes')
    } finally {
      setDeleting(false)
    }
  }

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code)
      toast.success('Copied', { description: code })
    } catch {
      toast.error('Failed to copy')
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header — collapses on scroll to give promo cards more room */}
      <div
        className={cn(
          'px-3.5 md:px-6 transition-all duration-200 ease-out',
          collapsed ? 'pt-1.5 pb-1.5' : 'pt-3 md:pt-6 pb-2.5',
        )}
      >
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h1
              className={cn(
                'font-bold tracking-tight transition-all duration-200 ease-out',
                collapsed ? 'text-base md:text-lg' : 'text-lg md:text-2xl',
              )}
            >
              Promo Codes
            </h1>
            <p
              className={cn(
                'text-sm text-muted-foreground transition-all duration-200 ease-out',
                collapsed
                  ? 'max-h-0 opacity-0 overflow-hidden'
                  : 'max-h-8 opacity-100',
              )}
            >
              Create discount codes and track redemptions
            </p>
          </div>
          {canManage && (
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-4 w-4" /> Create Promo
            </Button>
          )}
        </div>

        {/* Search — collapses away when header is collapsed */}
        <div
          className={cn(
            'transition-all duration-200 ease-out',
            collapsed
              ? 'max-h-0 opacity-0 overflow-hidden mt-0'
              : 'max-h-20 opacity-100 mt-3',
          )}
        >
          <div className="flex items-center gap-2 bg-secondary/60 rounded-xl px-3 py-1 max-w-md">
            <Search className="h-4 w-4 text-muted-foreground shrink-0" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search promo codes…"
              className="bg-transparent outline-none text-sm h-8 flex-1 placeholder:text-muted-foreground"
            />
            {search && (
              <button onClick={() => setSearch('')} aria-label="Clear search">
                <X className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Stats — collapse away when header is collapsed */}
      <div
        className={cn(
          'px-3.5 md:px-6 transition-all duration-200 ease-out',
          collapsed
            ? 'max-h-0 pb-0 opacity-0 overflow-hidden'
            : 'max-h-40 pb-3 opacity-100',
        )}
      >
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <StatChip icon={<Ticket className="h-3.5 w-3.5" />} label="Total Promos" value={String(stats.total)} />
          <StatChip
            icon={<CheckCircle2 className="h-3.5 w-3.5" />}
            label="Active"
            value={String(stats.active)}
            accent
          />
          <StatChip
            icon={<TrendingUp className="h-3.5 w-3.5" />}
            label="Redemptions"
            value={String(stats.redemptions)}
          />
        </div>
      </div>

      {/* Grid */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin px-3.5 md:px-6 pb-4 md:pb-6">
        {filtered.length === 0 ? (
          <EmptyPromos hasItems={promos.length > 0} canManage={canManage} onCreate={openCreate} />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 pt-1">
            {filtered.map((p) => (
              <PromoCard
                key={p.id}
                promo={p}
                currency={currency}
                toggling={togglingId === p.id}
                canManage={canManage}
                onCopy={() => copyCode(p.code)}
                onEdit={() => openEdit(p)}
                onDelete={() => setDeleteTarget(p)}
                onToggle={() => handleToggleActive(p)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-2xl bg-card max-h-[85vh] overflow-y-auto scrollbar-thin">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Promo Code' : 'Create Promo Code'}</DialogTitle>
            <DialogDescription>
              {editing
                ? 'Update the details of this promo code.'
                : 'Configure a new discount code for customers to use at checkout.'}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="p-code">Code *</Label>
              <Input
                id="p-code"
                value={form.code}
                onChange={(e) => setField('code', e.target.value.toUpperCase())}
                placeholder="SUMMER20"
                className="bg-secondary/50 border-0 font-mono uppercase tracking-wider"
              />
            </div>

            <div className="space-y-2">
              <Label>Type *</Label>
              <Select value={form.type} onValueChange={(v) => setField('type', v)}>
                <SelectTrigger className="bg-secondary/50 border-0 w-full">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PERCENTAGE">
                    <Percent className="h-3.5 w-3.5 mr-1 inline" /> Percentage
                  </SelectItem>
                  <SelectItem value="FIXED">
                    <IndianRupee className="h-3.5 w-3.5 mr-1 inline" /> Fixed amount
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="p-value">Value *</Label>
              <div className="relative">
                {form.type === 'PERCENTAGE' ? (
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    %
                  </span>
                ) : (
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    {currency}
                  </span>
                )}
                <Input
                  id="p-value"
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.value}
                  onChange={(e) => setField('value', e.target.value)}
                  placeholder={form.type === 'PERCENTAGE' ? '20' : '5.00'}
                  className={cn('bg-secondary/50 border-0', form.type === 'PERCENTAGE' ? 'pr-8' : 'pl-7')}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Valid Until</Label>
              {/* The app's calendar replaces the native date input so the picker
                  matches the rest of the product. The value stays the same
                  'YYYY-MM-DD' string the server has always received. */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="secondary"
                    className="h-10 w-full justify-start gap-2 bg-secondary/50 border-0 font-normal"
                  >
                    <CalendarIcon className="h-4 w-4 opacity-70 shrink-0" />
                    {form.validTo ? formatDate(form.validTo) : 'No expiry'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-auto p-0">
                  <Calendar
                    mode="single"
                    selected={form.validTo ? new Date(`${form.validTo}T00:00:00`) : undefined}
                    onSelect={(d) => setField('validTo', d ? formatDay(d) : '')}
                    defaultMonth={form.validTo ? new Date(`${form.validTo}T00:00:00`) : undefined}
                    className="p-3"
                  />
                  {form.validTo && (
                    <div className="flex justify-end border-t border-border p-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 text-xs text-muted-foreground"
                        onClick={() => setField('validTo', '')}
                      >
                        <X className="h-3.5 w-3.5 mr-1" /> Clear date
                      </Button>
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            </div>

            <div className="sm:col-span-2 space-y-2">
              <Label htmlFor="p-desc">Description</Label>
              <Textarea
                id="p-desc"
                value={form.description}
                onChange={(e) => setField('description', e.target.value)}
                placeholder="e.g. 20% off all summer menu items"
                className="bg-secondary/50 border-0 min-h-16"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="p-min">Min Order ({currency})</Label>
              <Input
                id="p-min"
                type="number"
                step="0.01"
                min="0"
                value={form.minOrder}
                onChange={(e) => setField('minOrder', e.target.value)}
                className="bg-secondary/50 border-0"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="p-max">Max Discount ({currency})</Label>
              <Input
                id="p-max"
                type="number"
                step="0.01"
                min="0"
                value={form.maxDiscount}
                onChange={(e) => setField('maxDiscount', e.target.value)}
                placeholder="0 = no cap"
                className="bg-secondary/50 border-0"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="p-limit">Usage Limit</Label>
              <Input
                id="p-limit"
                type="number"
                min="0"
                value={form.usageLimit}
                onChange={(e) => setField('usageLimit', e.target.value)}
                placeholder="0 = unlimited"
                className="bg-secondary/50 border-0"
              />
            </div>

            <div className="sm:col-span-2 flex items-center justify-between rounded-xl bg-secondary/40 px-4 py-3">
              <div>
                <p className="text-sm font-medium">Active</p>
                <p className="text-xs text-muted-foreground">When off, code cannot be redeemed</p>
              </div>
              <Switch checked={form.active} onCheckedChange={(v) => setField('active', v)} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Saving…
                </>
              ) : editing ? (
                'Save Changes'
              ) : (
                'Create Promo'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent className="bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete promo code?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <span className="font-mono font-semibold text-foreground">{deleteTarget?.code}</span>.
              Customers will no longer be able to redeem it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Deleting…
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4" /> Delete
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/* ---------- helpers ---------- */

function isExpired(p: PromoCode): boolean {
  if (!p.validTo) return false
  return new Date(p.validTo).getTime() < Date.now()
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Local calendar date as the 'YYYY-MM-DD' string the API expects. */
function formatDay(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/* ---------- sub components ---------- */

function StatChip({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode
  label: string
  value: string
  accent?: boolean
}) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border px-3 py-2.5 flex items-center gap-3',
        accent ? 'bg-primary/10' : 'bg-card',
      )}
    >
      <div
        className={cn(
          'h-8 w-8 rounded-lg flex items-center justify-center shrink-0',
          accent ? 'bg-primary/20 text-primary' : 'bg-secondary text-muted-foreground',
        )}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="text-sm font-semibold truncate">{value}</p>
      </div>
    </div>
  )
}

function PromoCard({
  promo,
  currency,
  toggling,
  canManage,
  onCopy,
  onEdit,
  onDelete,
  onToggle,
}: {
  promo: PromoCode
  currency: string
  toggling: boolean
  canManage: boolean
  onCopy: () => void
  onEdit: () => void
  onDelete: () => void
  onToggle: () => void
}) {
  const expired = isExpired(promo)
  const isPercentage = promo.type === 'PERCENTAGE'
  const usagePct =
    promo.usageLimit > 0 ? Math.min(100, Math.round((promo.usedCount / promo.usageLimit) * 100)) : 0
  const displayValue = isPercentage ? `${promo.value}%` : `${currency}${promo.value.toFixed(2)}`

  return (
    <div
      className={cn(
        'group relative rounded-2xl border border-border bg-card p-5 flex flex-col transition-all',
        'hover:border-primary/40 hover:shadow-lg hover:shadow-black/20',
        (!promo.active || expired) && 'opacity-90',
      )}
    >
      {/* Top row: code + type */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <button
            onClick={onCopy}
            className="group/code flex items-center gap-2 text-left min-h-[36px] py-1"
            title="Click to copy"
          >
            <span className="font-mono text-xl font-bold uppercase tracking-wider break-all leading-tight">
              {promo.code}
            </span>
            <span className="opacity-0 group-hover/code:opacity-100 transition-opacity text-muted-foreground shrink-0">
              <Copy className="h-3.5 w-3.5" />
            </span>
          </button>
          <div className="mt-1.5 flex items-center gap-2 flex-wrap">
            <Badge
              variant={isPercentage ? 'default' : 'secondary'}
              className={cn('text-[10px] uppercase', !isPercentage && 'bg-secondary text-secondary-foreground')}
            >
              {isPercentage ? <Percent className="h-3 w-3" /> : <IndianRupee className="h-3 w-3" />}
              {promo.type}
            </Badge>
            <span className="text-sm font-semibold text-primary">{displayValue}</span>
            {expired ? (
              <Badge variant="outline" className="text-[10px] text-destructive border-destructive/40">
                Expired
              </Badge>
            ) : promo.active ? (
              <Badge className="text-[10px] bg-green-500/15 text-green-400 border-0">Active</Badge>
            ) : (
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                Paused
              </Badge>
            )}
          </div>
        </div>
      </div>

      {/* Description */}
      <p className="mt-3 text-sm text-muted-foreground line-clamp-2 min-h-[2.5rem]">
        {promo.description || 'No description provided.'}
      </p>

      {/* Usage progress */}
      <div className="mt-3">
        <div className="flex items-center justify-between text-xs mb-1.5">
          <span className="text-muted-foreground">Redemptions</span>
          <span className="font-medium">
            {promo.usedCount}
            {promo.usageLimit > 0 ? ` / ${promo.usageLimit}` : ' · Unlimited'}
          </span>
        </div>
        {promo.usageLimit > 0 ? (
          <div className="h-2 w-full rounded-full bg-secondary overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all"
              style={{ width: `${usagePct}%` }}
            />
          </div>
        ) : (
          <div className="h-2 w-full rounded-full bg-primary/15" />
        )}
      </div>

      {/* Validity */}
      <div className="mt-3 flex items-start gap-2 text-xs text-muted-foreground flex-wrap">
        <CalendarClock className="h-3.5 w-3.5 shrink-0 mt-0.5" />
        <span className="min-w-0">
          {formatDate(promo.validFrom)} → {formatDate(promo.validTo)}
        </span>
      </div>

      {/* Min order + max discount */}
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg bg-secondary/40 px-2.5 py-1.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Min Order</p>
          <p className="font-medium">
            {currency}
            {promo.minOrder.toFixed(2)}
          </p>
        </div>
        <div className="rounded-lg bg-secondary/40 px-2.5 py-1.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Max Discount</p>
          <p className="font-medium">
            {promo.maxDiscount > 0 ? `${currency}${promo.maxDiscount.toFixed(2)}` : 'No cap'}
          </p>
        </div>
      </div>

      <Separator className="my-3" />

      {/* Footer actions */}
      <div className="mt-auto flex items-center justify-between gap-2 flex-wrap">
        <label className="flex items-center gap-2 cursor-pointer text-xs text-muted-foreground min-w-0">
          {/* The toggle is the card's primary affordance, so it stays in place
              and is disabled rather than removed when the role may not write. */}
          <Switch
            checked={promo.active}
            onCheckedChange={onToggle}
            disabled={toggling || !canManage}
            title={canManage ? undefined : 'You do not have permission to manage promo codes'}
          />
          <span className="truncate">
            {toggling ? 'Updating…' : promo.active ? 'Active' : 'Paused'}
          </span>
        </label>
        <div className="flex items-center gap-1 shrink-0">
          <Button size="icon" variant="ghost" className="h-9 w-9" onClick={onCopy} aria-label="Copy code">
            <Copy className="h-4 w-4" />
          </Button>
          {canManage && (
            <Button size="icon" variant="ghost" className="h-9 w-9" onClick={onEdit} aria-label="Edit promo">
              <Pencil className="h-4 w-4" />
            </Button>
          )}
          {canManage && (
            <Button
              size="icon"
              variant="ghost"
              className="h-9 w-9 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
              onClick={onDelete}
              aria-label="Delete promo"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function EmptyPromos({
  hasItems,
  canManage,
  onCreate,
}: {
  hasItems: boolean
  canManage: boolean
  onCreate: () => void
}) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center py-20">
      <div className="h-16 w-16 rounded-full bg-secondary flex items-center justify-center mb-4">
        <Gift className="h-7 w-7 text-muted-foreground" />
      </div>
      <h3 className="text-base font-semibold">
        {hasItems ? 'No promo codes found' : 'No promo codes yet'}
      </h3>
      <p className="text-sm text-muted-foreground mt-1 max-w-sm">
        {hasItems
          ? 'Try a different search to find the promo code you’re looking for.'
          : 'Create your first discount code to start tracking redemptions and rewarding customers.'}
      </p>
      {!hasItems && canManage && (
        <Button className="mt-4" onClick={onCreate}>
          <Plus className="h-4 w-4" /> Create First Promo
        </Button>
      )}
    </div>
  )
}

export default PromosView
