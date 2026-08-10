/*---------------------------------------------------------------------------------------------
 *  SideX - Remote development service (stub).
 *
 *  The remote backend (SSH / WSL / Dev Containers / Codespaces) is not
 *  implemented in SideX. This service keeps the upstream remote UI alive
 *  without calling unregistered Tauri commands: listings return empty,
 *  connect/exec operations fail with a clear message.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';

export type RemoteKind = 'ssh' | 'wsl' | 'container' | 'codespace' | 'tunnel';

export interface SshHost {
	host: string;
	hostname: string | null;
	port: number | null;
	user: string | null;
	identityFile: string | null;
}

export interface WslDistro {
	name: string;
	isDefault: boolean;
	version: number;
	state: string;
}

export interface ContainerEntry {
	id: string;
	name: string;
	image: string;
	status: string;
	ports: string;
}

export interface CodespaceEntry {
	name: string;
	displayName: string;
	repository: string;
	branch: string;
	machineType: string;
	state: string;
	createdAt: string;
	lastUsed: string;
}

export interface RemoteConnection {
	id: number;
	kind: RemoteKind;
	label: string;
	connectedSecs: number;
}

export interface RemoteExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export type SshAuth =
	| { kind: 'password'; password: string }
	| { kind: 'keyfile'; path: string; passphrase?: string }
	| { kind: 'agent' };

function unsupported(): Error {
	return new Error('Remote development is not supported in SideX yet');
}

export const ISideXRemoteService = createDecorator<ISideXRemoteService>('sidexRemoteService');

export interface ISideXRemoteService extends SideXRemoteService {
	readonly _serviceBrand: undefined;
}

export class SideXRemoteService {
	declare readonly _serviceBrand: undefined;

	async listSshHosts(): Promise<SshHost[]> {
		return [];
	}

	async connectSsh(host: string, user: string, port: number | undefined, auth: SshAuth): Promise<RemoteConnection> {
		throw unsupported();
	}

	async connectWsl(distro: string): Promise<RemoteConnection> {
		throw unsupported();
	}

	async connectContainer(configPath: string): Promise<RemoteConnection> {
		throw unsupported();
	}

	async connectCodespace(name: string, githubToken: string): Promise<RemoteConnection> {
		throw unsupported();
	}

	async execSsh(connectionId: number, command: string): Promise<RemoteExecResult> {
		throw unsupported();
	}

	async listWslDistros(): Promise<WslDistro[]> {
		return [];
	}

	async listContainers(): Promise<ContainerEntry[]> {
		return [];
	}

	async listCodespaces(githubToken: string): Promise<CodespaceEntry[]> {
		return [];
	}

	async disconnect(connectionId: number): Promise<void> {
		throw unsupported();
	}

	async activeConnections(): Promise<RemoteConnection[]> {
		return [];
	}
}

let _instance: SideXRemoteService | null = null;

export function getSideXRemoteService(): SideXRemoteService {
	if (!_instance) {
		_instance = new SideXRemoteService();
	}
	return _instance;
}

registerSingleton(ISideXRemoteService, SideXRemoteService, InstantiationType.Delayed);