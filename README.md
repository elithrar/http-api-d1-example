# Demo: Access Cloudflare D1 over HTTP

**Note**: 🧪 This is a example application and is not officially supported by Cloudflare.

D1 (https://developers.cloudflare.com/d1/) currently requires you to query it via a Cloudflare Worker, but since Workers allow you to create your own HTTP endpoints directly, it's easy to stand up a custom HTTP API in front of D1.

A HTTP API is useful for connecting to D1 from existing legacy applications (Node.js, Go, AWS Lambda); building adapters for existing web frameworks (Rails or Django); and/or otherwise querying your D1 databases from non-Workers clients.

This API is designed to be used by _trusted_ clients: it assumes that the client connecting over HTTP can query any table and/or issue any query against the database the API exposes. This is ideal for connecting your own applications. Connecting untrusted clients is out of scope of this example.

## Get started

To deploy this HTTP API in front of your D1 database:

1. Create a D1 database: https://developers.cloudflare.com/d1/get-started/
2. Clone the repo: `git clone https://github.com/elithrar/http-api-d1.git`
3. Install the dependencies: `npm i`
4. Create a key via `openssl rand -base64 32` and `wrangler secret put APP_SECRET`
5. Update `wrangler.toml` to include the binding for your `[[d1_databases]]` and add your `account_id` (or simply remove the placeholder)
6. Deploy it via `wrangler deploy`
7. Access the API over HTTP at the URL you deployed it to - e.g. `https://http-api-d1.<your-worker-subdomain>.workers.dev/query/all/`

```sh
$ export D1_HTTP_TOKEN=tokenfromstep2above
$ curl -H "Authorization: Bearer ${D1_HTTP_TOKEN}" "https://http-api-d1.<your-worker-subdomain>.workers.dev/query/all/" --data '{"queryText": "SELECT 1"}'
```
```json
// Returns results resembling the below:
{"results":[{"1":1}],"meta":{"duration":0.12522200029343367,"changes":0,"last_row_id":0,"changed_db":false,"size_after":167936}}%
```
## Endpoints

This example exposes three (3) endpoints to a client.

`/query/all/` - identical to D1's [`stmt.all()`](https://developers.cloudflare.com/d1/platform/client-api/#await-stmtall-column-) method and returns an array of rows.

```json
{"queryText": "SELECT * FROM users WHERE id = ?", "params": "3819848"}
```

`/query/batch/` - identical to D1's [`db.batch()`](https://developers.cloudflare.com/d1/platform/client-api/#dbbatch) method, and accepts an array of queries and (optional) bound parameters.

```json
{"batch":[{"queryText": "SELECT * FROM [Order] ORDER BY random() LIMIT 1"},{"queryText": "SELECT * FROM [Order] ORDER BY random() LIMIT 1"}]}
```

`/query/exec` - identical to D1's [`db.exec()`](https://developers.cloudflare.com/d1/platform/client-api/#await-dbexec) method, and accepts a single-shot query.

```json
{"queryText": "INSERT INTO users VALUES(12313,'user@example.com')}
```

## Built with

The HTTP API is built with [Hono](https://hono.dev/), an ultrafast web framework with native support for [Cloudflare Workers](https://developers.cloudflare.com/workers/) and [Zod](https://zod.dev/) for schema validation.

## License

Copyright Cloudflare, Inc (2023). Apache-2.0 licensed. See the LICENSE file for details.
