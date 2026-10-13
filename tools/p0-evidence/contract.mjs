import { validateObservationFacts } from './facts.mjs';
import {
  CANDIDATE_VERSION,
  OBSERVATION_CONTRACTS,
  OBSERVATION_VERSION,
  P0EvidenceError,
  STRUCTURALLY_COMPLETE_UNAUTHENTICATED,
  validateEvidenceEnvelope,
} from './schema.mjs';

export {
  CANDIDATE_VERSION as P0_EVIDENCE_CANDIDATE_VERSION,
  OBSERVATION_CONTRACTS as P0_OBSERVATION_CONTRACTS,
  OBSERVATION_VERSION as P0_OBSERVATION_VERSION,
  P0EvidenceError,
  STRUCTURALLY_COMPLETE_UNAUTHENTICATED as P0_STRUCTURALLY_COMPLETE_UNAUTHENTICATED,
};

export function evaluateP0EvidenceBundle(bundle, media) {
  const { proof, window, observations } = validateEvidenceEnvelope(bundle);
  validateObservationFacts(observations, proof, media, window);
  return Object.freeze({
    status: STRUCTURALLY_COMPLETE_UNAUTHENTICATED,
    releaseGateCleared: false,
    observationsAuthenticated: false,
    observationClaimsPresent: OBSERVATION_CONTRACTS.length,
    nextRequiredAction: 'authenticate_live_sources_and_independent_review',
  });
}
