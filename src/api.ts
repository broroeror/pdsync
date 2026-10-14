// Minimal HTTP layer: adds the app-version header and session auth to every
// request against the Drive API, and refreshes the access token on 401.
import type { ProtonDriveHTTPClient } from '@protontech/drive-sdk';

// Per the SDK usage guidelines: `external-drive-{name}@{semver}-{channel}`.
// The name is a placeholder until the project has a final (non-Proton) name.
export const APP_VERSION = 'external-drive-pdsync@0.1.0-alpha';
export const API_BASE = 'https://drive-api.proton.me';

// Core API success codes: 1000 = OK, 1001 = OK (multi-status).
const SUCCESS_CODES = new Set([1000, 1001]);

export type Session = { uid: string; accessToken: string; refreshToken: string };

export class ApiError extends Error {
    constructor(
        public status: number,
        public code: number | undefined,
        message: string,
        public body: unknown,
    ) {
        super(message);
    }
}

export class Api {
    session?: Session;
    onSessionChange?: (session: Session) => void;

    private sessionHeaders(headers: Headers) {
        headers.set('x-pm-appversion', APP_VERSION);
        if (this.session) {
            headers.set('x-pm-uid', this.session.uid);
            headers.set('Authorization', `Bearer ${this.session.accessToken}`);
        }
    }

    /** JSON request against a core/drive API path, e.g. `core/v4/users`. */
    async request<T = any>(method: string, path: string, json?: object): Promise<T> {
        const send = () => {
            const headers = new Headers({ Accept: 'application/vnd.protonmail.v1+json' });
            if (json) headers.set('Content-Type', 'application/json');
            this.sessionHeaders(headers);
            return fetch(`${API_BASE}/${path}`, {
                method,
                headers,
                body: json ? JSON.stringify(json) : undefined,
                signal: AbortSignal.timeout(30_000),
            });
        };

        let response = await send();
        if (response.status === 401 && this.session) {
            await this.refresh();
            response = await send();
        }

        const body: any = await response.json().catch(() => ({}));
        if (!response.ok || (body.Code !== undefined && !SUCCESS_CODES.has(body.Code))) {
            throw new ApiError(response.status, body.Code, body.Error ?? response.statusText, body);
        }
        return body as T;
    }

    async refresh() {
        if (!this.session) throw new Error('No session to refresh');
        const body = await fetch(`${API_BASE}/core/v4/auth/refresh`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-pm-appversion': APP_VERSION,
                'x-pm-uid': this.session.uid,
            },
            body: JSON.stringify({
                UID: this.session.uid,
                RefreshToken: this.session.refreshToken,
                ResponseType: 'token',
                GrantType: 'refresh_token',
                RedirectURI: 'https://protonmail.ch',
            }),
            signal: AbortSignal.timeout(30_000),
        }).then((r) => r.json() as Promise<any>);

        if (body.Code !== 1000) {
            throw new ApiError(401, body.Code, `Session refresh failed: ${body.Error}`, body);
        }
        this.session = { uid: this.session.uid, accessToken: body.AccessToken, refreshToken: body.RefreshToken };
        this.onSessionChange?.(this.session);
    }

    /** The HTTP client handed to the SDK. */
    httpClient(): ProtonDriveHTTPClient {
        const send = async (request: {
            url: string;
            method: string;
            headers: Headers;
            timeoutMs: number;
            signal?: AbortSignal;
            json?: object;
            body?: any;
        }) => {
            const attempt = () => {
                const headers = new Headers(request.headers);
                // Only API calls carry the session. Block storage URLs live on
                // other hosts and are authorised by the SDK's own token header.
                if (request.url.startsWith(API_BASE)) {
                    this.sessionHeaders(headers);
                } else {
                    headers.set('x-pm-appversion', APP_VERSION);
                }
                let body = request.body;
                if (request.json) {
                    headers.set('Content-Type', 'application/json');
                    body = JSON.stringify(request.json);
                }
                const timeout = AbortSignal.timeout(request.timeoutMs);
                return fetch(request.url, {
                    method: request.method,
                    headers,
                    body,
                    signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
                });
            };

            let response = await attempt();
            if (response.status === 401 && this.session && request.url.startsWith(API_BASE)) {
                await this.refresh();
                response = await attempt();
            }
            return response;
        };

        return { fetchJson: send, fetchBlob: send };
    }
}
