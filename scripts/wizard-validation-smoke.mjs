// Behavioral smoke for the unified-workspace wizard validation helpers.
// The helpers are module-private in app/unified-workspace.js, so this suite
// extracts the exact shipping block and executes it instead of re-implementing
// the logic, pinning the real credential/URL/command validation behavior.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(resolve(root, 'app/unified-workspace.js'), 'utf8')
const start = source.indexOf('function validID(value)')
const end = source.indexOf('function openConfigWizard(')
if (start < 0 || end < 0 || end <= start) {
  throw new Error('wizard validation block not found in app/unified-workspace.js')
}
const { validID, isSensitiveName, credential, localCredentialArgument, parseLocalCommand, safeRemoteMcpURL } =
  new Function(`${source.slice(start, end)};return { validID, isSensitiveName, credential, localCredentialArgument, parseLocalCommand, safeRemoteMcpURL }`)()

// validID mirrors the backend ID_RE contract.
assert.ok(validID('docs'))
assert.ok(validID('a1.b-c_d'))
assert.ok(validID(`a${'b'.repeat(63)}`), '64 characters is the limit')
for (const bad of ['', '9docs', '-docs', '.docs', '_docs', 'has space', 'ac/me', `a${'b'.repeat(64)}`]) {
  assert.ok(!validID(bad), JSON.stringify(bad))
}

// isSensitiveName normalizes camelCase and keeps word boundaries.
for (const name of ['apiKey', 'api_key', 'api-key', 'X-Api-Key', 'token', 'accessToken', 'clientSecret', 'refreshToken', 'privateKey', 'password', 'passphrase', 'Authorization', 'auth', 'credential', 'key']) {
  assert.ok(isSensitiveName(name), name)
}
for (const name of ['profile', 'region', 'timeout', 'monkey', 'turkey', 'keyboard', 'tokenize']) {
  assert.ok(!isSensitiveName(name), name)
}

// credential() allows env references for sensitive names and anything for the rest.
credential('apiKey', '{env:ACME_API_KEY}')
credential('profile', 'plain literal')
assert.throws(() => credential('apiKey', 'literal'), /must use \{env:VAR\}/)
assert.throws(() => credential('clientSecret', ''), /must use \{env:VAR\}/)
assert.throws(() => credential('Authorization', 'Bearer abc'), /must use \{env:VAR\}/)

// localCredentialArgument parses NAME=value and Header: value shapes.
localCredentialArgument('profile=plain')
localCredentialArgument('TOKEN={env:TOKEN}')
assert.throws(() => localCredentialArgument('Authorization: Bearer literal'), /must use \{env:VAR\}/)
assert.throws(() => localCredentialArgument('CLIENT_SECRET=literal'), /must use \{env:VAR\}/)

// parseLocalCommand validates shape and credential handling.
assert.deepEqual(parseLocalCommand('["npx","-y","example-mcp"]'), ['npx', '-y', 'example-mcp'])
assert.deepEqual(parseLocalCommand('["tool","--url","http://localhost:8080"]'), ['tool', '--url', 'http://localhost:8080'])
for (const bad of ['not json', '[]', '{"a":1}', '["tool",42]', '["tool",""]']) {
  assert.throws(() => parseLocalCommand(bad), /Local command/, bad)
}
for (const good of [
  '["tool","--api_key","{env:API_KEY}"]',
  '["tool","--clientSecret","{env:CLIENT_SECRET}"]',
  '["tool","--env","TOKEN={env:TOKEN}"]',
  '["tool","--header","X-Api-Key: {env:API_KEY}"]',
  '["tool","-e","TOKEN={env:TOKEN}"]',
  '["tool","--profile","literal"]',
]) {
  assert.ok(Array.isArray(parseLocalCommand(good)), good)
}
for (const bad of [
  '["tool","--password","literal"]',
  '["tool","--password=literal"]',
  '["tool","--clientSecret","literal"]',
  '["tool","--xApiKey","literal"]',
  '["tool","--env","TOKEN=literal"]',
  '["tool","--header","Authorization: literal"]',
  '["tool","-H","Authorization: Bearer literal"]',
  '["tool","PASSWORD=literal"]',
]) {
  assert.throws(() => parseLocalCommand(bad), /must use \{env:VAR\}/, bad)
}

// safeRemoteMcpURL enforces http(s), no embedded credentials, env-ref params.
assert.equal(safeRemoteMcpURL('https://mcp.example.com'), 'https://mcp.example.com')
assert.equal(safeRemoteMcpURL('https://mcp.example.com/?limit=10'), 'https://mcp.example.com/?limit=10')
assert.equal(
  safeRemoteMcpURL('https://mcp.example.com/?api_key={env:DOCS_KEY}&clientSecret={env:CLIENT_SECRET}'),
  'https://mcp.example.com/?api_key={env:DOCS_KEY}&clientSecret={env:CLIENT_SECRET}',
)
for (const bad of [
  'not a url',
  'ftp://example.com',
  'javascript:alert(1)',
  'https://user:pass@mcp.example.com',
  'https://mcp.example.com/?api_key=literal',
  'https://mcp.example.com/?clientSecret=literal',
]) {
  assert.throws(() => safeRemoteMcpURL(bad), /Remote MCP|must use \{env:VAR\}/, bad)
}

console.log('wizard validation smoke OK')
