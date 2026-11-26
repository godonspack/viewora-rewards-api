const ALLOWED_ORIGINS = [
  "https://viewora-miniapp.pages.dev",
  "https://hoppscotch.io"
];

const MONETAG_ZONE_ID = "12349862";
const MONETAG_REQUEST_VAR = "viewora_earn";

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin)
    ? origin
    : ALLOWED_ORIGINS[0];

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Viewora-Test-Secret",
    "Vary": "Origin"
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json"
    }
  });
}

function errorResponse(request, data, status = 400) {
  return json(data, status, corsHeaders(request));
}

function successResponse(request, data, status = 200) {
  return json(data, status, corsHeaders(request));
}

function validTelegramId(value) {
  return /^\d{1,20}$/.test(String(value || ""));
}

function validRewardId(value) {
  return /^[A-Za-z0-9_.-]{1,150}$/.test(String(value || ""));
}

function dollarsToMicros(value) {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000) {
    return 0;
  }

  return Math.round(amount * 1000000);
}

function microsToDollars(value) {
  return Number(value || 0) / 1000000;
}

async function hmacSha256(key, message) {
  const importedKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      importedKey,
      new TextEncoder().encode(message)
    )
  );
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;

  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

async function authenticateTelegram(request, env) {
  try {
    if (!env.TELEGRAM_BOT_TOKEN) return null;

    const authorization = request.headers.get("Authorization") || "";

    if (!authorization.startsWith("tma ")) return null;

    const initData = authorization.slice(4);

    if (!initData || initData.length > 10000) return null;

    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");

    if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
      return null;
    }

    params.delete("hash");

    const authDate = Number(params.get("auth_date"));
    const now = Math.floor(Date.now() / 1000);

    if (
      !Number.isFinite(authDate) ||
      authDate > now + 60 ||
      now - authDate > 86400
    ) {
      return null;
    }

    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = await hmacSha256(
      new TextEncoder().encode("WebAppData"),
      env.TELEGRAM_BOT_TOKEN
    );

    const calculatedHash = bytesToHex(
      await hmacSha256(secretKey, dataCheckString)
    );

    if (!constantTimeEqual(calculatedHash, receivedHash.toLowerCase())) {
      return null;
    }

    const userString = params.get("user");

    if (!userString) return null;

    const user = JSON.parse(userString);

    if (!validTelegramId(user.id)) return null;

    return {
      telegram_id: String(user.id),
      first_name: String(user.first_name || "")
    };

  } catch {
    return null;
  }
}

async function ensureWallet(env, telegramId) {
  await env.DB.prepare(`
    INSERT OR IGNORE INTO wallets (telegram_id)
    VALUES (?)
  `).bind(telegramId).run();
}

async function getWallet(env, telegramId) {
  await ensureWallet(env, telegramId);

  return await env.DB.prepare(`
    SELECT
      telegram_id,
      pending_micros,
      available_micros,
      lifetime_earned_micros,
      total_withdrawn_micros,
      total_converted_micros,
      created_at,
      updated_at
    FROM wallets
    WHERE telegram_id = ?
  `).bind(telegramId).first();
}

async function handleWallet(request, env) {
  const user = await authenticateTelegram(request, env);

  if (!user) {
    return errorResponse(request, {
      success: false,
      error: "Telegram authentication failed"
    }, 401);
  }

  const wallet = await getWallet(env, user.telegram_id);

  if (!wallet) {
    return errorResponse(request, {
      success: false,
      error: "Wallet could not be loaded"
    }, 500);
  }

  return successResponse(request, {
    success: true,
    wallet: {
      currency: "USD",
      pending: microsToDollars(wallet.pending_micros),
      available: microsToDollars(wallet.available_micros),
      lifetime_earned: microsToDollars(wallet.lifetime_earned_micros),
      total_withdrawn: microsToDollars(wallet.total_withdrawn_micros),
      total_converted: microsToDollars(wallet.total_converted_micros)
    }
  });
}

async function handleTransactions(request, env, url) {
  const user = await authenticateTelegram(request, env);

  if (!user) {
    return errorResponse(request, {
      success: false,
      error: "Telegram authentication failed"
    }, 401);
  }

  const requestedLimit = Number(url.searchParams.get("limit") || 20);

  const limit = Math.max(
    1,
    Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 20, 50)
  );

  const result = await env.DB.prepare(`
    SELECT
      transaction_id,
      transaction_type,
      source,
      amount_micros,
      balance_type,
      status,
      description,
      created_at
    FROM wallet_transactions
    WHERE telegram_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).bind(user.telegram_id, limit).all();

  return successResponse(request, {
    success: true,
    transactions: (result.results || []).map(item => ({
      transaction_id: item.transaction_id,
      type: item.transaction_type,
      source: item.source,
      amount: microsToDollars(item.amount_micros),
      currency: "USD",
      balance_type: item.balance_type,
      status: item.status,
      description: item.description,
      created_at: item.created_at
    }))
  });
}

async function getRevenueConfig(env) {
  const result = await env.DB.prepare(`
    SELECT config_key, config_value
    FROM platform_config
    WHERE config_key IN (
      'user_share_percent',
      'platform_share_percent',
      'rewards_enabled'
    )
  `).all();

  const config = {};

  for (const row of result.results || []) {
    config[row.config_key] = row.config_value;
  }

  const userShare = Number(config.user_share_percent);
  const platformShare = Number(config.platform_share_percent);

  if (
    config.rewards_enabled !== "1" ||
    !Number.isFinite(userShare) ||
    !Number.isFinite(platformShare) ||
    userShare <= 0 ||
    platformShare < 0 ||
    userShare + platformShare !== 100
  ) {
    return null;
  }

  return {
    userShare,
    platformShare
  };
}

// Monetag server-to-server postback.
// Only verified valued events are eligible for immediate credit.
async function handleMonetagPostback(request, env, url) {
  if (request.method !== "GET") {
    return errorResponse(request, {
      success: false,
      error: "GET required"
    }, 405);
  }

  if (
    !env.POSTBACK_SECRET ||
    url.searchParams.get("secret") !== env.POSTBACK_SECRET
  ) {
    return errorResponse(request, {
      success: false,
      error: "Unauthorized"
    }, 401);
  }

  const params = url.searchParams;

  if (params.get("reward_event_type") !== "valued") {
    return successResponse(request, {
      success: true,
      ignored: true,
      reason: "Not a valued reward"
    });
  }

  const rewardId = params.get("ymid") || "";
  const telegramId = params.get("telegram_id") || "";
  const zoneId = params.get("zone_id") || "";
  const requestVar = params.get("request_var") || "";
  const eventType = params.get("event_type") || "";
  const estimatedPrice = params.get("estimated_price") || "";

  if (
    !validRewardId(rewardId) ||
    !validTelegramId(telegramId)
  ) {
    return errorResponse(request, {
      success: false,
      error: "Invalid reward or Telegram ID"
    }, 400);
  }

  if (
    zoneId !== MONETAG_ZONE_ID ||
    requestVar !== MONETAG_REQUEST_VAR
  ) {
    return errorResponse(request, {
      success: false,
      error: "Unexpected Monetag reward"
    }, 400);
  }

  const grossMicros = dollarsToMicros(estimatedPrice);

  if (!grossMicros) {
    return errorResponse(request, {
      success: false,
      error: "Invalid estimated reward amount"
    }, 400);
  }

  try {
    const config = await getRevenueConfig(env);

    if (!config) {
      return errorResponse(request, {
        success: false,
        error: "Rewards are disabled or revenue configuration is invalid"
      }, 503);
    }

    const userRewardMicros = Math.round(
      grossMicros * config.userShare / 100
    );

    const platformShareMicros = grossMicros - userRewardMicros;

    if (userRewardMicros <= 0) {
      return errorResponse(request, {
        success: false,
        error: "Reward amount is too small"
      }, 400);
    }

    const rewardDate = new Date().toISOString().slice(0, 10);
    const transactionId = "MONETAG-" + rewardId;

    await ensureWallet(env, telegramId);

    // Every balance-changing operation is gated by changes().
    // D1 batch is atomic: a failed statement rolls back the batch.

    const results = await env.DB.batch([

      // 1. Insert unique Monetag reward.
      env.DB.prepare(`
        INSERT OR IGNORE INTO rewards (
          telegram_id,
          reward_id,
          amount,
          reward_date,
          views_amount,
          reactions_amount,
          status,
          event_type,
          estimated_price,
          zone_id,
          request_var
        )
        VALUES (?, ?, ?, ?, 0, 0, 'pending', ?, ?, ?, ?)
      `).bind(
        telegramId,
        rewardId,
        estimatedPrice,
        rewardDate,
        eventType,
        estimatedPrice,
        zoneId,
        requestVar
      ),

      // 2. Insert the internal revenue ledger entry.
      // Only if the reward was newly inserted.
      env.DB.prepare(`
        INSERT OR IGNORE INTO monetag_reward_ledger (
          reward_id,
          telegram_id,
          gross_estimate_micros,
          user_reward_micros,
          platform_share_micros,
          user_share_percent,
          platform_share_percent,
          status
        )
        SELECT
          ?, ?, ?, ?, ?, ?, ?, 'credited'
        WHERE changes() > 0
      `).bind(
        rewardId,
        telegramId,
        grossMicros,
        userRewardMicros,
        platformShareMicros,
        config.userShare,
        config.platformShare
      ),

      // 3. Credit available wallet balance.
      // Only if the ledger was newly inserted.
      env.DB.prepare(`
        UPDATE wallets
        SET
          available_micros = available_micros + ?,
          lifetime_earned_micros = lifetime_earned_micros + ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE telegram_id = ?
          AND changes() > 0
      `).bind(
        userRewardMicros,
        userRewardMicros,
        telegramId
      ),

      // 4. Insert completed wallet transaction.
      // Only if the wallet was updated.
      env.DB.prepare(`
        INSERT INTO wallet_transactions (
          telegram_id,
          transaction_id,
          transaction_type,
          source,
          amount_micros,
          balance_type,
          status,
          description,
          reference_id
        )
        SELECT
          ?,
          ?,
          'earning',
          'monetag',
          ?,
          'available',
          'completed',
          'Monetag valued reward',
          ?
        WHERE changes() > 0
      `).bind(
        telegramId,
        transactionId,
        userRewardMicros,
        rewardId
      ),

      // 5. Mark reward as credited.
      // Only if the transaction was inserted.
      env.DB.prepare(`
        UPDATE rewards
        SET
          status = 'credited',
          credited_at = CURRENT_TIMESTAMP
        WHERE reward_id = ?
          AND telegram_id = ?
          AND changes() > 0
      `).bind(
        rewardId,
        telegramId
      )

    ]);

    const inserted = Number(results[0]?.meta?.changes || 0);

    if (inserted === 1) {
      return successResponse(request, {
        success: true,
        duplicate: false,
        status: "credited",
        currency: "USD",
        gross_estimate: microsToDollars(grossMicros),
        user_reward: microsToDollars(userRewardMicros),
        platform_share: microsToDollars(platformShareMicros),
        message: "Reward credited successfully."
      });
    }

    // Duplicate reward: verify ownership.
    const existing = await env.DB.prepare(`
      SELECT telegram_id, status
      FROM rewards
      WHERE reward_id = ?
    `).bind(rewardId).first();

    if (!existing) {
      return errorResponse(request, {
        success: false,
        error: "Reward record could not be verified"
      }, 500);
    }

    if (existing.telegram_id !== telegramId) {
      return errorResponse(request, {
        success: false,
        error: "Reward ownership mismatch"
      }, 409);
    }

    return successResponse(request, {
      success: true,
      duplicate: true,
      status: existing.status,
      message: "Reward already processed. No additional credit was added."
    });

  } catch (error) {
    console.error("Monetag postback processing failed:", error);

    return errorResponse(request, {
      success: false,
      error: "Reward processing failed"
    }, 500);
  }
}

async function handleDuplicateRewardTest(request, env) {
if (request.method !== "POST") {
return json({ success: false, error: "POST required" }, 405);
}

const suppliedSecret = request.headers.get("X-Viewora-Test-Secret") || "";

if (
!env.MINAPP_INTERNAL_SECRET ||
!constantTimeEqual(suppliedSecret, env.MINAPP_INTERNAL_SECRET)
) {
return json({ success: false, error: "Unauthorized" }, 401);
}

if (!env.POSTBACK_SECRET) {
return json({ success: false, error: "Postback secret is missing" }, 503);
}

const randomDigits = Array.from(
crypto.getRandomValues(new Uint8Array(17)),
byte => String(byte % 10)
).join("");

const testTelegramId = "99" + randomDigits;
const testRewardId = "VIEWORA-DUPTEST-" + crypto.randomUUID();

let testWalletCreated = false;

try {
const existingWallet = await env.DB.prepare("SELECT telegram_id FROM wallets WHERE telegram_id = ?").bind(testTelegramId).first();

if (existingWallet) {
  throw new Error("Synthetic test account collision");
}

await ensureWallet(env, testTelegramId);
testWalletCreated = true;

const testUrl = new URL("https://internal.test/monetag/postback");

testUrl.searchParams.set("secret", env.POSTBACK_SECRET);
testUrl.searchParams.set("ymid", testRewardId);
testUrl.searchParams.set("event_type", "impression");
testUrl.searchParams.set("reward_event_type", "valued");
testUrl.searchParams.set("estimated_price", "0.10");
testUrl.searchParams.set("zone_id", MONETAG_ZONE_ID);
testUrl.searchParams.set("request_var", MONETAG_REQUEST_VAR);
testUrl.searchParams.set("telegram_id", testTelegramId);

const firstResponse = await handleMonetagPostback(
  new Request(testUrl.toString()),
  env,
  testUrl
);

const firstResult = await firstResponse.json();

const secondResponse = await handleMonetagPostback(
  new Request(testUrl.toString()),
  env,
  testUrl
);

const secondResult = await secondResponse.json();

const wallet = await env.DB.prepare(`
  SELECT available_micros, lifetime_earned_micros
  FROM wallets
  WHERE telegram_id = ?
`).bind(testTelegramId).first();

const ledger = await env.DB.prepare(`
  SELECT COUNT(*) AS total
  FROM monetag_reward_ledger
  WHERE reward_id = ?
`).bind(testRewardId).first();

const transactions = await env.DB.prepare(`
  SELECT COUNT(*) AS total
  FROM wallet_transactions
  WHERE telegram_id = ? AND reference_id = ?
`).bind(testTelegramId, testRewardId).first();

const reward = await env.DB.prepare(`
  SELECT COUNT(*) AS total, MAX(status) AS status
  FROM rewards
  WHERE reward_id = ? AND telegram_id = ?
`).bind(testRewardId, testTelegramId).first();

const expectedReward = 40000;

const passed =
  firstResult.success === true &&
  firstResult.duplicate === false &&
  secondResult.success === true &&
  secondResult.duplicate === true &&
  Number(wallet?.available_micros) === expectedReward &&
  Number(wallet?.lifetime_earned_micros) === expectedReward &&
  Number(ledger?.total) === 1 &&
  Number(transactions?.total) === 1 &&
  Number(reward?.total) === 1 &&
  reward?.status === "credited";

return json({
  success: true,
  test: passed ? "PASSED" : "FAILED",
  first_submission: firstResult,
  second_submission: secondResult,
  checks: {
    wallet_credit_micros: Number(wallet?.available_micros || 0),
    expected_wallet_credit_micros: expectedReward,
    ledger_entries: Number(ledger?.total || 0),
    wallet_transactions: Number(transactions?.total || 0),
    reward_records: Number(reward?.total || 0),
    reward_status: reward?.status || null
  },
  test_records: "Will be cleaned up automatically"
});

} catch (error) {
console.error("Duplicate reward test failed:", error);

return json({
  success: false,
  test: "ERROR",
  error: "The duplicate-reward test could not be completed."
}, 500);

} finally {
if (testWalletCreated) {
await env.DB.batch([
env.DB.prepare("DELETE FROM wallet_transactions WHERE telegram_id = ? AND reference_id = ?").bind(testTelegramId, testRewardId),

    env.DB.prepare(`
      DELETE FROM monetag_reward_ledger
      WHERE reward_id = ? AND telegram_id = ?
    `).bind(testRewardId, testTelegramId),

    env.DB.prepare(`
      DELETE FROM rewards
      WHERE reward_id = ? AND telegram_id = ?
    `).bind(testRewardId, testTelegramId),

    env.DB.prepare(`
      DELETE FROM wallets
      WHERE telegram_id = ?
    `).bind(testTelegramId)
  ]);
}
}}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request)
      });
    }

    if (url.pathname === "/") {
      return successResponse(request, {
        success: true,
        project: "VIEWORA Rewards API",
        status: "online"
      });
    }

    if (url.pathname === "/health") {
      try {
        await env.DB.prepare("SELECT 1").first();

        return successResponse(request, {
          success: true,
          worker: "online",
          database: "connected",
          wallet_system: "enabled"
        });

      } catch {
        return errorResponse(request, {
          success: false,
          error: "Database connection failed"
        }, 500);
      }
    }

    if (url.pathname === "/api/wallet") {
      if (request.method !== "GET") {
        return errorResponse(request, {
          success: false,
          error: "GET required"
        }, 405);
      }

      try {
        return await handleWallet(request, env);
      } catch (error) {
        console.error("Wallet request failed:", error);

        return errorResponse(request, {
          success: false,
          error: "Wallet request failed"
        }, 500);
      }
    }

    if (url.pathname === "/api/transactions") {
      if (request.method !== "GET") {
        return errorResponse(request, {
          success: false,
          error: "GET required"
        }, 405);
      }

      try {
        return await handleTransactions(request, env, url);
      } catch (error) {
        console.error("Transaction request failed:", error);

        return errorResponse(request, {
          success: false,
          error: "Transaction request failed"
        }, 500);
      }
    }

    if (url.pathname === "/admin/test-duplicate") {
  return await handleDuplicateRewardTest(request, env);
    }

    if (url.pathname === "/monetag/postback") {
      return await handleMonetagPostback(request, env, url);
    }

    if (url.pathname === "/tbc/confirm") {
      return errorResponse(request, {
        success: false,
        error: "This legacy SMM endpoint has been retired"
      }, 410);
    }

    return errorResponse(request, {
      success: false,
      error: "Endpoint not found"
    }, 404);
  }
};
