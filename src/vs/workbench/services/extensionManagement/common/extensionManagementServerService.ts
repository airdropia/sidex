/*---------------------------------------------------------------------------------------------
 *  SideX — Extension Management Server Service for Tauri builds.
 *
 *  Unlike the default web-only implementation, this registers a LOCAL
 *  extension management server so that all extension UI features work:
 *    - "Install from VSIX..." menu item appears
 *    - Extensions panel can install/uninstall local extensions
 *    - Context keys CONTEXT_HAS_LOCAL_SERVER / CONTEXT_HAS_REMOTE_SERVER
 *      become true, un-hiding extension actions.
 *
 *  The actual I/O is handled by WebExtensionManagementService with
 *  file-system operations routed through the Tauri FileSystemProvider
 *  registered in web.main.ts.
 *---------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import {
	ExtensionInstallLocation,
	IExtensionManagementServer,
	IExtensionManagementServerService
} from './extensionManagement.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { isWeb } from '../../../../base/common/platform.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WebExtensionManagementService } from './webExtensionManagementService.js';
import { IExtension } from '../../../../platform/extensions/common/extensions.js';

export class ExtensionManagementServerService implements IExtensionManagementServerService {
	declare readonly _serviceBrand: undefined;

	readonly localExtensionManagementServer: IExtensionManagementServer | null = null;
	readonly remoteExtensionManagementServer: IExtensionManagementServer | null = null;
	readonly webExtensionManagementServer: IExtensionManagementServer | null = null;

	constructor(@IInstantiationService instantiationService: IInstantiationService) {
		const isTauri =
			typeof (globalThis as any).__TAURI_INTERNALS__ !== 'undefined' ||
			typeof (globalThis as any).__TAURI__ !== 'undefined' ||
			(globalThis as any).__SIDEX_TAURI__ === true;

		if (isTauri) {
			// Register a local server for native Tauri mode
			// WebExtensionManagementService uses the registered TauriFileSystemProvider
			// for file I/O, so no changes needed there
			const extensionManagementService = instantiationService.createInstance(WebExtensionManagementService);
			this.localExtensionManagementServer = {
				id: 'local',
				extensionManagementService,
				label: localize('local', 'Local')
			};
		} else if (isWeb) {
			// Fallback to web-only behavior
			const extensionManagementService = instantiationService.createInstance(WebExtensionManagementService);
			this.webExtensionManagementServer = {
				id: 'web',
				extensionManagementService,
				label: localize('browser', 'Browser')
			};
		}
	}

	getExtensionManagementServer(extension: IExtension): IExtensionManagementServer | null {
		if (this.localExtensionManagementServer) {
			return this.localExtensionManagementServer;
		}
		if (this.webExtensionManagementServer) {
			return this.webExtensionManagementServer;
		}
		throw new Error(`Invalid Extension ${extension.location}`);
	}

	getExtensionInstallLocation(_extension: IExtension): ExtensionInstallLocation | null {
		if (this.localExtensionManagementServer) {
			return ExtensionInstallLocation.Local;
		}
		if (this.webExtensionManagementServer) {
			return ExtensionInstallLocation.Web;
		}
		return null;
	}
}

registerSingleton(IExtensionManagementServerService, ExtensionManagementServerService, InstantiationType.Delayed);
