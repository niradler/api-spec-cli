import { randomUUID } from "node:crypto";
import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { connectOnce, runOAuthFlow, type OAuthTarget } from "./auth-flow.ts";
import { SpecCliOAuthProvider } from "./provider.ts";
import { loadTokenFile, saveTokenFile } from "./tokens.ts";

export type AuthorizationStart =
  | { status: "authorized"; flow: "client_credentials" | "none_required" }
  | { status: "redirect"; authorizationUrl: string };

export interface AuthorizationCallback {
  code: string;
  state: string;
}

/**
 * Authorization-code + PKCE for hosts that receive the callback themselves (a web app or
 * server) instead of a local listener. The authorization URL is handed back to the caller,
 * and the PKCE verifier and state are kept in the token file until the callback arrives.
 */
class RedirectOAuthProvider extends SpecCliOAuthProvider {
  #name: string;
  #redirectUrl: string;
  #state: string;
  #codeVerifier: string | undefined;
  authorizationUrl: URL | undefined;

  constructor(name: string, entry: OAuthTarget, redirectUrl: string, state: string = randomUUID()) {
    super(name, entry);
    this.#name = name;
    this.#redirectUrl = redirectUrl;
    this.#state = state;
  }

  override get redirectUrl(): string {
    return this.#redirectUrl;
  }

  override get clientMetadata(): OAuthClientMetadata {
    return { ...super.clientMetadata, redirect_uris: [this.#redirectUrl] };
  }

  override state(): string {
    return this.#state;
  }

  override saveCodeVerifier(codeVerifier: string): void {
    this.#codeVerifier = codeVerifier;
  }

  override codeVerifier(): string {
    const verifier = this.#codeVerifier ?? loadTokenFile(this.#name).pending?.codeVerifier;
    if (!verifier) throw new Error("No code verifier saved");
    return verifier;
  }

  override async prepareRedirect(): Promise<void> {}

  override redirectToAuthorization(authorizationUrl: URL): void {
    saveTokenFile(this.#name, {
      pending: {
        state: this.#state,
        codeVerifier: this.codeVerifier(),
        redirectUrl: this.#redirectUrl,
      },
    });
    this.authorizationUrl = authorizationUrl;
  }
}

function assertRedirectUrl(redirectUrl: string): void {
  let url: URL;
  try {
    url = new URL(redirectUrl);
  } catch {
    throw new Error(`Invalid OAuth redirect URL '${redirectUrl}'.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("OAuth redirect URL must use http or https.");
}

export async function startRedirectAuthorization(
  name: string,
  entry: OAuthTarget,
  redirectUrl: string
): Promise<AuthorizationStart> {
  if (entry.oauthFlow === "client_credentials") {
    const { flow } = await runOAuthFlow(name, entry);
    return { status: "authorized", flow: flow === "browser" ? "none_required" : flow };
  }
  assertRedirectUrl(redirectUrl);
  const provider = new RedirectOAuthProvider(name, entry, redirectUrl);
  try {
    await connectOnce(entry, provider);
    return { status: "authorized", flow: "none_required" };
  } catch (error) {
    if (!(error instanceof UnauthorizedError) || !provider.authorizationUrl) throw error;
    return { status: "redirect", authorizationUrl: provider.authorizationUrl.toString() };
  }
}

export async function finishRedirectAuthorization(
  name: string,
  entry: OAuthTarget,
  { code, state }: AuthorizationCallback
): Promise<void> {
  const pending = loadTokenFile(name).pending;
  if (!pending) throw new Error(`No sign-in is in progress for '${name}'.`);
  if (state !== pending.state) throw new Error("OAuth state mismatch — possible CSRF attack");
  // The code is single use: drop the pending sign-in whether or not the exchange succeeds.
  saveTokenFile(name, { pending: undefined });
  const provider = new RedirectOAuthProvider(name, entry, pending.redirectUrl, pending.state);
  provider.saveCodeVerifier(pending.codeVerifier);
  const result = await auth(provider, { serverUrl: entry.url, authorizationCode: code });
  if (result !== "AUTHORIZED") throw new Error(`Authorization for '${name}' did not complete.`);
}
