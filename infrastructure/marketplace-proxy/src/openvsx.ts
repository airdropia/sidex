import type { NormalizedExtension } from './types';

const OPEN_VSX_BASE = 'https://open-vsx.org';

interface OpenVsxSearchItem {
	url: string;
	files?: { download?: string; icon?: string };
	name: string;
	namespace: string;
	version: string;
	displayName?: string;
	description?: string;
	averageRating?: number;
	downloadCount?: number;
	timestamp?: string;
}

interface OpenVsxSearchResponse {
	offset: number;
	totalSize: number;
	extensions: OpenVsxSearchItem[];
}

export function normalizeOpenVsxItem(item: OpenVsxSearchItem): NormalizedExtension | undefined {
	const download = item.files?.download;
	if (!download) {
		return undefined;
	}
	// Extract the file base URL from the download URL.
	// Open VSX download URLs follow the pattern:
	//   https://open-vsx.org/api/{namespace}/{name}/{targetPlatform}/{version}/file/{filename}
	// OR for universal extensions:
	//   https://open-vsx.org/api/{namespace}/{name}/{version}/file/{filename}
	// Strip everything from "/file/" onward to get the base.
	const fileBase = download.replace(/\/file\/[^/]+$/, '/file');
	return {
		id: `${item.namespace}.${item.name}`,
		name: item.name,
		displayName: item.displayName || item.name,
		description: item.description ?? '',
		version: item.version,
		publisher: item.namespace,
		installCount: item.downloadCount ?? 0,
		rating: item.averageRating ?? 0,
		iconUrl: item.files?.icon,
		downloadUrl: download,
		source: 'openvsx',
		lastUpdated: item.timestamp,
		openVsxFileBase: fileBase
	};
}

export async function searchOpenVsx(
	query: string,
	pageSize: number,
	targetPlatform: string | null,
	signal: AbortSignal
): Promise<{ items: NormalizedExtension[]; total: number }> {
	const url = new URL(`${OPEN_VSX_BASE}/api/-/search`);
	if (query) {
		url.searchParams.set('query', query);
	}
	url.searchParams.set('size', String(pageSize));
	url.searchParams.set('offset', '0');
	url.searchParams.set('includeAllVersions', 'false');

	const res = await fetch(url.toString(), {
		headers: {
			accept: 'application/json',
			'user-agent': 'sidex-marketplace-proxy/1.0'
		},
		signal
	});
	if (!res.ok) {
		throw new Error(`open-vsx ${res.status}`);
	}
	const json = (await res.json()) as OpenVsxSearchResponse;
	let items = (json.extensions ?? []).map(normalizeOpenVsxItem).filter((e): e is NormalizedExtension => !!e);

	// Filter by target platform if specified
	if (targetPlatform) {
		items = filterByTargetPlatform(items, targetPlatform);
	}

	return { items, total: json.totalSize ?? items.length };
}

/**
 * Filters Open VSX extensions by target platform.
 * Open VSX URLs contain the platform in the path:
 *   https://open-vsx.org/api/{ns}/{name}/{platform}/{version}/file/...
 */
function filterByTargetPlatform(items: NormalizedExtension[], targetPlatform: string): NormalizedExtension[] {
	// Try to find an exact match first
	const exactMatch = items.filter(item => item.downloadUrl.includes(`/${targetPlatform}/`));
	if (exactMatch.length > 0) {
		return exactMatch;
	}

	// If no exact match, try without platform (universal extensions)
	const universal = items.filter(item => !item.downloadUrl.match(/\/(win32|x64|arm64|linux|darwin|alpine)[^/]*\//));
	if (universal.length > 0) {
		return universal;
	}

	// Fallback: return first item (allows install to proceed even without perfect match)
	return items.slice(0, 1);
}
