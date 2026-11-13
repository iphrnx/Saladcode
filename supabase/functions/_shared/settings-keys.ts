/**
 * Keys in the `settings` table that more than one function has to agree on.
 *
 * `settings` is a plain key/value table, so nothing enforces that two functions
 * spell a key the same way. The onboarding draft is written by the wizard and
 * withheld by bootstrap, so both have to name it identically — a typo in one
 * would silently stop the other from finding it, and the failure would read as
 * "the draft was never saved" rather than as a mismatch.
 */

/** The onboarding wizard's unsaved work, written before setup is complete. */
export const ONBOARDING_DRAFT_KEY = "onboarding_draft";
