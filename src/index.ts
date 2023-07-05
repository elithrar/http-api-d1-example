import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

const MIN_SECRET_LENGTH = 16;

const schema = z.object({
	name: z.string(),
	age: z.number(),
});

// Bindings to our resources.
type Bindings = {
	// The D1 database we want to expose over HTTP.
	DB: D1Database;
	// The secret our HTTP client needs to pass in to be valid.
	// Must be at least 32 bytes long to ensure sufficiently random.
	//
	// Tip: generate a random secret on the command-line:
	// $ openssl rand -base64 32
	APP_SECRET: string;
};

const PreparedQuery = z.object({
	// We set a reasonable limit on the statement length we'll accept.
	queryText: z.string().min(1).max(1e4).trim(),
	params: z.any().array().optional(),
});

const ExecQuery = z.object({
	// Allow 100,000 (1e6) bytes for exec queries.
	queryText: z.string().min(1).max(1e6).trim(),
});

const BatchQuery = z.object({
	batch: PreparedQuery.array().nonempty(),
});

const ERR_PARAMS_NOT_VALID_ENDPOINT = "query parameters not valid on this endpoint";

interface QueryResponse {
	results?: Array<any>;
	error?: string;
	meta?: Array<any>;
}

interface ExecResponse {
	count: number;
	durationMs: number;
}

const QueryResponse = z.object({
	results: z.any().array().optional(),
	error: z.string().optional(),
	meta: z.any().optional(),
});

export class D1HTTP {
	db: D1Database;
	sharedSecret: string;
	honoInstance: Hono;

	constructor(db: D1Database, sharedSecret: string, honoInstance?: Hono) {
		this.db = db;
		if (sharedSecret.length < MIN_SECRET_LENGTH) {
			throw new Error(`sharedSecret not long enough: must be at least ${MIN_SECRET_LENGTH} bytes long`);
		}

		this.sharedSecret = sharedSecret;
		this.honoInstance = honoInstance !== undefined ? honoInstance : new Hono();
	}

	app() {
		return this.honoInstance;
	}

	run(req: Request, env: Env, ctx: ExecutionContext) {
		return this.honoInstance.fetch(req, env, ctx);
	}
}

export default {
	async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (!env.DB) {
			throw new Error(`A D1 database is not connected to the API. Confirm you have a [[d1_database]] binding called 'DB' created.`);
		}

		// Create a new instance of our D1 HTTP API for a given API and shared shared (for authenticating clients)
		//
		// - `env.DB` is a D1 database configured in either `wrangler.toml` or bound to our Pages application
		// - `env.APP_SECRET` is the secret key we configured as a Wrangler secret - e.g. wrangler secret put APP_SECRET
		const d1API = new D1HTTP(env.DB, env.APP_SECRET);
		const app = d1API.app();
		app.use("*", prettyJSON());
		app.use("*", logger());

		// Hono's route grouping API allows us to separate our `/query/*` routes.
		// Docs: https://hono.dev/api/routing#grouping
		const query = new Hono<{ Bindings: Bindings }>();

		// The Bearer authentication middleware protects all routes in our
		// "query" group and requires an Authorization HTTP header with our
		// token to be provided.
		//
		// This is ideal for connecting a non-Workers backend, such as an
		// existing Node.js app, Go API, or Rust backend, to D1.
		//
		// Important: Clients are presumed to be trusted.
		query.use("*", bearerAuth({ token: d1API.sharedSecret }));

		// A single /all/ endpoint that accepts a single query and (optional)
		// parameters to bind.
		//
		// Returns an array of objects, with each object representing a result
		// row.
		//
		// Docs: https://developers.cloudflare.com/d1/platform/client-api/#await-stmtall-column-
		query.post("/all/", zValidator("json", PreparedQuery), async (c) => {
			let resp: QueryResponse;
			try {
				let query = c.req.valid("json");
				let stmt = c.env.DB.prepare(query.queryText);
				if (query.params) {
					stmt = stmt.bind(...query.params);
				}

				let result = await stmt.all();
				resp = {
					results: result.results,
					meta: result.meta,
				};
			} catch (err) {
				let msg = `failed to run query: ${err}`;
				console.error(msg);
				return c.json({ error: msg }, 500);
			}

			return c.json(resp, 200);
		});

		// Exec a single query, or multiple queries (separated by a newline character).
		// Useful for single-shot queries or batch inserts.
		//
		// Returns the number of queries executed and the duration. Does not
		// return query results.
		//
		// Docs: https://developers.cloudflare.com/d1/platform/client-api/#await-dbexec
		query.post("/exec/", zValidator("json", ExecQuery), async (c) => {
			let resp: ExecResponse;
			try {
				let query = c.req.valid("json");
				let out = await c.env.DB.exec(query.queryText);
				resp = {
					// @ts-expect-error Property 'count' does not exist on type 'D1Result<unknown>'
					// Relates to https://github.com/cloudflare/workerd/pull/762
					count: out?.count || 0,
					// @ts-expect-error Property 'duration' does not exist on type 'D1Result<unknown>'
					// Relates to https://github.com/cloudflare/workerd/pull/762
					durationMs: out?.duration || 0,
				};
			} catch (err) {
				console.error(`failed to exec query: ${err}`);
				return c.json({ error: err }, 500);
			}

			return c.json(resp, 200);
		});

		query.post("/batch/", zValidator("json", BatchQuery), async (c) => {
			let batchResp: Array<QueryResponse> = [];
			try {
				let batch = c.req.valid("json");
				let statements: Array<D1PreparedStatement> = [];
				for (let query of batch.batch) {
					let stmt = c.env.DB.prepare(query.queryText);

					if (query.params) {
						statements.push(stmt.bind(...query.params));
					} else {
						statements.push(stmt);
					}
				}

				console.log(statements);
				let batchResults = await c.env.DB.batch(statements);
				for (let result of batchResults) {
					let queryResp: QueryResponse = {
						results: result.results,
						error: result.error,
						meta: result.meta,
					};
					batchResp.push(queryResp);
				}
			} catch (err) {
				let msg = `failed to batch query: ${err}`;
				console.error(msg);
				return c.json({ error: msg }, 500);
			}

			return c.json(batchResp);
		});

		app.all("/", async (c) => {
			return c.json(app.showRoutes());
		});

		app.route("/query", query);
		return d1API.run(req, env, ctx);
	},
};
