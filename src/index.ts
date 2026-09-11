export default {
    async fetch(request, env, ctx): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === "/characters") {
            url.pathname = "/characters.html";
            return env.ASSETS.fetch(new Request(url, request));
        }

        return env.ASSETS.fetch(request);
    },
} satisfies ExportedHandler<Env>;