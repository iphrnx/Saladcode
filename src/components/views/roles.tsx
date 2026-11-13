'use client'

import { useMemo, useState, useEffect } from 'react'
import { useApp, type Role, type User } from '@/components/app/data-context'
import { PERMISSION_GROUPS } from '@/lib/constants'
import { edgeFetch } from '@/lib/edge'
import { failIfNotOk, type ApiFailure } from '@/lib/api-error'
import { useAccessDenied } from '@/lib/use-access-denied'
import { AccessDenied } from '@/components/shared/access-denied'
import { canGrantRole, hasPermission, reservedRoleName, splitPermissions } from '@/lib/permissions'
import { expandPermissions, PERMISSION_IMPLICATIONS } from '@/lib/constants'
import { cn } from '@/lib/utils'
import { useScrollCollapse } from '@/lib/use-scroll-collapse'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Separator } from '@/components/ui/separator'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Shield, ShieldCheck, ShieldPlus, Users, Plus, Lock, Check, ChevronDown, ChevronRight, Save, Trash2, MoreVertical, Crown, KeyRound, UserPlus, Power, AlertTriangle, Loader2,
} from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { toast } from 'sonner'

const PRESET_COLORS = ['#f97316', '#4ade80', '#60a5fa', '#fbbf24', '#c084fc', '#f472b6', '#22d3ee', '#a78bfa']

function initials(name: string) {
  return name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase()
}

/** Roles store permissions as a comma string, but some legacy rows are JSON.
 *  This is the reading the server does, so the matrix and the guards agree. */
function parsePerms(permString: string | null | undefined): string[] {
  return splitPermissions(permString)
}

export function RolesView() {
  const { data, refresh } = useApp()
  // The staff list is the only load this view owns, and it lives in the staff
  // tab below — so the denial state is held here, where the whole screen can be
  // replaced by it, and the handlers are handed down to the writers.
  const { denied, setDenied, handleLoad, handleAction } = useAccessDenied()
  const { scrollRef, collapsed } = useScrollCollapse()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [staffCreateOpen, setStaffCreateOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<'roles' | 'staff'>('roles')

  const roles = data?.roles ?? []
  const users = data?.users ?? []
  const staff = data?.staff ?? []

  // Derive the effective selected role (falls back to first role when none selected / missing).
  const selectedRole = useMemo(() => {
    if (roles.length === 0) return null
    return roles.find((r) => r.id === selectedId) ?? roles[0]
  }, [roles, selectedId])

  const memberCounts = useMemo(() => {
    const map: Record<string, number> = {}
    for (const u of users) {
      const rid = u.roleId || ''
      if (rid) map[rid] = (map[rid] || 0) + 1
    }
    for (const s of staff) {
      const rid = s.roleId || ''
      if (rid) map[rid] = (map[rid] || 0) + 1
    }
    return map
  }, [users, staff])

  // Combine dashboard users and staff members assigned to the selected role
  const roleMembers = useMemo(() => {
    if (!selectedRole) return []
    const userMembers = users
      .filter((u) => u.roleId === selectedRole.id)
      .map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        type: 'user' as const,
      }))
    const staffMembers = staff
      .filter((s) => s.roleId === selectedRole.id)
      .map((s) => ({
        id: s.id,
        name: s.name,
        email: `ID: ${s.employeeId}`,
        type: 'staff' as const,
      }))
    return [...userMembers, ...staffMembers]
  }, [selectedRole, users, staff])

  const systemCount = roles.filter((r) => r.isSystem).length
  const customCount = roles.length - systemCount

  // The roles a staff.manage/roles.manage holder may actually assign: the
  // Owner role never, and any role whose permissions the caller does not hold
  // in full — the server would refuse those as an escalation, so the dropdowns
  // do not offer them.
  const callerPermissions = data?.permissions ?? []
  const grantableRoles = useMemo(
    () => roles.filter((r) => !(r.isSystem && r.name === 'Owner') && canGrantRole(parsePerms(r.permissions), callerPermissions)),
    [roles, callerPermissions],
  )

  // Managing roles and managing staff are separate keys, and a role can hold one
  // without the other — so each tab and each control asks for its own.
  const canManageRoles = hasPermission(data?.permissions, 'roles.manage')
  const canManageStaff = hasPermission(data?.permissions, 'staff.manage')
  const canViewRoles = hasPermission(data?.permissions, 'roles.view') || canManageRoles
  const canViewStaff = hasPermission(data?.permissions, 'staff.view') || canManageStaff

  // A role allowed only one of the two tabs must not be left on the other one.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the selected tab is derived from the permission list, not synchronised with an external system
    if (activeTab === 'roles' && !canViewRoles && canViewStaff) setActiveTab('staff')
    else if (activeTab === 'staff' && !canViewStaff && canViewRoles) setActiveTab('roles')
  }, [activeTab, canViewRoles, canViewStaff])

  const headers = {
    'x-tenant-id': data?.tenant.id ?? '',
    'content-type': 'application/json',
  }

  if (!data) return null

  // A refused staff load takes over the screen instead of rendering an empty
  // staff list, which would claim the restaurant has no staff accounts. Clearing
  // the denial remounts the staff section, whose effect loads again.
  if (denied) return <AccessDenied failure={denied} subject="roles and staff" onRetry={() => setDenied(null)} view="roles" />

  return (
    // Mobile: one page scroll. Everything flows — header, tabs, stats, pills,
    // detail — and only the role pills dock at the top once they reach it.
    // Desktop keeps the app-viewport layout with its own inner scrollers.
    // The shrink-0s below are load-bearing: an overflow-auto flex column
    // shrinks its children to fit before it ever scrolls, and any child with
    // overflow of its own has a zero automatic minimum — the stats grid was
    // flex-shrunk to its padding until they were pinned.
    <div className="h-full flex flex-col overflow-y-auto scrollbar-thin lg:overflow-hidden">
      {/* Header. The scroll collapse only engages on lg and up: on a phone the
          role pills sit directly below this block, and collapsing moved them
          ~170px mid-scroll — a jump the user reads as broken. Below lg the
          header stays put and only the permission sections scroll. */}
      <div className={cn(
        'shrink-0 px-3.5 md:px-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 sm:gap-3 transition-all duration-200 ease-out',
        collapsed ? 'pt-3 md:pt-6 pb-2.5 lg:pt-1.5 lg:pb-1.5' : 'pt-3 md:pt-6 pb-2.5',
      )}>
        <div>
          <h2 className={cn(
            'font-bold tracking-tight flex items-center gap-2 transition-all duration-200 ease-out',
            collapsed ? 'text-lg' : 'text-lg md:text-2xl',
          )}>
            <Shield className={cn('text-primary transition-all duration-200 ease-out', collapsed ? 'h-5 w-5' : 'h-5 w-5 md:h-6 md:w-6')} />
            Role Access
          </h2>
          <div className={cn(
            'overflow-hidden transition-all duration-200 ease-out',
            collapsed ? 'max-h-8 opacity-100 lg:max-h-0 lg:opacity-0' : 'max-h-8 opacity-100',
          )}>
            <p className="text-sm text-muted-foreground mt-0.5">Manage staff roles and granular permissions</p>
          </div>
        </div>
        {/* Tabs and the action button stack on phones. Side by side they cannot
            both fit at 390px — the tab labels are nowrap, so the row overran the
            viewport and the button was clipped rather than wrapped. */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
          {/* Tab toggle: Roles & Permissions vs Staff Accounts.
              flex-1 on phones so the pair shares the row with the button rather
              than wrapping its labels onto two lines. Shown only when both tabs
              are open to the role — a toggle with one live button is not a
              choice, and the other tab would be a dead end. */}
          {canViewRoles && canViewStaff && (
            <div className="inline-flex flex-1 sm:flex-none rounded-xl bg-secondary/50 border border-border p-0.5">
              <button
                onClick={() => setActiveTab('roles')}
                className={cn(
                  'flex flex-1 sm:flex-none items-center justify-center gap-1.5 rounded-lg px-2.5 sm:px-3 py-1.5 min-h-8 text-xs font-medium whitespace-nowrap transition-premium',
                  activeTab === 'roles' ? 'bg-primary text-white shadow-glow-primary' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Shield className="h-3.5 w-3.5 shrink-0" /> Roles & Permissions
              </button>
              <button
                onClick={() => setActiveTab('staff')}
                className={cn(
                  'flex flex-1 sm:flex-none items-center justify-center gap-1.5 rounded-lg px-2.5 sm:px-3 py-1.5 min-h-8 text-xs font-medium whitespace-nowrap transition-premium',
                  activeTab === 'staff' ? 'bg-primary text-white shadow-glow-primary' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Users className="h-3.5 w-3.5 shrink-0" /> Staff Accounts
              </button>
            </div>
          )}
          {activeTab === 'roles'
            ? canManageRoles && (
                <Button onClick={() => setCreateOpen(true)} className="bg-primary hover:bg-primary/90 shrink-0 whitespace-nowrap w-full sm:w-auto">
                  <Plus className="h-4 w-4" />
                  Create Role
                </Button>
              )
            : canManageStaff && (
                <Button onClick={() => setStaffCreateOpen(true)} className="bg-primary hover:bg-primary/90 shrink-0 whitespace-nowrap w-full sm:w-auto">
                  <UserPlus className="h-4 w-4" />
                  Add Staff
                </Button>
              )}
        </div>
      </div>

      {/* Top stats — collapse away to free up vertical room when scrolled,
          on lg and up only; below lg they stay so the role pills never jump. */}
      <div className={cn(
        'shrink-0 overflow-hidden transition-all duration-200 ease-out px-3.5 md:px-6 grid grid-cols-2 md:grid-cols-4 gap-3',
        // The expanded height has to clear the tallest layout this grid takes.
        // It is one row from md up, but two rows on a phone — and the cap has
        // to match the compact cards, or the collapse animation leaves a gap
        // where the cards used to be.
        collapsed ? 'max-h-[8.5rem] md:max-h-20 opacity-100 pb-3 lg:max-h-0 lg:opacity-0 lg:pb-0' : 'max-h-[8.5rem] md:max-h-20 opacity-100 pb-3',
      )}>
        <StatCard icon={<Shield className="h-3.5 w-3.5 sm:h-4 sm:w-4" />} label="Total Roles" value={roles.length} tint="#f97316" />
        <StatCard icon={<ShieldCheck className="h-3.5 w-3.5 sm:h-4 sm:w-4" />} label="System Roles" value={systemCount} tint="#4ade80" />
        <StatCard icon={<ShieldPlus className="h-3.5 w-3.5 sm:h-4 sm:w-4" />} label="Custom Roles" value={customCount} tint="#60a5fa" />
        <StatCard icon={<Users className="h-3.5 w-3.5 sm:h-4 sm:w-4" />} label="Total Staff" value={staff.length} tint="#fbbf24" />
      </div>

      {/* Two-column layout (desktop) + horizontal pills (mobile). On mobile the
          wrapper is a plain block so the page scrolls as one; the lg: chain
          restores the bounded app-viewport layout on desktop. */}
      {activeTab === 'roles' && (
      <div className="lg:flex-1 lg:min-h-0 lg:overflow-hidden px-3.5 md:px-6 pb-4 md:pb-6">
        {/* Mobile: horizontal scrollable role pills + detail below */}
        <div className="lg:hidden flex flex-col gap-3">
          {/* The pills ride the page scroll and dock under the shell header
              once they reach it. -mt-3 + pt-3 keeps the unstuck gap to the
              stats pixel-identical while the opaque band gives cards a
              covered strip to slide under; pb-3 + -mb-3 does the same below.
              Scrolls on its own horizontally, so a long role list never
              widens the page. */}
          <div className="sticky top-0 z-20 -mt-3 -mb-3 bg-background pt-3 pb-3 -mx-3.5 px-3.5 overflow-x-auto overscroll-x-contain scrollbar-thin">
            <div className="flex gap-1.5 py-1 w-max min-w-full">
              {roles.map((role) => {
                const active = role.id === (selectedRole?.id ?? null)
                return (
                  <button
                    key={role.id}
                    onClick={() => setSelectedId(role.id)}
                    className={cn(
                      'shrink-0 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[13px] transition-all min-h-[32px]',
                      active
                        ? 'border-primary/50 bg-primary/10 text-foreground ring-1 ring-primary/30'
                        : 'border-border bg-secondary/40 text-foreground hover:bg-secondary',
                    )}
                  >
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: role.color }} />
                    <span className="font-medium whitespace-nowrap">{role.name}</span>
                    {role.isSystem && <Lock className="h-2.5 w-2.5 text-muted-foreground shrink-0" />}
                    <span className="text-[11px] text-muted-foreground whitespace-nowrap">({memberCounts[role.id] || 0})</span>
                  </button>
                )
              })}
              {canManageRoles && (
                <button
                  onClick={() => setCreateOpen(true)}
                  className="shrink-0 inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-1.5 text-[13px] text-muted-foreground hover:text-primary hover:border-primary/40 transition-colors min-h-[32px]"
                >
                  <Plus className="h-3 w-3" />
                  <span className="whitespace-nowrap">New</span>
                </button>
              )}
            </div>
          </div>
          <div>
            {selectedRole ? (
              <RoleDetail
                role={selectedRole}
                members={roleMembers}
                allRoles={roles}
                headers={headers}
                refresh={refresh}
                scrollRef={scrollRef}
                canManageRoles={canManageRoles}
                canManageStaff={canManageStaff}
                grantableKeys={callerPermissions}
                handleAction={handleAction}
              />
            ) : (
              <Card className="rounded-2xl bg-card border-border flex items-center justify-center">
                <div className="text-center">
                  <Shield className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-50" />
                  <p className="text-sm text-muted-foreground">Select a role to view details</p>
                </div>
              </Card>
            )}
          </div>
        </div>

        {/* Desktop: sidebar list + detail */}
        <div className="hidden lg:grid lg:grid-cols-3 gap-4 h-full">
          {/* Left: role list */}
          <Card className="lg:col-span-1 rounded-2xl bg-card border-border p-3 flex flex-col gap-2 overflow-hidden">
            <div className="flex items-center justify-between px-1 pb-1">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Roles</h3>
              <span className="text-xs text-muted-foreground">{roles.length} total</span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin -mx-1 px-1">
              <div className="space-y-1.5 pr-1">
                {roles.map((role) => (
                  <RoleListItem
                    key={role.id}
                    role={role}
                    memberCount={memberCounts[role.id] || 0}
                    active={role.id === (selectedRole?.id ?? null)}
                    onClick={() => setSelectedId(role.id)}
                  />
                ))}
                {canManageRoles && (
                  <button
                    onClick={() => setCreateOpen(true)}
                    className="w-full mt-2 flex items-center justify-center gap-2 rounded-xl border border-dashed border-border text-muted-foreground hover:text-primary hover:border-primary/40 py-2.5 text-sm transition-colors"
                  >
                    <Plus className="h-4 w-4" />
                    Create Role
                  </button>
                )}
              </div>
            </div>
          </Card>

          {/* Right: detail */}
          <div className="lg:col-span-2 min-h-0">
            {selectedRole ? (
              <RoleDetail
                role={selectedRole}
                members={roleMembers}
                allRoles={roles}
                headers={headers}
                refresh={refresh}
                scrollRef={scrollRef}
                canManageRoles={canManageRoles}
                canManageStaff={canManageStaff}
                grantableKeys={callerPermissions}
                handleAction={handleAction}
              />
            ) : (
              <Card className="rounded-2xl bg-card border-border h-full flex items-center justify-center">
                <div className="text-center">
                  <Shield className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-50" />
                  <p className="text-sm text-muted-foreground">Select a role to view details</p>
                </div>
              </Card>
            )}
          </div>
        </div>
      </div>
      )}

      {/* Staff Accounts tab */}
      {activeTab === 'staff' && (
        <StaffAccountsSection
          headers={headers}
          roles={grantableRoles}
          tenantId={data.tenant.id}
          refresh={refresh}
          createOpen={staffCreateOpen}
          setCreateOpen={setStaffCreateOpen}
          handleLoad={handleLoad}
          handleAction={handleAction}
          setDenied={setDenied}
        />
      )}

      {/* Create dialog */}
      <CreateRoleDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        headers={headers}
        handleAction={handleAction}
        onCreated={(newRole) => {
          setSelectedId(newRole.id)
          refresh()
        }}
      />
    </div>
  )
}

function StatCard({ icon, label, value, tint }: { icon: React.ReactNode; label: string; value: number; tint: string }) {
  return (
    // The Card primitive ships with py-6 and gap-6, which is a lot of air for a
    // number and a label. Both are overridden here, and the type and the icon
    // are sized for a phone — four of these used to take a third of the
    // screen.
    <Card className="rounded-2xl bg-card border-border p-2.5 gap-0 sm:p-3">
      <div className="flex items-center gap-2.5 sm:gap-3">
        <div
          className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center shrink-0"
          style={{ backgroundColor: `${tint}1a`, color: tint }}
        >
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-lg sm:text-xl font-bold leading-none">{value}</p>
          <p className="text-[10.5px] sm:text-xs text-muted-foreground mt-0.5 leading-tight truncate">{label}</p>
        </div>
      </div>
    </Card>
  )
}

function RoleListItem({ role, memberCount, active, onClick }: { role: Role; memberCount: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left rounded-xl border p-3 transition-all',
        active
          ? 'border-primary/50 bg-primary/10 ring-1 ring-primary/30'
          : 'border-border bg-secondary/40 hover:bg-secondary hover:border-border'
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className="mt-1 w-3 h-3 rounded-full shrink-0 ring-2 ring-background"
          style={{ backgroundColor: role.color }}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-medium text-sm truncate">{role.name}</p>
            {role.isSystem && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 bg-secondary/80">
                <Lock className="h-2.5 w-2.5" />
                SYSTEM
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
            {role.description || 'No description'}
          </p>
          <div className="flex items-center gap-1 mt-1.5">
            <Users className="h-3 w-3 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">{memberCount} member{memberCount !== 1 ? 's' : ''}</span>
          </div>
        </div>
      </div>
    </button>
  )
}

type RoleMember = {
  id: string
  name: string
  email: string
  type?: 'user' | 'staff'
}

function RoleDetail({
  role,
  members,
  allRoles,
  headers,
  refresh,
  scrollRef,
  canManageRoles,
  canManageStaff,
  grantableKeys,
  handleAction,
}: {
  role: Role
  members: RoleMember[]
  allRoles: Role[]
  headers: Record<string, string>
  refresh: () => Promise<void>
  scrollRef?: React.RefObject<HTMLDivElement | null>
  /** Editing a role — its name, colour, permissions — needs `roles.manage`. */
  canManageRoles: boolean
  /** Reassigning a member to another role needs `staff.manage`. */
  canManageStaff: boolean
  /** The caller's effective permissions — keys it may not grant are locked. */
  grantableKeys: string[]
  handleAction: (error: unknown, subject: string) => void
}) {
  const [permState, setPermState] = useState<string[]>(() => parsePerms(role.permissions))
  const [name, setName] = useState(role.name)
  const [description, setDescription] = useState(role.description || '')
  const [color, setColor] = useState(role.color)
  const [saving, setSaving] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState('')

  // `.manage` implies its `.view`: the matrix shows and counts the *effective*
  // set, so a settings.manage-only role reads "Settings 2/2" and really can
  // open Settings — the same expansion the server applies to the session.
  const effectivePerms = useMemo(() => expandPermissions(permState), [permState])
  // A *rename* onto a built-in role's name is blocked (the server refuses it
  // too); an existing custom role that already carries such a name is left
  // alone, and its other fields remain editable.
  const reserved = name !== role.name ? reservedRoleName(name) : null
  // The caller may only grant keys they themselves hold — the server refuses
  // the rest as an escalation. For the owner (who holds everything) this is a
  // no-op, so nothing on the Owner's own matrix is ever locked by it.
  const viewerCanGrant = (perm: string) => grantableKeys.includes(perm)
  const impliedByManage = (perm: string) =>
    Object.entries(PERMISSION_IMPLICATIONS).find(([, v]) => v === perm)?.[0] ?? null

  // Re-sync when role changes
  useEffect(() => {
    setPermState(parsePerms(role.permissions))
    setName(role.name)
    setDescription(role.description || '')
    setColor(role.color)
  }, [role.id, role.permissions, role.name, role.description, role.color])

  const isSystem = role.isSystem
  const dirty = useMemo(() => {
    const original = parsePerms(role.permissions)
    const samePerms = original.length === permState.length && original.every((p) => permState.includes(p))
    return !samePerms || name !== role.name || description !== (role.description || '') || color !== role.color
  }, [permState, name, description, color, role])

  const togglePerm = (key: string) => {
    if (isSystem || !canManageRoles) return
    setPermState((prev) => (prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key]))
  }

  const toggleGroup = (groupPerms: readonly string[], on: boolean) => {
    if (isSystem || !canManageRoles) return
    setPermState((prev) => {
      if (on) return Array.from(new Set([...prev, ...groupPerms]))
      return prev.filter((p) => !groupPerms.includes(p))
    })
  }

  const save = async () => {
    setSaving(true)
    try {
      const res = await edgeFetch(`/api/roles/${role.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ name, description, permissions: permState, color }),
      })
      await failIfNotOk(res, 'the role')
      toast.success('Role updated')
      await refresh()
    } catch (err) {
      handleAction(err, 'the role')
    } finally {
      setSaving(false)
    }
  }

  const removeRole = async () => {
    if (deleteConfirm !== role.name) {
      toast.error(`Type "${role.name}" to confirm`)
      return
    }
    setSaving(true)
    try {
      const res = await edgeFetch(`/api/roles/${role.id}`, {
        method: 'DELETE',
        headers,
      })
      // A 409 ("role still has members") carries the server's own explanation,
      // which `handleAction` keeps for every failure that is not about permission.
      await failIfNotOk(res, 'the role')
      toast.success('Role deleted')
      setDeleteOpen(false)
      setDeleteConfirm('')
      await refresh()
    } catch (err) {
      handleAction(err, 'the role')
    } finally {
      setSaving(false)
    }
  }

  const assignRole = async (member: RoleMember, newRoleId: string) => {
    if (!canManageStaff) return
    try {
      if (member.type === 'staff') {
        const res = await edgeFetch(`/api/staff/manage/${member.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ roleId: newRoleId }),
        })
        await failIfNotOk(res, 'the staff account')
      }
      toast.success(`${member.name}'s role updated`, { description: `Now assigned as ${allRoles.find((r) => r.id === newRoleId)?.name ?? 'new role'}` })
      await refresh()
    } catch (err) {
      handleAction(err, 'the staff account')
    }
  }

  return (
    // Natural height on mobile — the page scrolls, not the card. The lg:
    // chain restores the bounded card with its own scroller on desktop.
    <Card className="rounded-2xl bg-card border-border lg:h-full flex flex-col overflow-hidden py-0 gap-0">
      {/* Role header */}
      <div className="p-3 sm:p-4 border-b border-border flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 sm:gap-3 min-w-0 flex-1">
          <span
            className="mt-1 w-3.5 h-3.5 sm:w-4 sm:h-4 rounded-full shrink-0 ring-2 ring-background"
            style={{ backgroundColor: color }}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-base sm:text-lg leading-tight truncate">{role.name}</h3>
              {isSystem && (
                <Badge variant="secondary" className="text-[10px] h-4 px-1.5 bg-secondary/80">
                  <Lock className="h-2.5 w-2.5" />
                  System Role
                </Badge>
              )}
            </div>
            <p className="text-[13px] sm:text-sm text-muted-foreground mt-0.5 line-clamp-2">{description || 'No description provided'}</p>
          </div>
        </div>
        {!isSystem && canManageRoles && (
          <Button variant="ghost" size="icon" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setDeleteOpen(true)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>

      <div ref={scrollRef} className="lg:flex-1 lg:min-h-0 lg:overflow-y-auto scrollbar-thin">
        <div className="p-3 sm:p-4 space-y-3.5 sm:space-y-5">
          {/* Role meta */}
          <div className="grid sm:grid-cols-2 gap-2.5 sm:gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Role Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isSystem || !canManageRoles}
                className="bg-secondary/50 border-border"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Color</Label>
              <div className="flex items-center gap-2 flex-wrap">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    disabled={!canManageRoles}
                    onClick={() => setColor(c)}
                    className={cn(
                      'w-7 h-7 sm:w-7 sm:h-7 rounded-full ring-2 ring-offset-2 ring-offset-card transition-all disabled:opacity-40',
                      color === c ? 'ring-foreground scale-110' : 'ring-transparent hover:scale-105'
                    )}
                    style={{ backgroundColor: c }}
                  >
                    {color === c && <Check className="h-3 w-3 sm:h-3.5 sm:w-3.5 text-white mx-auto" />}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={!canManageRoles}
              rows={2}
              className="bg-secondary/50 border-border resize-none"
              placeholder="What can this role do?"
            />
          </div>

          {isSystem && (
            <div className="flex items-start gap-2 rounded-xl bg-secondary/50 border border-border p-3 text-xs text-muted-foreground">
              <Lock className="h-4 w-4 mt-0.5 shrink-0 text-amber-400" />
              <span>System role — its name and permissions are fixed, but its description and colour can be edited.</span>
            </div>
          )}

          {/* Permission matrix */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold">Permissions Matrix</h4>
              <span className="text-xs text-muted-foreground">{effectivePerms.length} enabled</span>
            </div>
            {effectivePerms.includes('dashboard.view') !== effectivePerms.includes('tables.view') && (
              <p className="text-[11px] text-amber-600/90 dark:text-amber-400/90 mb-3">
                Dashboard is the point-of-sale screen: it opens only with both
                Dashboard <em>and</em> Tables &amp; QR → View checked.
              </p>
            )}
            <div className="grid sm:grid-cols-2 gap-3">
              {PERMISSION_GROUPS.map((group) => {
                const enabledCount = group.perms.filter((p) => effectivePerms.includes(p)).length
                const allOn = enabledCount === group.perms.length
                return (
                  <Collapsible key={group.label} defaultOpen className="rounded-xl border border-border bg-secondary/30">
                    <div className="flex items-center justify-between p-3">
                      <CollapsibleTrigger asChild>
                        <button className="flex items-center gap-2 text-sm font-medium flex-1">
                          {allOn ? (
                            <Check className="h-4 w-4 text-emerald-400" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          )}
                          {group.label}
                          <span className="text-xs text-muted-foreground">({enabledCount}/{group.perms.length})</span>
                        </button>
                      </CollapsibleTrigger>
                      {!isSystem && canManageRoles && (
                        <button
                          type="button"
                          onClick={() => toggleGroup(group.perms, !allOn)}
                          className="text-xs text-primary hover:underline"
                        >
                          {allOn ? 'Clear all' : 'Select all'}
                        </button>
                      )}
                    </div>
                    <CollapsibleContent>
                      <div className="px-3 pb-3 space-y-1 border-t border-border/50 pt-3">
                        {group.perms.map((perm) => {
                          const held = effectivePerms.includes(perm)
                          // Ticked because a .manage the role holds implies it —
                          // unchecking is meaningless while the .manage is on.
                          const implied = held && !permState.includes(perm)
                          // The caller holds roles.manage but not this key; the
                          // server would refuse the grant as an escalation.
                          const ungrantable =
                            !isSystem && canManageRoles && !viewerCanGrant(perm)
                          const locked = isSystem || !canManageRoles || implied || (!isSystem && ungrantable)
                          return (
                          <label
                            key={perm}
                            className={cn(
                              'flex items-center gap-2.5 text-sm rounded-md px-2 py-2 min-h-[40px]',
                              locked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-secondary/60'
                            )}
                            title={
                              implied
                                ? `Included with ${impliedByManage(perm) ?? 'its manage key'}`
                                : ungrantable
                                  ? 'You cannot grant this permission — you do not hold it'
                                  : undefined
                            }
                          >
                            <Checkbox
                              checked={held}
                              onCheckedChange={() => togglePerm(perm)}
                              disabled={locked}
                            />
                            <span className="font-mono text-xs break-all">{perm}</span>
                            {implied && <Lock className="h-3 w-3 text-muted-foreground shrink-0 ml-auto" />}
                          </label>
                          )
                        })}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                )
              })}
            </div>
          </div>

          <Separator />

          {/* Members */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                Members
                <span className="text-xs text-muted-foreground font-normal">({members.length})</span>
              </h4>
            </div>
            {members.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-4 md:p-6 text-center">
                <Users className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-50" />
                <p className="text-sm text-muted-foreground">No staff assigned to this role yet</p>
              </div>
            ) : (
              <div className="space-y-2">
                {members.map((u) => (
                  <div key={u.id} className="flex items-center gap-3 rounded-xl border border-border bg-secondary/30 p-2.5">
                    <Avatar className="h-9 w-9 border border-border">
                      <AvatarFallback className="bg-secondary text-xs font-medium" style={{ color: role.color }}>
                        {initials(u.name)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{u.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                    </div>
                    {/* Static: a member is the account that registered the
                        restaurant, and the Owner role is exclusive to it. The
                        dropdown this replaces never sent a request for members,
                        so it only claimed the role had changed. */}
                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: role.color }}
                      />
                      <span className="truncate">{role.name}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Save bar. A role without `roles.manage` still reads the matrix above,
          but there is nothing here for them to save. System roles get it too,
          so their description and colour — the fields the server lets them
          edit — can be saved. */}
      {canManageRoles && (
        <div className="border-t border-border p-3 flex items-center justify-between gap-2 bg-card/60">
          <p className="text-xs text-muted-foreground">
            {dirty ? 'You have unsaved changes' : 'All changes saved'}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={!dirty || saving || (isSystem ? false : !!reserved)}
              onClick={() => {
                setPermState(parsePerms(role.permissions))
                setName(role.name)
                setDescription(role.description || '')
                setColor(role.color)
              }}
            >
              Discard
            </Button>
            <Button size="sm" disabled={!dirty || saving} onClick={save} className="bg-primary hover:bg-primary/90">
              {saving ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Saving…</> : <><Save className="h-3.5 w-3.5" /> Save Changes</>}
            </Button>
          </div>
        </div>
      )}

      {/* Delete dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="bg-card border-border max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-destructive" />
              Delete role
            </DialogTitle>
            <DialogDescription>
              This will permanently remove the <strong className="text-foreground">{role.name}</strong> role. Staff assigned to it will need to be reassigned.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">
              Type <span className="font-mono text-foreground">{role.name}</span> to confirm
            </Label>
            <Input
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder={role.name}
              className="bg-secondary/50 border-border"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={removeRole} disabled={saving || deleteConfirm !== role.name}>
              {saving ? 'Deleting…' : 'Delete Role'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function CreateRoleDialog({
  open,
  onOpenChange,
  headers,
  handleAction,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  headers: Record<string, string>
  handleAction: (error: unknown, subject: string) => void
  onCreated: (role: Role) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState(PRESET_COLORS[0])
  const [perms, setPerms] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const reset = () => {
    setName('')
    setDescription('')
    setColor(PRESET_COLORS[0])
    setPerms([])
  }

  const reserved = reservedRoleName(name)

  const submit = async () => {
    if (!name.trim()) {
      toast.error('Role name is required')
      return
    }
    if (reserved) {
      toast.error(`"${reserved}" is a built-in role name`)
      return
    }
    setSaving(true)
    try {
      const res = await edgeFetch('/api/roles', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: name.trim(), description: description.trim(), permissions: perms, color }),
      })
      await failIfNotOk(res, 'the role')
      const role: Role = await res.json()
      toast.success('Role created')
      reset()
      onOpenChange(false)
      onCreated(role)
    } catch (err) {
      handleAction(err, 'the role')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o) }}>
      <DialogContent className="bg-card border-border max-w-lg max-h-[85vh] overflow-y-auto scrollbar-thin">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldPlus className="h-4 w-4 text-primary" />
            Create New Role
          </DialogTitle>
          <DialogDescription>Define a new staff role with custom permissions.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="role-name">Role name</Label>
            <Input
              id="role-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Shift Manager"
              className="bg-secondary/50 border-border"
            />
            {reserved && (
              <p className="text-[11px] text-amber-600/90 dark:text-amber-400/90 mt-1">
                "{reserved}" is a built-in role name — pick a different one.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="role-desc">Description</Label>
            <Textarea
              id="role-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="What does this role do?"
              className="bg-secondary/50 border-border resize-none"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Color</Label>
            <div className="flex items-center gap-2 flex-wrap">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={cn(
                    'w-7 h-7 rounded-full ring-2 ring-offset-2 ring-offset-card transition-all',
                    color === c ? 'ring-foreground scale-110' : 'ring-transparent hover:scale-105'
                  )}
                  style={{ backgroundColor: c }}
                >
                  {color === c && <Check className="h-3.5 w-3.5 text-white mx-auto" />}
                </button>
              ))}
            </div>
          </div>

          <Separator />

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Permissions</Label>
              <span className="text-xs text-muted-foreground">{perms.length} selected</span>
            </div>
            <div className="max-h-64 overflow-y-auto scrollbar-thin space-y-2 pr-1">
              {PERMISSION_GROUPS.map((group) => {
                const enabledCount = group.perms.filter((p) => perms.includes(p)).length
                const allOn = enabledCount === group.perms.length
                return (
                  <Collapsible key={group.label} className="rounded-lg border border-border bg-secondary/30">
                    <div className="flex items-center justify-between p-2.5">
                      <CollapsibleTrigger asChild>
                        <button className="flex items-center gap-2 text-sm font-medium flex-1">
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                          {group.label}
                          <span className="text-xs text-muted-foreground">({enabledCount}/{group.perms.length})</span>
                        </button>
                      </CollapsibleTrigger>
                      <button
                        type="button"
                        onClick={() => {
                          if (allOn) setPerms((prev) => prev.filter((p) => !(group.perms as readonly string[]).includes(p)))
                          else setPerms((prev) => Array.from(new Set([...prev, ...group.perms])))
                        }}
                        className="text-xs text-primary hover:underline"
                      >
                        {allOn ? 'Clear' : 'All'}
                      </button>
                    </div>
                    <CollapsibleContent>
                      <div className="px-2.5 pb-2.5 space-y-1 border-t border-border/50 pt-2">
                        {group.perms.map((perm) => (
                          <label key={perm} className="flex items-center gap-2.5 text-sm cursor-pointer hover:bg-secondary/60 rounded-md px-2 py-2 min-h-[40px]">
                            <Checkbox
                              checked={perms.includes(perm)}
                              onCheckedChange={() => {
                                setPerms((prev) => (prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm]))
                              }}
                            />
                            <span className="font-mono text-xs break-all">{perm}</span>
                          </label>
                        ))}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                )
              })}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving || !name.trim() || !!reserved} className="bg-primary hover:bg-primary/90">
            {saving ? 'Creating…' : <><Plus className="h-3.5 w-3.5" /> Create Role</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Staff Accounts Section ───────────────────────────────────────────────
function StaffAccountsSection({ headers, roles, tenantId, refresh, createOpen, setCreateOpen, handleLoad, handleAction, setDenied }: {
  headers: Record<string, string>
  roles: Role[]
  tenantId: string
  refresh: () => Promise<void>
  createOpen: boolean
  setCreateOpen: (v: boolean) => void
  handleLoad: (error: unknown, subject: string) => boolean
  handleAction: (error: unknown, subject: string) => void
  setDenied: (failure: ApiFailure | null) => void
}) {
  const { data } = useApp()
  const [staff, setStaff] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [resetStaff, setResetStaff] = useState<any | null>(null)
  const [newPin, setNewPin] = useState('')
  const [deleteStaff, setDeleteStaff] = useState<any | null>(null)
  // In-flight feedback for every staff mutation. `creating`/`resettingPin`/
  // `deleting` drive the dialog buttons; `rowBusy` names the one card whose
  // toggle/role change is in flight, so that row's controls spin and the rest
  // of its actions are disabled against duplicate requests.
  const [creating, setCreating] = useState(false)
  const [resettingPin, setResettingPin] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [rowBusy, setRowBusy] = useState<{ id: string; action: 'toggle' | 'role' } | null>(null)

  // Creating, reassigning, deactivating or deleting a staff account is
  // `staff.manage`; reading the list is `staff.view`. A role can hold the second
  // without the first, so the controls below ask before they render.
  const canManageStaff = hasPermission(data?.permissions, 'staff.manage')

  // The server refuses to act on an account that holds a permission the caller
  // does not — including the caller's own role, because `staff.manage` is held
  // by Manager and the role a Manager would move themselves to is the
  // escalation. The card does not offer what the server will refuse: the role
  // selector is dead on your own row, and every action is dead on a row that
  // outranks you.
  // The owner shell names the caller `currentStaff`; the staff shell's `/me`
  // sends the caller as a single `staff` object instead. Either way, the card
  // carries the row's own id, so both shells can recognise it.
  const myStaffId =
    data?.currentStaff?.id ??
    (data?.staff && !Array.isArray(data.staff) ? (data.staff as any).id : null) ??
    null
  const myPermissions = data?.permissions ?? []
  const outOfReach = (s: any) => {
    const role = (data?.roles ?? []).find((r) => r.id === s.roleId)
    return parsePerms(role?.permissions).some((p) => !myPermissions.includes(p))
  }

  // Form state for new staff
  const [form, setForm] = useState({ name: '', employeeId: '', roleId: '', pin: '' })

  const load = async () => {
    setLoading(true)
    try {
      const res = await edgeFetch('/api/staff/manage', { headers })
      await failIfNotOk(res, 'staff accounts')
      const json = await res.json()
      setStaff(Array.isArray(json) ? json : [])
      // A retry that succeeds clears the Access Denied screen above.
      setDenied(null)
    } catch (err) {
      // A 403 is a permission the role does not hold, not a restaurant with no
      // staff — so say so instead of rendering the empty state.
      handleLoad(err, 'staff accounts')
      setStaff([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleCreate = async () => {
    if (!form.name.trim() || !form.employeeId.trim() || !form.pin) {
      toast.error('Name, employee ID, and PIN are required')
      return
    }
    setCreating(true)
    try {
      const res = await edgeFetch('/api/staff/manage', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: form.name.trim(),
          employeeId: form.employeeId.trim(),
          roleId: form.roleId || null,
          pin: form.pin,
          active: true,
        }),
      })
      // A duplicate employee ID (409) carries the server's own message, which
      // `handleAction` keeps for every failure that is not about permission.
      await failIfNotOk(res, 'the staff account')
      toast.success(`Staff account created for ${form.name}`)
      setForm({ name: '', employeeId: '', roleId: '', pin: '' })
      setCreateOpen(false)
      await load()
      await refresh()
    } catch (err) {
      handleAction(err, 'the staff account')
    } finally {
      setCreating(false)
    }
  }

  const handleToggleActive = async (s: any) => {
    if (rowBusy) return
    setRowBusy({ id: s.id, action: 'toggle' })
    try {
      const res = await edgeFetch(`/api/staff/manage/${s.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ active: !s.active }),
      })
      await failIfNotOk(res, 'the staff account')
      toast.success(`${s.name} ${s.active ? 'deactivated' : 'activated'}`)
      await load()
      await refresh()
    } catch (err) {
      handleAction(err, 'the staff account')
    } finally {
      setRowBusy(null)
    }
  }

  const handleChangeRole = async (s: any, roleId: string) => {
    if (rowBusy) return
    setRowBusy({ id: s.id, action: 'role' })
    try {
      const res = await edgeFetch(`/api/staff/manage/${s.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ roleId: roleId || null }),
      })
      await failIfNotOk(res, 'the staff account')
      toast.success(`${s.name}'s role updated`)
      await load()
      await refresh()
    } catch (err) {
      handleAction(err, 'the staff account')
    } finally {
      setRowBusy(null)
    }
  }

  const handleResetPin = async () => {
    if (!resetStaff || !newPin) return
    if (!/^\d{4}$/.test(newPin)) { toast.error('PIN must be 4 digits'); return }
    setResettingPin(true)
    try {
      const res = await edgeFetch(`/api/staff/manage/${resetStaff.id}/reset-pin`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ pin: newPin }),
      })
      await failIfNotOk(res, 'the staff account')
      toast.success(`PIN reset for ${resetStaff.name}`)
      setResetStaff(null)
      setNewPin('')
      await load()
      await refresh()
    } catch (err) {
      handleAction(err, 'the staff account')
    } finally {
      setResettingPin(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteStaff) return
    setDeleting(true)
    try {
      const res = await edgeFetch(`/api/staff/manage/${deleteStaff.id}`, { method: 'DELETE', headers })
      await failIfNotOk(res, 'the staff account')
      toast.success(`${deleteStaff.name} deleted`)
      setDeleteStaff(null)
      await load()
      await refresh()
    } catch (err) {
      handleAction(err, 'the staff account')
    } finally {
      setDeleting(false)
    }
  }

  return (
    // Mobile: flow inside the one page scroll — the same pattern as the Roles
    // tab. A nested flex-1/min-h-0/overflow-y-auto here turned the section into
    // its own scroll container on phones, which clipped the staff cards and the
    // login banner behind a restricted internal scrollbar. Only on lg does the
    // section become the bounded, self-scrolling panel of the app-viewport
    // layout.
    <div className="lg:flex-1 lg:min-h-0 lg:overflow-y-auto scrollbar-thin px-3.5 md:px-6 pb-4 md:pb-6">
      <div className="max-w-4xl space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" />
              Staff Accounts
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Create PIN-based accounts for staff to access the POS via the staff login screen
            </p>
          </div>
        </div>

        {/* Staff list */}
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map(i => <div key={i} className="h-20 rounded-2xl bg-secondary/30 animate-pulse" />)}
          </div>
        ) : staff.length === 0 ? (
          <Card className="rounded-2xl bg-card border-border p-8 text-center">
            <Users className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-50" />
            <p className="text-sm font-medium">No staff accounts yet</p>
            <p className="text-xs text-muted-foreground mt-1">Create staff accounts so they can log in with a PIN</p>
            {canManageStaff && (
              <Button onClick={() => setCreateOpen(true)} className="mt-4 bg-primary hover:bg-primary/90">
                <UserPlus className="h-4 w-4 mr-1.5" /> Add First Staff Member
              </Button>
            )}
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {staff.map((s) => (
              <Card key={s.id} className={cn('rounded-2xl bg-card border-border p-4', !s.active && 'opacity-60')}>
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold shrink-0"
                      style={{ backgroundColor: `${s.roleColor}20`, color: s.roleColor }}>
                      {s.name.split(' ').map(n => n[0]).slice(0, 2).join('')}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm font-medium truncate">{s.name}</p>
                        {s.lockedUntil && new Date(s.lockedUntil) > new Date() && (
                          <Lock className="h-3 w-3 text-amber-500" />
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">ID: {s.employeeId}</p>
                    </div>
                  </div>
                  <Badge variant="secondary" style={{ backgroundColor: `${s.roleColor}15`, color: s.roleColor }}>
                    {s.roleName}
                  </Badge>
                </div>

                {/* Status + last login */}
                <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-3">
                  <span className={cn('inline-flex items-center gap-1', s.active ? 'text-emerald-400' : 'text-red-400')}>
                    <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: s.active ? '#4ade80' : '#ef4444' }} />
                    {s.active ? 'Active' : 'Inactive'}
                  </span>
                  {s.lastLogin && <span>Last login: {new Date(s.lastLogin).toLocaleDateString()}</span>}
                </div>

                {/* Actions. Reassigning, resetting a PIN, deactivating and
                    deleting are all `staff.manage` — a role with only
                    `staff.view` reads the card and nothing else. */}
                {canManageStaff && (
                  <div className="flex items-center gap-1.5">
                    {/* Role selector — disabled and spinning while this row's
                        role change is in flight, so a second pick cannot race
                        the first. */}
                    <Select
                      value={s.roleId || ''}
                      onValueChange={(v) => handleChangeRole(s, v)}
                      disabled={s.id === myStaffId || outOfReach(s) || rowBusy?.id === s.id}
                    >
                      <SelectTrigger
                        className="h-8 text-xs bg-secondary/50 border-border flex-1"
                        title={
                          s.id === myStaffId
                            ? 'You cannot change your own role'
                            : outOfReach(s)
                              ? 'That account holds permissions you do not'
                              : undefined
                        }
                      >
                        {rowBusy?.id === s.id && rowBusy?.action === 'role' ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                        ) : (
                          <SelectValue placeholder="Role" />
                        )}
                      </SelectTrigger>
                      <SelectContent>
                        {roles.filter(r => !(r.isSystem && r.name === 'Owner')).map(r => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                      </SelectContent>
                    </Select>

                    <Button variant="outline" size="sm" className="h-8 px-2" disabled={outOfReach(s) || !!rowBusy} title={outOfReach(s) ? 'That account holds permissions you do not' : undefined} onClick={() => { setResetStaff(s); setNewPin('') }}>
                      <KeyRound className="h-3.5 w-3.5" />
                    </Button>

                    <Button variant="outline" size="sm" className="h-8 px-2" disabled={outOfReach(s) || !!rowBusy} title={outOfReach(s) ? 'That account holds permissions you do not' : undefined} onClick={() => handleToggleActive(s)}>
                      {rowBusy?.id === s.id && rowBusy?.action === 'toggle' ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Power className="h-3.5 w-3.5" />
                      )}
                    </Button>

                    <Button variant="outline" size="sm" className="h-8 px-2 text-destructive hover:text-destructive" disabled={outOfReach(s) || !!rowBusy} title={outOfReach(s) ? 'That account holds permissions you do not' : undefined} onClick={() => setDeleteStaff(s)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}

                {/* Lockout warning */}
                {s.failedAttempts > 0 && s.failedAttempts < 5 && (
                  <p className="text-[10px] text-amber-500 mt-2">{s.failedAttempts}/5 failed attempts</p>
                )}
                {s.lockedUntil && new Date(s.lockedUntil) > new Date() && (
                  <p className="text-[10px] text-red-400 mt-2">Locked until {new Date(s.lockedUntil).toLocaleTimeString()}</p>
                )}
              </Card>
            ))}
          </div>
        )}

        {/* Info banner */}
        <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
              <KeyRound className="h-4 w-4 text-primary" />
            </div>
            <div>
              <p className="text-sm font-medium">Staff login screen</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Staff can log in at <code className="bg-secondary px-1.5 py-0.5 rounded text-primary">/?view=staff-login&tenant={data?.tenant?.slug || data?.tenant?.id || ''}</code> using their employee ID and 4-digit PIN.
              </p>
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => window.open(`/?view=staff-login&tenant=${data?.tenant?.slug || data?.tenant?.id || ''}`, '_blank')}
            className="text-xs h-8 shrink-0 bg-background/60 hover:bg-background"
          >
            Open Staff Login ↗
          </Button>
        </div>
      </div>

      {/* Create staff dialog */}
      <Dialog open={createOpen} onOpenChange={(o) => { if (!creating) setCreateOpen(o) }}>
        <DialogContent className="sm:max-w-md bg-card">
          <DialogHeader>
            <DialogTitle>Add Staff Account</DialogTitle>
            <DialogDescription>Create a PIN-based login for a staff member</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Name *</Label>
              <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Raj Kumar" className="bg-secondary/50 border-border" autoFocus disabled={creating} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Employee ID / Username *</Label>
              <Input value={form.employeeId} onChange={e => setForm(f => ({ ...f, employeeId: e.target.value }))}
                placeholder="e.g. raj001" className="bg-secondary/50 border-border" disabled={creating} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Role</Label>
              <Select value={form.roleId} onValueChange={v => setForm(f => ({ ...f, roleId: v }))} disabled={creating}>
                <SelectTrigger className="bg-secondary/50 border-border"><SelectValue placeholder="Select role" /></SelectTrigger>
                <SelectContent>
                  {roles.filter(r => !(r.isSystem && r.name === 'Owner')).map(r => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">4-Digit PIN *</Label>
              <Input value={form.pin} onChange={e => setForm(f => ({ ...f, pin: e.target.value.replace(/\D/g, '').slice(0, 4) }))}
                placeholder="••••" maxLength={4} inputMode="numeric" className="bg-secondary/50 border-border text-center text-2xl tracking-[0.5em]" disabled={creating} />
              <p className="text-[11px] text-muted-foreground">PIN is hashed and stored securely. Never shared in plaintext.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={creating}>Cancel</Button>
            <Button onClick={handleCreate} disabled={creating} className="bg-primary hover:bg-primary/90">
              {creating ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Creating…</> : <><UserPlus className="h-4 w-4 mr-1.5" /> Create Account</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset PIN dialog */}
      <Dialog open={!!resetStaff} onOpenChange={(o) => { if (!resettingPin) setResetStaff(null) }}>
        <DialogContent className="sm:max-w-sm bg-card">
          <DialogHeader>
            <DialogTitle>Reset PIN — {resetStaff?.name}</DialogTitle>
            <DialogDescription>Enter a new 4-digit PIN for this staff member</DialogDescription>
          </DialogHeader>
          <Input value={newPin} onChange={e => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder="••••" maxLength={4} inputMode="numeric" className="bg-secondary/50 border-border text-center text-2xl tracking-[0.5em]" autoFocus disabled={resettingPin} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setResetStaff(null)} disabled={resettingPin}>Cancel</Button>
            <Button onClick={handleResetPin} disabled={newPin.length !== 4 || resettingPin} className="bg-primary hover:bg-primary/90">
              {resettingPin ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Resetting…</> : <><KeyRound className="h-4 w-4 mr-1.5" /> Reset PIN</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteStaff} onOpenChange={(o) => { if (!deleting) setDeleteStaff(null) }}>
        <AlertDialogContent className="bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Delete {deleteStaff?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the staff account and all related sessions. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting} className="bg-destructive text-white hover:bg-destructive/90">
              {deleting ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Deleting…</> : 'Delete Account'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
