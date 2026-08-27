/**
 * Unit tests for QoderWork CN usage (quota/usage + /user/balance fallback).
 *
 * Enterprise accounts expose snake_case quota records on the gateway
 * quota/usage endpoint; personal accounts get user_quota: null there and
 * rely on the qwenwork.cn /user/balance credit endpoint instead.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const load = () => import("../../open-sse/services/usage/misc.js");

const QUOTA_URL = "https://gateway.qwenwork.cn/api/v2/quota/usage";
const BALANCE_URL = "https://qwenwork.cn/user/balance";
const WEB_QUOTA_URL = "https://qwenwork.cn/user/quota";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function routeByUrl(routes) {
  fetchMock.mockImplementation(async (url) => {
    for (const [prefix, response] of routes) {
      if (String(url).startsWith(prefix)) return response;
    }
    return jsonResponse({}, 404);
  });
}

describe("getQoderworkCnUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a message when no access token is available", async () => {
    const { getQoderworkCnUsage } = await load();
    const res = await getQoderworkCnUsage(null);
    expect(res.message).toMatch(/no access token/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a Web Token for enterprise connections instead of showing the personal wallet", async () => {
    const { getQoderworkCnUsage } = await load();
    const res = await getQoderworkCnUsage("device-token", null, {
      accountType: "enterprise",
      organizationId: "org-1",
    });
    expect(res.message).toMatch(/enterprise Web Token/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("combines enterprise /user/quota with /user/balance using the business cookie", async () => {
    routeByUrl([
      [WEB_QUOTA_URL, jsonResponse({ code: "ok", data: {
        user_quota: { allowance: 2000, used: 372.2003, remaining: 1627.7997 },
        next_used_reset_at: "2026-09-16T00:00:00.000Z",
      } })],
      [BALANCE_URL, jsonResponse({ code: "ok", data: { balance: 1627.7997, freeze_credit: 25.8548 } })],
    ]);

    const { getQoderworkCnUsage } = await load();
    const res = await getQoderworkCnUsage("device-token", null, {
      businessToken: "biz-token",
      accountType: "enterprise",
      userId: "user-1",
      organizationId: "org-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([WEB_QUOTA_URL, BALANCE_URL]));
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers.Cookie).toBe("token=biz-token");
      expect(init.headers["x-channel"]).toContain("source_org_id=org-1");
    }
    expect(res.quotas.organization).toMatchObject({
      total: 2000,
      used: 372.2003,
      remaining: 1627.7997,
    });
    expect(res.balance).toBe(1627.7997);
    expect(res.freezeCredit).toBe(25.8548);
  });

  it("parses enterprise snake_case quota records from quota/usage", async () => {
    routeByUrl([
      [QUOTA_URL, jsonResponse({
        user_id: "u1",
        user_type: "enterprise_member",
        total_usage_percentage: 0.00468765,
        is_quota_exceeded: false,
        expires_at: 0,
        user_quota: { total: 2000, used: 9.3753, remaining: 1990.6247, percentage: 0.00468765, unit: "credits" },
        add_on_quota: null,
        org_resource_package: null,
      })],
    ]);

    const { getQoderworkCnUsage } = await load();
    const res = await getQoderworkCnUsage("token");

    expect(fetchMock).toHaveBeenCalledTimes(1); // no balance fallback
    expect(fetchMock.mock.calls[0][0]).toBe(QUOTA_URL);
    expect(res.plan).toBe("Enterprise Member");
    expect(res.quotas.user).toMatchObject({
      total: 2000,
      used: 9.3753,
      remaining: 1990.6247,
      unit: "credits",
    });
    expect(res.quotas.user.remainingPercentage).toBeCloseTo(99.53, 1);
    expect(res.quotas.organization).toBeUndefined();
    expect(res.isQuotaExceeded).toBe(false);
  });

  it("falls back to /user/balance when user_quota is null (personal account)", async () => {
    routeByUrl([
      [QUOTA_URL, jsonResponse({
        user_id: "u2",
        user_type: "personal_standard",
        total_usage_percentage: 0,
        user_quota: null,
        add_on_quota: null,
        org_resource_package: null,
        is_quota_exceeded: false,
        expires_at: 0,
      })],
      [BALANCE_URL, jsonResponse({ code: "ok", data: { balance: 2086.0432, freeze_credit: 0 } })],
    ]);

    const { getQoderworkCnUsage } = await load();
    const res = await getQoderworkCnUsage("token");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(BALANCE_URL);
    expect(res.plan).toBe("Personal Standard");
    expect(res.balance).toBe(2086.0432);
    expect(res.freezeCredit).toBe(0);
    const row = res.quotas["Balance (credits)"];
    expect(row).toMatchObject({
      used: 0,
      total: 2086.0432,
      remaining: 2086.0432,
      remainingPercentage: 100,
      unit: "credits",
    });
  });

  it("does not treat in-flight freeze_credit as historical usage", async () => {
    routeByUrl([
      [QUOTA_URL, jsonResponse({ user_quota: null, expires_at: 0 })],
      [BALANCE_URL, jsonResponse({ code: "ok", data: { balance: 100, freeze_credit: 25 } })],
    ]);

    const { getQoderworkCnUsage } = await load();
    const res = await getQoderworkCnUsage("token");
    const row = res.quotas["Balance (credits)"];
    expect(row.used).toBe(0);
    expect(row.total).toBe(100);
    expect(row.remainingPercentage).toBe(100);
  });

  it("reports an auth-expired message on 401 so the route can force-refresh", async () => {
    routeByUrl([[QUOTA_URL, jsonResponse({ error: "unauthorized" }, 401)]]);

    const { getQoderworkCnUsage } = await load();
    const res = await getQoderworkCnUsage("token");
    expect(res.quotas).toBeUndefined();
    expect(res.message.toLowerCase()).toMatch(/expired|unauthorized|401/);
  });

  it("falls back to balance when quota/usage errors", async () => {
    routeByUrl([
      [QUOTA_URL, jsonResponse({ error: "boom" }, 500)],
      [BALANCE_URL, jsonResponse({ code: "ok", data: { balance: 42, freeze_credit: 0 } })],
    ]);

    const { getQoderworkCnUsage } = await load();
    const res = await getQoderworkCnUsage("token");
    expect(res.quotas["Balance (credits)"].remaining).toBe(42);
  });
});
