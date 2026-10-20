import {useEffect, useMemo, useState, type FormEvent} from 'react';
import {useSearchParams} from 'react-router-dom';
import {LuxSelect} from './LuxSelect';

// The card filter forms of the Model and Chatter Revenue pages (Python app:
// model_filter_form / chatter_filter_form). Values live in the URL under the
// page's own parameter names (e.g. model_creator, chatter_sort), next to the
// period, as the original GET forms did.

export interface ListField {
    param: string;
    label: string;
    options: {value: string; label: string}[];
}

export interface CardFilterConfig {
    lists: string[];
    sortParam: string;
    directionParam: string;
    defaultSort: string;
}

export interface CardFilterState {
    lists: Record<string, string[]>;
    sort: string;
    direction: string;
}

function readState(params: URLSearchParams, config: CardFilterConfig): CardFilterState {
    return {
        lists: Object.fromEntries(config.lists.map(name => [name, params.getAll(name).filter(Boolean)])),
        sort: params.get(config.sortParam) ?? config.defaultSort,
        direction: params.get(config.directionParam) ?? 'desc',
    };
}

function toParams(state: CardFilterState, config: CardFilterConfig): URLSearchParams {
    const params = new URLSearchParams();
    for (const name of config.lists) for (const value of state.lists[name] ?? []) params.append(name, value);
    params.set(config.sortParam, state.sort);
    params.set(config.directionParam, state.direction);
    return params;
}

// Current card filters, their API query parameters, and a setter that keeps
// the page's period parameters.
export function useCardFilters(config: CardFilterConfig) {
    const [params, setParams] = useSearchParams();
    const state = useMemo(() => readState(params, config), [params, config]);
    const apiParams = useMemo(() => toParams(state, config), [state, config]);

    function apply(next: CardFilterState) {
        const search = new URLSearchParams(params);
        for (const name of [...config.lists, config.sortParam, config.directionParam]) search.delete(name);
        for (const [key, value] of toParams(next, config)) search.append(key, value);
        setParams(search);
    }

    return {state, apiParams, apply};
}

export function CardFilterForm({fields, sortOptions, state, onApply}: {
    fields: ListField[];
    sortOptions: {value: string; label: string}[];
    state: CardFilterState;
    onApply: (next: CardFilterState) => void;
}) {
    const [draft, setDraft] = useState(state);
    useEffect(() => setDraft(state), [state]);

    function submit(event: FormEvent) {
        event.preventDefault();
        onApply(draft);
    }

    return (
        <form className="filters model-card-filters" onSubmit={submit}>
            {fields.map(field => (
                <label key={field.param}>{field.label}
                    <LuxSelect multiple options={field.options} value={draft.lists[field.param] ?? []}
                               onChange={values => setDraft(d => ({...d, lists: {...d.lists, [field.param]: values}}))}/>
                </label>
            ))}
            <label>Sort By
                <LuxSelect options={sortOptions} value={draft.sort} onChange={sort => setDraft(d => ({...d, sort}))}/>
            </label>
            <label>Direction
                <LuxSelect options={[{value: 'desc', label: 'High to Low'}, {value: 'asc', label: 'Low to High'}]}
                           value={draft.direction} onChange={direction => setDraft(d => ({...d, direction}))}/>
            </label>
            <button type="submit">Apply</button>
        </form>
    );
}

export function options(values: string[], labels: Record<string, string> = {}) {
    return values.map(v => ({value: v, label: labels[v] ?? v}));
}
