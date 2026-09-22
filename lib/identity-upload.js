import crypto from 'node:crypto';

export const IDENTITY_UPLOAD_LIMITS = Object.freeze({
  photoBytes: 3_000_000,
  voiceBytes: 3_000_000,
  minPhotoDimension: 512,
  maxPhotoDimension: 8192,
  minVoiceSeconds: 5,
  maxVoiceSeconds: 120,
});

const MIME_BY_KIND = Object.freeze({
  photo: new Set(['image/jpeg', 'image/png']),
  voice: new Set(['audio/wav', 'audio/x-wav', 'audio/mpeg']),
});

function invalid(message) {
  throw Object.assign(new Error(message), { statusCode: 400, failureCategory: 'UPLOAD_INVALID', publicCode: 'invalid_upload', publicMessage: message });
}

export function decodeStrictDataUrl(value) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(String(value || ''));
  if (!match || !match[2] || match[2].length % 4 !== 0) invalid('The selected file is malformed.');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.toString('base64') !== match[2]) invalid('The selected file is malformed.');
  return { declaredMime: match[1].toLowerCase(), buffer };
}

function jpegDimensions(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  invalid('The JPEG file does not contain valid dimensions.');
}

function pngDimensions(buffer) {
  let offset = 8;
  let width;
  let height;
  let sawImageData = false;
  let sawEnd = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const nextOffset = dataStart + length + 4;
    if (nextOffset > buffer.length) invalid('The PNG file is malformed.');
    if (offset === 8 && (type !== 'IHDR' || length !== 13)) invalid('The PNG file is malformed.');
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
    } else if (type === 'IDAT') {
      sawImageData = true;
    } else if (type === 'IEND') {
      if (length !== 0 || nextOffset !== buffer.length) invalid('The PNG file is malformed.');
      sawEnd = true;
      break;
    }
    offset = nextOffset;
  }
  if (!width || !height || !sawImageData || !sawEnd) invalid('The PNG file is malformed.');
  return { width, height };
}

function photoMetadata(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ...pngDimensions(buffer), extension: '.png' };
  }
  if (buffer.length >= 10 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    if (buffer.at(-2) !== 0xff || buffer.at(-1) !== 0xd9) invalid('The JPEG file is malformed.');
    return { mime: 'image/jpeg', ...jpegDimensions(buffer), extension: '.jpg' };
  }
  invalid('Use a valid JPEG or PNG portrait.');
}

function wavMetadata(buffer) {
  if (buffer.length < 44 || buffer.subarray(0, 4).toString('ascii') !== 'RIFF' || buffer.subarray(8, 12).toString('ascii') !== 'WAVE') return null;
  let offset = 12;
  let format;
  let dataBytes;
  while (offset + 8 <= buffer.length) {
    const id = buffer.subarray(offset, offset + 4).toString('ascii');
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (size < 0 || start + size > buffer.length) invalid('The WAV file is malformed.');
    if (id === 'fmt ' && size >= 16) {
      format = {
        encoding: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        byteRate: buffer.readUInt32LE(start + 8),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    }
    if (id === 'data') dataBytes = size;
    offset = start + size + (size % 2);
  }
  if (!format || !dataBytes || ![1, 3].includes(format.encoding) || !format.channels || !format.sampleRate || !format.byteRate) invalid('Use an uncompressed PCM WAV recording.');
  if (format.channels > 2 || format.sampleRate < 8_000 || format.sampleRate > 192_000 || ![8, 16, 24, 32].includes(format.bitsPerSample)) invalid('The WAV codec is not supported.');
  return { mime: 'audio/wav', extension: '.wav', durationSeconds: dataBytes / format.byteRate, codec: `pcm-${format.bitsPerSample}`, ...format };
}

const MP3_BITRATES = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

function mp3Metadata(buffer) {
  let offset = 0;
  if (buffer.subarray(0, 3).toString('ascii') === 'ID3' && buffer.length >= 10) {
    offset = 10 + ((buffer[6] & 0x7f) << 21) + ((buffer[7] & 0x7f) << 14) + ((buffer[8] & 0x7f) << 7) + (buffer[9] & 0x7f);
  }
  let seconds = 0;
  let frames = 0;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) { offset += 1; continue; }
    const versionBits = (buffer[offset + 1] >> 3) & 0x03;
    const layerBits = (buffer[offset + 1] >> 1) & 0x03;
    const bitrateIndex = (buffer[offset + 2] >> 4) & 0x0f;
    const sampleIndex = (buffer[offset + 2] >> 2) & 0x03;
    const padding = (buffer[offset + 2] >> 1) & 0x01;
    if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) { offset += 1; continue; }
    const version = versionBits === 3 ? 1 : 2;
    const layer = 4 - layerBits;
    const table = MP3_BITRATES[`${version}-${layer}`];
    const bitrate = table?.[bitrateIndex] * 1000;
    const baseRates = [44_100, 48_000, 32_000];
    const divisor = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 4;
    const sampleRate = baseRates[sampleIndex] / divisor;
    if (!bitrate || !sampleRate) { offset += 1; continue; }
    const samples = layer === 1 ? 384 : layer === 3 && version !== 1 ? 576 : 1152;
    const frameLength = layer === 1
      ? Math.floor((12 * bitrate / sampleRate + padding) * 4)
      : Math.floor(((layer === 3 && version !== 1 ? 72 : 144) * bitrate / sampleRate) + padding);
    if (frameLength < 4 || offset + frameLength > buffer.length) break;
    seconds += samples / sampleRate;
    frames += 1;
    offset += frameLength;
  }
  if (frames < 2 || seconds <= 0) invalid('The MP3 file is malformed or uses an unsupported codec.');
  return { mime: 'audio/mpeg', extension: '.mp3', durationSeconds: seconds, codec: 'mp3' };
}

function voiceMetadata(buffer) {
  return wavMetadata(buffer) || mp3Metadata(buffer);
}

export function validateIdentityUpload({ dataUrl, kind }) {
  if (!MIME_BY_KIND[kind]) invalid('Choose whether this is an identity photo or voice recording.');
  const { declaredMime, buffer } = decodeStrictDataUrl(dataUrl);
  if (!MIME_BY_KIND[kind].has(declaredMime)) invalid(kind === 'photo' ? 'Use a JPEG or PNG portrait.' : 'Use an MP3 or WAV recording.');
  const maxBytes = kind === 'photo' ? IDENTITY_UPLOAD_LIMITS.photoBytes : IDENTITY_UPLOAD_LIMITS.voiceBytes;
  if (buffer.length > maxBytes) invalid(`The ${kind} file is too large.`);
  const metadata = kind === 'photo' ? photoMetadata(buffer) : voiceMetadata(buffer);
  const canonicalDeclared = declaredMime === 'audio/x-wav' ? 'audio/wav' : declaredMime;
  if (canonicalDeclared !== metadata.mime) invalid('The file contents do not match the declared type.');
  if (kind === 'photo') {
    if (metadata.width < IDENTITY_UPLOAD_LIMITS.minPhotoDimension || metadata.height < IDENTITY_UPLOAD_LIMITS.minPhotoDimension) invalid('Use a portrait at least 512 × 512 pixels.');
    if (metadata.width > IDENTITY_UPLOAD_LIMITS.maxPhotoDimension || metadata.height > IDENTITY_UPLOAD_LIMITS.maxPhotoDimension) invalid('The portrait dimensions are too large.');
  } else if (metadata.durationSeconds < IDENTITY_UPLOAD_LIMITS.minVoiceSeconds || metadata.durationSeconds > IDENTITY_UPLOAD_LIMITS.maxVoiceSeconds) {
    invalid(`Record between ${IDENTITY_UPLOAD_LIMITS.minVoiceSeconds} and ${IDENTITY_UPLOAD_LIMITS.maxVoiceSeconds} seconds of speech.`);
  }
  return { buffer, contentType: metadata.mime, extension: metadata.extension, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), ...metadata };
}
