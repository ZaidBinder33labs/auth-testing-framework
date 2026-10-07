'use strict';
/**
 * Suite registry.
 *
 * Maps a test file to the suite it belongs to, its category, its verification level, and — since
 * the capability system arrived — the capabilities the suite needs from the active policy.
 *
 * verificationLevel:
 *   'unit'        - package-local logic
 *   'fixture'     - mock adapter / in-memory fixtures
 *   'redis'       - a real Redis instance
 *   'http'        - a real non-production HTTP endpoint
 *   'reporting'   - the report generators themselves
 *
 * capabilities — what the suite is PERMITTED to need, from:
 *   mutatesOwnSession  login / refresh / logout of the test account
 *   mutatesRedis       any Redis write
 *   concurrentLoad     parallel refresh or login storms
 *   tokenRotation      deliberately invalidating a refresh token
 *   ttlWaits           waiting for a real key to expire
 *
 * An empty list is a deliberate statement: this suite talks to nothing real. Every suite must
 * state its list explicitly; a missing `capabilities` key is an error, because silence must never
 * read as permission. A suite needing something the policy denies reports BLOCKED naming the
 * capability — never skipped, never passed.
 *
 * testCapabilities refines the suite baseline for individual tests, matched by exact test name.
 * The baseline is the norm; an override exists where one test in a suite needs strictly more (or
 * strictly less) than its neighbours.
 */

const CAPABILITIES = ['mutatesOwnSession', 'mutatesRedis', 'concurrentLoad', 'tokenRotation', 'ttlWaits'];

const SUITES = [
  // ---- packages: pure logic, no real system, so nothing is required --------------------------------
  { match: /packages[\\/]adapters[\\/]tests[\\/]credential-auth\.test\.js$/,
    id: 'auth-adapter', name: 'Credential Auth Adapter', category: 'auth', verification: 'unit', required: true,
    capabilities: [],
    why: 'Drives the adapter through scripted transports only. No session, no Redis, no network.' },

  { match: /packages[\\/]adapters[\\/]tests[\\/]example-target\.spec\.js$/,
    id: 'example-target', name: 'Example Target (application-agnostic proof)', category: 'auth', verification: 'unit', required: true,
    capabilities: [],
    why: 'Proves one adapter serves a unlike target through a scripted transport. Nothing real is contacted.' },

  { match: /packages[\\/]adapters[\\/]tests[\\/]contract\.test\.js$/,
    id: 'adapter-contract', name: 'Adapter Contract', category: 'adapter', verification: 'unit', required: true,
    capabilities: [],
    why: 'Checks the mock adapters satisfy the contract. Mocks only.' },

  { match: /packages[\\/]http-transport[\\/]tests[\\/]/,
    id: 'http-transport', name: 'HTTP Transport', category: 'adapter', verification: 'unit', required: true,
    capabilities: [],
    why: 'Transport behaviour against scripted contexts and a loopback server it starts itself. No target, no session.' },

  { match: /packages[\\/]target-config[\\/]tests[\\/]/,
    id: 'target-config', name: 'Target Descriptors', category: 'adapter', verification: 'unit', required: true,
    capabilities: [],
    why: 'Validates descriptor files on disk and proves no descriptor carries a credential. Reads files, contacts nothing.' },

  { match: /packages[\\/]env-config[\\/]tests[\\/]/,
    id: 'env-config', name: 'Environments and Policies', category: 'adapter', verification: 'unit', required: true,
    capabilities: [],
    why: 'Validates environment and policy descriptors and the production guardrails, with injected env objects. Contacts nothing.' },

  { match: /packages[\\/]auth-core[\\/]tests[\\/]/,
    id: 'auth-core', name: 'Auth Core (sessions)', category: 'session', verification: 'unit', required: true,
    capabilities: [],
    why: 'AuthManager against the mock adapter. A mock session is not the system under test, so no capability is needed.' },

  { match: /packages[\\/]token-security[\\/]tests[\\/]/,
    id: 'token-security', name: 'Token Security', category: 'security', verification: 'unit', required: true,
    capabilities: [],
    why: 'Fingerprinting and redaction of synthetic tokens. No real token is ever handled.' },

  { match: /packages[\\/]concurrency-engine[\\/]tests[\\/]/,
    id: 'concurrency', name: 'Concurrency Engine', category: 'concurrency', verification: 'unit', required: true,
    capabilities: [],
    why: 'RefreshLock and parallelLimit primitives in-process. No load is placed on any system.' },

  { match: /packages[\\/]isolation-engine[\\/]tests[\\/]/,
    id: 'isolation-engine', name: 'Isolation Engine', category: 'isolation', verification: 'unit', required: true,
    capabilities: [],
    why: 'Validates isolation decisions over in-memory state.' },

  { match: /packages[\\/]lifecycle-engine[\\/]tests[\\/]/,
    id: 'lifecycle', name: 'Lifecycle Engine', category: 'lifecycle', verification: 'unit', required: true,
    capabilities: [],
    why: 'BEFORE/AFTER sequencing over fixtures.' },

  { match: /packages[\\/]redis-observer[\\/]tests[\\/]/,
    id: 'redis-observer', name: 'Redis Observer', category: 'redis', verification: 'unit', required: true,
    capabilities: [],
    why: 'Safety rules and config parsing against a mock client. Proves FLUSHDB/FLUSHALL stay unreachable without needing a real Redis.' },

  { match: /packages[\\/]state-diff[\\/]tests[\\/]/,
    id: 'state-diff', name: 'State Diff', category: 'redis', verification: 'unit', required: false,
    capabilities: [],
    why: 'Snapshot diffing over plain objects.' },

  { match: /packages[\\/]test-fixtures[\\/]tests[\\/]/,
    id: 'test-fixtures', name: 'Test Fixtures', category: 'fixtures', verification: 'unit', required: false,
    capabilities: [],
    why: 'The fixtures themselves.' },

  { match: /packages[\\/]tenant-core[\\/]tests[\\/]/,
    id: 'tenant-core', name: 'Tenant Core', category: 'multi-tenant', verification: 'unit', required: true,
    capabilities: [],
    why: 'Tenant identity and registry validation in memory.' },

  { match: /packages[\\/]reporting[\\/]tests[\\/]/,
    id: 'reporting', name: 'Reporting', category: 'reporting', verification: 'reporting', required: true,
    capabilities: [],
    why: 'The report generators and the TAP parser, over synthetic TAP.' },

  // ---- fixture suites: mock adapters, no real system ----------------------------------------------
  { match: /tests[\\/]multitenant[\\/]/,
    id: 'multitenant-auth', name: 'Dynamic Multi-Tenant Auth', category: 'multi-tenant', verification: 'fixture', required: true,
    capabilities: [],
    why: 'Shared AuthService across tenants, entirely on the mock adapter. Fixture evidence only — not backend proof.' },

  { match: /tests[\\/]authentication[\\/]/,
    id: 'auth-login', name: 'Auth / Login', category: 'auth', verification: 'fixture', required: true,
    capabilities: [],
    why: 'Login flows on the mock adapter.' },

  { match: /tests[\\/]session[\\/]/,
    id: 'session-lifecycle', name: 'Session Lifecycle', category: 'session', verification: 'fixture', required: true,
    capabilities: ['mutatesOwnSession'],
    why: 'Ends real sessions, including a confirmed logout, so it needs permission to mutate the test account.' },

  { match: /tests[\\/]token[\\/]/,
    id: 'token-refresh', name: 'Token Refresh', category: 'session', verification: 'fixture', required: true,
    capabilities: ['mutatesOwnSession', 'tokenRotation'],
    why: 'Refreshes and deliberately invalidates refresh tokens to prove rotation and reuse are detected.',
    testCapabilities: {
      'refresh detects rotation and reports the previous token': ['mutatesOwnSession', 'tokenRotation'],
      'an invalidated refresh token is rejected': ['mutatesOwnSession', 'tokenRotation'],
      'reuse of a rotated refresh token is detected': ['mutatesOwnSession', 'tokenRotation'],
    } },

  { match: /tests[\\/]security[\\/]/,
    id: 'security', name: 'Security', category: 'security', verification: 'fixture', required: true,
    capabilities: [],
    why: 'Fingerprint, redaction and claim-inspection properties over synthetic tokens.' },

  { match: /tests[\\/]tenancy[\\/]/,
    id: 'tenant-isolation', name: 'Tenant Isolation', category: 'isolation', verification: 'fixture', required: true,
    capabilities: [],
    why: 'Cross-tenant access refusal over in-memory tenants.' },

  { match: /tests[\\/]integration[\\/]/,
    id: 'integration', name: 'Integration', category: 'integration', verification: 'fixture', required: true,
    capabilities: [],
    why: 'Composes the cores end to end on mocks. Fixture evidence only.' },

  { match: /tests[\\/]selftest[\\/]/,
    id: 'selftest', name: 'Framework Self-Test', category: 'regression', verification: 'fixture', required: true,
    capabilities: [],
    why: 'Proves the framework detects its own breakage. Must never need a real system, or it could not police itself.' },

  { match: /tests[\\/]concurrency[\\/]/,
    id: 'concurrency-specs', name: 'Concurrency Specs', category: 'concurrency', verification: 'fixture', required: false,
    capabilities: ['mutatesOwnSession', 'concurrentLoad'],
    why: 'Runs parallel refresh and login storms against one account, so it both mutates that account and places concurrent load.' },

  { match: /tests[\\/]redis[\\/]/,
    id: 'redis-mock', name: 'Redis (mock adapter)', category: 'redis', verification: 'fixture', required: false,
    capabilities: [],
    why: 'In-memory mock Redis. Nothing is written to a real instance.' },

  // ---- suites that touch a real system ----------------------------------------------------------------
  { match: /tests[\\/]redis-integration[\\/]/,
    id: 'redis-integration', name: 'Real Redis Integration', category: 'redis', verification: 'redis', required: true,
    capabilities: ['mutatesRedis', 'ttlWaits'],
    why: 'Writes real keys in a test namespace to observe them, and waits out a real TTL to prove expiry.',
    testCapabilities: {
      'REDIS-04 a real key TTL expires': ['mutatesRedis', 'ttlWaits'],
    } },

  { match: /tests[\\/]http-integration[\\/]/,
    id: 'http-integration', name: 'Real HTTP Integration', category: 'auth', verification: 'http', required: false,
    capabilities: ['mutatesOwnSession'],
    why: 'Logs in, refreshes and logs out against a real endpoint, so it needs permission to mutate the test account.' },
];

/** Suites that reach a real system, i.e. those a policy can meaningfully deny. */
const REAL_SYSTEM_SUITES = SUITES.filter((s) => s.capabilities.length > 0).map((s) => s.id);

class SuiteRegistryError extends Error {
  constructor(message, { code, suite } = {}) {
    super(message);
    this.name = 'SuiteRegistryError';
    this.code = code || 'SUITE_REGISTRY_ERROR';
    this.suite = suite || null;
  }
}

// A suite that omits `capabilities` would silently be treated as needing nothing. Refuse the
// registry at load time instead, so the omission cannot reach a report.
for (const suite of SUITES) {
  if (!Array.isArray(suite.capabilities)) {
    throw new SuiteRegistryError(`suite '${suite.id}' does not declare its capabilities`, {
      code: 'CAPABILITIES_UNSTATED', suite: suite.id,
    });
  }
  for (const cap of suite.capabilities) {
    if (!CAPABILITIES.includes(cap)) {
      throw new SuiteRegistryError(`suite '${suite.id}' declares unknown capability '${cap}'`, {
        code: 'UNKNOWN_CAPABILITY', suite: suite.id,
      });
    }
  }
  for (const [name, caps] of Object.entries(suite.testCapabilities || {})) {
    for (const cap of caps) {
      if (!CAPABILITIES.includes(cap)) {
        throw new SuiteRegistryError(`suite '${suite.id}' test override '${name}' declares unknown capability '${cap}'`, {
          code: 'UNKNOWN_CAPABILITY', suite: suite.id,
        });
      }
    }
  }
}

/** Resolve a file to its suite, or a generic suite when the path is not registered. */
function suiteFor(file) {
  const normalised = String(file || '').replace(/\//g, '\\');
  for (const suite of SUITES) {
    if (suite.match.test(normalised)) return suite;
  }
  return {
    id: 'other',
    name: 'Other',
    category: 'other',
    verification: 'unit',
    required: false,
    capabilities: [],
    why: 'Not a registered suite. Treat as needing nothing and investigate why it is unregistered.',
  };
}

function allSuites() {
  return SUITES.map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    verification: s.verification,
    required: s.required,
    capabilities: s.capabilities,
    testCapabilities: s.testCapabilities || {},
    why: s.why,
  }));
}

function suiteById(id) {
  return SUITES.find((s) => s.id === id) || null;
}

module.exports = { SUITES, CAPABILITIES, REAL_SYSTEM_SUITES, SuiteRegistryError, suiteFor, suiteById, allSuites };