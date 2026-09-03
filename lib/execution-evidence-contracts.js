export const EXECUTION_EVIDENCE_SCHEMA = 'execution-evidence-v1';
export const MUTATION_CERTAINTIES = [
    'not_applicable',
    'confirmed_present',
    'definitively_absent',
    'unknown',
];
export const NO_EXTERNAL_MUTATION_COMMANDS = [
    'github.review_packet',
    'github.capabilities',
    'work.checkpoint',
    'work.heartbeat',
    'skill.activate',
    'skill.complete',
    'orchestration.start',
    'orchestration.horizon_checkpoint',
    'orchestration.horizon_resolve',
    'orchestration.finish',
    'orchestration.maintain',
    'orchestration.resume_packet',
    'orchestration.diagnose',
    'orchestration.status',
];
export const VERIFIED_EXTERNAL_EFFECT_COMMANDS = [
    'github.repository_metadata.ensure',
    'github.repository.rename',
    'github.repository_template.ensure',
    'github.repository_from_template.create',
    'github.milestone.ensure',
    'github.release.create',
    'github.required_checks.ensure',
];
