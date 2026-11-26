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
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
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

// Verify Telegram Mini App initData.
async function authenticateTelegram(request, env) {
  try {
    if (!env.TELEGRAM_BOT_TOKEN) {
      return null;
    }

    const authorization = request.headers.get("Authorization") || "";

    if (!authorization.startsWith("tma ")) {
      return null;
    }

    const initData = authorization.slice(4);

    if (!initData || initData.length > 10000) {
      return null;
    }

    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");

    if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
      return null;
    }

    params.delete("hash");

    const authDate = Number(params.get("auth_date"));

    if (
      !Number.isFinite(authDate) ||
      authDate > Math.floor(Date.now() / 1000) + 60 ||
      Math.floor(Date.now() / 1000) - authDate > 86400
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

    if (!userString) {
      return null;
    }

    const user = JSON.parse(userString);

    if (!validTelegramId(user.id)) {
      return null;
    }

    return {
      telegram_id: String(user.id),
      first_name: String(user.first_name || "")
    };

  } catch (error) {
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

// Monetag server-to-server postback.
// Estimated revenue is recorded as PENDING only.
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
  const estimatedPrice = Number(params.get("estimated_price") || 0);

  if (!validRewardId(rewardId) || !validTelegramId(telegramId)) {
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

  const amountMicros = dollarsToMicros(estimatedPrice);

  if (!amountMicros) {
    return errorResponse(request, {
      success: false,
      error: "Invalid estimated reward amount"
    }, 400);
  }

  try {
    await ensureWallet(env, telegramId);

    const rewardDate = new Date().toISOString().slice(0, 10);

    // D1 batch executes these statements atomically.
    // changes() ensures a duplicate reward cannot update the wallet.
    await env.DB.batch([
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

      env.DB.prepare(`
        UPDATE wallets
        SET pending_micros = pending_micros + ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE telegram_id = ?
          AND changes() > 0
      `).bind(amountMicros, telegramId),

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
          'pending',
          'pending',
          'Estimated Monetag reward awaiting revenue reconciliation',
          ?
        WHERE changes() > 0
      `).bind(
        telegramId,
        "MONETAG-" + rewardId,
        amountMicros,
        rewardId
      )
    ]);

    const existing = await env.DB.prepare(`
      SELECT telegram_id, status
      FROM rewards
      WHERE reward_id = ?
    `).bind(rewardId).first();

    if (!existing || existing.telegram_id !== telegramId) {
      return errorResponse(request, {
        success: false,
        error: "Reward ownership mismatch"
      }, 409);
    }

    return successResponse(request, {
      success: true,
      status: existing.status,
      duplicate: existing.status === "pending" &&
        false,
      message: "Reward recorded for reconciliation. It is not withdrawable yet."
    });

  } catch (error) {
    return errorResponse(request, {
      success: false,
      error: "Reward recording failed"
    }, 500);
  }
}

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

      } catch (error) {
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
        return errorResponse(request, {
          success: false,
          error: "Transaction request failed"
        }, 500);
      }
    }

    if (url.pathname === "/monetag/postback") {
      return await handleMonetagPostback(request, env, url);
    }

    // Old SMM confirmation endpoint intentionally retired.
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
