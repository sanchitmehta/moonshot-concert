import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp, type Dependencies } from "../src/http/app.ts";

for (const failing of [undefined, "database", "cache", "catalog", "queues"] as const) {
  test(`root warmup and readiness agree when ${failing ?? "all dependencies are healthy"}`, async t => {
    const calls: string[] = [];
    const dependency = (name: string) => ({
      ping: async () => {
        calls.push(name);
        if (name === failing) throw new Error("Dependency unavailable");
      },
    });
    const deps = {
      inventory: dependency("database"),
      availability: dependency("cache"),
      catalog: dependency("catalog"),
      queues: dependency("queues"),
      authenticate: async () => { throw new Error("Warmup must not require authentication"); },
      version: { service: "data-platform-api", version: "test", commit: "test" },
    } as unknown as Dependencies;
    const app = buildApp(deps);
    t.after(() => app.close());

    for (const url of ["/", "/health/ready"]) {
      calls.length = 0;
      const response = await app.inject({ method: "GET", url });
      assert.equal(response.statusCode, failing ? 503 : 200);
      assert.deepEqual(response.json(), {
        status: failing ? "failing" : "ok",
        ...Object.fromEntries(["database", "cache", "catalog", "queues"].map(
          name => [name, name === failing ? "failing" : "ok"],
        )),
      });
      assert.deepEqual(calls.sort(), ["cache", "catalog", "database", "queues"]);
    }

    assert.equal((await app.inject({ method: "GET", url: "/health/live" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/not-a-route" })).statusCode, 404);
  });
}
