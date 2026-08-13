/*---------------------------------------------------------------------------------------------
 *  SideX — Low-level Tauri IPC bridge.
 *  Wraps `window.__TAURI__` with a graceful fallback when running outside
 *  the Tauri webview (e.g. in a plain browser during development).
 *--------------------------------------------------------------------------------------------*/

declare global {
	interface Window {
		__TAURI__?: {
			core: {
				invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
			};
		};
	}
}

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;

function getInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
	if (_invoke) {
		return _invoke;
	}
	// Tauri 2.x injects `window.__TAURI_INTERNALS__.invoke` directly;
	// older builds expose `window.__TAURI__.core.invoke`. Check both.
	const internals = (window as any).__TAURI_INTERNALS__;
	if (typeof internals?.invoke === 'function') {
		_invoke = internals.invoke.bind(internals);
		return _invoke;
	}
	if (window.__TAURI__?.core?.invoke) {
		_invoke = window.__TAURI__.core.invoke;
		return _invoke;
	}
	return null;
}

export async function invoke<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
	const fn = getInvoke();
	if (!fn) {
		console.warn(`[SideX] invoke(${cmd}) — Tauri not available`);
		return null as unknown as T;
	}
	return fn(cmd, args) as Promise<T>;
}

export function isTauri(): boolean {
	return !!getInvoke();
}
