/*---------------------------------------------------------------------------------------------
 *  SideX — Tauri-backed Local Extension Management Service.
 *
 *  This service handles local (file-based) extension installation, including
 *  VSIX files. It delegates to Tauri commands for the actual work:
 *    - install_extension(vsix_path) — installs from a local .vsix file
 *    - install_extension_from_url(url) — installs from a remote URL
 *    - install_extension_from_marketplace(id) — installs from marketplace
 *
 *  Unlike WebExtensionManagementService, this properly supports VSIX installs
 *  by routing through the native Tauri backend.
 *---------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import { ILocalExtension, IExtensionManifest, InstallOptions } from '../../../../../platform/extensionManagement/common/extensionManagement.js';
import { IExtensionManagementService } from '../../../../../platform/extensionManagement/common/extensionManagement.js';
import { ExtensionType, IExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IFileService } from '../../../../files/common/files.js';
import { ILogService } from '../../../../log/common/log.js';
import { IProductService } from '../../../../product/common/productService.js';
import { IUserDataProfileService } from '../../../../userDataProfile/common/userDataProfile.js';
import { IUriIdentityService } from '../../../../uriIdentity/common/uriIdentity.js';
import { isWeb } from '../../../../../base/common/platform.js';

export class TauriExtensionManagementService implements IExtensionManagementService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IProductService private readonly productService: IProductService,
		@IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService
	) {}

	async getManifest(vsix: URI): Promise<IExtensionManifest> {
		// Read package.json from the VSIX file
		// VSIX is a ZIP archive, so we need to extract and read it
		const path = vsix.fsPath;
		if (!path) {
			throw new Error('VSIX path is not available');
		}

		// Use Tauri command to install and get manifest info
		const result = await invoke<{ id: string; path: string }>('install_extension', { vsixPath: path });
		
		// Return a minimal manifest — full parsing happens during scan
		return {
			name: result.id.split('.')[1] ?? 'extension',
			displayName: result.id,
			version: '0.0.0',
			publisher: result.id.split('.')[0] ?? 'unknown',
			engines: { vscode: '*' },
			__metadata: {
				id: result.id,
				startTime: Date.now(),
				endTime: Date.now(),
				manifestHash: '',
				installFolder: result.path,
				resourceUrl: '',
				allArtifactUrls: [],
				isBuiltin: false,
				location: vsix
			}
		} as IExtensionManifest;
	}

	async install(vsix: URI, options?: InstallOptions): Promise<ILocalExtension> {
		const path = vsix.fsPath;
		if (!path) {
			throw new Error('VSIX path is not available');
		}

		this.logService.info(`[SideX] Installing extension from VSIX: ${path}`);
		
		const result = await invoke<{ id: string; path: string }>('install_extension', { vsixPath: path });
		
		this.logService.info(`[SideX] Extension installed: ${result.id} at ${result.path}`);

		return {
			identifier: { id: result.id, uuid: undefined },
			location: URI.file(result.path),
			manifest: await this.getManifest(vsix),
			type: ExtensionType.User,
			isBuiltin: false,
			isPreRelease: false,
			isMachineScoped: false,
			installSourcePath: path,
			installOrigin: undefined,
			installReason: undefined
		} as ILocalExtension;
	}

	async uninstall(extension: ILocalExtension, _options?: unknown): Promise<void> {
		const id = extension.identifier.id;
		this.logService.info(`[SideX] Uninstalling extension: ${id}`);
		await invoke('uninstall_extension', { extensionId: id });
	}

	async download(_gallery: any, _options?: any): Promise<URI> {
		throw new Error('Not supported');
	}

	async zip(_extension: ILocalExtension): Promise<URI> {
		throw new Error('Not supported');
	}

	getTargetPlatform(): Promise<string> {
		return Promise.resolve('win32-x64');
	}

	async getInstalled(_location?: URI): Promise<ILocalExtension[]> {
		// Scan extensions directory
		const extensionsDir = `${process.env.USERPROFILE}\\${'.sidex'}\\extensions`;
		try {
			const entries = await this.fileService.resolve([URI.file(extensionsDir)], CancellationToken.None, {
				type: 'directory'
			});
			// Return empty for now — scanning happens via Tauri event
			return [];
		} catch {
			return [];
		}
	}

	async copyExtensions(_from: ILocalExtension[], _to: URI): Promise<void> {
		throw new Error('Not supported');
	}

	async updateExtensionMetadata(_extension: ILocalExtension, _metadata: any): Promise<void> {
		// Metadata updates are handled by the backend
	}

	async getExtensionsControlManifest(): Promise<any> {
		return {};
	}

	async toggleApplicationScope(_extension: ILocalExtension, _profileLocation: URI): Promise<ILocalExtension> {
		throw new Error('Not supported');
	}

	async resetPinnedStateForAllUserExtensions(_pinned: boolean): Promise<void> {
		// No-op for now
	}

	registerParticipant(_participant: any): void {
		// No-op for now
	}

	get onInstallExtension() { return undefined as any; }
	get onDidInstallExtensions() { return undefined as any; }
	get onUninstallExtension() { return undefined as any; }
	get onDidUninstallExtension() { return undefined as any; }
	get onDidChangeProfile() { return undefined as any; }
}
