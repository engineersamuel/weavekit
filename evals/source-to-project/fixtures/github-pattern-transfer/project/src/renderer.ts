export function renderRecord(record: { id: string; title: string }): string {
  return `<article data-id="${record.id}"><h2>${record.title}</h2></article>`;
}
