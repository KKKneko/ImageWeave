import { createPlaceholderShell } from "../components/empty-state.js";

export function createPlaceholderApplication(responsibility) {
  return createPlaceholderShell({ responsibility });
}
