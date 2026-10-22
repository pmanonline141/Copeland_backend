export const roles = ['admin', 'staff', 'supplier', 'shipping', 'buyer'];
export function isRole(value) {
    return typeof value === 'string' && roles.includes(value);
}
export function hasRole(actualRole, allowedRoles) {
    return isRole(actualRole) && allowedRoles.includes(actualRole);
}
