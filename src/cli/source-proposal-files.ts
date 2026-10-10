import { readFileSync, writeFileSync } from 'node:fs';
import { commandOption } from './project-command-runtime.ts';
import {
  SOURCE_PROPOSAL_SCHEMA,
  validateSourceAssignment,
  validateSourceProposal,
} from '../source/source-obligation.ts';

const assignmentPath = commandOption('--assignment');
const outputPath = commandOption('--output');
if (!assignmentPath || !outputPath) throw new Error('SOURCE_PROPOSAL_FILES_ARGUMENTS_REQUIRED');
const encoded = process.env.SOURCE_PROPOSAL_FILES_BASE64 ?? '';
if (!encoded || encoded.length > 1000000) throw new Error('SOURCE_PROPOSAL_FILES_SIZE_INVALID');
const bytes = Buffer.from(encoded, 'base64');
if (bytes.toString('base64') !== encoded || !Buffer.from(bytes.toString('utf8')).equals(bytes))
  throw new Error('SOURCE_PROPOSAL_FILES_ENCODING_INVALID');
const assignment = validateSourceAssignment(JSON.parse(readFileSync(assignmentPath, 'utf8')));
const proposal = validateSourceProposal(
  {
    schema: SOURCE_PROPOSAL_SCHEMA,
    run_id: assignment.claim.run_id,
    claimed_revision: assignment.claim.claimed_revision,
    claimed_source_sha: assignment.claim.source_sha,
    files: JSON.parse(bytes.toString('utf8')),
  },
  assignment.task,
  assignment.claim,
);
writeFileSync(outputPath, `${JSON.stringify(proposal, null, 2)}\n`);
