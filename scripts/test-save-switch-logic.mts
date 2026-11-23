/**
 * Save & Switch State Machine & Behavior Verification
 *
 * Verifies that:
 * 1. An in-flight save keeps the dialog open and disables buttons & dismissal.
 * 2. On success: closes the dialog, clears error, and transitions to requested role/tab.
 * 3. On failure: dialog stays open, draft & target preserved, error displayed, retry enabled.
 */

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`  ✓ ok   ${label}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL ${label}${detail ? `\n        ${detail}` : ""}`);
  }
}

// Model the state machine implemented in RolesView
class RolesNavigationStateMachine {
  selectedRole: { id: string; name: string } = { id: "role-1", name: "Manager" };
  selectedId: string = "role-1";
  activeTab: "roles" | "staff" = "roles";
  isDetailDirty: boolean = false;
  unsavedTarget: { type: "role"; id: string } | { type: "tab"; tab: "roles" | "staff" } | null = null;
  isSavingSwitch: boolean = false;
  saveSwitchError: string | null = null;

  saveFn: (() => Promise<boolean>) | null = null;
  discardFn: (() => void) | null = null;

  handleSelectRole(roleId: string) {
    if (roleId === this.selectedRole.id) return;
    if (this.isDetailDirty) {
      this.saveSwitchError = null;
      this.unsavedTarget = { type: "role", id: roleId };
    } else {
      this.selectedId = roleId;
    }
  }

  handleTabChange(tab: "roles" | "staff") {
    if (tab === this.activeTab) return;
    if (this.isDetailDirty) {
      this.saveSwitchError = null;
      this.unsavedTarget = { type: "tab", tab };
    } else {
      this.activeTab = tab;
    }
  }

  handleDismissDialog(isOpen: boolean) {
    if (!isOpen && !this.isSavingSwitch) {
      this.unsavedTarget = null;
      this.saveSwitchError = null;
    }
  }

  async handleConfirmSaveSwitch(): Promise<boolean> {
    if (this.isSavingSwitch || !this.saveFn) return false;
    this.isSavingSwitch = true;
    this.saveSwitchError = null;

    try {
      const ok = await this.saveFn();
      if (ok) {
        const target = this.unsavedTarget;
        this.unsavedTarget = null;
        this.saveSwitchError = null;
        this.isSavingSwitch = false;
        if (target?.type === "role") this.selectedId = target.id;
        if (target?.type === "tab") this.activeTab = target.tab;
        return true;
      } else {
        this.saveSwitchError = "Failed to save changes. Please try again.";
        this.isSavingSwitch = false;
        return false;
      }
    } catch (err: any) {
      this.saveSwitchError = err?.message || "Failed to save changes. Please try again.";
      this.isSavingSwitch = false;
      return false;
    }
  }

  handleConfirmDiscardSwitch() {
    if (this.isSavingSwitch) return;
    if (this.discardFn) this.discardFn();
    const target = this.unsavedTarget;
    this.unsavedTarget = null;
    this.saveSwitchError = null;
    if (target?.type === "role") this.selectedId = target.id;
    if (target?.type === "tab") this.activeTab = target.tab;
  }
}

async function runTests() {
  console.log("\n========================================================");
  console.log("  Save & Switch State Machine & Behavior Tests");
  console.log("========================================================\n");

  // 1. Navigation without dirty state
  const sm1 = new RolesNavigationStateMachine();
  sm1.handleSelectRole("role-2");
  check("Clean state: directly switches role without opening dialog", sm1.selectedId === "role-2" && sm1.unsavedTarget === null);

  // 2. Navigation with dirty state
  sm1.isDetailDirty = true;
  sm1.handleSelectRole("role-3");
  check("Dirty state: sets unsavedTarget and preserves selectedId", sm1.selectedId === "role-2" && sm1.unsavedTarget?.type === "role" && sm1.unsavedTarget.id === "role-3");

  // 3. Pending save: duplicate clicks disabled & dismissal blocked
  let resolveSave: (ok: boolean) => void;
  sm1.saveFn = () => new Promise<boolean>((resolve) => { resolveSave = resolve; });

  const savePromise = sm1.handleConfirmSaveSwitch();
  check("While save is pending: isSavingSwitch is true", sm1.isSavingSwitch === true);

  // Attempt duplicate save
  const duplicateSave = await sm1.handleConfirmSaveSwitch();
  check("While save is pending: duplicate submission is refused", duplicateSave === false);

  // Attempt dismissal during save
  sm1.handleDismissDialog(false);
  check("While save is pending: dismissal is blocked (unsavedTarget preserved)", sm1.unsavedTarget !== null);

  // 4. Save Success Flow
  resolveSave!(true);
  const saveResult = await savePromise;
  check("Save succeeds: returns true", saveResult === true);
  check("Save succeeds: isSavingSwitch returns to false", sm1.isSavingSwitch === false);
  check("Save succeeds: dialog closed (unsavedTarget is null)", sm1.unsavedTarget === null);
  check("Save succeeds: switched to originally requested role (role-3)", sm1.selectedId === "role-3");

  // 5. Save Failure Flow
  console.log("\n── Save Failure & Retry Flow ──");
  const sm2 = new RolesNavigationStateMachine();
  sm2.selectedId = "role-1";
  sm2.isDetailDirty = true;
  sm2.handleTabChange("staff");
  check("Dirty state: switching tab sets unsavedTarget to staff", sm2.unsavedTarget?.type === "tab" && sm2.unsavedTarget.tab === "staff");

  // Make save fail
  sm2.saveFn = async () => {
    throw new Error("Network timeout: 504 Gateway Timeout");
  };

  const failedResult = await sm2.handleConfirmSaveSwitch();
  check("Save fails: returns false", failedResult === false);
  check("Save fails: isSavingSwitch returns to false", sm2.isSavingSwitch === false);
  check("Save fails: dialog STAYS open (unsavedTarget preserved)", sm2.unsavedTarget !== null && sm2.unsavedTarget.tab === "staff");
  check("Save fails: current tab preserved (still on roles)", sm2.activeTab === "roles");
  check("Save fails: error displayed in dialog", sm2.saveSwitchError === "Network timeout: 504 Gateway Timeout");

  // 6. Retry after failure succeeds
  console.log("\n── Retry Flow ──");
  sm2.saveFn = async () => true; // Network recovers
  const retryResult = await sm2.handleConfirmSaveSwitch();
  check("Retry succeeds: returns true", retryResult === true);
  check("Retry succeeds: dialog closes and switches tab to staff", sm2.unsavedTarget === null && sm2.activeTab === "staff");
  check("Retry succeeds: saveSwitchError cleared", sm2.saveSwitchError === null);

  // 7. Role Creation onCreated Unsaved Edits Flow
  console.log("\n── Role Creation onCreated Unsaved Edits Flow ──");
  const sm3 = new RolesNavigationStateMachine();
  sm3.selectedId = "role-1";
  sm3.isDetailDirty = false;

  // Clean editor role creation
  const handleRoleCreated = async (newRole: { id: string; name: string }) => {
    // In RolesView: onCreated calls await refresh() then handleSelectRole(newRole.id)
    sm3.handleSelectRole(newRole.id);
  };

  await handleRoleCreated({ id: "role-new-1", name: "Sommelier" });
  check("Clean editor onCreated: selects new role immediately", sm3.selectedId === "role-new-1" && sm3.unsavedTarget === null);

  // Dirty editor role creation
  sm3.selectedId = "role-1";
  sm3.isDetailDirty = true;
  await handleRoleCreated({ id: "role-new-2", name: "Barista" });
  check("Dirty editor onCreated: does NOT change selectedId directly", sm3.selectedId === "role-1");
  check("Dirty editor onCreated: triggers unsaved changes dialog with new role target", sm3.unsavedTarget?.type === "role" && sm3.unsavedTarget.id === "role-new-2");

  // User chooses Stay on Role
  sm3.handleDismissDialog(false);
  check("Dirty editor onCreated -> Stay: preserves current selection and draft", sm3.selectedId === "role-1" && sm3.unsavedTarget === null && sm3.isDetailDirty === true);

  // Re-trigger dirty creation switch
  await handleRoleCreated({ id: "role-new-2", name: "Barista" });

  // Save fails on Save & Switch
  sm3.saveFn = async () => false;
  const saveFailed = await sm3.handleConfirmSaveSwitch();
  check("Dirty editor onCreated -> Save & Switch fails: returns false", saveFailed === false);
  check("Dirty editor onCreated -> Save & Switch fails: preserves current selection", sm3.selectedId === "role-1");
  check("Dirty editor onCreated -> Save & Switch fails: dialog stays open for retry", sm3.unsavedTarget?.type === "role" && sm3.unsavedTarget.id === "role-new-2");
  check("Dirty editor onCreated -> Save & Switch fails: error message displayed", sm3.saveSwitchError !== null);

  // Save succeeds on retry
  sm3.saveFn = async () => {
    sm3.isDetailDirty = false;
    return true;
  };
  const saveRetry = await sm3.handleConfirmSaveSwitch();
  check("Dirty editor onCreated -> Save retry succeeds: returns true", saveRetry === true);
  check("Dirty editor onCreated -> Save retry succeeds: dialog closed", sm3.unsavedTarget === null);
  check("Dirty editor onCreated -> Save retry succeeds: switched to new role", sm3.selectedId === "role-new-2");

  // 8. Bulk Permission Editing Editability & State Tests
  console.log("\n── Bulk Permission Editing with Role Manager ──");
  const PERMISSION_IMPLICATIONS: Record<string, string> = {
    "orders.create": "orders.view",
    "orders.edit": "orders.view",
    "orders.cancel": "orders.view",
    "orders.complete": "orders.view",
    "orders.prepare": "orders.view",
    "orders.ready": "orders.view",
    "orders.serve": "orders.view",
    "orders.discount": "orders.view",
    "payments.refund": "payments.collect",
    "table-sessions.manage": "tables.view",
    "menu.manage": "menu.view",
    "tables.manage": "tables.view",
    "promos.manage": "promos.view",
    "settings.manage": "settings.view",
    "security.manage": "security.view",
  };

  const expandPermissions = (perms: readonly string[]) => {
    const out = new Set<string>();
    for (const p of perms) {
      out.add(p);
      const implied = PERMISSION_IMPLICATIONS[p];
      if (implied) out.add(implied);
    }
    return [...out];
  };

  // Scenario: Role manager can grant only some permissions in Orders group
  const managerGrantableKeys = ["orders.view", "orders.prepare", "orders.ready", "orders.serve"];
  const ordersGroupPerms = [
    "orders.view", "orders.create", "orders.edit", "orders.cancel",
    "orders.complete", "orders.prepare", "orders.ready", "orders.serve", "orders.discount"
  ];

  let permState: string[] = [];
  const viewerCanGrant = (perm: string) => managerGrantableKeys.includes(perm);

  const isPermEditable = (perm: string, currentPerms: string[]) => {
    if (!viewerCanGrant(perm)) return false;
    const lockedByUngrantable = currentPerms.some(
      (k) => PERMISSION_IMPLICATIONS[k] === perm && !viewerCanGrant(k)
    );
    if (lockedByUngrantable) return false;
    return true;
  };

  const getBulkState = (groupPerms: string[], currentPerms: string[]) => {
    const effective = expandPermissions(currentPerms);
    const editablePerms = groupPerms.filter((p) => isPermEditable(p, currentPerms));
    const hasEditable = editablePerms.length > 0;
    const allEditableOn = hasEditable && editablePerms.every((p) => effective.includes(p));
    return { editablePerms, hasEditable, allEditableOn, label: allEditableOn ? "Clear" : "Select all" };
  };

  const toggleGroup = (groupPerms: string[], on: boolean, currentPerms: string[]) => {
    const editableInGroup = groupPerms.filter((p) => isPermEditable(p, currentPerms));
    if (editableInGroup.length === 0) return currentPerms;
    if (on) {
      return Array.from(new Set([...currentPerms, ...editableInGroup]));
    } else {
      return currentPerms.filter((p) => !editableInGroup.includes(p));
    }
  };

  // Initial state: empty custom role
  let bulkState = getBulkState(ordersGroupPerms, permState);
  check("Manager can edit only their 4 grantable permissions in Orders (4/9)", bulkState.editablePerms.length === 4);
  check("Initial bulk button state calculates to 'Select all'", bulkState.label === "Select all" && bulkState.allEditableOn === false);

  // Click Select All
  permState = toggleGroup(ordersGroupPerms, true, permState);
  check("Select All grants ONLY the 4 grantable permissions", permState.length === 4 && permState.every(p => managerGrantableKeys.includes(p)));
  check("Select All does NOT grant unheld orders.create, edit, cancel, complete, discount", !permState.includes("orders.cancel") && !permState.includes("orders.create"));

  // Check state after Select All
  bulkState = getBulkState(ordersGroupPerms, permState);
  check("Bulk button state calculates to 'Clear' after Select All", bulkState.label === "Clear" && bulkState.allEditableOn === true);

  // Click Clear
  permState = toggleGroup(ordersGroupPerms, false, permState);
  check("Clear removes all editable permissions", permState.length === 0);
  bulkState = getBulkState(ordersGroupPerms, permState);
  check("Bulk button state flips back to 'Select all' after Clear", bulkState.label === "Select all" && bulkState.allEditableOn === false);

  // Scenario: Role already contains locked permissions (orders.cancel set by Owner)
  permState = ["orders.cancel", "orders.prepare"];
  bulkState = getBulkState(ordersGroupPerms, permState);
  // orders.cancel implies orders.view and is ungrantable by manager, so orders.view is locked by ungrantable implication
  check("orders.view is locked when ungrantable orders.cancel is present", !isPermEditable("orders.view", permState));
  check("orders.prepare and orders.ready remain editable", isPermEditable("orders.prepare", permState) && isPermEditable("orders.ready", permState));

  // Select all preserves locked orders.cancel
  permState = toggleGroup(ordersGroupPerms, true, permState);
  check("Select all preserves locked orders.cancel in permState", permState.includes("orders.cancel"));
  check("Select all enabled orders.ready and orders.serve", permState.includes("orders.ready") && permState.includes("orders.serve"));

  // Clear preserves locked orders.cancel and respects implication of orders.view
  permState = toggleGroup(ordersGroupPerms, false, permState);
  check("Clear preserves locked orders.cancel in permState", permState.includes("orders.cancel"));
  check("Clear removed editable orders.prepare, orders.ready, orders.serve", !permState.includes("orders.prepare") && !permState.includes("orders.ready") && !permState.includes("orders.serve"));
  const effectiveAfterClear = expandPermissions(permState);
  check("effectivePerms still holds orders.view because locked orders.cancel implies it", effectiveAfterClear.includes("orders.view"));

  // Scenario: Manager holds 0 permissions in Settings group
  const settingsGroupPerms = ["settings.view", "settings.manage"];
  const settingsBulk = getBulkState(settingsGroupPerms, permState);
  check("Manager holds 0 permissions in Settings -> hasEditable is false (button disabled)", settingsBulk.hasEditable === false && settingsBulk.editablePerms.length === 0);

  console.log("\n========================================================");
  console.log(`  Results: ${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
  console.log("========================================================\n");

  if (fail > 0) process.exit(1);
}

runTests();
