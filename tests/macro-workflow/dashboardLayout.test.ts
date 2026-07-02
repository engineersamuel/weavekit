import { describe, expect, it } from "vitest";
import { layoutWorkflowGraph } from "../../src/macro-workflow/dashboard/layout.js";

describe("layoutWorkflowGraph", () => {
  it("lays out workflow nodes left-to-right with smooth horizontal edges", () => {
    const graph = layoutWorkflowGraph({
      nodes: [
        { id: "a", data: {}, position: { x: 0, y: 0 } },
        { id: "b", data: {}, position: { x: 0, y: 0 } },
        { id: "c", data: {}, position: { x: 0, y: 0 } },
        { id: "d", data: {}, position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: "b-c", source: "b", target: "c" },
        { id: "a-d", source: "a", target: "d" },
      ],
    });

    const byId = new Map(graph.nodes.map((node) => [node.id, node]));

    expect(byId.get("c")!.position.x).toBeGreaterThan(byId.get("b")!.position.x);
    expect(byId.get("d")!.position.x).toBeGreaterThan(byId.get("a")!.position.x);
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "a", sourcePosition: "right", targetPosition: "left" }),
        expect.objectContaining({ id: "c", sourcePosition: "right", targetPosition: "left" }),
      ]),
    );
    expect(graph.edges).toEqual([
      expect.objectContaining({ id: "b-c", type: "smoothstep" }),
      expect.objectContaining({ id: "a-d", type: "smoothstep" }),
    ]);
  });
});
