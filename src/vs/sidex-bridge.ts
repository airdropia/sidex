/*---------------------------------------------------------------------------------------------
 *  SideX — Low-level Tauri IPC bridge.
 *  Uses the official Tauri 2 API. Global fallbacks support older development shells.
 *--------------------------------------------------------------------------------------------*/

import { invoke as tauriInvoke } from '@tauri-apps/api/core';

declare global {
	interface Window {
		__TAURI__?: {
			core?: {
				invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
			};
		};
		__TAURI_INTERNALS__?: {
			invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
		};
	}
}

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;

function getInvoke(): (cmd: string, args?: Record<string, unknown>) => Promise<unknown> {
	if (_invoke) {
		return _invoke;
	}

	const internals = window.__TAURI_INTERNALS__?.invoke;
	if (typeof internals === 'function') {
		_invoke = internals.bind(window.__TAURI_INTERNALS__);
		return _invoke;
	}

	const globalInvoke = window.__TAURI__?.core?.invoke;
	if (typeof globalInvoke === 'function') {
		_invoke = globalInvoke.bind(window.__TAURI__?.core);
		return _invoke;
	}

	_invoke = tauriInvoke;
	return _invoke;
}

export async function invoke<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
	try {
		return (await getInvoke()(cmd, args)) as T;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`[SideX] Tauri command '${cmd}' failed: ${message}`);
	}
}

export function isTauri(): boolean {
	return typeof getInvoke() === 'function';
}
