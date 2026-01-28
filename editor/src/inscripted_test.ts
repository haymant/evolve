import { extractInscriptions, updateInscriptionText } from "./inscripted";

const sample = `nets:
  - id: net1
    pages:
      - id: page1
        transitions:
          - id: t1
            evolve:
              inscriptions:
                - id: in1
                  language: python
                  kind: guard
                  source: inline
                  code: "lambda d: d['id'] > 0"
                - id: in2
                  language: rust
                  kind: expression
                  source: inline
                  code: "|d| d.id + 1"
`;

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const ins = extractInscriptions(sample);
assert(ins.length === 2, `expected 2 inscriptions, got ${ins.length}`);
assert(ins[0].language === 'python', 'first inscription language should be python');
assert(ins[1].language === 'rust', 'second inscription language should be rust');
assert(!!ins[0].code && ins[0].code.includes('lambda'), 'first inscription should contain lambda');

const updated = updateInscriptionText(sample, 0, "lambda d: d['id'] >= 0");
const updatedIns = extractInscriptions(updated);
assert(updatedIns[0].code === "lambda d: d['id'] >= 0", 'updated code should be reflected');

console.log('InscriptEd unit tests: OK');
