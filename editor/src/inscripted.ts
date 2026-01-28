import { parseDocument, isMap, isSeq, isScalar, Pair } from "yaml";

export type InscriptionInfo = {
  index: number;
  id?: string;
  language?: string;
  source?: string;
  code?: string;
  range?: { start: number; end: number };
};

export const extractInscriptions = (text: string): InscriptionInfo[] => {
  const doc = parseDocument(text);
  const inscriptions: InscriptionInfo[] = [];
  let index = 0;

  const visit = (node: any) => {
    if (isMap(node)) {
      for (const item of node.items) {
        const key = isScalar(item.key) ? String(item.key.value) : undefined;
        if (key === 'inscriptions' && isSeq(item.value)) {
          const seq = item.value;
          for (const entry of seq.items) {
            if (isMap(entry)) {
              const getVal = (k: string) => {
                const found = entry.items.find((it: any) => isScalar(it.key) && String(it.key.value) === k);
                return found ? found.value : undefined;
              };
              const idNode = getVal('id');
              const langNode = getVal('language');
              const sourceNode = getVal('source');
              const codeNode = getVal('code');
              const codeRange = (codeNode as any)?.range;
              const entryRange = (entry as any)?.range;
              const range = codeRange ? { start: codeRange[0], end: codeRange[1] } : (entryRange ? { start: entryRange[0], end: entryRange[1] } : undefined);
              inscriptions.push({
                index: index++,
                id: idNode && isScalar(idNode) ? String(idNode.value) : undefined,
                language: langNode && isScalar(langNode) ? String(langNode.value) : undefined,
                source: sourceNode && isScalar(sourceNode) ? String(sourceNode.value) : undefined,
                code: codeNode && isScalar(codeNode) ? String(codeNode.value) : undefined,
                range
              });
            }
          }
        } else {
          if (item.value) visit(item.value);
        }
      }
    } else if (isSeq(node)) {
      for (const it of node.items) visit(it);
    }
  };

  visit(doc.contents);
  return inscriptions;
};

export const updateInscriptionText = (text: string, targetIndex: number, newCode: string): string => {
  const doc = parseDocument(text);
  let current = 0;
  const visit = (node: any) => {
    if (isMap(node)) {
      for (const item of node.items) {
        const key = isScalar(item.key) ? String(item.key.value) : undefined;
        if (key === 'inscriptions' && isSeq(item.value)) {
          for (const entry of item.value.items) {
            if (isMap(entry)) {
              if (current === targetIndex) {
                const codeItem = entry.items.find((it: any) => isScalar(it.key) && String(it.key.value) === 'code');
                if (codeItem) {
                  codeItem.value = newCode;
                } else {
                  entry.items.push(new Pair('code', newCode));
                }
                return true;
              }
              current++;
            }
          }
        } else {
          if (item.value && visit(item.value)) return true;
        }
      }
    } else if (isSeq(node)) {
      for (const it of node.items) if (visit(it)) return true;
    }
    return false;
  };
  visit(doc.contents);
  return String(doc);
};

export const getInscriptionLangExt = (lang?: string) => {
  switch ((lang || '').toLowerCase()) {
    case 'python':
      return { ext: 'py', id: 'python' };
    case 'typescript':
      return { ext: 'ts', id: 'typescript' };
    case 'rust':
      return { ext: 'rs', id: 'rust' };
    default:
      return { ext: 'txt', id: 'plaintext' };
  }
};

export const buildInscriptionUri = (sourceUri: string, index: number, lang?: string) => {
  const { ext } = getInscriptionLangExt(lang);
  return `evolve-inscription://inscription/${index}.${ext}?source=${encodeURIComponent(sourceUri)}&index=${index}&lang=${encodeURIComponent(lang || '')}`;
};