/*---------------------------------------------------------------------------------------------
 *  SideX — Tauri-backed file system provider.
 *  Handles `file` and `vscode-file` schemes by delegating all I/O to the
 *  Rust backend via `invoke()` from @tauri-apps/api/core.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { URI } from '../../../base/common/uri.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import {
	FileChangeType,
	FileSystemProviderCapabilities,
	FileSystemProviderErrorCode,
	FileType,
	createFileSystemProviderError,
	IFileChange,
	IFileDeleteOptions,
	IFileOverwriteOptions,
	IFileWriteOptions,
	IStat,
	IWatchOptions,
	IFileSystemProviderWithFileReadWriteCapability,
	FilePermission
} from '../common/files.js';

interface TauriFileStat {
	size: number;
	is_dir: boolean;
	is_file: boolean;
	is_symlink: boolean;
	modified: number;
	created: number;
	readonly: boolean;
}

interface TauriDirEntry {
	name: string;
	path: string;
	is_dir: boolean;
	is_file: boolean;
	is_symlink: boolean;
	size: number;
	modified: number;
}

interface TauriWatchEvent {
	path: string;
	kind: string;
	is_dir: boolean;
}

interface TauriWatchBatch {
	watch_id: number;
	events: TauriWatchEvent[];
}

export class TauriFileSystemProvider extends Disposable implements IFileSystemProviderWithFileReadWriteCapability {
	readonly capabilities: FileSystemProviderCapabilities =
		FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive;

	readonly onDidChangeCapabilities = Event.None;

	private readonly _onDidChangeFile = this._register(new Emitter<readonly IFileChange[]>());
	readonly onDidChangeFile = this._onDidChangeFile.event;

	private readonly _activeWatches = new Map<number, IDisposable>();
	private _watchBatchUnlisten: UnlistenFn | undefined;
	private _watchListenerRefCount = 0;

	static toPath(resource: URI): string {
		if (resource.scheme === 'vscode-file') {
			return decodeURIComponent(resource.path);
		}
		if (resource.scheme === 'sidex-asset') {
			let path = resource.path;
			// If the path starts with a raw Windows drive letter (e.g. /c:/ or c:/),
			// decodeURIComponent may not work properly. Normalize by stripping
			// leading slash and then using the raw path.
			if (path.startsWith('/') && path.length > 2 && path[2] === ':') {
				// It's a raw Windows path like /c:/Users/... -> return as-is after removing leading slash
				return path.substring(1);
			}
			// If it's already percent-encoded, decode it
			try {
				return decodeURIComponent(path);
			} catch {
				// If decoding fails, return the path as-is (might be raw)
				return path;
			}
		}
		return resource.fsPath;
	}

	private static toError(err: unknown, resource: URI, code: FileSystemProviderErrorCode): Error {
		const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
		return createFileSystemProviderError(msg, code);
	}

	private static toFileChangeType(kind: string): FileChangeType | undefined {
		switch (kind) {
			case 'created':
				return FileChangeType.ADDED;
			case 'modified':
				return FileChangeType.UPDATED;
			case 'deleted':
				return FileChangeType.DELETED;
			case 'renamed_to':
				return FileChangeType.ADDED;
			case 'renamed_from':
				return FileChangeType.DELETED;
			default:
				return undefined;
		}
	}

	private async _ensureWatchBatchListener(): Promise<void> {
		if (this._watchBatchUnlisten) {
			return;
		}
		this._watchBatchUnlisten = await listen<TauriWatchBatch>('watch-batch', event => {
			const batch = event.payload;
			if (!batch?.events?.length) {
				return;
			}
			const changes: IFileChange[] = [];
			for (const e of batch.events) {
				const type = TauriFileSystemProvider.toFileChangeType(e.kind);
				if (type === undefined) {
					continue;
				}
				changes.push({ type, resource: URI.file(e.path) });
			}
			if (changes.length > 0) {
				this._onDidChangeFile.fire(changes);
			}
		});
	}

	async stat(resource: URI): Promise<IStat> {
		const path = TauriFileSystemProvider.toPath(resource);
		let raw: TauriFileStat;
		try {
			raw = await invoke<TauriFileStat>('stat', { path });
		} catch (err) {
			const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
			const isNotFound = /no such file|not found|ENOENT/i.test(msg);
			if (!isNotFound) {
				console.debug('[SideX-FS] stat failed:', path, err);
			}
			throw TauriFileSystemProvider.toError(err, resource, FileSystemProviderErrorCode.FileNotFound);
		}

		let type: FileType;
		if (raw.is_dir) {
			type = FileType.Directory;
		} else if (raw.is_symlink) {
			type = FileType.SymbolicLink;
		} else {
			type = FileType.File;
		}

		return {
			type,
			mtime: raw.modified * 1000,
			ctime: raw.created * 1000,
			size: raw.size,
			permissions: raw.readonly ? FilePermission.Readonly : undefined
		};
	}

	async readdir(resource: URI): Promise<[string, FileType][]> {
		const path = TauriFileSystemProvider.toPath(resource);
		let entries: TauriDirEntry[];
		try {
			entries = await invoke<TauriDirEntry[]>('read_dir', { path });
		} catch (err) {
			const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
			const isNotFound = /no such file|not found|ENOENT/i.test(msg);
			if (!isNotFound) {
				console.debug('[SideX-FS] readdir failed:', path, err);
			}
			throw TauriFileSystemProvider.toError(err, resource, FileSystemProviderErrorCode.FileNotFound);
		}

		return entries.map(e => {
			let ft: FileType;
			if (e.is_dir) {
				ft = FileType.Directory;
			} else if (e.is_symlink) {
				ft = FileType.SymbolicLink;
			} else {
				ft = FileType.File;
			}
			return [e.name, ft] as [string, FileType];
		});
	}

	async readFile(resource: URI): Promise<Uint8Array> {
		const path = TauriFileSystemProvider.toPath(resource);
		let bytes: number[];
		try {
			bytes = await invoke<number[]>('read_file_bytes', { path });
		} catch (err) {
			throw TauriFileSystemProvider.toError(err, resource, FileSystemProviderErrorCode.FileNotFound);
		}
		return new Uint8Array(bytes);
	}

	async writeFile(resource: URI, content: Uint8Array, _opts: IFileWriteOptions): Promise<void> {
		const path = TauriFileSystemProvider.toPath(resource);
		try {
			await invoke('write_file_bytes', { path, content: Array.from(content) });
		} catch (err) {
			throw TauriFileSystemProvider.toError(err, resource, FileSystemProviderErrorCode.Unknown);
		}
	}

	async mkdir(resource: URI): Promise<void> {
		const path = TauriFileSystemProvider.toPath(resource);
		try {
			await invoke('mkdir', { path, recursive: true });
		} catch (err) {
			throw TauriFileSystemProvider.toError(err, resource, FileSystemProviderErrorCode.Unknown);
		}
	}

	async delete(resource: URI, opts: IFileDeleteOptions): Promise<void> {
		const path = TauriFileSystemProvider.toPath(resource);
		try {
			await invoke('remove', { path, recursive: opts.recursive });
		} catch (err) {
			throw TauriFileSystemProvider.toError(err, resource, FileSystemProviderErrorCode.FileNotFound);
		}
	}

	async rename(from: URI, to: URI, opts: IFileOverwriteOptions): Promise<void> {
		const oldPath = TauriFileSystemProvider.toPath(from);
		const newPath = TauriFileSystemProvider.toPath(to);

		if (!opts.overwrite) {
			let exists: boolean;
			try {
				exists = await invoke<boolean>('exists', { path: newPath });
			} catch {
				exists = false;
			}
			if (exists) {
				throw createFileSystemProviderError(
					`Unable to rename — target '${newPath}' already exists`,
					FileSystemProviderErrorCode.FileExists
				);
			}
		}

		try {
			await invoke('rename', { oldPath, newPath });
		} catch (err) {
			throw TauriFileSystemProvider.toError(err, from, FileSystemProviderErrorCode.Unknown);
		}
	}

	watch(resource: URI, opts: IWatchOptions): IDisposable {
		const path = TauriFileSystemProvider.toPath(resource);
		let watchId: number | undefined;
		let disposed = false;

		this._watchListenerRefCount++;
		this._ensureWatchBatchListener().catch(() => {});

		invoke<number>('watch_start', {
			paths: [path],
			options: {
				recursive: opts.recursive,
				debounce_ms: 100,
				ignore_patterns: opts.excludes.length > 0 ? opts.excludes : undefined
			}
		}).then(
			id => {
				if (disposed) {
					invoke('watch_stop', { id }).catch(() => {});
					return;
				}
				watchId = id;
			},
			() => {}
		);

		return toDisposable(() => {
			disposed = true;
			this._watchListenerRefCount--;
			if (watchId !== undefined) {
				invoke('watch_stop', { id: watchId }).catch(() => {});
			}
			if (this._watchListenerRefCount <= 0 && this._watchBatchUnlisten) {
				this._watchBatchUnlisten();
				this._watchBatchUnlisten = undefined;
				this._watchListenerRefCount = 0;
			}
		});
	}
}
