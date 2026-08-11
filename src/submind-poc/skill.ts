export function submindSkill(helperCommand: string): string {
  return `---
name: submind-poc
description: Use when orchestrating the durable submind proof-of-concept run assigned in this worktree.
---

# Durable Submind POC

Control Herdr only through this scoped helper:

\`${helperCommand} --operation <operation> --input '<json>'\`

Never call Herdr CLI or socket directly. Never inspect or mutate unrelated workspaces, panes, or agents.

Use bounded sequence: snapshot, create four worker tabs, launch one worker in each tab, verify detection, rename, prompt concurrently, wait, read, answer, wait, read acknowledgement, complete. Helper automatically appends intent and receipt records for every operation. Use \`event\` only for extra reasoning milestones; never claim helper-generated receipts. Stop and complete with failed outcome on wrong agent kind, unknown agent, exited pane, timeout, or malformed response.

Every helper call accepts JSON and returns JSON. Inputs:

- \`snapshot\`: \`{}\`
- \`tab\`: \`{"label":"Copilot worker"}\`; returns both \`createdTabId\` and its root \`createdPaneId\`
- \`split\`: \`{"paneId":"...","direction":"right"}\`
- \`launch\`: \`{"paneId":"...","name":"...","kind":"copilot","command":"copilot","args":["--autopilot","--allow-all","--no-ask-user"]}\`
- interactive launch: same shape with \`"interactive":true\`; omit \`kind\` for aliases
- \`rename\`: \`{"agentId":"...","name":"..."}\`
- \`plan\`: \`{"agentId":"..."}\`; switches the scoped Codex worker to Plan mode so native \`request_user_input\` is available
- \`prompt\`: \`{"agentId":"...","prompt":"..."}\`
- \`submit\`: \`{"agentId":"..."}\`; press Enter only when a run-owned agent visibly has pending input that \`agent.prompt\` did not submit
- \`wait\`: \`{"agentId":"...","states":["idle","blocked","done"],"timeoutMs":120000}\`
- \`read\`: \`{"agentId":"...","lines":120}\`
- \`event\`: \`{"type":"receipt","data":{"operation":"...","paneId":"...","agentId":"..."}}\`
- \`complete\`: full final manifest JSON

Workers:

- Copilot: interactive \`copilot --autopilot --allow-all --no-ask-user\`; prompt it: "Do not inspect or modify files. Ask me what my favorite color is, then wait for my answer and acknowledge it."
- Grok: \`grx superpowers --permission-mode bypassPermissions\`; prompt it: "Do not inspect or modify files. Ask me what my favorite movie is, then wait for my answer and acknowledge it."
- Codex: interactive \`codx\`; prompt it: "Do not inspect or modify files. Use your native request_user_input (ask-user) tool, not a prose question, to ask which book is my favorite. Offer exactly these choices: The Left Hand of Darkness, Kindred, and A Wizard of Earthsea. Wait for my selection, then acknowledge it."
- Claude Council: interactive \`trellage --profile claude-council\`; prompt it: "Do not inspect or modify files. Ask me what my favorite programming language is, then wait for my answer and acknowledge it."

Use these exact canonical worker names at launch and in the manifest: \`<agentPrefix>copilot\`, \`<agentPrefix>grok\`, \`<agentPrefix>codex\`, and \`<agentPrefix>claude-council\`. Do not use temporary \`-launch\` or \`-worker\` suffixes. Tab labels may add descriptive suffixes. Start every worker through interactive pane input, wait for agent detection, verify expected kind, then rename them to the same canonical names supplied at launch. Call \`plan\` once for Codex and wait for it to settle before sending question instructions concurrently. Read each worker's question. For Codex, require state \`blocked\` and confirm the read output shows the native multiple-choice request before answering. Choose answers yourself; do not ask user. Send each answer through \`prompt\`, then capture acknowledgement through \`wait\` and \`read\`.

Require \`interactiveReady\` only for Copilot. Herdr 0.8 may leave it false for usable Grok, Codex, and Claude TUIs; correct detected kind plus a live idle/done state is sufficient for those aliases.

Do no more than 40 snapshot/read checks per transition and use helper wait up to 120000ms. Launch and prompt each participant only once. If unsure whether mutation happened, snapshot and adopt matching run-prefixed resource; never repeat blindly.

Success exists only after \`complete\` accepts manifest containing exact run/worktree identity, orchestrator IDs, all worker commands, pane and agent IDs, four questions, chosen answers, acknowledgements, timestamps, and \`completed\` outcome. Agent lifecycle state alone is never success. Leave all panes, agents, and worktree open.

Manifest object shape:

\`{"schemaVersion":1,"runId":"...","outcome":"completed","sourceRepositoryPath":"...","worktreePath":"...","branchName":"...","workspaceId":"...","orchestrator":{"paneId":"...","agentId":"...","name":"..."},"workers":[...],"startedAt":"ISO-8601","completedAt":"ISO-8601"}\`

Each worker object: \`{"kind":"copilot|grok|codex|claude","command":"exact launch command","paneId":"...","agentId":"...","name":"...","question":"...","answer":"...","acknowledgement":"...","launchedAt":"ISO-8601","answeredAt":"ISO-8601","acknowledgedAt":"ISO-8601"}\`. Use exactly one worker of each kind. For failure, use \`"outcome":"failed"\`, add nonempty \`"failure"\`, and include only fully observed worker records.
`;
}
