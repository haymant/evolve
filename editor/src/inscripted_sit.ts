import { extractInscriptions, updateInscriptionText, buildInscriptionUri, getInscriptionLangExt } from "./inscripted";

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

// SIT-1: Open inscription in native editor (simulated by URI construction)
const ins = extractInscriptions(sample);
const uri = buildInscriptionUri("file:///tmp/sample.evolve.yaml", ins[0].index, ins[0].language);
assert(uri.startsWith("evolve-inscription://"), "SIT-1: URI scheme should be evolve-inscription");
const { ext } = getInscriptionLangExt(ins[0].language);
assert(uri.includes(`.${ext}`), "SIT-1: URI should include language extension");
console.log("SIT-1: OK (virtual inscription URI)");

// SIT-2: Round-trip edits
const updated = updateInscriptionText(sample, 0, "lambda d: d['id'] >= 0");
const updatedIns = extractInscriptions(updated);
assert(updatedIns[0].code === "lambda d: d['id'] >= 0", "SIT-2: YAML update failed");
console.log("SIT-2: OK (round-trip update)");

// SIT-3: Debug hooks (future) - simulated by checking mapping inputs exist
assert(updatedIns[0].language === "python", "SIT-3: language mapping should remain intact");
console.log("SIT-3: OK (language mapping ready for DAP integration)");
