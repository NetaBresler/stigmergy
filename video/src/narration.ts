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
    text: "Stigmergy. A framework for coordinating language model agents through a shared environment with decay.",
    fallbackSeconds: 6,
  },
  {
    id: "hierarchy",
    text: "Almost every multi-agent framework shipping today encodes the same assumption. If you want many agents to work together, give them a manager. The manager delegates, collects output, plans again. It works for a handful of agents, and it plateaus hard past five or six. The manager becomes a context-window-shaped bottleneck.",
    fallbackSeconds: 18,
  },
  {
    id: "termites",
    text: "In nineteen fifty-nine, the biologist Pierre-Paul Grassé watched termites rebuild a damaged nest. They weren't talking. They weren't taking orders. Each one worked as if alone. Yet together they built a cathedral.",
    fallbackSeconds: 14,
  },
  {
    id: "principle",
    text: "He called it stigmergy. Work that guides work. The shape of what already exists tells the next agent what belongs next.",
    fallbackSeconds: 10,
  },
  {
    id: "medium",
    text: "Stigmergy replaces the manager with a shared medium. Agents read from it, deposit signals as they work, and the next agent picks up whatever the medium suggests it should do next.",
    fallbackSeconds: 13,
  },
  {
    id: "decay",
    text: "Stale signals evaporate. Plans that aren't working simply fade. You don't tell the colony to reconsider — pheromones that aren't reinforced just disappear.",
    fallbackSeconds: 11,
  },
  {
    id: "primitives",
    text: "Six primitives. A shared medium. Decay. Roles. Agents. Locality. And validated reinforcement. Six ingredients. No manager. No orchestrator. The coordination lives in the medium, not in any single agent.",
    fallbackSeconds: 16,
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
