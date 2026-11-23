'use client'

import { useMemo, useState, useEffect, useCallback, useRef } from 'react'
import { useApp, type Role } from '@/components/app/data-context'
import {
  PERMISSION_GROUPS,
  PERMISSION_METADATA,
  type PermissionKey,
  canGrantRole,
  hasPermission,
  reservedRoleName,
  splitPermissions,
  expandPermissions,
  PERMISSION_IMPLICATIONS,
} from '@/lib/permissions'
import { edgeFetch } from '@/lib/edge'
import { failIfNotOk, type ApiFailure } from '@/lib/api-error'
import { useAccessDenied } from '@/lib/use-access-denied'
import { AccessDenied } from '@/components/shared/access-denied'
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
  Shield, ShieldCheck, ShieldPlus, Users, Plus, Lock, Check, ChevronDown, Save, Trash2,
  KeyRound, UserPlus, Power, AlertTriangle, Loader2, Copy,
} from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { toast } from 'sonner'

/** 8 distinct accessible preset colors with high contrast in light/dark themes */
const PRESET_COLORS = [
  '#f97316', // Orange
  '#4ade80', // Green
  '#60a5fa', // Blue
  '#fbbf24', // Amber/Yellow
  '#c084fc', // Purple
  '#f472b6', // Pink
  '#22d3ee', // Cyan
  '#e11d48', // Rose / Red (replaces duplicate purple swatch)
] as const

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
  const { denied, setDenied, handleLoad, handleAction } = useAccessDenied()
  const { scrollRef, collapsed } = useScrollCollapse()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [duplicateRoleData, setDuplicateRoleData] = useState<{
    name: string
    description: string
    color: string
    permissions: string[]
  } | null>(null)
  const [staffCreateOpen, setStaffCreateOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<'roles' | 'staff'>('roles')

  // Unsaved changes tracking across role and tab switches
  const [isDetailDirty, setIsDetailDirty] = useState(false)
  const [unsavedTarget, setUnsavedTarget] = useState<{ type: 'role'; id: string } | { type: 'tab'; tab: 'roles' | 'staff' } | null>(null)
  const [isSavingSwitch, setIsSavingSwitch] = useState(false)
  const [saveSwitchError, setSaveSwitchError] = useState<string | null>(null)
  const roleDetailSaveRef = useRef<(() => Promise<boolean>) | null>(null)
  const roleDetailDiscardRef = useRef<(() => void) | null>(null)

  const roles = data?.roles ?? []
  const users = data?.users ?? []
  const staff = data?.staff ?? []

  // Derive effective selected role (falls back to first role when none selected / missing).
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
  // PRESERVES original casing of names.
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

  const callerPermissions = data?.permissions ?? []
  const grantableRoles = useMemo(
    () => roles.filter((r) => !(r.isSystem && r.name === 'Owner') && canGrantRole(parsePerms(r.permissions), callerPermissions)),
    [roles, callerPermissions],
  )

  const canManageRoles = hasPermission(data?.permissions, 'roles.manage')
  const canManageStaff = hasPermission(data?.permissions, 'staff.manage')
  const canViewRoles = hasPermission(data?.permissions, 'roles.view') || canManageRoles
  const canViewStaff = hasPermission(data?.permissions, 'staff.view') || canManageStaff

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (activeTab === 'roles' && !canViewRoles && canViewStaff) setActiveTab('staff')
    else if (activeTab === 'staff' && !canViewStaff && canViewRoles) setActiveTab('roles')
  }, [activeTab, canViewRoles, canViewStaff])

  // Browser navigation warning when unsaved changes exist
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDetailDirty) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [isDetailDirty])

  const handleSelectRole = useCallback((roleId: string) => {
    if (roleId === selectedRole?.id) return
    if (isDetailDirty) {
      setSaveSwitchError(null)
      setUnsavedTarget({ type: 'role', id: roleId })
    } else {
      setSelectedId(roleId)
    }
  }, [selectedRole?.id, isDetailDirty])

  const handleTabChange = useCallback((tab: 'roles' | 'staff') => {
    if (tab === activeTab) return
    if (isDetailDirty) {
      setSaveSwitchError(null)
      setUnsavedTarget({ type: 'tab', tab })
    } else {
      setActiveTab(tab)
    }
  }, [activeTab, isDetailDirty])

  const handleConfirmSaveSwitch = async () => {
    if (isSavingSwitch || !roleDetailSaveRef.current) return
    setIsSavingSwitch(true)
    setSaveSwitchError(null)
    try {
      const ok = await roleDetailSaveRef.current()
      if (ok) {
        const target = unsavedTarget
        setUnsavedTarget(null)
        setSaveSwitchError(null)
        setIsSavingSwitch(false)
        if (target?.type === 'role') setSelectedId(target.id)
        if (target?.type === 'tab') setActiveTab(target.tab)
      } else {
        setSaveSwitchError('Failed to save changes. Please try again.')
        setIsSavingSwitch(false)
      }
    } catch (err: any) {
      setSaveSwitchError(err?.message || 'Failed to save changes. Please try again.')
      setIsSavingSwitch(false)
    }
  }

  const handleConfirmDiscardSwitch = () => {
    if (isSavingSwitch) return
    if (roleDetailDiscardRef.current) {
      roleDetailDiscardRef.current()
    }
    const target = unsavedTarget
    setUnsavedTarget(null)
    setSaveSwitchError(null)
    if (target?.type === 'role') setSelectedId(target.id)
    if (target?.type === 'tab') setActiveTab(target.tab)
  }

  const handleStayOnRole = () => {
    if (isSavingSwitch) return
    setUnsavedTarget(null)
    setSaveSwitchError(null)
  }

  const handleDuplicateSystemRole = useCallback((roleToDuplicate: Role) => {
    let suggestedName = `${roleToDuplicate.name} (Custom)`
    let counter = 2
    while (roles.some((r) => r.name.toLowerCase() === suggestedName.toLowerCase())) {
      suggestedName = `${roleToDuplicate.name} (Custom ${counter})`
      counter++
    }

    setDuplicateRoleData({
      name: suggestedName,
      description: roleToDuplicate.description || `Custom variant based on ${roleToDuplicate.name}`,
      color: roleToDuplicate.color,
      permissions: parsePerms(roleToDuplicate.permissions),
    })
    setCreateOpen(true)
  }, [roles])

  const headers = useMemo(() => ({
    'x-tenant-id': data?.tenant.id ?? '',
    'content-type': 'application/json',
  }), [data?.tenant.id])

  if (!data) return null

  if (denied) return <AccessDenied failure={denied} subject="roles and staff" onRetry={() => setDenied(null)} view="roles" />

  return (
    <div className="h-full flex flex-col overflow-y-auto scrollbar-thin lg:overflow-hidden">
      {/* Header — clean mobile-first bar: redundant "Role Access" heading removed */}
      <div className={cn(
        'shrink-0 px-3.5 md:px-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 sm:gap-3 transition-all duration-200 ease-out',
        collapsed ? 'pt-2.5 md:pt-4 pb-2 lg:pt-1.5 lg:pb-1.5' : 'pt-3 md:pt-5 pb-2.5',
      )}>
        <div>
          <p className="text-xs sm:text-sm text-muted-foreground font-medium">
            Manage staff roles, granular permissions, and security assignments
          </p>
        </div>

        {/* Responsive tabs + create button */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
          {canViewRoles && canViewStaff && (
            <div className="inline-flex flex-1 sm:flex-none rounded-xl bg-secondary/50 border border-border p-0.5">
              <button
                type="button"
                onClick={() => handleTabChange('roles')}
                className={cn(
                  'flex flex-1 sm:flex-none items-center justify-center gap-1.5 rounded-lg px-2.5 sm:px-3 py-1.5 min-h-8 text-xs font-medium whitespace-nowrap transition-all',
                  activeTab === 'roles' ? 'bg-primary text-white shadow-glow-primary' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Shield className="h-3.5 w-3.5 shrink-0" /> Roles & Permissions
              </button>
              <button
                type="button"
                onClick={() => handleTabChange('staff')}
                className={cn(
                  'flex flex-1 sm:flex-none items-center justify-center gap-1.5 rounded-lg px-2.5 sm:px-3 py-1.5 min-h-8 text-xs font-medium whitespace-nowrap transition-all',
                  activeTab === 'staff' ? 'bg-primary text-white shadow-glow-primary' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Users className="h-3.5 w-3.5 shrink-0" /> Staff Accounts
              </button>
            </div>
          )}
          {activeTab === 'roles'
            ? canManageRoles && (
                <Button
                  onClick={() => {
                    setDuplicateRoleData(null)
                    setCreateOpen(true)
                  }}
                  className="bg-primary hover:bg-primary/90 shrink-0 whitespace-nowrap w-full sm:w-auto"
                >
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

      {/* Top stats */}
      <div className={cn(
        'shrink-0 overflow-hidden transition-all duration-200 ease-out px-3.5 md:px-6 grid grid-cols-2 md:grid-cols-4 gap-2.5 sm:gap-3',
        collapsed ? 'max-h-[8.5rem] md:max-h-20 opacity-100 pb-3 lg:max-h-0 lg:opacity-0 lg:pb-0' : 'max-h-[8.5rem] md:max-h-20 opacity-100 pb-3',
      )}>
        <StatCard icon={<Shield className="h-3.5 w-3.5 sm:h-4 sm:w-4" />} label="Total Roles" value={roles.length} tint="#f97316" />
        <StatCard icon={<ShieldCheck className="h-3.5 w-3.5 sm:h-4 sm:w-4" />} label="System Roles" value={systemCount} tint="#4ade80" />
        <StatCard icon={<ShieldPlus className="h-3.5 w-3.5 sm:h-4 sm:w-4" />} label="Custom Roles" value={customCount} tint="#60a5fa" />
        <StatCard icon={<Users className="h-3.5 w-3.5 sm:h-4 sm:w-4" />} label="Total Staff" value={staff.length} tint="#fbbf24" />
      </div>

      {/* Roles & Permissions tab */}
      {activeTab === 'roles' && (
      <div className="lg:flex-1 lg:min-h-0 lg:overflow-hidden px-3.5 md:px-6 pb-4 md:pb-6">
        {/* Mobile: horizontal scrollable role pills with right-edge fade and partial visibility */}
        <div className="lg:hidden flex flex-col gap-3">
          <div className="sticky top-0 z-20 -mt-3 -mb-3 bg-background pt-2.5 pb-2.5 -mx-3.5 px-3.5">
            <div className="relative">
              <div
                role="tablist"
                aria-label="Role selector"
                className="flex gap-2 overflow-x-auto overscroll-x-contain scrollbar-none py-1 pr-10"
              >
                {roles.map((role) => {
                  const active = role.id === (selectedRole?.id ?? null)
                  const isOutOfReach = !role.isSystem && !canGrantRole(parsePerms(role.permissions), callerPermissions)
                  return (
                    <button
                      key={role.id}
                      role="tab"
                      aria-selected={active}
                      aria-label={`${role.name} role, ${memberCounts[role.id] || 0} members`}
                      onClick={() => handleSelectRole(role.id)}
                      className={cn(
                        'shrink-0 inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs sm:text-[13px] transition-all min-h-[34px] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                        active
                          ? 'border-primary/60 bg-primary/10 text-foreground ring-1 ring-primary/40 font-semibold shadow-sm'
                          : 'border-border bg-secondary/40 text-muted-foreground hover:text-foreground hover:bg-secondary',
                      )}
                    >
                      <span className="w-2.5 h-2.5 rounded-full shrink-0 ring-1 ring-background" style={{ backgroundColor: role.color }} />
                      <span className="whitespace-nowrap">{role.name}</span>
                      {role.isSystem && <Lock className="h-3 w-3 text-muted-foreground shrink-0" />}
                      {isOutOfReach && (
                        <span title="This role includes permissions you don’t hold" className="inline-flex items-center shrink-0">
                          <Lock className="h-3 w-3 text-amber-500/80" />
                        </span>
                      )}
                      <span className="text-[11px] opacity-70 whitespace-nowrap">({memberCounts[role.id] || 0})</span>
                    </button>
                  )
                })}
                {canManageRoles && (
                  <button
                    type="button"
                    onClick={() => {
                      setDuplicateRoleData(null)
                      setCreateOpen(true)
                    }}
                    className="shrink-0 inline-flex items-center gap-1 rounded-full border border-dashed border-border px-3 py-1.5 text-xs sm:text-[13px] text-muted-foreground hover:text-primary hover:border-primary/40 transition-colors min-h-[34px]"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span className="whitespace-nowrap">New</span>
                  </button>
                )}
              </div>
              {/* Subtle right-edge gradient fade to indicate horizontal scrollability */}
              <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-background to-transparent" />
            </div>
          </div>

          <div>
            {selectedRole ? (
              <RoleDetail
                role={selectedRole}
                members={roleMembers}
                allRoles={roles}
                allStaff={staff}
                headers={headers}
                refresh={refresh}
                scrollRef={scrollRef}
                canManageRoles={canManageRoles}
                canManageStaff={canManageStaff}
                grantableKeys={callerPermissions}
                handleAction={handleAction}
                onDuplicateRole={handleDuplicateSystemRole}
                onDirtyChange={(dirty, saveFn, discardFn) => {
                  setIsDetailDirty(dirty)
                  roleDetailSaveRef.current = saveFn
                  roleDetailDiscardRef.current = discardFn
                }}
              />
            ) : (
              <Card className="rounded-2xl bg-card border-border flex items-center justify-center p-8">
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
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Roles</h3>
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
                    isOutOfReach={!role.isSystem && !canGrantRole(parsePerms(role.permissions), callerPermissions)}
                    onClick={() => handleSelectRole(role.id)}
                  />
                ))}
                {canManageRoles && (
                  <button
                    type="button"
                    onClick={() => {
                      setDuplicateRoleData(null)
                      setCreateOpen(true)
                    }}
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
                allStaff={staff}
                headers={headers}
                refresh={refresh}
                scrollRef={scrollRef}
                canManageRoles={canManageRoles}
                canManageStaff={canManageStaff}
                grantableKeys={callerPermissions}
                handleAction={handleAction}
                onDuplicateRole={handleDuplicateSystemRole}
                onDirtyChange={(dirty, saveFn, discardFn) => {
                  setIsDetailDirty(dirty)
                  roleDetailSaveRef.current = saveFn
                  roleDetailDiscardRef.current = discardFn
                }}
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

      {/* Create / Duplicate role dialog */}
      <CreateRoleDialog
        open={createOpen}
        onOpenChange={(isOpen) => {
          setCreateOpen(isOpen)
          if (!isOpen) setDuplicateRoleData(null)
        }}
        initialData={duplicateRoleData}
        headers={headers}
        handleAction={handleAction}
        onCreated={async (newRole) => {
          setDuplicateRoleData(null)
          await refresh()
          handleSelectRole(newRole.id)
        }}
      />

      {/* Unsaved Changes Confirmation Dialog */}
      <AlertDialog
        open={!!unsavedTarget}
        onOpenChange={(isOpen) => {
          if (!isOpen && !isSavingSwitch) {
            setUnsavedTarget(null)
            setSaveSwitchError(null)
          }
        }}
      >
        <AlertDialogContent className="bg-card border-border sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Unsaved Changes
            </AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes to <strong className="text-foreground">{selectedRole?.name}</strong>. If you leave without saving, your edits will be discarded.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {saveSwitchError && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span className="flex-1">{saveSwitchError}</span>
            </div>
          )}

          <AlertDialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              disabled={isSavingSwitch}
              onClick={handleStayOnRole}
            >
              Stay on Role
            </Button>
            <Button
              variant="outline"
              disabled={isSavingSwitch}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive border-destructive/30"
              onClick={handleConfirmDiscardSwitch}
            >
              Discard Changes
            </Button>
            <Button
              disabled={isSavingSwitch}
              className="bg-primary hover:bg-primary/90 text-white"
              onClick={handleConfirmSaveSwitch}
            >
              {isSavingSwitch ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                  Saving...
                </>
              ) : (
                'Save & Switch'
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function StatCard({ icon, label, value, tint }: { icon: React.ReactNode; label: string; value: number; tint: string }) {
  return (
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

function RoleListItem({
  role,
  memberCount,
  active,
  isOutOfReach,
  onClick,
}: {
  role: Role
  memberCount: number
  active: boolean
  isOutOfReach?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left rounded-xl border p-3 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        active
          ? 'border-primary/50 bg-primary/10 ring-1 ring-primary/30'
          : 'border-border bg-secondary/40 hover:bg-secondary hover:border-border',
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
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 bg-secondary/80 gap-1 font-semibold">
                <Lock className="h-2.5 w-2.5" />
                SYSTEM
              </Badge>
            )}
            {isOutOfReach && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-amber-500/30 text-amber-600 dark:text-amber-400 gap-1 font-semibold">
                <Lock className="h-2.5 w-2.5" />
                READ-ONLY
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
  allStaff,
  headers,
  refresh,
  scrollRef,
  canManageRoles,
  canManageStaff,
  grantableKeys,
  handleAction,
  onDuplicateRole,
  onDirtyChange,
}: {
  role: Role
  members: RoleMember[]
  allRoles: Role[]
  allStaff: any[]
  headers: Record<string, string>
  refresh: () => Promise<void>
  scrollRef?: React.RefObject<HTMLDivElement | null>
  canManageRoles: boolean
  canManageStaff: boolean
  grantableKeys: string[]
  handleAction: (error: unknown, subject: string) => void
  onDuplicateRole?: (role: Role) => void
  onDirtyChange?: (dirty: boolean, saveFn: () => Promise<boolean>, discardFn: () => void) => void
}) {
  const [permState, setPermState] = useState<string[]>(() => parsePerms(role.permissions))
  const [name, setName] = useState(role.name)
  const [description, setDescription] = useState(role.description || '')
  const [color, setColor] = useState(role.color)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [assignStaffOpen, setAssignStaffOpen] = useState(false)

  // Accordion open state for all 10 groups
  // Default to collapsed on mobile (< 1024px), open on desktop
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    const isMobile = typeof window !== 'undefined' ? window.innerWidth < 1024 : false
    const initial: Record<string, boolean> = {}
    for (const group of PERMISSION_GROUPS) {
      initial[group.label] = !isMobile
    }
    return initial
  })

  const toggleGroupOpen = (label: string) => {
    setOpenGroups((prev) => ({ ...prev, [label]: !prev[label] }))
  }

  const effectivePerms = useMemo(() => expandPermissions(permState), [permState])
  const reserved = name !== role.name ? reservedRoleName(name) : null
  const viewerCanGrant = (perm: string) => grantableKeys.includes(perm)
  const impliedByManage = (perm: string) =>
    Object.entries(PERMISSION_IMPLICATIONS).find(([k, v]) => v === perm && permState.includes(k))?.[0] ??
    Object.entries(PERMISSION_IMPLICATIONS).find(([, v]) => v === perm)?.[0] ??
    null

  // Re-sync when role changes from parent
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPermState(parsePerms(role.permissions))
    setName(role.name)
    setDescription(role.description || '')
    setColor(role.color)
    setSaveError(null)
  }, [role.id, role.permissions, role.name, role.description, role.color])

  const isSystem = role.isSystem
  const outOfReach = !isSystem && !canGrantRole(parsePerms(role.permissions), grantableKeys)
  const canEditRole = canManageRoles && !outOfReach

  const dirty = useMemo(() => {
    if (!canEditRole) return false
    const original = parsePerms(role.permissions)
    const samePerms = original.length === permState.length && original.every((p) => permState.includes(p))
    return !samePerms || name !== role.name || description !== (role.description || '') || color !== role.color
  }, [canEditRole, permState, name, description, color, role])

  const discardChanges = useCallback(() => {
    setPermState(parsePerms(role.permissions))
    setName(role.name)
    setDescription(role.description || '')
    setColor(role.color)
    setSaveError(null)
  }, [role])

  const saveRole = useCallback(async (): Promise<boolean> => {
    if (!canEditRole) return false
    setSaving(true)
    setSaveError(null)
    try {
      const res = await edgeFetch(`/api/roles/${role.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ name, description, permissions: permState, color }),
      })
      await failIfNotOk(res, 'the role')
      toast.success('Role updated successfully')
      await refresh()
      return true
    } catch (err) {
      const errMsg = (err as any)?.message || 'Failed to update role'
      setSaveError(errMsg)
      handleAction(err, 'the role')
      return false
    } finally {
      setSaving(false)
    }
  }, [canEditRole, role.id, headers, name, description, permState, color, refresh, handleAction])

  // Inform parent of dirty state for unsaved-changes protection
  useEffect(() => {
    onDirtyChange?.(dirty, saveRole, discardChanges)
  }, [dirty, saveRole, discardChanges, onDirtyChange])

  const isPermEditable = useCallback(
    (perm: string) => {
      if (isSystem || !canEditRole) return false
      if (!viewerCanGrant(perm)) return false
      // If this permission is implied by an ungrantable key currently in permState,
      // that key cannot be removed by the current viewer, so this perm is permanently locked on.
      const lockedByUngrantable = permState.some(
        (k) => PERMISSION_IMPLICATIONS[k] === perm && !viewerCanGrant(k)
      )
      if (lockedByUngrantable) return false
      return true
    },
    [isSystem, canEditRole, viewerCanGrant, permState]
  )

  const togglePerm = (key: string) => {
    if (isSystem || !canEditRole) return
    setPermState((prev) => (prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key]))
  }

  const toggleGroup = useCallback((groupPerms: readonly string[], on: boolean) => {
    if (isSystem || !canEditRole) return
    setPermState((prev) => {
      const editableInGroup = groupPerms.filter((perm) => {
        if (!viewerCanGrant(perm)) return false
        const lockedByUngrantable = prev.some(
          (k) => PERMISSION_IMPLICATIONS[k] === perm && !viewerCanGrant(k)
        )
        return !lockedByUngrantable
      })

      if (editableInGroup.length === 0) return prev

      if (on) {
        return Array.from(new Set([...prev, ...editableInGroup]))
      } else {
        return prev.filter((p) => !editableInGroup.includes(p))
      }
    })
  }, [isSystem, canEditRole, viewerCanGrant])

  const removeRole = async () => {
    if (!canEditRole) return
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

  return (
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
                <Badge variant="secondary" className="text-[10px] h-4 px-1.5 bg-secondary/80 gap-1 font-semibold">
                  <Lock className="h-2.5 w-2.5" />
                  System Role
                </Badge>
              )}
              {outOfReach && (
                <Badge variant="outline" className="text-[10px] h-4 px-1.5 border-amber-500/30 text-amber-600 dark:text-amber-400 gap-1 font-semibold">
                  <Lock className="h-2.5 w-2.5" />
                  Read-only
                </Badge>
              )}
            </div>
            <p className="text-[13px] sm:text-sm text-muted-foreground mt-0.5 line-clamp-2">{description || 'No description provided'}</p>
          </div>
        </div>
        {!isSystem && canEditRole && (
          <Button variant="ghost" size="icon" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setDeleteOpen(true)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Main scrollable body with generous padding so sticky bar never obscures content */}
      <div ref={scrollRef} className="lg:flex-1 lg:min-h-0 lg:overflow-y-auto scrollbar-thin">
        <div className="p-3 sm:p-4 space-y-3.5 sm:space-y-5 pb-28 sm:pb-24">
          {/* System role banner with "Duplicate as Custom Role" */}
          {isSystem && (
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 rounded-xl bg-secondary/50 border border-border p-3 sm:p-3.5 text-xs text-muted-foreground">
              <div className="flex items-start gap-2.5">
                <Lock className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
                <div>
                  <span className="font-semibold text-foreground">Built-in System Role: </span>
                  <span>Permissions and role name are fixed for system security. Description and color can be edited.</span>
                </div>
              </div>
              {canManageRoles && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0 text-xs h-8 gap-1.5 border-border bg-background/80 hover:bg-background hover:text-primary transition-colors"
                  onClick={() => onDuplicateRole?.(role)}
                >
                  <Copy className="h-3.5 w-3.5" />
                  Duplicate as Custom Role
                </Button>
              )}
            </div>
          )}

          {/* Out of reach custom role banner */}
          {outOfReach && (
            <div className="flex items-start gap-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 p-3 sm:p-3.5 text-xs text-amber-700 dark:text-amber-400">
              <Lock className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
              <div>
                <p className="font-semibold text-foreground">This role includes permissions you don’t hold.</p>
                <p className="mt-0.5 text-muted-foreground">
                  You can view this role's configuration, but editing and deletion are restricted to users who hold all of its assigned permissions.
                </p>
              </div>
            </div>
          )}

          {/* Role meta: Name & Color */}
          <div className="grid sm:grid-cols-2 gap-2.5 sm:gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Role Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isSystem || !canEditRole}
                className="bg-secondary/50 border-border"
              />
              {reserved && (
                <p className="text-[11px] text-amber-600/90 dark:text-amber-400/90 mt-1">
                  "{reserved}" is a built-in role name. Choose a distinct custom name.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Color</Label>
              <div className="flex items-center gap-2 flex-wrap pt-0.5">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    disabled={!canEditRole}
                    onClick={() => setColor(c)}
                    className={cn(
                      'w-7 h-7 sm:w-7 sm:h-7 rounded-full ring-2 ring-offset-2 ring-offset-card transition-all disabled:opacity-40 focus:outline-none focus-visible:ring-primary',
                      color === c ? 'ring-primary scale-110' : 'ring-transparent hover:scale-105',
                    )}
                    style={{ backgroundColor: c }}
                    aria-label={`Select color ${c}`}
                  >
                    {color === c && <Check className="h-3.5 w-3.5 text-white stroke-[3] mx-auto drop-shadow-sm" />}
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
              disabled={!canEditRole}
              rows={2}
              className="bg-secondary/50 border-border resize-none"
              placeholder="What responsibilities does this role hold?"
            />
          </div>

          <Separator />

          {/* Permission Matrix — Human-Readable Accordions */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <Shield className="h-4 w-4 text-primary" />
                Permissions Matrix
              </h4>
              <Badge variant="outline" className="text-xs font-normal border-border bg-secondary/40">
                {effectivePerms.length}/29 enabled
              </Badge>
            </div>
            {effectivePerms.includes('dashboard.view') !== effectivePerms.includes('tables.view') && (
              <p className="text-[11px] text-amber-600/90 dark:text-amber-400/90 mb-3 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2.5">
                Dashboard is the point-of-sale screen: it opens only with both <strong>Dashboard</strong> and <strong>Tables &amp; QR → View Tables</strong> enabled.
              </p>
            )}

            <div className="grid sm:grid-cols-2 gap-3">
              {PERMISSION_GROUPS.map((group) => {
                const enabledCount = group.perms.filter((p) => effectivePerms.includes(p)).length
                const allOn = enabledCount === group.perms.length
                const isOpen = openGroups[group.label] ?? false

                const editablePerms = group.perms.filter(isPermEditable)
                const hasEditable = editablePerms.length > 0
                const allEditableOn = hasEditable && editablePerms.every((p) => effectivePerms.includes(p))

                return (
                  <Collapsible
                    key={group.label}
                    open={isOpen}
                    onOpenChange={() => toggleGroupOpen(group.label)}
                    className="rounded-xl border border-border bg-secondary/30 transition-colors"
                  >
                    <div className="flex items-center justify-between p-3 gap-2">
                      <CollapsibleTrigger asChild>
                        <button
                          type="button"
                          className="flex items-center gap-2 text-sm font-medium flex-1 text-left select-none focus:outline-none focus-visible:ring-1 focus-visible:ring-primary rounded"
                        >
                          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform duration-200', !isOpen && '-rotate-90')} />
                          <span className="font-medium text-foreground">{group.label}</span>
                          <span className="text-xs text-muted-foreground font-normal">
                            ({enabledCount}/{group.perms.length})
                          </span>
                          {allOn && <Check className="h-3.5 w-3.5 text-emerald-500 ml-auto mr-1 shrink-0" />}
                        </button>
                      </CollapsibleTrigger>
                      {!isSystem && canEditRole && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={!hasEditable}
                          onClick={() => toggleGroup(group.perms, !allEditableOn)}
                          className="text-xs h-7 px-2 text-primary hover:text-primary hover:bg-primary/10 disabled:opacity-40"
                        >
                          {allEditableOn ? 'Clear' : 'Select all'}
                        </Button>
                      )}
                    </div>

                    <CollapsibleContent>
                      <div className="px-3 pb-3 space-y-2 border-t border-border/50 pt-2.5">
                        {group.perms.map((perm) => {
                          const meta = PERMISSION_METADATA[perm as PermissionKey] ?? {
                            key: perm as PermissionKey,
                            label: perm,
                            description: '',
                            module: group.label,
                          }
                          const held = effectivePerms.includes(perm)
                          const implied = held && !permState.includes(perm)
                          const ungrantable = !isSystem && canManageRoles && !viewerCanGrant(perm)
                          const locked = isSystem || !canEditRole || implied || (!isSystem && ungrantable)

                          return (
                            <label
                              key={perm}
                              className={cn(
                                'flex items-start gap-2.5 rounded-lg border p-2 transition-colors select-none',
                                locked
                                  ? 'cursor-not-allowed opacity-80 border-border/40 bg-secondary/20'
                                  : 'cursor-pointer border-border/60 hover:bg-secondary/50 hover:border-border',
                                held && !locked && 'bg-primary/[0.04] border-primary/25',
                              )}
                              title={
                                isSystem
                                  ? 'System role permissions are fixed and read-only'
                                  : outOfReach
                                    ? 'This role includes permissions you don’t hold'
                                    : implied
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
                                className="mt-0.5 shrink-0"
                              />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="font-medium text-xs text-foreground leading-snug">{meta.label}</span>
                                  <span className="font-mono text-[10px] text-muted-foreground/75 bg-secondary px-1 py-0.5 rounded border border-border/50">
                                    {perm}
                                  </span>
                                  {implied && (
                                    <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 text-muted-foreground gap-1 border-muted-foreground/30">
                                      <Lock className="h-2.5 w-2.5" />
                                      Included
                                    </Badge>
                                  )}
                                  {isSystem && (
                                    <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 text-muted-foreground gap-1 border-muted-foreground/30">
                                      <Lock className="h-2.5 w-2.5" />
                                      Fixed
                                    </Badge>
                                  )}
                                </div>
                                {meta.description && (
                                  <p className="text-[11px] text-muted-foreground mt-0.5 leading-tight">
                                    {meta.description}
                                  </p>
                                )}
                              </div>
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

          {/* Members card with + Assign Staff */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                Members
                <span className="text-xs text-muted-foreground font-normal">({members.length})</span>
              </h4>
              {canManageStaff && !outOfReach && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs gap-1.5 border-primary/30 text-primary hover:bg-primary/10 hover:text-primary"
                  onClick={() => setAssignStaffOpen(true)}
                >
                  <UserPlus className="h-3.5 w-3.5" />
                  Assign Staff
                </Button>
              )}
            </div>

            {members.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-4 md:p-6 text-center">
                <Users className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-50" />
                <p className="text-sm text-muted-foreground">No staff assigned to this role yet</p>
                {canManageStaff && !outOfReach && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-3 text-xs gap-1"
                    onClick={() => setAssignStaffOpen(true)}
                  >
                    <UserPlus className="h-3.5 w-3.5" />
                    Assign Staff Now
                  </Button>
                )}
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
                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs">
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

      {/* Sticky Save / Discard Bar near viewport bottom whenever editing or dirty */}
      {canEditRole && (
        <div className={cn(
          'sticky bottom-0 z-30 border-t border-border bg-card/95 backdrop-blur-md p-3 sm:px-4 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 shadow-lg transition-all',
          'pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]',
        )}>
          <div className="flex items-center gap-2">
            {saving ? (
              <span className="flex items-center gap-1.5 text-xs text-primary font-medium">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving changes…
              </span>
            ) : saveError ? (
              <span className="flex items-center gap-1.5 text-xs text-destructive font-medium">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {saveError}
              </span>
            ) : dirty ? (
              <span className="flex items-center gap-1.5 text-xs text-amber-500 font-medium">
                <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                You have unsaved changes
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Check className="h-3.5 w-3.5 text-emerald-500" />
                All changes saved
              </span>
            )}
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={!dirty || saving}
              onClick={discardChanges}
              className="text-xs"
            >
              Discard
            </Button>
            <Button
              size="sm"
              disabled={!dirty || saving || (isSystem ? false : !!reserved)}
              onClick={saveRole}
              className="bg-primary hover:bg-primary/90 text-xs min-w-[110px]"
            >
              {saving ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Saving…
                </>
              ) : (
                <>
                  <Save className="mr-1.5 h-3.5 w-3.5" /> Save Changes
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      {/* Delete role dialog */}
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

      {/* Assign Staff Dialog */}
      <AssignStaffDialog
        open={assignStaffOpen}
        onOpenChange={setAssignStaffOpen}
        role={role}
        staff={allStaff}
        headers={headers}
        grantableKeys={grantableKeys}
        refresh={refresh}
        handleAction={handleAction}
      />
    </Card>
  )
}

/** Assign Staff Dialog */
function AssignStaffDialog({
  open,
  onOpenChange,
  role,
  staff,
  headers,
  grantableKeys,
  refresh,
  handleAction,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  role: Role
  staff: any[]
  headers: Record<string, string>
  grantableKeys: string[]
  refresh: () => Promise<void>
  handleAction: (error: unknown, subject: string) => void
}) {
  const [selectedStaffId, setSelectedStaffId] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)

  const isOwner = role.isSystem && role.name === 'Owner'

  const handleAssign = async () => {
    if (!selectedStaffId) {
      toast.error('Please select a staff member')
      return
    }
    if (isOwner) {
      toast.error('The Owner role cannot be assigned to staff PIN accounts')
      return
    }
    if (!canGrantRole(parsePerms(role.permissions), grantableKeys)) {
      toast.error('You cannot assign a role with permissions you do not hold')
      return
    }

    setSubmitting(true)
    try {
      const res = await edgeFetch(`/api/staff/manage/${selectedStaffId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ roleId: role.id }),
      })
      await failIfNotOk(res, 'the staff account')
      const targetStaff = staff.find((s) => s.id === selectedStaffId)
      toast.success(`${targetStaff?.name ?? 'Staff member'} assigned to ${role.name}`)
      setSelectedStaffId('')
      onOpenChange(false)
      await refresh()
    } catch (err) {
      handleAction(err, 'the staff account')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-primary" />
            Assign Staff to {role.name}
          </DialogTitle>
          <DialogDescription>
            Select an employee from this restaurant to assign to the <strong className="text-foreground">{role.name}</strong> role.
          </DialogDescription>
        </DialogHeader>

        {isOwner ? (
          <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-600 dark:text-amber-400">
            <p className="font-semibold">Owner Role Invariant</p>
            <p className="mt-1">
              The built-in Owner role is reserved exclusively for registered account owners and cannot be assigned to staff PIN accounts.
            </p>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Target Role</Label>
              <div className="flex items-center gap-2 p-2.5 rounded-lg border border-border bg-secondary/40 text-sm">
                <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: role.color }} />
                <span className="font-medium text-foreground">{role.name}</span>
                {role.isSystem && <Badge variant="secondary" className="text-[10px] h-4 px-1 ml-auto">System</Badge>}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Select Staff Member *</Label>
              {staff.length === 0 ? (
                <p className="text-xs text-muted-foreground p-3 border rounded-lg border-dashed">
                  No staff accounts found. Create staff in the Staff Accounts tab first.
                </p>
              ) : (
                <Select value={selectedStaffId} onValueChange={setSelectedStaffId} disabled={submitting}>
                  <SelectTrigger className="bg-secondary/50 border-border text-xs sm:text-sm">
                    <SelectValue placeholder="Choose a staff member" />
                  </SelectTrigger>
                  <SelectContent>
                    {staff.map((s) => {
                      const isAlreadyInRole = s.roleId === role.id
                      return (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name} ({s.employeeId}) — currently: {s.roleName || 'No Role'}
                          {isAlreadyInRole ? ' (Already assigned)' : ''}
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={handleAssign}
            disabled={submitting || isOwner || !selectedStaffId}
            className="bg-primary hover:bg-primary/90 text-xs"
          >
            {submitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Assigning…
              </>
            ) : (
              'Confirm Assignment'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CreateRoleDialog({
  open,
  onOpenChange,
  initialData,
  headers,
  handleAction,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialData?: {
    name: string
    description: string
    color: string
    permissions: string[]
  } | null
  headers: Record<string, string>
  handleAction: (error: unknown, subject: string) => void
  onCreated: (role: Role) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState<string>(PRESET_COLORS[0])
  const [perms, setPerms] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  // Sync initialData when opening (supports Duplication)
  useEffect(() => {
    if (open) {
      if (initialData) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setName(initialData.name)
        setDescription(initialData.description)
        setColor(initialData.color)
        setPerms(initialData.permissions)
      } else {
        setName('')
        setDescription('')
        setColor(PRESET_COLORS[0])
        setPerms([])
      }
    }
  }, [open, initialData])

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
      toast.success(initialData ? `Custom role "${role.name}" created from template` : 'Role created successfully')
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
            {initialData ? `Duplicate Role: ${initialData.name}` : 'Create New Custom Role'}
          </DialogTitle>
          <DialogDescription>
            {initialData
              ? 'Customize the duplicated permissions and metadata before saving this new custom role.'
              : 'Define a new staff role with granular, human-readable permissions.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="role-name">Role name *</Label>
            <Input
              id="role-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Shift Supervisor"
              className="bg-secondary/50 border-border"
            />
            {reserved && (
              <p className="text-[11px] text-amber-600/90 dark:text-amber-400/90 mt-1">
                "{reserved}" is a built-in role name — pick a different custom name.
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
              placeholder="What responsibilities does this role carry?"
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
                    'w-7 h-7 rounded-full ring-2 ring-offset-2 ring-offset-card transition-all focus:outline-none focus-visible:ring-primary',
                    color === c ? 'ring-primary scale-110' : 'ring-transparent hover:scale-105',
                  )}
                  style={{ backgroundColor: c }}
                  aria-label={`Select color ${c}`}
                >
                  {color === c && <Check className="h-3.5 w-3.5 text-white stroke-[3] mx-auto drop-shadow-sm" />}
                </button>
              ))}
            </div>
          </div>

          <Separator />

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Permissions</Label>
              <span className="text-xs text-muted-foreground">{perms.length}/29 selected</span>
            </div>
            <div className="max-h-64 overflow-y-auto scrollbar-thin space-y-2 pr-1">
              {PERMISSION_GROUPS.map((group) => {
                const enabledCount = group.perms.filter((p) => perms.includes(p)).length
                const allOn = enabledCount === group.perms.length
                return (
                  <Collapsible key={group.label} className="rounded-lg border border-border bg-secondary/30">
                    <div className="flex items-center justify-between p-2.5">
                      <CollapsibleTrigger asChild>
                        <button type="button" className="flex items-center gap-2 text-sm font-medium flex-1 text-left">
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                          <span>{group.label}</span>
                          <span className="text-xs text-muted-foreground">({enabledCount}/{group.perms.length})</span>
                        </button>
                      </CollapsibleTrigger>
                      <button
                        type="button"
                        onClick={() => {
                          if (allOn) setPerms((prev) => prev.filter((p) => !(group.perms as readonly string[]).includes(p)))
                          else setPerms((prev) => Array.from(new Set([...prev, ...group.perms])))
                        }}
                        className="text-xs text-primary hover:underline px-1 py-0.5"
                      >
                        {allOn ? 'Clear' : 'All'}
                      </button>
                    </div>
                    <CollapsibleContent>
                      <div className="px-2.5 pb-2.5 space-y-1.5 border-t border-border/50 pt-2">
                        {group.perms.map((perm) => {
                          const meta = PERMISSION_METADATA[perm as PermissionKey] ?? {
                            key: perm as PermissionKey,
                            label: perm,
                            description: '',
                            module: group.label,
                          }
                          const checked = perms.includes(perm)
                          return (
                            <label key={perm} className="flex items-start gap-2.5 text-sm cursor-pointer hover:bg-secondary/60 rounded-md p-1.5 border border-transparent hover:border-border/40">
                              <Checkbox
                                checked={checked}
                                onCheckedChange={() => {
                                  setPerms((prev) => (prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm]))
                                }}
                                className="mt-0.5 shrink-0"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="font-medium text-xs text-foreground">{meta.label}</span>
                                  <span className="font-mono text-[10px] text-muted-foreground/70 bg-secondary px-1 py-0.2 rounded border border-border/50">{perm}</span>
                                </div>
                                {meta.description && (
                                  <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">{meta.description}</p>
                                )}
                              </div>
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
  const [creating, setCreating] = useState(false)
  const [resettingPin, setResettingPin] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [rowBusy, setRowBusy] = useState<{ id: string; action: 'toggle' | 'role' } | null>(null)

  const canManageStaff = hasPermission(data?.permissions, 'staff.manage')

  const myStaffId =
    data?.currentStaff?.id ??
    (data?.staff && !Array.isArray(data.staff) ? (data.staff as any).id : null) ??
    null
  const myPermissions = data?.permissions ?? []
  const outOfReach = (s: any) => {
    const role = (data?.roles ?? []).find((r) => r.id === s.roleId)
    return parsePerms(role?.permissions).some((p) => !myPermissions.includes(p))
  }

  const [form, setForm] = useState({ name: '', employeeId: '', roleId: '', pin: '' })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await edgeFetch('/api/staff/manage', { headers })
      await failIfNotOk(res, 'staff accounts')
      const json = await res.json()
      setStaff(Array.isArray(json) ? json : [])
      setDenied(null)
    } catch (err) {
      handleLoad(err, 'staff accounts')
      setStaff([])
    } finally {
      setLoading(false)
    }
  }, [headers, setDenied, handleLoad])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [load])

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
            {[1, 2, 3].map((i) => <div key={i} className="h-20 rounded-2xl bg-secondary/30 animate-pulse" />)}
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
                    <div
                      className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold shrink-0"
                      style={{ backgroundColor: `${s.roleColor}20`, color: s.roleColor }}
                    >
                      {s.name.split(' ').map((n: string) => n[0]).slice(0, 2).join('')}
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

                <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-3">
                  <span className={cn('inline-flex items-center gap-1', s.active ? 'text-emerald-400' : 'text-red-400')}>
                    <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: s.active ? '#4ade80' : '#ef4444' }} />
                    {s.active ? 'Active' : 'Inactive'}
                  </span>
                  {s.lastLogin && <span>Last login: {new Date(s.lastLogin).toLocaleDateString()}</span>}
                </div>

                {canManageStaff && (
                  <div className="flex items-center gap-1.5">
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
                        {roles.filter((r) => !(r.isSystem && r.name === 'Owner')).map((r) => (
                          <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                        ))}
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
                Staff can log in at <code className="bg-secondary px-1.5 py-0.5 rounded text-primary">/?view=staff-login&amp;tenant={tenantId}</code> using their employee ID and 4-digit PIN.
              </p>
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => window.open(`/?view=staff-login&tenant=${tenantId}`, '_blank')}
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
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Raj Kumar"
                className="bg-secondary/50 border-border"
                autoFocus
                disabled={creating}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Employee ID / Username *</Label>
              <Input
                value={form.employeeId}
                onChange={(e) => setForm((f) => ({ ...f, employeeId: e.target.value }))}
                placeholder="e.g. raj001"
                className="bg-secondary/50 border-border"
                disabled={creating}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Role</Label>
              <Select value={form.roleId} onValueChange={(v) => setForm((f) => ({ ...f, roleId: v }))} disabled={creating}>
                <SelectTrigger className="bg-secondary/50 border-border"><SelectValue placeholder="Select role" /></SelectTrigger>
                <SelectContent>
                  {roles.filter((r) => !(r.isSystem && r.name === 'Owner')).map((r) => (
                    <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">4-Digit PIN *</Label>
              <Input
                value={form.pin}
                onChange={(e) => setForm((f) => ({ ...f, pin: e.target.value.replace(/\D/g, '').slice(0, 4) }))}
                placeholder="••••"
                maxLength={4}
                inputMode="numeric"
                className="bg-secondary/50 border-border text-center text-2xl tracking-[0.5em]"
                disabled={creating}
              />
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
          <Input
            value={newPin}
            onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder="••••"
            maxLength={4}
            inputMode="numeric"
            className="bg-secondary/50 border-border text-center text-2xl tracking-[0.5em]"
            autoFocus
            disabled={resettingPin}
          />
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
