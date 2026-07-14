# Building a Safe Todo Mutation Path

A small CRUD application does not need a large architecture, but every mutation
still crosses trust boundaries. The most reliable improvement is a thin,
end-to-end slice that makes input, domain behavior, errors, browser rendering,
and proof agree.

## Validate at every HTTP boundary

Treat request bodies and route parameters as untrusted. Parse them with explicit
schemas before domain code runs. A create request should trim its title, require
at least one non-whitespace character, enforce a reasonable maximum length, and
reject fields the API does not support. An update request must require a real
boolean rather than coercing arbitrary values. Invalid input should stop at the
adapter and return a structured `400` response.

## Keep transport code thin

Express route handlers should translate HTTP input and output, not own todo
rules or storage mutations. Put create, completion update, delete, and
not-found behavior in a focused todo service. Let that service depend on a small
repository contract. An in-memory repository is a valid first adapter and makes
the service easy to test; this guidance does not require a production database.

## Use one stable error contract

Clients should not need to understand a different JSON shape for each failure.
Use one response contract with a machine-readable code and a human-readable
message. Map validation failures to `400`, missing todos to `404`, and
unexpected failures to `500` in centralized Express error middleware. Do not
return stack traces or raw internal exception messages.

## Render persisted text as text

API data remains untrusted when it reaches the browser. Never interpolate
persisted user text into `innerHTML`. Build list items and buttons with
`document.createElement`, assign titles through `textContent`, and attach
behavior with `addEventListener`. This preserves the UI while preventing a todo
title from becoming executable markup.

## Test the vertical slice

Test the service rules directly with an in-memory repository. Add HTTP
integration checks for valid creates, invalid bodies, boolean updates, deletes,
and missing ids. Add a browser or DOM-focused regression test that renders a
title containing HTML-like text and proves it remains text. Keep type checking
and the focused test command in the project's normal validation scripts.

## Scope boundary

Do not replace the web framework, add authentication, introduce a production
database, or redesign deployment as part of this improvement. The goal is one
cohesive, verifiable mutation path using the application's existing stack.
