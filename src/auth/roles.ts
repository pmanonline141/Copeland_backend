export const roles = ['admin', 'staff', 'supplier', 'shipping', 'buyer'] as const;
export type Role = (typeof roles)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && roles.includes(value as Role);
}

export function hasRole(actualRole: unknown, allowedRoles: readonly Role[]): boolean {
  return isRole(actualRole) && allowedRoles.includes(actualRole);
}
