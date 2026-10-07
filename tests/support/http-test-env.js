'use strict';
/**
 * HTTP test context.
 *
 * The context itself now lives in @atf/http-transport, because an application-agnostic
 * framework needs one and the refresh token is delivered in an HttpOnly cookie that a client
 * without a cookie jar cannot re-send. This module remains so existing test files and any
 * consumer that expects this path keep working unchanged.
 *
 * Credentials are read from configuration and never returned, logged or written to a report.
 */

const { FetchRequestContext, parseSetCookie } = require('@atf/http-transport');

module.exports = { FetchRequestContext, parseSetCookie };
