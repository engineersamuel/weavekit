type Request = { params: { id: string }; body: unknown };

export function updateRecord(req: Request) {
  const input = req.body as { title: string };
  if (!req.params.id) return { status: 404, body: { error: "not found" } };
  return { status: 200, body: { id: req.params.id, title: input.title } };
}
