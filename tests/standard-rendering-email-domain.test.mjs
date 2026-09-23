import assert from 'node:assert/strict';
import test from 'node:test';
import { standardRenderingEmailDomainAllowed } from '../lib/video-os-security.js';

const original = process.env.VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS;
test.afterEach(() => {
  if (original === undefined) delete process.env.VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS;
  else process.env.VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS = original;
});

test('denies every email when the domain list is unset or empty', () => {
  delete process.env.VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS;
  assert.equal(standardRenderingEmailDomainAllowed('anyone@luxmarketingcompany.com'), false);
  process.env.VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS = '   ';
  assert.equal(standardRenderingEmailDomainAllowed('anyone@luxmarketingcompany.com'), false);
});

test('allows an email whose domain exactly matches a configured entry', () => {
  process.env.VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS = 'luxmarketingcompany.com';
  assert.equal(standardRenderingEmailDomainAllowed('ariel@luxmarketingcompany.com'), true);
  assert.equal(standardRenderingEmailDomainAllowed('someone.else@luxmarketingcompany.com'), true);
});

test('matching is case-insensitive on both the configured domain and the email', () => {
  process.env.VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS = 'LuxMarketingCompany.com';
  assert.equal(standardRenderingEmailDomainAllowed('Ariel@LUXMARKETINGCOMPANY.COM'), true);
});

test('supports a comma-separated list of domains', () => {
  process.env.VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS = 'luxmarketingcompany.com, another-trusted.example';
  assert.equal(standardRenderingEmailDomainAllowed('someone@another-trusted.example'), true);
});

test('rejects a different domain, a subdomain, and a domain that merely contains the configured one', () => {
  process.env.VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS = 'luxmarketingcompany.com';
  assert.equal(standardRenderingEmailDomainAllowed('someone@gmail.com'), false);
  assert.equal(standardRenderingEmailDomainAllowed('someone@mail.luxmarketingcompany.com'), false, 'a subdomain must not match unless explicitly configured');
  assert.equal(standardRenderingEmailDomainAllowed('someone@notluxmarketingcompany.com'), false, 'substring/suffix matching must not be treated as a real domain match');
});

test('rejects malformed or missing email input without throwing', () => {
  process.env.VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS = 'luxmarketingcompany.com';
  assert.equal(standardRenderingEmailDomainAllowed(''), false);
  assert.equal(standardRenderingEmailDomainAllowed(undefined), false);
  assert.equal(standardRenderingEmailDomainAllowed('not-an-email'), false);
});
