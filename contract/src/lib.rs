//! NEARnest vault.
//!
//! A policy wallet for a yield agent. The vault account holds the funds and has no
//! full-access key. The agent holds one function-call key on the vault account,
//! limited to `agent_supply` and `agent_withdraw`. Every rule below is enforced here,
//! so a compromised agent (stolen key, prompt injection, bad model output) can only
//! move money between the vault and venues the owner approved, in capped amounts.
//! Funds leave the vault/venue loop only to the owner.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PublicKey,
};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const GAS_FT_TRANSFER_CALL: Gas = Gas::from_tgas(80);
const GAS_VENUE_CALL: Gas = Gas::from_tgas(60);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(15);
const DAY_NS: u64 = 86_400 * 1_000_000_000;
/// Native NEAR the vault keeps for its own storage; the agent can never stake it.
const NATIVE_RESERVE: NearToken = NearToken::from_millinear(500);
/// Sentinel token id for native NEAR.
pub const NATIVE: &str = "near";

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Venues,
    Positions,
    MaxMove,
}

/// How the vault talks to a venue. Each kind fixes the exact calls the vault makes,
/// so the agent never chooses a receiver, a method or a message.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum VenueKind {
    /// Burrow-style lending (Rhea Lending is a Burrow fork). Supply = `ft_transfer_call`
    /// on the token with msg "" (supplied, not collateral). Withdraw = `execute` with a
    /// Withdraw action; the venue sends tokens back to the vault.
    LendingFt,
    /// Liquid staking (LiNEAR, stNEAR). Supply = `deposit_and_stake` with native NEAR
    /// attached. Withdraw = `unstake`, then `withdraw_all` after the unbonding delay.
    LiquidStake,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Venue {
    pub kind: VenueKind,
    /// Venue contract. Fixed at approval time.
    pub contract: AccountId,
    /// FT contract id, or "near" for native NEAR.
    pub token: String,
    /// Most the vault may hold in this venue, in token base units.
    pub max_alloc: U128,
    pub enabled: bool,
    /// Set by the risk feeder or owner. Blocked venues accept withdrawals only.
    pub blocked_reason: Option<String>,
    /// Lending venues that count balances in internal units (Rhea Lend uses token
    /// decimals + 12) need the withdraw amount scaled up by this many decimals.
    #[serde(default)]
    pub extra_decimals: u8,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Policy {
    /// Minimum gap between two supply moves, in seconds.
    pub cooldown_s: u64,
    /// Supply moves allowed per rolling UTC day.
    pub max_moves_per_day: u32,
}

#[near(serializers = [json])]
pub struct VaultView {
    pub owner: AccountId,
    pub agent_key: PublicKey,
    pub risk_feeder: Option<AccountId>,
    pub paused: bool,
    pub policy: Policy,
    pub last_move_ns: u64,
    pub moves_today: u32,
    pub day_start_ns: u64,
}

#[near(serializers = [json])]
pub struct VenueView {
    pub id: String,
    pub venue: Venue,
    /// Principal the vault has supplied and not yet withdrawn, as tracked by the vault.
    pub position: U128,
    pub max_move: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner: AccountId,
    agent_key: PublicKey,
    risk_feeder: Option<AccountId>,
    paused: bool,
    policy: Policy,
    venues: IterableMap<String, Venue>,
    positions: LookupMap<String, u128>,
    /// Per-token cap on a single supply move.
    max_move: LookupMap<String, u128>,
    last_move_ns: u64,
    day_start_ns: u64,
    moves_today: u32,
}

/// Token units to a venue's internal units.
pub fn scale_up(amount: u128, extra_decimals: u8) -> u128 {
    amount
        .checked_mul(10u128.pow(extra_decimals as u32))
        .unwrap_or_else(|| env::panic_str("amount overflows venue units"))
}

fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "nearnest", "version": "1.0.0", "event": event, "data": [data]})
    ));
}

#[near]
impl Vault {
    #[init]
    pub fn new(owner: AccountId, agent_key: PublicKey, policy: Policy) -> Self {
        Self {
            owner,
            agent_key,
            risk_feeder: None,
            paused: false,
            policy,
            venues: IterableMap::new(Key::Venues),
            positions: LookupMap::new(Key::Positions),
            max_move: LookupMap::new(Key::MaxMove),
            last_move_ns: 0,
            day_start_ns: 0,
            moves_today: 0,
        }
    }

    // ---------------------------------------------------------------- agent

    /// Move `amount` of the venue's token from the vault into the venue.
    pub fn agent_supply(&mut self, venue_id: String, amount: U128) -> Promise {
        self.assert_agent();
        require!(!self.paused, "paused");
        let venue = self.venue(&venue_id);
        require!(venue.enabled, "venue disabled");
        if let Some(reason) = &venue.blocked_reason {
            env::panic_str(&format!("venue blocked: {reason}"));
        }
        let amount = amount.0;
        require!(amount > 0, "zero amount");
        let cap = self.max_move.get(&venue.token).copied().unwrap_or(0);
        if amount > cap {
            env::panic_str(&format!("move {amount} exceeds per-move cap {cap}"));
        }
        let position = self.position(&venue_id);
        if position + amount > venue.max_alloc.0 {
            env::panic_str(&format!(
                "allocation {} would exceed venue cap {}",
                position + amount,
                venue.max_alloc.0
            ));
        }
        self.check_rate();

        // Reserve the allocation before the async call; the callback releases what
        // the venue did not take.
        self.positions.insert(venue_id.clone(), position + amount);
        self.record_move();
        emit("supply_started", json!({"venue": venue_id, "amount": U128(amount)}));

        let call = match venue.kind {
            VenueKind::LendingFt => {
                require!(venue.token != NATIVE, "lending venue needs an FT token");
                let token: AccountId = venue.token.parse().unwrap();
                Promise::new(token).function_call(
                    "ft_transfer_call",
                    json!({"receiver_id": venue.contract, "amount": U128(amount), "msg": ""})
                        .to_string()
                        .into_bytes(),
                    ONE_YOCTO,
                    GAS_FT_TRANSFER_CALL,
                )
            }
            VenueKind::LiquidStake => {
                require!(venue.token == NATIVE, "staking venue takes native NEAR");
                let spendable = env::account_balance().saturating_sub(NATIVE_RESERVE);
                require!(NearToken::from_yoctonear(amount) <= spendable, "not enough spendable NEAR");
                Promise::new(venue.contract.clone()).function_call(
                    "deposit_and_stake",
                    b"{}".to_vec(),
                    NearToken::from_yoctonear(amount),
                    GAS_VENUE_CALL,
                )
            }
        };
        call.then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CALLBACK)
                .on_supply(venue_id, U128(amount)),
        )
    }

    /// Pull `amount` back from a venue into the vault. Allowed even when the venue is
    /// blocked or the vault is paused, and exempt from the cooldown: exiting risk is
    /// never rate-limited.
    pub fn agent_withdraw(&mut self, venue_id: String, amount: U128) -> Promise {
        self.assert_agent();
        let venue = self.venue(&venue_id);
        let amount = amount.0;
        require!(amount > 0, "zero amount");
        emit("withdraw_started", json!({"venue": venue_id, "amount": U128(amount)}));
        let call = match venue.kind {
            VenueKind::LendingFt => Promise::new(venue.contract.clone()).function_call(
                "execute",
                json!({"actions": [{"Withdraw": {"token_id": venue.token, "max_amount": U128(scale_up(amount, venue.extra_decimals))}}]})
                    .to_string()
                    .into_bytes(),
                ONE_YOCTO,
                GAS_VENUE_CALL,
            ),
            VenueKind::LiquidStake => Promise::new(venue.contract.clone()).function_call(
                "unstake",
                json!({"amount": U128(amount)}).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_VENUE_CALL,
            ),
        };
        call.then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CALLBACK)
                .on_withdraw(venue_id, U128(amount)),
        )
    }

    /// Finish a liquid-staking exit after the unbonding delay. Funds land in the vault.
    pub fn agent_claim_unstaked(&mut self, venue_id: String) -> Promise {
        self.assert_agent();
        let venue = self.venue(&venue_id);
        require!(venue.kind == VenueKind::LiquidStake, "not a staking venue");
        Promise::new(venue.contract).function_call(
            "withdraw_all",
            b"{}".to_vec(),
            NearToken::from_yoctonear(0),
            GAS_VENUE_CALL,
        )
    }

    // ------------------------------------------------------------ callbacks

    #[private]
    pub fn on_supply(&mut self, venue_id: String, amount: U128) -> U128 {
        // ft_transfer_call returns the amount the receiver used; deposit_and_stake
        // returns nothing useful on success. A failed call used nothing.
        let venue = self.venue(&venue_id);
        let used = match (env::promise_result_checked(0, 256), &venue.kind) {
            (Ok(bytes), VenueKind::LendingFt) => {
                serde_json::from_slice::<U128>(&bytes).map(|u| u.0).unwrap_or(0)
            }
            (Ok(_), VenueKind::LiquidStake) => amount.0,
            // TooLong still means the call succeeded; only a lending venue reports
            // usage, and its answer is a short string, so treat TooLong as unknown = 0.
            (Err(_), _) => 0,
        };
        let used = used.min(amount.0);
        let unused = amount.0 - used;
        if unused > 0 {
            let pos = self.position(&venue_id);
            self.positions.insert(venue_id.clone(), pos.saturating_sub(unused));
        }
        emit("supply_done", json!({"venue": venue_id, "requested": amount, "used": U128(used)}));
        U128(used)
    }

    #[private]
    pub fn on_withdraw(&mut self, venue_id: String, amount: U128) -> bool {
        let ok = !matches!(env::promise_result_checked(0, 256), Err(near_sdk::PromiseError::Failed));
        if ok {
            let pos = self.position(&venue_id);
            self.positions.insert(venue_id.clone(), pos.saturating_sub(amount.0));
        }
        emit("withdraw_done", json!({"venue": venue_id, "amount": amount, "ok": ok}));
        ok
    }

    // ---------------------------------------------------------- risk feeder

    /// Block a venue for new supply. The feeder can block and pause, never unblock,
    /// add venues or move funds.
    pub fn block_venue(&mut self, venue_id: String, reason: String) {
        self.assert_owner_or_feeder();
        require!(!reason.is_empty() && reason.len() <= 280, "reason must be 1 to 280 chars");
        let mut v = self.venue(&venue_id);
        v.blocked_reason = Some(reason.clone());
        self.venues.insert(venue_id.clone(), v);
        emit("venue_blocked", json!({"venue": venue_id, "reason": reason, "by": env::predecessor_account_id()}));
    }

    pub fn pause(&mut self) {
        self.assert_owner_or_feeder();
        self.paused = true;
        emit("paused", json!({"by": env::predecessor_account_id()}));
    }

    // ---------------------------------------------------------------- owner

    pub fn add_venue(&mut self, venue_id: String, venue: Venue) {
        self.assert_owner();
        require!(venue_id.len() <= 64, "venue id too long");
        require!(venue.extra_decimals <= 24, "extra_decimals too large");
        if venue.kind == VenueKind::LiquidStake {
            require!(venue.token == NATIVE, "staking venue takes native NEAR");
        } else {
            require!(venue.token.parse::<AccountId>().is_ok(), "token must be an account id");
        }
        self.venues.insert(venue_id.clone(), venue);
        emit("venue_added", json!({"venue": venue_id}));
    }

    pub fn set_venue_enabled(&mut self, venue_id: String, enabled: bool) {
        self.assert_owner();
        let mut v = self.venue(&venue_id);
        v.enabled = enabled;
        self.venues.insert(venue_id, v);
    }

    pub fn unblock_venue(&mut self, venue_id: String) {
        self.assert_owner();
        let mut v = self.venue(&venue_id);
        v.blocked_reason = None;
        self.venues.insert(venue_id.clone(), v);
        emit("venue_unblocked", json!({"venue": venue_id}));
    }

    pub fn set_max_move(&mut self, token: String, amount: U128) {
        self.assert_owner();
        self.max_move.insert(token, amount.0);
    }

    pub fn set_policy(&mut self, policy: Policy) {
        self.assert_owner();
        self.policy = policy;
    }

    pub fn set_risk_feeder(&mut self, feeder: Option<AccountId>) {
        self.assert_owner();
        self.risk_feeder = feeder;
    }

    /// Rotate the agent key. The owner also adds or deletes the access key itself on
    /// the vault account (via `add_agent_key` / `remove_agent_key`).
    pub fn set_agent_key(&mut self, agent_key: PublicKey) {
        self.assert_owner();
        self.agent_key = agent_key;
    }

    /// Add the agent's function-call key to the vault account, limited to the agent
    /// methods, with a gas allowance in yoctoNEAR.
    pub fn add_agent_key(&mut self, allowance: U128) -> Promise {
        self.assert_owner();
        Promise::new(env::current_account_id()).add_access_key_allowance(
            self.agent_key.clone(),
            near_sdk::Allowance::limited(NearToken::from_yoctonear(allowance.0)).expect("allowance must be > 0"),
            env::current_account_id(),
            "agent_supply,agent_withdraw,agent_claim_unstaked",
        )
    }

    /// Kill switch: delete the agent's key from the vault account.
    pub fn remove_agent_key(&mut self) -> Promise {
        self.assert_owner_or_feeder();
        emit("agent_key_removed", json!({"by": env::predecessor_account_id()}));
        Promise::new(env::current_account_id()).delete_key(self.agent_key.clone())
    }

    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
        emit("unpaused", json!({}));
    }

    /// Register the vault with a venue or token for storage. Owner attaches the deposit.
    #[payable]
    pub fn storage_deposit_on(&mut self, target: AccountId) -> Promise {
        self.assert_owner();
        Promise::new(target).function_call(
            "storage_deposit",
            json!({"account_id": env::current_account_id(), "registration_only": true})
                .to_string()
                .into_bytes(),
            env::attached_deposit(),
            GAS_VENUE_CALL,
        )
    }

    /// The only way funds leave the vault: to the owner.
    pub fn owner_withdraw(&mut self, token: String, amount: U128) -> Promise {
        self.assert_owner();
        emit("owner_withdraw", json!({"token": token, "amount": amount}));
        if token == NATIVE {
            Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
        } else {
            let token: AccountId = token.parse().expect("bad token id");
            Promise::new(token).function_call(
                "ft_transfer",
                json!({"receiver_id": self.owner, "amount": amount}).to_string().into_bytes(),
                ONE_YOCTO,
                GAS_FT_TRANSFER,
            )
        }
    }

    /// Accept FT deposits from anyone (the owner funding, or a venue returning funds).
    /// Never forwards: returns "0" so the tokens stay in the vault.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let _ = msg;
        emit(
            "ft_received",
            json!({"token": env::predecessor_account_id(), "from": sender_id, "amount": amount}),
        );
        U128(0)
    }

    // ---------------------------------------------------------------- views

    pub fn get_vault(&self) -> VaultView {
        VaultView {
            owner: self.owner.clone(),
            agent_key: self.agent_key.clone(),
            risk_feeder: self.risk_feeder.clone(),
            paused: self.paused,
            policy: self.policy.clone(),
            last_move_ns: self.last_move_ns,
            moves_today: self.moves_today,
            day_start_ns: self.day_start_ns,
        }
    }

    pub fn get_venues(&self) -> Vec<VenueView> {
        self.venues
            .iter()
            .map(|(id, v)| VenueView {
                id: id.clone(),
                venue: v.clone(),
                position: U128(self.position(id)),
                max_move: U128(self.max_move.get(&v.token).copied().unwrap_or(0)),
            })
            .collect()
    }

    // -------------------------------------------------------------- helpers

    fn assert_agent(&self) {
        // The call must be signed by the vault account itself (its function-call key)
        // and by exactly the registered agent key.
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "agent calls must come from the vault account's own key"
        );
        require!(env::signer_account_pk() == self.agent_key, "signer is not the agent key");
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn assert_owner_or_feeder(&self) {
        let p = env::predecessor_account_id();
        require!(
            p == self.owner || Some(&p) == self.risk_feeder.as_ref(),
            "owner or risk feeder only"
        );
    }

    fn venue(&self, id: &str) -> Venue {
        self.venues
            .get(id)
            .cloned()
            .unwrap_or_else(|| env::panic_str(&format!("unknown venue {id}")))
    }

    fn position(&self, id: &str) -> u128 {
        self.positions.get(id).copied().unwrap_or(0)
    }

    fn check_rate(&mut self) {
        let now = env::block_timestamp();
        if now >= self.day_start_ns + DAY_NS {
            self.day_start_ns = now - now % DAY_NS;
            self.moves_today = 0;
        }
        if self.moves_today >= self.policy.max_moves_per_day {
            env::panic_str(&format!("daily move limit {} reached", self.policy.max_moves_per_day));
        }
        let gap = self.policy.cooldown_s * 1_000_000_000;
        if self.last_move_ns > 0 && now < self.last_move_ns + gap {
            env::panic_str(&format!(
                "cooldown: {}s left",
                (self.last_move_ns + gap - now) / 1_000_000_000
            ));
        }
    }

    fn record_move(&mut self) {
        self.last_move_ns = env::block_timestamp();
        self.moves_today += 1;
    }
}

#[cfg(test)]
mod tests;
