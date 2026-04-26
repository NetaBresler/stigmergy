// The script. Single source of truth for narration text and scene order.
// The generator writes one MP3 per scene + a manifest.json with measured
// durations. The Composition reads that manifest to lay out scene timing.
//
// Fallback durations are used when the manifest is absent (e.g. you're
// previewing in the studio before generating audio). They are deliberately
// generous so visuals never get cut short of the spoken line.

export type SceneId =
  | "title"
  | "hierarchy"
  | "termites"
  | "principle"
  | "medium"
  | "decay"
  | "primitives"
  | "claim";

export type SceneScript = {
  id: SceneId;
  text: string;
  fallbackSeconds: number;
};

export const SCRIPT: SceneScript[] = [
  {
    id: "title",
    text: "Stigmergy. Coordinating language model agents through a shared environment with decay.",
    fallbackSeconds: 5,
  },
  {
    id: "hierarchy",
    text: "Almost every multi-agent framework today gives the agents a manager. The manager delegates, collects output, plans again. It works for five or six agents — then plateaus. The manager is a context-window-shaped bottleneck.",
    fallbackSeconds: 13,
  },
  {
    id: "termites",
    text: "Nineteen fifty-nine. Pierre-Paul Grassé watches termites rebuild a nest. No conversation. No orders. Each one works as if alone — and together, they build a cathedral.",
    fallbackSeconds: 11,
  },
  {
    id: "principle",
    text: "He called it stigmergy. Work that guides work. The shape of what exists tells the next agent what belongs next.",
    fallbackSeconds: 9,
  },
  {
    id: "medium",
    text: "Stigmergy replaces the manager with a shared medium. Agents read from it, deposit signals as they work, and the next agent picks up whatever the medium suggests.",
    fallbackSeconds: 11,
  },
  {
    id: "decay",
    text: "Stale signals evaporate. Plans that aren't working fade. Pheromones that aren't reinforced disappear.",
    fallbackSeconds: 8,
  },
  {
    id: "primitives",
    text: "Six primitives. Medium. Decay. Roles. Agents. Locality. Validated reinforcement. No manager. No orchestrator. The coordination lives in the medium.",
    fallbackSeconds: 12,
  },
  {
    id: "claim",
    text: "Stop managing the agents. Shape the landscape they walk on.",
    fallbackSeconds: 6,
  },
];

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
