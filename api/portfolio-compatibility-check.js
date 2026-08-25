export const access = 'admin';
export const methods = ['POST'];

export default async function (_req, res) {
  return res.status(410).json({
    ok: false,
    command: 'portfolio.compatibility_check',
    schema_version: 'command-response-v1',
    error: 'LEGACY_CONTROL_PLANE_RETIRED',
    error_code: 'LEGACY_CONTROL_PLANE_RETIRED',
    code: 'LEGACY_CONTROL_PLANE_RETIRED',
    error_class: 'precondition',
    message: 'Disposed-repository compatibility execution was retired with the Agent Execution Control Plane. Historical repositories remain readable but cannot receive compatibility incident or release work.',
    retryable: false,
    rejection: true,
    may_have_mutated: false,
    recommended_action: 'use_busbar',
    escalation_required: false,
    legacy_system: 'agent_execution_control_plane',
    replacement: { system: 'busbar' },
  });
}