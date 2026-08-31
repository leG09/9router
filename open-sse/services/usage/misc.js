/**
 * Misc usage handlers (iFlow, Ollama, GLM, Vercel AI Gateway, Qoder)
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U } from "./shared.js";

export { getGlmUsage } from "./glm.js";


// Vercel AI Gateway credits endpoint
// Returns { balance: "95.50", total_used: "4.50" } (USD as decimal strings).
const VERCEL_AI_GATEWAY_CREDITS_URL = U("vercel-ai-gateway").url;

/**
 * iFlow Usage
 */
export async function getIflowUsage(accessToken) {
  try {
    // iFlow may have usage endpoint
    return { message: "iFlow connected. Usage tracked per request." };
  } catch (error) {
    return { message: "Unable to fetch iFlow usage." };
  }
}

/**
 * Ollama Cloud Usage
 * GET https://ollama.com/api/usage — session (5h) + weekly (7d) `usage` is a 0..1
 *   ratio (1.0 = limit reached, e.g. weekly 100% used). No reset timestamp exposed.
 * POST https://ollama.com/api/me — plan label (fail-open).
 * Auth: Authorization: Bearer <apiKey>
 */
export async function getOllamaUsage(apiKey, providerSpecificData, proxyOptions = null) {
  if (!apiKey) {
    return { message: "Ollama Cloud API key not available." };
  }

  try {
    const response = await proxyAwareFetch("https://ollama.com/api/usage", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return { message: "Ollama Cloud API key invalid or expired." };
    }

    if (!response.ok) {
      return { message: `Ollama Cloud usage API error (${response.status}).` };
    }

    let data;
    try {
      data = await response.json();
    } catch {
      return { message: "Ollama Cloud usage response was not JSON." };
    }

    // Best-effort plan label from /api/me
    const me = await proxyAwareFetch("https://ollama.com/api/me", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Length": "0",
      },
    }, proxyOptions).then((r) => (r.ok ? r.json() : null)).catch(() => null);

    const planRaw = typeof me?.Plan === "string" ? me.Plan : "";
    const plan = planRaw
      ? planRaw.charAt(0).toUpperCase() + planRaw.slice(1).toLowerCase()
      : "Ollama Cloud";

    const limits = data?.limits && typeof data.limits === "object" ? data.limits : {};

    // Ollama `usage` is a 0..1 ratio (1.0 = limit reached). Convert to a 0..100
    // bar. Do NOT set absolute `remaining` — QuotaTable reads remainingPercentage.
    function ratioQuota(usageRatio, resetAt = null) {
      const ratio = Math.max(0, Math.min(1, Number(usageRatio) || 0));
      const usedPct = Math.round(ratio * 100);
      return { used: usedPct, total: 100, remainingPercentage: 100 - usedPct, resetAt, unlimited: false };
    }

    const sessionRaw = limits.session?.usage;
    const weeklyRaw = limits.weekly?.usage;
    const sessionNum = Number(sessionRaw);
    const weeklyNum = Number(weeklyRaw);
    const hasSession = sessionRaw !== undefined && sessionRaw !== null && !Number.isNaN(sessionNum);
    const hasWeekly = weeklyRaw !== undefined && weeklyRaw !== null && !Number.isNaN(weeklyNum);

    if (!hasSession && !hasWeekly) {
      return {
        plan,
        message: "Ollama Cloud connected. No usage limits reported.",
        quotas: {},
      };
    }

    const quotas = {};
    if (hasSession) quotas["Session (5h)"] = ratioQuota(sessionNum);
    if (hasWeekly) quotas["Weekly (7d)"] = ratioQuota(weeklyNum);

    return { plan, quotas };
  } catch (error) {
    return { message: `Ollama Cloud error: ${error.message}` };
  }
}



/**
 * Vercel AI Gateway usage — credit balance for the API key
 *
 * Calls GET /v1/credits which returns:
 *   { "balance": "95.50", "total_used": "4.50" }   (USD as decimal strings)
 *
 * We surface this as a single "Balance ($)" quota row so the existing
 * QuotaTable / progress-bar UI can render it. used = total_used,
 * total = balance + total_used (the original credit allotment), so the
 * remaining percentage equals balance / total.
 *
 * Docs: https://vercel.com/docs/ai-gateway/usage
 */
export async function getVercelAiGatewayUsage(apiKey, proxyOptions = null) {
  if (!apiKey) {
    return { message: "Vercel AI Gateway API key not available." };
  }

  try {
    const response = await proxyAwareFetch(VERCEL_AI_GATEWAY_CREDITS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return { message: "Vercel AI Gateway API key invalid or expired." };
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const trimmed = errorText ? `: ${errorText.slice(0, 200)}` : "";
      return { message: `Vercel AI Gateway credits API error (${response.status})${trimmed}` };
    }

    const data = await response.json();

    // Vercel returns numeric strings; coerce safely.
    const balance = Number(data?.balance) || 0;
    const totalUsed = Number(data?.total_used) || 0;

    // Vercel gives $5/month free credit. The API doesn't return the
    // monthly allocation so we use the known constant as the denominator.
    const MONTHLY_CREDIT = 5;
    const remainingPercentage = (balance / MONTHLY_CREDIT) * 100;

    if (balance <= 0 && totalUsed <= 0) {
      return {
        plan: "Pay-as-you-go",
        message: "Vercel AI Gateway connected. No credit allocation found (BYOK or unfunded account).",
        quotas: {},
      };
    }

    // "Used (USD)": how much has been spent this month (no fixed cap → unlimited).
    // "Remaining (USD)": balance remaining out of the $5 monthly allocation.
    return {
      plan: "Pay-as-you-go",
      quotas: {
        "Used (USD)": {
          used: totalUsed,
          total: 0,
          remaining: 0,
          remainingPercentage: 100,
          unlimited: true,
        },
        "Remaining (USD)": {
          used: balance,
          total: MONTHLY_CREDIT,
          remaining: balance,
          remainingPercentage,
          unlimited: false,
        },
      },
    };
  } catch (error) {
    return { message: `Vercel AI Gateway error: ${error.message}` };
  }
}

export async function getQoderUsage(accessToken, proxyOptions = null) {
  if (!accessToken) {
    return { message: "Qoder usage unavailable: no access token" };
  }
  try {
    const response = await proxyAwareFetch(
      U("qoder").url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );
    if (!response.ok) {
      return { message: `Qoder connected. Usage fetch returned ${response.status}.` };
    }
    const body = await response.json().catch(() => null);
    if (!body) {
      return { message: "Qoder connected. Usage response was not JSON." };
    }
    // Quota records live under `quotas`; scalar metadata
    // (totalUsagePercentage, isQuotaExceeded, expiresAt) are surfaced as
    // siblings so the dashboard parser doesn't try to render them as rows.
    const userQuota = body.userQuota || {};
    const orgQuota = body.orgResourcePackage || {};
    // Qoder publishes a single absolute reset timestamp (`expiresAt` in ms);
    // surface it on every quota record as ISO so the table can render
    // "resets at" alongside used/total.
    const expiresAtMs = Number.isFinite(Number(body.expiresAt)) && Number(body.expiresAt) > 0
      ? Number(body.expiresAt)
      : null;
    const resetAt = expiresAtMs ? new Date(expiresAtMs).toISOString() : null;
    const quotas = {
      user: {
        total: Number(userQuota.total) || 0,
        used: Number(userQuota.used) || 0,
        remaining: Number(userQuota.remaining) || 0,
        unit: userQuota.unit || "credits",
        resetAt,
      },
      organization: {
        total: Number(orgQuota.total) || 0,
        used: Number(orgQuota.used) || 0,
        remaining: Number(orgQuota.remaining) || 0,
        unit: orgQuota.unit || "credits",
        resetAt,
      },
    };
    return {
      quotas,
      totalUsagePercentage: Number(body.totalUsagePercentage) || 0,
      isQuotaExceeded: !!body.isQuotaExceeded,
      expiresAt: expiresAtMs,
    };
  } catch (error) {
    return { message: `Qoder connected. Unable to fetch usage: ${error.message}` };
  }
}

function qoderworkCnResetAt(raw) {
  if (!raw) return null;
  const numeric = Number(raw);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
    : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const QODERWORK_CN_ACCOUNT_CONTEXT_URL =
  "https://gateway.qwenwork.cn/api/v1/adapter/user/account-context";

function qoderworkCnPlanLabel(userType) {
  if (typeof userType !== "string" || !userType.trim()) return null;
  return userType
    .trim()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// CN quota/usage speaks snake_case ({user_quota, add_on_quota,
// org_resource_package, expires_at, ...}) — unlike Qoder intl's camelCase —
// so it needs its own parser.
function qoderworkCnQuotaRecord(quota, resetAt) {
  if (!quota || typeof quota !== "object") return null;
  const used = Number(quota.used) || 0;
  const remaining = Number(quota.remaining) || 0;
  // Personal/free accounts currently return a balance-shaped quota from
  // account-context: { total: null, used: null, remaining: 2100 }. Treat the
  // available balance as the pool size so the dashboard does not interpret
  // the row as an empty/unlimited 0-total quota.
  const reportedTotal = Number(quota.total) || 0;
  const total = reportedTotal > 0 ? reportedTotal : used + remaining;
  if (!total && !used && !remaining) return null;
  const remainingPercentage =
    total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : null;
  return {
    total,
    used,
    remaining,
    unit: quota.unit || "credits",
    resetAt,
    remainingPercentage,
  };
}

/**
 * QoderWork CN usage.
 *
 * The device callback first grants a personal-context OAuth token. During
 * login, enterprise accounts are switched through /adapter/auth/switch and the
 * resulting is_biz token is persisted. The official desktop client reads quota
 * from account-context with that switched token; no browser cookie is needed.
 */
export async function getQoderworkCnUsage(accessToken, proxyOptions = null, providerSpecificData = {}) {
  if (!accessToken) {
    return { message: "QoderWork CN usage unavailable: no access token" };
  }

  try {
    const url = new URL(QODERWORK_CN_ACCOUNT_CONTEXT_URL);
    url.searchParams.set("include", "user,plan,quota,page,data_sharing");
    url.searchParams.set(
      "state",
      Buffer.from(JSON.stringify({ v: 1 })).toString("base64url"),
    );
    const response = await proxyAwareFetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": "qoderwork/0.1.8",
      },
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return {
        message: `QoderWork CN token expired or unauthorized (${response.status}). Please re-authorize.`,
      };
    }

    if (!response.ok) {
      return { message: `QoderWork CN connected. Usage fetch returned ${response.status}.` };
    }

    const body = await response.json().catch(() => null);
    const data = body?.data && typeof body.data === "object" ? body.data : body;
    if (!data || typeof data !== "object" || (body?.code && body.code !== "ok")) {
      return { message: "QoderWork CN account-context response was not valid JSON." };
    }

    const user = data.user && typeof data.user === "object" ? data.user : data;
    const quota = data.quota && typeof data.quota === "object" ? data.quota : null;
    const planData = data.plan && typeof data.plan === "object" ? data.plan : null;
    const resetAt = qoderworkCnResetAt(quota?.expires_at || quota?.reset_at || null);
    const primary = qoderworkCnQuotaRecord(quota, resetAt);
    if (!primary) {
      return { message: "QoderWork CN account-context did not include quota." };
    }

    const isBiz = user.is_biz === true || providerSpecificData?.identityTarget === "biz";
    const quotas = { [isBiz ? "organization" : "user"]: primary };
    const addOn = qoderworkCnQuotaRecord(quota?.add_on_quota, resetAt);
    if (addOn) quotas["add-on"] = addOn;
    const org = qoderworkCnQuotaRecord(
      quota?.org_resource_package || quota?.shared_quota,
      resetAt,
    );
    if (org) quotas.organization = org;

    const total = Number(primary.total) || 0;
    const used = Number(primary.used) || 0;

    return {
      plan: planData?.name || qoderworkCnPlanLabel(planData?.user_type || (isBiz ? "enterprise" : "personal")),
      quotas,
      balance: primary.remaining,
      freezeCredit: 0,
      totalUsagePercentage: total > 0 ? (used / total) * 100 : 0,
      isQuotaExceeded: quota?.exceeded === true || (total > 0 && used >= total),
      organizationId: providerSpecificData?.organizationId || null,
    };
  } catch (error) {
    return { message: `QoderWork CN usage unavailable: ${error.message}` };
  }
}
