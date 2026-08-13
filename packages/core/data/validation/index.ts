/**
 * @status core
 *
 * Generic validation boundary. Project-specific schemas belong in Client Experience.
 */
export type ValidationResult =
  | { success: true }
  | { success: false; message: string };

export function valid(): ValidationResult {
  return { success: true };
}
