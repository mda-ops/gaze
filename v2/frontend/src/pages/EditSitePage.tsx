import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useRef, type FormEvent} from 'react';
import {Link, useSearchParams} from 'react-router-dom';
import {api} from '../api/client';
import {C_HUB_SECTIONS, CORE_PAGES, HUB_PAGES, REPORT_PAGES} from '../pages';

// /edit-site (Python app: edit_site): admins add rich-text blocks to pages.

interface Block {
    id: string; page: string; title: string; body: string; cleanBody: string; style: string; enabled: boolean; sort_order: number;
}

// Python app: editable_pages, in this order.
const EDITABLE = [...CORE_PAGES, ...REPORT_PAGES, ...C_HUB_SECTIONS.flatMap(s => s.pages), ...HUB_PAGES];
const pageLabel = (path: string) => EDITABLE.find(p => p.path === path)?.label ?? path;

const STYLES: [string, string][] = [['note', 'Note'], ['highlight', 'Highlight'], ['warning', 'Important'], ['quiet', 'Quiet']];
const TOOLS: [label: string, command: string, value?: string][] = [
    ['B', 'bold'], ['I', 'italic'], ['List', 'insertUnorderedList'], ['H3', 'formatBlock', 'h3'], ['P', 'formatBlock', 'p'],
];

const BLOCKS = ['edit-site'];

function BlockForm({editing, pageValue, onSaved}: {editing: Block | null; pageValue: string; onSaved: (page: string, id: string) => void}) {
    const editor = useRef<HTMLDivElement>(null);
    const save = useMutation({
        mutationFn: (block: Omit<Block, 'sort_order' | 'cleanBody'>) => api<{id: string; page: string}>('/api/edit-site', {method: 'POST', body: block}),
        onSuccess: result => onSaved(result.page, result.id),
    });

    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        save.mutate({
            id: editing?.id ?? '',
            page: String(form.get('page') ?? '/'),
            title: String(form.get('title') ?? ''),
            body: editor.current?.innerHTML ?? '',
            style: String(form.get('style') ?? 'note'),
            enabled: form.get('enabled') !== null,
        });
    }
    function runTool(command: string, value?: string) {
        editor.current?.focus();
        document.execCommand(command, false, value);
    }

    return (
        <form className="builder-form" onSubmit={submit}>
            <label>Page
                <select name="page" defaultValue={EDITABLE.some(p => p.path === pageValue) ? pageValue : EDITABLE[0].path}>
                    {EDITABLE.map(p => <option key={p.path} value={p.path}>{p.label}</option>)}
                </select>
            </label>
            <label>Block Title<input name="title" defaultValue={editing?.title ?? ''} placeholder="Example: COO notes for tomorrow"/></label>
            <label>Style
                <select name="style" defaultValue={editing?.style || 'note'}>
                    {STYLES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
            </label>
            <label className="toggle-row"><input type="checkbox" name="enabled" value="1" defaultChecked={editing?.enabled ?? true}/> Visible on site</label>
            <div className="wysiwyg-toolbar" aria-label="Text tools">
                {TOOLS.map(([label, command, value]) => (
                    <button key={label} type="button" onMouseDown={e => e.preventDefault()} onClick={() => runTool(command, value)}>{label}</button>
                ))}
            </div>
            {/* Uncontrolled: the browser edits it; its HTML is saved (the server cleans it). */}
            <div ref={editor} className="wysiwyg-editor" contentEditable suppressContentEditableWarning
                 dangerouslySetInnerHTML={{__html: editing?.cleanBody ?? ''}}/>
            {save.error && <p className="login-error">{save.error.message}</p>}
            <button type="submit" disabled={save.isPending}>{editing ? 'Save Block' : 'Add Block'}</button>
        </form>
    );
}

export function EditSitePage() {
    const queryClient = useQueryClient();
    const [params, setParams] = useSearchParams();
    const {data, error} = useQuery({queryKey: BLOCKS, queryFn: () => api<{blocks: Block[]}>('/api/edit-site')});
    const refresh = async () => {
        await queryClient.invalidateQueries({queryKey: BLOCKS});
        await queryClient.invalidateQueries({queryKey: ['site-blocks']});
    };
    const move = useMutation({
        mutationFn: (body: {id: string; direction: 'up' | 'down'}) => api<{page: string | null}>('/api/edit-site/move', {method: 'POST', body}),
        onSuccess: async (result, body) => {
            await refresh();
            if (result.page !== null) setParams({page: result.page, block: body.id});
        },
    });
    const remove = useMutation({
        mutationFn: (id: string) => api('/api/edit-site/delete', {method: 'POST', body: {id}}),
        onSuccess: async () => {
            await refresh();
            setParams({});
        },
    });

    if (error) return <section className="panel"><h2>Could not load this page</h2><p className="note">{error.message}</p></section>;
    if (!data) return <section className="panel"><p className="note">Loading…</p></section>;

    const blocks = data.blocks;
    const blockId = params.get('block') ?? '';
    const editing = blocks.find(b => b.id === blockId) ?? null;
    const selectedPage = params.get('page') ?? (blocks[0]?.page ?? '/');
    const pageValue = editing?.page || selectedPage;

    return (
        <>
            <section className="panel builder-intro">
                <h2>Edit Site</h2>
                <p>Admin-only editor. Add simple rich-text blocks to any page, then they appear on the site without touching code.</p>
            </section>
            <section className="builder-grid">
                <div className="panel">
                    <h2>Saved Blocks</h2>
                    <div className="builder-block-list">
                        {!blocks.length && <div className="empty">No editable blocks yet. Add your first one on the right.</div>}
                        {blocks.map(block => (
                            <div key={block.id} className={`builder-block-row${block.id === blockId ? ' active' : ''}`}>
                                <span>
                                    <strong>{block.title || 'Untitled block'}</strong>
                                    <em>{pageLabel(block.page || '/')} · {block.enabled ? 'Visible' : 'Hidden'}</em>
                                </span>
                                <span className="builder-actions">
                                    <Link className="button ghost small" to={`/edit-site?${new URLSearchParams({page: block.page || '/', block: block.id})}`}>Edit</Link>
                                    <button type="button" className="ghost small" onClick={() => move.mutate({id: block.id, direction: 'up'})}>Up</button>
                                    <button type="button" className="ghost small" onClick={() => move.mutate({id: block.id, direction: 'down'})}>Down</button>
                                    <button type="button" className="danger small" onClick={() => remove.mutate(block.id)}>Delete</button>
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
                <div className="panel">
                    <h2>{editing ? 'Edit Block' : 'Add Block'}</h2>
                    {/* Remount when the edited block changes, so the uncontrolled fields reset. */}
                    <BlockForm key={`${blockId}|${pageValue}|${editing?.body ?? ''}`} editing={editing} pageValue={pageValue} onSaved={async (page, id) => {
                        await refresh();
                        setParams({page, block: id, saved: '1'});
                    }}/>
                </div>
            </section>
        </>
    );
}
