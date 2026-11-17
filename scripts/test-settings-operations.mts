import { describe, it } from 'node:test'
import assert from 'node:assert'

describe('Settings -> Operations Audit and Logic Verification', () => {
  const OPS_TOGGLES = [
    { key: 'auto_accept_orders', label: 'Auto Accept Orders', desc: 'Automatically accept incoming table orders into the kitchen' },
    { key: 'auto_bill_print', label: 'Auto Bill Print', desc: 'Automatically print bill when session ends' },
  ]

  // Mock server AppData
  const createMockData = (overrides?: any) => ({
    tenant: {
      id: '33052d21-1625-4831-a5ed-56e40b6e9f2b',
      name: 'My Cafe',
      tagline: 'Fresh & Healthy',
      email: 'phrnxs@gmail.com',
      phone: '9876543210',
      address: '123 Market St',
      currency: 'INR',
      currencySymbol: '₹',
      logo: '',
      taxRate: '5.00',
      serviceCharge: '0.00',
      ...overrides?.tenant,
    },
    settings: {
      opening_hours: 'Mon–Fri 9:00 AM – 10:00 PM',
      timezone: 'Asia/Kolkata',
      gstin: '',
      fssai: '',
      instagram: '',
      facebook: '',
      youtube: '',
      menu_theme: 'light',
      pref_theme: 'dark',
      pref_language: 'en',
      pref_email_alerts: 'true',
      pref_push_alerts: 'true',
      pref_sound_alerts: 'false',
      pref_daily_digest: 'true',
      pref_default_order_type: 'DINE_IN',
      pref_compact_mode: 'false',
      auto_accept_orders: 'true',
      auto_bill_print: 'true',
      ...overrides?.settings,
    },
    currentUser: {
      name: 'Owner',
      email: 'phrnxs@gmail.com',
      phone: '9876543210',
      avatar: '',
    },
    orders: [],
    summary: { todayOrders: 5, todayRevenue: 1200 },
  })

  // Simulated React State Container following the updated settings.tsx implementation
  class SettingsFormHarness {
    data: any
    tenantForm: any
    taxRate: string = '0'
    serviceCharge: string = '0'
    openingHours: string = ''
    timezone: string = 'UTC'
    opToggles: Record<string, boolean> = {}
    prefs: any
    profileForm: any

    initializedTenantId: string | null = null
    dirtyRef = { current: false }

    constructor(initialData: any) {
      this.data = initialData
      this.syncFromServer(true)
    }

    initForm(d: any) {
      const t = d.tenant
      this.tenantForm = {
        name: t.name || '',
        tagline: t.tagline || '',
        email: t.email || '',
        phone: t.phone || '',
        address: t.address || '',
        currency: t.currency || 'INR',
        currencySymbol: t.currencySymbol || '$',
        logo: t.logo || '',
        gstin: d.settings.gstin || '',
        fssai: d.settings.fssai || '',
        instagram: d.settings.instagram || '',
        facebook: d.settings.facebook || '',
        youtube: d.settings.youtube || '',
        menuTheme: d.settings.menu_theme || 'light',
      }
      this.taxRate = t.taxRate != null ? String(Number(t.taxRate)) : '0'
      this.serviceCharge = t.serviceCharge != null ? String(Number(t.serviceCharge)) : '0'
      this.openingHours = d.settings.opening_hours || 'Mon–Fri 9:00 AM – 10:00 PM'
      this.timezone = d.settings.timezone || 'Asia/Kolkata'

      const toggles: Record<string, boolean> = {}
      for (const tog of OPS_TOGGLES) {
        toggles[tog.key] = d.settings[tog.key] === 'true'
      }
      this.opToggles = toggles

      this.profileForm = { ...d.currentUser }
      this.prefs = {
        theme: d.settings.pref_theme || 'dark',
        language: d.settings.pref_language || 'en',
        emailAlerts: d.settings.pref_email_alerts !== 'false',
        pushAlerts: d.settings.pref_push_alerts !== 'false',
        soundAlerts: d.settings.pref_sound_alerts === 'true',
        dailyDigest: d.settings.pref_daily_digest !== 'false',
        defaultOrderType: d.settings.pref_default_order_type || 'DINE_IN',
        compactMode: d.settings.pref_compact_mode === 'true',
      }
    }

    syncFromServer(force: boolean = false) {
      if (!this.data) return
      if (this.initializedTenantId !== this.data.tenant.id) {
        this.initializedTenantId = this.data.tenant.id
        this.initForm(this.data)
        this.updateDirty()
        return
      }
      if (force || !this.dirtyRef.current) {
        this.initForm(this.data)
      }
      this.updateDirty()
    }

    isDirty(): boolean {
      if (!this.data) return false
      const t = this.data.tenant
      if (this.tenantForm.name !== (t.name || '')) return true
      if (this.tenantForm.tagline !== (t.tagline || '')) return true
      if (this.tenantForm.email !== (t.email || '')) return true
      if (this.tenantForm.phone !== (t.phone || '')) return true
      if (this.tenantForm.address !== (t.address || '')) return true
      if (this.tenantForm.currency !== (t.currency || 'INR')) return true
      if (this.tenantForm.currencySymbol !== (t.currencySymbol || '$')) return true
      if (this.tenantForm.logo !== (t.logo || '')) return true
      if (this.tenantForm.gstin !== (this.data.settings.gstin || '')) return true
      if (this.tenantForm.fssai !== (this.data.settings.fssai || '')) return true
      if (this.tenantForm.instagram !== (this.data.settings.instagram || '')) return true
      if (this.tenantForm.facebook !== (this.data.settings.facebook || '')) return true
      if (this.tenantForm.youtube !== (this.data.settings.youtube || '')) return true

      const savedTaxRateStr = t.taxRate != null ? String(Number(t.taxRate)) : '0'
      const savedServiceChargeStr = t.serviceCharge != null ? String(Number(t.serviceCharge)) : '0'
      if (this.taxRate !== savedTaxRateStr) return true
      if (this.serviceCharge !== savedServiceChargeStr) return true

      if (this.openingHours !== (this.data.settings.opening_hours || 'Mon–Fri 9:00 AM – 10:00 PM')) return true
      if (this.timezone !== (this.data.settings.timezone || 'Asia/Kolkata')) return true
      for (const tog of OPS_TOGGLES) {
        if (this.opToggles[tog.key] !== (this.data.settings[tog.key] === 'true')) return true
      }

      if (this.prefs.theme !== (this.data.settings.pref_theme || 'dark')) return true
      if (this.prefs.language !== (this.data.settings.pref_language || 'en')) return true
      if (this.prefs.emailAlerts !== (this.data.settings.pref_email_alerts !== 'false')) return true
      if (this.prefs.pushAlerts !== (this.data.settings.pref_push_alerts !== 'false')) return true
      if (this.prefs.soundAlerts !== (this.data.settings.pref_sound_alerts === 'true')) return true
      if (this.prefs.dailyDigest !== (this.data.settings.pref_daily_digest !== 'false')) return true
      if (this.prefs.defaultOrderType !== (this.data.settings.pref_default_order_type || 'DINE_IN')) return true
      if (this.prefs.compactMode !== (this.data.settings.pref_compact_mode === 'true')) return true

      return false
    }

    updateDirty() {
      const d = this.isDirty()
      this.dirtyRef.current = d
      return d
    }

    // Build payload exactly as save() in settings.tsx
    prepareSavePayload() {
      const parsedTaxRate = this.taxRate.trim() === '' ? 0 : parseFloat(this.taxRate)
      const parsedServiceCharge = this.serviceCharge.trim() === '' ? 0 : parseFloat(this.serviceCharge)
      const validTaxRate = isNaN(parsedTaxRate) ? 0 : Math.max(0, Math.min(100, parsedTaxRate))
      const validServiceCharge = isNaN(parsedServiceCharge) ? 0 : Math.max(0, Math.min(100, parsedServiceCharge))

      return {
        tenant: {
          name: this.tenantForm.name,
          tagline: this.tenantForm.tagline,
          email: this.tenantForm.email,
          phone: this.tenantForm.phone,
          address: this.tenantForm.address,
          currency: this.tenantForm.currency,
          currencySymbol: this.tenantForm.currencySymbol,
          logo: this.tenantForm.logo,
          taxRate: validTaxRate,
          serviceCharge: validServiceCharge,
        },
        settings: {
          opening_hours: this.openingHours,
          timezone: this.timezone,
          gstin: this.tenantForm.gstin,
          fssai: this.tenantForm.fssai,
          instagram: this.tenantForm.instagram,
          facebook: this.tenantForm.facebook,
          youtube: this.tenantForm.youtube,
          menu_theme: this.tenantForm.menuTheme,
          pref_theme: this.prefs.theme,
          pref_language: this.prefs.language,
          pref_email_alerts: String(this.prefs.emailAlerts),
          pref_push_alerts: String(this.prefs.pushAlerts),
          pref_sound_alerts: String(this.prefs.soundAlerts),
          pref_daily_digest: String(this.prefs.dailyDigest),
          pref_default_order_type: this.prefs.defaultOrderType,
          pref_compact_mode: String(this.prefs.compactMode),
          ...Object.fromEntries(Object.entries(this.opToggles).map(([k, v]) => [k, String(v)])),
        },
      }
    }
  }

  it('1. Form initial state correctly parses numeric strings from Postgres and sets opToggles', () => {
    const data = createMockData()
    const form = new SettingsFormHarness(data)

    assert.strictEqual(form.taxRate, '5', 'taxRate string is formatted without trailing decimals ("5.00" -> "5")')
    assert.strictEqual(form.serviceCharge, '0', 'serviceCharge string is formatted cleanly ("0.00" -> "0")')
    assert.strictEqual(form.opToggles['auto_accept_orders'], true, 'auto_accept_orders initialized to true')
    assert.strictEqual(form.opToggles['auto_bill_print'], true, 'auto_bill_print initialized to true')
    assert.strictEqual(form.updateDirty(), false, 'Form is not dirty on initial load')
  })

  it('2. Zero can be cleared to empty string without snapping back', () => {
    const data = createMockData()
    const form = new SettingsFormHarness(data)

    // User backspaces the '0' in Service Charge
    form.serviceCharge = ''
    assert.strictEqual(form.serviceCharge, '', 'serviceCharge state holds empty string without instantly snapping to 0')
    assert.strictEqual(form.updateDirty(), true, 'Form is marked dirty when value cleared')

    // User types '15'
    form.serviceCharge = '15'
    assert.strictEqual(form.serviceCharge, '15')
    assert.strictEqual(form.updateDirty(), true)
  })

  it('3. Zero (0) is accepted as a valid taxRate and serviceCharge', () => {
    const data = createMockData({ tenant: { taxRate: '5.00', serviceCharge: '10.00' } })
    const form = new SettingsFormHarness(data)

    // User changes taxRate to 0
    form.taxRate = '0'
    assert.strictEqual(form.updateDirty(), true, 'Setting taxRate to 0 marks form dirty when saved was 5')

    const payload = form.prepareSavePayload()
    assert.strictEqual(payload.tenant.taxRate, 0, 'Payload converts "0" to numeric 0')

    // User changes serviceCharge to 0
    form.serviceCharge = '0'
    const payload2 = form.prepareSavePayload()
    assert.strictEqual(payload2.tenant.serviceCharge, 0, 'Payload converts "0" to numeric 0 for serviceCharge')
  })

  it('4. Decimal values (e.g. 2.5, 0.5) are preserved and saved accurately', () => {
    const data = createMockData()
    const form = new SettingsFormHarness(data)

    form.taxRate = '2.5'
    form.serviceCharge = '0.5'
    assert.strictEqual(form.updateDirty(), true)

    const payload = form.prepareSavePayload()
    assert.strictEqual(payload.tenant.taxRate, 2.5)
    assert.strictEqual(payload.tenant.serviceCharge, 0.5)
  })

  it('5. Toggles flip without reverting and activate Save button', () => {
    const data = createMockData()
    const form = new SettingsFormHarness(data)

    // Initially true, user toggles Auto Accept Orders to false
    form.opToggles['auto_accept_orders'] = false
    assert.strictEqual(form.updateDirty(), true, 'Dirty is true after toggle flip')

    // Prepare save payload
    const payload = form.prepareSavePayload()
    assert.strictEqual(payload.settings.auto_accept_orders, 'false', 'Payload has auto_accept_orders: "false"')
    assert.strictEqual(payload.settings.auto_bill_print, 'true', 'Payload keeps auto_bill_print: "true"')

    // If user flips it back to true
    form.opToggles['auto_accept_orders'] = true
    assert.strictEqual(form.updateDirty(), false, 'Dirty reverts to false when returned to server state')
  })

  it('6. Periodic background polling (runDeltaSync) NEVER overwrites unsaved edits', () => {
    const data = createMockData()
    const form = new SettingsFormHarness(data)

    // User makes edits in Operations:
    // 1. Toggles auto_accept_orders to false
    form.opToggles['auto_accept_orders'] = false
    // 2. Types new tax rate 18
    form.taxRate = '18'
    // 3. Types new service charge 5
    form.serviceCharge = '5'
    form.updateDirty()

    assert.strictEqual(form.dirtyRef.current, true, 'Form is dirty with user edits')

    // Simulate 4s delta sync: new object reference for data, updated summary, new orders
    form.data = {
      ...form.data,
      summary: { todayOrders: 6, todayRevenue: 1550 },
      orders: [{ id: 'new-order-1', total: 350 }],
    }

    // Call syncFromServer (simulating background useEffect run)
    form.syncFromServer(false)

    // VERIFY user edits were NOT blown away!
    assert.strictEqual(form.opToggles['auto_accept_orders'], false, 'Toggle was NOT reverted by background sync!')
    assert.strictEqual(form.taxRate, '18', 'Tax rate was NOT reset by background sync!')
    assert.strictEqual(form.serviceCharge, '5', 'Service charge was NOT reset by background sync!')
    assert.strictEqual(form.dirtyRef.current, true, 'Form remains dirty and Save button remains active!')
  })

  it('7. Discard cleanly restores original state and resets dirty', () => {
    const data = createMockData()
    const form = new SettingsFormHarness(data)

    form.taxRate = '12'
    form.serviceCharge = '3'
    form.opToggles['auto_bill_print'] = false
    assert.strictEqual(form.updateDirty(), true)

    // User clicks Discard
    form.initForm(form.data)
    assert.strictEqual(form.taxRate, '5')
    assert.strictEqual(form.serviceCharge, '0')
    assert.strictEqual(form.opToggles['auto_bill_print'], true)
    assert.strictEqual(form.updateDirty(), false, 'Dirty is false after discard')
  })

  it('8. Save cleanly updates server baseline and clears dirty state', () => {
    const data = createMockData()
    const form = new SettingsFormHarness(data)

    form.taxRate = '0'
    form.serviceCharge = '0'
    form.opToggles['auto_accept_orders'] = false
    assert.strictEqual(form.updateDirty(), true)

    const payload = form.prepareSavePayload()
    assert.strictEqual(payload.tenant.taxRate, 0)
    assert.strictEqual(payload.settings.auto_accept_orders, 'false')

    // Simulate server response and refresh() updating data
    form.data = createMockData({
      tenant: { taxRate: '0.00', serviceCharge: '0.00' },
      settings: { auto_accept_orders: 'false' },
    })

    // After save completes, form updates its local state with the saved values
    form.taxRate = String(payload.tenant.taxRate)
    form.serviceCharge = String(payload.tenant.serviceCharge)
    form.opToggles['auto_accept_orders'] = payload.settings.auto_accept_orders === 'true'

    // Form dirty check against fresh server data
    assert.strictEqual(form.updateDirty(), false, 'Form is no longer dirty after save completes and refreshes')
  })
})

