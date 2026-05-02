import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFastHexAddress } from '../tools/fast.js';
import { AtelMcpError } from '../contracts/errors.js';

test('resolveFastHexAddress passes through 64-char hex (lowercased)', () => {
  const hex = 'a'.repeat(64);
  assert.equal(resolveFastHexAddress(hex), hex);
  assert.equal(resolveFastHexAddress('A'.repeat(64)), 'a'.repeat(64));
});

test('resolveFastHexAddress rejects 63-char and 65-char hex', () => {
  assert.throws(() => resolveFastHexAddress('a'.repeat(63)), AtelMcpError);
  assert.throws(() => resolveFastHexAddress('a'.repeat(65)), AtelMcpError);
});

test('resolveFastHexAddress rejects bech32-style input', () => {
  // bech32 chars include 'l' which isn't hex; also length mismatch.
  assert.throws(
    () => resolveFastHexAddress('fast1qqqqq...'),
    (err: unknown) => err instanceof AtelMcpError && err.code === 'INVALID_INPUT',
  );
});

test('resolveFastHexAddress rejects 0x-prefixed EVM-style address', () => {
  // 0x + 40 hex (EVM checksum length) — looks valid but is wrong format.
  assert.throws(
    () => resolveFastHexAddress('0x' + 'a'.repeat(40)),
    AtelMcpError,
  );
});

test('resolveFastHexAddress decodes 32-zero-byte DID (all-1s base58)', () => {
  // 32 zero bytes encode to 32 '1' chars in base58.
  const did = 'did:atel:ed25519:' + '1'.repeat(32);
  assert.equal(resolveFastHexAddress(did), '00'.repeat(32));
});

test('resolveFastHexAddress rejects malformed DID prefix', () => {
  assert.throws(() => resolveFastHexAddress('did:other:ed25519:abc'), AtelMcpError);
  assert.throws(() => resolveFastHexAddress('did:atel:secp256k1:abc'), AtelMcpError);
});

test('resolveFastHexAddress rejects DID with bad base58 char', () => {
  // '0' (zero) and 'O' (capital o) and 'I' and 'l' are NOT valid base58 chars.
  const did = 'did:atel:ed25519:0OIl' + '1'.repeat(28);
  assert.throws(
    () => resolveFastHexAddress(did),
    (err: unknown) => err instanceof AtelMcpError && err.code === 'INVALID_INPUT',
  );
});
