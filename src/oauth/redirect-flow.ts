import { randomUUID } from "node:crypto";
import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { connectOnce, runOAuthFlow, type OAuthTarget } from "./auth-flow.ts";
import { assertHttpUrl } from "./browser.ts";
import { SpecCliOAuthProvider } from "./provider.ts";
import {
  getClientSecret,
  loadTokenFile,
  saveTokenFile,
  type PendingAuthorization,
} from "./tokens.ts";

export type AuthorizationStart =
  | { status: "authorized"; flow: "client_credentials" | "none_required" }
  | { status: "redirect"; authorizationUrl: string };

export interface AuthorizationCallback {
  code: string;
  state: string;
}

const PENDING_TTL_MS = 10 * 60 * 1000;

function livePending(name: string): Record<string, PendingAuthorization> {
  const now = Date.now();
  return Object.fromEntries(
    Object.entries(loadTokenFile(name).pending ?? {}).filter(
      ([, pending]) => now - pending.createdAt < PENDING_TTL_MS
    )
  );
}

function updatePending(
  name: string,
  change: (pending: Record<string, PendingAuthorization>) => void
): void {
  const pending = livePending(name);
  change(pending);
  saveTokenFile(name, { pending: Object.keys(pending).length ? pending : undefined });
}

class RedirectOAuthProvider extends SpecCliOAuthProvider {
  #name: string;
  #entry: OAuthTarget;
  #redirectUrl: string;
  #state: string;
  #codeVerifier: string | undefined;
  clientInfo: OAuthClientInformationMixed | undefined;
  authorizationUrl: URL | undefined;

  constructor(
    name: string,
    entry: OAuthTarget,
    redirectUrl: string,
    state: string = randomUUID(),
    clientInfo?: OAuthClientInformationMixed
  ) {
    super(name, entry);
    this.#name = name;
    this.#entry = entry;
    this.#redirectUrl = redirectUrl;
    this.#state = state;
    this.clientInfo = clientInfo;
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

  override tokens(): OAuthTokens | undefined {
    return undefined;
  }

  override saveTokens(tokens: OAuthTokens): void {
    saveTokenFile(
      this.#name,
      this.clientInfo ? { tokens, clientInfo: this.clientInfo } : { tokens }
    );
  }

  override clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.clientInfo) return this.clientInfo;
    if (!this.#entry.oauthClientId) return undefined;
    const clientSecret = getClientSecret(this.#name);
    return clientSecret
      ? { client_id: this.#entry.oauthClientId, client_secret: clientSecret }
      : { client_id: this.#entry.oauthClientId };
  }

  override saveClientInformation(info: OAuthClientInformationMixed): void {
    this.clientInfo = info;
  }

  override saveCodeVerifier(codeVerifier: string): void {
    this.#codeVerifier = codeVerifier;
  }

  override codeVerifier(): string {
    if (!this.#codeVerifier) throw new Error("No code verifier saved");
    return this.#codeVerifier;
  }

  override async prepareRedirect(): Promise<void> {}

  override redirectToAuthorization(authorizationUrl: URL): void {
    const pending: PendingAuthorization = {
      codeVerifier: this.codeVerifier(),
      redirectUrl: this.#redirectUrl,
      createdAt: Date.now(),
      ...(this.clientInfo ? { clientInfo: this.clientInfo } : {}),
    };
    updatePending(this.#name, (all) => {
      all[this.#state] = pending;
    });
    this.authorizationUrl = authorizationUrl;
  }
}

export async function startRedirectAuthorization(
  name: string,
  entry: OAuthTarget,
  redirectUrl: string
): Promise<AuthorizationStart> {
  assertHttpUrl(redirectUrl, "OAuth redirect URL");
  if (entry.oauthFlow === "client_credentials") {
    if (!entry.oauthClientId || !getClientSecret(name))
      throw new Error(
        `'${name}' uses the client_credentials flow but has no client ID and secret configured.`
      );
    await runOAuthFlow(name, entry);
    return { status: "authorized", flow: "client_credentials" };
  }
  const provider = new RedirectOAuthProvider(name, entry, redirectUrl);
  try {
    await connectOnce(entry, provider);
    return { status: "authorized", flow: "none_required" };
  } catch (error) {
    if (error instanceof UnauthorizedError && provider.authorizationUrl)
      return { status: "redirect", authorizationUrl: provider.authorizationUrl.toString() };
    updatePending(name, (all) => {
      delete all[provider.state()];
    });
    throw error;
  }
}

export async function finishRedirectAuthorization(
  name: string,
  entry: OAuthTarget,
  { code, state }: AuthorizationCallback
): Promise<void> {
  const all = livePending(name);
  if (!Object.keys(all).length) throw new Error(`No sign-in is in progress for '${name}'.`);
  const pending = all[state];
  if (!pending) throw new Error("OAuth state mismatch — possible CSRF attack");
  updatePending(name, (current) => {
    delete current[state];
  });
  const provider = new RedirectOAuthProvider(
    name,
    entry,
    pending.redirectUrl,
    state,
    pending.clientInfo
  );
  provider.saveCodeVerifier(pending.codeVerifier);
  const result = await auth(provider, { serverUrl: entry.url, authorizationCode: code });
  if (result !== "AUTHORIZED") throw new Error(`Authorization for '${name}' did not complete.`);
  if (provider.clientInfo) saveTokenFile(name, { clientInfo: provider.clientInfo });
}
