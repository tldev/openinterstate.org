export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.hostname === "www.openinterstate.org") {
      url.hostname = "openinterstate.org";
      return Response.redirect(url.toString(), 301);
    }

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("x-openinterstate-site", "worker");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
};
