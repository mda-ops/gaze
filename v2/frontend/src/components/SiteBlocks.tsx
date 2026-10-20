import {useQuery} from '@tanstack/react-query';
import {api} from '../api/client';

// Text blocks admins added to this page on Edit Site, shown after the page
// content (Python app: render_site_blocks). The server has already cleaned
// the HTML down to simple formatting.

interface Block {
    id: string;
    title: string;
    body: string;
    style: string;
}

export function SiteBlocks({page}: {page: string}) {
    const {data} = useQuery({
        queryKey: ['site-blocks', page],
        queryFn: () => api<{blocks: Block[]}>(`/api/site-blocks?${new URLSearchParams({page})}`),
    });
    return (
        <>
            {data?.blocks.map(block => (
                <section key={block.id} className={`panel editable-block editable-block-${block.style}`}>
                    {block.title && <h2>{block.title}</h2>}
                    <div className="editable-block-body" dangerouslySetInnerHTML={{__html: block.body}}/>
                </section>
            ))}
        </>
    );
}
