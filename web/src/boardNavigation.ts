/**
 * The board view's walk through its cards, shared by its modes (the
 * reviews inbox, the Work board): j / k through the rows as drawn, staying
 * in the column on a wide pane; h / l (Tab) to the column beside, at the
 * same height. Keys name the cards; null when nothing is drawn.
 */

function clamp(at: number, length: number): number {
  return Math.min(length - 1, Math.max(0, at));
}

/**
 * The row `step` away from the selected one: in its column when the pane
 * shows columns (and it is in one), else through every row as drawn. With
 * nothing selected, a count from the start (3j: the third) or the end.
 */
export function nextRow(
  columns: readonly (readonly string[])[] | null,
  ordered: readonly string[],
  selected: string | null,
  step: number,
): string | null {
  if (!ordered.length) return null;
  const column =
    selected === null
      ? undefined
      : columns?.find((rows) => rows.includes(selected));
  if (column)
    return column[clamp(column.indexOf(selected!) + step, column.length)]!;
  const at = selected === null ? -1 : ordered.indexOf(selected);
  const next =
    at < 0
      ? step > 0
        ? Math.min(ordered.length - 1, step - 1)
        : Math.max(0, ordered.length + step)
      : clamp(at + step, ordered.length);
  return ordered[next]!;
}

/**
 * The row at the same height in the column `step` away (skipping empty
 * columns); the first or last column's with nothing selected. Null when
 * there is no column to go to.
 */
export function nextColumn(
  columns: readonly (readonly string[])[],
  selected: string | null,
  step: number,
): string | null {
  if (!columns.length) return null;
  const at =
    selected === null
      ? -1
      : columns.findIndex((rows) => rows.includes(selected));
  const row = at < 0 ? 0 : columns[at]!.findIndex((key) => key === selected);
  for (
    let next = at < 0 ? (step > 0 ? 0 : columns.length - 1) : at + step;
    next >= 0 && next < columns.length;
    next += step
  ) {
    const rows = columns[next]!;
    if (!rows.length) continue;
    return rows[Math.min(row, rows.length - 1)]!;
  }
  return null;
}
