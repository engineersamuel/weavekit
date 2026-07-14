import express from "express";
import { todos } from "./store.js";

const app = express();
app.use(express.json());
app.use(express.static("public"));

app.get("/api/todos", (_req, res) => {
  res.json(todos);
});

app.post("/api/todos", (req, res) => {
  if (!req.body.title) {
    res.status(400).json({ error: "title required" });
    return;
  }
  const todo = {
    id: String(Date.now()),
    title: req.body.title,
    completed: false,
  };
  todos.push(todo);
  res.status(201).json(todo);
});

app.patch("/api/todos/:id", (req, res) => {
  const todo = todos.find((candidate) => candidate.id === req.params.id);
  if (!todo) {
    res.status(404).json({ ok: false });
    return;
  }
  todo.completed = Boolean(req.body.completed);
  res.json(todo);
});

app.delete("/api/todos/:id", (req, res) => {
  const index = todos.findIndex((candidate) => candidate.id === req.params.id);
  if (index < 0) {
    res.status(404).json({ error: "missing" });
    return;
  }
  todos.splice(index, 1);
  res.status(204).end();
});

app.listen(3000, () => {
  console.log("Todo app listening on http://localhost:3000");
});
