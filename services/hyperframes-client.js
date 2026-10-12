import { assertHyperframesMvpReady } from './hyperframes-contract.js';

// Workflow imports this adapter, never the Sandbox-bearing runtime. A future
// isolated handler may replace the unsupported branch after it has its own
// authenticated claim, replay, packaging, and hosted-runtime proof.
export async function finishMediaWithHyperframes() {
  assertHyperframesMvpReady();
}
