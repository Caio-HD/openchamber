/**
 * Re-reads the Settings-facing lists after OpenCode rebuilt a catalog.
 *
 * OpenCode v2 watches its own config files and publishes what it rebuilt, so a
 * file written by OpenChamber, by the user's editor, or by another client all
 * arrive the same way. The sync layer refreshes its own slices; this module
 * refreshes the stores the Settings pages and the composer read, so an agent
 * added on disk shows up in the list without anyone pressing a button.
 *
 * Every refresh is best-effort: a failed list leaves the previous one in place
 * and the next event or a page visit re-reads it.
 */

import type { CatalogKind } from "@/lib/opencode/events";
import { invalidateAgentsLoadCache, useAgentsStore } from "@/stores/useAgentsStore";
import { invalidateCommandsLoadCache, useCommandsStore } from "@/stores/useCommandsStore";
import { invalidateSkillsLoadCache, useSkillsStore } from "@/stores/useSkillsStore";
import { useSkillsCatalogStore } from "@/stores/useSkillsCatalogStore";
import { useConfigStore } from "@/stores/useConfigStore";
import { useMcpConfigStore } from "@/stores/useMcpConfigStore";
import { usePluginsStore } from "@/stores/usePluginsStore";

const SOURCE = "catalogRefresh";

const refreshAgents = async (): Promise<void> => {
  invalidateAgentsLoadCache();
  await Promise.allSettled([
    useAgentsStore.getState().loadAgents(),
    useConfigStore.getState().loadAgents({ source: SOURCE }),
  ]);
};

const refreshCommands = async (): Promise<void> => {
  invalidateCommandsLoadCache();
  await useCommandsStore.getState().loadCommands();
};

const refreshSkills = async (): Promise<void> => {
  invalidateSkillsLoadCache();
  await Promise.allSettled([
    useSkillsStore.getState().loadSkills(),
    useSkillsCatalogStore.getState().loadCatalog({ refresh: true }),
  ]);
};

const refreshMcp = async (): Promise<void> => {
  await useMcpConfigStore.getState().loadMcpConfigs({ force: true });
};

const refreshPlugins = async (): Promise<void> => {
  await usePluginsStore.getState().loadPlugins({ force: true });
};

// The current list stays on screen until the fresh one lands. Emptying it
// first would blank the composer's model and effort pickers and every
// message footer's effort label for the length of the request, and OpenCode
// publishes `catalog.updated` many times during one reply, so that blank
// would read as flicker on every turn. `loadProviders` always re-reads (its
// only short-circuit is an in-flight request for the same directory).
const refreshProviders = async (): Promise<void> => {
  const config = useConfigStore.getState();
  config.invalidateModelMetadataCache();
  await config.loadProviders({ source: SOURCE });
};

/** The lists a catalog kind invalidates, in the order they are re-read. */
export function catalogRefreshTasks(kind: CatalogKind): Array<() => Promise<void>> {
  switch (kind) {
    case "agent":
      return [refreshAgents];
    case "command":
      return [refreshCommands];
    case "skill":
      return [refreshSkills];
    case "plugin":
      return [refreshPlugins];
    case "provider":
    case "model":
    case "credential":
      return [refreshProviders];
    // A config file can carry any of them, and OpenChamber's own plugin
    // injection lives in one, so the whole set is re-read.
    case "config":
      return [refreshAgents, refreshCommands, refreshSkills, refreshMcp, refreshPlugins];
    // Projects are the sync layer's own slice; nothing in Settings reads them
    // through these stores.
    case "project":
      return [];
  }
}

export async function refreshStoresForCatalogKind(kind: CatalogKind): Promise<void> {
  const tasks = catalogRefreshTasks(kind);
  if (tasks.length === 0) return;
  await Promise.allSettled(tasks.map((task) => task()));
}
