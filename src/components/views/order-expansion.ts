type OrderIdentity = { id: string; status: string }

type ExpansionMode =
  | { kind: 'single'; id: string }
  | { kind: 'multiple' }

export type OrderExpansion = {
  mode: ExpansionMode
  openId: string | null
  manuallyClosedId: string | null
}

export function orderExpansionMode(orders: readonly OrderIdentity[]): ExpansionMode {
  const valid = orders.filter((order) => order.status !== 'CANCELLED')
  return valid.length === 1 ? { kind: 'single', id: valid[0].id } : { kind: 'multiple' }
}

export function reconcileOrderExpansion(
  state: OrderExpansion | null,
  orders: readonly OrderIdentity[],
): OrderExpansion {
  const mode = orderExpansionMode(orders)
  const manuallyClosedId = state?.manuallyClosedId ?? null
  if (mode.kind === 'single') {
    if (state?.mode.kind === 'single' && state.mode.id === mode.id) return state
    return { mode, openId: mode.id === manuallyClosedId ? null : mode.id, manuallyClosedId }
  }

  const openId = state?.mode.kind === 'multiple' && orders.some((order) => order.id === state.openId)
    ? state.openId
    : null
  if (state?.mode.kind === 'multiple' && state.openId === openId) return state
  return { mode, openId, manuallyClosedId }
}

export function toggleOrderExpansion(state: OrderExpansion, id: string): OrderExpansion {
  const closing = state.openId === id
  return { ...state, openId: closing ? null : id, manuallyClosedId: closing ? id : null }
}
