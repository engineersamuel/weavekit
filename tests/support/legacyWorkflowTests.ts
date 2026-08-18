import { it } from "vitest";

export const RUN_LEGACY_WORKFLOW_TESTS = process.env.WEAVEKIT_RUN_LEGACY_WORKFLOW_TESTS === "1";

export const legacyTest = RUN_LEGACY_WORKFLOW_TESTS ? it : it.skip;
