import type { TokenRole } from "../tokens";
import { tokenName } from "../tokens";

export type NexusTheme = Partial<Record<TokenRole, string>>;

export function themeToCssVariables(
  theme: NexusTheme
): Record<string, string> {
  const variables: Record<string, string> = {};

  for (const [role, value] of Object.entries(theme)) {
    if (value === undefined) continue;

    variables[tokenName(role as TokenRole)] = value;
  }

  return variables;
}
