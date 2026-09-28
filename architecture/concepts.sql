-- Relational language for Overcenter architecture.
--
-- This file defines what can be said. It contains no repository paths,
-- provider names, workflow names, or current implementation bindings.

PRAGMA foreign_keys = ON;

CREATE TABLE authority (
  authority_id TEXT PRIMARY KEY CHECK (length(trim(authority_id)) > 0)
) STRICT;

CREATE TABLE effect (
  effect_id TEXT PRIMARY KEY CHECK (length(trim(effect_id)) > 0)
) STRICT;

CREATE TABLE obligation (
  obligation_id TEXT PRIMARY KEY CHECK (length(trim(obligation_id)) > 0)
) STRICT;

CREATE TABLE evidence (
  evidence_id TEXT PRIMARY KEY CHECK (length(trim(evidence_id)) > 0)
) STRICT;

CREATE TABLE capability (
  capability_id TEXT PRIMARY KEY CHECK (length(trim(capability_id)) > 0)
) STRICT;

CREATE TABLE assurance_property (
  property_id TEXT PRIMARY KEY CHECK (length(trim(property_id)) > 0)
) STRICT;

CREATE TABLE assurance_property_requires_authority (
  property_id TEXT NOT NULL REFERENCES assurance_property(property_id) ON DELETE CASCADE,
  authority_id TEXT NOT NULL REFERENCES authority(authority_id) ON DELETE CASCADE,
  PRIMARY KEY (property_id, authority_id)
) STRICT;

CREATE TABLE assurance_property_requires_capability (
  property_id TEXT NOT NULL REFERENCES assurance_property(property_id) ON DELETE CASCADE,
  capability_id TEXT NOT NULL REFERENCES capability(capability_id) ON DELETE CASCADE,
  PRIMARY KEY (property_id, capability_id)
) STRICT;

CREATE TABLE assurance_property_guards_effect (
  property_id TEXT NOT NULL REFERENCES assurance_property(property_id) ON DELETE CASCADE,
  effect_id TEXT NOT NULL REFERENCES effect(effect_id) ON DELETE CASCADE,
  PRIMARY KEY (property_id, effect_id)
) STRICT;

CREATE TABLE assurance_property_requires_effect_implementation (
  property_id TEXT NOT NULL REFERENCES assurance_property(property_id) ON DELETE CASCADE,
  effect_id TEXT NOT NULL REFERENCES effect(effect_id) ON DELETE CASCADE,
  PRIMARY KEY (property_id, effect_id)
) STRICT;

CREATE TABLE effect_requires_authority (
  effect_id TEXT NOT NULL REFERENCES effect(effect_id) ON DELETE CASCADE,
  authority_id TEXT NOT NULL REFERENCES authority(authority_id) ON DELETE CASCADE,
  PRIMARY KEY (effect_id, authority_id)
) STRICT;

CREATE TABLE authority_depends_on_authority (
  authority_id TEXT NOT NULL REFERENCES authority(authority_id) ON DELETE CASCADE,
  required_authority_id TEXT NOT NULL REFERENCES authority(authority_id) ON DELETE CASCADE,
  PRIMARY KEY (authority_id, required_authority_id),
  CHECK (authority_id <> required_authority_id)
) STRICT;

CREATE TABLE effect_requires_capability (
  effect_id TEXT NOT NULL REFERENCES effect(effect_id) ON DELETE CASCADE,
  capability_id TEXT NOT NULL REFERENCES capability(capability_id) ON DELETE CASCADE,
  PRIMARY KEY (effect_id, capability_id)
) STRICT;

CREATE TABLE obligation_guards_effect (
  obligation_id TEXT NOT NULL REFERENCES obligation(obligation_id) ON DELETE CASCADE,
  effect_id TEXT NOT NULL REFERENCES effect(effect_id) ON DELETE CASCADE,
  PRIMARY KEY (obligation_id, effect_id)
) STRICT;

CREATE TABLE evidence_witnesses_obligation (
  evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id) ON DELETE CASCADE,
  obligation_id TEXT NOT NULL REFERENCES obligation(obligation_id) ON DELETE CASCADE,
  PRIMARY KEY (evidence_id, obligation_id)
) STRICT;

CREATE TABLE evidence_witnesses_capability (
  evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id) ON DELETE CASCADE,
  capability_id TEXT NOT NULL REFERENCES capability(capability_id) ON DELETE CASCADE,
  PRIMARY KEY (evidence_id, capability_id)
) STRICT;

CREATE TABLE capability_depends_on_capability (
  capability_id TEXT NOT NULL REFERENCES capability(capability_id) ON DELETE CASCADE,
  required_capability_id TEXT NOT NULL REFERENCES capability(capability_id) ON DELETE CASCADE,
  PRIMARY KEY (capability_id, required_capability_id),
  CHECK (capability_id <> required_capability_id)
) STRICT;

CREATE TABLE artifact (
  artifact_id TEXT PRIMARY KEY CHECK (length(trim(artifact_id)) > 0)
) STRICT;

CREATE TABLE symbol (
  symbol_id TEXT PRIMARY KEY CHECK (length(trim(symbol_id)) > 0),
  artifact_id TEXT NOT NULL REFERENCES artifact(artifact_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE principal (
  principal_id TEXT PRIMARY KEY CHECK (length(trim(principal_id)) > 0)
) STRICT;

CREATE TABLE principal_defined_in_artifact (
  principal_id TEXT PRIMARY KEY REFERENCES principal(principal_id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES artifact(artifact_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE symbol_implements_authority (
  symbol_id TEXT NOT NULL REFERENCES symbol(symbol_id) ON DELETE CASCADE,
  authority_id TEXT NOT NULL REFERENCES authority(authority_id) ON DELETE CASCADE,
  PRIMARY KEY (symbol_id, authority_id)
) STRICT;

CREATE TABLE symbol_implements_capability (
  symbol_id TEXT NOT NULL REFERENCES symbol(symbol_id) ON DELETE CASCADE,
  capability_id TEXT NOT NULL REFERENCES capability(capability_id) ON DELETE CASCADE,
  PRIMARY KEY (symbol_id, capability_id)
) STRICT;

CREATE TABLE symbol_projects_capability (
  symbol_id TEXT NOT NULL REFERENCES symbol(symbol_id) ON DELETE CASCADE,
  capability_id TEXT NOT NULL REFERENCES capability(capability_id) ON DELETE CASCADE,
  PRIMARY KEY (symbol_id, capability_id)
) STRICT;

CREATE TABLE symbol_performs_effect (
  symbol_id TEXT NOT NULL REFERENCES symbol(symbol_id) ON DELETE CASCADE,
  effect_id TEXT NOT NULL REFERENCES effect(effect_id) ON DELETE CASCADE,
  PRIMARY KEY (symbol_id, effect_id)
) STRICT;

CREATE TABLE symbol_dispatches_to_symbol (
  symbol_id TEXT NOT NULL REFERENCES symbol(symbol_id) ON DELETE CASCADE,
  implementation_symbol_id TEXT NOT NULL REFERENCES symbol(symbol_id) ON DELETE CASCADE,
  PRIMARY KEY (symbol_id, implementation_symbol_id),
  CHECK (symbol_id <> implementation_symbol_id)
) STRICT;

CREATE TABLE artifact_witnesses_evidence (
  artifact_id TEXT NOT NULL REFERENCES artifact(artifact_id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id) ON DELETE CASCADE,
  PRIMARY KEY (artifact_id, evidence_id)
) STRICT;

CREATE TABLE principal_holds_authority (
  principal_id TEXT NOT NULL REFERENCES principal(principal_id) ON DELETE CASCADE,
  authority_id TEXT NOT NULL REFERENCES authority(authority_id) ON DELETE CASCADE,
  PRIMARY KEY (principal_id, authority_id)
) STRICT;

CREATE TABLE principal_has_capability (
  principal_id TEXT NOT NULL REFERENCES principal(principal_id) ON DELETE CASCADE,
  capability_id TEXT NOT NULL REFERENCES capability(capability_id) ON DELETE CASCADE,
  PRIMARY KEY (principal_id, capability_id)
) STRICT;

CREATE TABLE principal_invokes_effect (
  principal_id TEXT NOT NULL REFERENCES principal(principal_id) ON DELETE CASCADE,
  effect_id TEXT NOT NULL REFERENCES effect(effect_id) ON DELETE CASCADE,
  PRIMARY KEY (principal_id, effect_id)
) STRICT;

CREATE TABLE principal_reaches_effect (
  principal_id TEXT NOT NULL REFERENCES principal(principal_id) ON DELETE CASCADE,
  effect_id TEXT NOT NULL REFERENCES effect(effect_id) ON DELETE CASCADE,
  PRIMARY KEY (principal_id, effect_id)
) STRICT;
