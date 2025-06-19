import { AuthCallback, AuthClaims, getDb, getMigrator, SSODb } from "./db";

import {
  Data,
  deleteIdentityProvider,
  fetchMetadata,
  getIdentityProvider,
  listIdentityProviders,
  registerIdentityProvider,
} from "./helpers/identity-provider";
import {
  deleteAuthCallback,
  getAuthCallback,
  registerAuthCallback,
} from "./helpers/auth-callback";
import {
  deleteAuthClaims,
  getAccountClaims,
  getAuthClaims,
  registerAuthClaims,
} from "./helpers/auth-claims";

export class SSOManager {
  readonly db: SSODb;

  constructor(
    public dbLocation: string,
    disableWalAutoCheckpoint = false,
  ) {
    this.db = getDb(dbLocation, disableWalAutoCheckpoint);
  }

  async migrateOrThrow() {
    await this.db.ensureWal();
    await getMigrator(this.db).migrateToLatestOrThrow();
  }

  close() {
    this.db.close();
  }

  listIdentityProviders() {
    return listIdentityProviders(this.db);
  }

  getIdentityProvider(
    id: string,
  ) {
    return getIdentityProvider(this.db, id);
  }

  createIdentityProvider(
    opts: Data,
  ) {
    return registerIdentityProvider(this.db, opts);
  }

  fetchMetadata(id: string) {
    return fetchMetadata(this.db, id);
  }

  deleteIdentityProvider(id: string) {
    return deleteIdentityProvider(this.db, id);
  }

  getAuthCallback(id: string) {
    return getAuthCallback(this.db, id);
  }

  createAuthCallback(opts: AuthCallback) {
    return registerAuthCallback(this.db, opts);
  }

  deleteAuthCallback(id: string) {
    return deleteAuthCallback(this.db, id);
  }

  getAuthClaims(did: string, idpId: string) {
    return getAuthClaims(this.db, did, idpId);
  }

  createAuthClaims(opts: AuthClaims) {
    return registerAuthClaims(this.db, opts);
  }

  deleteAuthClaims(did: string, idpId: string) {
    return deleteAuthClaims(this.db, did, idpId);
  }

  getAccountClaims(sub: string, idpId: string) {
    return getAccountClaims(this.db, sub, idpId);
  }
}
