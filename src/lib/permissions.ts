/**
 * Client-side mirror of the Convex permission model (src/convex/access.ts).
 * The session query returns this shape; navigation renders only modules the
 * user's role grants.
 */
export interface PermissionSet {
  dashboard: boolean;
  workspace: boolean;
  audit: boolean;
  risk: boolean;
  compliance: boolean;
  cyber: boolean;
  bcm: boolean;
  reports: boolean;
  admin: boolean;
  adminManage: boolean;
}

export const DEFAULT_PERMISSIONS: PermissionSet = {
  dashboard: false,
  workspace: false,
  audit: false,
  risk: false,
  compliance: false,
  cyber: false,
  bcm: false,
  reports: false,
  admin: false,
  adminManage: false,
};
