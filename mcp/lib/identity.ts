/**
 * Who an authenticated request belongs to (ported from Tonight).
 *
 * One stable id and nothing else. Here the id is a **member id** (plan §7.2):
 * codes, refresh families and access-token `sub` all name one membership row.
 * A member row never changes workspace and removal is final, so a credential
 * issued for one workspace can never act in another. To every reader outside
 * `lib/workspace` it is an opaque key.
 */
export type AuthenticatedUser = {
  id: string;
};
