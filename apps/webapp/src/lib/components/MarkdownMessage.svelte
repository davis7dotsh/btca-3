<script module lang="ts">
	const markdownCache: Record<string, string> = {};
</script>

<script lang="ts">
	import { marked } from 'marked';
	import { getChatHighlighter, isLoadedLang } from '$lib/shiki/chatHighlighter';
	import { theme } from '$lib/stores/theme.svelte';

	interface Props {
		content: string;
	}

	let { content }: Props = $props();

	const createCodeId = () => Math.random().toString(36).slice(2, 10);

	const escapeHtml = (value: string) =>
		value
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll('"', '&quot;')
			.replaceAll("'", '&#39;');

	const normalizeCodeLang = (langRaw: string | undefined) => {
		const lang = (langRaw ?? '').trim().toLowerCase();

		if (!lang) {
			return 'text';
		}

		const aliases: Record<string, string> = {
			js: 'javascript',
			ts: 'typescript',
			sh: 'shell',
			bash: 'bash',
			md: 'markdown',
			yml: 'yaml',
			env: 'dotenv',
			py: 'python'
		};

		return aliases[lang] ?? lang;
	};

	const sanitizeHref = (href: string) => {
		if (href.startsWith('/') || href.startsWith('#')) {
			return href;
		}

		try {
			const url = new URL(href);

			if (['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) {
				return href;
			}

			return null;
		} catch {
			return null;
		}
	};

	const renderMarkdown = async (source: string) => {
		if (!source.trim()) {
			return '';
		}

		const cached = markdownCache[source];

		if (cached) {
			return cached;
		}

		const highlighter = await getChatHighlighter();
		const renderer = new marked.Renderer();

		renderer.html = (token) => escapeHtml(token.text);
		renderer.link = (token) => {
			const safeHref = sanitizeHref(token.href);
			const label = renderer.parser.parseInline(token.tokens);
			const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';

			if (!safeHref) {
				return `<span>${label}</span>`;
			}

			return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer"${title}>${label}</a>`;
		};
		renderer.image = (token) => {
			const safeHref = sanitizeHref(token.href);
			const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';

			if (!safeHref) {
				return `<span>${escapeHtml(token.text)}</span>`;
			}

			return `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(token.text)}"${title} />`;
		};
		renderer.code = (token) => {
			const normalizedLang = normalizeCodeLang(token.lang);
			const codeId = createCodeId();
			const canHighlight = isLoadedLang(normalizedLang);

			let highlighted: string;

			if (canHighlight) {
				try {
					highlighted = highlighter.codeToHtml(token.text, {
						lang: normalizedLang,
						themes: {
							light: 'light-plus',
							dark: 'dark-plus'
						},
						defaultColor: false
					});
				} catch {
					highlighted = `<pre class="shiki"><code>${escapeHtml(token.text)}</code></pre>`;
				}
			} else {
				highlighted = `<pre class="shiki"><code>${escapeHtml(token.text)}</code></pre>`;
			}

			return `
				<div class="code-block-wrapper">
					<div class="code-block-header">
						<span class="code-lang">${escapeHtml(token.lang ?? 'text')}</span>
						<button class="copy-btn" type="button" onclick="window.copyCode?.('${codeId}')">
							Copy
						</button>
					</div>
					<div class="code-content">${highlighted}</div>
					<pre id="code-raw-${codeId}" hidden>${escapeHtml(token.text)}</pre>
				</div>
			`;
		};

		const rendered = await marked.parse(source, {
			async: true,
			breaks: true,
			gfm: true,
			renderer
		});

		markdownCache[source] = rendered;
		return rendered;
	};

	let html = $state('');
	let lastRendered = $state('');

	$effect(() => {
		const nextContent = content;
		let cancelled = false;

		if (nextContent === lastRendered) {
			return;
		}

		void renderMarkdown(nextContent)
			.then((rendered) => {
				if (cancelled) {
					return;
				}

				html = rendered;
				lastRendered = nextContent;
			})
			.catch((error) => {
				console.error('Failed to render markdown message', error);

				if (cancelled) {
					return;
				}

				html = `<p>${escapeHtml(nextContent)}</p>`;
				lastRendered = nextContent;
			});

		return () => {
			cancelled = true;
		};
	});

	if (typeof window !== 'undefined') {
		type WindowWithCopyCode = Window & {
			copyCode?: (id: string) => Promise<void>;
		};

		(window as WindowWithCopyCode).copyCode = async (id) => {
			const element = document.getElementById(`code-raw-${id}`);

			if (!element) {
				return;
			}

			await navigator.clipboard.writeText(element.textContent ?? '');
		};
	}
</script>

{#if html}
	<div class="prose max-w-none" class:prose-invert={theme.isDark}>
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		{@html html}
	</div>
{:else if content.trim()}
	<div class="prose max-w-none" class:prose-invert={theme.isDark}>
		<p>{content}</p>
	</div>
{/if}
