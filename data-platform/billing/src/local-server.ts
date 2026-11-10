import { createServer } from "node:http";
import { handler } from "./handler.ts";

/**
 * Local development only (Aspire): accepts the same JSON event the Lambda receives on
 * `POST /invoke` and returns the handler's response, like Lambda's Invoke API.
 */
const port = Number(process.env.PORT ?? 5200);

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
    return;
  }
  if (request.method !== "POST" || request.url !== "/invoke") {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", async () => {
    try {
      const result = await handler(JSON.parse(body || "null"));
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (error) {
      // Lambda reports an unhandled error as FunctionError; mirror that with a 500.
      response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ errorMessage: String(error) }));
    }
  });
});

server.listen(port, "127.0.0.1", () => console.log(`Billing listening at http://127.0.0.1:${port}`));
