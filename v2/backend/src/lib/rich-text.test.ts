import {describe, expect, it} from 'vitest';
import {cleanRichText} from './rich-text.js';

// Inputs and the Python app's clean_rich_text output for them.
const PYTHON_CASES: [string, string][] = [
    ["<p>Hello <b>world</b></p>", "<p>Hello <b>world</b></p>"],
    ["<script>alert(1)</script><p>x</p>", "<p>x</p>"],
    ["<a href='javascript:alert(1)'>bad</a> <a href=\"https://x.com/?a=1&amp;b=2\">ok</a> <a href='/c-hub'>in</a>", "<a>bad</a> <a href=\"https://x.com/?a=1&amp;b=2\">ok</a> <a href=\"/c-hub\">in</a>"],
    ["<img src=x onerror=alert(1)><div class='x' style='color:red'>styled</div>", "<div>styled</div>"],
    ["Tom & Jerry <3 \"quotes\" 'single'", "Tom &amp; Jerry &lt;3 &quot;quotes&quot; &#x27;single&#x27;"],
    ["<ul><li>one<li>two</ul>", "<ul><li>one<li>two</ul>"],
    ["line<br>break<br/>again", "line<br>break<br>again"],
    ["<H3>Caps</H3><STRONG>bold</STRONG>", "<h3>Caps</h3><strong>bold</strong>"],
    ["<style>p{}</style>after", "after"],
    ["a &amp; b &lt;tag&gt; &copy;", "a &amp; b &lt;tag&gt; ©"],
    ["<p><span>nested <em>em <u>u</u></em></span></p><blockquote>q</blockquote>", "<p><span>nested <em>em <u>u</u></em></span></p><blockquote>q</blockquote>"],
    ["<!-- comment --><h2>t</h2><h1>no h1</h1>", "<h2>t</h2>no h1"],
];

describe('cleanRichText', () => {
    it.each(PYTHON_CASES)('%s', (input, expected) => {
        expect(cleanRichText(input)).toBe(expected);
    });
});
