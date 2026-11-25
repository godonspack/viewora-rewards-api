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

    if (url.pathname === "/test-tbc") {
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

      if (!env.TBC_REWARD_WEBHOOK_URL) {
        return json({
          success: false,
          error: "TBC webhook not configured"
        }, 500);
      }

      try {
        const testData = {
          diagnostic: true,
          source: "VIEWORA_CLOUDFLARE",
          test_id: crypto.randomUUID(),
          message: "Connection test only. No reward."
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
          reward_credited: false
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
