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
          database: "error"
        }, { status: 500 });
      }
    }

    return Response.json({
      success: false,
      error: "Endpoint not found"
    }, { status: 404 });
  }
};
