const form = document.querySelector("#todo-form");
const titleInput = document.querySelector("#todo-title");
const list = document.querySelector("#todo-list");
const status = document.querySelector("#status");

async function loadTodos() {
  const response = await fetch("/api/todos");
  const todos = await response.json();
  list.innerHTML = todos
    .map(
      (todo) => `
        <li data-id="${todo.id}">
          <span>${todo.title}</span>
          <button type="button" data-action="toggle">${todo.completed ? "Reopen" : "Complete"}</button>
          <button type="button" data-action="delete">Delete</button>
        </li>
      `,
    )
    .join("");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const response = await fetch("/api/todos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: titleInput.value }),
  });
  status.textContent = response.ok ? "Todo added." : "Could not add todo.";
  titleInput.value = "";
  await loadTodos();
});

list.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  const item = button?.closest("li");
  if (!button || !item) return;
  const action = button.dataset.action;
  if (action === "delete") {
    await fetch(`/api/todos/${item.dataset.id}`, { method: "DELETE" });
  } else {
    await fetch(`/api/todos/${item.dataset.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: button.textContent === "Complete" }),
    });
  }
  await loadTodos();
});

await loadTodos();
