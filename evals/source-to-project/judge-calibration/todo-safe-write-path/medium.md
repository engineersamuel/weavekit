# Medium plan

The current `src/server.ts` trusts request bodies and returns inconsistent errors. Add `src/validation.ts` with reusable create and update parsers. Trim titles, reject empty titles and non-boolean `completed` values, and call these parsers from the existing `/api/todos` POST and PATCH handlers.

Add centralized Express error middleware returning `{ code, message }`. Validation failures return 400, missing todos return 404, and unexpected failures return a generic 500 without stack details. Preserve Express, the in-memory array, current routes, and success responses.

Add HTTP integration tests for valid create/update/delete requests, empty titles, wrong types, and missing todos. Add `test` and `typecheck` package scripts and document the validation commands.

Do not introduce authentication, a database, queues, deployment changes, or a framework replacement.
