'use client'

import { useMemo, useState } from 'react'
import { useApp, type PromoCode } from '@/components/app/data-context'
import { cn } from '@/lib/utils'
import { type DateFormatPattern } from '@/lib/date-format'
import { useScrollCollapse } from '@/lib/use-scroll-collapse'
import { edgeFetch } from '@/lib/edge'
import { failIfNotOk } from '@/lib/api-error'
import { useAccessDenied } from '@/lib/use-access-denied'
import { AccessDeniedForView } from '@/components/shared/access-denied'
import { canView, hasPermission } from '@/lib/permissions'
import {
  getISTDateString,
  getPromoStatus,
  normalizePromoCode,
  normalizePromoType,
  toISTDateString,
  type PromoStatus,
} from '@/lib/promo'
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
  AlertCircle,
} from 'lucide-react'

interface PromoFormState {
  code: string
  description: string
  type: string
  value: string
  minOrder: string
  maxDiscount: string
  usageLimit: string
  validFrom: string
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
  validFrom: '',
  validTo: '',
  active: true,
}

export function PromosView() {
  const { data, refresh } = useApp()
  const { handleAction } = useAccessDenied()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'expired'>('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<PromoCode | null>(null)
  const [form, setForm] = useState<PromoFormState>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<PromoCode | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const { scrollRef, collapsed } = useScrollCollapse()

  const promos = data?.promos ?? []
  const tenant = data?.tenant
  const currency = tenant?.currencySymbol ?? '$'
  const dateFormat = (data?.settings?.pref_date_format as DateFormatPattern) || 'DD/MM/YYYY'
  const canManage = hasPermission(data?.permissions, 'promos.manage')

  const todayIST = getISTDateString()

  // ACTIVE KPI counts only getPromoStatus(promo) === 'active'
  const stats = useMemo(() => {
    const total = promos.length
    const active = promos.filter((p) => getPromoStatus(p) === 'active').length
    const redemptions = promos.reduce((s, p) => s + p.usedCount, 0)
    return { total, active, redemptions }
  }, [promos])

  // Filters: All, Active, Expired; combined with search
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return promos.filter((p) => {
      const status = getPromoStatus(p)
      if (statusFilter === 'active' && status !== 'active') {
        return false
      }
      if (statusFilter === 'expired' && status !== 'expired') {
        return false
      }
      if (!q) return true
      return (
        p.code.toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q)
      )
    })
  }, [promos, search, statusFilter])

  if (!data || !tenant) return null

  if (!canView(data.permissions, 'promos')) {
    return <AccessDeniedForView view="promos" />
  }

  const openCreate = () => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setFormError(null)
    setDialogOpen(true)
  }

  const openEdit = (p: PromoCode) => {
    setEditing(p)
    setForm({
      code: p.code,
      description: p.description || '',
      type: normalizePromoType(p.type) ?? 'PERCENTAGE',
      value: String(p.value ?? ''),
      minOrder: String(p.minOrder ?? 0),
      maxDiscount: String(p.maxDiscount ?? 0),
      usageLimit: String(p.usageLimit ?? 0),
      validFrom: p.validFrom ? toISTDateString(p.validFrom) || '' : '',
      validTo: p.validTo ? toISTDateString(p.validTo) || '' : '',
      active: p.active,
    })
    setFormError(null)
    setDialogOpen(true)
  }

  const setField = <K extends keyof PromoFormState>(key: K, value: PromoFormState[K]) => {
    setForm((f) => {
      const next = { ...f, [key]: value }
      // If switching from PERCENTAGE to FLAT, reset maxDiscount to 0 to prevent stale hidden fields on create
      if (key === 'type' && (value === 'FLAT' || value === 'FIXED') && !editing) {
        next.maxDiscount = '0'
      }
      return next
    })
    if (formError) setFormError(null)
  }

  const handleSave = async () => {
    if (saving) return
    setFormError(null)

    const normalizedCode = normalizePromoCode(form.code)
    if (!normalizedCode) {
      const err = 'Promo code is required'
      setFormError(err)
      toast.error(err)
      return
    }

    // Normalized-code uniqueness check within current restaurant scope
    const isDuplicate = promos.some(
      (p) => p.id !== editing?.id && normalizePromoCode(p.code) === normalizedCode,
    )
    if (isDuplicate) {
      const err = `A promo code with code "${normalizedCode}" already exists`
      setFormError(err)
      toast.error(err)
      return
    }

    const value = parseFloat(form.value)
    if (Number.isNaN(value) || value <= 0) {
      const err = 'Enter a valid discount value greater than 0'
      setFormError(err)
      toast.error(err)
      return
    }

    if (form.type === 'PERCENTAGE' && (value <= 0 || value > 100)) {
      const err = 'Percentage discount must be between 0 and 100%'
      setFormError(err)
      toast.error(err)
      return
    }

    const validFrom = form.validFrom.trim() || null
    const validTo = form.validTo.trim() || null

    if (validFrom && validTo && validTo < validFrom) {
      const err = 'Valid Until cannot be earlier than Valid From'
      setFormError(err)
      toast.error(err)
      return
    }

    // Permit date correction without allowing an already-expired promo to be enabled through an invalid save
    if (validTo && todayIST > validTo && form.active) {
      const err = 'Extend Valid Until to reactivate this code.'
      setFormError(err)
      toast.error(err)
      return
    }

    const normalizedType = normalizePromoType(form.type) ?? 'PERCENTAGE'
    const body = {
      code: normalizedCode,
      description: form.description.trim() || null,
      type: normalizedType,
      value,
      minOrder: Math.max(0, parseFloat(form.minOrder) || 0),
      maxDiscount: normalizedType === 'PERCENTAGE'
        ? Math.max(0, parseFloat(form.maxDiscount) || 0)
        : (editing && Number(editing.maxDiscount) > 0 ? Number(editing.maxDiscount) : 0),
      usageLimit: Math.max(0, parseInt(form.usageLimit, 10) || 0),
      validFrom,
      validTo,
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
      setFormError(null)
      await refresh()
    } catch (err: any) {
      const msg = err?.message || 'Failed to save promo code'
      setFormError(msg)
      handleAction(err, 'promo codes')
    } finally {
      setSaving(false)
    }
  }

  const handleToggleActive = async (p: PromoCode) => {
    const status = getPromoStatus(p)
    // Expired or exhausted promos cannot be toggled directly
    if (status === 'expired' || status === 'exhausted') {
      return
    }
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

  const isEditingRedeemed = Boolean(editing && editing.usedCount > 0)
  const isEditingExpired = Boolean(editing && form.validTo && todayIST > form.validTo)

  return (
    <div className="h-full flex flex-col overscroll-contain">
      {/* Header — clean top row without duplicate heading */}
      <div
        className={cn(
          'px-3.5 md:px-6 transition-all duration-200 ease-out',
          collapsed ? 'pt-1.5 pb-1.5' : 'pt-3 md:pt-4 pb-2.5',
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 bg-secondary/60 rounded-xl px-3 py-1 flex-1 max-w-md">
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
          {canManage && (
            <Button size="sm" onClick={openCreate} className="shrink-0">
              <Plus className="h-4 w-4 mr-1" /> Create Promo
            </Button>
          )}
        </div>

        {/* Filter chips below search */}
        <div className="flex items-center gap-1.5 mt-2.5">
          {(['all', 'active', 'expired'] as const).map((filter) => {
            const label = filter === 'all' ? 'All' : filter === 'active' ? 'Active' : 'Expired'
            const isSelected = statusFilter === filter
            return (
              <button
                key={filter}
                onClick={() => setStatusFilter(filter)}
                className={cn(
                  'px-3 py-1 rounded-lg text-xs font-medium transition-colors',
                  isSelected
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground',
                )}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Stats — compact, responsive three-column layout */}
      <div
        className={cn(
          'px-3.5 md:px-6 transition-all duration-200 ease-out',
          collapsed
            ? 'max-h-0 pb-0 opacity-0 overflow-hidden'
            : 'max-h-40 pb-3 opacity-100',
        )}
      >
        <div className="grid grid-cols-3 gap-2">
          <StatChip icon={<Ticket className="h-3.5 w-3.5" />} label="Total Promos" value={String(stats.total)} />
          <StatChip
            icon={<CheckCircle2 className="h-3.5 w-3.5" />}
            label="Active"
            value={String(stats.active)}
          />
          <StatChip
            icon={<TrendingUp className="h-3.5 w-3.5" />}
            label="Redemptions"
            value={String(stats.redemptions)}
          />
        </div>
      </div>

      {/* Grid — pull-to-refresh contained within scrollable content container */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto overscroll-y-contain scrollbar-thin px-3.5 md:px-6 pb-4 md:pb-6"
      >
        {filtered.length === 0 ? (
          <EmptyPromos
            hasItems={promos.length > 0}
            isFiltered={statusFilter !== 'all' || search.trim().length > 0}
            canManage={canManage}
            onCreate={openCreate}
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 pt-1">
            {filtered.map((p) => (
              <PromoCard
                key={p.id}
                promo={p}
                currency={currency}
                dateFormat={dateFormat}
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

      {/* Create / Edit Dialog — constrained flex layout */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!saving) {
            setDialogOpen(open)
            if (!open) setFormError(null)
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl bg-card max-h-[85dvh] flex flex-col p-0 gap-0 overflow-hidden">
          <DialogHeader className="p-6 pb-4 shrink-0 border-b border-border/50">
            <DialogTitle>{editing ? 'Edit Promo Code' : 'Create Promo Code'}</DialogTitle>
            <DialogDescription>
              {editing
                ? 'Update the details of this promo code.'
                : 'Configure a new discount code for customers to use at checkout.'}
            </DialogDescription>
          </DialogHeader>

          {/* Form body */}
          <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-4">
            {isEditingExpired && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-500 flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>Extend Valid Until to reactivate this code.</span>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="p-code">Code *</Label>
                <Input
                  id="p-code"
                  value={form.code}
                  disabled={isEditingRedeemed || saving}
                  onChange={(e) => setField('code', normalizePromoCode(e.target.value))}
                  placeholder="SUMMER20"
                  className={cn(
                    'bg-secondary/50 border-0 font-mono uppercase tracking-wider',
                    isEditingRedeemed && 'opacity-70 cursor-not-allowed',
                  )}
                />
                {isEditingRedeemed && (
                  <p className="text-[11px] text-muted-foreground">
                    Code cannot be modified once redeemed.
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label>Type *</Label>
                <Select
                  value={form.type}
                  disabled={isEditingRedeemed || saving}
                  onValueChange={(v) => setField('type', v)}
                >
                  <SelectTrigger
                    className={cn(
                      'bg-secondary/50 border-0 w-full',
                      isEditingRedeemed && 'opacity-70 cursor-not-allowed',
                    )}
                  >
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PERCENTAGE">
                      <Percent className="h-3.5 w-3.5 mr-1 inline" /> Percentage
                    </SelectItem>
                    <SelectItem value="FLAT">
                      <IndianRupee className="h-3.5 w-3.5 mr-1 inline" /> Flat amount
                    </SelectItem>
                  </SelectContent>
                </Select>
                {isEditingRedeemed && (
                  <p className="text-[11px] text-muted-foreground">
                    Type cannot be modified once redeemed.
                  </p>
                )}
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
                    max={form.type === 'PERCENTAGE' ? '100' : undefined}
                    disabled={saving}
                    value={form.value}
                    onChange={(e) => setField('value', e.target.value)}
                    placeholder={form.type === 'PERCENTAGE' ? '20' : '5.00'}
                    className={cn('bg-secondary/50 border-0', form.type === 'PERCENTAGE' ? 'pr-8' : 'pl-7')}
                  />
                </div>
              </div>

              {/* Conditional Max Discount: only shown for percentage discounts */}
              {form.type === 'PERCENTAGE' ? (
                <div className="space-y-2">
                  <Label htmlFor="p-max">Max Discount ({currency})</Label>
                  <Input
                    id="p-max"
                    type="number"
                    step="0.01"
                    min="0"
                    disabled={saving}
                    value={form.maxDiscount}
                    onChange={(e) => setField('maxDiscount', e.target.value)}
                    placeholder="0 = no cap"
                    className="bg-secondary/50 border-0"
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="p-min">Min Order ({currency})</Label>
                  <Input
                    id="p-min"
                    type="number"
                    step="0.01"
                    min="0"
                    disabled={saving}
                    value={form.minOrder}
                    onChange={(e) => setField('minOrder', e.target.value)}
                    className="bg-secondary/50 border-0"
                  />
                </div>
              )}

              {/* Date fields: Valid From beside Valid Until */}
              <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Valid From</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="secondary"
                        disabled={saving}
                        className="h-10 w-full justify-start gap-2 bg-secondary/50 border-0 font-normal"
                      >
                        <CalendarIcon className="h-4 w-4 opacity-70 shrink-0" />
                        {form.validFrom ? formatDate(form.validFrom, dateFormat) : 'Immediate'}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-auto p-0">
                      <Calendar
                        mode="single"
                        selected={form.validFrom ? new Date(`${form.validFrom}T12:00:00`) : undefined}
                        onSelect={(d) => setField('validFrom', d ? formatDay(d) : '')}
                        defaultMonth={form.validFrom ? new Date(`${form.validFrom}T12:00:00`) : undefined}
                        className="p-3"
                      />
                      {form.validFrom && (
                        <div className="flex justify-end border-t border-border p-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 text-xs text-muted-foreground"
                            onClick={() => setField('validFrom', '')}
                          >
                            <X className="h-3.5 w-3.5 mr-1" /> Clear date
                          </Button>
                        </div>
                      )}
                    </PopoverContent>
                  </Popover>
                </div>

                <div className="space-y-2">
                  <Label>Valid Until</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="secondary"
                        disabled={saving}
                        className="h-10 w-full justify-start gap-2 bg-secondary/50 border-0 font-normal"
                      >
                        <CalendarIcon className="h-4 w-4 opacity-70 shrink-0" />
                        {form.validTo ? formatDate(form.validTo, dateFormat) : 'No expiry'}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-auto p-0">
                      <Calendar
                        mode="single"
                        selected={form.validTo ? new Date(`${form.validTo}T12:00:00`) : undefined}
                        onSelect={(d) => setField('validTo', d ? formatDay(d) : '')}
                        defaultMonth={form.validTo ? new Date(`${form.validTo}T12:00:00`) : undefined}
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
              </div>

              {form.type === 'PERCENTAGE' && (
                <div className="space-y-2">
                  <Label htmlFor="p-min-pct">Min Order ({currency})</Label>
                  <Input
                    id="p-min-pct"
                    type="number"
                    step="0.01"
                    min="0"
                    disabled={saving}
                    value={form.minOrder}
                    onChange={(e) => setField('minOrder', e.target.value)}
                    className="bg-secondary/50 border-0"
                  />
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="p-limit">Usage Limit</Label>
                <Input
                  id="p-limit"
                  type="number"
                  min="0"
                  disabled={saving}
                  value={form.usageLimit}
                  onChange={(e) => setField('usageLimit', e.target.value)}
                  placeholder="0 = unlimited"
                  className="bg-secondary/50 border-0"
                />
              </div>

              <div className="sm:col-span-2 space-y-2">
                <Label htmlFor="p-desc">Description</Label>
                <Textarea
                  id="p-desc"
                  disabled={saving}
                  value={form.description}
                  onChange={(e) => setField('description', e.target.value)}
                  placeholder="e.g. 20% off all summer menu items"
                  className="bg-secondary/50 border-0 min-h-16"
                />
              </div>

              <div className="sm:col-span-2 flex items-center justify-between rounded-xl bg-secondary/40 px-4 py-3">
                <div>
                  <p className="text-sm font-medium">Active</p>
                  <p className="text-xs text-muted-foreground">
                    {isEditingExpired
                      ? 'Extend Valid Until to reactivate this code.'
                      : 'When off, code cannot be redeemed'}
                  </p>
                </div>
                <Switch
                  checked={form.active}
                  disabled={saving}
                  onCheckedChange={(v) => setField('active', v)}
                />
              </div>
            </div>
          </div>

          {/* Footer with actionable validation error and action buttons */}
          <DialogFooter className="p-4 sm:p-6 shrink-0 border-t border-border/50 flex flex-col gap-2">
            {formError && (
              <div className="w-full text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-2.5 flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span className="flex-1">{formError}</span>
              </div>
            )}
            <div className="flex items-center justify-end gap-2 w-full">
              <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-1" /> Saving…
                  </>
                ) : editing ? (
                  'Save Changes'
                ) : (
                  'Create Promo'
                )}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent className="bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete promo code?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete{' '}
              <span className="font-mono font-semibold text-foreground">{deleteTarget?.code}</span>.
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

function formatDate(iso: string | null | undefined, pattern: DateFormatPattern = 'DD/MM/YYYY'): string {
  if (!iso) return '—'
  const dateStr = toISTDateString(iso)
  if (!dateStr) return '—'
  const [yyyy, mm, dd] = dateStr.split('-')
  switch (pattern) {
    case 'MM/DD/YYYY':
      return `${mm}/${dd}/${yyyy}`
    case 'YYYY-MM-DD':
      return `${yyyy}-${mm}-${dd}`
    case 'DD/MM/YYYY':
    default:
      return `${dd}/${mm}/${yyyy}`
  }
}

/** Local calendar date as deterministic 'YYYY-MM-DD' string. */
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
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5 flex items-center gap-2.5 sm:gap-3 min-w-0">
      <div className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0 bg-secondary text-muted-foreground">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground truncate">{label}</p>
        <p className="text-sm font-semibold truncate">{value}</p>
      </div>
    </div>
  )
}

function PromoCard({
  promo,
  currency,
  dateFormat = 'DD/MM/YYYY',
  toggling,
  canManage,
  onCopy,
  onEdit,
  onDelete,
  onToggle,
}: {
  promo: PromoCode
  currency: string
  dateFormat?: DateFormatPattern
  toggling: boolean
  canManage: boolean
  onCopy: () => void
  onEdit: () => void
  onDelete: () => void
  onToggle: () => void
}) {
  const status: PromoStatus = getPromoStatus(promo)
  const normalizedType = normalizePromoType(promo.type) ?? promo.type
  const isPercentage = normalizedType === 'PERCENTAGE'
  const usagePct =
    promo.usageLimit > 0 ? Math.min(100, Math.round((promo.usedCount / promo.usageLimit) * 100)) : 0
  const displayValue = isPercentage ? `${promo.value}%` : `${currency}${promo.value.toFixed(2)}`

  // Expired/exhausted cards must never show an enabled, ON-state Active toggle.
  const isToggleDisabled = toggling || !canManage || status === 'expired' || status === 'exhausted'
  const isToggleChecked = status === 'active'
  const toggleLabel = toggling
    ? 'Updating…'
    : status === 'expired'
    ? 'Expired'
    : status === 'exhausted'
    ? 'Limit Reached'
    : promo.active
    ? 'Active'
    : 'Paused'

  return (
    <div
      className={cn(
        'group relative rounded-2xl border border-border bg-card p-5 flex flex-col transition-all',
        'hover:border-primary/40 hover:shadow-lg hover:shadow-black/20',
        (status === 'expired' || status === 'paused' || status === 'exhausted') && 'opacity-90',
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
              {normalizedType}
            </Badge>
            <span className="text-sm font-semibold text-primary">{displayValue}</span>
            {status === 'expired' && (
              <Badge variant="outline" className="text-[10px] text-destructive border-destructive/40">
                Expired
              </Badge>
            )}
            {status === 'exhausted' && (
              <Badge variant="outline" className="text-[10px] text-amber-500 border-amber-500/40">
                Limit Reached
              </Badge>
            )}
            {status === 'paused' && (
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                Paused
              </Badge>
            )}
            {status === 'scheduled' && (
              <Badge variant="outline" className="text-[10px] text-blue-500 border-blue-500/40">
                Scheduled
              </Badge>
            )}
            {status === 'active' && (
              <Badge className="text-[10px] bg-green-500/15 text-green-400 border-0">Active</Badge>
            )}
          </div>
        </div>
      </div>

      {/* Description — rendered ONLY when non-empty */}
      {promo.description?.trim() ? (
        <p className="mt-3 text-sm text-muted-foreground line-clamp-2">
          {promo.description.trim()}
        </p>
      ) : null}

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
          {formatDate(promo.validFrom, dateFormat)} → {formatDate(promo.validTo, dateFormat)}
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
        <label
          className={cn(
            'flex items-center gap-2 text-xs text-muted-foreground min-w-0',
            isToggleDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
          )}
        >
          <Switch
            checked={isToggleChecked}
            onCheckedChange={() => {
              if (isToggleDisabled) return
              onToggle()
            }}
            disabled={isToggleDisabled}
            title={
              !canManage
                ? 'You do not have permission to manage promo codes'
                : status === 'expired'
                ? 'Expired promo codes cannot be toggled active. Extend Valid Until to reactivate.'
                : status === 'exhausted'
                ? 'This promo code has reached its usage limit.'
                : undefined
            }
          />
          <span className="truncate">{toggleLabel}</span>
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
  isFiltered,
  canManage,
  onCreate,
}: {
  hasItems: boolean
  isFiltered: boolean
  canManage: boolean
  onCreate: () => void
}) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center py-20">
      <div className="h-16 w-16 rounded-full bg-secondary flex items-center justify-center mb-4">
        <Gift className="h-7 w-7 text-muted-foreground" />
      </div>
      <h3 className="text-base font-semibold">
        {isFiltered ? 'No matching promo codes' : hasItems ? 'No promo codes found' : 'No promo codes yet'}
      </h3>
      <p className="text-sm text-muted-foreground mt-1 max-w-sm">
        {isFiltered
          ? 'Try adjusting your search or filters to find what you’re looking for.'
          : hasItems
          ? 'Try a different search to find the promo code you’re looking for.'
          : 'Create your first discount code to start tracking redemptions and rewarding customers.'}
      </p>
      {!hasItems && !isFiltered && canManage && (
        <Button className="mt-4" onClick={onCreate}>
          <Plus className="h-4 w-4 mr-1" /> Create First Promo
        </Button>
      )}
    </div>
  )
}

export default PromosView
