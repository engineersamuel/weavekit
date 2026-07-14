import { expect, it } from "vitest";
import { updateRecord } from "../src/httpAdapter.js";
import { renderRecord } from "../src/renderer.js";

it("updates and renders a record", () => {
  const response = updateRecord({ params: { id: "record-1" }, body: { title: "Example" } });
  expect(response.status).toBe(200);
  expect(renderRecord(response.body as { id: string; title: string })).toContain("Example");
});
