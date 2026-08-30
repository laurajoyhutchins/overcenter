export function verifyRuntimeObservation(artifact, observation) {
    if (artifact.artifactDigest !== observation.observedArtifactDigest) {
        throw Object.assign(new Error('Runtime observation does not match the intended immutable runtime artifact.'), { code: 'RUNTIME_ARTIFACT_MISMATCH' });
    }
    return { artifact, observation };
}