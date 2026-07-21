export function accountDto(record) {
  const role = record.user.role || 'customer';
  const subscriptions = {
    owner: { plan: 'Video OS Owner Access', status: 'active', renewal: 'Owner-managed workspace' },
    ceo: { plan: 'Video OS Lite CEO Preview', status: 'active', renewal: 'Full-access executive preview' },
    demo: { plan: 'Video OS Lite Demo Access', status: 'active', renewal: 'Password access enabled' },
    customer: { plan: 'Video OS', status: 'contained' },
  };
  return {
    accountId: record.user.id,
    account: { accountId: record.user.id, name: record.user.name, role, subscription: subscriptions[role] || subscriptions.customer },
    credits: { accountId: record.user.id, balance: record.credits.balance, reserved: record.credits.reserved, currency: 'credits' },
    entitlements: record.entitlements || {},
  };
}

export function jobDto(job) {
  const output = job.output || {};
  return {
    id: job.id,
    providerJobId: job.providerJobId,
    correlationId: job.correlationId,
    provider: { id: job.provider, name: job.provider === 'heygen' ? 'HeyGen' : job.provider },
    title: job.title,
    format: job.format,
    projectId: job.projectId,
    identityId: job.input?.identityId || null,
    avatar: output.avatar || job.input?.avatar,
    voice: output.voice || job.input?.voice,
    productionKit: job.input?.productionKit || {},
    cost: job.costCredits,
    status: job.status,
    stage: job.status,
    filename: output.filename,
    effects: output.effects,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    message: job.status === 'ready' ? 'Final MP4 ready.' : job.status === 'failed' ? 'Render needs attention.' : 'Render workflow is running.',
    url: job.status === 'ready' ? `/api/video-os-lite/download?jobId=${encodeURIComponent(job.id)}` : null,
  };
}
