import { describe, expect, it } from "vitest";
import {
  OBJECTIVE_PREVIEW_LENGTH,
  getObjectivePreview,
  shouldShowObjectiveExpansion,
} from "../../src/macro-workflow/dashboard/objective.js";

describe("workflow dashboard objective presentation", () => {
  it("keeps short objectives unchanged", () => {
    const objective = "Improve the dashboard run picker.";

    expect(getObjectivePreview(objective)).toBe(objective);
    expect(shouldShowObjectiveExpansion(objective)).toBe(false);
  });

  it("bounds long objectives and exposes expansion", () => {
    const objective = "x".repeat(OBJECTIVE_PREVIEW_LENGTH + 20);

    expect(getObjectivePreview(objective)).toHaveLength(OBJECTIVE_PREVIEW_LENGTH);
    expect(getObjectivePreview(objective)).toMatch(/\.\.\.$/);
    expect(shouldShowObjectiveExpansion(objective)).toBe(true);
  });
});
