import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/**
 * Extension point for authentication (see ARCHITECTURE.md §Authentication). Intentionally a no-op: auth is out of scope
 * for this challenge. A production deployment would validate an OIDC JWT issued by an external IdP (e.g. Keycloak),
 * map the token's client/azp claim to a providerId through a ProviderIdentityPort and reject requests whose body.providerId
 * differs. Health and metrics endpoints stay open.
 */
export interface ProviderIdentityPort { resolveProviderId(authorizationHeader: string | undefined): Promise<string | undefined>; }

@Injectable()
export class NoopAuthGuard implements CanActivate {
  canActivate(_ctx: ExecutionContext): boolean { return true; }
}
