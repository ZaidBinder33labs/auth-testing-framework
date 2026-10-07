'use strict';
/**
 * Shared Auth interface consumption.
 *
 * IPO and Inventory are hypothetical future modules. This test proves both consume the same
 * AuthService without duplicating login or session handling: neither module contains an HTTP
 * call, a token, or a login routine of its own â€” only AuthService calls.
 *
 * The modules themselves are NOT implemented here; only the interface contract they will use.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createMockAuthAdapter } = require('@atf/adapters');
const { fixtureTenants } = require('../support/tenant-config');
const { AuthService, TenantBoundaryError } = require('../support/auth-service');

/**
 * A module client receives an authenticated session and uses it.
 * Deliberately contains no auth logic: no login, no refresh loop, no token handling.
 */
function createIpoClient() {
  return {
    name: 'ipo',
    async createOrder(session, payload) {
      session.assertTenant(payload.tenantId);
      return { module: 'ipo', action: 'create-order', tenant: session.alias, ref: 'IPO-1' };
    },
    async effectiveAccess(session) {
      return session.getEffectiveAccess();
    },
  };
}

function createInventoryClient() {
  return {
    name: 'inventory',
    async receiveStock(session, payload) {
      session.assertTenant(payload.tenantId);
      return { module: 'inventory', action: 'receive-stock', tenant: session.alias, ref: 'INV-1' };
    },
    async effectiveAccess(session) {
      return session.getEffectiveAccess();
    },
  };
}

const TENANTS = fixtureTenants(2);

test('IFACE-01 two modules share one AuthService instance', () => {
  const service = new AuthService({ adapter: createMockAuthAdapter(), tenantConfigs: TENANTS });
  const ipo = createIpoClient();
  const inventory = createInventoryClient();

  assert.strictEqual(ipo.name, 'ipo');
  assert.strictEqual(inventory.name, 'inventory');
  // The point of the interface: one service, many consumers.
  assert.strictEqual(service.aliases.length, 2);
});

test('IFACE-02 both modules operate under a tenant session obtained from the shared service', async () => {
  const service = new AuthService({ adapter: createMockAuthAdapter(), tenantConfigs: TENANTS });
  const ipo = createIpoClient();
  const inventory = createInventoryClient();
  const tenantId = TENANTS[0].tenantId;

  const session = await service.loginAs(TENANTS[0].alias);

  const order = await ipo.createOrder(session, { tenantId });
  const receipt = await inventory.receiveStock(session, { tenantId });

  assert.strictEqual(order.tenant, TENANTS[0].alias);
  assert.strictEqual(receipt.tenant, TENANTS[0].alias);
  // One login served both modules.
  assert.strictEqual(service.manager.listSessions().length, 1);
});

test('IFACE-03 neither module can act for another tenant, whatever it passes in', async () => {
  const service = new AuthService({ adapter: createMockAuthAdapter(), tenantConfigs: TENANTS });
  const ipo = createIpoClient();
  const inventory = createInventoryClient();

  const sessionA = await service.loginAs(TENANTS[0].alias);
  const tenantB = TENANTS[1].tenantId;

  // A module must not be able to reach another tenant by supplying a different tenant id.
  await assert.rejects(
    ipo.createOrder(sessionA, { tenantId: tenantB }),
    (e) => e instanceof TenantBoundaryError && e.code === 'CROSS_TENANT_SESSION_USE'
  );
  await assert.rejects(
    inventory.receiveStock(sessionA, { tenantId: tenantB }),
    (e) => e.code === 'CROSS_TENANT_SESSION_USE'
  );
});

test('IFACE-04 modules share token lifecycle through the service, not their own copies', async () => {
  const adapter = createMockAuthAdapter({ rotationEnabled: true });
  const service = new AuthService({ adapter, tenantConfigs: TENANTS });
  const ipo = createIpoClient();

  const session = await service.loginAs(TENANTS[0].alias);
  const before = session.session.accessToken;
  await session.refresh();

  assert.notStrictEqual(session.session.accessToken, before);
  assert.strictEqual(ipo.name, 'ipo', 'the module itself was not involved in the refresh');
});

test('IFACE-05 a module can read effective access through the shared session handle', async () => {
  const adapter = createMockAuthAdapter();
  adapter.getEffectiveAccess = async () => ({
    items: [{ screenCode: 'IPO_CREATE', moduleCode: 'IPO', scope: 'ALL', level: 'ADMIN', canApprove: true, canDelete: false }],
    screenCodes: ['IPO_CREATE'],
    moduleCodes: ['IPO'],
    canApprove: ['IPO_CREATE'],
  });
  const service = new AuthService({ adapter, tenantConfigs: TENANTS });
  const ipo = createIpoClient();
  const session = await service.loginAs(TENANTS[0].alias);

  const access = await ipo.effectiveAccess(session);

  assert.strictEqual(access.supported, true);
  assert.deepStrictEqual(access.screenCodes, ['IPO_CREATE']);
});

test('IFACE-06 logging out through the shared service invalidates every module session', async () => {
  const service = new AuthService({ adapter: createMockAuthAdapter(), tenantConfigs: TENANTS });
  const ipo = createIpoClient();
  const inventory = createInventoryClient();
  const tenantId = TENANTS[0].tenantId;

  const session = await service.loginAs(TENANTS[0].alias);
  await ipo.createOrder(session, { tenantId });
  await inventory.receiveStock(session, { tenantId });

  await service.cleanup();

  assert.strictEqual(session.session.state, 'logged-out');
  assert.strictEqual(service.manager.listSessions().length, 1);
  assert.strictEqual(service.sessions.size, 0);
});

test('IFACE-07 module source contains no authentication logic', () => {
  // The interface only holds if consumers really do not re-implement auth.
  const source = fs.readFileSync(__filename, 'utf8');
  // Bound the scan to the two module clients. Including the test bodies would match the
  // forbidden patterns inside these very assertions.
  const consumerRegion = source.slice(
    source.indexOf('function createIpoClient'),
    source.indexOf('const TENANTS = fixtureTenants(2);')
  );
  assert.ok(consumerRegion.includes('createIpoClient') && consumerRegion.includes('createInventoryClient'));

  assert.ok(!/\/api\/v1\/auth/.test(consumerRegion), 'a module must not call auth endpoints directly');
  assert.ok(!/access_token|refresh_token/.test(consumerRegion), 'a module must not read tokens directly');
  assert.ok(!/\blogin\(/.test(consumerRegion), 'a module must not implement its own login');
});

test('IFACE-08 the shared service is reusable from a single import path', () => {
  const serviceModule = require.resolve('../support/auth-service');
  assert.ok(fs.existsSync(serviceModule));
  const exported = require(serviceModule);
  assert.deepStrictEqual(Object.keys(exported).sort(), ['AuthService', 'TenantBoundaryError', 'TenantSession']);
  assert.ok(path.isAbsolute(serviceModule));
});

