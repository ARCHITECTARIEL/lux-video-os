// Vercel rejects a prebuilt file upload above this count
// (`files should NOT have more than 15000 items`). This project's workflow
// output is over the limit, so the sanctioned preview deploy uses --archive=tgz.
export const VERCEL_PREBUILT_FILE_LIMIT = 15000;
export const PREVIEW_DEPLOY_COMMAND = 'vercel deploy --prebuilt --archive=tgz';

export function targetFlagValues(argv = []) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (typeof arg !== 'string') continue;
    if (arg === '--target') {
      values.push(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith('--target=')) values.push(arg.slice('--target='.length));
  }
  return values;
}

export function previewUploadLimitWarning(fileCount) {
  if (!Number.isInteger(fileCount) || fileCount <= VERCEL_PREBUILT_FILE_LIMIT) return null;
  return `Preview output has ${fileCount} files, over Vercel's 15,000-file upload limit. Deploy with: ${PREVIEW_DEPLOY_COMMAND}`;
}
