import { searchMicrosoftMarketplace } from './ms';
import { searchOpenVsx } from './openvsx';
import { mergeResults } from './merge';
import { toOpenVsxCompat } from './compat';
import { etagFor, notModifiedResponse } from './etag';
import { TOP_QUERIES } from './prefetch';
import { handleGalleryQuery } from './gallery';
import type { NormalizedExtension, NormalizedSearchResponse } from './types';
import { stripHopByHop, withHeaders } from './types';

export interface Env {
	MARKETPLACE_CACHE: KVNamespace;
	/** Optional override for testing; defaults to MS Marketplace upstream. */
	MS_UPSTREAM?: string;
	/** Optional override for testing; defaults to open-vsx.org. */
	OPENVSX_UPSTREAM?: string;
}

const SEARCH_CACHE_TTL = 300; // 5 minutes
const SEARCH_STALE_WHILE_REVALIDATE = 1800; // 30 minutes — serve stale, refresh in bg
const DOWNLOAD_CACHE_TTL = 86400; // 24 hours
const UPSTREAM_TIMEOUT_MS = 8000;

/**
 * Hosts we're willing to proxy downloads AND icons from. Anything
 * else is a 403 so the worker can't be used as a generic open proxy.
 */
const DOWNLOAD_ALLOWED_HOSTS = new Set([
	// Microsoft Marketplace asset CDN
	'gallery.vsassets.io',
	'marketplace.visualstudio.com',
	// Open VSX / Eclipse
	'open-vsx.org',
	'openvsxorg.blob.core.windows.net',
	'openvsx.eclipsecontent.org',
	// Subdomain CDN blobs (e.g. ms-python.gallerycdn.vsassets.io)
	'vsassets.io'
]);

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const started = Date.now();

		// Fast path: CORS preflight. Never touches cache or upstream.
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: {
					'access-control-allow-origin': '*',
					'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
					'access-control-allow-headers': 'if-none-match, range, accept-encoding',
					'access-control-max-age': '86400'
				}
			});
		}

		try {
			let response: Response;
			if (url.pathname === '/api/search') {
				response = await handleSearch(url, request, env, ctx, 'normalized');
			} else if (url.pathname === '/api/-/search') {
				response = await handleSearch(url, request, env, ctx, 'openvsx-compat');
			} else if (url.pathname === '/api/gallery/extensionquery' || url.pathname === '/api/gallery/extensionquery/') {
				response = await handleVsGallery(url, request, env, ctx);
			} else if (url.pathname.startsWith('/api/icon/')) {
				response = await handleIcon(url, request, env, ctx);
			} else if (url.pathname.startsWith('/api/asset/')) {
				response = await handleAsset(url, request, env, ctx);
			} else if (url.pathname.startsWith('/api/download/')) {
				response = await handleDownload(url, request, env, ctx);
			} else if (url.pathname === '/healthz') {
				response = new Response('ok', { status: 200 });
			} else {
				response = new Response('not found', { status: 404 });
			}
			return withHeaders(response, {
				'server-timing': `total;dur=${Date.now() - started}`
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return new Response(JSON.stringify({ error: message }), {
				status: 502,
				headers: { 'content-type': 'application/json' }
			});
		}
	},

	/**
	 * Cron handler — pre-warms the cache with the top extension
	 * searches so the first user in a cold POP still sees a cache
	 * hit. Runs server-side only; zero impact on the user's machine.
	 */
	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		const origin = 'https://marketplace.siden.ai';
		const pageSize = 50;
		const shape: 'normalized' | 'openvsx-compat' = 'normalized';

		// Fire all prefetches in parallel but cap concurrency to avoid
		// hammering upstream. 5 in flight is well within what both
		// backends happily serve.
		const queue = [...TOP_QUERIES];
		const workers = Array.from({ length: 5 }, async () => {
			while (queue.length) {
				const query = queue.shift();
				if (query === undefined) {
					return;
				}
				try {
					const body = await runSearch(query, pageSize, 0, shape, origin);
					const etag = etagFor(body);
					const cacheKey = `search2:${shape}:${pageSize}:0:${query.toLowerCase()}`;
					const edgeReq = new Request(`https://sidex-cache/${encodeURIComponent(cacheKey)}`);
					await Promise.all([
						env.MARKETPLACE_CACHE.put(cacheKey, body, {
							expirationTtl: SEARCH_CACHE_TTL * 2 // double TTL for pre-warmed entries
						}),
						caches.default.put(edgeReq, jsonResponse(body, SEARCH_CACHE_TTL * 2, 'prewarmed', etag).clone())
					]);
				} catch {
					// A single failing query should never stop the whole run.
				}
			}
		});
		await Promise.all(workers);
		ctx.waitUntil(Promise.resolve());
	}
};

// ---------------------------------------------------------------------------
// VS Code gallery protocol endpoint
// ---------------------------------------------------------------------------

/**
 * Handles POST /api/gallery/extensionquery — the exact protocol
 * VS Code's built-in extensionGalleryService uses. Accepts the
 * MS-format POST body, fans out to both MS + Open VSX, merges, and
 * returns an MS-format response so VS Code parses it with zero changes.
 *
 * Responses are cached by a hash of the POST body, same two-tier
 * strategy as search (edge Cache API + KV).
 */
async function handleVsGallery(url: URL, request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const origin = new URL(request.url).origin;

	// Read body once for both caching key and forwarding.
	const bodyText = await request.text();
	const etag = etagFor(bodyText);
	// v2 prefix busts any stale edge/KV cache entries from before the
	// asset URL rewriting fixes (wrong assetUri format causing 404s).
	const cacheKey = `gallery2:${etag}`;

	const edgeReq = new Request(`https://sidex-cache/${encodeURIComponent(cacheKey)}`);
	const edgeHit = await caches.default.match(edgeReq);
	if (edgeHit) {
		const respEtag = edgeHit.headers.get('etag');
		if (respEtag) {
			const nm = notModifiedResponse(request, respEtag);
			if (nm) {
				return withHeaders(nm, { 'x-sidex-cache': 'edge-304' });
			}
		}
		return withHeaders(edgeHit, { 'x-sidex-cache': 'edge' });
	}

	const kvHit = await env.MARKETPLACE_CACHE.get(cacheKey, 'text');
	if (kvHit) {
		const respEtag = etagFor(kvHit);
		const nm = notModifiedResponse(request, respEtag);
		if (nm) {
			return withHeaders(nm, { 'x-sidex-cache': 'kv-304' });
		}
		const resp = galleryResponse(kvHit, 'kv', respEtag);
		ctx.waitUntil(caches.default.put(edgeReq, resp.clone()));
		return resp;
	}

	// Reconstruct a Request with the body text so handleGalleryQuery
	// can call request.json() on it.
	const syntheticReq = new Request(url.toString(), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: bodyText
	});
	const { body } = await handleGalleryQuery(syntheticReq, origin);
	const respEtag = etagFor(body);
	ctx.waitUntil(env.MARKETPLACE_CACHE.put(cacheKey, body, { expirationTtl: SEARCH_CACHE_TTL }));
	const resp = galleryResponse(body, 'miss', respEtag);
	ctx.waitUntil(caches.default.put(edgeReq, resp.clone()));
	return resp;
}

function galleryResponse(body: string, cacheState: string, etag: string): Response {
	return new Response(body, {
		status: 200,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': `public, max-age=${SEARCH_CACHE_TTL}, stale-while-revalidate=${SEARCH_STALE_WHILE_REVALIDATE}`,
			'access-control-allow-origin': '*',
			'access-control-expose-headers': 'etag, x-sidex-cache, server-timing',
			vary: 'accept-encoding',
			etag,
			'x-sidex-cache': cacheState
		}
	});
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function handleSearch(
	url: URL,
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	shape: 'normalized' | 'openvsx-compat'
): Promise<Response> {
	const query = (url.searchParams.get('q') ?? url.searchParams.get('query') ?? '').trim();
	const pageSize = Math.min(Number(url.searchParams.get('pageSize') ?? url.searchParams.get('size')) || 50, 100);
	const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
	const cacheKey = `search2:${shape}:${pageSize}:${offset}:${query.toLowerCase()}`;

	const edgeReq = new Request(`https://sidex-cache/${encodeURIComponent(cacheKey)}`);
	const edgeHit = await caches.default.match(edgeReq);
	if (edgeHit) {
		const age = Number(edgeHit.headers.get('age') ?? '0');
		if (age > SEARCH_CACHE_TTL) {
			ctx.waitUntil(refreshSearch(url, env, ctx, shape, cacheKey, edgeReq));
		}
		const etag = edgeHit.headers.get('etag');
		if (etag) {
			const notModified = notModifiedResponse(request, etag);
			if (notModified) {
				return withHeaders(notModified, { 'x-sidex-cache': 'edge-304' });
			}
		}
		return withHeaders(edgeHit, { 'x-sidex-cache': 'edge' });
	}

	const kvHit = await env.MARKETPLACE_CACHE.get(cacheKey, 'text');
	if (kvHit) {
		const etag = etagFor(kvHit);
		const notModified = notModifiedResponse(request, etag);
		if (notModified) {
			return withHeaders(notModified, { 'x-sidex-cache': 'kv-304' });
		}
		const resp = jsonResponse(kvHit, SEARCH_CACHE_TTL, 'kv', etag);
		ctx.waitUntil(caches.default.put(edgeReq, resp.clone()));
		return resp;
	}

	const origin = new URL(request.url).origin;
	const body = await runSearch(query, pageSize, offset, shape, origin);
	const etag = etagFor(body);
	ctx.waitUntil(env.MARKETPLACE_CACHE.put(cacheKey, body, { expirationTtl: SEARCH_CACHE_TTL }));
	const notModified = notModifiedResponse(request, etag);
	if (notModified) {
		ctx.waitUntil(caches.default.put(edgeReq, jsonResponse(body, SEARCH_CACHE_TTL, 'miss', etag).clone()));
		return withHeaders(notModified, { 'x-sidex-cache': 'miss-304' });
	}
	const resp = jsonResponse(body, SEARCH_CACHE_TTL, 'miss', etag);
	ctx.waitUntil(caches.default.put(edgeReq, resp.clone()));
	return resp;
}

async function refreshSearch(
	url: URL,
	env: Env,
	ctx: ExecutionContext,
	shape: 'normalized' | 'openvsx-compat',
	cacheKey: string,
	edgeReq: Request
): Promise<void> {
	const query = (url.searchParams.get('q') ?? url.searchParams.get('query') ?? '').trim();
	const pageSize = Math.min(Number(url.searchParams.get('pageSize') ?? url.searchParams.get('size')) || 50, 100);
	const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
	const body = await runSearch(query, pageSize, offset, shape, 'https://sidex-cache');
	const etag = etagFor(body);
	await env.MARKETPLACE_CACHE.put(cacheKey, body, { expirationTtl: SEARCH_CACHE_TTL });
	await caches.default.put(edgeReq, jsonResponse(body, SEARCH_CACHE_TTL, 'miss', etag).clone());
}

async function runSearch(
	query: string,
	pageSize: number,
	offset: number,
	shape: 'normalized' | 'openvsx-compat',
	origin: string
): Promise<string> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
	const [msResult, ovsxResult] = await Promise.allSettled([
		searchMicrosoftMarketplace(query, pageSize, controller.signal),
		searchOpenVsx(query, pageSize, null, controller.signal)
	]);
	clearTimeout(timeout);

	const msItems: NormalizedExtension[] = msResult.status === 'fulfilled' ? msResult.value.items : [];
	const ovsxItems: NormalizedExtension[] = ovsxResult.status === 'fulfilled' ? ovsxResult.value.items : [];

	// Rewrite every downloadUrl AND iconUrl to point at this Worker so
	// installs and icon loads both benefit from the same edge cache.
	const merged = mergeResults(msItems, ovsxItems)
		.slice(0, pageSize)
		.map(ext => ({
			...ext,
			downloadUrl: rewriteDownloadUrl(ext, origin),
			iconUrl: ext.iconUrl ? rewriteIconUrl(ext.iconUrl, origin) : undefined
		}));

	if (shape === 'openvsx-compat') {
		return JSON.stringify(toOpenVsxCompat(merged, offset));
	}
	const payload: NormalizedSearchResponse = {
		results: merged,
		totalCount: merged.length,
		sources: {
			microsoft: { ok: msResult.status === 'fulfilled', count: msItems.length },
			openvsx: { ok: ovsxResult.status === 'fulfilled', count: ovsxItems.length }
		}
	};
	return JSON.stringify(payload);
}

function rewriteDownloadUrl(ext: NormalizedExtension, origin: string): string {
	if (!ext.downloadUrl) {
		return '';
	}
	try {
		const target = new URL(ext.downloadUrl);
		if (!isAllowedHost(target.host)) {
			return ext.downloadUrl;
		}
		const encoded = base64UrlEncode(ext.downloadUrl);
		return `${origin}/api/download/${ext.source}/${encoded}`;
	} catch {
		return ext.downloadUrl;
	}
}

function rewriteIconUrl(iconUrl: string, origin: string): string {
	try {
		const target = new URL(iconUrl);
		if (!isAllowedHost(target.host)) {
			return iconUrl;
		}
		return `${origin}/api/icon/${base64UrlEncode(iconUrl)}`;
	} catch {
		return iconUrl;
	}
}

// ---------------------------------------------------------------------------
// Icon proxy
// ---------------------------------------------------------------------------

/**
 * Proxies extension icons through the Worker so:
 *   a) icons load from Cloudflare edge (same origin as search) — faster
 *   b) the Extensions pane never shows mixed-content or CORS errors
 *   c) icons are cached 24h and served with proper headers
 *
 *   /api/icon/<b64url-icon-url>
 */
async function handleIcon(url: URL, _request: Request, _env: Env, ctx: ExecutionContext): Promise<Response> {
	const encoded = url.pathname.slice('/api/icon/'.length);
	if (!encoded) {
		return new Response('bad request', { status: 400 });
	}
	let target: URL;
	try {
		target = new URL(base64UrlDecode(encoded));
	} catch {
		return new Response('bad target', { status: 400 });
	}
	if (!isAllowedHost(target.host)) {
		return new Response('host not allowed', { status: 403 });
	}

	const cacheKey = `icon:${target.host}${target.pathname}`;
	const edgeReq = new Request(`https://sidex-cache/${encodeURIComponent(cacheKey)}`);
	const edgeHit = await caches.default.match(edgeReq);
	if (edgeHit) {
		return withHeaders(edgeHit, { 'x-sidex-cache': 'edge' });
	}

	const upstream = await fetch(target.toString(), {
		headers: { 'user-agent': 'sidex-marketplace-proxy/1.0' }
	});
	if (!upstream.ok) {
		return iconPlaceholder();
	}

	const ct = upstream.headers.get('content-type') ?? 'image/png';
	const headers = new Headers({
		'content-type': ct,
		'cache-control': `public, max-age=${DOWNLOAD_CACHE_TTL}, immutable`,
		'access-control-allow-origin': '*',
		'x-sidex-cache': 'miss'
	});
	const resp = new Response(await upstream.arrayBuffer(), { status: 200, headers });
	ctx.waitUntil(caches.default.put(edgeReq, resp.clone()));
	return resp;
}

/**
 * Handles /api/asset/<source>/<b64url-cdn-base>/<assetType>
 *
 * VS Code constructs `assetUri/{assetType}` for every extension asset.
 * We encode the real upstream CDN base into the URL (base64url), then
 * decode it here and fetch `cdnBase/{assetType}` — which always works
 * because it's the exact URL the upstream gallery returned.
 *
 * Also handles the legacy /api/asset/<source>/<publisher>/<name>/<version>/<assetType>
 * format for Open VSX extensions in the search path.
 */
async function handleAsset(url: URL, _request: Request, _env: Env, ctx: ExecutionContext): Promise<Response> {
	const parts = url.pathname.split('/').filter(Boolean);
	// parts[0]="api", parts[1]="asset", parts[2]=source, parts[3]=...
	if (parts.length < 4) {
		return new Response('bad request', { status: 400 });
	}
	const source = parts[2];
	const rest = parts.slice(3);

	// Special case: no-icon placeholder path. Return a transparent 1×1 PNG
	// immediately so VS Code doesn't log 404 errors for iconless extensions.
	if (rest[0] === 'no-icon') {
		return iconPlaceholder();
	}

	// Special case: vsix-<b64url-of-direct-vsix-url>/<assetType>
	// Used as fallbackAssetUri for Open VSX extensions so VS Code's
	// getDownloadAsset() can install them. The b64 encodes the real
	// upstream VSIX URL (from /api/download/openvsx/<b64>); we fetch
	// the upstream directly to avoid a self-referential loop.
	if (rest[0]?.startsWith('vsix-')) {
		const b64 = rest[0].slice('vsix-'.length);
		try {
			const vsixUrl = base64UrlDecode(b64);
			// vsixUrl is the real upstream Open VSX VSIX URL
			const cacheKey = `vsix:${vsixUrl}`;
			const edgeReq = new Request(`https://sidex-cache/${encodeURIComponent(cacheKey)}`);
			const edgeHit = await caches.default.match(edgeReq);
			if (edgeHit) {
				return withHeaders(edgeHit, { 'x-sidex-cache': 'edge' });
			}
			const upstream = await fetch(vsixUrl, {
				headers: { 'user-agent': 'sidex-marketplace-proxy/1.0', accept: '*/*' },
				redirect: 'follow'
			});
			if (!upstream.ok) {
				return new Response(`upstream ${upstream.status}`, { status: upstream.status });
			}
			const ct = upstream.headers.get('content-type') ?? 'application/octet-stream';
			const headers = new Headers({
				'content-type': ct,
				'cache-control': `public, max-age=${DOWNLOAD_CACHE_TTL}, immutable`,
				'access-control-allow-origin': '*',
				'x-sidex-cache': 'miss'
			});
			const resp = new Response(await upstream.arrayBuffer(), { status: 200, headers });
			ctx.waitUntil(caches.default.put(edgeReq, resp.clone()));
			return resp;
		} catch {
			return new Response('bad vsix url', { status: 400 });
		}
	}

	let upstreamUrl: string;

	// Detect b64url-encoded CDN base (single segment that decodes to a URL)
	// vs the legacy publisher/name/version/assetType format (4+ segments).
	if (rest.length >= 2) {
		// Try to decode rest[0] as a base64url CDN base URL
		try {
			const decoded = base64UrlDecode(rest[0]);
			if (decoded.startsWith('https://') || decoded.startsWith('http://')) {
				const assetType = rest.slice(1).join('/');
				const targetPlatform = url.searchParams.get('targetPlatform');
				// For Open VSX /file/ base URLs, map MS asset type names to real
				// Open VSX filenames. For MS CDN URLs, append the type directly.
				const resolvedType = decoded.includes('open-vsx.org') ? openVsxFilename(assetType) : assetType;
				upstreamUrl = `${decoded}/${resolvedType}${targetPlatform ? `?targetPlatform=${encodeURIComponent(targetPlatform)}` : ''}`;
			} else {
				throw new Error('not a URL');
			}
		} catch {
			// Legacy scheme: <publisher>/<name>/<version>/<assetType>
			if (rest.length < 4) {
				return new Response('bad request', { status: 400 });
			}
			const [publisher, name, version, ...assetTypeParts] = rest;
			const assetType = assetTypeParts.join('/');
			const targetPlatform = url.searchParams.get('targetPlatform');
			if (source === 'microsoft') {
				upstreamUrl = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${publisher}/vsextensions/${name}/${version}/assets/${assetType}`;
			} else {
				upstreamUrl = `https://open-vsx.org/vscode/asset/${publisher}/${name}/${version}/${assetType}${targetPlatform ? `?targetPlatform=${encodeURIComponent(targetPlatform)}` : ''}`;
			}
		}
	} else {
		return new Response('bad request', { status: 400 });
	}

	// Validate the resolved upstream host
	try {
		const targetHost = new URL(upstreamUrl).host;
		if (!isAllowedHost(targetHost)) {
			return new Response('host not allowed', { status: 403 });
		}
	} catch {
		return new Response('bad upstream url', { status: 400 });
	}

	const cacheKey = `asset:${upstreamUrl}`;
	const edgeReq = new Request(`https://sidex-cache/${encodeURIComponent(cacheKey)}`);
	const edgeHit = await caches.default.match(edgeReq);
	if (edgeHit) {
		return withHeaders(edgeHit, { 'x-sidex-cache': 'edge' });
	}

	const upstream = await fetch(upstreamUrl, {
		headers: {
			'user-agent': 'sidex-marketplace-proxy/1.0',
			accept: '*/*'
		},
		redirect: 'follow'
	});
	if (!upstream.ok) {
		// For icon requests, a missing icon is normal (e.g. Open VSX extensions
		// without icons). Return a transparent 1×1 PNG so VS Code doesn't log
		// a 404 error or fail to render the extension detail pane.
		const isIconRequest = upstreamUrl.includes('Icons.Default') || upstreamUrl.includes('Icons.Small');
		if (isIconRequest) {
			return iconPlaceholder();
		}
		// For all other assets (manifest, readme, changelog etc.) return the
		// actual status so VS Code can handle it gracefully (show "No README"
		// etc.) rather than crashing the pane with an unhandled rejection.
		return new Response(`upstream ${upstream.status}`, { status: upstream.status });
	}

	const ct = upstream.headers.get('content-type') ?? 'application/octet-stream';
	const headers = new Headers({
		'content-type': ct,
		'cache-control': `public, max-age=${DOWNLOAD_CACHE_TTL}, immutable`,
		'access-control-allow-origin': '*',
		'x-sidex-cache': 'miss'
	});
	const resp = new Response(await upstream.arrayBuffer(), { status: 200, headers });
	ctx.waitUntil(caches.default.put(edgeReq, resp.clone()));
	return resp;
}

function isAllowedHost(host: string): boolean {
	for (const allowed of DOWNLOAD_ALLOWED_HOSTS) {
		if (host === allowed || host.endsWith(`.${allowed}`)) {
			return true;
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Download proxy
// ---------------------------------------------------------------------------

/**
 * Proxies VSIX downloads with a double-layered cache (edge + KV only
 * stores metadata; bodies live in the Cache API which has no size
 * limit per entry up to 512 MB — more than enough for any VSIX).
 *
 *   /api/download/<source>/<b64url-upstream-url>
 *
 * Honors inbound `Range` so interrupted installs can resume without
 * re-downloading the whole archive. The cached response stores the
 * *full* VSIX; range responses are synthesized per-request.
 */
async function handleDownload(url: URL, request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const parts = url.pathname.split('/').filter(Boolean);
	if (parts.length < 4) {
		return new Response('bad request', { status: 400 });
	}
	const source = parts[2];
	const encoded = parts.slice(3).join('/');
	let target: URL;
	try {
		target = new URL(base64UrlDecode(encoded));
	} catch {
		return new Response('bad target', { status: 400 });
	}
	if (!isAllowedHost(target.host)) {
		return new Response('host not allowed', { status: 403 });
	}

	const range = request.headers.get('range');
	const cacheKey = `dl:${source}:${target.host}${target.pathname}${target.search}`;
	const edgeReq = new Request(`https://sidex-cache/${encodeURIComponent(cacheKey)}`);

	// Cache API does not natively return partial content, so we fetch
	// the full cached body and slice it ourselves when the client asks
	// for a range.
	const edgeHit = await caches.default.match(edgeReq);
	if (edgeHit && edgeHit.body) {
		return range ? partialFrom(edgeHit, range, 'edge') : withHeaders(edgeHit, { 'x-sidex-cache': 'edge' });
	}

	const upstream = await fetch(target.toString(), {
		headers: new Headers({
			'user-agent': 'sidex-marketplace-proxy/1.0',
			'accept-encoding': 'identity' // store the raw bytes so range math is simple
		})
	});
	if (!upstream.ok) {
		return new Response(`upstream ${upstream.status}`, { status: upstream.status });
	}

	const headers = stripHopByHop(upstream.headers);
	headers.set('cache-control', `public, max-age=${DOWNLOAD_CACHE_TTL}, immutable`);
	headers.set('x-sidex-cache', 'miss');
	headers.set('accept-ranges', 'bytes');

	// Cloudflare only caches responses we `put` with a 200. Buffer the
	// body, store it, and then return either the full body or a range
	// slice. VSIX files are typically <50 MB so this is fine.
	const full = new Response(await upstream.arrayBuffer(), { status: 200, headers });
	ctx.waitUntil(caches.default.put(edgeReq, full.clone()));
	return range ? partialFrom(full, range, 'miss') : full;
}

/**
 * Build a 206 Partial Content response from a cached full-body
 * response. Supports single-range `bytes=start-end` / `bytes=start-` /
 * `bytes=-suffix`. Invalid ranges fall back to returning the full body.
 */
async function partialFrom(full: Response, range: string, cacheState: string): Promise<Response> {
	const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
	if (!match) {
		return withHeaders(full, { 'x-sidex-cache': cacheState });
	}
	const buf = await full.clone().arrayBuffer();
	const total = buf.byteLength;
	let start: number;
	let end: number;
	if (match[1] === '' && match[2] !== '') {
		const suffix = Number(match[2]);
		start = Math.max(0, total - suffix);
		end = total - 1;
	} else {
		start = Number(match[1]);
		end = match[2] === '' ? total - 1 : Math.min(Number(match[2]), total - 1);
	}
	if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
		return new Response('range not satisfiable', {
			status: 416,
			headers: { 'content-range': `bytes */${total}` }
		});
	}
	const slice = buf.slice(start, end + 1);
	const headers = new Headers(full.headers);
	headers.set('content-range', `bytes ${start}-${end}/${total}`);
	headers.set('content-length', String(slice.byteLength));
	headers.set('x-sidex-cache', cacheState);
	return new Response(slice, { status: 206, headers });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: string, ttl: number, cacheState: string, etag?: string): Response {
	const headers: Record<string, string> = {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': `public, max-age=${ttl}, stale-while-revalidate=${SEARCH_STALE_WHILE_REVALIDATE}`,
		'access-control-allow-origin': '*',
		'access-control-expose-headers': 'etag, x-sidex-cache, server-timing',
		'x-sidex-cache': cacheState,
		vary: 'accept-encoding'
	};
	if (etag) {
		headers.etag = etag;
	}
	return new Response(body, { status: 200, headers });
}

/**
 * Maps MS Marketplace asset type names to their Open VSX filename equivalents.
 * Open VSX stores files with real names (package.json, readme.md) rather than
 * VS Code's abstract type identifiers.
 */
const OPEN_VSX_FILENAME_MAP: Record<string, string> = {
	'Microsoft.VisualStudio.Code.Manifest': 'package.json',
	'Microsoft.VisualStudio.Services.Content.Details': 'readme.md',
	'Microsoft.VisualStudio.Services.Content.Changelog': 'CHANGELOG.md',
	'Microsoft.VisualStudio.Services.Content.License': 'LICENSE.txt',
	'Microsoft.VisualStudio.Services.Icons.Default': 'icon.png',
	'Microsoft.VisualStudio.Services.Icons.Small': 'icon.png',
	'Microsoft.VisualStudio.Services.VsixManifest': 'extension.vsixmanifest'
};

function openVsxFilename(assetType: string): string {
	return OPEN_VSX_FILENAME_MAP[assetType] ?? assetType;
}

/** Transparent 1×1 PNG — returned instead of 404 for missing extension icons. */
function iconPlaceholder(): Response {
	const bytes = Uint8Array.from(
		atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
		c => c.charCodeAt(0)
	);
	return new Response(bytes, {
		status: 200,
		headers: {
			'content-type': 'image/png',
			'cache-control': 'public, max-age=86400',
			'access-control-allow-origin': '*',
			'x-sidex-cache': 'placeholder'
		}
	});
}

function base64UrlDecode(input: string): string {
	const padded = input.replace(/-/g, '+').replace(/_/g, '/');
	const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
	return atob(padded + pad);
}

function base64UrlEncode(input: string): string {
	return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
