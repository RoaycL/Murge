/**
 * PHASE 9 LEGACY (superseded by Phase 9B): the reviewed COM-launch and
 * state-directory SDDL contracts. The state-directory SDDL is STILL the
 * normative contract the Go service matches byte-for-byte (see the
 * `stateDirectorySDDL` constant in native/tun-service/runtime_windows.go) —
 * the Go side now carries the SAME mandatory-integrity label, so a Medium-IL
 * same-user process can neither read nor write the service state directory.
 * The COM masks are audit-trail only.
 */
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'

export const COM_LAUNCH_MASK = 0x0b
export const COM_ACCESS_MASK = 0x03
export const STATE_DIRECTORY_SDDL = 'O:SYG:SYD:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)S:(ML;OICI;NW;;;HI)'

const SID_PATTERN = /^S-1-(?:\d+-){1,14}\d+$/

export interface ComSecurityDescriptorContract {
  launchSddl: string
  accessSddl: string
  launchMask: typeof COM_LAUNCH_MASK
  accessMask: typeof COM_ACCESS_MASK
}

/** Builds the exact reviewed SDDL source strings. Conversion to binary is Windows-only and remains gated. */
export function buildComSecurityDescriptorContract(ownerSid: string): ComSecurityDescriptorContract {
  if (!SID_PATTERN.test(ownerSid)) {
    throw new ProtocolError(ProtocolErrorCode.TUN_SECURITY_DESCRIPTOR_INVALID, 'Invalid owner SID', { path: 'ownerSid' })
  }
  return {
    launchSddl: `D:P(A;;0xB;;;SY)(A;;0xB;;;BA)(A;;0xB;;;${ownerSid})`,
    accessSddl: `D:P(A;;0x3;;;SY)(A;;0x3;;;${ownerSid})`,
    launchMask: COM_LAUNCH_MASK,
    accessMask: COM_ACCESS_MASK
  }
}
