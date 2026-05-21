/**
 * Permission enforcement layer. Automation actions call {@link assertGranted}
 * before doing anything sensitive; the result is surfaced to the renderer so it
 * can show an explicit approval prompt. Nothing here grants permission
 * silently — every grant is an explicit user action recorded in the log.
 */
import { getConfig, updateConfig } from '../storage/config'
import { log } from '../logger'
import { PERMISSIONS } from '@shared/permissions'
import type { PermissionId, PermissionState } from '@shared/permissions'

export class PermissionDeniedError extends Error {
  constructor(public readonly permission: PermissionId) {
    super(`Permission "${permission}" has not been granted.`)
    this.name = 'PermissionDeniedError'
  }
}

export function getPermissions(): Record<PermissionId, PermissionState> {
  return getConfig().permissions
}

export function isGranted(id: PermissionId): boolean {
  return getConfig().permissions[id]?.granted ?? false
}

export function assertGranted(id: PermissionId): void {
  if (!isGranted(id)) throw new PermissionDeniedError(id)
}

export function setPermission(
  id: PermissionId,
  granted: boolean
): Record<PermissionId, PermissionState> {
  const permissions = { ...getConfig().permissions }
  permissions[id] = {
    granted,
    grantedAt: granted ? new Date().toISOString() : null
  }
  updateConfig({ permissions })
  const def = PERMISSIONS.find((p) => p.id === id)
  log(
    granted ? 'success' : 'warn',
    'permission',
    `${granted ? 'Granted' : 'Revoked'} permission: ${def?.label ?? id}`
  )
  return permissions
}

export function revokeAll(): Record<PermissionId, PermissionState> {
  let permissions = getConfig().permissions
  for (const p of PERMISSIONS) {
    permissions = setPermission(p.id, false)
  }
  return permissions
}
