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

  return await fetch(env.TBC_REWARD_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
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

    // HEALTH CHECK
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

    // TBC CREDIT CONFIRMATION
    if (url.pathname === "/tbc/confirm") {
      if (request.method !== "POST") {
        return json({
          success: false,
          error: "POST required"
        }, 405);
      }

      try {
        const contentType = request.headers.get("Content-Type") || "";
let data;

if (contentType.includes("application/json")) {
  data = await request.json();
} else {
  const form = await request.formData();
  data = Object.fromEntries(form.entries());
}

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

        if (
          !/^\d+$/.test(telegramId) ||
          !/^[A-Za-z0-9_.-]{1,150}$/.test(rewardId)
        ) {
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

        if (result.meta.changes > 0) {
          return json({
            success: true,
            confirmed: true,
            updated: result.meta.changes
          });
        }

        const existing = await env.DB.prepare(`
          SELECT status, telegram_id
          FROM rewards
          WHERE reward_id = ?
        `).bind(rewardId).first();

        if (
          existing &&
          existing.telegram_id === telegramId &&
          existing.status === "credited"
        ) {
          return json({
            success: true,
            confirmed: true,
            duplicate: true
          });
        }

        return json({
          success: false,
          confirmed: false,
          error: "Reward is not pending or does not match"
        }, 409);

      } catch (error) {
        return json({
          success: false,
          error: "Confirmation processing failed"
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

        if (
          !env.POSTBACK_SECRET ||
          params.get("secret") !== env.POSTBACK_SECRET
        ) {
          return json({
            success: false,
            error: "Unauthorized"
          }, 401);
        }

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

        if (
          !env.TBC_REWARD_WEBHOOK_URL ||
          !env.MINAPP_INTERNAL_SECRET
        ) {
          return json({
            success: false,
            error: "Reward delivery is not configured"
          }, 500);
        }

        const rewardDate = new Date().toISOString().slice(0, 10);

        // Record the reward as pending.
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
            error: "Reward record not found"
          }, 500);
        }

        if (existing.telegram_id !== telegramId) {
          return json({
            success: false,
            error: "Reward ownership mismatch"
          }, 409);
        }

        if (existing.status === "credited") {
          return json({
            success: true,
            duplicate: true,
            status: "credited"
          });
        }

        // Only pending rewards are automatically delivered.
        if (existing.status !== "pending") {
          return json({
            success: false,
            status: existing.status,
            error: "Reward requires reconciliation"
          }, 409);
        }

        // Send reward to TBC.
        const tbcResponse = await deliverReward(env, {
          telegram_id: telegramId,
          reward_id: rewardId
        });

        if (!tbcResponse.ok) {
          return json({
            success: false,
            status: "pending",
            error: "TBC delivery request failed"
          }, 502);
        }

        // Check whether TBC actually confirmed the credit.
        const finalRecord = await env.DB.prepare(`
          SELECT status
          FROM rewards
          WHERE reward_id = ?
        `).bind(rewardId).first();

        if (finalRecord && finalRecord.status === "credited") {
          return json({
            success: true,
            status: "credited",
            views: 50,
            reactions: 5
          });
        }

        return json({
          success: true,
          status: "pending",
          message: "Reward delivered to TBC but confirmation is still pending"
        }, 202);

      } catch (error) {
        return json({
          success: false,
          error: "Reward processing failed"
        }, 500);
      }
    }

    // CONTROLLED CONNECTION TEST
    if (
      url.pathname === "/test-tbc" ||
      url.pathname === "/test-reward"
    ) {
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

    return json({
      success: false,
      error: "Endpoint not found"
    }, 404);
  }
};
