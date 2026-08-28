import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const load = () => import("../../open-sse/services/usage/misc.js");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("getQoderworkCnUsage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a message when no OAuth token is available", async () => {
    const { getQoderworkCnUsage } = await load();
    const result = await getQoderworkCnUsage(null);
    expect(result.message).toMatch(/no access token/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads enterprise quota from the official account-context endpoint", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      code: "ok",
      data: {
        user: { id: "u1", is_biz: true },
        plan: { name: "企业基础版", user_type: "enterprise" },
        quota: { total: 2000, used: 372.2997, remaining: 1627.7003, exceeded: false },
      },
    }));

    const { getQoderworkCnUsage } = await load();
    const result = await getQoderworkCnUsage("biz-oauth-token", null, {
      identityTarget: "biz",
      organizationId: "org-1",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/v1/adapter/user/account-context");
    expect(String(url)).toContain("include=user%2Cplan%2Cquota%2Cpage%2Cdata_sharing");
    expect(init.headers.Authorization).toBe("Bearer biz-oauth-token");
    expect(result.plan).toBe("企业基础版");
    expect(result.quotas.organization).toMatchObject({
      total: 2000,
      used: 372.2997,
      remaining: 1627.7003,
    });
    expect(result.balance).toBe(1627.7003);
    expect(result.totalUsagePercentage).toBeCloseTo(18.614985, 5);
  });

  it("normalizes the balance-shaped quota returned for personal accounts", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      code: "ok",
      data: {
        user: { id: "u2", is_biz: false },
        plan: { name: "Free", user_type: "personal" },
        quota: { total: null, used: null, remaining: 2100, exceeded: false },
      },
    }));

    const { getQoderworkCnUsage } = await load();
    const result = await getQoderworkCnUsage("personal-oauth-token");
    expect(result.quotas.user).toMatchObject({
      total: 2100,
      used: 0,
      remaining: 2100,
      remainingPercentage: 100,
    });
    expect(result.balance).toBe(2100);
    expect(result.totalUsagePercentage).toBe(0);
    expect(result.quotas.organization).toBeUndefined();
  });

  it("parses add-on and shared quota records when present", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      code: "ok",
      data: {
        user: { id: "u3", is_biz: true },
        quota: {
          total: 100,
          used: 25,
          remaining: 75,
          add_on_quota: { total: 20, used: 5, remaining: 15 },
          shared_quota: { total: 500, used: 10, remaining: 490 },
        },
      },
    }));
    const { getQoderworkCnUsage } = await load();
    const result = await getQoderworkCnUsage("token", null, { identityTarget: "biz" });
    expect(result.quotas["add-on"].remaining).toBe(15);
    expect(result.quotas.organization.remaining).toBe(490);
  });

  it("reports an auth-expired message on 401", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));
    const { getQoderworkCnUsage } = await load();
    const result = await getQoderworkCnUsage("expired-token");
    expect(result.message.toLowerCase()).toMatch(/expired|unauthorized|401/);
  });
});
