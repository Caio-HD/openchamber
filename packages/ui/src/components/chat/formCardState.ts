/**
 * Pure form logic behind `FormCard`.
 *
 * OpenCode v2 replaced the old multi-question prompt with a typed form: one
 * request carries a title and an ordered list of fields, and the reply is a
 * single `{ [key]: value }` answer. Everything that decides what the card
 * shows and whether it can be submitted lives here so it can be tested without
 * rendering, and so the component stays a view.
 */

import type { FormField, FormValue } from '@opencode/client';
import type { FormRequest } from '@/lib/opencode/model';

/**
 * The value a field currently holds in the card.
 *
 * `custom` marks a select field whose user typed their own answer instead of
 * picking an option, so re-selecting an option can clear the typed text.
 */
export type FieldValue = {
    text: string;
    number: number | null;
    boolean: boolean;
    selected: string[];
    custom: boolean;
};

export type FormValues = Record<string, FieldValue>;

/** Fields whose value the user edits; `external` only links out. */
export type AnswerableField = Exclude<FormField, { type: 'external' }>;

export const isAnswerableField = (field: FormField): field is AnswerableField => field.type !== 'external';

/**
 * Numeric bounds and defaults arrive as either a number or one of the JSON
 * stand-ins for values JSON cannot hold. The stand-ins are not usable as a
 * starting value or a bound, so they read as absent.
 */
export const toFiniteNumber = (value: number | 'Infinity' | '-Infinity' | 'NaN' | undefined): number | null => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return value;
};

const emptyValue = (): FieldValue => ({ text: '', number: null, boolean: false, selected: [], custom: false });

/** The card's starting state: every field seeded from its declared default. */
export function initialFormValues(fields: readonly FormField[]): FormValues {
    const values: FormValues = {};
    for (const field of fields) {
        if (!isAnswerableField(field)) continue;
        const value = emptyValue();
        switch (field.type) {
            case 'string':
                if (field.default !== undefined) {
                    // A default that names an option selects it; otherwise it is typed text.
                    if (field.options?.some((option) => option.value === field.default)) {
                        value.selected = [field.default];
                    } else {
                        value.text = field.default;
                        value.custom = Boolean(field.options?.length);
                    }
                }
                break;
            case 'number':
            case 'integer':
                value.number = toFiniteNumber(field.default);
                break;
            case 'boolean':
                value.boolean = field.default ?? false;
                break;
            case 'multiselect':
                value.selected = field.default ? [...field.default] : [];
                break;
        }
        values[field.key] = value;
    }
    return values;
}

export const valueOf = (values: FormValues, key: string): FieldValue => values[key] ?? emptyValue();

/** The answer a single field contributes, or `undefined` when it has none yet. */
export function fieldAnswer(field: AnswerableField, values: FormValues): FormValue | undefined {
    const value = valueOf(values, field.key);
    switch (field.type) {
        case 'string': {
            if (field.options?.length && !value.custom) {
                return value.selected[0];
            }
            const text = value.text.trim();
            return text.length > 0 ? text : undefined;
        }
        case 'number':
        case 'integer':
            return value.number ?? undefined;
        case 'boolean':
            return value.boolean;
        case 'multiselect': {
            const selected = [...value.selected];
            const custom = value.text.trim();
            if (value.custom && custom.length > 0) selected.push(custom);
            return selected.length > 0 ? selected : undefined;
        }
    }
}

/**
 * Whether a field is currently shown. `when` clauses compare another field's
 * answer, so a field gated on an unanswered field stays hidden.
 */
export function isFieldVisible(field: FormField, fields: readonly FormField[], values: FormValues): boolean {
    // `external` fields are never gated, so only the answerable ones carry `when`.
    const when = isAnswerableField(field) ? field.when : undefined;
    if (!when || when.length === 0) return true;
    return when.every((clause) => {
        const target = fields.find((candidate) => candidate.key === clause.key);
        const answer = target && isAnswerableField(target) ? fieldAnswer(target, values) : undefined;
        const expected = typeof clause.value === 'string' && ['Infinity', '-Infinity', 'NaN'].includes(clause.value)
            ? undefined
            : clause.value;
        const matches = Array.isArray(answer)
            ? answer.some((entry) => entry === expected)
            : answer === expected;
        return clause.op === 'eq' ? matches : !matches;
    });
}

/** Fields the card renders right now, in declaration order. */
export function visibleFields(fields: readonly FormField[], values: FormValues): FormField[] {
    return fields.filter((field) => isFieldVisible(field, fields, values));
}

/** Keys of visible fields that are required and still unanswered. */
export function missingRequiredKeys(fields: readonly FormField[], values: FormValues): string[] {
    const missing: string[] = [];
    for (const field of visibleFields(fields, values)) {
        if (!isAnswerableField(field) || !field.required) continue;
        const answer = fieldAnswer(field, values);
        if (answer === undefined) {
            missing.push(field.key);
            continue;
        }
        if (field.type === 'multiselect' && Array.isArray(answer) && answer.length === 0) {
            missing.push(field.key);
        }
    }
    return missing;
}

/**
 * The reply payload. Only visible fields contribute: a field hidden by a
 * `when` clause was never asked, so sending a value for it would answer a
 * question the user never saw.
 */
export function buildFormAnswer(fields: readonly FormField[], values: FormValues): Record<string, FormValue> {
    const answer: Record<string, FormValue> = {};
    for (const field of visibleFields(fields, values)) {
        if (!isAnswerableField(field)) continue;
        const value = fieldAnswer(field, values);
        if (value !== undefined) answer[field.key] = value;
    }
    return answer;
}

/** Fields a form request actually asks the user to fill in. */
export const formFields = (form: FormRequest): readonly FormField[] => form.fields;
