"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildInscriptionUri = exports.getInscriptionLangExt = exports.updateInscriptionText = exports.extractInscriptions = void 0;
const yaml_1 = require("yaml");
const extractInscriptions = (text) => {
    const doc = (0, yaml_1.parseDocument)(text);
    const inscriptions = [];
    let index = 0;
    const visit = (node) => {
        if ((0, yaml_1.isMap)(node)) {
            for (const item of node.items) {
                const key = (0, yaml_1.isScalar)(item.key) ? String(item.key.value) : undefined;
                if (key === 'inscriptions' && (0, yaml_1.isSeq)(item.value)) {
                    const seq = item.value;
                    for (const entry of seq.items) {
                        if ((0, yaml_1.isMap)(entry)) {
                            const getVal = (k) => {
                                const found = entry.items.find((it) => (0, yaml_1.isScalar)(it.key) && String(it.key.value) === k);
                                return found ? found.value : undefined;
                            };
                            const idNode = getVal('id');
                            const langNode = getVal('language');
                            const sourceNode = getVal('source');
                            const codeNode = getVal('code');
                            const codeRange = codeNode?.range;
                            const entryRange = entry?.range;
                            const range = codeRange ? { start: codeRange[0], end: codeRange[1] } : (entryRange ? { start: entryRange[0], end: entryRange[1] } : undefined);
                            inscriptions.push({
                                index: index++,
                                id: idNode && (0, yaml_1.isScalar)(idNode) ? String(idNode.value) : undefined,
                                language: langNode && (0, yaml_1.isScalar)(langNode) ? String(langNode.value) : undefined,
                                source: sourceNode && (0, yaml_1.isScalar)(sourceNode) ? String(sourceNode.value) : undefined,
                                code: codeNode && (0, yaml_1.isScalar)(codeNode) ? String(codeNode.value) : undefined,
                                range
                            });
                        }
                    }
                }
                else {
                    if (item.value)
                        visit(item.value);
                }
            }
        }
        else if ((0, yaml_1.isSeq)(node)) {
            for (const it of node.items)
                visit(it);
        }
    };
    visit(doc.contents);
    return inscriptions;
};
exports.extractInscriptions = extractInscriptions;
const updateInscriptionText = (text, targetIndex, newCode) => {
    const doc = (0, yaml_1.parseDocument)(text);
    let current = 0;
    const visit = (node) => {
        if ((0, yaml_1.isMap)(node)) {
            for (const item of node.items) {
                const key = (0, yaml_1.isScalar)(item.key) ? String(item.key.value) : undefined;
                if (key === 'inscriptions' && (0, yaml_1.isSeq)(item.value)) {
                    for (const entry of item.value.items) {
                        if ((0, yaml_1.isMap)(entry)) {
                            if (current === targetIndex) {
                                const codeItem = entry.items.find((it) => (0, yaml_1.isScalar)(it.key) && String(it.key.value) === 'code');
                                if (codeItem) {
                                    codeItem.value = newCode;
                                }
                                else {
                                    entry.items.push(new yaml_1.Pair('code', newCode));
                                }
                                return true;
                            }
                            current++;
                        }
                    }
                }
                else {
                    if (item.value && visit(item.value))
                        return true;
                }
            }
        }
        else if ((0, yaml_1.isSeq)(node)) {
            for (const it of node.items)
                if (visit(it))
                    return true;
        }
        return false;
    };
    visit(doc.contents);
    return String(doc);
};
exports.updateInscriptionText = updateInscriptionText;
const getInscriptionLangExt = (lang) => {
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
exports.getInscriptionLangExt = getInscriptionLangExt;
const buildInscriptionUri = (sourceUri, index, lang) => {
    const { ext } = (0, exports.getInscriptionLangExt)(lang);
    return `evolve-inscription://inscription/${index}.${ext}?source=${encodeURIComponent(sourceUri)}&index=${index}&lang=${encodeURIComponent(lang || '')}`;
};
exports.buildInscriptionUri = buildInscriptionUri;
//# sourceMappingURL=inscripted.js.map