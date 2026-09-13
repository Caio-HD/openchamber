import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, SyntheticMessage, UserMessage } from '@/lib/opencode/model';

import { getActiveAssistantContext } from './useAssistantStatus';

const userMessage = (id: string): UserMessage => ({
    id,
    role: 'user',
    sessionID: 'ses_1',
    time: { created: 1 },
});

const assistantMessage = (id: string, providerID: string, modelID: string): AssistantMessage => ({
    id,
    role: 'assistant',
    sessionID: 'ses_1',
    time: { created: 2 },
    agent: 'build',
    providerID,
    modelID,
});

const syntheticMessage = (id: string): SyntheticMessage => ({
    id,
    role: 'synthetic',
    sessionID: 'ses_1',
    time: { created: 3 },
    text: 'server plugin prompt',
});

describe('getActiveAssistantContext', () => {
    test('keeps the model when plumbing messages land after the assistant', () => {
        const assistant = assistantMessage('assistant_1', 'anthropic', 'claude-opus-4-1');

        expect(getActiveAssistantContext([userMessage('user_1'), assistant, syntheticMessage('synthetic_1')])).toEqual({
            assistantId: assistant.id,
            model: {
                providerId: 'anthropic',
                modelId: 'claude-opus-4-1',
            },
        });
    });

    test('reports the model recorded on the newest assistant message', () => {
        const prompt = userMessage('user_1');
        const assistant = assistantMessage('assistant_1', 'anthropic', 'claude-opus-4-1');
        const laterPrompt = userMessage('user_2');

        expect(getActiveAssistantContext([prompt, assistant, laterPrompt])).toEqual({
            assistantId: assistant.id,
            model: {
                providerId: 'anthropic',
                modelId: 'claude-opus-4-1',
            },
        });
    });

    test('follows the newer assistant message when the model changed mid-session', () => {
        const firstUser = userMessage('user_1');
        const firstAssistant = assistantMessage('assistant_1', 'anthropic', 'claude-opus-4-1');
        const secondUser = userMessage('user_2');
        const secondAssistant = assistantMessage('assistant_2', 'openai', 'gpt-5.6-sol');

        expect(getActiveAssistantContext([firstUser, firstAssistant, secondUser, secondAssistant])).toEqual({
            assistantId: secondAssistant.id,
            model: {
                providerId: 'openai',
                modelId: 'gpt-5.6-sol',
            },
        });
    });

    test('does not guess a model when the assistant message records none', () => {
        const assistant = assistantMessage('assistant_1', '', '');

        expect(getActiveAssistantContext([assistant])).toEqual({
            assistantId: assistant.id,
            model: null,
        });
    });

    test('reports no assistant when the session has only prompts', () => {
        expect(getActiveAssistantContext([userMessage('user_1')])).toEqual({
            assistantId: null,
            model: null,
        });
    });
});
