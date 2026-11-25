const corsHeaders = {
  "Access-Control-Allow-Origin": "https://hoppscotch.io",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}

async function deliverReward(env, reward) {
  const payload = {
    source: "VIEWORA_CLOUDFLARE",
    telegram_id: reward.telegram_id,
    reward_id: reward.reward_id,
    views: 50,
    reactions: 5,
    internal_secret: env.MINAPP_INTERNAL_SECRET
  };

  const response = await fetch(env.TBC_REWARD_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error("TBC webhook returned HTTP " + response.status);
  }

  return response.status;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    if (url.pathname === "/") {
      return json({
        success: true,
        project: "VIEWORA Rewards API",
        status: "online"
      });
    }

    if (url.pathname === "/health") {
      try {
        await env.DB.prepare("SELECT 1").first();

        return json({
          success: true,
          worker: "online",
          database: "connected"
        });
      } catch (error) {
        return json({
          success: false,
          error: "Database connection failed"
        }, 500);
      }
    }

    // MONETAG SERVER-TO-SERVER POSTBACK
    if (url.pathname === "/monetag/postback") {
      if (request.method !== "GET") {
        return json({
          success: false,
          error: "GET required"
        }, 405);
      }

      try {
        const params = url.searchParams;

        // Verify Monetag postback secret
        if (
          !env.POSTBACK_SECRET ||
          params.get("secret") !== env.POSTBACK_SECRET
        ) {
          return json({
            success: false,
            error: "Unauthorized"
          }, 401);
        }

        // Only valued ad events qualify
        if (params.get("reward_event_type") !== "valued") {
          return json({
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
        const estimatedPrice = Number(
          params.get("estimated_price") || 0
        );

        // Validate required values
        if (
          !/^[A-Za-z0-9_.-]{1,150}$/.test(rewardId) ||
          !/^\d+$/.test(telegramId)
        ) {
          return json({
            success: false,
            error: "Invalid reward or Telegram ID"
          }, 400);
        }

        if (zoneId !== "12349862") {
          return json({
            success: false,
            error: "Unexpected Monetag zone"
          }, 400);
        }

        if (requestVar !== "viewora_earn") {
          return json({
            success: false,
            error: "Unexpected reward request"
          }, 400);
        }

        if (!env.TBC_REWARD_WEBHOOK_URL ||
            !env.MINAPP_INTERNAL_SECRET) {
          return json({
            success: false,
            error: "Reward delivery is not configured"
          }, 500);
        }

        const rewardDate = new Date().toISOString().slice(0, 10);

        // Record the reward. reward_id is UNIQUE in D1.
        await env.DB.prepare(`
          INSERT OR IGNORE INTO rewards
          (
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
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          telegramId,
          rewardId,
          estimatedPrice,
          rewardDate,
          50,
          5,
          "pending",
          eventType,
          estimatedPrice,
          zoneId,
          requestVar
        ).run();

        const existing = await env.DB.prepare(`
          SELECT telegram_id, reward_id, status
          FROM rewards
          WHERE reward_id = ?
        `).bind(rewardId).first();

        if (!existing) {
          return json({
            success: false,
            error: "Reward record could not be found"
          }, 500);
        }

        // Do not credit an already credited reward again.
        if (existing.status === "credited") {
          return json({
            success: true,
            duplicate: true,
            status: "credited"
          });
        }

        // Prevent a reward ID from being associated with another user.
        if (existing.telegram_id !== telegramId) {
          return json({
            success: false,
            error: "Reward ID ownership mismatch"
          }, 409);
        }

        // Deliver to the existing VIEWORA wallet.
        const tbcStatus = await deliverReward(env, {
          telegram_id: telegramId,
          reward_id: rewardId
        });

        await env.DB.prepare(`
          UPDATE rewards
          SET status = 'credited',
              credited_at = CURRENT_TIMESTAMP
          WHERE reward_id = ?
        `).bind(rewardId).run();

        await env.DB.prepare(`
          INSERT INTO users
          (telegram_id, total_earnings, total_views, total_reactions)
          VALUES (?, 0, 50, 5)
          ON CONFLICT(telegram_id)
          DO UPDATE SET
            total_views = total_views + 50,
            total_reactions = total_reactions + 5
        `).bind(telegramId).run();

        return json({
          success: true,
          status: "credited",
          views: 50,
          reactions: 5,
          tbc_http_status: tbcStatus
        });

      } catch (error) {
        return json({
          success: false,
          error: "Reward processing failed"
        }, 500);
      }
    }

    // CONTROLLED TEST ENDPOINTS
    if (url.pathname === "/test-tbc" ||
        url.pathname === "/test-reward") {

      if (request.method !== "POST") {
        return json({
          success: false,
          error: "POST required"
        }, 405);
      }

      const auth = request.headers.get("Authorization");

      if (auth !== `Bearer ${env.POSTBACK_SECRET}`) {
        return json({
          success: false,
          error: "Unauthorized"
        }, 401);
      }

      if (!env.TBC_REWARD_WEBHOOK_URL ||
          !env.MINAPP_INTERNAL_SECRET) {
        return json({
          success: false,
          error: "Reward delivery is not configured"
        }, 500);
      }

      try {
        const testData = {
          source: "VIEWORA_CLOUDFLARE",
          telegram_id: "6694470603",
          reward_id: "TEST-" + crypto.randomUUID(),
          views: 50,
          reactions: 5,
          internal_secret: env.MINAPP_INTERNAL_SECRET
        };

        const response = await fetch(
          env.TBC_REWARD_WEBHOOK_URL,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify(testData)
          }
        );

        return json({
          success: response.ok,
          tbc_http_status: response.status,
          test_sent: true,
          reward_credited: false,
          test_reward_id: testData.reward_id
        });

      } catch (error) {
        return json({
          success: false,
          error: "TBC connection failed"
        }, 502);
      }
    }

    // TBC CREDIT CONFIRMATION
if (url.pathname === "/tbc/confirm") {
  if (request.method !== "POST") {
    return json({
      success: false,
      error: "POST required"
    }, 405);
  }

  try {
    const data = await request.json();

    if (
      !env.MINAPP_INTERNAL_SECRET ||
      data.internal_secret !== env.MINAPP_INTERNAL_SECRET
    ) {
      return json({
        success: false,
        error: "Unauthorized"
      }, 401);
    }

    const telegramId = String(data.telegram_id || "");
    const rewardId = String(data.reward_id || "");

    if (!/^\d+$/.test(telegramId) || !rewardId) {
      return json({
        success: false,
        error: "Invalid confirmation data"
      }, 400);
    }

    const result = await env.DB.prepare(`
      UPDATE rewards
      SET status = 'credited',
          credited_at = CURRENT_TIMESTAMP
      WHERE reward_id = ?
        AND telegram_id = ?
        AND status = 'pending'
    `).bind(rewardId, telegramId).run();

    return json({
      success: true,
      confirmed: true,
      updated: result.meta.changes
    });

  } catch (error) {
    return json({
      success: false,
      error: "Confirmation processing failed"
    }, 500);
  }
}

    return json({
      success: false,
      error: "Endpoint not found"
    }, 404);
  }
};
