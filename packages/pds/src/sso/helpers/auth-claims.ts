import { AuthClaims, SSODb } from "../db";

export const selectQB = (db: SSODb) =>
  db.db.selectFrom("auth_claims").selectAll();

export const getAuthClaims = (
  db: SSODb,
  did: string,
  idpId: string,
): Promise<AuthClaims | null> =>
  selectQB(db).where((qb) =>
    qb.where("did", "=", did).where("idpId", "=", idpId)
  )
    .executeTakeFirst().then((found) => found || null);

export const registerAuthClaims = (
  db: SSODb,
  opts: AuthClaims,
): Promise<[string, string] | null> =>
  db.executeWithRetry(
    db.db
      .insertInto("auth_claims")
      .values(opts)
      .onConflict((oc) => oc.doNothing())
      .returning(["did", "idpId"]),
  ).then(([res]) => res ? [res.did, res.idpId] : null);

export const deleteAuthClaims = (
  db: SSODb,
  did: string,
  idpId: string,
): Promise<void> =>
  db.executeWithRetry(
    db.db.deleteFrom("auth_claims").where("did", "=", did).where(
      "idpId",
      "=",
      idpId,
    ),
  ).then(() => {});

export const getAccountClaims = (
  db: SSODb,
  sub: string,
  idpId: string,
): Promise<AuthClaims | null> =>
  selectQB(db).where("sub", "=", sub).where(
    "idpId",
    "=",
    idpId,
  ).executeTakeFirst().then((found) => found || null);
