export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return Response.json({
        success: true,
        project: "VIEWORA Rewards API",
        status: "online"
      });
    }

    if (url.pathname === "/health") {
      try {
        await env.DB.prepare("SELECT 1").first();

        return Response.json({
          success: true,
          worker: "online",
          database: "connected"
        });
      } catch (error) {
        return Response.json({
          success: false,
          error: "Database connection failed"
        }, { status: 500 });
      }
    }

    if (url.pathname === "/test-tbc") {
      if (request.method !== "POST") {
        return Response.json({
          success: false,
          error: "POST required"
        }, { status: 405 });
      }

      const auth = request.headers.get("Authorization");

      if (auth !== `Bearer ${env.POSTBACK_SECRET}`) {
        return Response.json({
          success: false,
          error: "Unauthorized"
        }, { status: 401 });
      }

      if (!env.TBC_REWARD_WEBHOOK_URL) {
        return Response.json({
          success: false,
          error: "TBC webhook not configured"
        }, { status: 500 });
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

        return Response.json({
          success: response.ok,
          tbc_http_status: response.status,
          test_sent: true,
          reward_credited: false
        });

      } catch (error) {
        return Response.json({
          success: false,
          error: "TBC connection failed"
        }, { status: 502 });
      }
    }

    return Response.json({
      success: false,
      error: "Endpoint not found"
    }, { status: 404 });
  }
};
