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

  console.log("\n========================================================");
  console.log(`  Results: ${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
  console.log("========================================================\n");

  if (fail > 0) process.exit(1);
}

runTests();
