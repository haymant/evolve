Read [](file:///home/data/git/haymant/pagent/schema/pnml.schema#1-1), lines 1 to 400

Read [](file:///home/data/git/haymant/pagent/schema/pnml.schema#400-400), lines 400 to 647

Checklist (RNG → JSON Schema) after re-review:

- `pnml.element` → $defs/pnml (oneOrMore net → `net` array minItems=1). Aligned. See [pagent/schema/pnml.rng](pagent/schema/pnml.rng) and [pagent/schema/pnml.schema](pagent/schema/pnml.schema).
- `net.element` → $defs/net (`@id`, `@type` required; optional `name`, `toolspecific`; `page` array minItems=1; `net.labels` empty). Aligned. See pagent/schema/pnml.rng and pagent/schema/pnml.schema.
- `page.content` → $defs/page (`@id` required; optional `name`, `toolspecific`, `graphics`; zeroOrMore netobject mapped to arrays). Aligned; `toolspecific` now optional. See [pagent/schema/pnml.rng](pagent/schema/pnml.rng) and [pagent/schema/pnml.schema](pagent/schema/pnml.schema).
- `place.content` → $defs/place (optional `name`, `toolspecific`, `graphics`; `@id` required). Aligned. See pagent/schema/pnml.rng and pagent/schema/pnml.schema.
- `transition.content` → $defs/transition (same as `place`). Aligned. See [pagent/schema/pnml.rng](pagent/schema/pnml.rng) and [pagent/schema/pnml.schema](pagent/schema/pnml.schema).
- `refplace.content`/`reftrans.content` → $defs/referencePlace/$defs/referenceTransition (`@id`, `@ref` required; optional `name`, `toolspecific`, `graphics`). Aligned. See pagent/schema/pnml.rng and pagent/schema/pnml.schema.
- `arc.content` → $defs/arc (`@id`, `@source`, `@target` required; optional `name`, `graphics`, `toolspecific`; `arc.labels` empty). Aligned. See [pagent/schema/pnml.rng](pagent/schema/pnml.rng) and [pagent/schema/pnml.schema](pagent/schema/pnml.schema).
- `nodegraphics.content` → $defs/nodeGraphics (required `position`; optional `dimension`, `fill`, `line`). Aligned. See pagent/schema/pnml.rng and pagent/schema/pnml.schema.
- `edgegraphics.content` → $defs/edgeGraphics (zeroOrMore `position` → optional array; optional `line`). Aligned. See [pagent/schema/pnml.rng](pagent/schema/pnml.rng) and [pagent/schema/pnml.schema](pagent/schema/pnml.schema).
- `Name`/`simpletextlabel.content` → $defs/nameLabel (optional `text`, optional `graphics`, zeroOrMore `toolspecific` → optional array). Aligned. See pagent/schema/pnml.rng and pagent/schema/pnml.schema.
- `annotationgraphics.content` → $defs/annotationGraphics (required `offset`; optional `fill`, `line`, `font`). Aligned. See [pagent/schema/pnml.rng](pagent/schema/pnml.rng) and [pagent/schema/pnml.schema](pagent/schema/pnml.schema).
- `position.element`/`offset.element`/`dimension.element`/`positiveDecimal.content` → $defs/position/$defs/offset/$defs/dimension/$defs/positiveDecimal. Aligned. See pagent/schema/pnml.rng and pagent/schema/pnml.schema.
- `fill.element`/`line.element`/`font.element`/`color.type`/`toolspecific.element`/`anyElement` → corresponding $defs. Aligned. See pagent/schema/pnml.rng and pagent/schema/pnml.schema.

