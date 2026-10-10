# Owner consent: one informed decision, only for consequential work

This is the policy for [mobile owner approval](https://github.com/laurajoyhutchins/overcenter/issues/702).

**Ordinary bounded maintenance:** No owner review. Trusted source admission,
verification, settlement and independent readback remain mandatory. An unknown
impact or missing narrow delegation **holds**, rather than creating another
owner chore. Merely editing an `architecture/` path is not automatically
authorization to change the protected model.

**Owner-significant decisions:** IAM/privilege grants, protection-policy changes,
production cutovers, irreversible data changes, material financial commitments,
and external legal commitments. Any of these requires an exact request, an
intelligible explanation, and an authenticated Approve/Reject event.

The consent card must state: what will happen, why, exact scope, principal
risk and cost, consequence of **Approve**, consequence of **Reject**, recovery,
and subsequent independent verification. Technical evidence is linked separately.
Changing a material field, source base, tree, or identity invalidates the
request digest. Rejection must not perform the proposed effect.

`src/owner-consent.ts` defines a **pure, non-authorizing classifier and review
summary**. Its `independently-verified` input and routine policy flag are
not authentication; neither a worker assertion nor this module can mint a
privileged effect. A trusted accepted runner must first establish the input
facts, admission and exact-tree identity. An authenticated deployment-review
record must be independently retrieved and bound to the digest, identity,
expiry, one-time operation and exact source before a reserved effect may execute.

The existing `.github/workflows/owner-approval-canary.yml` is intentionally a
**no-side-effect canary**. It is not the operator approval system; it still
requires a manual owner dispatch and a GitHub environment that must be
configured and actually verified. GitHub environment required reviewers can
offer an in-app Approve/Reject review, but the settings and mobile notification
have not been independently read back in this project. The accepted protected
recovery workflow remains owner-dispatched and is not replaced by this policy.

Next operational steps: read back reviewer environment configuration; perform
one live approve/reject no-effect canary; connect a trusted automatic request
dispatcher with a manifest digest; revalidate owner review, exact base and
bounded identity after approval; complete independent readback and a durable
settlement receipt. No manual SHA transcription and no broadly reusable
approval token.

The owner should not be asked to approve a one-line no-op module deletion
merely because its path falls under the protected tree. A narrow delegated
routine policy can be introduced after **separate legitimate approval and
admission** of that policy itself, not by changing a flag in a proposal.
