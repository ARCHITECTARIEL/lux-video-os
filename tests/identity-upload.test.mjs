import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeStrictDataUrl, IDENTITY_UPLOAD_LIMITS, validateIdentityUpload } from '../lib/identity-upload.js';

function dataUrl(mime, buffer) {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  return chunk;
}

function png(width = 512, height = 512) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', Buffer.from([0x00])),
    pngChunk('IEND'),
  ]);
}

function jpeg(width = 512, height = 512, includeEoi = true) {
  const sof = Buffer.alloc(15);
  sof.set([0xff, 0xc0, 0x00, 0x0b, 0x08], 0);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.set([0x01, 0x01, 0x11, 0x00], 9);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, includeEoi ? Buffer.from([0xff, 0xd9]) : Buffer.alloc(0)]);
}

function wav(seconds, sampleRate = 8_000) {
  const channels = 1;
  const bits = 16;
  const dataSize = seconds * sampleRate * channels * bits / 8;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bits / 8, 28);
  buffer.writeUInt16LE(channels * bits / 8, 32);
  buffer.writeUInt16LE(bits, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function mpeg1Layer3(seconds = 5) {
  const sampleRate = 44_100;
  const bitrate = 128_000;
  const samplesPerFrame = 1_152;
  const frameLength = Math.floor(144 * bitrate / sampleRate);
  const frameCount = Math.ceil(seconds * sampleRate / samplesPerFrame);
  const buffer = Buffer.alloc(frameLength * frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = frame * frameLength;
    buffer.set([0xff, 0xfb, 0x90, 0x00], offset);
  }
  return buffer;
}

test('identity photo validation checks signature, MIME, and dimensions', () => {
  const result = validateIdentityUpload({ kind: 'photo', dataUrl: dataUrl('image/png', png()) });
  assert.equal(result.contentType, 'image/png');
  assert.equal(result.width, 512);
  assert.equal(result.height, 512);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => validateIdentityUpload({ kind: 'photo', dataUrl: dataUrl('image/jpeg', png()) }), /do not match/);
  assert.throws(() => validateIdentityUpload({ kind: 'photo', dataUrl: dataUrl('image/png', png(200, 200)) }), /at least 512/);
});

test('identity photo validation requires complete PNG and JPEG structure', () => {
  const validJpeg = validateIdentityUpload({ kind: 'photo', dataUrl: dataUrl('image/jpeg', jpeg()) });
  assert.equal(validJpeg.contentType, 'image/jpeg');
  assert.throws(() => validateIdentityUpload({ kind: 'photo', dataUrl: dataUrl('image/png', png().subarray(0, -12)) }), /malformed/);
  assert.throws(() => validateIdentityUpload({ kind: 'photo', dataUrl: dataUrl('image/png', png().subarray(0, -2)) }), /malformed/);
  assert.throws(() => validateIdentityUpload({ kind: 'photo', dataUrl: dataUrl('image/jpeg', jpeg(512, 512, false)) }), /malformed/);
});

test('identity uploads reject raw files above the base64-safe three megabyte limit', () => {
  assert.equal(IDENTITY_UPLOAD_LIMITS.photoBytes, 3_000_000);
  assert.equal(IDENTITY_UPLOAD_LIMITS.voiceBytes, 3_000_000);
  const overLimit = Buffer.alloc(3_000_001);
  assert.throws(() => validateIdentityUpload({ kind: 'photo', dataUrl: dataUrl('image/png', overLimit) }), /too large/);
});

test('identity voice validation checks WAV signature, codec, and duration', () => {
  const result = validateIdentityUpload({ kind: 'voice', dataUrl: dataUrl('audio/wav', wav(5)) });
  assert.equal(result.contentType, 'audio/wav');
  assert.equal(result.durationSeconds, 5);
  assert.equal(result.codec, 'pcm-16');
  assert.throws(() => validateIdentityUpload({ kind: 'voice', dataUrl: dataUrl('audio/wav', wav(4)) }), /between 5 and 120/);
  assert.throws(() => validateIdentityUpload({ kind: 'voice', dataUrl: dataUrl('audio/mpeg', wav(5)) }), /do not match/);
});

test('identity voice validation accepts bounded MPEG-1 Layer III audio', () => {
  const result = validateIdentityUpload({ kind: 'voice', dataUrl: dataUrl('audio/mpeg', mpeg1Layer3(5)) });
  assert.equal(result.contentType, 'audio/mpeg');
  assert.equal(result.codec, 'mp3');
  assert.ok(result.durationSeconds >= 5 && result.durationSeconds < 6);
});

test('identity upload validation errors carry a publicMessage so the API does not mask them with a generic "Upload failed."', () => {
  try {
    validateIdentityUpload({ kind: 'photo', dataUrl: dataUrl('image/png', png(200, 200)) });
    assert.fail('expected validateIdentityUpload to throw');
  } catch (error) {
    assert.equal(error.statusCode, 400);
    assert.equal(error.publicCode, 'invalid_upload');
    assert.equal(error.publicMessage, error.message);
    assert.match(error.publicMessage, /at least 512/);
  }
});

test('identity upload rejects non-canonical or empty base64', () => {
  assert.throws(() => decodeStrictDataUrl('data:image/png;base64,'), /malformed/);
  assert.throws(() => decodeStrictDataUrl('data:image/png;base64,%%%='), /malformed/);
  assert.throws(() => decodeStrictDataUrl('https://example.com/photo.png'), /malformed/);
});
