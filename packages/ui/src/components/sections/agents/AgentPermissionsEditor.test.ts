import { describe, expect, test } from 'bun:test';

import type { PermissionRule } from '@/stores/useAgentsStore';

import {
  effectiveEffect,
  modelsEqual,
  parseRules,
  serializeRules,
} from './agentPermissionModel';

const rule = (action: string, resource: string, effect: PermissionRule['effect']): PermissionRule => ({ action, resource, effect });

describe('per-tool view of an ordered rule list', () => {
  test('an empty ruleset is an empty model and serializes back to nothing', () => {
    expect(parseRules([])).toEqual({ global: null, keys: {} });
    expect(serializeRules(parseRules([]))).toEqual([]);
  });

  test('the agent wildcard, a tool wildcard and its patterns round-trip', () => {
    const rules = [
      rule('*', '*', 'allow'),
      rule('shell', '*', 'ask'),
      rule('shell', 'git status *', 'allow'),
      rule('shell', 'git push *', 'deny'),
    ];
    const model = parseRules(rules);
    expect(model.global).toBe('allow');
    expect(model.keys.shell).toEqual({
      effect: 'ask',
      patterns: [
        { pattern: 'git status *', effect: 'allow' },
        { pattern: 'git push *', effect: 'deny' },
      ],
    });
    expect(serializeRules(model)).toEqual(rules);
  });

  test('a pattern always follows its tool wildcard so it overrides the broad rule', () => {
    // Stored in an order where the wildcard would win; the editor rewrites it
    // so the pattern wins, which is what the user asked for.
    const model = parseRules([rule('shell', 'git push *', 'deny'), rule('shell', '*', 'allow')]);
    expect(serializeRules(model)).toEqual([rule('shell', '*', 'allow'), rule('shell', 'git push *', 'deny')]);
  });

  test('when a tool has two wildcard rules the last one counts', () => {
    const model = parseRules([rule('edit', '*', 'allow'), rule('edit', '*', 'deny')]);
    expect(model.keys.edit.effect).toBe('deny');
  });

  test('legacy v1 keys are dropped rather than written back', () => {
    const model = parseRules([rule('doom_loop', '*', 'ask'), rule('bash', '*', 'allow'), rule('shell', '*', 'allow')]);
    expect(Object.keys(model.keys)).toEqual(['shell']);
  });

  test('MCP and plugin tools survive as their own rows', () => {
    const model = parseRules([rule('playwright_click', '*', 'ask')]);
    expect(model.keys.playwright_click).toEqual({ effect: 'ask', patterns: [] });
  });

  test('blank patterns are not written', () => {
    const model = parseRules([rule('read', '*', 'allow')]);
    model.keys.read.patterns.push({ pattern: '   ', effect: 'deny' });
    expect(serializeRules(model)).toEqual([rule('read', '*', 'allow')]);
  });

  test('equality compares what would be written, not row objects', () => {
    const a = parseRules([rule('shell', '*', 'ask')]);
    const b = parseRules([rule('shell', '*', 'ask')]);
    b.keys.shell.patterns.push({ pattern: '', effect: 'allow' });
    expect(modelsEqual(a, b)).toBe(true);
  });
});

describe('effectiveEffect', () => {
  test('OpenCode defaults allow everything except external directories', () => {
    expect(effectiveEffect('shell', { global: [], agentGlobal: null })).toBe('allow');
    expect(effectiveEffect('external_directory', { global: [], agentGlobal: null })).toBe('ask');
  });

  test('global config rules override the defaults', () => {
    expect(effectiveEffect('shell', { global: [rule('shell', '*', 'deny')], agentGlobal: null })).toBe('deny');
  });

  test("the agent's own wildcard overrides both", () => {
    expect(effectiveEffect('shell', { global: [rule('shell', '*', 'deny')], agentGlobal: 'ask' })).toBe('ask');
  });

  test('pattern rules do not decide the tool-wide answer', () => {
    expect(effectiveEffect('read', { global: [rule('read', '*.env', 'deny')], agentGlobal: null })).toBe('allow');
  });
});
