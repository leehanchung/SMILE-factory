import {
  Activity,
  AiGenerate,
  Bee,
  Bot,
  Chemistry,
  ChemistryReference,
  Chip,
  Cognitive,
  Fire,
  Globe,
  HealthCross,
  Lightning,
  Microscope,
  Mountain,
  RainDrop,
  Rocket,
  Snowflake,
  Sprout,
  Star,
  Sun,
  Tree,
} from "@carbon/icons-react";
import type { CarbonIconType } from "@carbon/icons-react";
import { DEFAULT_ICON, isConnIconKey } from "../lib/icons";
import type { ConnIconKey } from "../lib/icons";

/** Connection icon key -> Carbon glyph [renderer §7]. */
export const CONN_ICON_COMPONENTS: Record<ConnIconKey, CarbonIconType> = {
  flask: Chemistry,
  microscope: Microscope,
  testtube: ChemistryReference,
  brain: Cognitive,
  bot: Bot,
  heartbeat: HealthCross,
  pulse: Activity,
  cpu: Chip,
  sparkle: AiGenerate,
  planet: Globe,
  rocket: Rocket,
  star: Star,
  sun: Sun,
  tree: Tree,
  sprout: Sprout,
  bee: Bee,
  mountains: Mountain,
  lightning: Lightning,
  snowflake: Snowflake,
  drop: RainDrop,
  fire: Fire,
};

export function ConnIcon({ name, size = 18 }: { name: string | undefined; size?: number }) {
  const Glyph = CONN_ICON_COMPONENTS[isConnIconKey(name) ? name : DEFAULT_ICON];
  return <Glyph size={size} aria-hidden />;
}
