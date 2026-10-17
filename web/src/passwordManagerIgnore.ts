/**
 * Search fields are not credentials, but password-manager extensions open
 * their autofill menu on any focused text input, covering the menu that just
 * opened. `autocomplete="off"` alone does not stop them; each honors its own
 * opt-out attribute.
 */
export const passwordManagerIgnore = {
  "data-bwignore": "true",
  "data-1p-ignore": "true",
  "data-lpignore": "true",
  "data-form-type": "other",
} as const;
