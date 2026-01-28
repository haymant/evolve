import { parseDocument, isMap, isSeq, isScalar } from "yaml";

export type PlaceIndex = {
  id: string | undefined;
  idLine: number;
  startLine: number;
  endLine: number;
};

const buildLineOffsets = (text: string) => {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
};

const positionAt = (offsets: number[], index: number) => {
  let low = 0;
  let high = offsets.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const start = offsets[mid];
    const next = mid + 1 < offsets.length ? offsets[mid + 1] : Number.MAX_SAFE_INTEGER;
    if (index < start) high = mid - 1;
    else if (index >= next) low = mid + 1;
    else return { line: mid, character: index - start };
  }
  return { line: 0, character: 0 };
};

export const extractPlaceIndex = (text: string): PlaceIndex[] => {
  const doc = parseDocument(text);
  const offsets = buildLineOffsets(text);
  const places: PlaceIndex[] = [];

  const visit = (node: any) => {
    if (isMap(node)) {
      for (const item of node.items) {
        const key = isScalar(item.key) ? String(item.key.value) : undefined;
        if (key === "place" && isSeq(item.value)) {
          for (const entry of item.value.items) {
            if (isMap(entry)) {
              const idItem = entry.items.find((it: any) => isScalar(it.key) && String(it.key.value) === "id");
              const idNode = idItem?.value;
              const idRange = (idNode as any)?.range;
              const entryRange = (entry as any)?.range;
              const idLine = idRange ? positionAt(offsets, idRange[0]).line : (entryRange ? positionAt(offsets, entryRange[0]).line : 0);
              const startLine = entryRange ? positionAt(offsets, entryRange[0]).line : idLine;
              const endLine = entryRange ? positionAt(offsets, entryRange[1]).line : idLine;
              places.push({
                id: idNode && isScalar(idNode) ? String(idNode.value) : undefined,
                idLine,
                startLine,
                endLine
              });
            }
          }
        } else if (item.value) {
          visit(item.value);
        }
      }
    } else if (isSeq(node)) {
      for (const it of node.items) visit(it);
    }
  };

  visit(doc.contents);
  const sorted = [...places].sort((a, b) => a.startLine - b.startLine);
  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i];
    const next = sorted[i + 1];
    const cappedEnd = Math.max(current.startLine, next.startLine - 1);
    current.endLine = Math.min(current.endLine, cappedEnd);
  }
  return places;
};

export const findPlaceForLine = (places: PlaceIndex[], line: number): PlaceIndex | undefined => {
  for (const place of places) {
    if (line >= place.startLine && line <= place.endLine) return place;
  }
  const before = places
    .filter((p) => p.startLine <= line)
    .sort((a, b) => b.startLine - a.startLine);
  return before[0];
};