import {Parser} from 'htmlparser2';

// The rich text of Edit Site blocks, cleaned like the Python app's
// RichTextCleaner: only simple formatting tags survive (without attributes,
// except a safe link's href), script and style are dropped with their
// content, and all text is escaped.

const ALLOWED = new Set(['b', 'strong', 'i', 'em', 'u', 'br', 'p', 'div', 'span', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'blockquote', 'a']);

// Python's html.escape(text, quote=True).
export function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

export function cleanRichText(value: string): string {
    const parts: string[] = [];
    let skipDepth = 0;
    const parser = new Parser({
        onopentag(tag, attribs) {
            if (tag === 'script' || tag === 'style') {
                skipDepth += 1;
                return;
            }
            if (skipDepth || !ALLOWED.has(tag)) return;
            if (tag === 'a') {
                const href = attribs.href ?? '';
                if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('/')) {
                    parts.push(`<a href="${escapeHtml(href)}">`);
                    return;
                }
            }
            parts.push(`<${tag}>`);
        },
        // The Python parser only sees end tags that are written out, so the
        // ones htmlparser2 adds itself (implied) are ignored.
        onclosetag(tag, isImplied) {
            if (isImplied) return;
            if ((tag === 'script' || tag === 'style') && skipDepth) {
                skipDepth -= 1;
                return;
            }
            if (skipDepth) return;
            if (ALLOWED.has(tag) && tag !== 'br') parts.push(`</${tag}>`);
        },
        ontext(text) {
            if (!skipDepth) parts.push(escapeHtml(text));
        },
    }, {decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true});
    parser.write(value);
    parser.end();
    return parts.join('');
}
