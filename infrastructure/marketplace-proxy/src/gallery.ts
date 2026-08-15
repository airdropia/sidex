/**
 * VS Code extension gallery POST protocol adapter.
 *
 * The native VS Code extensionGalleryService POSTs to
 * `<serviceUrl>/extensionquery` with a JSON body containing filters,
 * flags, page/pageSize, and expects back a response shaped exactly
 * like the MS Marketplace API.
 *
 * This module:
 *   1. Accepts that exact POST body.
 *   2. Extracts the search text + page/size.
 *   3. Fans the query out to both MS Marketplace and Open VSX.
 *   4. Merges + dedupes results.
 *   5. Returns a response shaped exactly like the MS Marketplace API
 *      so the VS Code gallery service can parse it with zero changes.
 *
 * The response shape is what VS Code expects from
 * `extensionGalleryService.queryRawGalleryExtensions`.
 */

import { normalizeMsExtension } from './ms';
import { normalizeOpenVsxItem } from './openvsx';
import { mergeResults } from './merge';
import type { NormalizedExtension } from './types';

// ---------------------------------------------------------------------------
// VS Code gallery request shape
// ---------------------------------------------------------------------------

interface GalleryCriterium {
	filterType: number;
	value?: string;
}

interface GalleryFilter {
	criteria: GalleryCriterium[];
	pageNumber?: number;
	pageSize?: number;
	sortBy?: number;
	sortOrder?: number;
}

interface GalleryQueryBody {
	filters: GalleryFilter[];
	flags: number;
}

// FilterType 10 = SearchText, 8 = Target
const FILTER_SEARCH_TEXT = 10;
const FILTER_EXTENSION_IDS = 4;
const FILTER_EXTENSION_NAMES = 7;
const FILTER_TARGET_PLATFORM = 9; // VS Code filter type for target platform

// Target platform string to Open VSX API path segment mapping
const TARGET_PLATFORM_MAP: Record<string, string> = {
	'win32-x64': 'win32-x64',
	'win32-arm64': 'win32-arm64',
	'linux-x64': 'linux-x64',
	'linux-arm64': 'linux-arm64',
	'darwin-x64': 'darwin-x64',
	'darwin-arm64': 'darwin-arm64'
};

// ---------------------------------------------------------------------------
// Upstream fetch helpers (reuse the existing raw fetchers from ms.ts / openvsx.ts)
// ---------------------------------------------------------------------------

const MS_GALLERY_API = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const MS_GALLERY_ACCEPT = 'application/json; api-version=7.2-preview.1; excludeUrls=true';

// ---------------------------------------------------------------------------
// Response builder
// ---------------------------------------------------------------------------

/**
 * Converts our normalized shape back into the MS Marketplace response
 * format that `extensionGalleryService.ts` parses.
 */
function toMsGalleryResponse(
	items: NormalizedExtension[],
	total: number,
	msOk: boolean,
	ovsxOk: boolean,
	origin: string
): object {
	const extensions = items.map(ext => {
		const vsixUrl = ext.downloadUrl;
		const iconUrl = ext.iconUrl ?? '';

		// Build assetUri — VS Code appends "/{assetType}" to this to fetch
		// icons, READMEs, changelogs, etc.
		//
		// For MS extensions the real CDN base already exists in iconUrl
		// (it's the icon path minus the trailing "/assetType"). We
		// base64url-encode it so our /api/asset/ endpoint can decode and
		// proxy it to the exact CDN URL — avoiding the guessed
		// /publishers/.../assets/... URL that MS returns 404 for.
		//
		// For Open VSX extensions the legacy publisher/name/version format
		// works fine because open-vsx.org/vscode/asset/{p}/{n}/{v}/{type}
		// is a real, stable URL pattern.
		let assetBase: string;
		if (ext.source === 'microsoft' && iconUrl) {
			// iconUrl is already proxied: "${origin}/api/icon/<b64url-of-original-cdn-url>"
			// Decode the b64 to get the real CDN URL, strip the trailing
			// "/assetType" to get the CDN base, then re-encode for /api/asset/.
			let cdnBase: string | null = null;
			try {
				const b64Part = iconUrl.split('/api/icon/')[1];
				if (b64Part) {
					const originalCdnUrl = base64UrlDecodeStr(b64Part);
					// CDN URL ends with "/Microsoft.VisualStudio.Services.Icons.Default"
					// Strip the last path segment to get the base.
					cdnBase = originalCdnUrl.replace(/\/[^/]+$/, '');
				}
			} catch {
				cdnBase = null;
			}
			if (cdnBase) {
				const encoded = btoa(cdnBase).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
				assetBase = `${origin}/api/asset/microsoft/${encoded}`;
			} else {
				// No icon available for this extension — use a path that will
				// return a transparent 1x1 PNG placeholder instead of 404ing,
				// so VS Code doesn't log errors for extensions without icons.
				assetBase = `${origin}/api/asset/microsoft/no-icon/${encodeURIComponent(ext.publisher)}/${encodeURIComponent(ext.name)}/${encodeURIComponent(ext.version)}`;
			}
		} else {
			// Open VSX: use the real file base extracted from the download URL
			// so platform-specific extensions like alpine-x64 load correctly.
			// If we have the real file base (e.g. .../alpine-x64/0.27.0/file),
			// b64-encode it for the /api/asset/ endpoint. Otherwise fall back
			// to the generic publisher/name/version path.
			if (ext.openVsxFileBase) {
				const encoded = btoa(ext.openVsxFileBase).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
				assetBase = `${origin}/api/asset/openvsx/${encoded}`;
			} else {
				assetBase = `${origin}/api/asset/${ext.source}/${encodeURIComponent(ext.publisher)}/${encodeURIComponent(ext.name)}/${encodeURIComponent(ext.version)}`;
			}
		}
		return {
			extensionId: `${ext.publisher}.${ext.name}`,
			extensionName: ext.name,
			displayName: ext.displayName,
			shortDescription: ext.description,
			// These top-level date fields are read by VS Code's toExtension()
			// via Date.parse() to show "Published X years ago" / "Last Released".
			releaseDate: ext.lastUpdated ?? new Date().toISOString(),
			publishedDate: ext.lastUpdated ?? new Date().toISOString(),
			lastUpdated: ext.lastUpdated ?? new Date().toISOString(),
			publisher: {
				publisherName: ext.publisher,
				displayName: ext.publisher
			},
			versions: [
				{
					version: ext.version,
					// lastUpdated is required for "Published X years ago" display.
					lastUpdated: ext.lastUpdated ?? new Date().toISOString(),
					assetUri: assetBase,
					// fallbackAssetUri is used by VS Code's getDownloadAsset() for
					// VSIX installs. For Open VSX extensions we point it directly at
					// the real upstream VSIX URL (via vsix-<b64> sentinel) so the
					// Worker fetches it directly without a self-referential loop.
					fallbackAssetUri:
						ext.source === 'openvsx' && vsixUrl
							? (() => {
									// vsixUrl is our proxied /api/download/openvsx/<b64-of-real-url>
									// Extract the b64 of the real upstream URL so the Worker
									// can fetch it without going through itself.
									const proxyB64Match = vsixUrl.match(/\/api\/download\/openvsx\/([^/]+)$/);
									if (proxyB64Match) {
										// Re-use the same b64 in the vsix-<b64> sentinel so
										// handleAsset can decode the real upstream URL directly.
										return `${origin}/api/asset/openvsx/vsix-${proxyB64Match[1]}`;
									}
									return assetBase;
								})()
							: assetBase,
					// Include every well-known asset type so VS Code's
					// getVersionAsset() returns non-null for manifest,
					// README, changelog, etc.  The source URL uses our
					// assetBase so all fetches go through the Worker cache.
					files: [
						{
							assetType: 'Microsoft.VisualStudio.Code.Manifest',
							source: `${assetBase}/Microsoft.VisualStudio.Code.Manifest`
						},
						{
							assetType: 'Microsoft.VisualStudio.Services.Content.Details',
							source: `${assetBase}/Microsoft.VisualStudio.Services.Content.Details`
						},
						{
							assetType: 'Microsoft.VisualStudio.Services.Content.Changelog',
							source: `${assetBase}/Microsoft.VisualStudio.Services.Content.Changelog`
						},
						{
							assetType: 'Microsoft.VisualStudio.Services.Content.License',
							source: `${assetBase}/Microsoft.VisualStudio.Services.Content.License`
						},
						{
							assetType: 'Microsoft.VisualStudio.Services.Icons.Default',
							source: `${assetBase}/Microsoft.VisualStudio.Services.Icons.Default`
						},
						{
							assetType: 'Microsoft.VisualStudio.Services.Icons.Small',
							source: `${assetBase}/Microsoft.VisualStudio.Services.Icons.Small`
						},
						{
							assetType: 'Microsoft.VisualStudio.Services.VsixManifest',
							source: `${assetBase}/Microsoft.VisualStudio.Services.VsixManifest`
						},
						...(vsixUrl ? [{ assetType: 'Microsoft.VisualStudio.Services.VSIXPackage', source: vsixUrl }] : [])
					]
				}
			],
			statistics: [
				{ statisticName: 'install', value: ext.installCount },
				{ statisticName: 'averagerating', value: ext.rating },
				{ statisticName: 'ratingcount', value: ext.ratingCount ?? 0 },
				{ statisticName: 'weightedRating', value: ext.rating }
			],
			tags: ext.tags ?? [],
			categories: ext.categories ?? [],
			flags: '',
			// Minimal properties array so VS Code renders engine, platform info
			// and the "Marketplace" resource link correctly.
			...(ext.repositoryUrl
				? {
						// Repository link is surfaced in the Resources section of the
						// extension detail sidebar. Without this VS Code omits it.
					}
				: {})
		};
	});

	return {
		results: [
			{
				extensions,
				pagingToken: null,
				resultMetadata: [
					{
						metadataType: 'ResultCount',
						metadataItems: [{ name: 'TotalCount', count: total }]
					},
					{
						metadataType: 'Fragment',
						metadataItems: [
							{ name: 'microsoft', count: msOk ? 1 : 0 },
							{ name: 'openvsx', count: ovsxOk ? 1 : 0 }
						]
					}
				]
			}
		]
	};
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

const UPSTREAM_TIMEOUT_MS = 8000;

export async function handleGalleryQuery(request: Request, origin: string): Promise<{ body: string; total: number }> {
	let queryBody: GalleryQueryBody;
	try {
		queryBody = (await request.json()) as GalleryQueryBody;
	} catch {
		throw new Error('invalid gallery query body');
	}

	const filter: GalleryFilter = queryBody.filters?.[0] ?? { criteria: [] };
	const pageSize = Math.min(filter.pageSize ?? 50, 100);
	const pageNumber = Math.max(filter.pageNumber ?? 1, 1);
	const offset = (pageNumber - 1) * pageSize;

	// Extract the search text from criteria
	const searchCriterium = filter.criteria.find(c => c.filterType === FILTER_SEARCH_TEXT);
	const idCriterium = filter.criteria.find(c => c.filterType === FILTER_EXTENSION_IDS);
	const nameCriterium = filter.criteria.find(c => c.filterType === FILTER_EXTENSION_NAMES);
	const query = searchCriterium?.value?.trim() ?? nameCriterium?.value?.trim() ?? '';

	// If the client is asking for specific extension IDs/names, proxy
	// directly to MS marketplace since Open VSX doesn't have a batch
	// lookup by ID that's fast enough.
	const isBatchLookup = !!idCriterium || (!!nameCriterium && !searchCriterium);

	if (isBatchLookup) {
		const res = await fetch(MS_GALLERY_API, {
			method: 'POST',
			headers: {
				accept: MS_GALLERY_ACCEPT,
				'content-type': 'application/json',
				'user-agent': 'sidex-marketplace-proxy/1.0'
			},
			body: JSON.stringify(queryBody)
		});
		if (!res.ok) {
			throw new Error(`ms gallery batch ${res.status}`);
		}
		const raw = (await res.json()) as {
			results: {
				extensions: {
					extensionName?: string;
					publisher?: { publisherName?: string };
					versions?: {
						version?: string;
						assetUri?: string;
						fallbackAssetUri?: string;
					}[];
				}[];
			}[];
		};

		// Rewrite assetUri to point at our Worker's /api/asset/ endpoint.
		//
		// For Microsoft extensions the real CDN assetUri looks like:
		//   https://ms-python.gallerycdn.vsassets.io/extensions/ms-python/python/2026.5.x/1774608437793
		// VS Code appends "/{assetType}" to that base to get icon/readme etc.
		// Our /api/asset/ endpoint receives <source>/<b64-encoded-cdn-base>/<assetType>
		// and proxies to cdnBase + "/" + assetType — which always works.
		for (const result of raw.results ?? []) {
			for (const ext of result.extensions ?? []) {
				for (const version of ext.versions ?? []) {
					if (version.assetUri) {
						// Encode the real CDN base in the path so our endpoint can
						// reconstruct the exact upstream URL.
						const encoded = rewriteUrl(version.assetUri, `${origin}/api/asset/microsoft`);
						version.assetUri = encoded;
						version.fallbackAssetUri = encoded;
					}
				}
			}
		}
		return { body: JSON.stringify(raw), total: pageSize };
	}

	// Extract target platform from query filters (filterType 9)
	const targetPlatformFilter = filter.criteria.find(c => c.filterType === FILTER_TARGET_PLATFORM);
	const targetPlatform = targetPlatformFilter?.value ?? null;

	// Standard search: fan out to both backends.
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

	const [msResult, ovsxResult] = await Promise.allSettled([
		fetchMsGallery(queryBody, controller.signal),
		fetchOpenVsx(query, pageSize, targetPlatform, controller.signal)
	]);
	clearTimeout(timeout);

	const msItems: NormalizedExtension[] = msResult.status === 'fulfilled' ? msResult.value.items : [];
	const ovsxItems: NormalizedExtension[] = ovsxResult.status === 'fulfilled' ? ovsxResult.value.items : [];
	const msTotal = msResult.status === 'fulfilled' ? msResult.value.total : 0;

	const merged = mergeResults(msItems, ovsxItems)
		.slice(0, pageSize)
		.map(ext => ({
			...ext,
			downloadUrl: rewriteUrl(ext.downloadUrl, `${origin}/api/download/${ext.source}`),
			iconUrl: ext.iconUrl ? rewriteUrl(ext.iconUrl, `${origin}/api/icon`) : undefined
		}));

	const body = JSON.stringify(
		toMsGalleryResponse(
			merged,
			Math.max(msTotal, merged.length),
			msResult.status === 'fulfilled',
			ovsxResult.status === 'fulfilled',
			origin
		)
	);
	return { body, total: merged.length };
}

// ---------------------------------------------------------------------------
// Per-backend fetchers
// ---------------------------------------------------------------------------

async function fetchMsGallery(
	originalBody: GalleryQueryBody,
	signal: AbortSignal
): Promise<{ items: NormalizedExtension[]; total: number }> {
	const res = await fetch(MS_GALLERY_API, {
		method: 'POST',
		headers: {
			accept: MS_GALLERY_ACCEPT,
			'content-type': 'application/json',
			'user-agent': 'sidex-marketplace-proxy/1.0'
		},
		body: JSON.stringify(originalBody),
		signal
	});
	if (!res.ok) {
		throw new Error(`ms gallery ${res.status}`);
	}
	const json = (await res.json()) as {
		results: {
			extensions: Parameters<typeof normalizeMsExtension>[0][];
			resultMetadata?: { metadataType: string; metadataItems: { name: string; count: number }[] }[];
		}[];
	};
	const result = json.results[0];
	const items = (result?.extensions ?? [])
		.map(normalizeMsExtension)
		.filter((e): e is NormalizedExtension => !!e && !!e.downloadUrl);
	const total =
		result?.resultMetadata
			?.find(m => m.metadataType === 'ResultCount')
			?.metadataItems.find(i => i.name === 'TotalCount')?.count ?? items.length;
	return { items, total };
}

async function fetchOpenVsx(
	query: string,
	pageSize: number,
	signal: AbortSignal
): Promise<{ items: NormalizedExtension[]; total: number }> {
	const url = new URL('https://open-vsx.org/api/-/search');
	if (query) {
		url.searchParams.set('query', query);
	}
	url.searchParams.set('size', String(pageSize));
	url.searchParams.set('offset', '0');
	url.searchParams.set('includeAllVersions', 'false');

	const res = await fetch(url.toString(), {
		headers: { accept: 'application/json', 'user-agent': 'sidex-marketplace-proxy/1.0' },
		signal
	});
	if (!res.ok) {
		throw new Error(`open-vsx ${res.status}`);
	}
	const json = (await res.json()) as {
		totalSize: number;
		extensions: Parameters<typeof normalizeOpenVsxItem>[0][];
	};
	const items = (json.extensions ?? []).map(normalizeOpenVsxItem).filter((e): e is NormalizedExtension => !!e);
	return { items, total: json.totalSize ?? items.length };
}

// ---------------------------------------------------------------------------
// URL rewriting helpers
// ---------------------------------------------------------------------------

function rewriteUrl(raw: string, proxyBase: string): string {
	if (!raw) {
		return raw;
	}
	try {
		const encoded = btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
		return `${proxyBase}/${encoded}`;
	} catch {
		return raw;
	}
}

function base64UrlDecodeStr(input: string): string {
	const padded = input.replace(/-/g, '+').replace(/_/g, '/');
	const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
	return atob(padded + pad);
}
