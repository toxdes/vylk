// Moves the AI context onto note text changed elsewhere, such as an edit synced
// from another device. Offsets count UTF-16 code units, like textarea ranges.

const lowSurrogate = (text, index) => /[\udc00-\udfff]/.test(text[index] || '');

// The one span where two texts differ: before[start, oldEnd) became
// after[start, newEnd). Never splits a surrogate pair.
export function changedSpan(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  if (start > 0 && (lowSurrogate(before, start) || lowSurrogate(after, start))) start--;
  let suffix = 0;
  while (
    suffix < before.length - start &&
    suffix < after.length - start &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;
  if (
    suffix > 0 &&
    (lowSurrogate(before, before.length - suffix) || lowSurrogate(after, after.length - suffix))
  )
    suffix--;
  return {start, oldEnd: before.length - suffix, newEnd: after.length - suffix};
}

// Offsets inside the change move to its start, or to its new end for the end
// of a range, so a selection around the change keeps covering it.
export function mapOffset(offset, change, {end = false} = {}) {
  if (offset <= change.start) return offset;
  if (offset >= change.oldEnd) return offset + change.newEnd - change.oldEnd;
  return end ? change.newEnd : change.start;
}

// Three-way merge of two edits to base. Each side collapses to one span, so
// edits that touch the same text, or interleave, return null.
export function mergeEdits(base, ours, theirs) {
  const mine = changedSpan(base, ours);
  const other = changedSpan(base, theirs);
  if (ours === base) return theirs;
  if (theirs === base || theirs === ours) return ours;
  const order =
    mine.oldEnd <= other.start
      ? [mine, ours, other, theirs]
      : other.oldEnd <= mine.start
        ? [other, theirs, mine, ours]
        : null;
  if (!order) return null;
  const [first, firstText, second, secondText] = order;
  return (
    base.slice(0, first.start) +
    firstText.slice(first.start, first.newEnd) +
    base.slice(first.oldEnd, second.start) +
    secondText.slice(second.start, second.newEnd) +
    base.slice(second.oldEnd)
  );
}
