import type { PermissionEffect, PermissionRule } from '@/stores/useAgentsStore';

/**
 * Editor model for an agent's permissions.
 *
 * OpenCode v2 stores an ORDERED list of `{ action, resource, effect }` rules
 * where the last match wins. The user does not think in ordered rules; they
 * think "what may this agent do with each tool?". So the editor keeps the v1
 * mental model — one row per tool with inherit / allow / ask / deny, plus
 * optional resource patterns under a row — and this module translates that
 * view to and from the rule list. Ordering is the module's job: the agent's
 * wildcard rule first, then per tool its wildcard rule followed by its
 * patterns, so every pattern legitimately overrides the broader rule.
 */

export const EFFECTS: PermissionEffect[] = ['allow', 'ask', 'deny'];

/**
 * Permission actions the built-in v2 tools check, in the order they are
 * listed. Plugins and MCP servers add their own (`<server>_<tool>`), which
 * appear as rows once the agent's rules or the tool catalog mention them.
 */
export const BUILTIN_ACTIONS = [
  'shell',
  'edit',
  'read',
  'glob',
  'grep',
  'patch',
  'webfetch',
  'websearch',
  'skill',
  'subagent',
  'question',
  'external_directory',
] as const;

/** OpenChamber's own agent tools, shown so their rules are discoverable. */
export const OPENCHAMBER_ACTIONS = ['openchamber', 'openchamber_web', 'openchamber_memory'] as const;

/**
 * v1 permission keys OpenCode 2 no longer checks. Rules on them are inert, so
 * the editor neither shows nor writes them back: the next save drops them.
 */
export const LEGACY_ACTIONS: ReadonlySet<string> = new Set([
  'bash',
  'task',
  'write',
  'list',
  'lsp',
  'todowrite',
  'todoread',
  'multiedit',
  'doom_loop',
  'plan_enter',
  'plan_exit',
]);

export const isLegacyAction = (action: string): boolean => LEGACY_ACTIONS.has(action);

/**
 * The ordered base policy every agent starts with (OpenCode docs,
 * "Permissions → Defaults"). Global config rules come after it and the agent's
 * own rules last.
 */
export const OPENCODE_DEFAULT_RULES: readonly PermissionRule[] = [
  { action: '*', resource: '*', effect: 'allow' },
  { action: 'external_directory', resource: '*', effect: 'ask' },
  { action: 'read', resource: '*.env', effect: 'ask' },
  { action: 'read', resource: '*.env.*', effect: 'ask' },
  { action: 'read', resource: '*.env.example', effect: 'allow' },
];

export interface PatternRule {
  pattern: string;
  effect: PermissionEffect;
}

export interface KeyState {
  /** The tool's own `*` rule; null = not set, so lower layers decide. */
  effect: PermissionEffect | null;
  /** Resource patterns for the tool, in stable order. */
  patterns: PatternRule[];
}

export interface PermissionModel {
  /** The agent's `*` / `*` rule; null = not set. */
  global: PermissionEffect | null;
  keys: Record<string, KeyState>;
}

export const emptyModel = (): PermissionModel => ({ global: null, keys: {} });

export const cloneModel = (model: PermissionModel): PermissionModel => ({
  global: model.global,
  keys: Object.fromEntries(
    Object.entries(model.keys).map(([key, state]) => [
      key,
      { effect: state.effect, patterns: state.patterns.map((entry) => ({ ...entry })) },
    ]),
  ),
});

/**
 * Read the agent's stored rule list into the per-tool view. Legacy v1 keys are
 * dropped here on purpose (see `LEGACY_ACTIONS`). When a tool has several
 * wildcard rules the last one wins, which is also what OpenCode evaluates.
 */
export const parseRules = (rules: readonly PermissionRule[]): PermissionModel => {
  const model = emptyModel();
  for (const rule of rules) {
    if (isLegacyAction(rule.action)) continue;
    if (rule.action === '*') {
      if (rule.resource === '*') model.global = rule.effect;
      continue;
    }
    const state = model.keys[rule.action] ?? { effect: null, patterns: [] };
    if (rule.resource === '*') {
      state.effect = rule.effect;
    } else {
      const existing = state.patterns.findIndex((entry) => entry.pattern === rule.resource);
      if (existing >= 0) state.patterns[existing] = { pattern: rule.resource, effect: rule.effect };
      else state.patterns.push({ pattern: rule.resource, effect: rule.effect });
    }
    model.keys[rule.action] = state;
  }
  return model;
};

/**
 * Write the per-tool view back as an ordered rule list: the agent's wildcard
 * first, then each tool's wildcard followed by its patterns, so a pattern
 * always overrides the tool's broad rule. Blank patterns are dropped.
 */
export const serializeRules = (model: PermissionModel): PermissionRule[] => {
  const rules: PermissionRule[] = [];
  if (model.global !== null) rules.push({ action: '*', resource: '*', effect: model.global });
  for (const action of Object.keys(model.keys).sort((a, b) => a.localeCompare(b))) {
    const state = model.keys[action];
    if (state.effect !== null) rules.push({ action, resource: '*', effect: state.effect });
    for (const entry of state.patterns) {
      const pattern = entry.pattern.trim();
      if (pattern.length === 0) continue;
      rules.push({ action, resource: pattern, effect: entry.effect });
    }
  }
  return rules;
};

export const modelsEqual = (a: PermissionModel, b: PermissionModel): boolean =>
  JSON.stringify(serializeRules(a)) === JSON.stringify(serializeRules(b));

/**
 * What OpenCode would decide for a tool (any resource) given the layers below
 * the agent's own row: defaults, global config, and the agent's `*` rule.
 * Later rules win; a tool-specific wildcard beats a `*` wildcard only by
 * coming later in that combined list, which mirrors OpenCode's evaluation.
 */
export const effectiveEffect = (
  action: string,
  layers: { global: readonly PermissionRule[]; agentGlobal: PermissionEffect | null },
): PermissionEffect => {
  const combined: PermissionRule[] = [
    ...OPENCODE_DEFAULT_RULES,
    ...layers.global,
    ...(layers.agentGlobal ? [{ action: '*', resource: '*', effect: layers.agentGlobal }] : []),
  ];
  let effect: PermissionEffect = 'ask';
  for (const rule of combined) {
    if (rule.resource !== '*') continue;
    if (rule.action === '*' || rule.action === action) effect = rule.effect;
  }
  return effect;
};
