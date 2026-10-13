export const HYPERFRAMES_MVP_UNSUPPORTED = 'HYPERFRAMES_MVP_UNSUPPORTED';

const HYPERFRAMES_MVP_READINESS = Object.freeze({
  version: 'hyperframes-mvp-readiness/v1',
  ready: false,
  code: HYPERFRAMES_MVP_UNSUPPORTED,
  failureCategory: 'CONFIG_MISSING',
  reason: 'HyperFrames finishing is unavailable in the initial MVP release.',
});

export function hyperframesMvpReadiness() {
  return HYPERFRAMES_MVP_READINESS;
}

export function assertHyperframesMvpReady() {
  const readiness = hyperframesMvpReadiness();
  if (readiness.ready !== true) {
    throw Object.assign(new Error(readiness.reason), {
      code: readiness.code,
      failureCategory: readiness.failureCategory,
    });
  }
  return readiness;
}
