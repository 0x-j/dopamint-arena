//! One-off database migration binary for explorer.
//!
//! Runs Diesel migrations embedded in `backend/explorer/migrations` against the
//! database given by `DATABASE_URL`. Exits non-zero on any error so the deploy
//! pipeline can fail fast before rolling the ECS service.

use diesel::Connection;
use diesel_migrations::{embed_migrations, EmbeddedMigrations, MigrationHarness};

const MIGRATIONS: EmbeddedMigrations = embed_migrations!("migrations");

fn main() -> anyhow::Result<()> {
    let database_url = std::env::var("DATABASE_URL")
        .map_err(|_| anyhow::anyhow!("DATABASE_URL environment variable is required"))?;

    let mut conn = diesel::PgConnection::establish(&database_url)
        .map_err(|e| anyhow::anyhow!("failed to connect to DATABASE_URL: {e}"))?;

    let versions = conn
        .run_pending_migrations(MIGRATIONS)
        .map_err(|e| anyhow::anyhow!("database migration failed: {e}"))?;

    if versions.is_empty() {
        println!("no pending migrations");
    } else {
        for v in versions {
            println!("applied migration: {v}");
        }
    }

    Ok(())
}
