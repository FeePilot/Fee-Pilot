//! Offline order notes synced from clients. Keyed by the client's idempotency key.

use std::future::Future;

use feepilot_core::Network;
use serde::Serialize;
use sqlx::types::Json;
use sqlx::Row;
use uuid::Uuid;

use crate::{network_str, MemStore, PgStore, StoreError};

/// The fields a client supplies. Two payloads are "the same" when all of these match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewOrder {
    pub idempotency_key: Uuid,
    pub client_id: Uuid,
    pub network: Network,
    pub amount_sat: u64,
    pub memo: String,
    pub txid: Option<String>,
    pub client_created_at: i64,
    pub schema_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OrderState {
    AwaitingVerification,
    Seen,
    /// A different transaction spends the same inputs. Not the same as "not seen".
    Replaced,
    /// This node does not see it. That does not prove it does not exist.
    NotSeen,
}

impl OrderState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::AwaitingVerification => "awaiting_verification",
            Self::Seen => "seen",
            Self::Replaced => "replaced",
            Self::NotSeen => "not_seen",
        }
    }

    fn parse(s: &str) -> Result<Self, StoreError> {
        match s {
            "awaiting_verification" => Ok(Self::AwaitingVerification),
            "seen" => Ok(Self::Seen),
            "replaced" => Ok(Self::Replaced),
            "not_seen" => Ok(Self::NotSeen),
            other => Err(StoreError(format!("unexpected order state {other:?}"))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StoredOrder {
    pub idempotency_key: Uuid,
    pub client_id: Uuid,
    pub amount_sat: u64,
    pub memo: String,
    pub txid: Option<String>,
    pub client_created_at: i64,
    pub state: OrderState,
    /// Last verification result, if the order has a txid and the node was reachable.
    pub observation: Option<serde_json::Value>,
}

impl StoredOrder {
    fn matches(&self, new: &NewOrder) -> bool {
        self.client_id == new.client_id
            && self.amount_sat == new.amount_sat
            && self.memo == new.memo
            && self.txid == new.txid
            && self.client_created_at == new.client_created_at
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Upsert {
    /// First time this key was seen.
    Created,
    /// The key exists with an identical payload; nothing changed.
    Existing,
    /// The key exists with a different payload; the stored one is kept.
    Conflict,
}

pub trait OrderStore: Send + Sync {
    /// Insert unless the key exists. Returns the stored row (the first payload wins).
    fn upsert_order(
        &self,
        new: &NewOrder,
    ) -> impl Future<Output = Result<(StoredOrder, Upsert), StoreError>> + Send;

    /// Record a verification result for an order.
    fn set_verification(
        &self,
        key: Uuid,
        state: OrderState,
        observation: Option<serde_json::Value>,
    ) -> impl Future<Output = Result<(), StoreError>> + Send;
}

fn order_from_row(row: &sqlx::postgres::PgRow) -> Result<StoredOrder, StoreError> {
    let observation: Option<Json<serde_json::Value>> = row.try_get("observation")?;
    Ok(StoredOrder {
        idempotency_key: row.try_get("idempotency_key")?,
        client_id: row.try_get("client_id")?,
        amount_sat: row.try_get::<i64, _>("amount_sat")? as u64,
        memo: row.try_get("memo")?,
        txid: row.try_get("txid")?,
        client_created_at: row.try_get("client_created_at")?,
        state: OrderState::parse(&row.try_get::<String, _>("state")?)?,
        observation: observation.map(|j| j.0),
    })
}

const ORDER_COLUMNS: &str =
    "idempotency_key, client_id, amount_sat, memo, txid, client_created_at, state, observation";

impl OrderStore for PgStore {
    async fn upsert_order(&self, new: &NewOrder) -> Result<(StoredOrder, Upsert), StoreError> {
        let inserted = sqlx::query(
            "INSERT INTO orders (idempotency_key, client_id, network, amount_sat, memo, txid,
                                 client_created_at, schema_version)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (idempotency_key) DO NOTHING",
        )
        .bind(new.idempotency_key)
        .bind(new.client_id)
        .bind(network_str(new.network))
        .bind(new.amount_sat as i64)
        .bind(&new.memo)
        .bind(&new.txid)
        .bind(new.client_created_at)
        .bind(new.schema_version as i32)
        .execute(&self.pool)
        .await?
        .rows_affected()
            == 1;
        let row = sqlx::query(&format!(
            "SELECT {ORDER_COLUMNS} FROM orders WHERE idempotency_key = $1"
        ))
        .bind(new.idempotency_key)
        .fetch_one(&self.pool)
        .await?;
        let stored = order_from_row(&row)?;
        let outcome = if inserted {
            Upsert::Created
        } else if stored.matches(new) {
            Upsert::Existing
        } else {
            Upsert::Conflict
        };
        Ok((stored, outcome))
    }

    async fn set_verification(
        &self,
        key: Uuid,
        state: OrderState,
        observation: Option<serde_json::Value>,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "UPDATE orders SET state = $2, observation = $3, updated_at = now()
             WHERE idempotency_key = $1",
        )
        .bind(key)
        .bind(state.as_str())
        .bind(observation.map(Json))
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

impl OrderStore for MemStore {
    async fn upsert_order(&self, new: &NewOrder) -> Result<(StoredOrder, Upsert), StoreError> {
        let mut orders = self.orders.lock().unwrap();
        if let Some(existing) = orders.get(&new.idempotency_key) {
            let outcome = if existing.matches(new) {
                Upsert::Existing
            } else {
                Upsert::Conflict
            };
            return Ok((existing.clone(), outcome));
        }
        let stored = StoredOrder {
            idempotency_key: new.idempotency_key,
            client_id: new.client_id,
            amount_sat: new.amount_sat,
            memo: new.memo.clone(),
            txid: new.txid.clone(),
            client_created_at: new.client_created_at,
            state: OrderState::AwaitingVerification,
            observation: None,
        };
        orders.insert(new.idempotency_key, stored.clone());
        Ok((stored, Upsert::Created))
    }

    async fn set_verification(
        &self,
        key: Uuid,
        state: OrderState,
        observation: Option<serde_json::Value>,
    ) -> Result<(), StoreError> {
        if let Some(o) = self.orders.lock().unwrap().get_mut(&key) {
            o.state = state;
            o.observation = observation;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new(key: u128, amount: u64) -> NewOrder {
        NewOrder {
            idempotency_key: Uuid::from_u128(key),
            client_id: Uuid::from_u128(key + 1000),
            network: Network::Regtest,
            amount_sat: amount,
            memo: "m".into(),
            txid: None,
            client_created_at: 5,
            schema_version: 1,
        }
    }

    #[tokio::test]
    async fn resync_is_idempotent_and_conflicts_are_reported_not_applied() {
        let store = MemStore::default();
        let (_, first) = store.upsert_order(&new(1, 100)).await.unwrap();
        let (_, again) = store.upsert_order(&new(1, 100)).await.unwrap();
        let (kept, clash) = store.upsert_order(&new(1, 999)).await.unwrap();
        assert_eq!(
            (first, again, clash),
            (Upsert::Created, Upsert::Existing, Upsert::Conflict)
        );
        assert_eq!(kept.amount_sat, 100, "the first payload wins");
        assert_eq!(store.orders.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn verification_updates_the_state() {
        let store = MemStore::default();
        store.upsert_order(&new(2, 5)).await.unwrap();
        store
            .set_verification(Uuid::from_u128(2), OrderState::Seen, None)
            .await
            .unwrap();
        let (o, _) = store.upsert_order(&new(2, 5)).await.unwrap();
        assert_eq!(o.state, OrderState::Seen);
    }
}
