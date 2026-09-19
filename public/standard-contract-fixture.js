// Local-only synthetic transport. No network, provider, real consent or accounting.
export const standardFixtureIds = Object.freeze({
  identity: '11111111-1111-4111-8111-111111111111',
  audio: '22222222-2222-4222-8222-222222222222',
  project: '33333333-3333-4333-8333-333333333333',
});

export function createStandardFixtureTransport({ hostname, outcome = 'success' }) {
  if (!['localhost', '127.0.0.1'].includes(hostname)) throw new Error('Contract fixtures require localhost.');
  const calls = [];
  let job = null;
  let submitted = null;
  let polls = 0;
  const fail = (message, status) => Object.assign(new Error(message), { status });
  return {
    calls,
    async request(url, options = {}) {
      const method = options.method || 'GET';
      const body = options.body;
      calls.push({ url, method, body: body && structuredClone(body) });
      if (url === '/api/video-os-lite/projects' && method === 'POST') {
        if (body.tier !== 'STANDARD' || body.identityId !== standardFixtureIds.identity || !body.title) throw fail('Invalid fixture project.', 400);
        return { ok: true, project: { ...body, id: standardFixtureIds.project, script: '', avatar: null, voice: null, settings: { tier: 'STANDARD' } } };
      }
      if (url === '/api/video-os-lite/render' && method === 'POST') {
        if (outcome === 'unavailable') throw fail('Standard rendering is disabled in this build.', 503);
        if (outcome === 'consent' || body.audioReference?.assetId !== standardFixtureIds.audio || body.identityId !== standardFixtureIds.identity) throw fail('Current identity consent does not authorize these sources.', 403);
        if (body.projectId !== standardFixtureIds.project || body.tier !== 'STANDARD' || !body.idempotencyKey) throw fail('Invalid fixture render.', 400);
        if (submitted && JSON.stringify(submitted) !== JSON.stringify(body)) throw fail('Pending submission changed.', 409);
        if (!submitted) {
          submitted = structuredClone(body);
          job = { id: 'fixture-standard-001', projectId: body.projectId, title: body.title, tier: 'standard', status: 'QUEUED', outputAccepted: false, url: null, fixture: true };
          if (outcome === 'uncertain') throw fail('Submission response lost. Its outcome is uncertain.', 0);
        }
        return { ok: true, job: { ...job } };
      }
      if (url === '/api/video-os-lite/results' && method === 'GET') {
        if (job) {
          polls += 1;
          job = { ...job, status: polls === 1 ? 'QUEUED' : polls === 2 ? 'PROCESSING' : 'SUCCEEDED' };
          if (polls > 2) job = { ...job, outputAccepted: outcome !== 'unaccepted', url: '/api/video-os-lite/download?jobId=fixture-standard-001', filename: 'lux-standard-contract-fixture.mp4' };
        }
        return { ok: true, results: job ? [{ ...job }] : [] };
      }
      throw fail('No fixture contract for this request.', 404);
    },
  };
}
