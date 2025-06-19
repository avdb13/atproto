import { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("auth_callback")
    .addColumn("idpId", "varchar", (col) => col.primaryKey())
    .addColumn("scopes", "varchar", (col) => col.notNull())
    .addColumn("state", "varchar", (col) => col.notNull())
    .addColumn("nonce", "varchar", (col) => col.notNull())
    .addColumn("redirectUri", "varchar", (col) => col.notNull())
    .addColumn("codeVerifier", "varchar")
    .execute();
  await db.schema
    .createIndex("state_for_auth_callback_idx")
    .on("auth_callback")
    .column("state")
    .execute();

  await db.schema
    .createTable("auth_claims")
    .addColumn("did", "varchar", (col) => col.notNull())
    .addColumn("idpId", "varchar", (col) => col.notNull())
    .addColumn("sub", "varchar", (col) => col.notNull())
    .addColumn("picture", "varchar")
    .addColumn("email", "varchar")
    .addPrimaryKeyConstraint("app_password_pkey", ["did", "idpId"])
    .execute();
  await db.schema
    .createTable("identity_provider")
    .addColumn("id", "varchar", (col) => col.primaryKey())
    .addColumn("name", "varchar")
    .addColumn("icon", "varchar")
    .addColumn("issuer", "varchar", (col) => col.notNull())
    .addColumn("clientId", "varchar", (col) => col.notNull())
    .addColumn("clientSecret", "varchar", (col) => col.notNull())
    .addColumn("scopes", "varchar", (col) => col.notNull())
    .addColumn("usePkce", "integer", (col) => col.notNull())
    .addColumn("discoverable", "integer", (col) => col.notNull())
    .addColumn("metadata", "varchar")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("state_for_auth_callback_idx").execute();

  await db.schema.dropTable("auth_callback").execute();
  await db.schema.dropTable("auth_claims").execute();
  await db.schema.dropTable("identity_provider").execute();
}
