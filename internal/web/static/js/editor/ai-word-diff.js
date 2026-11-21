// Highlighting is presentation only. Never use these ranges to apply edits.
// A shared budget bounds quadratic work across the entire review, not per row.
export function changedRanges(before, after, budget) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  const low = (value, offset) =>
    offset < value.length &&
    value.charCodeAt(offset) >= 0xdc00 &&
    value.charCodeAt(offset) <= 0xdfff;
  if (start && (low(before, start) || low(after, start))) start--;
  let leftEnd = before.length,
    rightEnd = after.length;
  while (leftEnd > start && rightEnd > start && before[leftEnd - 1] === after[rightEnd - 1]) {
    leftEnd--;
    rightEnd--;
  }
  if (low(before, leftEnd) || low(after, rightEnd)) {
    leftEnd++;
    rightEnd++;
  }
  const fallback = {
    before: leftEnd > start ? [[start, leftEnd]] : [],
    after: rightEnd > start ? [[start, rightEnd]] : [],
  };
  if (
    !fallback.before.length ||
    !fallback.after.length ||
    leftEnd - start > 16384 ||
    rightEnd - start > 16384 ||
    budget.cells <= 0 ||
    budget.marks <= 0
  )
    return fallback;
  const tokenize = (value, end) => {
    const tokens = [];
    for (const match of value.slice(start, end).matchAll(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu)) {
      if (tokens.length >= 512) return null;
      tokens.push({
        value: match[0],
        start: start + match.index,
        end: start + match.index + match[0].length,
      });
    }
    return tokens;
  };
  const left = tokenize(before, leftEnd),
    right = tokenize(after, rightEnd);
  if (!left || !right) return fallback;
  const width = right.length + 1,
    cells = (left.length + 1) * width;
  if (cells > Math.min(65536, budget.cells)) return fallback;
  budget.cells -= cells;
  const table = new Uint16Array(cells);
  for (let i = left.length - 1; i >= 0; i--)
    for (let j = right.length - 1; j >= 0; j--)
      table[i * width + j] =
        left[i].value === right[j].value
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  const result = {before: [], after: []};
  const add = (ranges, token) => {
    const last = ranges.at(-1);
    if (last && last[1] === token.start) last[1] = token.end;
    else ranges.push([token.start, token.end]);
  };
  let i = 0,
    j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i].value === right[j].value) {
      i++;
      j++;
    } else if (
      j < right.length &&
      (i === left.length || table[i * width + j + 1] > table[(i + 1) * width + j])
    )
      add(result.after, right[j++]);
    else add(result.before, left[i++]);
  }
  const marks = result.before.length + result.after.length;
  if (marks > budget.marks) return fallback;
  budget.marks -= marks;
  return result;
}
