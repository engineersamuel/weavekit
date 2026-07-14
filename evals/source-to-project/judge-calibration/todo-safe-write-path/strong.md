# Strong plan

## Problem and outcome

`src/server.ts` currently mixes HTTP translation with todo mutation rules, trusts untyped request bodies, coerces `completed` with `Boolean()`, accepts arbitrary route identifiers, and emits inconsistent errors. `src/store.ts` exposes its mutable array directly. `public/app.js` interpolates persisted titles through `innerHTML`, allowing stored markup to become executable DOM. The project has no automated service, HTTP, or browser-boundary checks.

Implement one bounded vertical slice that preserves Express, the browser client, `/api/todos` routes, success status codes, and in-memory persistence while making create, update, delete, and rendering safe and testable.

## Ordered implementation

1. Add `src/todoRepository.ts` with a `TodoRepository` contract and `InMemoryTodoRepository` adapter around the existing array. Stop importing the array from HTTP handlers.
2. Add `src/todoService.ts`. Move ID creation, create, completion update, delete, and not-found behavior into `TodoService`, injected with the repository. The service has no Express request or response dependency.
3. Add `src/validation.ts` with explicit parsers for create bodies, update bodies, and route IDs. Create accepts only `{ title }`, requires a string, trims it, rejects empty/whitespace-only and overlong values, and rejects unknown fields. Update accepts only `{ completed }` and requires a real boolean, so `"false"`, `0`, `null`, and missing values return 400. Route IDs must match the digit-string format produced by the app; malformed IDs return 400 while a well-formed missing ID reaches the service and returns 404.
4. Add typed validation and not-found errors plus final Express error middleware. Return one stable `{ code, message }` JSON shape: validation and malformed JSON map to 400, missing todos to 404, and unexpected exceptions to a generic 500 without internal messages or stacks.
5. Refactor `src/server.ts` into thin adapters: parse transport input, call the service, translate the successful result, and forward failures to middleware. Preserve GET/POST `/api/todos`, PATCH/DELETE `/api/todos/:id`, and existing success status codes.
6. Replace `public/app.js` title interpolation with `createElement`, `textContent`, `replaceChildren`, and `addEventListener`. Preserve todo IDs, completion state, Complete/Reopen labels, delete behavior, and semantic buttons.
7. Add stable `test` and `typecheck` package scripts.

## Verification

- Service unit tests cover create, completion update, delete, and not-found behavior with an isolated repository.
- Validation unit tests enumerate missing, wrong-type, empty, whitespace-only, boundary-length, overlong, unknown-field, unsafe-coercion, malformed-ID, and valid inputs.
- HTTP integration tests repeat every applicable invalid case at the real Express boundary, including `{ completed: "false" }`, malformed JSON, malformed ID returning 400, and well-formed missing ID returning 404. They also cover valid create/update/delete behavior and the stable error contract.
- DOM tests render `<img onerror=...>`, `<script>`, and ordinary markup-like titles as literal text with no created executable elements. They also prove completion/delete controls, labels, IDs, order, and repeated rendering still work.
- Run the project-owned typecheck and test scripts, then manually confirm create, complete/reopen, delete, and literal markup rendering through the unchanged UI.

Out of scope: authentication, production persistence, queues, deployment infrastructure, unrelated product features, or framework replacement.
