import { expect, it } from "vitest";
import { greeting } from "../src/index.js";

it("greets by name", () => expect(greeting("Ada")).toBe("Hello Ada"));
