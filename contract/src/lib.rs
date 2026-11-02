//! NEARnest vault.
//!
//! A policy wallet for a yield agent. The vault account holds the funds and has no
//! full-access key. The agent holds one function-call key on the vault account,
//! limited to `agent_supply` and `agent_withdraw`. Every rule below is enforced here,
//! so a compromised agent (stolen key, prompt injection, bad model output) can only
//! move money between the vault and venues the owner approved, in capped amounts.
//! Funds leave the vault/venue loop only to the owner.
//!
//! v3 adds, without a state migration (new values live under their own storage keys):
//! - a risk cap per venue that the risk feeder can only lower and only the owner can
//!   raise or clear, so the off-chain policy's tighter caps bind a stolen agent key too;
//! - exits and claims by the owner or risk feeder, which work after the agent key is
//!   removed;
//! - positions synced from the venue's own account after every exit and claim, and an
//!   unbonding ledger for liquid-staking exits, which counts toward the venue cap.

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
const GAS_VIEW: Gas = Gas::from_tgas(10);
const GAS_STORAGE: Gas = Gas::from_tgas(10);
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
    /// What the vault holds in the venue: reserved on supply, synced from the venue's
    /// own account after every exit and claim (so it includes earned interest).
    pub position: U128,
    /// Liquid-staking exits waiting out the unbonding delay. Still exposed to the venue.
    pub unbonding: U128,
    pub max_move: U128,
    /// Cap set by the risk feeder (lower only) or owner, if any.
    pub risk_cap: Option<U128>,
    /// The cap a supply is checked against: min(max_alloc, risk_cap).
    pub effective_cap: U128,
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

// v3 values under their own storage keys ("x:<what>:<venue>"), so v2 state still loads.
fn raw_key(what: &str, id: &str) -> Vec<u8> {
    format!("x:{what}:{id}").into_bytes()
}
fn raw_get(what: &str, id: &str) -> Option<u128> {
    env::storage_read(&raw_key(what, id)).map(|b| u128::from_le_bytes(b.try_into().expect("bad stored value")))
}
fn raw_set(what: &str, id: &str, v: Option<u128>) {
    match v {
        Some(x) => {
            env::storage_write(&raw_key(what, id), &x.to_le_bytes());
        }
        None => {
            env::storage_remove(&raw_key(what, id));
        }
    }
}

/// Venue internal units back to token units (rounds down).
pub fn scale_down(amount: u128, extra_decimals: u8) -> u128 {
    amount / 10u128.pow(extra_decimals as u32)
}

/// Read the vault's holding from a venue's `get_account` answer:
/// Burrow-style lending reports `supplied[].balance` in internal units, liquid staking
/// reports `staked_balance` and `unstaked_balance`. Returns (position, unbonding).
pub fn parse_venue_account(kind: &VenueKind, token: &str, extra_decimals: u8, bytes: &[u8]) -> Option<(u128, u128)> {
    let v: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    if v.is_null() {
        return Some((0, 0));
    }
    let num = |x: &serde_json::Value| x.as_str().and_then(|s| s.parse::<u128>().ok());
    match kind {
        VenueKind::LendingFt => {
            let supplied = v.get("supplied")?.as_array()?;
            let bal = supplied
                .iter()
                .find(|e| e.get("token_id").and_then(|t| t.as_str()) == Some(token))
                .map(|e| e.get("balance").and_then(num))
                .unwrap_or(Some(0))?;
            Some((scale_down(bal, extra_decimals), 0))
        }
        VenueKind::LiquidStake => Some((num(v.get("staked_balance")?)?, num(v.get("unstaked_balance")?)?)),
    }
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

    /// One-call setup for vaults made by the factory: venues, per-move caps and the
    /// risk feeder at creation, and storage registration on each listed contract, paid
    /// from the vault's own balance.
    #[init]
    pub fn new_preset(
        owner: AccountId,
        agent_key: PublicKey,
        policy: Policy,
        risk_feeder: Option<AccountId>,
        venues: Vec<(String, Venue)>,
        max_moves: Vec<(String, U128)>,
        storage: Vec<(AccountId, U128)>,
    ) -> Self {
        let mut v = Self::new(owner, agent_key, policy);
        v.risk_feeder = risk_feeder;
        for (id, venue) in venues {
            require!(id.len() <= 64 && venue.extra_decimals <= 24, "bad venue");
            v.venues.insert(id, venue);
        }
        for (token, amount) in max_moves {
            v.max_move.insert(token, amount.0);
        }
        for (target, deposit) in storage {
            Promise::new(target).function_call(
                "storage_deposit",
                json!({"account_id": env::current_account_id(), "registration_only": true}).to_string().into_bytes(),
                NearToken::from_yoctonear(deposit.0),
                GAS_STORAGE,
            );
        }
        emit("vault_created", json!({"owner": v.owner}));
        v
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
        let exposure = position + self.unbonding(&venue_id) + amount;
        let cap = self.effective_cap(&venue_id, &venue);
        if exposure > cap {
            let which = if cap < venue.max_alloc.0 { "risk cap" } else { "venue cap" };
            env::panic_str(&format!("allocation {exposure} would exceed {which} {cap}"));
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
    /// never rate-limited. Funds can only land back in the vault.
    pub fn agent_withdraw(&mut self, venue_id: String, amount: U128) -> Promise {
        self.assert_agent();
        self.start_exit(venue_id, amount.0)
    }

    /// Finish a liquid-staking exit after the unbonding delay. Funds land in the vault.
    pub fn agent_claim_unstaked(&mut self, venue_id: String) -> Promise {
        self.assert_agent();
        self.start_claim(venue_id)
    }

    // ------------------------------------------------- owner or risk feeder

    /// Exit a venue without the agent: works after the agent key is removed.
    pub fn guardian_exit(&mut self, venue_id: String, amount: U128) -> Promise {
        self.assert_owner_or_feeder();
        self.start_exit(venue_id, amount.0)
    }

    /// Claim unstaked NEAR without the agent.
    pub fn guardian_claim(&mut self, venue_id: String) -> Promise {
        self.assert_owner_or_feeder();
        self.start_claim(venue_id)
    }

    /// Lower a venue's cap. The risk feeder can only lower it; the owner can set any
    /// value. Supplies are checked against min(max_alloc, risk_cap).
    pub fn set_risk_cap(&mut self, venue_id: String, cap: U128) {
        self.assert_owner_or_feeder();
        let venue = self.venue(&venue_id);
        if env::predecessor_account_id() != self.owner {
            let current = self.effective_cap(&venue_id, &venue);
            if cap.0 >= current {
                env::panic_str(&format!("risk feeder can only lower the cap (now {current})"));
            }
        }
        raw_set("cap", &venue_id, Some(cap.0));
        emit("risk_cap_set", json!({"venue": venue_id, "cap": cap, "by": env::predecessor_account_id()}));
    }

    // ------------------------------------------------------------- anyone

    /// Re-read the vault's holding from the venue itself. Safe for anyone to call:
    /// the venue contract was fixed when the owner approved it.
    pub fn sync_position(&mut self, venue_id: String) -> Promise {
        let venue = self.venue(&venue_id);
        self.read_venue(&venue_id, &venue)
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

    /// Set position and unbonding from the venue's `get_account` answer. The answer
    /// arrives whether or not the exit before it succeeded, so the books follow the
    /// venue rather than the amount requested.
    #[private]
    pub fn on_sync(&mut self, venue_id: String) -> bool {
        let venue = self.venue(&venue_id);
        let parsed = env::promise_result_checked(0, 16_384)
            .ok()
            .and_then(|b| parse_venue_account(&venue.kind, &venue.token, venue.extra_decimals, &b));
        match parsed {
            Some((position, unbonding)) => {
                self.positions.insert(venue_id.clone(), position);
                raw_set("unb", &venue_id, if unbonding > 0 { Some(unbonding) } else { None });
                emit("position_synced", json!({"venue": venue_id, "position": U128(position), "unbonding": U128(unbonding)}));
                true
            }
            None => {
                emit("sync_failed", json!({"venue": venue_id}));
                false
            }
        }
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

    /// Remove a venue's risk cap. Owner only: loosening risk is the owner's call.
    pub fn clear_risk_cap(&mut self, venue_id: String) {
        self.assert_owner();
        raw_set("cap", &venue_id, None);
        emit("risk_cap_cleared", json!({"venue": venue_id}));
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

    /// Owner-only code upgrade. The raw wasm is the call's input (not JSON). The vault
    /// has no full-access key, so this is the only way to change its code, and only the
    /// owner, who can already withdraw everything, can use it.
    pub fn update_contract(&self) -> Promise {
        self.assert_owner();
        let code = env::input().unwrap_or_else(|| env::panic_str("missing wasm input"));
        emit("contract_updated", json!({"by": env::predecessor_account_id(), "bytes": code.len()}));
        Promise::new(env::current_account_id()).deploy_contract(code)
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
                unbonding: U128(self.unbonding(id)),
                max_move: U128(self.max_move.get(&v.token).copied().unwrap_or(0)),
                risk_cap: raw_get("cap", id).map(U128),
                effective_cap: U128(self.effective_cap(id, v)),
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

    fn unbonding(&self, id: &str) -> u128 {
        raw_get("unb", id).unwrap_or(0)
    }

    fn effective_cap(&self, id: &str, venue: &Venue) -> u128 {
        raw_get("cap", id).map_or(venue.max_alloc.0, |c| c.min(venue.max_alloc.0))
    }

    /// The exit call for a venue's kind, followed by a sync from the venue's account.
    fn start_exit(&mut self, venue_id: String, amount: u128) -> Promise {
        let venue = self.venue(&venue_id);
        require!(amount > 0, "zero amount");
        emit("withdraw_started", json!({"venue": venue_id, "amount": U128(amount), "by": env::predecessor_account_id()}));
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
        call.then(self.view_account(&venue)).then(self.sync_cb(&venue_id))
    }

    fn start_claim(&mut self, venue_id: String) -> Promise {
        let venue = self.venue(&venue_id);
        require!(venue.kind == VenueKind::LiquidStake, "not a staking venue");
        emit("claim_started", json!({"venue": venue_id, "by": env::predecessor_account_id()}));
        Promise::new(venue.contract.clone())
            .function_call("withdraw_all", b"{}".to_vec(), NearToken::from_yoctonear(0), GAS_VENUE_CALL)
            .then(self.view_account(&venue))
            .then(self.sync_cb(&venue_id))
    }

    /// `get_account` on the venue, then `on_sync`.
    fn read_venue(&self, venue_id: &str, venue: &Venue) -> Promise {
        self.view_account(venue).then(self.sync_cb(venue_id))
    }

    fn view_account(&self, venue: &Venue) -> Promise {
        Promise::new(venue.contract.clone()).function_call(
            "get_account",
            json!({"account_id": env::current_account_id()}).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_VIEW,
        )
    }

    fn sync_cb(&self, venue_id: &str) -> Promise {
        Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_sync(venue_id.to_string())
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
