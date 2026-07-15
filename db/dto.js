export function accountDto(record) {
  return {
    account: { accountId: record.user.id, name: record.user.name, subscription: { plan: 'Video OS', status: 'contained' } },
    credits: { accountId: record.user.id, balance: record.credits.balance, reserved: record.credits.reserved, currency: 'credits' },
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
